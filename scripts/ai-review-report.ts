#!/usr/bin/env bun
// scripts/ai-review-report.ts — the effect ledger of the AI review (docs/reports/IA-revision-de-noticias-2026-11-14.md §4).
// READ-ONLY: data/trading.db and data/historical.db are opened { readonly: true }; nothing is written, no network.
//
//   bun scripts/ai-review-report.ts [--db data/trading.db] [--hist data/historical.db] [--since YYYY-MM-DD] [--json]
//
// By default a short Spanish summary for the owner; --json prints the whole ledger. Applied days and hypothetical ones
// (the switch was off) are reported separately and never added together. Logic and tests: src/ai-review/effects.ts.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { buildLedger, renderLedger, type JournalPass, type OpenLookup } from "../src/ai-review/effects";

/** The session's open from historical.db's daily bars (stamped inside the session's UTC day, Alpaca's 1d convention). */
export function dailyOpenLookup(hist: Database): OpenLookup {
  const q = hist.prepare(`SELECT open FROM historical_bars WHERE symbol = ? AND timeframe = '1d' AND timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC LIMIT 1`);
  return (symbol, session) => {
    const from = Date.parse(`${session}T00:00:00Z`);
    const row = q.get(symbol, from, from + 86_400_000) as { open: number } | null;
    return row && Number.isFinite(row.open) && row.open > 0 ? row.open : null;
  };
}

/** Every completed live pass of the stock sleeves, with only the review's own part of its diagnostics (the rest is large). */
export function readPasses(db: Database, since?: string): JournalPass[] {
  const has = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'portfolio_decisions'`).get();
  if (!has) return [];
  const rows = db.prepare(`SELECT account_id, session, status, equity, json_extract(diagnostics_json, '$.aiReview') AS ai
    FROM portfolio_decisions WHERE mode = 'live' AND status IN ('submitted', 'decided') AND account_id IN ('momentum_stocks', 'meanrev_stocks')
      AND session >= ? ORDER BY session, id`).all(since ?? "0000-00-00") as Array<{ account_id: string; session: string; status: string; equity: number; ai: string | null }>;
  return rows.map(r => {
    let aiReview: unknown = undefined;
    try { aiReview = r.ai ? JSON.parse(r.ai) : undefined; } catch { /* a malformed record reads as no review */ }
    return { sleeve: r.account_id, session: r.session, status: r.status, equity: r.equity, diagnostics: { aiReview } };
  });
}

export function reportFrom(tradingDbPath: string, histPath: string, since?: string) {
  const db = new Database(tradingDbPath, { readonly: true });
  const hist = new Database(histPath, { readonly: true });
  try { return buildLedger(readPasses(db, since), dailyOpenLookup(hist)); } finally { db.close(); hist.close(); }
}

if (import.meta.main) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : undefined; };
  const tradingPath = arg("--db") ?? "data/trading.db", histPath = arg("--hist") ?? "data/historical.db";
  for (const p of [tradingPath, histPath]) if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(2); }
  const ledger = reportFrom(tradingPath, histPath, arg("--since"));
  console.log(process.argv.includes("--json") ? JSON.stringify({ generatedAt: new Date().toISOString(), ...ledger }, null, 2) : renderLedger(ledger));
}
