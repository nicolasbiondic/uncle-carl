// ══════════════════════════════════════════════
// P&L breakdown — why a period's P&L differs from what was realized in it
// (2026-09-29, owner: "Esos +4000 no los veo"; 2026-11-06, owner: "+$367 ·
// realized −$912" on the same tile).
//
// The period P&L the dashboard and Telegram show is the change in the
// accounts' VALUE over the window (combineEquityPnlLegs over the *_main
// legs). Closing a position adds nothing to that value: it turns an open
// gain into a realized one. Since the 5-day rule (2026-10-26) closes and
// rebuys ~10 stock lots every day and the portfolio engines resize the rest,
// "realized since entry" is mostly days of accrued moves booked today. This
// module attributes the window's P&L so every figure on a tile shares ONE
// window:
//
//   P&L = closedInWindow + openChange + holding
//   positions = P&L − closedInWindow            (what the tile shows)
//
//  realized       Σ since-entry result of EVERY reducing leg inside the
//                 window, each counted exactly once: final closes (the row's
//                 pnl minus the partial legs it booked before the window) and
//                 partial reductions (trims) of rows still open or closed
//                 later. Stocks: the portfolio engines' sell legs in
//                 portfolio_decisions.orders_json, basis = the pre-trade
//                 book_json entry; crypto: the scalePosition legs in `fills`.
//  earnedBefore   for legs whose lot entered before windowStart:
//                 (P_start − entry)·q, net of the entry commission on closes
//  closedInWindow realized − earnedBefore: closes + trims measured inside
//                 the window
//  openChange     positions open now: (P_now − (P_start if entered before
//                 the window, else entry))·q, less the in-window add-backs'
//                 (fill − P_start)·q
//  holding        the residual: funding, margin interest, fees of open
//                 positions, the COIN-M BTC collateral, reconcile closes, the
//                 gap between the window boundary and each leg's start pass
//
// P_start: the window-start marks the snapshot writer persisted
// (pnl_window_marks — the prices the pass used as the window's start equity
// was marked at); when a day has none (restart across the boundary, a
// symbol the pass didn't hold), today's fallback: stocks — the last
// alpaca_wide 1d close before the window's first ET day; crypto — the
// binance_futures 1h close at the boundary (mainnet USDT perp; BASE/USDC maps
// to its BASE/USD proxy). `startPrices` says which was used. A needed price
// that is missing makes the affected figure null — never guessed.
// ══════════════════════════════════════════════

import type { Database } from "bun:sqlite";
import { getETDayStart, getPnlWindowMarks, RECONCILE_CLOSE_SQL } from "../db/database";
import { ALL_PROFILE_IDS, RISK_PROFILES } from "../config/riskProfiles";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A closing leg recorded within this many ms of the row's exit_time is the
 *  row's final close (already in its pnl), not a trim: the engines stamp the
 *  fill and close the row in the same pass, seconds apart at most; a trim is
 *  a separate decision, hours away. */
const FINAL_LEG_WINDOW_MS = 60_000;

/** Sleeves whose P&L is linear in price and whose symbols have historical
 *  bars. momentum_btc (COIN-M inverse contracts) is neither. */
export const MARKABLE_ACCOUNTS: ReadonlySet<string> = new Set([
  "momentum_stocks", "meanrev_stocks", "momentum_crypto", "momentum_crypto_usdc",
]);

/** The window boundary every period figure shares (getTradingStats and
 *  getEquityPnlDisplay use the same rule): 0 = all-time, 1 = today's ET day,
 *  N = the ET day start of N−1 days ago. */
export function windowStartFor(periodDays: number, now = Date.now()): number {
  if (periodDays === 0) return 0;
  return periodDays <= 1 ? getETDayStart(now) : getETDayStart(now - (periodDays - 1) * DAY);
}

function direction(side: string): 1 | -1 {
  return side === "sell" || side === "short" ? -1 : 1;
}

/** Price of `symbol` at the instant `at`, from historical.db; null when the
 *  bar is missing or stale (older than a long weekend for stocks, 3h for
 *  crypto). */
