#!/usr/bin/env bun
/**
 * Line B orchestrator (docs/reports/V-plan-volumen-rentabilidad.md §12):
 * manifest-driven nested walk-forward for the short-term reversal kernel
 * (scripts/stocks-reversal-replay.ts), producing the SAME summary schema as
 * scripts/walk-forward.ts (stitchedOos, outerSelection, outerPsr, foldPsr,
 * breakEvenCurve, acceptance, …) plus the §12-specific evidence fields
 * (corrVsLive, yearPnlShares, exTopDecile, ordersPerDay).
 *
 * It deliberately does NOT touch scripts/walk-forward.ts (parallel research
 * lines share that file); instead it imports its exported building blocks so
 * both protocols judge evidence with the same instruments:
 *   - generateFolds / stitchEquityHistory / stitchedMetrics /
 *     computeOuterEvidence / breakEvenFromCurve / benchmarkFromFoldBars /
 *     concentration / aggregateInner / selectCandidate / correctedDsr /
 *     hashDataSnapshot / hashCodeFiles / runIdentityHash / canonicalJson /
 *     writeOutputs, and computeSequenceRisk from scripts/lib.
 *
 * §12 common criteria (A/B/C) → acceptance gates, pre-registered in the
 * manifest and never reinterpreted here:
 *   1. pure OOS chain: nested purged walk-forward, ≥3 outer folds, selection
 *      inner-only, outerSelection persisted (structural — this driver).
 *   2. minSharpe ≥ 1.0 (stitched OOS, base costs) and minOuterPsr ≥ 0.95.
 *   3. stressMinSharpe ≥ 0.5 (stress cost tier).
 *   4. minBreakEvenExtraBpsPerSide: first Sharpe≤0 crossing of the per-side
 *      slippage curve MINUS the base per-side cost must be ≥ 2× base.
 *   5. maxCorrVsLive ≤ 0.30: Pearson correlation of the stitched OOS daily
 *      returns vs the capital-weighted combination of the four authoritative
 *      live chains (manifest.liveArtifacts, daily returns reconstructed from
 *      each artifact's runs.jsonl outer base trials).
 *   6. maxDrawdown ≤ 0.25 at the proposed size (ledger.initialEquity ×
 *      maxGrossMult is built into the kernel sizing).
 *   7. robustness: maxYearPnlShare ≤ 0.50 (no calendar year contributes more
 *      than half the OOS P&L) and exTopDecileMinSharpe ≥ 0.5 (OOS chain
 *      re-run excluding the top 10% symbols by P&L).
 *   8. ordersPerDay reported (no minimum).
 *
 * Usage: bun scripts/stocks-reversal-wf.ts experiments/<manifest>.json [--dry-run] [--no-breakeven]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  aggregateInner,
  benchmarkFromFoldBars,
  breakEvenFromCurve,
  BREAK_EVEN_SLIPPAGE_BPS,
  canonicalJson,
  computeOuterEvidence,
  concentration,
  correctedDsr,
  generateFolds,
  hashCodeFiles,
  hashDataSnapshot,
  isChainRuined,
  makeTrialId,
  ledgerComplete,
  runIdentityHash,
  selectCandidate,
  stitchedDailyReturns,
  stitchEquityHistory,
  stitchedMetrics,
  writeOutputs,
  type InnerMetrics,
  type TrialRecord,
  type WalkForwardSummary,
  type WindowConfig,
} from "./walk-forward";
import { loadBars, type ReplayResult, type Sleeve } from "./backtest-momentum-wf";
import { computeSequenceRisk } from "./lib/sequenceRisk";
import { expandDataPath } from "./lib/researchData";
import { hashCloseSlices } from "./lib/closeSlices";
import { hashStConfig, runStReversalReplay, type CloseReversalSpec, type StReversalConfig, type StReversalParams, type StReversalResult } from "./stocks-reversal-replay";

// ── manifest schema ──────────────────────────────────────────────────────
export interface StCandidate extends StReversalParams {
  name: string;
  /** §12-septies line G (OPT-IN; absent = the exact line-B/B2 candidate AND
   *  its legacy hash). See CloseReversalSpec in stocks-reversal-replay.ts. */
  closeReversal?: CloseReversalSpec;
}

export interface StManifest {
  name: string;
  sleeve: "streversal";
  description?: string;
  trialAccounting: { priorUniqueTrials: number; complete: boolean };
  data: {
    dbPath: string;
    source: string;
    timeframe: string;
    refSymbol: string;
    sectorEtfs: string[];
    membership: { index: string; exclude: string[] };
    corrLookbackSessions: number;
    sectorRefreshSessions: number;
    /** 15:45-slice database (§12-septies G — required when any candidate
     *  sets closeReversal). "$UC_RESEARCH_DATA_DIR/…" is expanded at use;
     *  runtime-only (never hashed as a path — the slice ROWS enter the data
     *  identity via hashCloseSlices). */
    sliceDb?: string;
  };
  asOf: string; // pinned ISO timestamp (no "latest" — pre-registered identity)
  window: WindowConfig;
  costs: {
    base: { perSideBps: number; shortBorrowAnnual: number };
    stress: { perSideBps: number; shortBorrowAnnual: number };
  };
  ledger: {
    initialEquity: number;
    maxGrossMult: number;
    /** B2 (§12-bis) sizing axis — both OPTIONAL and opt-in (absent = the
     *  exact line-B behavior AND the legacy candidate hashes). */
    sizing?: "equityProportional";
    fractionalLongs?: boolean;
  };
  candidates: StCandidate[];
  /** The four authoritative live chains with their capital weights —
   *  criterion 5's comparison portfolio, pinned before running. */
  liveArtifacts: Array<{ sleeve: string; path: string; capitalUsd: number }>;
  acceptance: {
    minSharpe: number;
    minOuterPsr: number;
    stressMinSharpe: number;
    minBreakEvenExtraBpsPerSide: number;
    maxCorrVsLive: number;
    maxDrawdown: number;
    maxYearPnlShare: number;
    exTopDecileMinSharpe: number;
  };
}

