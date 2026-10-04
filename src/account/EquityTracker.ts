// ══════════════════════════════════════════════
// Equity Tracker v8 — broker-truth per sleeve
//
// v8: momentum_crypto OWNS its whole Binance wallet — the sync loop calls
// syncBrokerTruth() every 60s with the broker's own equity/cash. The two
// Alpaca sleeves SHARE one wallet, so each carries a per-sleeve ledger
// (computeSleeveLedger below) fed via syncLedger(); broker truth for the
// shared wallet lives only in the alpaca_main snapshots.
// ══════════════════════════════════════════════

import { createLogger } from "../utils/logger";
import { loadAccount, saveAccount, pnlOf } from "../db/database";
import { getInitialEquityForProfile, type RiskProfileId } from "../config/riskProfiles";

const log = createLogger("EquityTracker");

/**
 * Pure per-sleeve ledger math (shared-wallet sleeves, i.e. both Alpaca books):
 *   equity = initial allocation + realized PnL + unrealized PnL of open trades
 *   cash   = initial allocation + realized PnL − Σ(open cost basis), floored at 0
 * `priceOf(symbol)` returning ≤ 0 falls back to the trade's entry price
 * (unrealized 0 for that leg — conservative, never fabricates a price).
 */
export interface OpenTradeLike { symbol: string; side: string; entryPrice: number; quantity: number }

/** Minimal shape both call sites need — satisfied by AlpacaExecutor. */
export interface CachedPriceSource {
  getCachedPrice(symbol: string): number;
  getLatestPrice(symbol: string): Promise<number>;
  /** Optional 24/7 broker-truth fallback (AlpacaExecutor.getPositions()).
   *  currentPrice is Alpaca's own last-close mark when the market is shut —
   *  the correct final fallback before degrading to entry price. May THROW
   *  (fail-closed guard on malformed broker data); buildSleevePriceMap
   *  contains that, it never propagates. */
  getPositions?(): Promise<Array<{ symbol: string; currentPrice: number }>>;
}

/**
 * THE ONE cached-price-with-REST-fallback resolver for sleeve ledger pricing.
 * Was implemented twice (AlpacaMomentumAdapter.getEquity had the fallback,
 * AccountManager.syncAlpacaAccount — the single writer of equity_snapshots —
 * did not), so the snapshot silently degraded to cost-basis (entry price)
 * whenever the ~30s WS price cache went cold, understating sleeve equity by
 * the whole unrealized PnL. getLatestPrice's own REST call is already bounded
 * internally (fetchT/withTimeout in AlpacaExecutor) — no extra timeout
 * wrapper needed here; a rejection just yields 0, which computeSleeveLedger
 * already treats as "fall back to entry price" (never fabricates a price).
 */
export async function resolvePrice(source: CachedPriceSource, symbol: string): Promise<number> {
  const cached = source.getCachedPrice(symbol);
  if (cached > 0) return cached;
  try { return await source.getLatestPrice(symbol); } catch { return 0; }
}

/** Builds a symbol→price map for a sleeve's open trades via resolvePrice, so
 *  computeSleeveLedger's synchronous priceOf callback only ever reads memory.
 *  Only cold-cache symbols hit the network — a warm cache never calls REST.
 *
 *  Market-closed gap: cache AND REST both legitimately return 0 outside
 *  trading hours, silently degrading the snapshot to cost basis (measured
 *  live 2026-07-25: momentum_stocks −$524, meanrev_stocks −$140). The
 *  broker's own position mark is available 24/7 and is fetched at most ONCE
 *  here — only if something is still unresolved after cache+REST — never
 *  per-symbol. A getPositions() throw or a non-finite/zero mark just leaves
 *  the symbol unresolved, so computeSleeveLedger's existing 0→entry-price
 *  fallback still applies; the broker mark is never multiplied by the
 *  broker's (aggregate, cross-sleeve) quantity — only per-share price is used. */
export async function buildSleevePriceMap(
  source: CachedPriceSource,
  openTrades: OpenTradeLike[],
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  for (const t of openTrades) prices.set(t.symbol, await resolvePrice(source, t.symbol));

  const unresolved = [...prices.entries()].filter(([, px]) => !(px > 0)).map(([s]) => s);
  if (unresolved.length > 0 && source.getPositions) {
    try {
      const positions = await source.getPositions();
      const markOf = new Map(positions.map(p => [p.symbol, p.currentPrice]));
      for (const s of unresolved) {
        const mark = markOf.get(s);
        if (Number.isFinite(mark) && mark! > 0) prices.set(s, mark!);
      }
    } catch (e: any) {
      log.warn(`buildSleevePriceMap: broker position fallback failed: ${e.message}`);
    }
  }
  return prices;
}

export function computeSleeveLedger(
  initialEquity: number,
  realizedPnl: number,
  openTrades: OpenTradeLike[],
  priceOf: (symbol: string) => number,
): { equity: number; cash: number; unrealized: number } {
  let unrealized = 0, costBasis = 0;
  for (const t of openTrades) {
    const raw = priceOf(t.symbol);
    const px = raw > 0 ? raw : t.entryPrice;
    // `.raw` ON PURPOSE (see pnlOf): this ledger must DETECT a corrupt leg,
    // never coerce it. Coercing pnl to 0 while costBasis stayed unguarded
    // kept `equity` finite with a NaN `cash` — syncLedger's fail-closed
    // guard never fired and AlpacaMomentumAdapter.getEquity fed a fabricated
    // equity to RiskGuard/position sizing. Any non-finite input (entryPrice,
    // quantity, price, or the resulting pnl) invalidates the WHOLE ledger:
    // NaN is the marker both consumers already reject loudly (syncLedger
    // freezes the snapshot, MomentumEngine.readEquity blocks opens).
    const legPnl = pnlOf(t.side, t.entryPrice, px, t.quantity).raw;
    const legCost = t.entryPrice * t.quantity;
    if (!Number.isFinite(raw) || !Number.isFinite(legPnl) || !Number.isFinite(legCost)) {
      log.error(`computeSleeveLedger: corrupt open trade ${t.symbol} (side=${t.side}, entryPrice=${t.entryPrice}, quantity=${t.quantity}, price=${raw}) — ledger invalidated (NaN) so consumers fail closed instead of sizing on a fabricated equity`);
      return { equity: NaN, cash: NaN, unrealized: NaN };
    }
    unrealized += legPnl;
    costBasis += legCost;
  }
  return {
    equity: initialEquity + realizedPnl + unrealized,
    cash: Math.max(0, initialEquity + realizedPnl - costBasis),
    unrealized,
  };
}