export function priceAt(hist: Database | null, symbol: string, market: string, at: number): number | null {
  if (!hist || !(at > 0)) return null;
  try {
    if (market === "stock") {
      const r = hist.prepare(
        `SELECT close c, timestamp t FROM historical_bars WHERE source = 'alpaca_wide' AND timeframe = '1d' AND symbol = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1`,
      ).get(symbol, at) as { c: number; t: number } | null;
      return r && r.c > 0 && at - r.t <= 6 * DAY ? r.c : null;
    }
    if (market === "crypto") {
      const proxy = symbol.replace(/\/USDC$/, "/USD");
      const r = hist.prepare(
        `SELECT close c, timestamp t FROM historical_bars WHERE source = 'binance_futures' AND timeframe = '1h' AND symbol = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1`,
      ).get(proxy, at - HOUR) as { c: number; t: number } | null;
      return r && r.c > 0 && at - r.t <= 3 * HOUR ? r.c : null;
    }
  } catch {}
  return null;
}

export type StartPriceSource = "marks" | "bars";

/** P_start resolver: the persisted window-start marks first, bars otherwise.
 *  Remembers whether any bar was needed (the modal says "approximate"). */
export class StartPrices {
  private readonly marks = new Map<string, number>();
  barsUsed = false;
  constructor(db: Database, private readonly hist: Database | null, readonly windowStart: number) {
    if (windowStart > 0) {
      try {
        for (const m of getPnlWindowMarks(windowStart, db)) this.marks.set(`${m.market}|${m.symbol}`, m.price);
      } catch {}
    }
  }
  get hasMarks(): boolean { return this.marks.size > 0; }
  at(symbol: string, market: string): number | null {
    const m = this.marks.get(`${market}|${symbol}`);
    if (m != null && m > 0) return m;
    const px = priceAt(this.hist, symbol, market, this.windowStart);
    if (px != null) this.barsUsed = true;
    return px;
  }
  get source(): StartPriceSource { return this.barsUsed ? "bars" : "marks"; }
}

// ── Reducing legs ──────────────────────────────────────────────────────────

export interface CloseContribution {
  accountId: string;
  symbol: string;
  /** "close" = the row's final leg; "trim" = a partial reduction (resize). */
  kind: "close" | "trim";
  entryTime: number;
  exitTime: number;
  quantity: number;
  /** Since-entry result of this leg; null when its fill price is unknown. */
  realized: number | null;
  /** Part of `realized` earned before the window (0 when entered inside it);
   *  null when the lot can't be marked at the boundary. */
  earnedBefore: number | null;
  inWindow: number | null;
}

interface RowLite {
  id: string; accountId: string; symbol: string; market: string; side: string;
  quantity: number; entryPrice: number; entryTime: number; exitTime: number | null;
  openCommission: number;
  /** Contracts/shares the row's partial ledger booked (0 = never trimmed). */
  partialClosed: number;
}

interface RawLeg {
  row: RowLite;
  kind: "close" | "trim";
  qty: number;
  /** Basis the leg was measured from (the pre-trade book entry). */
  basis: number;
  /** null when the venue reported a fill without a price. */
  price: number | null;
  time: number;
  /** Realized since entry; for the final close the row's pnl net of the
   *  partial legs it booked, so Σ legs of a row = the row's pnl. */
  realized: number | null;
  /** Entry commission (closes only: paid once per row, before the window
   *  when the lot predates it). */
  openCommission: number;
  /** The journal had no fill time (sessions before 2026-10-24): `time` is the
   *  decision's. */
  legacyTime?: boolean;
}

interface BuyLeg { row: RowLite; qty: number; price: number; time: number }

const STOCK_JOURNAL_ACCOUNTS = ALL_PROFILE_IDS.filter(id => MARKABLE_ACCOUNTS.has(id) && RISK_PROFILES[id].broker === "alpaca");
const CRYPTO_FILL_ACCOUNTS = ALL_PROFILE_IDS.filter(id => MARKABLE_ACCOUNTS.has(id) && RISK_PROFILES[id].broker !== "alpaca");

function rowLite(r: any): RowLite {
  return {
    id: r.id, accountId: r.account_id, symbol: r.symbol, market: r.market, side: r.side,
    quantity: Number(r.quantity) || 0, entryPrice: Number(r.entry_price) || 0, entryTime: Number(r.entry_time) || 0,
    exitTime: r.exit_time == null ? null : Number(r.exit_time), openCommission: Number(r.open_commission) || 0,
    partialClosed: Number(r.partial_closed_contracts) || 0,
  };
}

const ROW_COLS = `id, account_id, symbol, market, side, quantity, entry_price, entry_time, exit_time, open_commission, partial_closed_contracts`;