const CANDIDATE_KEYS = new Set(["name", "lookbackDays", "holdDays", "residual", "slotsPerSide", "closeReversal"]);

/** Strict shape check for a CloseReversalSpec (§12-septies G) — an unknown
 *  key would be silently dropped (config that changes nothing). */
function validateCloseReversal(cr: unknown, name: string): void {
  if (!cr || typeof cr !== "object" || Array.isArray(cr)) throw new Error(`candidate ${name}: closeReversal must be an object`);
  const obj = cr as Record<string, unknown>;
  const allowed = ["entryRsi", "smaLong", "minPrice", "minPriorCloses", "exit", "smaExit", "hardStop", "short"];
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`candidate ${name}: closeReversal has unknown keys: ${unknown.join(", ")}`);
  if (!Number.isFinite(obj.entryRsi) || (obj.entryRsi as number) <= 0 || (obj.entryRsi as number) >= 100) throw new Error(`candidate ${name}: closeReversal.entryRsi must be in (0, 100)`);
  if (!Number.isInteger(obj.smaLong) || (obj.smaLong as number) < 2) throw new Error(`candidate ${name}: closeReversal.smaLong must be an integer >= 2`);
  if (!Number.isFinite(obj.minPrice) || (obj.minPrice as number) < 0) throw new Error(`candidate ${name}: closeReversal.minPrice must be >= 0`);
  if (!Number.isInteger(obj.minPriorCloses) || (obj.minPriorCloses as number) < (obj.smaLong as number) + 1) {
    throw new Error(`candidate ${name}: closeReversal.minPriorCloses must be an integer >= smaLong + 1`);
  }
  if (obj.exit !== "nextOpen" && obj.exit !== "nextClose" && obj.exit !== "sma5") throw new Error(`candidate ${name}: closeReversal.exit must be "nextOpen" | "nextClose" | "sma5"`);
  if (obj.exit === "sma5") {
    if (!Number.isInteger(obj.smaExit) || (obj.smaExit as number) < 1) throw new Error(`candidate ${name}: closeReversal.smaExit must be a positive integer with exit="sma5"`);
  } else if (obj.smaExit !== undefined) {
    throw new Error(`candidate ${name}: closeReversal.smaExit only applies to exit="sma5"`);
  }
  if (obj.hardStop !== undefined) {
    const hs = obj.hardStop as Record<string, unknown>;
    const hsKeys = ["kSigma", "lookbackBars", "minPct", "maxPct"];
    const hsUnknown = Object.keys(hs).filter(k => !hsKeys.includes(k));
    if (hsUnknown.length > 0) throw new Error(`candidate ${name}: closeReversal.hardStop has unknown keys: ${hsUnknown.join(", ")}`);
    if (!Number.isFinite(hs.kSigma) || (hs.kSigma as number) <= 0) throw new Error(`candidate ${name}: closeReversal.hardStop.kSigma must be positive`);
    if (!Number.isInteger(hs.lookbackBars) || (hs.lookbackBars as number) < 2) throw new Error(`candidate ${name}: closeReversal.hardStop.lookbackBars must be an integer >= 2`);
    if (!Number.isFinite(hs.minPct) || (hs.minPct as number) <= 0) throw new Error(`candidate ${name}: closeReversal.hardStop.minPct must be positive (percent-units)`);
    if (!Number.isFinite(hs.maxPct) || (hs.maxPct as number) < (hs.minPct as number)) throw new Error(`candidate ${name}: closeReversal.hardStop.maxPct must be >= minPct`);
  }
  if (obj.short !== undefined) {
    const sh = obj.short as Record<string, unknown>;
    const shUnknown = Object.keys(sh).filter(k => k !== "entryRsi");
    if (shUnknown.length > 0) throw new Error(`candidate ${name}: closeReversal.short has unknown keys: ${shUnknown.join(", ")}`);
    if (!Number.isFinite(sh.entryRsi) || (sh.entryRsi as number) <= 0 || (sh.entryRsi as number) >= 100) throw new Error(`candidate ${name}: closeReversal.short.entryRsi must be in (0, 100)`);
    if (obj.exit !== "nextOpen") throw new Error(`candidate ${name}: closeReversal.short requires exit="nextOpen" (§12-septies G4)`);
  }
}

