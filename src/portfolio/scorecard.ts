// ══════════════════════════════════════════════
// Scorecard — "¿cómo va el modelo vs lo que el backtest validado predice?"
//
// Pure functions + READ-ONLY DB readers (every query here is a SELECT; the
// module never writes — tests open the DB readonly and run the whole thing).
// Two consumers own the write side elsewhere: the Telegram ops-episode state
// lives in sync_state via telegram-reporter (bandEpisodeTransitions below is
// the pure part), and nothing else persists.
//
// WHAT IT ANSWERS (per live sleeve and per broker account):
//  • Time-weighted return / CAGR / vol / Sharpe / Sortino / maxDD over four
//    windows: since the CURRENT model's start (MODEL_START below), 30d, 90d,
//    and since v8 (2026-07-10).
//  • The same-dates benchmark return (SPY for Alpaca entities from
//    alpaca_wide/1d; BTC/USD for Binance entities from binance_futures/1d in
//    data/historical.db), alpha/beta by daily-return OLS, information ratio,
//    tracking error.
//  • Live PSR via src/portfolio/trackRecord.ts (Bailey & López de Prado) —
//    REUSED, not reimplemented.
//  • Capital utilization (mean open notional / equity, reconstructed from
//    trades) and realized vs unrealized P&L.
//  • EXPECTATION BAND: a block bootstrap (fixed seed) over the authoritative
//    pure-chain OOS daily returns of each sleeve's validated artifact gives
//    the 5/50/95 percentiles of cumulative return and maxDD at horizon
//    h = live sessions since MODEL_START. Live below p5 = the automatic
//    "rinde peor que lo validado" signal. The two stock sleeves' bands are
//    haircut for universe selection bias (SELECTION_BIAS_HAIRCUT below).
//
// The below-band signal is the measurable spirit of the PRE-REGISTERED
// reversion criteria written next to each wiring decision:
//  • momentum_stocks (src/index.ts, MOMENTUM_STOCKS_MAX_LONGS block +
//    MOMENTUM_STOCKS_DAILY_HORIZON doc): "back to 4 × 0.25 / {3,20,2,12} if
//    realized sleeve maxDD over the next 60 trading days exceeds 20%" and
//    "revert to null if, after 60 trading days live, realized sleeve maxDD
//    exceeds 20% or the sleeve trails the pure-chain replay of the same live
//    window by >10pp".
//  • momentum_crypto (src/index.ts, volTarget block): "revert if, over the
//    first 60 live days, realized sleeve DD exceeds the prior 60 days' DD,
//    or if the median volTargetScale sits at a clamp on >70% of ticks".
//  • meanrev_stocks (MeanRevEngine.ts, DEFAULT_MEANREV_CONFIG.maxPositions):
//    "back to 5 if realized sleeve DD over the next 60 trading days exceeds
//    15%, or live win rate < 55% over ≥ 40 closes".
// The band does NOT execute those reversals — it pages ops once per episode
// (see telegram-reporter) so a human evaluates the written criterion.
//
// HONESTY FLOOR (do not oversell): with a few weeks of live data NO metric
// here certifies edge — the PSR/MinTRL machinery says exactly how far we are
// (obsMissing). The band detects BREAKAGE vs the validated distribution; a
// sleeve inside its band has "not broken", which is not the same as "has
// alpha".
// ══════════════════════════════════════════════

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { getETDateKey } from "../db/database";
import { nextGridDay } from "./sleeveReturns";
import { computeTrackRecord, type TrackRecord } from "./trackRecord";

// ── Windows & entities ────────────────────────────────────────────────────

/** v8 go-live — the "desde v8" window anchor. */
export const V8_START = "2026-07-10";

/**
 * First SESSION attributable to the currently-wired model of each live
 * sleeve (the window's daily returns start with this session's close vs the
 * prior session's close — the base mark is the last session BEFORE it):
 *  • momentum_stocks  2026-09-28 — blend-63/126/252 daily kernel (artifact
 *    cc2f5d69…) wired 2026-09-25 after the close; first full session is
 *    Monday 2026-09-28.
 *  • meanrev_stocks   2026-09-28 — 7 slots × 0.12 (artifact 624d50e9…) wired
 *    2026-09-28 before the open; the band is that chain, so the window starts
 *    with it (7 × 0.10 ran 2026-09-25 only).
 *  • momentum_crypto  2026-09-27 — vt-35 volTarget, wired 2026-09-23. The
 *    23rd–26th are NOT the model's: the sleeve still held the previous
 *    model's positions (SOL/ADA, stopped on the 23rd) and its RiskState
 *    carried the previous model's peak, so a soft-DD pause blocked every
 *    vt-35 entry until the one-shot re-anchor of 2026-09-26 19:00 UTC — the
 *    same instant fixed that day as the parity epoch (scripts/parity-check.ts
 *    PARITY_EPOCHS). The 27th is the first full UTC day of the model's own
 *    book. Moved 2026-10-04 after the corrected replay showed it (AUDITS):
 *    from the epoch, live −4.6% vs the corrected sim −5.4%. Rule for the
 *    next cutover: MODEL_START is the first full session after inherited
 *    positions AND inherited risk state are gone.
 *  • momentum_crypto_usdc 2026-09-29 — daily kernel d13-s5-blend-63-126-252
 *    (artifact 752767ae…, the band below). First daily decision 2026-09-27,
 *    but its MODEL_CUTOVER only fires at 00:00:15 UTC 09-29 (the 09-27 pass
 *    skipped it — BinanceMomentumAdapter carried no entryTime, fixed
 *    f385ab5): 09-29 is the first UTC day on the daily model's own book.
 *    (Was 2026-07-20, the hourly model's launch — a daily-kernel band over
 *    70 days of hourly returns.)
 */
