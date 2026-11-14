// ═══ Portfolio engine — persistence of decisions (portfolio_decisions) ═══
//
// One row per (sleeve, strategy version, execution session). The table is
// created by src/db/database.ts (createTables). This module is the only
// writer/reader. Session deduplication spans ALL versions of a sleeve.
// Memory is per strategy version: the next decision of version
// V reads the memory persisted by the latest decision of V, never another
// version's.

import { getDB } from "../../db/database";
import type { Database } from "bun:sqlite";
import type { OrderIntent, OrderResult, Position, SessionDate, StopLevel } from "../types";
import { portfolioClientOrderId } from "./clientOrderId";

export type DecisionMode = "observer" | "live";

/** decided → submitted/observed → (resumed) …; skipped_stale/failed carry a note. */
export type DecisionStatus = "decided" | "observed" | "submitted" | "skipped_stale" | "failed";

/** Why an order exists — the EXECUTION's own label, fixed when the order is journaled (Q7 V1, 2026-11-07).
 *  Cost readers classify by it, never by the trade's eventual close_reason. `retry` is the `-r1` remainder
 *  of a MAX_HOLD close (its intent still carries maxHold "close"). `ai_review_sell` (stage B of the AI review): a sell that
 *  exists because the review lowered a weight; never on a MAX_HOLD close (it keeps its own label and reason). */
export type PortfolioOrderLabel = "max_hold_close" | "max_hold_rebuy" | "stale_close" | "retry" | "rebalance_buy" | "rebalance_sell" | "ai_review_sell";

export interface PersistedOrder {
  intent: OrderIntent;
  clientOrderId: string | null;
  result: OrderResult | null;
  /** The fill was applied to the trades rows (restart-safe: never applied twice). */
  applied: boolean;
  /** First fill confirmation time (ms); old journals use the decision's updatedAt. */
  filledAt?: number;
  // ── Execution record (Q7 V1, 2026-11-07). Absent on journals written before it: readers use
  //    inferOrderLabel and treat the prices as unknown, never as zero. ──
  label?: PortfolioOrderLabel;
  /** The reference price the pass decided on for this symbol (venue last/mark, else the last close). */
  decisionPrice?: number | null;
  /** The execution session's UNADJUSTED open at the venue, read at submission when the venue offers it
   *  cheaply (Alpaca: the snapshot's daily bar); null = not available on this venue/that day, declared. */
  sessionOpenRaw?: number | null;
  /** When the order was first handed to the venue (ms). */
  submittedAt?: number;
  /** Skipped before submission (observer, trading disabled, …). */
  skipped?: string;
  /** Submissions of this order that the venue rejected as RETRYABLE (a sell refused because the
   *  shares are still held by a resting order). Capped per session; the order stays unapplied
   *  (same client order id) until it fills, is rejected for another reason, or hits the cap. */
  attempts?: number;
}

/** The label of a journaled order: its own when it has one; for journals written before 2026-11-07 it
 *  is derived from what the row already carries (the `-r1` suffix, the maxHold leg, the stale-close id
 *  — recomputable from sleeve/session/symbol — and the side). */
export function inferOrderLabel(o: Pick<PersistedOrder, "intent" | "clientOrderId" | "label">,
  key: { accountId: string; session: SessionDate }): PortfolioOrderLabel {
  if (o.label) return o.label;
  if (o.clientOrderId?.endsWith("-r1")) return "retry";
  if (o.intent.maxHold === "close") {
    return o.clientOrderId === portfolioClientOrderId(key.accountId, key.session, o.intent.symbol, "stale-close") ? "stale_close" : "max_hold_close";
  }
  if (o.intent.maxHold === "rebuy") return "max_hold_rebuy";
  return o.intent.side === "buy" ? "rebalance_buy" : "rebalance_sell";
}

export interface PortfolioDecisionRecord {
  id?: number;
  accountId: string;
  strategyVersion: string;
  session: SessionDate;
  asOf: SessionDate;
  mode: DecisionMode;
  status: DecisionStatus;
  equity: number;
  book: readonly Position[];
  weights: Readonly<Record<string, number>>;
  stops: readonly StopLevel[];
  memory: Readonly<Record<string, unknown>>;
  diagnostics: Readonly<Record<string, unknown>>;
  orders: PersistedOrder[];
  note: string | null;
  decidedAt: number;
  updatedAt: number;
}