export class EquityTracker {
  readonly accountId: string;
  private _equity: number;
  private _cash: number;
  private _initialEquity: number;

  constructor(accountId: string) {
    this.accountId = accountId;
    const initEq = getInitialEquityForProfile(accountId as RiskProfileId);

    const saved = loadAccount(accountId);
    if (saved) {
      this._equity = saved.equity > 0 ? saved.equity : saved.cash;
      this._cash = saved.cash;
      this._initialEquity = saved.initialEquity;
      // Config is truth for the sleeve ALLOCATION: adopt the profile's
      // initialEquity when it changes (e.g. momentum_stocks 100k → 50k when
      // the shared-wallet attribution fix split the Alpaca wallet).
      if (Number.isFinite(initEq) && saved.initialEquity !== initEq) {
        log.warn(`${accountId}: initialEquity $${saved.initialEquity} → $${initEq} (config allocation changed)`);
        this._initialEquity = initEq;
        this.persist();
      }
      log.info(`Loaded ${accountId}: equity=$${this._equity.toFixed(2)}, cash=$${this._cash.toFixed(2)}`);
    } else {
      this._equity = initEq;
      this._cash = initEq;
      this._initialEquity = initEq;
      this.persist();
      log.info(`Created ${accountId}: equity=$${initEq}`);
    }
  }

  get equity(): number { return this._equity; }
  get cash(): number { return this._cash; }
  get initialEquity(): number { return this._initialEquity; }
  get totalPnl(): number { return this._equity - this._initialEquity; }
  get totalPnlPct(): number { return this._initialEquity > 0 ? (this.totalPnl / this._initialEquity) * 100 : 0; }

  /** Broker = truth: called by the 60s sync loops with the wallet reading.
   *  v8: IN-MEMORY ONLY. The deprecated accounts.equity/cash columns are no
   *  longer written on the hot path — truth lives in equity_snapshots, written
   *  by AccountManager's single 5-min snapshot loop (portfolio/truth.ts reads
   *  those, never accounts). Cards read acc.equity.equity from this memory. */
  syncBrokerTruth(equity: number, cash: number) {
    // A finite zero/negative reading is a valid broker state (e.g. wiped
    // margin) and must overwrite the cache, not be silently dropped — only
    // non-finite values (NaN/Infinity, a malformed read) are rejected loudly
    // so bad data can't masquerade as a real sync.
    if (!Number.isFinite(equity) || !Number.isFinite(cash)) {
      throw new Error(`syncBrokerTruth: non-finite reading equity=${equity}, cash=${cash}`);
    }
    this._equity = equity;
    this._cash = cash;
  }

  /** Ledger = truth for shared-wallet sleeves (both Alpaca books): values come
   *  from computeSleeveLedger, not the broker. IN-MEMORY ONLY (see above). */
  syncLedger(equity: number, cash: number) {
    // Same rejection as syncBrokerTruth's, but LOUD instead of throwing: a
    // non-finite ledger (e.g. one NaN pnl row poisoning SUM(pnl)) silently
    // froze this sleeve's 5-min snapshot at its last good value with zero
    // signal. log.error, not throw — the sole call site (syncAlpacaAccount)
    // would otherwise abort the OTHER sleeve's ledger, orphan reconciliation
    // and the sync heartbeat over what is a display-ledger problem.
    if (!Number.isFinite(equity)) {
      log.error(`${this.accountId}: syncLedger rejected non-finite equity=${equity} (cash=${cash}) — sleeve snapshot frozen at last good value; a poisoned trades.pnl row is the usual cause`);
      return;
    }
    this._equity = equity;
    this._cash = Number.isFinite(cash) ? cash : 0;
  }

  // NOTE for the orchestrator: persist() still routes through db.saveAccount,
  // which co-writes the DEPRECATED accounts.equity/cash columns alongside
  // initial_equity. saveAccount lives in src/db/database.ts (outside this
  // agent's file scope) and can't be split from here. persist() is now called
  // ONLY from the constructor (first-create + config-allocation migration) —
  // NEVER on the 60s hot path — so equity/cash are effectively frozen and
  // read by nobody (truth = equity_snapshots via src/portfolio/truth.ts). To
  // fully retire the columns, split saveAccount into an initial-equity-only
  // writer and call that here.
  private persist() {
    try {
      saveAccount(this.accountId, this._equity, this._cash, this._initialEquity, this.totalPnl);
    } catch (e: any) {
      log.error(`Failed to persist ${this.accountId}: ${e.message}`);
    }
  }

  getDailyPnlFromStats(todayPnl: number) {
    return {
      dailyPnl: todayPnl,
      dailyPnlPct: this._initialEquity > 0 ? (todayPnl / this._initialEquity) * 100 : 0,
    };
  }
}
