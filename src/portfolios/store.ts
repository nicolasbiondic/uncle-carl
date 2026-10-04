/**
 * Platform portfolio registry (F3b, 2026-10-04 — docs/platform/PLAN.md).
 *
 * `platform_portfolios` (the `platform_` prefix avoids the legacy
 * `broker_accounts` table in database.ts) stores one row per portfolio,
 * seeded ONCE and idempotently from builtin.ts (INSERT OR IGNORE — an
 * owner-edited row is never overwritten by a reboot).
 *
 * Source selection: PORTFOLIOS_SOURCE=code|db, DEFAULT code.
 *   - code → index.ts builds the engines from builtin.ts, byte-identical
 *     to the F3a wiring (the seed still runs so the registry is readable).
 *   - db   → index.ts builds the engines from the ENABLED rows here.
 *   - anything else → resolvePortfoliosSource throws and the bot refuses
 *     to start (an ambiguous money-path source is never guessed).
 *
 * Parity: src/portfolios/store.test.ts proves factory(seeded rows) is
 * deep-equal to factory(builtin) for every sleeve.
 */
import type { Database } from "bun:sqlite";
import { builtinPortfolios } from "./builtin";
import type { PortfolioAccountId, PortfolioDefinition, PortfolioMode, PortfolioParams, PortfolioTemplate } from "./types";

export type PortfoliosSource = "code" | "db";

/** Portfolio lifecycle (F3c/F3d): edits apply on the NEXT boot. */
export type PortfolioStatus = "active" | "pending_restart" | "archived";

/** Validation state vs the sleeve's experiment artifact: an owner edit of a
 *  live portfolio's params marks it unvalidated (F3d); builtin seeds are
 *  validated (liveSleeveConfigs' vivo=validado lock). */
export type PortfolioValidation = "validated" | "unvalidated";

export function resolvePortfoliosSource(raw: string | undefined): PortfoliosSource {
  if (raw === undefined || raw === "" || raw === "code") return "code";
  if (raw === "db") return "db";
  throw new Error(
    `PORTFOLIOS_SOURCE='${raw}' is not a valid portfolio source (expected 'code' or 'db') — refusing to start on an ambiguous money-path flag`,
  );
}

export interface PlatformPortfolioRow {
  id: string;
  name: string;
  template: PortfolioTemplate;
  account: PortfolioAccountId;
  capital: number;
  mode: PortfolioMode;
  enabled: boolean;
  params: PortfolioParams;
  status: PortfolioStatus;
  validation: PortfolioValidation;
  /** "builtin" for seeded rows, "owner" for rows created/edited via F3d. */
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** CREATE TABLE IF NOT EXISTS + one idempotent seed from builtin.ts. */
export function initPlatformPortfolios(db: Database, nowMs: number = Date.now()): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS platform_portfolios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template TEXT NOT NULL,
      account TEXT NOT NULL,
      capital REAL NOT NULL,
      mode TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      params_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      validation TEXT NOT NULL DEFAULT 'validated',
      source TEXT NOT NULL DEFAULT 'builtin',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO platform_portfolios
      (id, name, template, account, capital, mode, enabled, params_json, status, validation, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'validated', 'builtin', ?, ?)
  `);
  // Rows the owner never edited (source='builtin') mirror builtin.ts: when the
  // code's definition changes they are refreshed here (e.g. momentum_crypto's
  // registered default shadow → live, 2026-10-04). An owner edit flips the
  // row to source='owner' and freezes it. Unchanged rows are not touched.
  const current = db.prepare(`SELECT * FROM platform_portfolios WHERE id = ?`);
  const refresh = db.prepare(`
    UPDATE platform_portfolios
    SET name = ?, template = ?, account = ?, capital = ?, mode = ?, enabled = ?, params_json = ?, updated_at = ?
    WHERE id = ? AND source = 'builtin'
  `);
  for (const def of builtinPortfolios()) {
    const paramsJson = JSON.stringify(def.params);
    insert.run(
      def.id,
      def.name,
      def.template,
      def.account,
      def.capital,
      def.mode,
      def.enabled ? 1 : 0,
      paramsJson,
      nowMs,
      nowMs,
    );
    const r = current.get(def.id) as any;
    if (r && r.source === "builtin" && (
      r.name !== def.name || r.template !== def.template || r.account !== def.account ||
      r.capital !== def.capital || r.mode !== def.mode || r.enabled !== (def.enabled ? 1 : 0) || r.params_json !== paramsJson
    )) {
      refresh.run(def.name, def.template, def.account, def.capital, def.mode, def.enabled ? 1 : 0, paramsJson, nowMs, def.id);
    }
  }
}

function rowToRecord(r: any): PlatformPortfolioRow {
  return {
    id: r.id,
    name: r.name,
    template: r.template,
    account: r.account,
    capital: r.capital,
    mode: r.mode,
    enabled: r.enabled === 1,
    params: JSON.parse(r.params_json) as PortfolioParams,
    status: r.status,
    validation: r.validation,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Every row, archived included (the read API shows lifecycle state). */
export function loadPlatformPortfolioRows(db: Database): PlatformPortfolioRow[] {
  return (db.prepare("SELECT * FROM platform_portfolios ORDER BY id").all() as any[]).map(rowToRecord);
}

/** F3d: persist an owner-created portfolio (validated by
 *  src/portfolios/validate.ts — this is write plumbing only). */
export function insertPlatformPortfolio(db: Database, row: PlatformPortfolioRow): void {
  db.prepare(`
    INSERT INTO platform_portfolios
      (id, name, template, account, capital, mode, enabled, params_json, status, validation, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.name, row.template, row.account, row.capital, row.mode,
    row.enabled ? 1 : 0, JSON.stringify(row.params), row.status, row.validation,
    row.source, row.createdAt, row.updatedAt,
  );
}

/** F3d: persist an owner edit (id/template/account are immutable — the
 *  validator never changes them; mode belongs to sleeve_modes at runtime). */
export function updatePlatformPortfolio(db: Database, row: PlatformPortfolioRow): void {
  db.prepare(`
    UPDATE platform_portfolios
    SET name = ?, capital = ?, enabled = ?, params_json = ?, status = ?, validation = ?, source = ?, updated_at = ?
    WHERE id = ?
  `).run(
    row.name, row.capital, row.enabled ? 1 : 0, JSON.stringify(row.params),
    row.status, row.validation, row.source, row.updatedAt, row.id,
  );
}

/** The definitions index.ts builds engines from under PORTFOLIOS_SOURCE=db:
 *  every NON-archived row, with `enabled` carrying the row flag (main()'s
 *  per-sleeve gates — env flags included — stay in charge of what builds). */
export function loadPlatformPortfolioDefinitions(db: Database): PortfolioDefinition[] {
  return loadPlatformPortfolioRows(db)
    .filter((r) => r.status !== "archived")
    .map((r) => ({
      id: r.id,
      name: r.name,
      template: r.template,
      account: r.account,
      capital: r.capital,
      mode: r.mode,
      enabled: r.enabled,
      params: r.params,
    }));
}