export function validateStManifest(m: StManifest): StManifest {
  if (m.sleeve !== "streversal") throw new Error('sleeve must be "streversal"');
  if (!Number.isInteger(m.trialAccounting?.priorUniqueTrials) || m.trialAccounting.priorUniqueTrials < 0) {
    throw new Error("trialAccounting.priorUniqueTrials must be a non-negative integer");
  }
  if (m.trialAccounting.complete !== false) throw new Error("trialAccounting.complete must be false (scope is incomplete by declaration)");
  if (!Array.isArray(m.data.sectorEtfs) || m.data.sectorEtfs.length === 0) throw new Error("data.sectorEtfs must not be empty");
  if (!m.data.membership?.index || !Array.isArray(m.data.membership.exclude)) throw new Error("data.membership.{index,exclude} required");
  if (new Set(m.data.membership.exclude).size !== m.data.membership.exclude.length) throw new Error("membership.exclude has duplicates");
  if (!Number.isInteger(m.data.corrLookbackSessions) || m.data.corrLookbackSessions < 20) throw new Error("corrLookbackSessions must be an integer >= 20");
  if (!Number.isInteger(m.data.sectorRefreshSessions) || m.data.sectorRefreshSessions < 1) throw new Error("sectorRefreshSessions must be a positive integer");
  if (!Number.isFinite(Date.parse(m.asOf)) || m.asOf.toLowerCase() === "latest") throw new Error("asOf must be a pinned ISO timestamp");
  if (!Number.isInteger(m.window.outerFoldCount) || m.window.outerFoldCount < 3) throw new Error("outerFoldCount must be an integer >= 3 (§12 criterion 1)");
  for (const tier of ["base", "stress"] as const) {
    const c = m.costs[tier];
    if (!(c.perSideBps >= 0) || !(c.shortBorrowAnnual >= 0 && c.shortBorrowAnnual < 1)) throw new Error(`costs.${tier} invalid`);
  }
  if (!(m.ledger.initialEquity > 0) || !(m.ledger.maxGrossMult > 0)) throw new Error("ledger values must be positive");
  if (m.ledger.sizing !== undefined && m.ledger.sizing !== "equityProportional") {
    throw new Error('ledger.sizing only accepts "equityProportional" — omit the key for fixed-notional slots');
  }
  if (m.ledger.fractionalLongs !== undefined && typeof m.ledger.fractionalLongs !== "boolean") {
    throw new Error("ledger.fractionalLongs must be boolean");
  }
  if (!Array.isArray(m.candidates) || m.candidates.length === 0 || m.candidates.length > 4) {
    throw new Error("candidates must be 1..4 (§12: at most 4 per line, declared before running)");
  }
  for (const c of m.candidates) {
    const unknown = Object.keys(c).filter(k => !CANDIDATE_KEYS.has(k));
    if (unknown.length > 0) throw new Error(`candidate ${c.name}: unknown keys ${unknown.join(", ")}`);
    if (!Number.isInteger(c.lookbackDays) || c.lookbackDays < 1 || c.lookbackDays > 5) throw new Error(`candidate ${c.name}: lookbackDays must be 1..5 (§12 line B)`);
    if (!Number.isInteger(c.holdDays) || c.holdDays < 1) throw new Error(`candidate ${c.name}: holdDays must be a positive integer`);
    if (c.residual !== "sector" && c.residual !== "none") throw new Error(`candidate ${c.name}: residual must be "sector" or "none"`);
    if (!Number.isInteger(c.slotsPerSide) || c.slotsPerSide < 1) throw new Error(`candidate ${c.name}: slotsPerSide must be a positive integer`);
    if (c.closeReversal !== undefined) {
      validateCloseReversal(c.closeReversal, c.name);
      // The kernel pins the legacy knobs to inert values in this mode.
      if (c.residual !== "none") throw new Error(`candidate ${c.name}: closeReversal requires residual="none"`);
      if (c.lookbackDays !== 1) throw new Error(`candidate ${c.name}: closeReversal requires lookbackDays=1 (inert)`);
    }
  }
  // §12-septies G: the slice DB and the closeReversal mode come and go
  // together (same philosophy as the walk-forward sliceDb check).
  {
    const wantsCr = m.candidates.some(c => c.closeReversal !== undefined);
    if (wantsCr && !m.data.sliceDb) throw new Error("closeReversal candidates require data.sliceDb (the 15:45-slice database)");
    if (m.data.sliceDb !== undefined && !wantsCr) throw new Error("data.sliceDb set but no candidate uses closeReversal (config that changes nothing)");
  }
  if (!Array.isArray(m.liveArtifacts) || m.liveArtifacts.length === 0) throw new Error("liveArtifacts must list the authoritative live chains");
  const a = m.acceptance;
  for (const k of ["minSharpe", "minOuterPsr", "stressMinSharpe", "minBreakEvenExtraBpsPerSide", "maxCorrVsLive", "maxDrawdown", "maxYearPnlShare", "exTopDecileMinSharpe"] as const) {
    if (!Number.isFinite(a?.[k])) throw new Error(`acceptance.${k} must be set (pre-registered §12 gate)`);
  }
  return m;
}