/** The row of (account, symbol) that was open at instant `at` — one open row
 *  per (sleeve, symbol) by construction; null when none (a rebuy's own row
 *  opens after its sell). */
function rowOpenAt(db: Database, accountId: string, symbol: string, at: number, strictEntry = false): RowLite | null {
  const r = db.prepare(
    `SELECT ${ROW_COLS} FROM trades
      WHERE account_id = ? AND symbol = ? AND entry_time ${strictEntry ? "<" : "<="} ? AND (exit_time IS NULL OR exit_time > ?)
      ORDER BY entry_time DESC LIMIT 1`,
  ).get(accountId, symbol, at, at) as any;
  return r ? rowLite(r) : null;
}

/** Stock legs from the portfolio engines' journals: every applied sell with a
 *  fill is a reducing leg of the row open at the decision; every applied buy
 *  into an EXISTING row is an add-back (the rebuy of a 5-day renewal opens a
 *  new row and is not one). */
function stockJournalLegs(db: Database, since: number): { sells: RawLeg[]; buys: BuyLeg[] } {
  const sells: RawLeg[] = [];
  const buys: BuyLeg[] = [];
  if (STOCK_JOURNAL_ACCOUNTS.length === 0) return { sells, buys };
  let rows: any[] = [];
  try {
    rows = db.prepare(
      `SELECT account_id a, decided_at d, book_json b, orders_json o FROM portfolio_decisions
        WHERE decided_at >= ? AND account_id IN (${STOCK_JOURNAL_ACCOUNTS.map(() => "?").join(",")}) ORDER BY decided_at ASC`,
    ).all(since, ...STOCK_JOURNAL_ACCOUNTS) as any[];
  } catch { return { sells, buys }; }
  for (const j of rows) {
    let book: any[] = [], orders: any[] = [];
    try { book = JSON.parse(j.b) ?? []; orders = JSON.parse(j.o) ?? []; } catch { continue; }
    const basisOf = new Map<string, number>();
    for (const p of book) if (p && p.symbol && p.avgEntryPrice > 0) basisOf.set(p.symbol, Number(p.avgEntryPrice));
    for (const o of orders) {
      const intent = o?.intent;
      const res = o?.result;
      if (!intent || !res || !o.applied || !(res.filledQty > 0)) continue;
      const legacyTime = !(Number(o.filledAt) > 0);
      const time = legacyTime ? Number(j.d) : Number(o.filledAt);
      const price = res.avgPrice != null && res.avgPrice > 0 ? Number(res.avgPrice) : null;
      const qty = Number(res.filledQty);
      if (intent.side === "sell") {
        const row = rowOpenAt(db, j.a, intent.symbol, Number(j.d));
        if (!row) continue;
        const basis = basisOf.get(intent.symbol) ?? row.entryPrice;
        sells.push({
          row, kind: "trim", qty, basis, price, time, openCommission: 0, legacyTime,
          realized: price == null ? null : (price - basis) * qty * direction(row.side),
        });
      } else if (intent.side === "buy" && price != null) {
        const row = rowOpenAt(db, j.a, intent.symbol, time, true);
        if (row) buys.push({ row, qty, price, time });
      }
    }
  }
  return { sells, buys };
}

/** Crypto reducing legs from `fills`: the scalePosition reductions record a
 *  closing-side fill on the row (BinanceMomentumAdapter.scalePosition); the
 *  final close records one too, excluded by FINAL_LEG_WINDOW_MS. Fees are
 *  not on the fill (they stay in `holding`). */
function cryptoFillLegs(db: Database, rows: RowLite[]): RawLeg[] {
  const out: RawLeg[] = [];
  const candidates = rows.filter(r => r.partialClosed > 0 && CRYPTO_FILL_ACCOUNTS.includes(r.accountId as any));
  if (candidates.length === 0) return out;
  const q = db.prepare(`SELECT side, filled_px px, filled_qty q, fill_time t FROM fills WHERE trade_id = ? AND account_id = ? ORDER BY fill_time ASC`);
  for (const row of candidates) {
    let fills: any[] = [];
    try { fills = q.all(row.id, row.accountId) as any[]; } catch { continue; }
    for (const f of fills) {
      if (f.side === row.side || !(f.q > 0)) continue; // entries and add-backs
      if (!(f.t > row.entryTime - FINAL_LEG_WINDOW_MS)) continue; // no fill time: cannot be dated
      if (row.exitTime != null && f.t >= row.exitTime - FINAL_LEG_WINDOW_MS) continue; // the final close itself
      const price = f.px > 0 ? Number(f.px) : null;
      out.push({
        row, kind: "trim", qty: Number(f.q), basis: row.entryPrice, price, time: Number(f.t), openCommission: 0,
        realized: price == null ? null : (price - row.entryPrice) * Number(f.q) * direction(row.side),
      });
    }
  }
  return out;
}

