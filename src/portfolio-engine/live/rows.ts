// ═══ Portfolio engine — the sleeve's trades rows ═══
//
// Row model (RW-reescritura-rentable §3 "Reglas del vivo"):
//   - ONE open row per (sleeve, symbol), strategy = PORTFOLIO_ENGINE_STRATEGY,
//     strategy_version on every row;
//   - an increase updates quantity and the average entry price;
//   - a decrease records the partial realized P&L on the row (the COIN-M
//     partial-close ledger columns, native asset = the venue's quote: USD /
//     USDT / USDC) and shrinks the quantity;
//   - a full exit closes the row with close_reason PORTFOLIO_REBALANCE and a
//     pnl that already includes every earlier partial leg;
//   - ids start with "pf_": never "sync_", so BrokerSync never auto-closes
//     them (isSyncOwned is false) — the phantom guard.
//
// Every writer here runs in ONE SQLite transaction and re-reads the row under
// `status = 'open'`, so a close from any other path wins and we never resurrect
// a closed row. Nothing here talks to a broker.

import {
  getDB, PORTFOLIO_ENGINE_STRATEGY, accumulatePartialCloseLedger, closeTradeExplicit,
  getTradingStats, insertActivity, pnlOf,
} from "../../db/database";
import type { Position } from "../types";

export const PORTFOLIO_REBALANCE_CLOSE_REASON = "PORTFOLIO_REBALANCE";
/** A row whose broker position vanished (external close) — the row is closed
 *  at the reference price with this label, mirroring BROKER_GONE_404. */
export const PORTFOLIO_RECONCILED_CLOSE_REASON = "PORTFOLIO_RECONCILED";

export interface SleeveRow {
  id: string;
  symbol: string;
  market: "stock" | "crypto";
  side: "buy" | "sell";
  strategy: string;
  strategyVersion: string;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  /** Realized P&L (quote currency) of the partial decreases so far. */
  partialRealized: number;
}

export interface RowsConfig {
  accountId: string;
  strategyVersion: string;
  market: "stock" | "crypto";
  /** Quote asset label written on the partial ledger (USD / USDT / USDC). */
  quoteAsset: string;
}

function rowOf(r: any): SleeveRow {
  return {
    id: r.id,
    symbol: r.symbol,
    market: r.market,
    side: r.side,
    strategy: r.strategy,
    strategyVersion: r.strategy_version ?? "legacy",
    entryPrice: r.entry_price,
    quantity: r.quantity,
    entryTime: r.entry_time,
    partialRealized: Number(r.partial_realized_native) || 0,
  };
}

/** Every OPEN row of the sleeve, whatever its strategy tag (the sleeve's
 *  exposure — adoption re-tags the legacy ones; observer mode only reads). */
export function loadSleeveRows(accountId: string): SleeveRow[] {
  const rows = getDB().prepare(
    `SELECT * FROM trades WHERE account_id = ? AND status = 'open' ORDER BY entry_time ASC, id ASC`,
  ).all(accountId) as any[];
  return rows.map(rowOf);
}

/** Book positions from the rows: one Position per symbol (rows are one per
 *  symbol by construction; a legacy duplicate is merged qty-weighted so the
 *  book never under-reports exposure). Long-only: sell-side rows are reported
 *  with qty 0 and logged by the caller. */
