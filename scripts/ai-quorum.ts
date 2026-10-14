#!/usr/bin/env bun
// ══════════════════════════════════════════════
// Línea D — AI quorum shadow experiment (docs/reports/LD-quorum-ia.md).
//
//   bun scripts/ai-quorum.ts stocks   # after the US close — cron 21:15 UTC
//   bun scripts/ai-quorum.ts crypto   # UTC day roll       — cron 00:15 UTC
//   bun scripts/ai-quorum.ts fill     # only the lazy fill pass (idempotent)
//   bun scripts/ai-quorum.ts status   # evaluation snapshot to stdout
//
// ISOLATION (by design, see src/ai-quorum/types.ts header): separate process,
// own database data/ai-quorum.db, reads data/historical.db READ-ONLY, never
// imports an engine and never touches trading.db. Without AI_QUORUM_* keys it
// runs in "pending" mode: snapshots are built and stored, nobody is called.
// ══════════════════════════════════════════════

import { loadQuorumConfig } from "../src/ai-quorum/config";
import { openQuorumDb } from "../src/ai-quorum/db";
import { fillPendingFills } from "../src/ai-quorum/book";
import { evaluate, loadEvalSnapshots } from "../src/ai-quorum/evaluate";
import { runCycle } from "../src/ai-quorum/runner";
import { openHistoricalReadOnly } from "../src/ai-quorum/snapshot";
import { getNews } from "../src/dashboard/routes/news";
import type { NewsHeadline } from "../src/ai-quorum/types";

async function headlines(): Promise<NewsHeadline[]> {
  const { items } = await getNews("en");
  return items.slice(0, 12).map((i) => ({ title: i.title, source: i.source }));
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!["stocks", "crypto", "fill", "status"].includes(mode ?? "")) {
    console.error("usage: bun scripts/ai-quorum.ts <stocks|crypto|fill|status>");
    process.exit(2);
  }

  const config = loadQuorumConfig();
  const qdb = openQuorumDb(config.dbPath);
  const hist = openHistoricalReadOnly(config.historicalDbPath);
  const log = (msg: string) => console.log(`[ai-quorum] ${new Date().toISOString()} ${msg}`);

  try {
    if (mode === "fill") {
      const n = fillPendingFills(qdb, hist, Date.now());
      log(`fill pass complete: ${n} fill leg(s) updated`);
    } else if (mode === "status") {
      const ev = evaluate(loadEvalSnapshots(qdb), Date.now());
      console.log(JSON.stringify(ev, null, 2));
    } else {
      const result = await runCycle(config, mode as "stocks" | "crypto", {
        qdb, hist, newsFn: headlines, log,
      });
      log(`done: ${JSON.stringify({ ...result })}`);
    }
  } finally {
    qdb.close();
    hist.close();
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[ai-quorum] fatal: ${e?.message ?? e}`);
    process.exit(1);
  });
}