/** Drop the journal leg that IS a closed row's final close (the row's own leg
 *  carries the exact pnl); the engines stamp both within seconds. A legacy
 *  journal leg (no fill time) is the final close when it sold the row's whole
 *  remnant on the row's exit day. */
function dropFinalLegs(legs: RawLeg[], closedRows: Map<string, RowLite>): RawLeg[] {
  const lastByRow = new Map<string, RawLeg>();
  for (const l of legs) {
    const row = closedRows.get(l.row.id);
    if (!row || row.exitTime == null) continue;
    const isFinal = l.legacyTime
      ? getETDayStart(l.time) === getETDayStart(row.exitTime) && l.qty >= row.quantity * (1 - 1e-6)
      : l.time <= row.exitTime && l.time >= row.exitTime - FINAL_LEG_WINDOW_MS;
    if (!isFinal) continue;
    const cur = lastByRow.get(row.id);
    if (!cur || l.time >= cur.time) lastByRow.set(row.id, l);
  }
  const drop = new Set([...lastByRow.values()]);
  return legs.filter(l => !drop.has(l));
}

// ── Attribution ────────────────────────────────────────────────────────────

export interface RealizedAttribution {
  windowStart: number;
  /** Since-entry result of every reducing leg in the window. */
  realized: number;
  /** Final closes in the window (= `count`, kept for older readers). */
  closesCount: number;
  count: number;
  /** Partial reductions in the window. */
  trimsCount: number;
  earnedBefore: number | null;
  closedInWindow: number | null;
  closes: CloseContribution[];
  startPrices: StartPriceSource;
}

interface OpenRowInfo { row: RowLite; trims: RawLeg[]; buys: BuyLeg[] }

function attribute(db: Database, start: StartPrices, windowStart: number): RealizedAttribution & { openRows: Map<string, OpenRowInfo> } {
  const accounts = [...ALL_PROFILE_IDS];
  const inList = accounts.map(() => "?").join(",");
  const closedRaw = db.prepare(
    `SELECT ${ROW_COLS}, exit_price, pnl, partial_realized_native pr, partial_commission_native pc
       FROM trades
      WHERE status = 'closed' AND exit_time > ? AND ${RECONCILE_CLOSE_SQL} AND account_id IN (${inList})
      ORDER BY exit_time DESC`,
  ).all(windowStart, ...accounts) as any[];
  const openRaw = db.prepare(
    `SELECT ${ROW_COLS} FROM trades WHERE status = 'open' AND account_id IN (${inList})`,
  ).all(...accounts) as any[];

  const closedRows = new Map<string, RowLite>();
  const legs: RawLeg[] = [];
  for (const r of closedRaw) {
    const row = rowLite(r);
    closedRows.set(row.id, row);
    const partialNet = (Number(r.pr) || 0) - (Number(r.pc) || 0);
    const pnl = r.pnl == null ? null : Number(r.pnl);
    legs.push({
      row, kind: "close", qty: row.quantity, basis: row.entryPrice,
      price: r.exit_price > 0 ? Number(r.exit_price) : null, time: row.exitTime!,
      realized: pnl == null ? 0 : pnl - partialNet, openCommission: row.openCommission,
    });
  }
  const openRows = new Map<string, OpenRowInfo>();
  for (const r of openRaw) {
    const row = rowLite(r);
    openRows.set(`${row.accountId}|${row.symbol}`, { row, trims: [], buys: [] });
  }

  // Partial legs: journals back to the earliest lot involved (a row closed in
  // the window may have been trimmed before it — those legs are already in
  // its pnl and must be taken out, so they have to be dated).
  const involved = [...closedRows.values(), ...[...openRows.values()].map(o => o.row)];
  const since = involved.length ? Math.min(...involved.map(r => r.entryTime)) : windowStart;
  const journal = stockJournalLegs(db, since);
  const partials = dropFinalLegs([...journal.sells, ...cryptoFillLegs(db, involved)], closedRows);

  let realized = 0;
  let earned = 0;
  let unknownStart = false;
  let unknownLeg = false;
  let closesCount = 0, trimsCount = 0;
  const closes: CloseContribution[] = [];
  const markable = (row: RowLite) => MARKABLE_ACCOUNTS.has(row.accountId);

  const consider = (l: RawLeg) => {
    if (!(l.time > windowStart)) return; // before the window: not this period's
    if (l.kind === "close") closesCount++; else trimsCount++;
    if (l.realized == null) unknownLeg = true; else realized += l.realized;
    let before: number | null = 0;
    if (l.row.entryTime < windowStart) {
      const px = markable(l.row) ? start.at(l.row.symbol, l.row.market) : null;
      before = px == null ? null : (px - l.basis) * l.qty * direction(l.row.side) - l.openCommission;
    }
    if (before == null) unknownStart = true; else earned += before;
    closes.push({
      accountId: l.row.accountId, symbol: l.row.symbol, kind: l.kind, entryTime: l.row.entryTime, exitTime: l.time,
      quantity: l.qty, realized: l.realized, earnedBefore: before,
      inWindow: before == null || l.realized == null ? null : l.realized - before,
    });
  };
  for (const l of legs) consider(l);
  for (const l of partials) {
    consider(l);
    const open = openRows.get(`${l.row.accountId}|${l.row.symbol}`);
    if (open && open.row.id === l.row.id) open.trims.push(l);
  }
  for (const b of journal.buys) {
    const open = openRows.get(`${b.row.accountId}|${b.row.symbol}`);
    if (open && open.row.id === b.row.id) open.buys.push(b);
  }

  const earnedBefore = unknownStart ? null : earned;
  return {
    windowStart, realized, closesCount, count: closesCount, trimsCount, earnedBefore,
    closedInWindow: earnedBefore == null || unknownLeg ? null : realized - earnedBefore,
    closes, startPrices: start.source, openRows,
  };
}