export function positionsFromRows(rows: readonly SleeveRow[]): Position[] {
  const bySymbol = new Map<string, { qty: number; cost: number }>();
  for (const r of rows) {
    if (r.side !== "buy") continue;
    const cur = bySymbol.get(r.symbol) ?? { qty: 0, cost: 0 };
    cur.qty += r.quantity;
    cur.cost += r.quantity * r.entryPrice;
    bySymbol.set(r.symbol, cur);
  }
  return [...bySymbol.entries()]
    .filter(([, v]) => v.qty > 0)
    .map(([symbol, v]) => ({ symbol, qty: v.qty, avgEntryPrice: v.cost / v.qty }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

/** Realized P&L of the sleeve: closed rows (getTradingStats, RECONCILE_CLOSE_SQL
 *  scope — the same number the existing sleeves' ledgers use) plus the
 *  partial legs still sitting on open rows. */
export function sleeveRealizedPnl(accountId: string): number {
  const closed = getTradingStats(accountId).totalPnl as number;
  const open = getDB().prepare(
    `SELECT COALESCE(SUM(partial_realized_native), 0) AS p FROM trades WHERE account_id = ? AND status = 'open'`,
  ).get(accountId) as any;
  return (Number(closed) || 0) + (Number(open?.p) || 0);
}

/** First live run: every open row of the sleeve that is not yet ours is
 *  re-tagged (strategy + version) — never closed, never re-bought. Returns the
 *  re-tagged row ids. Idempotent: a second call finds nothing to do. */
export function adoptSleeveRows(cfg: RowsConfig, nowMs = Date.now()): string[] {
  const db = getDB();
  const txn = db.transaction(() => {
    const pending = db.prepare(
      `SELECT id, symbol, quantity, entry_price, strategy FROM trades
       WHERE account_id = ? AND status = 'open' AND strategy != ?`,
    ).all(cfg.accountId, PORTFOLIO_ENGINE_STRATEGY) as any[];
    const upd = db.prepare(
      `UPDATE trades SET strategy = ?, strategy_version = ? WHERE id = ? AND status = 'open'`,
    );
    const ids: string[] = [];
    for (const r of pending) {
      upd.run(PORTFOLIO_ENGINE_STRATEGY, cfg.strategyVersion, r.id);
      ids.push(r.id);
      insertActivity(cfg.accountId, "system",
        `portfolio engine adopted ${r.symbol} (${r.quantity} @ $${Number(r.entry_price).toFixed(4)}, was ${r.strategy}) as ${cfg.strategyVersion}`);
    }
    void nowMs;
    return ids;
  });
  return txn();
}

/** A broker position of the sleeve's universe with no DB row anywhere: adopt
 *  it as a row at the broker's average entry (never fabricate a basis). */
export function adoptBrokerPosition(cfg: RowsConfig, pos: Position, nowMs = Date.now()): string | null {
  if (!(pos.qty > 0) || !(pos.avgEntryPrice > 0) || !Number.isFinite(pos.avgEntryPrice)) return null;
  const db = getDB();
  const txn = db.transaction(() => {
    const anyRow = db.prepare(
      `SELECT COUNT(*) AS c FROM trades WHERE status = 'open' AND symbol = ? AND account_id NOT LIKE 'shadow_%'`,
    ).get(pos.symbol) as any;
    if ((anyRow?.c ?? 0) > 0) return null;
    const id = newRowId(cfg.accountId, pos.symbol, nowMs);
    insertOpenRow(cfg, id, pos.symbol, pos.qty, pos.avgEntryPrice, nowMs);
    insertActivity(cfg.accountId, "sync",
      `portfolio engine adopted broker position ${pos.symbol}: ${pos.qty} @ $${pos.avgEntryPrice.toFixed(4)} (no prior DB row)`);
    return id;
  });
  return txn();
}

function newRowId(accountId: string, symbol: string, nowMs: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `pf_${accountId}_${symbol.replace(/[^A-Za-z0-9]/g, "")}_${nowMs.toString(36)}_${rand}`;
}

function insertOpenRow(cfg: RowsConfig, id: string, symbol: string, qty: number, price: number, nowMs: number): void {
  getDB().prepare(`
    INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status,
                        account_id, profile_id, strategy_version, open_commission, partial_realized_native,
                        partial_commission_native, partial_commission_asset, partial_closed_contracts)
    VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, 'open', ?, ?, ?, 0, 0, 0, ?, 0)
  `).run(id, symbol, cfg.market, PORTFOLIO_ENGINE_STRATEGY, price, qty, nowMs, cfg.accountId, cfg.accountId,
    cfg.strategyVersion, cfg.quoteAsset);
}

export interface FillApplied {
  rowId: string;
  kind: "opened" | "increased" | "decreased" | "closed";
  qtyAfter: number;
  avgEntryAfter: number;
  /** Realized P&L of THIS leg (decrease/close), 0 for buys. */
  realized: number;
}

/** A BUY fill: open the symbol's row or increase it (qty-weighted average
 *  entry). One row per symbol: an existing open row of ANY strategy tag under
 *  this account is the one that grows (adoption already re-tagged it). */
export function applyBuyFill(cfg: RowsConfig, symbol: string, filledQty: number, avgPrice: number, nowMs = Date.now()): FillApplied {
  if (!(filledQty > 0) || !(avgPrice > 0)) throw new Error(`applyBuyFill ${symbol}: invalid fill qty=${filledQty} price=${avgPrice}`);
  const db = getDB();
  const txn = db.transaction((): FillApplied => {
    const row = db.prepare(
      `SELECT id, quantity, entry_price FROM trades WHERE account_id = ? AND symbol = ? AND status = 'open' AND side = 'buy'
       ORDER BY entry_time ASC LIMIT 1`,
    ).get(cfg.accountId, symbol) as any;
    if (!row) {
      const id = newRowId(cfg.accountId, symbol, nowMs);
      insertOpenRow(cfg, id, symbol, filledQty, avgPrice, nowMs);
      return { rowId: id, kind: "opened", qtyAfter: filledQty, avgEntryAfter: avgPrice, realized: 0 };
    }
    const qtyAfter = row.quantity + filledQty;
    const avgAfter = (row.quantity * row.entry_price + filledQty * avgPrice) / qtyAfter;
    // A portfolio→portfolio cutover may add to an older version's row. The episode still
    // belongs to the version that OPENED it, just as on partial sells and final closes.
    db.prepare(`UPDATE trades SET quantity = ?, entry_price = ?, strategy = ? WHERE id = ? AND status = 'open'`)
      .run(qtyAfter, avgAfter, PORTFOLIO_ENGINE_STRATEGY, row.id);
    return { rowId: row.id, kind: "increased", qtyAfter, avgEntryAfter: avgAfter, realized: 0 };
  });
  return txn();
}

/** A SELL fill: decrease the row (partial realized on the ledger columns) or,
 *  when it consumes the whole row (within `epsilon` of the quantity), close
 *  it with `closeReason` and a pnl = partial legs + this leg. */
export function applySellFill(
  cfg: RowsConfig,
  symbol: string,
  filledQty: number,
  avgPrice: number,
  opts: { closeReason?: string; epsilon?: number; nowMs?: number } = {},
): FillApplied | null {
  if (!(filledQty > 0) || !(avgPrice > 0)) throw new Error(`applySellFill ${symbol}: invalid fill qty=${filledQty} price=${avgPrice}`);
  const nowMs = opts.nowMs ?? Date.now();
  const closeReason = opts.closeReason ?? PORTFOLIO_REBALANCE_CLOSE_REASON;
  const epsilon = opts.epsilon ?? 1e-9;
  const db = getDB();
  const txn = db.transaction((): FillApplied | null => {
    const row = db.prepare(
      `SELECT id, quantity, entry_price, partial_realized_native FROM trades
       WHERE account_id = ? AND symbol = ? AND status = 'open' AND side = 'buy' ORDER BY entry_time ASC LIMIT 1`,
    ).get(cfg.accountId, symbol) as any;
    if (!row) return null;
    const qty = Math.min(filledQty, row.quantity);
    const leg = pnlOf("buy", row.entry_price, avgPrice, qty).pnl;
    const remaining = row.quantity - qty;
    if (remaining <= epsilon * Math.max(1, row.quantity)) {
      const partial = Number(row.partial_realized_native) || 0;
      const total = partial + leg;
      const basis = row.entry_price * row.quantity;
      const pct = basis > 0 ? (total / basis) * 100 : 0;
      const closed = closeTradeExplicit(row.id, avgPrice, nowMs, total, pct, closeReason);
      if (!closed) return null;
      return { rowId: row.id, kind: "closed", qtyAfter: 0, avgEntryAfter: row.entry_price, realized: leg };
    }
    accumulatePartialCloseLedger(row.id, {
      realizedNative: leg, commissionNative: 0, commissionAsset: cfg.quoteAsset,
      closedContracts: qty, remainingContracts: remaining,
    });
    return { rowId: row.id, kind: "decreased", qtyAfter: remaining, avgEntryAfter: row.entry_price, realized: leg };
  });
  return txn();
}

/** Broker = truth: the broker holds LESS than the row says (external close or
 *  reduction). Shrink/close the row at the reference price so the book the
 *  decision sees matches the venue. Never touches the broker. */
export function reconcileRowToBroker(
  cfg: RowsConfig,
  symbol: string,
  brokerQty: number,
  referencePrice: number,
  nowMs = Date.now(),
): FillApplied | null {
  const rows = loadSleeveRows(cfg.accountId).filter(r => r.symbol === symbol && r.side === "buy");
  const dbQty = rows.reduce((s, r) => s + r.quantity, 0);
  if (!(dbQty > brokerQty)) return null;
  const px = referencePrice > 0 ? referencePrice : (rows[0]?.entryPrice ?? 0);
  if (!(px > 0)) return null;
  const applied = applySellFill(cfg, symbol, dbQty - Math.max(0, brokerQty), px,
    { closeReason: PORTFOLIO_RECONCILED_CLOSE_REASON, nowMs });
  if (applied) {
    insertActivity(cfg.accountId, "sync",
      `portfolio engine reconciled ${symbol} to broker qty ${brokerQty} (was ${dbQty}) at $${px.toFixed(4)}`);
  }
  return applied;
}