export const MODEL_START: Record<string, string> = {
  momentum_stocks: "2026-09-28",
  meanrev_stocks: "2026-09-28",
  momentum_crypto: "2026-09-27",
  momentum_crypto_usdc: "2026-09-29",
};

export type ScorecardGrid = "trading_days" | "calendar_days";

export interface ScorecardEntityDef {
  id: string;
  kind: "sleeve" | "account";
  label: string;
  /** ET trading days for Alpaca entities (equity frozen after the close),
   *  UTC calendar days for Binance entities (24/7; UTC midnight = the
   *  benchmark bar boundary of binance_futures 1d bars). */
  grid: ScorecardGrid;
  obsPerYear: 252 | 365;
  benchmark: { source: string; symbol: string };
  /** account_ids whose trades reconstruct utilization + realized P&L. */
  tradeAccounts: string[];
}

const SPY = { source: "alpaca_wide", symbol: "SPY" };
const BTC = { source: "binance_futures", symbol: "BTC/USD" };

export const SCORECARD_ENTITIES: ScorecardEntityDef[] = [
  { id: "momentum_stocks", kind: "sleeve", label: "Momentum Stocks", grid: "trading_days", obsPerYear: 252, benchmark: SPY, tradeAccounts: ["momentum_stocks"] },
  { id: "meanrev_stocks", kind: "sleeve", label: "Reversión Stocks", grid: "trading_days", obsPerYear: 252, benchmark: SPY, tradeAccounts: ["meanrev_stocks"] },
  { id: "momentum_crypto", kind: "sleeve", label: "Momentum Cripto", grid: "calendar_days", obsPerYear: 365, benchmark: BTC, tradeAccounts: ["momentum_crypto"] },
  { id: "momentum_crypto_usdc", kind: "sleeve", label: "Momentum Cripto USDC", grid: "calendar_days", obsPerYear: 365, benchmark: BTC, tradeAccounts: ["momentum_crypto_usdc"] },
  { id: "alpaca_main", kind: "account", label: "Cuenta Alpaca", grid: "trading_days", obsPerYear: 252, benchmark: SPY, tradeAccounts: ["momentum_stocks", "meanrev_stocks"] },
  { id: "binance_main", kind: "account", label: "Cuenta Binance (FAPI)", grid: "calendar_days", obsPerYear: 365, benchmark: BTC, tradeAccounts: ["momentum_crypto", "momentum_crypto_usdc"] },
];

export type ScorecardWindowId = "model" | "30d" | "90d" | "v8";
/** Sleeves get all four; accounts have no single "model" (two models share
 *  one wallet), so they carry 30d/90d/v8 only. */
export const SLEEVE_WINDOWS: ScorecardWindowId[] = ["model", "30d", "90d", "v8"];
export const ACCOUNT_WINDOWS: ScorecardWindowId[] = ["30d", "90d", "v8"];

// ── Authoritative expectation artifacts (pure OOS chains) ─────────────────

export interface ArtifactRef {
  /** Artifact directory (runs.jsonl + manifest-resolved.json inside). */
  dir: string;
  /** Daily-bar MOMENTUM replays label a session by its END (next midnight),
   *  one calendar day late — shiftDays −1 realigns to trading-date labels
   *  (same caveat as /tmp/opencode/uc/scripts/combine.ts). Only affects date
   *  labels, never the return values the bootstrap resamples. */
  shiftDays: number;
  manifest: string;
}

/**
 * Per-sleeve authoritative pure-chain artifact (ledger:
 * experiments/historical-hypothesis-ledger-v1.json). Overridable via env
 * (SCORECARD_ARTIFACT_<SLEEVE_ID_UPPERCASE>) — the meanrev artifact in
 * particular may be re-run and re-pointed without a code change.
 * momentum_crypto_usdc's artifact is AUTHORITATIVE but NOT gate-certified
 * (U1 2026-09-26 rounds 3-5: the daily kernel passes 15/17 gates — fails
 * maxDrawdown 52.4%>45 and excess vs BTC −24.4pp — and replaced the
 * refuted hourly control per the pre-registered wiring criterion; the
 * sleeve keeps trading per the owner rule) — the band is the honest
 * expectation, not a certification.
 */
