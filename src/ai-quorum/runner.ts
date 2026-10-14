// Daily cycle orchestration (línea D). Called by scripts/ai-quorum.ts from
// cron — stocks after the US close (21:15 UTC), crypto at 00:15 UTC. Every
// dependency is injectable so the whole cycle (pending mode included) runs
// under bun test with a fake fetch and temp databases.
//
// Order of one run:
//   1. lazy fill pass (prices whatever became fillable since last run);
//   2. idempotence gate — one snapshot per (assetClass, UTC date);
//   3. build + persist the snapshot (features + headlines);
//   4. pending mode (no keys) → stop here, status "pending_keys";
//   5. daily cost cap gate → status "cost_capped";
//   6. call the 3 providers in parallel (timeout/retries/strict validation
//      inside callProvider), persist every call and every validated view;
//   7. quorum over the models that answered (≥2 required) + positions.

import type { Database } from "bun:sqlite";
import { fillPendingFills } from "./book";
import type { QuorumConfig } from "./config";
import {
  getSnapshot, insertModelCall, insertModelViews, insertQuorumPositions,
  insertSnapshot, setSnapshotStatus, spentTodayUsd,
} from "./db";
import { callProvider } from "./providers";
import { buildPrompt, buildSnapshot, utcDateKey } from "./snapshot";
import type { AssetClass, ModelViews, NewsHeadline } from "./types";
import { computeQuorum } from "./quorum";

export interface RunDeps {
  qdb: Database;
  hist: Database;                    // READ-ONLY handle
  now?: () => number;
  fetchFn?: typeof fetch;
  /** News headlines provider; failures are tolerated (empty list). */
  newsFn?: () => Promise<NewsHeadline[]>;
  log?: (msg: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface RunResult {
  status: "filled_only" | "pending_keys" | "cost_capped" | "ok" | "partial" | "failed";
  snapshotId: number | null;
  modelsAnswered: number;
  positions: number;
  fillsUpdated: number;
}

export async function runCycle(config: QuorumConfig, assetClass: AssetClass, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const ts = now();

  const fillsUpdated = fillPendingFills(deps.qdb, deps.hist, ts);
  if (fillsUpdated > 0) log(`fill pass: ${fillsUpdated} fill leg(s) updated`);

  const dateKey = utcDateKey(ts);
  if (getSnapshot(deps.qdb, assetClass, dateKey)) {
    log(`snapshot ${assetClass}/${dateKey} already exists — idempotent skip`);
    return { status: "filled_only", snapshotId: null, modelsAnswered: 0, positions: 0, fillsUpdated };
  }

  let headlines: NewsHeadline[] = [];
  if (deps.newsFn) {
    try { headlines = await deps.newsFn(); } catch (e: any) { log(`news unavailable: ${e?.message ?? e}`); }
  }

  const snapshot = buildSnapshot(deps.hist, assetClass, ts, headlines);
  if (snapshot.symbols.length === 0) {
    log(`no bars for any ${assetClass} symbol — refusing to snapshot an empty universe`);
    return { status: "failed", snapshotId: null, modelsAnswered: 0, positions: 0, fillsUpdated };
  }

  if (config.pending) {
    const id = insertSnapshot(deps.qdb, snapshot, "pending_keys");
    log(`snapshot ${assetClass}/${dateKey} stored (pending mode — no AI keys configured)`);
    return { status: "pending_keys", snapshotId: id, modelsAnswered: 0, positions: 0, fillsUpdated };
  }

  const spent = spentTodayUsd(deps.qdb, ts);
  if (spent >= config.maxDailyUsd) {
    const id = insertSnapshot(deps.qdb, snapshot, "cost_capped");
    log(`daily cost cap hit ($${spent.toFixed(4)} ≥ $${config.maxDailyUsd}) — snapshot stored, no calls`);
    return { status: "cost_capped", snapshotId: id, modelsAnswered: 0, positions: 0, fillsUpdated };
  }

  const id = insertSnapshot(deps.qdb, snapshot, "failed"); // upgraded below
  const prompt = buildPrompt(snapshot);
  const symbols = snapshot.symbols.map((s) => s.symbol);
  const callOpts = {
    fetchFn: deps.fetchFn,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    estCostPerCallUsd: config.estCostPerCallUsd,
    sleepFn: deps.sleepFn,
  };

  const settled = await Promise.allSettled(
    config.providers.map((p) => callProvider(p, prompt, symbols, callOpts)),
  );
  const answered: ModelViews[] = [];
  for (let i = 0; i < settled.length; i++) {
    const provider = config.providers[i];
    const r = settled[i];
    if (r.status === "fulfilled") {
      insertModelCall(deps.qdb, {
        snapshotId: id, modelId: provider.id, status: "ok",
        latencyMs: r.value.latencyMs, costUsd: r.value.costUsd,
        tokensIn: r.value.tokensIn, tokensOut: r.value.tokensOut, calledAt: ts,
      });
      insertModelViews(deps.qdb, id, provider.id, r.value.views);
      answered.push(r.value.views);
    } else {
      insertModelCall(deps.qdb, {
        snapshotId: id, modelId: provider.id, status: "error",
        error: String((r.reason as any)?.message ?? r.reason).slice(0, 500), calledAt: ts,
      });
      log(`${provider.id} failed: ${(r.reason as any)?.message ?? r.reason}`);
    }
  }

  let positions = 0;
  let status: RunResult["status"];
  if (answered.length === 0) status = "failed";
  else if (answered.length === 1) status = "partial"; // quorum (≥2) impossible
  else {
    const quorum = computeQuorum(answered, symbols);
    insertQuorumPositions(deps.qdb, id, quorum);
    positions = quorum.length;
    status = "ok";
  }
  setSnapshotStatus(deps.qdb, id, status);
  log(`snapshot ${assetClass}/${dateKey}: ${answered.length}/${config.providers.length} models, ${positions} quorum position(s), status=${status}`);
  return { status, snapshotId: id, modelsAnswered: answered.length, positions, fillsUpdated };
}