function toRecord(r: any): PortfolioDecisionRecord {
  return {
    id: r.id,
    accountId: r.account_id,
    strategyVersion: r.strategy_version,
    session: r.session,
    asOf: r.as_of,
    mode: r.mode,
    status: r.status,
    equity: r.equity,
    book: JSON.parse(r.book_json),
    weights: JSON.parse(r.weights_json),
    stops: JSON.parse(r.stops_json),
    memory: JSON.parse(r.memory_json),
    diagnostics: JSON.parse(r.diagnostics_json),
    orders: JSON.parse(r.orders_json),
    note: r.note ?? null,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}

/** Insert or replace the (sleeve, version, session) decision. */
export function savePortfolioDecision(rec: PortfolioDecisionRecord): void {
  getDB().prepare(`
    INSERT INTO portfolio_decisions
      (account_id, strategy_version, session, as_of, mode, status, equity, book_json, weights_json, stops_json,
       memory_json, diagnostics_json, orders_json, note, decided_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, strategy_version, session) DO UPDATE SET
      as_of = excluded.as_of, mode = excluded.mode, status = excluded.status, equity = excluded.equity,
      book_json = excluded.book_json, weights_json = excluded.weights_json, stops_json = excluded.stops_json,
      memory_json = excluded.memory_json, diagnostics_json = excluded.diagnostics_json,
      orders_json = excluded.orders_json, note = excluded.note, updated_at = excluded.updated_at
  `).run(
    rec.accountId, rec.strategyVersion, rec.session, rec.asOf, rec.mode, rec.status, rec.equity,
    JSON.stringify(rec.book), JSON.stringify(rec.weights), JSON.stringify(rec.stops),
    JSON.stringify(rec.memory), JSON.stringify(rec.diagnostics), JSON.stringify(rec.orders),
    rec.note, rec.decidedAt, rec.updatedAt,
  );
}

/** Partial update after each order: orders + status + memory (post-fill stop refresh). */
export function updatePortfolioDecisionProgress(
  key: { accountId: string; strategyVersion: string; session: SessionDate },
  patch: { orders?: PersistedOrder[]; status?: DecisionStatus; memory?: Readonly<Record<string, unknown>>; stops?: readonly StopLevel[]; note?: string | null },
  nowMs = Date.now(),
): void {
  const sets: string[] = ["updated_at = ?"];
  const args: unknown[] = [nowMs];
  if (patch.orders) { sets.push("orders_json = ?"); args.push(JSON.stringify(patch.orders)); }
  if (patch.status) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.memory) { sets.push("memory_json = ?"); args.push(JSON.stringify(patch.memory)); }
  if (patch.stops) { sets.push("stops_json = ?"); args.push(JSON.stringify(patch.stops)); }
  if (patch.note !== undefined) { sets.push("note = ?"); args.push(patch.note); }
  args.push(key.accountId, key.strategyVersion, key.session);
  getDB().prepare(
    `UPDATE portfolio_decisions SET ${sets.join(", ")} WHERE account_id = ? AND strategy_version = ? AND session = ?`,
  ).run(...(args as any[]));
}

export function getPortfolioDecision(accountId: string, strategyVersion: string, session: SessionDate): PortfolioDecisionRecord | null {
  const r = getDB().prepare(
    `SELECT * FROM portfolio_decisions WHERE account_id = ? AND strategy_version = ? AND session = ?`,
  ).get(accountId, strategyVersion, session) as any;
  return r ? toRecord(r) : null;
}

/** A session belongs to the sleeve, not the model version. Stale/failed attempts
 *  that never produced a decision may retry; every actual decision blocks a new one. */
export function getPortfolioSessionDecision(accountId: string, session: SessionDate): PortfolioDecisionRecord | null {
  const r = getDB().prepare(
    `SELECT * FROM portfolio_decisions WHERE account_id = ? AND session = ?
     AND status NOT IN ('skipped_stale', 'failed') ORDER BY id DESC LIMIT 1`,
  ).get(accountId, session) as any;
  return r ? toRecord(r) : null;
}

/** Memory to feed the next decision of THIS version: the latest decision that
 *  actually produced a target (decided/observed/submitted). {} when none. */
export function latestPortfolioMemory(accountId: string, strategyVersion: string, opts: { db?: Database; beforeSession?: SessionDate } = {}): Readonly<Record<string, unknown>> {
  const r = (opts.db ?? getDB()).prepare(
    `SELECT memory_json FROM portfolio_decisions
      WHERE account_id = ? AND strategy_version = ? AND status IN ('decided', 'observed', 'submitted')
        AND session < ?
      ORDER BY session DESC, id DESC LIMIT 1`,
  ).get(accountId, strategyVersion, opts.beforeSession ?? "9999-12-31") as any;
  return r ? JSON.parse(r.memory_json) : {};
}

export function listPortfolioDecisions(accountId: string, limit = 30): PortfolioDecisionRecord[] {
  return (getDB().prepare(
    `SELECT * FROM portfolio_decisions WHERE account_id = ? ORDER BY session DESC, id DESC LIMIT ?`,
  ).all(accountId, limit) as any[]).map(toRecord);
}

/** A new session never submits yesterday's target. Retire its unfinished
 *  journal explicitly (across versions too), preserving fills and memory. */
export function finalizeEndedPortfolioSessions(accountId: string, session: SessionDate, nowMs: number): void {
  const ended = getDB().prepare(
    `SELECT * FROM portfolio_decisions WHERE account_id = ? AND session < ? AND status = 'decided' AND mode = 'live'`,
  ).all(accountId, session) as any[];
  for (const row of ended) {
    const rec = toRecord(row);
    const unsent = rec.orders.filter(o => !o.applied && !o.skipped);
    for (const order of unsent) order.skipped = "session_ended";
    updatePortfolioDecisionProgress(rec, {
      status: "submitted", orders: rec.orders,
      note: `${rec.note ? `${rec.note}; ` : ""}session ended with ${unsent.length} unsent order(s)`,
    }, nowMs);
  }
}

/** BinanceVenueOptions.claimOrderId: record the id in portfolio_order_claims BEFORE returning true.
 *  One INSERT OR IGNORE statement = atomic (the PRIMARY KEY decides the race, even across
 *  processes); the row is durable in the same SQLite file as the book, never expires and is never
 *  deleted: a retry after a crash or restart finds it claimed and the venue only queries. */
export function claimPortfolioOrderId(id: string, nowMs = Date.now()): Promise<boolean> {
  const r = getDB().prepare(`INSERT OR IGNORE INTO portfolio_order_claims (id, claimed_at) VALUES (?, ?)`).run(id, nowMs);
  return Promise.resolve(Number(r.changes) === 1);
}