export function sleeveExpectationArtifacts(): Record<string, ArtifactRef> {
  const env = (k: string) => process.env[`SCORECARD_ARTIFACT_${k}`];
  return {
    // The three momentum chains below were re-run 2026-10-03 on prod's
    // 2026-10-02 base with the corrected replay, which counts every close in
    // RiskGuard's realised-pnl window like live (AUDITS 2026-10-03). Each
    // supersedes the pre-fix chain named in its comment; the pre-fix re-run on
    // the same base is cited for comparison.
    momentum_stocks: {
      // 5f03d68d… supersedes cc2f5d69… (same base pre-fix f418e295…:
      // +352.6% / 1.19 → +351.3% / 1.19, no gate change).
      dir: env("MOMENTUM_STOCKS") ?? "data/backtests/5f03d68daed8572ebb73d5c283dfd80ec1064d5b47e8afb9c1f871d8537f091d",
      shiftDays: -1,
      manifest: "experiments/momentum-stocks-daily-blend3-pure-v1.json",
    },
    meanrev_stocks: {
      // 624d50e9… = 7 × 0.12 pure chain on the adjustment=all research DB
      // (wired 2026-09-28; supersedes 03382972…, 7 × 0.10 split-only).
      dir: env("MEANREV_STOCKS") ?? "data/backtests/624d50e930d47ef55e42f16e6537e0e895dec847fb0b709c26b2ecd94ea37db7",
      shiftDays: 0,
      manifest: "experiments/meanrev-slot12-pure-v1.json",
    },
    momentum_crypto: {
      // 06e1a160… supersedes a5101316… (vt-35 control pure chain). Same base
      // pre-fix d6c0cdbe…: +363.6% / 1.16 / DD 35.6% → +509.8% / 1.31 / DD
      // 32.6%, same failed gate (maxDisplacementShare). The pre-fix replay
      // paused entries after every 5 hard stops; live never did.
      dir: env("MOMENTUM_CRYPTO") ?? "data/backtests/06e1a160c3556102aa2fff769f9e4c2a3d27d09a6f3874841286426425faf6e4",
      shiftDays: 0,
      manifest: "experiments/momentum-crypto-2026w-control-pure-v1.json",
    },
    momentum_crypto_usdc: {
      // The daily kernel d13-s5-blend-63-126-252 (U1 rounds 3-5). Daily-bar
      // replay ⇒ session labeled by its END (next UTC midnight) ⇒ shiftDays
      // −1, same as momentum_stocks. 413ffb90… supersedes 752767ae… (same
      // base pre-fix 512439df…: +328.4% → +324.3%, same failed gates).
      dir: env("MOMENTUM_CRYPTO_USDC") ?? "data/backtests/413ffb90cd968bfdfe51f1b1eebc87612f262ce9ecb7d2ca82fd59383a704625",
      shiftDays: -1,
      manifest: "experiments/momentum-crypto-usdc-daily-s5-pure-v1.json",
    },
  };
}

// ── Date-key helpers (grid-aware) ─────────────────────────────────────────

function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Grid-consistent day key: ET date for trading grids, UTC date for 24/7. */
export function gridDateKey(ms: number, grid: ScorecardGrid): string {
  return grid === "trading_days" ? getETDateKey(ms) : utcDateKey(ms);
}

function keyToUtcMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isWeekendKey(key: string): boolean {
  const dow = new Date(keyToUtcMs(key)).getUTCDay();
  return dow === 0 || dow === 6;
}

// ── Readonly readers ──────────────────────────────────────────────────────

export interface DailyMark { dateKey: string; equity: number; snapshotTime: number }

/**
 * One end-of-day equity mark per grid day: LAST equity_snapshots row of the
 * day with semantics=5 (the current v8 attribution era) and synthetic=0.
 * The current (incomplete) day is excluded; weekends are dropped on the
 * trading grid (equity is structurally frozen — same rule as sleeveReturns).
 */
export function readDailyMarks(db: Database, profileId: string, grid: ScorecardGrid, now = Date.now()): DailyMark[] {
  const rows = db.prepare(
    `SELECT equity, snapshot_time FROM equity_snapshots
     WHERE profile_id = ? AND semantics = 5 AND synthetic = 0 AND equity > 0
     ORDER BY snapshot_time ASC, id ASC`
  ).all(profileId) as { equity: number; snapshot_time: number }[];
  const todayKey = gridDateKey(now, grid);
  const marks = new Map<string, DailyMark>();
  for (const r of rows) {
    const dateKey = gridDateKey(r.snapshot_time, grid);
    if (dateKey >= todayKey) continue; // no close yet (>= also guards clock skew)
    if (grid === "trading_days" && isWeekendKey(dateKey)) continue;
    marks.set(dateKey, { dateKey, equity: r.equity, snapshotTime: r.snapshot_time });
  }
  return [...marks.values()];
}

export interface TradeRow {
  entry_price: number | null; quantity: number | null;
  entry_time: number | null; exit_time: number | null;
  status: string; pnl: number | null;
}