export function candidateToStConfig(
  m: StManifest,
  c: StCandidate,
  tier: "base" | "stress",
  dbPathOverride?: string,
  slippageOverrideBps?: number,
): StReversalConfig {
  const cost = m.costs[tier];
  return {
    sleeve: "streversal",
    dbPath: dbPathOverride ?? m.data.dbPath,
    source: m.data.source,
    timeframe: m.data.timeframe,
    refSymbol: m.data.refSymbol,
    sectorEtfs: [...m.data.sectorEtfs],
    membership: { index: m.data.membership.index, exclude: [...m.data.membership.exclude] },
    corrLookbackSessions: m.data.corrLookbackSessions,
    sectorRefreshSessions: m.data.sectorRefreshSessions,
    slippageBps: slippageOverrideBps ?? cost.perSideBps,
    commissionBps: 0,
    shortBorrowAnnual: cost.shortBorrowAnnual,
    initialEquity: m.ledger.initialEquity,
    maxGrossMult: m.ledger.maxGrossMult,
    params: { lookbackDays: c.lookbackDays, holdDays: c.holdDays, residual: c.residual, slotsPerSide: c.slotsPerSide },
    warmupDays: m.window.warmupDays,
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
    // B2 axis: undefined keys are dropped by canonicalJson — legacy hashes
    // (line B) stay byte-identical when the manifest doesn't set them.
    sizing: m.ledger.sizing,
    fractionalLongs: m.ledger.fractionalLongs || undefined,
    // §12-septies G axis: undefined = legacy hash. sliceDbPath is runtime-
    // only (hashStConfig excludes it) and expanded here.
    closeReversal: c.closeReversal,
    sliceDbPath: m.data.sliceDb !== undefined ? expandDataPath(m.data.sliceDb) : undefined,
  };
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Cast: StReversalResult is structurally compatible with every field the
 *  shared helpers read (equityHistory, closedTrades, fees, funding,
 *  liquidations, marginRejects, ruined, dailyReturns, tradesBySymbol,
 *  window.label, fromMs/toMs, config.{rthOnly,source,sleeve,initialEquity}). */
const asReplay = (r: StReversalResult): ReplayResult => r as unknown as ReplayResult;

// ── criterion 5: correlation vs the live combined portfolio ─────────────
/**
 * Reconstruct an authoritative artifact's stitched OOS daily returns from
 * its runs.jsonl: outer base trials (foldPath "k/test", costTier base)
 * whose candidateHash matches the summary's per-fold outerSelection.
 */
export function artifactOosDailyReturns(artifactDir: string): Map<string, number> {
  const summary = JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8"));
  const selection = new Map<string, string>(
    (summary.outerSelection ?? []).map((s: { foldPath: string; candidateHash: string }) => [s.foldPath, s.candidateHash]),
  );
  if (selection.size === 0) throw new Error(`artifact ${artifactDir}: no outerSelection in summary.json`);
  const out = new Map<string, number>();
  const lines = readFileSync(join(artifactDir, "runs.jsonl"), "utf8").trim().split("\n");
  for (const line of lines) {
    const t = JSON.parse(line);
    if (t.costTier !== "base" || t.status !== "complete" || !t.result) continue;
    const want = selection.get(t.foldPath);
    if (!want || t.candidateHash !== want) continue;
    for (const d of t.result.dailyReturns ?? []) out.set(d.date, d.ret);
  }
  if (out.size === 0) throw new Error(`artifact ${artifactDir}: no OOS daily returns reconstructed`);
  return out;
}

/**
 * Pearson correlation of `mine` (date → daily return) against the
 * capital-weighted sum of the live chains' daily returns; a chain with no
 * observation on a date contributes 0 (flat book that day). Dates = the
 * intersection of mine with the union of the live chains' dates.
 */
export function corrVsLivePortfolio(
  mine: Array<{ date: string; ret: number }>,
  liveArtifacts: Array<{ path: string; capitalUsd: number }>,
): { corr: number; observations: number } {
  const chains = liveArtifacts.map(a => ({ rets: artifactOosDailyReturns(a.path), w: a.capitalUsd }));
  const totalW = chains.reduce((s, c) => s + c.w, 0);
  const xs: number[] = [], ys: number[] = [];
  for (const d of mine) {
    let any = false, acc = 0;
    for (const c of chains) {
      const r = c.rets.get(d.date);
      if (r !== undefined) { any = true; acc += (c.w / totalW) * r; }
    }
    if (!any) continue;
    xs.push(d.ret);
    ys.push(acc);
  }
  const n = xs.length;
  if (n < 30) throw new Error(`corrVsLive: only ${n} overlapping daily observations`);
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  if (sxx < 1e-18 || syy < 1e-18) return { corr: 0, observations: n };
  return { corr: sxy / Math.sqrt(sxx * syy), observations: n };
}

// ── criterion 7a: calendar-year P&L shares ───────────────────────────────
export function yearPnlShares(history: Array<{ t: number; eq: number }>): { byYear: Record<string, number>; maxShare: number; totalPnl: number } {
  const byYear: Record<string, number> = {};
  for (let i = 1; i < history.length; i++) {
    const year = new Date(history[i].t).toISOString().slice(0, 4);
    byYear[year] = (byYear[year] ?? 0) + (history[i].eq - history[i - 1].eq);
  }
  const totalPnl = Object.values(byYear).reduce((s, v) => s + v, 0);
  let maxShare = Infinity; // fail closed when totalPnl <= 0
  if (totalPnl > 0) maxShare = Math.max(...Object.values(byYear).map(v => v / totalPnl));
  return { byYear, maxShare, totalPnl };
}

// ── main protocol ────────────────────────────────────────────────────────
export async function runStWalkForward(
  m: StManifest,
  opts: { dryRun?: boolean; breakEven?: boolean } = {},
): Promise<{ summary: WalkForwardSummary & Record<string, unknown>; outputDir: string; trials: TrialRecord[] }> {
  validateStManifest(m);
  // Unique effective candidates (same guard as the shared harness).
  {
    const seen = new Map<string, string>();
    for (const c of m.candidates) {
      const h = hashStConfig(candidateToStConfig(m, c, "base"));
      if (seen.has(h)) throw new Error(`duplicate effective candidate: ${c.name} == ${seen.get(h)}`);
      seen.set(h, c.name);
    }
  }
  const codeHash = await hashCodeFiles([
    "bun.lock",
    "package.json",
    "scripts/backtest-momentum-wf.ts",
    "scripts/lib/closeSlices.ts",
    "scripts/lib/membership.ts",
    "scripts/lib/sequenceRisk.ts",
    "scripts/stocks-reversal-replay.ts",
    "scripts/stocks-reversal-wf.ts",
    "scripts/walk-forward.ts",
    "src/db/database.ts",
    "src/portfolio/trackRecord.ts",
    "src/reports/metrics.ts",
    "src/strategies/meanrev/MeanRevEngine.ts",
    "src/strategies/momentum/MomentumEngine.ts",
    "src/utils/marketHours.ts",
  ].sort());

  const tmpDir = mkdtempSync(join(tmpdir(), "uncle-carl-stwf-"));
  const snapshotPath = join(tmpDir, "snapshot.db");
  try {
    const srcDb = new Database(m.data.dbPath, { readonly: true });
    try { srcDb.exec(`VACUUM INTO '${snapshotPath}'`); } finally { srcDb.close(); }

    const asOfMs = Date.parse(m.asOf);
    const folds = generateFolds(m.window, asOfMs);
    const replayToMs = folds[folds.length - 1].test.toMs;
    const sleeveLike = {
      name: m.sleeve,
      universe: [...new Set([m.data.refSymbol, ...m.data.sectorEtfs])],
      timeframe: m.data.timeframe,
      source: m.data.source,
      rthOnly: false,
      funding: false,
    } as unknown as Sleeve;
    const barsDataHash = await hashDataSnapshot(
      snapshotPath, sleeveLike, Date.parse(m.window.from), replayToMs, m.window.warmupDays, m.data.membership,
    );
    // §12-septies G: the 15:45-slice rows are consumed data — part of the
    // run's data identity. Absent sliceDb = legacy dataHash, byte-identical.
    const dataHash = m.data.sliceDb
      ? hashString(canonicalJson({ bars: barsDataHash, closeSlices: hashCloseSlices(expandDataPath(m.data.sliceDb)) }))
      : barsDataHash;
    const identity = (() => {
      const { ...rest } = m;
      return {
        ...rest,
        asOfResolved: new Date(asOfMs).toISOString(),
        foldBoundaries: folds.map(f => ({
          path: f.path, testFromMs: f.test.fromMs, testToMs: f.test.toMs,
          innerBoundaries: f.inner.map(i => ({ path: i.path, fromMs: i.fromMs, toMs: i.toMs })),
        })),
      };
    })();
    const configHash = hashString(canonicalJson(identity));
    const manifestHash = runIdentityHash(configHash, dataHash, codeHash);
    const outputDir = join("data", "backtests", manifestHash);

    const allTrials: TrialRecord[] = [];
    const runsById = new Map<string, TrialRecord>();
    const runTrial = async (
      c: StCandidate, fold: { path: string; fromMs: number; toMs: number }, tier: "base" | "stress", slippageOverrideBps?: number,
    ): Promise<TrialRecord> => {
      const cfg = candidateToStConfig(m, c, tier, snapshotPath, slippageOverrideBps);
      const candidateHash = hashStConfig(cfg);
      const id = makeTrialId(fold.path, candidateHash, tier);
      const cached = runsById.get(id);
      if (cached) return cached;
      const record: TrialRecord = {
        id, candidateHash, candidateName: c.name, foldPath: fold.path, costTier: tier,
        fromMs: fold.fromMs, toMs: fold.toMs, status: "running",
        hash: hashString(canonicalJson({ candidateHash, foldPath: fold.path, costTier: tier, contextHash: manifestHash })),
      };
      const win = { label: fold.path, from: new Date(fold.fromMs).toISOString(), to: new Date(fold.toMs).toISOString() };
      const result = await runStReversalReplay(cfg, win);
      if (result) { record.status = "complete"; record.result = asReplay(result); }
      else record.status = "failed";
      runsById.set(id, record);
      allTrials.push(record);
      return record;
    };

    // ── inner selection + outer/stress chains ─────────────────────────────
    const innerMetrics: InnerMetrics[] = [];
    const outerTestResults: StReversalResult[] = [];
    const stressResults: StReversalResult[] = [];
    const selectedByOuter = new Map<string, StCandidate>();
    const outerSelection: Array<{ foldPath: string; candidateName: string; candidateHash: string }> = [];
    const skippedFolds: string[] = [];
    let baseChainBroken = false;
    let stressChainBroken = false;

    for (const outer of folds) {
      if (outer.inner.length === 0) { skippedFolds.push(outer.path); continue; }
      const foldInner: InnerMetrics[] = [];
      if (!opts.dryRun) {
        for (const inner of outer.inner) {
          for (const c of m.candidates) {
            const rec = await runTrial(c, inner, "base");
            if (rec.status === "complete" && rec.result) {
              foldInner.push({
                candidateHash: rec.candidateHash,
                candidateName: rec.candidateName,
                foldPath: inner.path,
                dsr: correctedDsr(rec.result, m.candidates.length, m.trialAccounting.priorUniqueTrials, m.sleeve),
                sharpe: rec.result.sharpe,
                maxDrawdown: rec.result.maxDrawdown,
                totalReturn: rec.result.totalReturn,
                trades: rec.result.trades,
              });
            }
          }
        }
      }
      innerMetrics.push(...foldInner);
      const aggregates = aggregateInner(foldInner);
      if (aggregates.length === 0) { if (!opts.dryRun) skippedFolds.push(outer.path); continue; }
      const winner = selectCandidate(aggregates);
      const selected = m.candidates.find(c => hashStConfig(candidateToStConfig(m, c, "base", snapshotPath)) === winner.candidateHash);
      if (!selected) { skippedFolds.push(outer.path); continue; }
      selectedByOuter.set(outer.path, selected);
      outerSelection.push({ foldPath: outer.test.path, candidateName: selected.name, candidateHash: winner.candidateHash });

      if (baseChainBroken) skippedFolds.push(`${outer.test.path}:base`);
      else {
        const rec = await runTrial(selected, outer.test, "base");
        if (rec.status === "complete" && rec.result) {
          outerTestResults.push(rec.result as unknown as StReversalResult);
          if (isChainRuined(rec.result)) { baseChainBroken = true; skippedFolds.push(`${outer.test.path}:base:ruined`); }
        }
      }
      if (stressChainBroken) skippedFolds.push(`${outer.test.path}:stress`);
      else {
        const rec = await runTrial(selected, outer.test, "stress");
        if (rec.status === "complete" && rec.result) {
          stressResults.push(rec.result as unknown as StReversalResult);
          if (isChainRuined(rec.result)) { stressChainBroken = true; skippedFolds.push(`${outer.test.path}:stress:ruined`); }
        }
      }
    }

    // ── break-even per-side cost curve (criterion 4) ──────────────────────
    let breakEvenCurve: Array<{ slippageBps: number; sharpe: number; totalReturn: number }> | undefined;
    let breakEvenSlippageBps: number | undefined;
    if (!opts.dryRun && (opts.breakEven ?? true) && selectedByOuter.size > 0) {
      breakEvenCurve = [];
      for (const level of BREAK_EVEN_SLIPPAGE_BPS) {
        let tierBroken = false;
        const tierResults: StReversalResult[] = [];
        for (const outer of folds) {
          const selected = selectedByOuter.get(outer.path);
          if (!selected || tierBroken) continue;
          const rec = await runTrial(selected, outer.test, "base", level);
          if (rec.status === "complete" && rec.result) {
            tierResults.push(rec.result as unknown as StReversalResult);
            if (isChainRuined(rec.result)) tierBroken = true;
          } else tierBroken = true;
        }
        if (tierResults.length > 0) {
          const h = stitchEquityHistory(tierResults.map(asReplay), m.ledger.initialEquity);
          const sm = stitchedMetrics(h, tierResults.map(asReplay), 252);
          breakEvenCurve.push({ slippageBps: level, sharpe: sm.sharpe, totalReturn: sm.totalReturn });
        }
      }
      breakEvenSlippageBps = breakEvenFromCurve(breakEvenCurve);
    }

    // ── stitched OOS + evidence ───────────────────────────────────────────
    const outerReplay = outerTestResults.map(asReplay);
    const stitchedHistory = stitchEquityHistory(outerReplay, m.ledger.initialEquity);
    const stitched = stitchedMetrics(stitchedHistory, outerReplay, 252);
    const conc = concentration(outerReplay);
    const evidence = computeOuterEvidence(outerReplay, stitchedHistory, 252);
    const sequenceRisk = outerReplay.length > 0
      ? computeSequenceRisk(
          stitchedDailyReturns(stitchedHistory, false),
          outerReplay.flatMap(r => r.closedTrades).sort((a, b) => a.exitAt - b.exitAt).map(t => t.pnl),
          m.ledger.initialEquity,
        )
      : undefined;

    // Benchmark (refSymbol B&H on the same folds).
    let benchReturn: number | undefined, benchSharpe: number | undefined;
    let benchByFold: Array<{ foldPath: string; benchReturn: number }> | undefined;
    let benchError: string | undefined;
    if (outerTestResults.length > 0) {
      const snapDb = new Database(snapshotPath, { readonly: true });
      try {
        const foldBars = [...outerTestResults].sort((a, b) => a.fromMs - b.fromMs).map(r => ({
          foldPath: r.window.label,
          fromMs: r.fromMs,
          bars: loadBars(m.data.refSymbol, m.data.timeframe, m.data.source, false, r.fromMs, r.toMs, snapDb),
        }));
        const bench = benchmarkFromFoldBars(foldBars, 252, false);
        benchReturn = bench.benchReturn; benchSharpe = bench.benchSharpe; benchByFold = bench.byFold;
      } catch (e) { benchError = (e as Error).message; } finally { snapDb.close(); }
    }

    // ── §12-specific evidence ─────────────────────────────────────────────
    const myDaily = outerTestResults
      .sort((a, b) => a.fromMs - b.fromMs)
      .flatMap(r => r.dailyReturns);
    let corrVsLive: { corr: number; observations: number } | undefined;
    let corrError: string | undefined;
    if (!opts.dryRun && myDaily.length > 0) {
      try { corrVsLive = corrVsLivePortfolio(myDaily, m.liveArtifacts); }
      catch (e) { corrError = (e as Error).message; }
    }
    const years = yearPnlShares(stitchedHistory);

    // Criterion 7b: re-run the OOS chain excluding the top 10% symbols by
    // total OOS P&L (positive contributors first).
    let exTopDecile: { excluded: string[]; sharpe: number; totalReturn: number; maxDrawdown: number } | undefined;
    if (!opts.dryRun && outerTestResults.length > 0) {
      const pnlBySym = new Map<string, number>();
      for (const r of outerTestResults) {
        for (const [sym, v] of Object.entries(r.tradesBySymbol)) {
          if (v.trades > 0) pnlBySym.set(sym, (pnlBySym.get(sym) ?? 0) + v.grossPnl);
        }
      }
      const ranked = [...pnlBySym.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const nExcl = Math.max(1, Math.ceil(ranked.length * 0.10));
      const excludedSyms = ranked.slice(0, nExcl).map(([s]) => s);
      const mExcl: StManifest = {
        ...m,
        data: { ...m.data, membership: { ...m.data.membership, exclude: [...m.data.membership.exclude, ...excludedSyms] } },
      };
      const exclResults: StReversalResult[] = [];
      let broken = false;
      for (const outer of folds) {
        const selected = selectedByOuter.get(outer.path);
        if (!selected || broken) continue;
        const cfg = candidateToStConfig(mExcl, selected, "base", snapshotPath);
        const win = { label: `${outer.test.path}/exTop10`, from: new Date(outer.test.fromMs).toISOString(), to: new Date(outer.test.toMs).toISOString() };
        const r = await runStReversalReplay(cfg, win);
        if (!r) { broken = true; continue; }
        exclResults.push(r);
        if (r.ruined) broken = true;
      }
      if (exclResults.length > 0) {
        const h = stitchEquityHistory(exclResults.map(asReplay), m.ledger.initialEquity);
        const sm = stitchedMetrics(h, exclResults.map(asReplay), 252);
        exTopDecile = { excluded: excludedSyms, sharpe: sm.sharpe, totalReturn: sm.totalReturn, maxDrawdown: sm.maxDrawdown };
      }
    }

    // Criterion 8: executed orders/day over the OOS (entry+exit each count).
    const totalSessions = outerTestResults.reduce((s, r) => s + r.sessions, 0);
    const totalOrders = outerTestResults.reduce((s, r) => s + r.trades * 2, 0);
    const oosCalendarDays = outerTestResults.reduce((s, r) => s + (r.toMs - r.fromMs) / 86_400_000, 0);
    const ordersPerDay = {
      perSession: totalSessions > 0 ? totalOrders / totalSessions : 0,
      perCalendarDay: oosCalendarDays > 0 ? totalOrders / oosCalendarDays : 0,
      totalOrders,
      totalSessions,
    };

    // ── §12 acceptance gates ──────────────────────────────────────────────
    const a = m.acceptance;
    const gates: WalkForwardSummary["acceptance"] = {};
    gates.minSharpe = { gate: "minSharpe", value: stitched.sharpe, threshold: a.minSharpe, pass: stitched.sharpe >= a.minSharpe };
    gates.minOuterPsr = {
      gate: "minOuterPsr", value: evidence.outerPsr ?? NaN, threshold: a.minOuterPsr,
      pass: evidence.outerPsr !== undefined && evidence.outerPsr >= a.minOuterPsr,
      ...(evidence.outerPsr === undefined ? { reason: "outer PSR not computed" } : {}),
    };
    {
      const sm = stressResults.length > 0
        ? stitchedMetrics(stitchEquityHistory(stressResults.map(asReplay), m.ledger.initialEquity), stressResults.map(asReplay), 252)
        : undefined;
      gates.stressMinSharpe = {
        gate: "stressMinSharpe", value: sm?.sharpe ?? NaN, threshold: a.stressMinSharpe,
        pass: sm !== undefined && sm.sharpe >= a.stressMinSharpe,
        ...(sm === undefined ? { reason: "missing stress results" } : {}),
      };
    }
    {
      const basePerSide = m.costs.base.perSideBps;
      const extra = breakEvenSlippageBps === undefined ? undefined
        : breakEvenSlippageBps === Infinity ? Infinity
        : Math.max(0, breakEvenSlippageBps - basePerSide);
      gates.minBreakEvenExtraBps = {
        gate: "minBreakEvenExtraBps", value: extra ?? NaN, threshold: a.minBreakEvenExtraBpsPerSide,
        pass: extra !== undefined && extra >= a.minBreakEvenExtraBpsPerSide,
        ...(extra === undefined ? { reason: "break-even curve not computed" } : {}),
      };
    }
    gates.maxCorrVsLive = {
      gate: "maxCorrVsLive", value: corrVsLive?.corr ?? NaN, threshold: a.maxCorrVsLive,
      pass: corrVsLive !== undefined && Math.abs(corrVsLive.corr) <= a.maxCorrVsLive,
      ...(corrVsLive === undefined ? { reason: corrError ?? "correlation not computed" } : {}),
    };
    gates.maxDrawdown = { gate: "maxDrawdown", value: stitched.maxDrawdown, threshold: a.maxDrawdown, pass: stitched.maxDrawdown <= a.maxDrawdown };
    gates.maxYearPnlShare = {
      gate: "maxYearPnlShare", value: years.maxShare, threshold: a.maxYearPnlShare,
      pass: Number.isFinite(years.maxShare) && years.maxShare <= a.maxYearPnlShare,
      ...(Number.isFinite(years.maxShare) ? {} : { reason: "total OOS P&L <= 0 (fail closed)" }),
    };
    gates.exTopDecileMinSharpe = {
      gate: "exTopDecileMinSharpe", value: exTopDecile?.sharpe ?? NaN, threshold: a.exTopDecileMinSharpe,
      pass: exTopDecile !== undefined && exTopDecile.sharpe >= a.exTopDecileMinSharpe,
      ...(exTopDecile === undefined ? { reason: "exclusion re-run not computed" } : {}),
    };

    const complete = ledgerComplete(allTrials);
    const allPass = Object.values(gates).every(g => g.pass);
    let approved = false;
    let approvalReason: string;
    if (skippedFolds.length > 0) approvalReason = `validation-only/skipped outer folds exist: ${skippedFolds.join(", ")}`;
    else if (!complete) approvalReason = "current trial ledger incomplete";
    else if (!m.trialAccounting.complete) approvalReason = allPass
      ? "all gates pass; awaiting explicit human approval (not auto-deployed)"
      : `gate(s) failed: ${Object.values(gates).filter(g => !g.pass).map(g => g.gate).join(", ")}`;
    else approvalReason = "unreachable";
    if (!allPass && !approvalReason.startsWith("gate(s) failed") && skippedFolds.length === 0 && complete) {
      approvalReason = `gate(s) failed: ${Object.values(gates).filter(g => !g.pass).map(g => g.gate).join(", ")}`;
    }

    const summary = {
      manifestHash,
      configHash,
      dataHash,
      codeHash,
      asOfMs,
      resolvedTo: new Date(asOfMs).toISOString(),
      selectedCandidate: outerSelection.length > 0
        ? { hash: outerSelection[outerSelection.length - 1].candidateHash, name: outerSelection[outerSelection.length - 1].candidateName, reason: "last executed outer fold's inner winner" }
        : null,
      outerSelection,
      innerSelection: innerMetrics,
      outerTests: outerReplay.map(r => ({ foldPath: r.window.label, result: r })),
      stressTests: stressResults.map(r => ({ foldPath: (r as StReversalResult).window.label, result: asReplay(r as StReversalResult) })),
      stitchedOos: { ...stitched, benchReturn, benchSharpe },
      benchByFold,
      benchError,
      concentration: conc,
      loo: [] as never[],
      outerPsr: evidence.outerPsr,
      minTrl: evidence.minTrl,
      observations: evidence.observations,
      foldPsr: evidence.foldPsr,
      breakEvenCurve,
      breakEvenSlippageBps,
      sequenceRisk,
      certifiableSharpeAtPsr95: evidence.certifiableSharpeAtPsr95,
      skippedFolds,
      acceptance: gates,
      approved,
      approvalReason,
      complete,
      priorTrialsComplete: m.trialAccounting.complete,
      // §12-specific evidence (additive fields)
      ordersPerDay,
      corrVsLive: corrVsLive ?? null,
      corrVsLiveError: corrError,
      yearPnl: years,
      exTopDecile: exTopDecile ?? null,
      maxGrossSeen: Math.max(0, ...outerTestResults.map(r => r.maxGrossSeen)),
    } as unknown as WalkForwardSummary & Record<string, unknown>;

    if (!opts.dryRun) {
      writeOutputs(outputDir, { ...(m as unknown as object), trialLedger: allTrials } as never, allTrials, summary);
    }
    return { summary, outputDir, trials: allTrials };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args.find(x => x.endsWith(".json")) ?? "";
  if (!manifestPath || !existsSync(manifestPath)) {
    console.error("Usage: bun scripts/stocks-reversal-wf.ts experiments/<manifest>.json [--dry-run] [--no-breakeven]");
    process.exit(1);
  }
  const m = validateStManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const dryRun = args.includes("--dry-run");
  console.log(`▌ ST-reversal walk-forward: ${m.name}`);
  console.log(`   candidates: ${m.candidates.map(c => c.name).join(", ")}`);
  console.log(`   folds: ${m.window.outerFoldCount} outer × ${m.window.innerFoldCount} inner | asOf ${m.asOf}`);
  if (dryRun) console.log("   DRY RUN — no trials executed");
  const t0 = Date.now();
  const { summary, outputDir } = await runStWalkForward(m, { dryRun, breakEven: !args.includes("--no-breakeven") });
  console.log(`\n▌ SUMMARY (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  const s = summary.stitchedOos;
  console.log(`   outerSelection: ${(summary.outerSelection ?? []).map(o => `${o.foldPath}=${o.candidateName}`).join(", ")}`);
  console.log(`   stitched OOS: ret=${(s.totalReturn * 100).toFixed(1)}% sharpe=${s.sharpe.toFixed(2)} DD=${(s.maxDrawdown * 100).toFixed(1)}% trades=${s.trades} | bench ${m.data.refSymbol} ret=${((s.benchReturn ?? 0) * 100).toFixed(1)}%`);
  console.log(`   evidence: outerPSR=${summary.outerPsr?.toFixed(3) ?? "n/a"} obs=${summary.observations} foldPSR=[${(summary.foldPsr ?? []).map(f => f.psr.toFixed(2)).join(", ")}]`);
  if (summary.breakEvenCurve) {
    console.log(`   break-even: ${summary.breakEvenSlippageBps === Infinity ? ">30" : summary.breakEvenSlippageBps?.toFixed(1)} bps/side | curve ${summary.breakEvenCurve.map(p => `${p.slippageBps}→${p.sharpe.toFixed(2)}`).join(", ")}`);
  }
  const extra = summary as Record<string, any>;
  console.log(`   orders/day: session=${extra.ordersPerDay?.perSession?.toFixed(2)} calendar=${extra.ordersPerDay?.perCalendarDay?.toFixed(2)} (total ${extra.ordersPerDay?.totalOrders})`);
  console.log(`   corrVsLive: ${extra.corrVsLive ? extra.corrVsLive.corr.toFixed(3) + ` (n=${extra.corrVsLive.observations})` : "n/a: " + extra.corrVsLiveError}`);
  console.log(`   yearPnl maxShare: ${Number.isFinite(extra.yearPnl?.maxShare) ? (extra.yearPnl.maxShare * 100).toFixed(1) + "%" : "n/a"} | exTopDecile sharpe: ${extra.exTopDecile ? extra.exTopDecile.sharpe.toFixed(2) : "n/a"}`);
  for (const g of Object.values(summary.acceptance)) {
    console.log(`   gate ${g.pass ? "PASS" : "FAIL"} ${g.gate}: value=${Number.isFinite(g.value) ? g.value.toFixed(4) : g.value} threshold=${g.threshold}${g.reason ? ` (${g.reason})` : ""}`);
  }
  console.log(`   approved: ${summary.approved} — ${summary.approvalReason}`);
  if (!dryRun) console.log(`   written: ${outputDir}/`);
}

if (import.meta.main) await main();
