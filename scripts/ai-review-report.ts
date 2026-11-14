#!/usr/bin/env bun
// scripts/ai-review-report.ts — the effect ledger of the AI review (docs/reports/IA-revision-de-noticias-2026-11-14.md §4).
// READ-ONLY: data/trading.db and data/historical.db are opened { readonly: true }; nothing is written, no network.
//
//   bun scripts/ai-review-report.ts [--db data/trading.db] [--hist data/historical.db] [--since YYYY-MM-DD] [--json]
//
// By default a short Spanish summary for the owner; --json prints the whole ledger plus `misses` (every strong fall of a held stock
// the review had no action on, src/ai-review/history.ts). Applied days and hypothetical ones
// (the switch was off) are reported separately and never added together. Logic and tests: src/ai-review/effects.ts.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { SleeveId } from "../src/ai-review/contract";
import { AI_REVIEW_START, buildLedger, renderLedger } from "../src/ai-review/effects";
import { findMisses } from "../src/ai-review/history";
import { dailyOpenLookup, readPasses } from "../src/ai-review/journalDb";
import { stockUniverses } from "./ai-review-universes";

export { dailyOpenLookup, readPasses };

/** The ledger and the misses, from the same passes and the same opens. `universes` only matters for the misses. */
export function reportFrom(tradingDbPath: string, histPath: string, since?: string, universes?: Record<SleeveId, readonly string[]>) {
  const db = new Database(tradingDbPath, { readonly: true });
  const hist = new Database(histPath, { readonly: true });
  try {
    // Never before the review's own first session: the journal is older than the review, and a fall of those days is not a miss of it.
    const passes = readPasses(db, since ?? AI_REVIEW_START), opens = dailyOpenLookup(hist);
    const ledger = buildLedger(passes, opens);
    return Object.assign(ledger, { misses: universes ? findMisses(passes, opens, universes) : [] });
  } finally { db.close(); hist.close(); }
}

if (import.meta.main) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : undefined; };
  const tradingPath = arg("--db") ?? "data/trading.db", histPath = arg("--hist") ?? "data/historical.db";
  for (const p of [tradingPath, histPath]) if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(2); }
  const json = process.argv.includes("--json");
  const ledger = reportFrom(tradingPath, histPath, arg("--since"), json ? stockUniverses() : undefined);
  console.log(json ? JSON.stringify({ generatedAt: new Date().toISOString(), ...ledger }, null, 2) : renderLedger(ledger));
}