/** Realized attribution alone (Telegram's /status line). */
export function computeRealizedAttribution(db: Database, hist: Database | null, windowStart: number): RealizedAttribution {
  const { openRows: _o, ...ra } = attribute(db, new StartPrices(db, hist, windowStart), windowStart);
  return ra;
}

export interface BreakdownPosition {
  accountId: string;
  symbol: string;
  market: string;
  side: string;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  currentPrice: number;
}

export interface PnlBreakdown extends RealizedAttribution {
  periodDays: number;
  pnl: number | null;
  openChange: number | null;
  openCount: number;
  /** pnl − closedInWindow − openChange: funding, margin interest, fees on
   *  open positions, the COIN-M collateral, residual. */
  holding: number | null;
  /** pnl − closedInWindow — the tile's "positions" figure; closes + positions
   *  is the headline exactly. */
  positions: number | null;
}

export function computePnlBreakdown(opts: {
  db: Database;
  hist: Database | null;
  periodDays: number;
  /** The period's equity delta — the figure the KPI shows. */
  pnl: number | null;
  openPositions: BreakdownPosition[];
  now?: number;
}): PnlBreakdown {
  const windowStart = windowStartFor(opts.periodDays, opts.now);
  const start = new StartPrices(opts.db, opts.hist, windowStart);
  const { openRows, ...ra } = attribute(opts.db, start, windowStart);

  let openChange = 0;
  let openUnknown = false;
  for (const p of opts.openPositions) {
    if (!MARKABLE_ACCOUNTS.has(p.accountId) || !(p.currentPrice > 0)) { openUnknown = true; continue; }
    const before = p.entryTime < windowStart;
    const ref = before ? start.at(p.symbol, p.market) : p.entryPrice;
    if (ref == null) { openUnknown = true; continue; }
    const dir = direction(p.side);
    openChange += (p.currentPrice - ref) * p.quantity * dir;
    // An add-back inside the window moved from its fill, not from P_start.
    if (before) {
      for (const b of openRows.get(`${p.accountId}|${p.symbol}`)?.buys ?? []) {
        if (b.time > windowStart) openChange -= (b.price - ref) * b.qty * dir;
      }
    }
  }

  const open = openUnknown ? null : openChange;
  const positions = opts.pnl == null || ra.closedInWindow == null ? null : opts.pnl - ra.closedInWindow;
  const holding = positions == null || open == null ? null : positions - open;
  return {
    ...ra,
    startPrices: start.source,
    periodDays: opts.periodDays,
    pnl: opts.pnl,
    openChange: open,
    openCount: opts.openPositions.length,
    holding,
    positions,
  };
}