export function readTrades(db: Database, accountIds: string[]): TradeRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT entry_price, quantity, entry_time, exit_time, status, pnl
     FROM trades WHERE account_id IN (${ph})`
  ).all(...accountIds) as TradeRow[];
}

/**
 * Benchmark daily returns keyed by grid day: close_t / close_{t−1} − 1 over
 * consecutive 1d bars. Bar day key = UTC date of the bar timestamp (alpaca
 * daily bars are stamped at ET midnight = 04/05h UTC of the SAME date;
 * binance 1d bars at UTC midnight open — both resolve to the session date).
 */
export function readBenchmarkReturns(hist: Database, source: string, symbol: string): Map<string, number> {
  const rows = hist.prepare(
    `SELECT timestamp, close FROM historical_bars
     WHERE source = ? AND symbol = ? AND timeframe = '1d' AND close > 0
     ORDER BY timestamp ASC`
  ).all(source, symbol) as { timestamp: number; close: number }[];
  const out = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    out.set(utcDateKey(rows[i].timestamp), rows[i].close / rows[i - 1].close - 1);
  }
  return out;
}

/** Fail-soft readonly open of data/historical.db (or an explicit path). */
export function openHistoricalReadonly(path = "./data/historical.db"): Database | null {
  try {
    if (!existsSync(path)) return null;
    return new Database(path, { readonly: true });
  } catch { return null; }
}

// ── Pure math ─────────────────────────────────────────────────────────────

export interface DailyReturnObs { dateKey: string; ret: number }

/** Adjacent-grid-day daily returns from marks (a multi-day delta is NOT a
 *  daily return — same discipline as sleeveReturns; gap days are dropped). */
export function marksToDailyReturns(marks: DailyMark[], grid: ScorecardGrid): DailyReturnObs[] {
  const tradingDays = grid === "trading_days";
  const out: DailyReturnObs[] = [];
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1], cur = marks[i];
    if (cur.dateKey !== nextGridDay(prev.dateKey, tradingDays)) continue;
    if (prev.equity <= 0) continue;
    out.push({ dateKey: cur.dateKey, ret: cur.equity / prev.equity - 1 });
  }
  return out;
}

export function maxDrawdown(equities: number[]): number | null {
  if (equities.length < 2) return null;
  let peak = equities[0], mdd = 0;
  for (const e of equities) {
    if (e > peak) peak = e;
    else if (peak > 0) mdd = Math.max(mdd, 1 - e / peak);
  }
  return mdd;
}

function mean(xs: number[]): number { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function sampleSd(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** OLS of sleeve daily returns on benchmark daily returns (paired dates). */
export function olsAlphaBeta(rs: number[], rb: number[]): { alphaDaily: number; beta: number } | null {
  const n = rs.length;
  if (n < 10 || n !== rb.length) return null;
  const ms = mean(rs), mb = mean(rb);
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) { cov += (rs[i] - ms) * (rb[i] - mb); varB += (rb[i] - mb) ** 2; }
  if (varB === 0) return null;
  const beta = cov / varB;
  return { alphaDaily: ms - beta * mb, beta };
}

/** Linear-interpolated percentile (q in [0,1]) of an unsorted sample. */
export function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Deterministic PRNG (mulberry32) — the bootstrap must reproduce exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapBand {
  cumReturn: { p5: number; p50: number; p95: number };
  maxDD: { p5: number; p50: number; p95: number };
  horizon: number; nPaths: number; blockLen: number; seed: number; nOosReturns: number;
}

/**
 * Moving-block bootstrap over the OOS daily-return sample: nPaths synthetic
 * h-session paths built from random ~blockLen-day blocks (preserves short-
 * range autocorrelation), fixed seed. Percentiles of cumulative return and
 * of within-path maxDD.
 */
export function blockBootstrapBand(
  oosReturns: number[], h: number,
  opts: { seed?: number; blockLen?: number; nPaths?: number } = {},
): BootstrapBand | null {
  const seed = opts.seed ?? 42;
  const blockLen = opts.blockLen ?? 10;
  const nPaths = opts.nPaths ?? 2000;
  const n = oosReturns.length;
  if (h < 1 || n < blockLen * 2) return null;
  const rand = mulberry32(seed);
  const cums: number[] = [], dds: number[] = [];
  for (let p = 0; p < nPaths; p++) {
    let eq = 1, peak = 1, dd = 0, filled = 0;
    while (filled < h) {
      const start = Math.floor(rand() * (n - blockLen + 1));
      for (let j = 0; j < blockLen && filled < h; j++, filled++) {
        eq *= 1 + oosReturns[start + j];
        if (eq > peak) peak = eq;
        else dd = Math.max(dd, 1 - eq / peak);
      }
    }
    cums.push(eq - 1); dds.push(dd);
  }
  return {
    cumReturn: { p5: percentile(cums, 0.05), p50: percentile(cums, 0.5), p95: percentile(cums, 0.95) },
    maxDD: { p5: percentile(dds, 0.05), p50: percentile(dds, 0.5), p95: percentile(dds, 0.95) },
    horizon: h, nPaths, blockLen, seed, nOosReturns: n,
  };
}

export type BandStatus = "below" | "within" | "above" | "insufficient_data" | "unavailable";

export function classifyBand(liveCumReturn: number, band: BootstrapBand): Exclude<BandStatus, "insufficient_data" | "unavailable"> {
  if (liveCumReturn < band.cumReturn.p5) return "below";
  if (liveCumReturn > band.cumReturn.p95) return "above";
  return "within";
}

// ── Artifact OOS loader (combine.ts contract) ─────────────────────────────

const artifactCache = new Map<string, number[] | null>();

/**
 * OOS daily returns of a pure-chain artifact: outer test folds only
 * (foldPath "N/test"), costTier "base", AND the replay whose config matches
 * the manifest's declared base costs (runs.jsonl also holds the break-even
 * curve replays under costTier "base" — combine.ts caveat). Missing/corrupt
 * artifact → null, NEVER a throw ("no disponible" is a valid state).
 */
export function loadOosDailyReturns(ref: ArtifactRef): number[] | null {
  const cacheKey = `${ref.dir}|${ref.shiftDays}`;
  if (artifactCache.has(cacheKey)) return artifactCache.get(cacheKey)!;
  let out: number[] | null = null;
  try {
    const base = JSON.parse(readFileSync(`${ref.dir}/manifest-resolved.json`, "utf8")).costs?.base;
    const lines = readFileSync(`${ref.dir}/runs.jsonl`, "utf8").trim().split("\n");
    const byDate = new Map<string, number>();
    for (const line of lines) {
      const l = JSON.parse(line);
      if (!/^\d+\/test$/.test(l.foldPath) || l.costTier !== "base") continue;
      if (l.result?.config?.slippageBps !== base?.slippageBps || l.result?.config?.commissionBps !== base?.commissionBps) continue;
      for (const d of (l.result?.dailyReturns ?? []) as { date: string; ret: number }[]) {
        const key = ref.shiftDays
          ? utcDateKey(Date.parse(d.date + "T12:00:00Z") + ref.shiftDays * 86_400_000)
          : d.date;
        byDate.set(key, (byDate.get(key) ?? 0) + d.ret);
      }
    }
    if (byDate.size > 0) out = [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([, r]) => r);
  } catch { out = null; }
  artifactCache.set(cacheKey, out);
  return out;
}

/** Tests / long-lived processes: drop the artifact memo. */
export function clearArtifactCache(): void { artifactCache.clear(); }

// ── Window metrics ────────────────────────────────────────────────────────

export interface BenchmarkWindow {
  symbol: string;
  /** Cumulative benchmark return over the SAME dates as the entity's valid
   *  daily observations (paired dates only). */
  totalReturnPct: number | null;
  nPaired: number;
}

export interface ScorecardWindowMetrics {
  window: ScorecardWindowId;
  fromDate: string | null;  // base mark (the close the window compounds FROM)
  toDate: string | null;
  nObs: number;             // valid daily return observations
  totalReturnPct: number | null;  // end equity / base equity − 1
  cagrPct: number | null;         // only when the span ≥ 60 calendar days
  volAnnPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number | null;
  benchmark: BenchmarkWindow;
  alphaAnnPct: number | null;     // OLS intercept × obsPerYear (arithmetic)
  beta: number | null;
  informationRatio: number | null;
  trackingErrorAnnPct: number | null;
  psr: number | null;
  trackRecordStatus: TrackRecord["status"];
  capitalUtilizationPct: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
}

function emptyWindow(window: ScorecardWindowId, benchSymbol: string): ScorecardWindowMetrics {
  return {
    window, fromDate: null, toDate: null, nObs: 0,
    totalReturnPct: null, cagrPct: null, volAnnPct: null, sharpe: null, sortino: null,
    maxDrawdownPct: null, benchmark: { symbol: benchSymbol, totalReturnPct: null, nPaired: 0 },
    alphaAnnPct: null, beta: null, informationRatio: null, trackingErrorAnnPct: null,
    psr: null, trackRecordStatus: "no_data",
    capitalUtilizationPct: null, realizedPnl: null, unrealizedPnl: null,
  };
}

export function windowStartKey(window: ScorecardWindowId, entity: ScorecardEntityDef, now: number): string | null {
  switch (window) {
    case "model": return MODEL_START[entity.id] ?? null;
    case "30d": return gridDateKey(now - 30 * 86_400_000, entity.grid);
    case "90d": return gridDateKey(now - 90 * 86_400_000, entity.grid);
    case "v8": return V8_START;
  }
}

/** Everything about one entity×window — pure given marks/trades/bench. */
export function computeWindowMetrics(
  entity: ScorecardEntityDef,
  window: ScorecardWindowId,
  allMarks: DailyMark[],
  trades: TradeRow[],
  benchReturns: Map<string, number> | null,
  now: number,
): ScorecardWindowMetrics {
  const out = emptyWindow(window, entity.benchmark.symbol);
  const startKey = windowStartKey(window, entity, now);
  if (startKey == null) return out;

  // Base mark = last close BEFORE the window; window marks = closes inside it.
  const baseIdx = (() => {
    let idx = -1;
    for (let i = 0; i < allMarks.length; i++) if (allMarks[i].dateKey < startKey) idx = i;
    return idx;
  })();
  const inWindow = allMarks.filter(m => m.dateKey >= startKey);
  if (inWindow.length === 0) return out;
  const base = baseIdx >= 0 ? allMarks[baseIdx] : inWindow[0];
  const seq = base === inWindow[0] ? inWindow : [base, ...inWindow];
  const last = seq[seq.length - 1];
  out.fromDate = base.dateKey;
  out.toDate = last.dateKey;
  if (seq.length < 2 || base.equity <= 0) return out;

  out.totalReturnPct = (last.equity / base.equity - 1) * 100;
  const spanDays = (keyToUtcMs(last.dateKey) - keyToUtcMs(base.dateKey)) / 86_400_000;
  if (spanDays >= 60) out.cagrPct = (Math.pow(last.equity / base.equity, 365 / spanDays) - 1) * 100;
  const mdd = maxDrawdown(seq.map(m => m.equity));
  out.maxDrawdownPct = mdd == null ? null : mdd * 100;

  const rets = marksToDailyReturns(seq, entity.grid);
  out.nObs = rets.length;
  if (rets.length >= 2) {
    const vals = rets.map(r => r.ret);
    const sd = sampleSd(vals);
    out.volAnnPct = sd * Math.sqrt(entity.obsPerYear) * 100;
    if (sd > 0) out.sharpe = (mean(vals) / sd) * Math.sqrt(entity.obsPerYear);
    const downside = Math.sqrt(vals.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / vals.length);
    if (downside > 0) out.sortino = (mean(vals) / downside) * Math.sqrt(entity.obsPerYear);
    const tr = computeTrackRecord(vals, { obsPerYear: entity.obsPerYear });
    out.psr = tr.psr;
    out.trackRecordStatus = tr.status;
  } else if (rets.length > 0) {
    out.trackRecordStatus = "insufficient_observations";
  }

  // Benchmark on the SAME dates as the valid daily observations.
  if (benchReturns) {
    const paired = rets.filter(r => benchReturns.has(r.dateKey));
    out.benchmark.nPaired = paired.length;
    if (paired.length > 0) {
      const rb = paired.map(r => benchReturns.get(r.dateKey)!);
      const rs = paired.map(r => r.ret);
      out.benchmark.totalReturnPct = (rb.reduce((e, r) => e * (1 + r), 1) - 1) * 100;
      const ols = olsAlphaBeta(rs, rb);
      if (ols) {
        out.beta = ols.beta;
        out.alphaAnnPct = ols.alphaDaily * entity.obsPerYear * 100;
      }
      if (paired.length >= 10) {
        const diffs = rs.map((r, i) => r - rb[i]);
        const te = sampleSd(diffs);
        out.trackingErrorAnnPct = te * Math.sqrt(entity.obsPerYear) * 100;
        if (te > 0) out.informationRatio = (mean(diffs) / te) * Math.sqrt(entity.obsPerYear);
      }
    }
  }

  // Capital utilization: mean(open notional at each window close / equity).
  const utils: number[] = [];
  for (const m of inWindow) {
    if (m.equity <= 0) continue;
    let notional = 0;
    for (const t of trades) {
      if (t.entry_time == null || t.entry_time > m.snapshotTime) continue;
      const open = t.status === "open" || t.exit_time == null || t.exit_time > m.snapshotTime;
      if (!open) continue;
      notional += Math.abs((t.entry_price ?? 0) * (t.quantity ?? 0));
    }
    utils.push(notional / m.equity);
  }
  if (utils.length > 0) out.capitalUtilizationPct = mean(utils) * 100;

  // Realized (closed inside the window) vs unrealized (equity move − realized).
  let realized = 0;
  for (const t of trades) {
    if (t.status !== "closed" || t.exit_time == null) continue;
    if (t.exit_time > base.snapshotTime && t.exit_time <= last.snapshotTime) realized += t.pnl ?? 0;
  }
  out.realizedPnl = realized;
  out.unrealizedPnl = (last.equity - base.equity) - realized;
  return out;
}

// ── Expectation band per sleeve ───────────────────────────────────────────

export interface SelectionBiasHaircut {
  /** Annualized Sharpe the hand-picked universe owes to hindsight: the live
   *  kernel's Sharpe on its universe minus the same kernel's Sharpe on a
   *  point-in-time S&P 500 universe, same data base. */
  sharpe: number;
  evidence: string;
}

/**
 * Both stock sleeves trade universes chosen knowing who won (momentum 11
 * names, meanrev 32). The point-in-time S&P 500 research of 2026-10-02
 * (ledger authoritativeArtifactSp500Pit) re-ran each live kernel on the
 * index as it was each day: return did not shrink, Sharpe did, by ~0.18 on
 * both sleeves. Forward, the hand-picked names have no reason to keep
 * beating a rule-based selection, while their volatility is a persistent
 * property of the names, so the band keeps the artifact's volatility and
 * lowers its MEAN by exactly this Sharpe (selectionBiasDrift). The crypto
 * universes were not measured and get no haircut.
 */
export const SELECTION_BIAS_HAIRCUT: Record<string, SelectionBiasHaircut> = {
  momentum_stocks: { sharpe: 0.185, evidence: "control b5354075 Sharpe 1.213 − top-20 PIT 06d81aee 1.028 (S&P 500 PIT, 2026-10-02)" },
  meanrev_stocks: { sharpe: 0.183, evidence: "control 48451ce8 Sharpe 0.705 − PIT members ec5d6788 0.522 (S&P 500 PIT, 2026-10-02)" },
};

/** Pure: the constant daily drift whose subtraction lowers the series'
 *  annualized Sharpe (mean/sd × √obsPerYear — the walk-forward's own
 *  convention, verified to reproduce every artifact's stitched Sharpe) by
 *  `sharpeHaircut`, volatility unchanged. */
export function selectionBiasDrift(returns: number[], sharpeHaircut: number, obsPerYear: number): number {
  const n = returns.length;
  if (n < 2 || !(sharpeHaircut > 0)) return 0;
  const mean = returns.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return (sharpeHaircut * sd) / Math.sqrt(obsPerYear);
}

export interface ExpectationBand {
  status: BandStatus;
  reason: string | null;
  artifactDir: string | null;
  manifest: string | null;
  modelStart: string | null;
  horizonSessions: number;
  liveCumReturnPct: number | null;
  liveMaxDrawdownPct: number | null;
  cumReturnPct: { p5: number; p50: number; p95: number } | null;
  maxDDPct: { p5: number; p50: number; p95: number } | null;
  bootstrap: { seed: number; blockLen: number; nPaths: number; nOosReturns: number } | null;
  /** The haircut the band was built with (null = none for this sleeve). */
  selectionBias: { sharpeHaircut: number; dailyDrift: number; evidence: string } | null;
}

export function computeExpectationBand(
  sleeveId: string,
  modelWindow: ScorecardWindowMetrics,
  artifacts: Record<string, ArtifactRef> = sleeveExpectationArtifacts(),
  opts: { seed?: number; blockLen?: number; nPaths?: number } = {},
  haircuts: Record<string, SelectionBiasHaircut> = SELECTION_BIAS_HAIRCUT,
): ExpectationBand {
  const ref = artifacts[sleeveId] ?? null;
  const base: ExpectationBand = {
    status: "unavailable", reason: null,
    artifactDir: ref?.dir ?? null, manifest: ref?.manifest ?? null,
    modelStart: MODEL_START[sleeveId] ?? null,
    horizonSessions: modelWindow.nObs,
    liveCumReturnPct: modelWindow.totalReturnPct,
    liveMaxDrawdownPct: modelWindow.maxDrawdownPct,
    cumReturnPct: null, maxDDPct: null, bootstrap: null, selectionBias: null,
  };
  if (!ref) return { ...base, reason: "sin artefacto autoritativo para este sleeve" };
  // h<5 is checked BEFORE touching disk: a 2-session band would be noise, and
  // the early return keeps empty-DB paths (tests, fresh installs) from
  // parsing a multi-MB runs.jsonl for nothing.
  if (modelWindow.nObs < 5 || modelWindow.totalReturnPct == null) {
    return { ...base, status: "insufficient_data", reason: `solo ${modelWindow.nObs} sesiones vivas (mínimo 5)` };
  }
  const oos = loadOosDailyReturns(ref);
  if (!oos) return { ...base, reason: `artefacto no disponible en ${ref.dir}` };
  const haircut = haircuts[sleeveId] ?? null;
  const obsPerYear = SCORECARD_ENTITIES.find(e => e.id === sleeveId)?.obsPerYear ?? 252;
  const drift = haircut ? selectionBiasDrift(oos, haircut.sharpe, obsPerYear) : 0;
  // A new array: the loader's memo must keep the artifact's own returns.
  const sample = drift > 0 ? oos.map(r => r - drift) : oos;
  const band = blockBootstrapBand(sample, modelWindow.nObs, opts);
  if (!band) return { ...base, reason: "muestra OOS insuficiente para bootstrap" };
  return {
    ...base,
    status: classifyBand(modelWindow.totalReturnPct / 100, band),
    cumReturnPct: { p5: band.cumReturn.p5 * 100, p50: band.cumReturn.p50 * 100, p95: band.cumReturn.p95 * 100 },
    maxDDPct: { p5: band.maxDD.p5 * 100, p50: band.maxDD.p50 * 100, p95: band.maxDD.p95 * 100 },
    bootstrap: { seed: band.seed, blockLen: band.blockLen, nPaths: band.nPaths, nOosReturns: band.nOosReturns },
    selectionBias: haircut ? { sharpeHaircut: haircut.sharpe, dailyDrift: drift, evidence: haircut.evidence } : null,
  };
}

// ── Full scorecard ────────────────────────────────────────────────────────

export interface EntityScorecard {
  id: string;
  kind: "sleeve" | "account";
  label: string;
  grid: ScorecardGrid;
  obsPerYear: 252 | 365;
  benchmarkSymbol: string;
  modelStart: string | null;
  windows: ScorecardWindowMetrics[];
  band: ExpectationBand | null;  // sleeves only
}

export interface Scorecard {
  generatedAt: number;
  entities: EntityScorecard[];
  benchmarksAvailable: boolean;
  notes: string[];
}

export interface ScorecardOptions {
  db: Database;
  /** historical.db handle; null/missing ⇒ benchmark columns render null. */
  hist?: Database | null;
  now?: number;
  artifacts?: Record<string, ArtifactRef>;
  bootstrap?: { seed?: number; blockLen?: number; nPaths?: number };
  /** Defaults to SELECTION_BIAS_HAIRCUT; {} = the unadjusted bands. */
  selectionBias?: Record<string, SelectionBiasHaircut>;
}

export function computeScorecard(opts: ScorecardOptions): Scorecard {
  const now = opts.now ?? Date.now();
  const hist = opts.hist ?? null;
  const artifacts = opts.artifacts ?? sleeveExpectationArtifacts();
  const benchCache = new Map<string, Map<string, number> | null>();
  const benchFor = (b: { source: string; symbol: string }): Map<string, number> | null => {
    const key = `${b.source}|${b.symbol}`;
    if (!benchCache.has(key)) {
      let m: Map<string, number> | null = null;
      if (hist) { try { m = readBenchmarkReturns(hist, b.source, b.symbol); } catch { m = null; } }
      benchCache.set(key, m);
    }
    return benchCache.get(key)!;
  };

  const entities: EntityScorecard[] = SCORECARD_ENTITIES.map(def => {
    const marks = readDailyMarks(opts.db, def.id, def.grid, now);
    const trades = readTrades(opts.db, def.tradeAccounts);
    const bench = benchFor(def.benchmark);
    const windowIds = def.kind === "sleeve" ? SLEEVE_WINDOWS : ACCOUNT_WINDOWS;
    const windows = windowIds.map(w => computeWindowMetrics(def, w, marks, trades, bench, now));
    const band = def.kind === "sleeve"
      ? computeExpectationBand(def.id, windows.find(w => w.window === "model")!, artifacts, opts.bootstrap, opts.selectionBias)
      : null;
    return {
      id: def.id, kind: def.kind, label: def.label, grid: def.grid, obsPerYear: def.obsPerYear,
      benchmarkSymbol: def.benchmark.symbol, modelStart: MODEL_START[def.id] ?? null,
      windows, band,
    };
  });

  return {
    generatedAt: now,
    entities,
    benchmarksAvailable: hist != null,
    notes: [
      "Con pocas semanas de vivo NINGUNA métrica certifica edge (ver PSR/MinTRL: obsMissing).",
      "La banda detecta roturas frente a la distribución OOS validada; estar dentro NO prueba alpha.",
      "Benchmark calculado sobre las MISMAS fechas que las observaciones diarias válidas del sleeve.",
      "Bandas de los sleeves de acciones ajustadas por el sesgo de selección de su universo (−0,18 de Sharpe, investigación S&P 500 PIT del 2026-10-02); las de cripto, sin medir, van sin ajuste.",
    ],
  };
}

// ── Band readings for the SleeveGovernor (pure) ───────────────────────────

/** What the governor needs from a sleeve's expectation band. */
export interface BandReading {
  status: BandStatus;
  liveCumReturnPct: number | null;
  p5Pct: number | null;
  horizonSessions: number;
  modelStart: string | null;
  reason: string | null;
}

/** The live scorecard's band readings: trading.db (the caller's handle) and
 *  historical.db, both read-only. Used by the SleeveGovernor (index.ts) and
 *  the Portfolios view (dashboard). */
export function liveBandReadings(db: Database): Record<string, BandReading> {
  const hist = openHistoricalReadonly();
  try {
    return expectationBandReadings(computeScorecard({ db, hist }));
  } finally {
    try { hist?.close(); } catch { /* best-effort */ }
  }
}

/** Pure: one BandReading per sleeve of an already-computed scorecard
 *  (accounts carry no band and are skipped). */
export function expectationBandReadings(sc: Scorecard): Record<string, BandReading> {
  const out: Record<string, BandReading> = {};
  for (const e of sc.entities) {
    if (e.kind !== "sleeve" || !e.band) continue;
    out[e.id] = {
      status: e.band.status,
      liveCumReturnPct: e.band.liveCumReturnPct,
      p5Pct: e.band.cumReturnPct?.p5 ?? null,
      horizonSessions: e.band.horizonSessions,
      modelStart: e.band.modelStart,
      reason: e.band.reason,
    };
  }
  return out;
}

// ── Band episodes (pure part — sync_state I/O lives in telegram-reporter) ──

export type BandEpisodeState = "below" | "ok";
export interface BandTransition { sleeve: string; kind: "entered_below" | "recovered" }

/**
 * Once-per-episode semantics: alert on ok→below and below→ok ONLY.
 * insufficient_data / unavailable never change state (no evaluation ≠ recovery).
 */
export function bandEpisodeTransitions(
  prev: Partial<Record<string, BandEpisodeState>>,
  current: Record<string, BandStatus>,
): { transitions: BandTransition[]; next: Record<string, BandEpisodeState> } {
  const next: Record<string, BandEpisodeState> = {};
  for (const [k, v] of Object.entries(prev)) if (v === "below" || v === "ok") next[k] = v;
  const transitions: BandTransition[] = [];
  for (const [sleeve, status] of Object.entries(current)) {
    if (status === "insufficient_data" || status === "unavailable") continue;
    const was = next[sleeve] ?? "ok";
    if (status === "below" && was !== "below") transitions.push({ sleeve, kind: "entered_below" });
    if (status !== "below" && was === "below") transitions.push({ sleeve, kind: "recovered" });
    next[sleeve] = status === "below" ? "below" : "ok";
  }
  return { transitions, next };
}

// ── Telegram digest formatting (pure) ─────────────────────────────────────

const DIGEST_TAG: Record<string, string> = {
  momentum_stocks: "MOM-STO",
  meanrev_stocks: "REV-STO",
  momentum_crypto: "MOM-CRY",
  momentum_crypto_usdc: "MOM-USDC",
};

const BAND_ES: Record<BandStatus, string> = {
  below: "POR DEBAJO", within: "dentro", above: "por encima",
  insufficient_data: "datos insuficientes", unavailable: "no disponible",
};

function pctEs(x: number | null, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const s = `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(digits)}`.replace(".", ",");
  return `${s}%`;
}

/**
 * One digest line per sleeve, model-start window (the same the band judges):
 * "MOM-STO +1,2% vs SPY +0,8% (α +0,4%) · banda: dentro". α here is the
 * simple excess return live − benchmark on the same dates (a digest figure,
 * not the OLS alpha — that one lives in the dashboard/CLI).
 */
export function formatScorecardDigestLines(scorecard: Scorecard): string[] {
  const lines: string[] = [];
  for (const e of scorecard.entities) {
    if (e.kind !== "sleeve") continue;
    const w = e.windows.find(x => x.window === "model");
    const tag = DIGEST_TAG[e.id] ?? e.id;
    const bandTxt = e.band ? BAND_ES[e.band.status] : "no disponible";
    if (!w || w.totalReturnPct == null) {
      lines.push(`${tag} sin sesiones aún (modelo desde ${e.modelStart ?? "?"}) · banda: ${bandTxt}`);
      continue;
    }
    const excess = w.benchmark.totalReturnPct != null ? w.totalReturnPct - w.benchmark.totalReturnPct : null;
    lines.push(
      `${tag} ${pctEs(w.totalReturnPct)} vs ${e.benchmarkSymbol.replace("/USD", "")} ${pctEs(w.benchmark.totalReturnPct)}` +
      `${excess != null ? ` (α ${pctEs(excess)})` : ""} · banda: ${bandTxt}`
    );
  }
  return lines;
}
