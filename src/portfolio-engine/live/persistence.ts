// ═══ Portfolio engine — persistence of decisions (portfolio_decisions) ═══
//
// One row per (sleeve, strategy version, execution session). The table is
// created by src/db/database.ts (createTables). This module is the only
// writer/reader. Memory is per strategy version: the next decision of version
// V reads the memory persisted by the latest decision of V, never another
// version's.

import { getDB } from "../../db/database";
import type { OrderIntent, OrderResult, Position, SessionDate, StopLevel } from "../types";

export type DecisionMode = "observer" | "live";

/** decided → submitted/observed → (resumed) …; skipped_stale/failed carry a note. */
export type DecisionStatus = "decided" | "observed" | "submitted" | "skipped_stale" | "failed";

export interface PersistedOrder {
  intent: OrderIntent;
  clientOrderId: string | null;
  result: OrderResult | null;
  /** The fill was applied to the trades rows (restart-safe: never applied twice). */
  applied: boolean;
  /** Skipped before submission (observer, trading disabled, …). */
  skipped?: string;
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

/** Memory to feed the next decision of THIS version: the latest decision that
 *  actually produced a target (decided/observed/submitted). {} when none. */
export function latestPortfolioMemory(accountId: string, strategyVersion: string): Readonly<Record<string, unknown>> {
  const r = getDB().prepare(
    `SELECT memory_json FROM portfolio_decisions
     WHERE account_id = ? AND strategy_version = ? AND status IN ('decided', 'observed', 'submitted')
     ORDER BY session DESC, id DESC LIMIT 1`,
  ).get(accountId, strategyVersion) as any;
  return r ? JSON.parse(r.memory_json) : {};
}

export function listPortfolioDecisions(accountId: string, limit = 30): PortfolioDecisionRecord[] {
  return (getDB().prepare(
    `SELECT * FROM portfolio_decisions WHERE account_id = ? ORDER BY session DESC, id DESC LIMIT ?`,
  ).all(accountId, limit) as any[]).map(toRecord);
}
