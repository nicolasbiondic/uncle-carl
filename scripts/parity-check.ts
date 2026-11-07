#!/usr/bin/env bun
/**
 * parity-check — live↔sim DECISION monitor (W4 parity 2026-09-25; crypto
 * added 2026-09-26 after momentum_crypto ran ~2 weeks live on a DIFFERENT
 * model than the validated replay with nobody noticing, because this
 * monitor only covered the two daily stock sleeves).
 *
 * READ-ONLY. For the two crypto sleeves it replays the LIVE config
 * (src/config/liveSleeveConfigs.ts — the derivation locked against both
 * index.ts and the authoritative manifests) with the REAL simulator
 * (scripts/backtest-momentum-wf.ts runWithConfig) over data/historical.db,
 * from each sleeve's PARITY EPOCH to the last bar for which EVERY universe
 * symbol has a completed bar, and compares the ENTRY decisions, the EXIT
 * decisions and the holdings against the trades table of data/trading.db
 * (opened readonly). For the two stock sleeves it replays the portfolio
 * engine's exact decisions (below) — since 2026-11-07 that is the ONLY
 * engine they can run on (the TSM/Connors incumbents and their daily replay
 * path here were deleted with them; owner, audit C).
 *
 * Two sleeve shapes, one comparison contract:
 *   - momentum_stocks / meanrev_stocks: the portfolio-engine decision replay
 *     (checkPortfolioSleeve), one live decision per NYSE session.
 *   - momentum_crypto: HOURLY bars (binance_futures/1h), 24/7, decision
 *     stamps compared at MATCH_TOLERANCE_HOURS_CRYPTO-hour granularity
 *     (the live tick fires at bar-close + 15s, but the FIRST tick after a
 *     restart/re-anchor is out of phase with the bar boundary — the sim
 *     always decides at the exact close) PLUS a holdings check at the
 *     close of every UTC calendar day inside the window, not just at the
 *     window's end (24/7 books can round-trip a position entirely within
 *     the comparison window). A live exit whose close_reason is the native
 *     BROKER_STOP_LOSS is matched against the sim's own H/L-triggered stop
 *     by SYMBOL within the same ±2h window — never by price (the sim's
 *     entry-anchored stop and the broker's live trigger price can legally
 *     differ). See checkMomentumCryptoSleeve.
 *   - Turtle BREAKOUT_* seeds retain their role, entry age and row stop.
 *     A differing Turtle stop exit is explained (not paged) ONLY when the
 *     first reference-data CLOSE crossing the LIVE row stop agrees with the
 *     live decision bar (hourly ±2h, daily same UTC day). Its matched sim
 *     unit's exit is aligned only for comparison; output keeps both times.
 *     BREAKOUT_CATASTROPHE_STOP is a declared live-only native backstop:
 *     explain the matched unit's exit without requiring a reference CLOSE.
 *
 * Decisions, not P&L: fill prices/quantities are expected to differ; the
 * SYMBOLS and their approximate TIMES are not. Positions already open at
 * the epoch seed the sim's inventory: their inherited entries are ignored,
 * but their exits and holdings remain comparable (except MODEL_CUTOVER).
 *
 * Portfolio-engine stock sleeves: EXACT DECISION REPLAY, never a simulated
 * book. Rebuild HistoricalPriceView, the persisted pre-order positions/equity
 * and the preceding SAME-version memory (including observer decisions) using
 * live's loader. Run decide() on that version's manifest strategy. Compare
 * weights, regime, maxHold close intents and kernel diagnostics. Changed
 * input diagnostics → DATA REVISED (symbols reported); page only if the
 * regime/target set flips. Same inputs but changed outputs → DIVERGENCE.
 * Diagnostics are evidence, not a full bar snapshot: revisions outside their
 * coverage cannot be proven retrospectively. Execution drift is report-only.
 * Check one live decision per NYSE session through the last completed session,
 * previous-session as_of, and target-bar coverage. Default epoch = current
 * ModelVersion.since; --since replays older versions using THEIR manifests.
 *
 * Epochs (PARITY_EPOCHS — the monitor's sleeve list IS this map's keys):
 *   momentum_stocks / meanrev_stocks — keys only (the stock sleeves are
 *     always dispatched to the portfolio replay, whose epoch is the current
 *     ModelVersion.since or --since); the dates are the retired incumbent
 *     replay's last epochs, kept for --epoch investigations of that era.
 *   momentum_crypto 2026-10-23T09:00:00Z — RW3's cutover (correlation brake
 *     OFF, MOMENTUM_CRYPTO_MODEL_VERSION vt35-corroff-2026-10-23): the first
 *     pass of the new model, on a flat book with the RiskState re-anchored
 *     (peak = equity, streak 0) — as clean as the replay's, which starts
 *     empty and fresh at the epoch. This value is a PROJECTION of the deploy
 *     hour; the director sets the exact one after deploying (see below).
 *     (Before: 2026-09-26T19:00:00Z, the vt-35 re-anchor.)
 *   momentum_crypto_usdc 2026-10-24T00:00:00Z — first DAILY pass of the RW4a
 *     model (drawdown exposure control, PROJECTED deploy; the director sets
 *     the exact pass, see PARITY_EPOCHS); live BASE/USDC symbols map to the
 *     replay's BASE/USD proxies (normalizeLiveDecisions). (Before:
 *     2026-10-08 the UNI realign; 2026-09-27 the d13-s5 cutover.)
 *
 * Date tolerance: sim decision stamps can sit off the live pass (the daily
 * sim labels a decision by the bar's END — a weekend gap lands the stamp
 * on Saturday for Monday's live pass; sim hard stops book at the NEXT bar
 * boundary). Events match when the same symbol's dates differ by ≤
 * MATCH_TOLERANCE_DAYS calendar days (daily sleeves) or ≤
 * MATCH_TOLERANCE_HOURS_CRYPTO hours (momentum_crypto).
 *
 * Known modeling limits (divergences these CAN cause are still reported —
 * they are parity information, not noise to suppress):
 *   - RiskGuard starts FRESH at the epoch; live carries drawdown/streak
 *     state from before it (momentum_crypto's epoch is chosen so this is
 *     also true of live, per the re-anchor above).
 *   - Seeded TSM trail watermarks can only be reconstructed from history
 *     loaded by the replay; a seed predating that history lacks its older
 *     watermark (see seedTrailMark).
 *
 * Usage:
 *   bun run scripts/parity-check.ts [--db data/trading.db]
 *       [--hist data/historical.db] [--notify] [--sleeve <id>] [--since <ISO date>]
 *
 * Exit code: 0 = parity (or nothing to compare yet); 1 = divergences.
 * --notify sends ONE message to the OPS chat (TELEGRAM_BOT_TOKEN +
 * TELEGRAM_OPS_CHAT_ID, the watchdog.sh audience — NEVER the user chat)
 * and only when there is a divergence.
 *
 * Cron: scripts/install-cron.sh installs `45 4 * * 2-6` UTC (Tue–Sat,
 * after the 04:00 historical refresh and the 04:30 backup) via
 * scripts/parity-check.sh. momentum_crypto is 24/7 but a once-daily pass is
 * enough to catch a drift class that ran undetected for two weeks.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { getETDateKey, getETDayBounds } from "../src/db/database";
import { liveSleeveConfig, type LiveSleeveId } from "../src/config/liveSleeveConfigs";
import { runWithConfig, type ClosedTrade, type ReplayResult, type SeedPosition } from "./backtest-momentum-wf";
import { MODEL_CUTOVER_CLOSE_REASON } from "../src/strategies/momentum/MomentumEngine";
import { candidateToReplayConfig, type CandidateConfig, type ExperimentManifest } from "./walk-forward";
import { MODEL_VERSIONS, currentModelVersion } from "../src/portfolio/modelVersions";
import { decide } from "../src/portfolio-engine/decide";
import { latestPortfolioMemory, type PersistedOrder } from "../src/portfolio-engine/live/persistence";
import { portfolioDecisionSymbols } from "../src/portfolio-engine/live/PortfolioEngine";
import { HistoricalPriceView, DEFAULT_MAX_BARS } from "../src/portfolio-engine/live/priceView";
import { contingencyHistoryBars, overlaySymbols } from "../src/portfolio-engine/contingency";
import { getPreviousTradingDay, getSessionClose, isTradingDay } from "../src/utils/marketHours";
import type { PortfolioStrategyConfig, Position } from "../src/portfolio-engine/types";
import { IndexMembershipView } from "./lib/portfolioData";

// ── epochs ────────────────────────────────────────────────────────────────
// The monitor's sleeve list IS this map's keys (see main()) — adding a
// sleeve here is the only wiring needed to check it (plus a dispatch arm in
// main() if it needs a non-daily comparison shape, like momentum_crypto's).
export const PARITY_EPOCHS: Partial<Record<LiveSleeveId, string>> = {
  // Re-anchored to line E's resize pass (10-12, k = 1.5): its MODEL_CUTOVER
  // closes the whole k = 1 book, which the extractors exclude, so the sim
  // starts empty at the epoch exactly like the live book after the cutover,
  // and both buy at 0.1875/slot. Before: 10-07, the owner's GOOGL realign
  // (09-28..10-06 compared clean apart from GOOGL, AUDITS 2026-10-06).
  momentum_stocks: "2026-10-12",
  meanrev_stocks: "2026-09-29",
  // RW10: compare only passes under the System 1 short candidate, never replay the
  // new entry policy over pre-deploy decisions. This moves the parity window,
  // NOT the persisted live RiskState key (neither crypto sleeve re-anchors).
  momentum_crypto: "2026-11-03T03:00:00Z",
  // Owner-approved bo13 boundary for DAILY USDC: first eligible tick is 11-06
  // 00:00:15Z. The replay still starts fresh risk while live keeps its peak,
  // drawdown and exposure fractions — the known state difference remains.
  // Live trades are BASE/USDC; the replay runs the BASE/USD USDT-perp proxies
  // (declared in its manifest) — normalizeLiveDecisions.
  momentum_crypto_usdc: "2026-11-05T12:00:00Z",
};

/** Live symbols → the replay's universe symbols. momentum_crypto_usdc
 *  trades BASE/USDC perps while its validated replay runs the BASE/USD
 *  (USDT-perp) proxies; every other sleeve compares symbols verbatim. */
export function normalizeLiveDecisions(sleeve: LiveSleeveId, d: SleeveDecisions): SleeveDecisions {
  if (sleeve !== "momentum_crypto_usdc") return d;
  const n = (sym: string) => sym.replace(/\/USDC$/, "/USD");
  return {
    entries: d.entries.map(e => ({ ...e, symbol: n(e.symbol) })),
    exits: d.exits.map(e => ({ ...e, symbol: n(e.symbol) })),
    endHoldings: [...new Set(d.endHoldings.map(n))].sort(),
  };
}

/** Same BASE/USDC → BASE/USD mapping as normalizeLiveDecisions, applied to
 *  seed positions (extractSeedPositions) instead of decision events — the
 *  replay's universe/book only ever knows the BASE/USD proxy symbols. */
export function normalizeSeedPositions(sleeve: LiveSleeveId, seeds: SeedPosition[]): SeedPosition[] {
  if (sleeve !== "momentum_crypto_usdc") return seeds;
  return seeds.map(s => ({ ...s, symbol: s.symbol.replace(/\/USDC$/, "/USD") }));
}

/**
 * Live positions already open at the replay EPOCH (OPEN.md P2 "el libro
 * del sim arranca vacío en el epoch") — the seed for the sim's book (see
 * SeedPosition). A row counts iff it was opened strictly BEFORE the epoch
 * and was still open AT the epoch: status 'open', or an exit at/after it
 * (a close exactly at the epoch instant belongs to the live pass the
 * epoch marks, so the position existed through it — same boundary
 * extractLiveDecisions uses for entries: `entry_time < epochMs`, mirrored
 * here with the open side of the inequality flipped for exits).
 *
 * EXCLUDED: a row closed with MODEL_CUTOVER_CLOSE_REASON. That close is the
 * engine's own one-shot re-underwrite (src/index.ts's reunderwriteBefore,
 * verified live on momentum_stocks' AAPL/META and momentum_crypto_usdc's
 * NEAR/UNI 2026-09-28/29) — it closes the OLD row and reopens a FRESH one
 * (smaller notional, current sizing regime) in the SAME pass; the fresh
 * row's own entry_time is >= epochMs and is already a normal in-window
 * live entry. Seeding the OLD row instead would hand the sim a stale,
 * abandoned-regime notional the replay has no mechanism to re-underwrite
 * (reunderwriteBefore is deliberately NOT plumbed into
 * ReplayConfig/CandidateConfig — it is a live-only migration event, not a
 * strategy parameter) — verified live 2026-10-05: seeding momentum_stocks'
 * pre-cutover AAPL+META (≈$49.2k, ~0.98× the sleeve's $50k equity, sized
 * under the RETIRED 2× regime) alone saturated maxGrossExposureMult's 1.0×
 * cap and blocked EVERY entry for the rest of the window — worse than the
 * false divergence this fix targets, not better.
 */
export function extractSeedPositions(db: Database, accountId: string, epochMs: number): SeedPosition[] {
  const rows = db.prepare(
    `SELECT symbol, side, entry_time, entry_price, quantity, stop_loss, strategy FROM trades
     WHERE account_id = ? AND entry_time < ? AND (status = 'open' OR exit_time >= ?)
       AND (close_reason IS NULL OR close_reason != ?)
     ORDER BY entry_time ASC`,
  ).all(accountId, epochMs, epochMs, MODEL_CUTOVER_CLOSE_REASON) as Array<{
    symbol: string; side: string; entry_time: number; entry_price: number; quantity: number; stop_loss: number | null; strategy: string | null;
  }>;
  return rows.map(r => ({
    symbol: r.symbol,
    side: r.side === "sell" ? "sell" as const : "buy" as const,
    qty: r.quantity,
    entryPrice: r.entry_price,
    entryAt: r.entry_time,
    stopPrice: r.stop_loss,
    ...(r.strategy === "BREAKOUT_SHORT" ? { role: "breakout-short" as const } : r.strategy === "BREAKOUT_LONG" ? { role: "breakout-long" as const } : {}),
  }));
}

/** Calendar-day slack when matching a sim decision to a live one. 3 covers
 *  the weekend-gap stamp (Sat vs Mon) and the sim's next-bar stop booking. */
export const MATCH_TOLERANCE_DAYS = 3;

/** Hour slack for momentum_crypto's 24/7 hourly decisions: the live tick
 *  fires at bar-close + 15s, but the first tick after a restart/re-anchor
 *  is out of phase with the bar boundary while the sim always decides at
 *  the exact close — and a native BROKER_STOP_LOSS close can land anywhere
 *  in the 15s-loop's polling window relative to the sim's H/L-triggered
 *  stop on the same bar. 2h comfortably covers both without hiding a
 *  same-day-but-wrong-symbol divergence. */
export const MATCH_TOLERANCE_HOURS_CRYPTO = 2;

/** Live lag behind the sim at a UTC day close: the sim books a decision AT
 *  the bar boundary, live ticks at boundary + 15s and fills seconds later.
 *  Sampling both books at the same instant flagged every midnight decision
 *  (momentum_crypto_usdc decides only at 00:00 UTC; NEAR 2026-10-29: sim
 *  00:00:00, live fill 00:00:20.5). Far below the next hourly pass. */
export const LIVE_PASS_SLACK_MS = 5 * 60_000;

// ── decision extraction ──────────────────────────────────────────────────
export interface DecisionEvent { symbol: string; date: string }

export interface SleeveDecisions {
  entries: DecisionEvent[];
  exits: DecisionEvent[];
  /** Symbols still held at the end of the comparison window. */
  endHoldings: string[];
}

/** Formats a decision timestamp for both display and match-tolerance math
 *  (Date.parse recovers it). Daily sleeves key by ET trading day; momentum_crypto
 *  passes a full-precision ISO instant so the ±2h tolerance is meaningful. */
export type DateKeyFn = (ms: number) => string;

/** Live decisions from the trades table. A row's ENTRY counts only when it
 *  falls inside [epochMs, endMs) — a genuine in-window decision. A row
 *  opened BEFORE the epoch (entry_time < epochMs) contributes no entry
 *  event (nothing decided it during this window — see extractSeedPositions,
 *  the same carried-in row), but DOES still contribute its exit/holding
 *  when that row is "live at the epoch" (status 'open', or exit_time at/
 *  after epochMs) — OPEN.md P2: before this, a carried-in position's exit
 *  or continued holding was invisible to the comparison entirely, which
 *  (symmetrically with the sim's own pre-seeding blind book) hid real
 *  divergences instead of just avoiding false "fresh entry" ones.
 *
 *  A carried-in row closed with MODEL_CUTOVER_CLOSE_REASON is excluded
 *  from this widening (its own FRESH reopen row, entry_time >= epochMs,
 *  is still a normal in-window entry) — same reasoning and verified live
 *  incident as extractSeedPositions' identical exclusion: a one-shot
 *  migration close is not a comparable decision on either side. */
export function extractLiveDecisions(
  db: Database,
  accountId: string,
  epochMs: number,
  endMs: number,
  dateKeyFn: DateKeyFn = getETDateKey,
): SleeveDecisions {
  const rows = db.prepare(
    `SELECT symbol, entry_time, exit_time, status FROM trades
     WHERE account_id = ? AND entry_time < ?
       AND (
         entry_time >= ?
         OR ((status = 'open' OR exit_time >= ?) AND (close_reason IS NULL OR close_reason != ?))
       )
     ORDER BY entry_time ASC`,
  ).all(accountId, endMs, epochMs, epochMs, MODEL_CUTOVER_CLOSE_REASON) as Array<{ symbol: string; entry_time: number; exit_time: number | null; status: string }>;
  const entries: DecisionEvent[] = [];
  const exits: DecisionEvent[] = [];
  const endHoldings: string[] = [];
  for (const r of rows) {
    if (r.entry_time >= epochMs) entries.push({ symbol: r.symbol, date: dateKeyFn(r.entry_time) });
    if (r.exit_time !== null && r.exit_time < endMs && r.status !== "open") {
      exits.push({ symbol: r.symbol, date: dateKeyFn(r.exit_time) });
    } else {
      endHoldings.push(r.symbol);
    }
  }
  return { entries, exits, endHoldings: [...new Set(endHoldings)].sort() };
}

/** Exact identity of a seeded position (symbol+side+entryAt, verbatim —
 *  never a timestamp-threshold guess, see extractSimDecisions): both
 *  SimBroker.seedPositions and SimMeanRevBroker.seedPositions carry
 *  `entryAt`/`entryTime` through to the eventual ClosedTrade unchanged. */
function seedIdentity(symbol: string, side: string, entryAt: number): string {
  return `${symbol}|${side}|${entryAt}`;
}

/** Sim decisions from a replay's closedTrades. "fold_end" closes are the
 *  positions still open at window end — holdings, not exits. A closedTrade
 *  whose (symbol, side, entryAt) matches one of `seeds` verbatim contributes
 *  NO entry event — it was INHERITED at the epoch (see SeedPosition /
 *  checkSleeve's seeding), not decided during this window, so it has no
 *  live counterpart to compare against (extractLiveDecisions excludes the
 *  same row's entry for the same reason) — OPEN.md P2. Its exit/holding
 *  IS still compared normally: the seed only silences the one event type
 *  that was never a real decision. A plain timestamp cutoff (entryAt <
 *  epoch) would also catch momentum_stocks' legitimate epoch-day entry,
 *  whose replay-internal entryAt can land one bar before the ET epoch
 *  boundary — exact identity avoids that false exclusion.
 */
export function extractSimDecisions(
  closedTrades: ClosedTrade[],
  endMs: number,
  dateKeyFn: DateKeyFn = getETDateKey,
  seeds: SeedPosition[] = [],
): SleeveDecisions {
  const seedKeys = new Set(seeds.map(s => seedIdentity(s.symbol, s.side, s.entryAt)));
  const entries: DecisionEvent[] = [];
  const exits: DecisionEvent[] = [];
  const endHoldings: string[] = [];
  for (const t of closedTrades) {
    if (t.entryAt === undefined) {
      throw new Error(`parity-check: sim trade for ${t.symbol} carries no entryAt — replay too old for this monitor`);
    }
    if (!seedKeys.has(seedIdentity(t.symbol, t.side, t.entryAt))) {
      entries.push({ symbol: t.symbol, date: dateKeyFn(t.entryAt) });
    }
    if (t.reason === "fold_end") endHoldings.push(t.symbol);
    else if (t.exitAt < endMs) exits.push({ symbol: t.symbol, date: dateKeyFn(t.exitAt) });
    else endHoldings.push(t.symbol);
  }
  return { entries, exits, endHoldings: [...new Set(endHoldings)].sort() };
}

/** Full-precision ISO instant — the crypto sleeve's DateKeyFn (hour-granular
 *  tolerance needs the exact instant, not a calendar-day bucket). */
export const isoInstant: DateKeyFn = (ms: number) => new Date(ms).toISOString();

// ── comparison ────────────────────────────────────────────────────────────
export type DivergenceType =
  | "entry_missing_live"   // sim entered, live never did
  | "entry_extra_live"     // live entered, sim never did
  | "exit_missing_live"    // sim exited, live still holds / never exited
  | "exit_extra_live"      // live exited, sim did not
  | "holdings_missing_live"
  | "holdings_extra_live"
  // momentum_crypto only: the portfolio at the close of a UTC calendar day
  // inside the window, not just at the window's end (see compareDailyHoldings).
  | "eod_holdings_missing_live"
  | "eod_holdings_extra_live"
  | "portfolio_decision"
  | "portfolio_session"
  | "portfolio_data_flip";

export interface Divergence {
  type: DivergenceType;
  symbol: string;
  simDate?: string;
  liveDate?: string;
}

function matchEvents(
  sim: DecisionEvent[],
  live: DecisionEvent[],
  missingType: DivergenceType,
  extraType: DivergenceType,
  toleranceDays: number,
): Divergence[] {
  const tolMs = toleranceDays * 86_400_000;
  const liveUsed = new Array(live.length).fill(false);
  const out: Divergence[] = [];
  for (const s of sim) {
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < live.length; i++) {
      if (liveUsed[i] || live[i].symbol !== s.symbol) continue;
      const diff = Math.abs(Date.parse(live[i].date) - Date.parse(s.date));
      if (diff <= tolMs && diff < bestDiff) { best = i; bestDiff = diff; }
    }
    if (best >= 0) liveUsed[best] = true;
    else out.push({ type: missingType, symbol: s.symbol, simDate: s.date });
  }
  for (let i = 0; i < live.length; i++) {
    if (!liveUsed[i]) out.push({ type: extraType, symbol: live[i].symbol, liveDate: live[i].date });
  }
  return out;
}

export function compareDecisions(
  sim: SleeveDecisions,
  live: SleeveDecisions,
  toleranceDays: number = MATCH_TOLERANCE_DAYS,
): Divergence[] {
  const out: Divergence[] = [
    ...matchEvents(sim.entries, live.entries, "entry_missing_live", "entry_extra_live", toleranceDays),
    ...matchEvents(sim.exits, live.exits, "exit_missing_live", "exit_extra_live", toleranceDays),
  ];
  const liveSet = new Set(live.endHoldings);
  const simSet = new Set(sim.endHoldings);
  for (const s of sim.endHoldings) if (!liveSet.has(s)) out.push({ type: "holdings_missing_live", symbol: s });
  for (const s of live.endHoldings) if (!simSet.has(s)) out.push({ type: "holdings_extra_live", symbol: s });
  return out;
}

// ── daily portfolio check (momentum_crypto: 24/7, round-trips fit inside a
// window that never has an "end of session") ───────────────────────────────

/** UTC midnight boundaries strictly inside (fromMs, toMs] — the "close of
 *  each UTC day" checkpoints. Empty when the window doesn't span one. */
export function utcDayCloses(fromMs: number, toMs: number): number[] {
  const DAY_MS = 86_400_000;
  const out: number[] = [];
  for (let t = (Math.floor(fromMs / DAY_MS) + 1) * DAY_MS; t <= toMs; t += DAY_MS) out.push(t);
  return out;
}

/** Symbols held at `atMs`, reconstructed from entry/exit event streams whose
 *  `date` field is a DateKeyFn-formatted, Date.parse-able instant (see
 *  isoInstant). Counts entries minus exits per symbol up to `atMs` — correct
 *  for the no-overlapping-position-per-symbol invariant every engine here
 *  enforces (never opens a symbol it already holds). */
export function heldSymbolsAt(entries: DecisionEvent[], exits: DecisionEvent[], atMs: number): Set<string> {
  const net = new Map<string, number>();
  for (const e of entries) if (Date.parse(e.date) <= atMs) net.set(e.symbol, (net.get(e.symbol) ?? 0) + 1);
  for (const e of exits) if (Date.parse(e.date) <= atMs) net.set(e.symbol, (net.get(e.symbol) ?? 0) - 1);
  return new Set([...net].filter(([, n]) => n > 0).map(([s]) => s));
}

/** Portfolio parity at the close of every UTC day inside [fromMs, toMs] —
 *  catches a same-day open+close round trip that entry/exit matching alone
 *  can miss (right symbol, right side, but the live book briefly held a
 *  DIFFERENT combination than the sim at some point inside the window).
 *  Both books are read `liveSlackMs` after the close (LIVE_PASS_SLACK_MS):
 *  replay engine exits are stamped boundary + 1ms, live fills seconds later. */
export function compareDailyHoldings(
  sim: SleeveDecisions,
  live: SleeveDecisions,
  fromMs: number,
  toMs: number,
  liveSlackMs: number = LIVE_PASS_SLACK_MS,
): Divergence[] {
  const out: Divergence[] = [];
  for (const closeMs of utcDayCloses(fromMs, toMs)) {
    const dayKey = new Date(closeMs).toISOString().slice(0, 10);
    const simHeld = heldSymbolsAt(sim.entries, sim.exits, closeMs + liveSlackMs);
    const liveHeld = heldSymbolsAt(live.entries, live.exits, closeMs + liveSlackMs);
    for (const s of simHeld) if (!liveHeld.has(s)) out.push({ type: "eod_holdings_missing_live", symbol: s, simDate: dayKey });
    for (const s of liveHeld) if (!simHeld.has(s)) out.push({ type: "eod_holdings_extra_live", symbol: s, liveDate: dayKey });
  }
  return out;
}

// ── portfolio-engine exact decision replay ────────────────────────────────
/** Calibrated on prod 2026-11-06 (see AUDITS): only roundoff, not a trading band.
 * Compare |a-b| / max(1, |a|, |b|), also recording the RAW maximum per row. */
export const PORTFOLIO_FLOAT_TOLERANCE = 8 * Number.EPSILON;

export interface PortfolioParityDecision {
  session: string;
  version: string;
  classification: "PARITY" | "DATA REVISED" | "DIVERGENCE";
  changedSymbols: string[];
  differences: string[];
  maxNumericDelta: number;
  /** Filled quantities marked at the original reference prices/equity, NOT later market prices. */
  executionDrift: Array<{ symbol: string; side: string; status: string; filled: number; requested: number; offTargetWeight: number }>;
}

interface PortfolioParityRow {
  id: number; strategy_version: string; session: string; as_of: string; status: string;
  equity: number; book_json: string; memory_json: string; weights_json: string;
  diagnostics_json: string; orders_json: string;
}

/** JSON structural comparison, key-order independent; arrays retain their order. */
function portfolioDiff(a: any, b: any, path = "", out: string[] = [], delta = { max: 0 }): { paths: string[]; max: number } {
  if (typeof a === "number" && typeof b === "number") {
    const diff = Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
    delta.max = Math.max(delta.max, diff);
    if (!Number.isFinite(diff) || diff > PORTFOLIO_FLOAT_TOLERANCE) out.push(path);
  } else if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) portfolioDiff(a[k], b[k], path ? `${path}.${k}` : k, out, delta);
  } else if (a !== b) out.push(path);
  return { paths: out, max: delta.max };
}

/** Calendar, not historical-data tail: missing bars must not freeze the monitor. */
export function lastCompletedStockSession(nowMs: number): string {
  const today = getETDateKey(nowMs);
  const [start] = getETDayBounds(today);
  return isTradingDay(today) && nowMs >= start + getSessionClose(today).closeMinutes * 60_000
    ? today : getPreviousTradingDay(today);
}

function portfolioExecutionDrift(book: Position[], weights: Record<string, number>, orders: PersistedOrder[],
  prices: Record<string, number>, equity: number): PortfolioParityDecision["executionDrift"] {
  const qty = new Map(book.map(p => [p.symbol, p.qty]));
  for (const o of orders) {
    // Unknown/transport outcomes are not confirmed fills. Only applied journal legs affect the rows.
    if (o.applied && (o.result?.filledQty ?? 0) > 0) qty.set(o.intent.symbol,
      (qty.get(o.intent.symbol) ?? 0) + (o.intent.side === "buy" ? 1 : -1) * o.result!.filledQty);
  }
  return orders.filter(o => o.skipped || !o.result?.ok || o.result.filledQty < o.intent.qty * (1 - 1e-6)).map(o => ({
    symbol: o.intent.symbol, side: o.intent.side, status: o.skipped ?? o.result?.status ?? "unfilled",
    filled: o.result?.filledQty ?? 0, requested: o.intent.qty,
    offTargetWeight: (qty.get(o.intent.symbol) ?? 0) * (prices[o.intent.symbol] ?? 0) / equity - (weights[o.intent.symbol] ?? 0),
  }));
}

export function checkPortfolioSleeve(sleeve: LiveSleeveId, tradingDbPath: string, histPath: string, rootDir: string,
  since?: string, nowMs = Date.now()): SleeveParityResult {
  const epoch = since ?? currentModelVersion(sleeve)?.since;
  if (!epoch || !Number.isFinite(Date.parse(epoch))) throw new Error(`portfolio parity: invalid epoch ${epoch}`);
  const from = getETDateKey(Date.parse(epoch.length === 10 ? `${epoch}T12:00:00Z` : epoch));
  const completed = lastCompletedStockSession(nowMs), today = getETDateKey(nowMs);
  const db = new Database(tradingDbPath, { readonly: true });
  const hist = new Database(histPath, { readonly: true });
  try {
    // Include today's already-taken decision even before its close; require coverage only through completed.
    const rows = db.query(`SELECT * FROM portfolio_decisions WHERE account_id = ? AND mode = 'live'
      AND session >= ? AND session <= ? ORDER BY session, id`).all(sleeve, from, today) as PortfolioParityRow[];
    const divergences: Divergence[] = [], portfolio: PortfolioParityDecision[] = [];
    const add = (type: DivergenceType, session: string, detail: string) => divergences.push({ type, symbol: detail, liveDate: session });
    const actual = rows.filter(r => ["decided", "submitted"].includes(r.status));
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${completed}T00:00:00Z`); t += 86_400_000) {
      const session = new Date(t).toISOString().slice(0, 10);
      if (!isTradingDay(session)) continue;
      const n = actual.filter(r => r.session === session).length;
      if (n !== 1) add("portfolio_session", session, `${n === 0 ? "missing" : "duplicate"} live decision (${n})`);
    }
    // A duplicate already written today need not wait for the session close to page.
    if (today > completed && actual.filter(r => r.session === today).length > 1) add("portfolio_session", today, "duplicate live decision");
    for (const r of actual) {
      const version = MODEL_VERSIONS[sleeve]?.find(v => v.id === r.strategy_version);
      if (!version?.manifest || version.engine !== "portfolio") throw new Error(`unknown portfolio version ${r.strategy_version}`);
      const manifest = JSON.parse(readFileSync(join(rootDir, version.manifest), "utf8"));
      const candidate = manifest.candidates.find((c: any) => c.name === version.candidate);
      const config: PortfolioStrategyConfig | undefined = candidate?.portfolio?.strategy;
      if (!config) throw new Error(`missing portfolio candidate ${version.candidate} of ${version.manifest}`);
      const book: Position[] = JSON.parse(r.book_json), weights: Record<string, number> = JSON.parse(r.weights_json);
      const stored: Record<string, any> = JSON.parse(r.diagnostics_json), orders: PersistedOrder[] = JSON.parse(r.orders_json);
      const memory = latestPortfolioMemory(sleeve, r.strategy_version, { db, beforeSession: r.session });
      const membership = config.kind === "volManaged" && config.pitUniverse
        ? IndexMembershipView.load(hist, manifest.data.membership?.index ?? "sp500", manifest.data.membership?.exclude ?? []) : undefined;
      const symbols = portfolioDecisionSymbols(config, membership, r.as_of, memory, r.session);
      const view = new HistoricalPriceView({ db: hist, asOf: r.as_of,
        symbols: [...new Set([...symbols.all, ...symbols.required, ...book.map(p => p.symbol), ...Object.keys(weights)])],
        maxBars: config.kind === "volManaged" && (config.regimeOverlay || config.pitUniverse)
          ? Math.max(DEFAULT_MAX_BARS, contingencyHistoryBars(config)) : DEFAULT_MAX_BARS });
      if (!(r.equity > 0) || !Number.isFinite(r.equity)) throw new Error(`invalid equity at ${sleeve} ${r.session}`);
      const invariants: string[] = [];
      if (!isTradingDay(r.session)) invariants.push("non-NYSE session");
      if (r.as_of !== getPreviousTradingDay(r.session)) invariants.push(`as_of ${r.as_of} != previous session`);
      for (const symbol of Object.keys(weights)) if (view.lastSession(symbol) !== r.as_of) invariants.push(`missing target bar ${symbol}@${r.as_of}`);
      // Invalid dates / missing target bars can make the kernel throw; these known
      // invariant failures are divergences, not an opaque operational replay error.
      if (invariants.length) {
        add("portfolio_decision", r.session, invariants.join(", "));
        portfolio.push({ session: r.session, version: r.strategy_version, classification: "DIVERGENCE", changedSymbols: [],
          differences: invariants, maxNumericDelta: 0, executionDrift: [] });
        continue;
      }
      const target = decide({ view, membership, book: { equity: r.equity, positions: book, memory }, config, executionSession: r.session });
      // Live enriches diagnostics with venue-only fields; those are not kernel outputs.
      const { freshness: _freshness, prices, drift: _drift, rules: _rules, ...kernelDiagnostics } = stored;
      const diagnosticsDiff = portfolioDiff(target.diagnostics, kernelDiagnostics);
      const weightsDiff = portfolioDiff(target.weights, weights);
      // maxHold itself was not journaled separately: its close intents preserve the selected set.
      // A terminal remainder retry repeats the same symbol, not a second selection.
      const liveMaxHold = [...new Set(orders.filter(o => o.intent.maxHold === "close").map(o => o.intent.symbol))].sort();
      const maxHoldDiff = portfolioDiff([...(target.maxHold ?? [])].sort(), liveMaxHold).paths;
      const inputs = new Set(["vols", "covariance", "slowVol", "fastVol", "overlayCovariance", "signals", "pitUniverse"]);
      const inputPaths = diagnosticsDiff.paths.filter(p => inputs.has(p.split(".")[0]));
      const changed = new Set<string>();
      // A revised series moves its entire covariance row/column, NOT every
      // counterparty's input series. Prefer own vol/variance evidence first.
      for (const p of inputPaths) {
        const parts = p.split(".");
        if (parts[0] === "vols" || parts[0] === "signals" ||
          (["covariance", "overlayCovariance"].includes(parts[0]) && parts[1] === parts[2])) changed.add(parts[1]);
      }
      for (const p of inputPaths) {
        const parts = p.split(".");
        if (["covariance", "overlayCovariance"].includes(parts[0]) && parts.length === 3 &&
          !changed.has(parts[1]) && !changed.has(parts[2])) { changed.add(parts[1]); changed.add(parts[2]); }
      }
      // Regime references may be outside the core covariance (e.g. SPY in a future sleeve).
      const regimeDiff = portfolioDiff(target.diagnostics.regimeOverlay, stored.regimeOverlay).paths;
      if (regimeDiff.length && config.kind === "volManaged" && config.regimeOverlay)
        for (const s of overlaySymbols(config.regimeOverlay)) changed.add(s);
      const revised = inputPaths.length > 0;
      const targetSetFlipped = portfolioDiff(Object.keys(target.weights).sort(), Object.keys(weights).sort()).paths.length > 0;
      const regimeFlipped = (target.diagnostics.regimeOverlay as any)?.riskOff !== stored.regimeOverlay?.riskOff;
      const differences = [...invariants, ...weightsDiff.paths.map(p => `weights.${p}`), ...diagnosticsDiff.paths.map(p => `diagnostics.${p}`),
        ...maxHoldDiff.map(p => `maxHold.${p}`)];
      const logicDiverged = !revised && differences.length > 0;
      const page = invariants.length > 0 || maxHoldDiff.length > 0 || logicDiverged || (revised && (targetSetFlipped || regimeFlipped));
      if (page) add(revised && !invariants.length && !maxHoldDiff.length ? "portfolio_data_flip" : "portfolio_decision", r.session,
        `${r.strategy_version}: ${differences.slice(0, 8).join(", ")}${differences.length > 8 ? ` (+${differences.length - 8})` : ""}`);
      portfolio.push({ session: r.session, version: r.strategy_version,
        classification: revised ? "DATA REVISED" : logicDiverged || invariants.length || maxHoldDiff.length ? "DIVERGENCE" : "PARITY",
        changedSymbols: [...changed].sort(), differences, maxNumericDelta: Math.max(diagnosticsDiff.max, weightsDiff.max),
        executionDrift: portfolioExecutionDrift(book, weights, orders, prices ?? {}, r.equity) });
    }
    return { sleeve, status: "compared", epoch, lastSession: completed, staleSymbols: [], divergences, portfolio };
  } finally { db.close(); hist.close(); }
}

// ── replay drivers ────────────────────────────────────────────────────────
export interface SleeveParityResult {
  sleeve: LiveSleeveId;
  status: "compared" | "nothing_yet" | "error";
  epoch: string;
  /** status "error": why this sleeve's check threw (the others still run). */
  error?: string;
  portfolio?: PortfolioParityDecision[];
  /** Divergences matched by PARITY_ACKNOWLEDGED — shown, never counted. */
  acknowledged?: Divergence[];
  /** Reference-close evidence explains this unit's different stop timing. */
  explained?: ExplainedBreakoutStop[];
  lastSession?: string;
  /** Universe symbols whose newest daily bar lags the universe's newest by
   *  more than STALE_SYMBOL_DAYS — they clamp (or freeze) the comparison
   *  window, so the monitor screams instead of silently reporting
   *  "nothing to compare yet" forever. Found live on 2026-09-25: HON's
   *  alpaca_wide/1d series frozen at 2026-08-06 in the dev historical.db. */
  staleSymbols: Array<{ symbol: string; lastBar: string }>;
  sim?: SleeveDecisions;
  live?: SleeveDecisions;
  divergences: Divergence[];
}

/** A symbol lagging the freshest universe symbol by more than this many
 *  calendar days is reported as STALE (frozen backfill, delisting, rename). */
export const STALE_SYMBOL_DAYS = 7;

export interface ExplainedBreakoutStop {
  liveOnly?: boolean;
  symbol: string;
  entryDate: string;
  simDate: string;
  liveDate: string;
  referenceDate: string;
  stopPrice: number;
}

/** Compare crypto decisions without treating a testnet-fill-anchored Turtle
 * stop as a strategy divergence. Evidence is per UNIT, never a symbol-wide
 * waiver. No reference crossing, wrong decision bar, unmatched entry or
 * non-stop counterpart means the original divergence survives unchanged. */
export function compareCryptoReplay(
  tradingDb: Database,
  hist: Database,
  sleeve: "momentum_crypto" | "momentum_crypto_usdc",
  data: Pick<ExperimentManifest["data"], "source" | "timeframe" | "barMinutes">,
  closedTrades: ClosedTrade[],
  seeds: SeedPosition[],
  epochMs: number,
  endMs: number,
): { sim: SleeveDecisions; live: SleeveDecisions; divergences: Divergence[]; explained: ExplainedBreakoutStop[] } {
  const sim = extractSimDecisions(closedTrades, endMs, isoInstant, seeds);
  const live = normalizeLiveDecisions(sleeve, extractLiveDecisions(tradingDb, sleeve, epochMs, endMs, isoInstant));
  const barMs = data.barMinutes * 60_000, daily = data.barMinutes === 1440;
  const sameDecision = (a: number, b: number) => daily
    ? Math.floor(a / 86_400_000) === Math.floor(b / 86_400_000)
    : Math.abs(a - b) <= MATCH_TOLERANCE_HOURS_CRYPTO * 3_600_000;
  const rows = tradingDb.prepare(
    `SELECT symbol, side, entry_time, entry_price, exit_time, stop_loss, strategy, close_reason FROM trades
     WHERE account_id = ? AND status != 'open' AND entry_time < ? AND exit_time >= ? AND exit_time < ?
       AND ((strategy IN ('BREAKOUT_SHORT', 'BREAKOUT_LONG') AND close_reason = 'BREAKOUT_CATASTROPHE_STOP')
         OR (strategy = 'BREAKOUT_SHORT' AND close_reason = 'BREAKOUT_SHORT_STOP')
         OR (strategy = 'BREAKOUT_LONG' AND close_reason = 'BREAKOUT_LONG_STOP'))
     ORDER BY entry_time ASC`,
  ).all(sleeve, endMs, epochMs, endMs) as Array<{
    symbol: string; side: string; entry_time: number; entry_price: number; exit_time: number; stop_loss: number | null; strategy: string; close_reason: string;
  }>;
  const adjustedTrades = [...closedTrades], used = new Set<number>(), explained: ExplainedBreakoutStop[] = [];
  for (const r of rows) {
    const long = r.strategy === "BREAKOUT_LONG";
    const catastrophe = r.close_reason === "BREAKOUT_CATASTROPHE_STOP";
    if (!r.stop_loss || !Number.isFinite(r.stop_loss) || !(r.entry_price > 0)
      || r.side !== (long ? "buy" : "sell") || (long ? r.stop_loss >= r.entry_price : r.stop_loss <= r.entry_price)) continue;
    const symbol = sleeve === "momentum_crypto_usdc" ? r.symbol.replace(/\/USDC$/, "/USD") : r.symbol;
    // Match the opening decision (or exact seed identity), not whichever exit
    // happens to be nearest: repeated units of the same coin stay distinct.
    let best = -1, bestDiff = Infinity;
    for (let i = 0; i < closedTrades.length; i++) {
      const t = closedTrades[i];
      if (used.has(i) || t.symbol !== symbol || t.side !== r.side || t.entryAt === undefined
        || (!catastrophe && (t.reason === "fold_end" || t.exitAt >= endMs || t.engineCloseReason !== `${r.strategy}_STOP`))) continue;
      const matchesEntry = r.entry_time < epochMs ? t.entryAt === r.entry_time
        : t.entryAt >= epochMs && sameDecision(t.entryAt, r.entry_time);
      const diff = Math.abs(t.entryAt - r.entry_time);
      if (matchesEntry && diff < bestDiff) { best = i; bestDiff = diff; }
    }
    if (best < 0) continue;
    used.add(best);
    const t = closedTrades[best];
    if (catastrophe) {
      // Declared live-only native backstop; no reference close crossing is
      // expected. Waive ONLY this matched unit, never other entries/exits.
      explained.push({ symbol, entryDate: isoInstant(r.entry_time), simDate: isoInstant(t.exitAt), liveDate: isoInstant(r.exit_time), referenceDate: isoInstant(r.exit_time), stopPrice: r.stop_loss, liveOnly: true });
      adjustedTrades[best] = { ...t, exitAt: r.exit_time, reason: "stop" };
      continue;
    }
    // An ordinary matched stop (especially a seed carrying the SAME row stop)
    // needs no explanation and remains under the normal comparison contract.
    if (Math.abs(t.exitAt - r.exit_time) <= MATCH_TOLERANCE_HOURS_CRYPTO * 3_600_000) continue;
    const crossing = hist.prepare(
      `SELECT timestamp + ? AS decision FROM historical_bars
       WHERE source = ? AND timeframe = ? AND symbol = ?
         AND timestamp >= ? AND timestamp + ? >= ? AND timestamp + ? < ?
         AND close ${long ? "<=" : ">="} ? ORDER BY timestamp ASC LIMIT 1`,
    ).get(barMs, data.source, data.timeframe, symbol, r.entry_time - barMs, barMs, r.entry_time, barMs, endMs, r.stop_loss) as { decision: number } | null;
    if (!crossing || !sameDecision(crossing.decision, Math.floor(r.exit_time / barMs) * barMs)) continue;
    explained.push({ symbol, entryDate: isoInstant(r.entry_time), simDate: isoInstant(t.exitAt), liveDate: isoInstant(r.exit_time), referenceDate: isoInstant(crossing.decision), stopPrice: r.stop_loss });
    adjustedTrades[best] = { ...t, exitAt: r.exit_time };
  }
  const comparableSim = extractSimDecisions(adjustedTrades, endMs, isoInstant, seeds);
  // Inherited entries are not decisions, but they DO establish the initial
  // inventory for EOD checks. Add them symmetrically only for that check.
  const inherited = seeds.map(s => ({ symbol: s.symbol, date: isoInstant(s.entryAt) }));
  return {
    sim, live, explained,
    divergences: [
      ...compareDecisions(comparableSim, live, MATCH_TOLERANCE_HOURS_CRYPTO / 24),
      ...compareDailyHoldings({ ...comparableSim, entries: [...inherited, ...comparableSim.entries] }, { ...live, entries: [...inherited, ...live.entries] }, epochMs, endMs),
    ],
  };
}

/** momentum_crypto — 24/7 hourly binance_futures replay. Unlike the stock
 *  sleeves (ET sessions), the epoch IS the exact instant (no day-bounds
 *  snapping) and the comparison window is bounded by the last bar TIMESTAMP
 *  common to every universe symbol (the tick loop's own decision instant,
 *  not a padded session end — crypto bar-density validation is strict, see
 *  backtest-momentum-wf.ts's validateBarDensity). */
export async function checkMomentumCryptoSleeve(
  tradingDbPath: string,
  histPath: string,
  rootDir: string,
  epochOverride?: string,
  sleeve: "momentum_crypto" | "momentum_crypto_usdc" = "momentum_crypto",
): Promise<SleeveParityResult> {
  const epoch = epochOverride ?? PARITY_EPOCHS[sleeve];
  if (!epoch) throw new Error(`checkMomentumCryptoSleeve: no PARITY_EPOCHS entry and no --epoch override given`);
  const epochMs = Date.parse(epoch);
  const liveCfg = liveSleeveConfig(sleeve);
  const manifest: ExperimentManifest = JSON.parse(readFileSync(join(rootDir, liveCfg.manifestPath), "utf-8"));

  const hist = new Database(histPath, { readonly: true });
  let last: { key: string; ts: number; stale: Array<{ symbol: string; lastBar: string }> } | null;
  try {
    last = lastCompleteSession(hist, manifest);
  } finally {
    hist.close();
  }
  const barMs = manifest.data.barMinutes * 60_000;
  // last.ts is the OPEN timestamp of the freshest bar common to every
  // universe symbol — also the last instant the sim can DECIDE (the tick
  // loop needs a next bar to execute against, which is exactly this one for
  // the tick one bar earlier; see runWithConfig's `canDecide`). Anything at
  // or before the epoch means no decision could have happened yet.
  if (!last || last.ts <= epochMs) {
    return { sleeve, status: "nothing_yet", epoch, lastSession: last ? new Date(last.ts).toISOString() : undefined, staleSymbols: last?.stale ?? [], divergences: [] };
  }
  let endMs = last.ts + barMs;
  // Funding tail — the same clamp latestCommonAsOf applies to the
  // walk-forward's asOf: settlements land every 8h (00/08/16 UTC), so at the
  // 09:45 UTC cron the newest settled funding is 08:00 while the newest
  // hourly bar closes at 09:00, and validateFundingCoverage fails closed on
  // that tail (2026-09-29: the whole monitor aborted on it). Compare up to
  // the newest settlement common to the universe; the rest of the day is
  // compared on the next run.
  if (manifest.data.funding) {
    const fdb = new Database(histPath, { readonly: true });
    try {
      endMs = clampToFundingTail(endMs, fundingTailMs(fdb, manifest.data.universe), barMs);
    } finally {
      fdb.close();
    }
    if (endMs <= epochMs) {
      return { sleeve, status: "nothing_yet", epoch, lastSession: new Date(endMs).toISOString(), staleSymbols: last.stale, divergences: [] };
    }
  }

  const win = {
    label: `parity:${sleeve}`,
    from: new Date(epochMs).toISOString(),
    to: new Date(endMs).toISOString(),
  };

  const cfg = candidateToReplayConfig(manifest, liveCfg.candidate as CandidateConfig, "base", histPath);

  // Seed the sim's book with live positions already open AT THE EPOCH
  // (OPEN.md P2) — normalized to the replay's BASE/USD proxy symbols for
  // momentum_crypto_usdc, same as the live decisions below.
  const tradingDb = new Database(tradingDbPath, { readonly: true });
  let comparison: ReturnType<typeof compareCryptoReplay>;
  try {
    const seeds = normalizeSeedPositions(sleeve, extractSeedPositions(tradingDb, sleeve, epochMs));
    const result = await runWithConfig(cfg, win, undefined, seeds);
    if (!result) {
      return { sleeve, status: "nothing_yet", epoch, lastSession: new Date(last.ts).toISOString(), staleSymbols: last.stale, divergences: [] };
    }
    const referenceDb = new Database(histPath, { readonly: true });
    try {
      comparison = compareCryptoReplay(tradingDb, referenceDb, sleeve, manifest.data, result.closedTrades, seeds, epochMs, endMs);
    } finally { referenceDb.close(); }
  } finally {
    tradingDb.close();
  }
  return {
    sleeve,
    status: "compared",
    epoch,
    lastSession: new Date(last.ts).toISOString(),
    staleSymbols: last.stale,
    ...comparison,
  };
}

// ── reporting / notification ─────────────────────────────────────────────
function fmtEvents(events: DecisionEvent[]): string {
  return events.length === 0 ? "(none)" : events.map(e => `${e.date} ${e.symbol}`).join(", ");
}

/** Divergences already investigated and explained (AUDITS.md / OPEN.md):
 *  rendered as acknowledged, never counted, so the daily cron pages only on
 *  NEW ones. Exact match on (sleeve, type, symbol, event date) — an ack can
 *  never hide a later event of the same symbol. */
export const PARITY_ACKNOWLEDGED: ReadonlyArray<{ sleeve: LiveSleeveId; type: DivergenceType; symbol: string; date: string; reason: string }> = [
  // Stop series (OPEN.md P2 b): the sim fires the 4% stop on the 1h
  // last-price low (08:00 bar), live's STOP_MARKET works on the mark price
  // and fired at 14:29. Same trade, same exit class, different trigger time.
  { sleeve: "momentum_crypto", type: "exit_missing_live", symbol: "AVAX/USD", date: "2026-09-28T08:00:00.000Z", reason: "stop series: sim 1h last-price low vs live mark-price STOP_MARKET (OPEN.md P2 b)" },
  { sleeve: "momentum_crypto", type: "exit_extra_live", symbol: "AVAX/USD", date: "2026-09-28T14:29:11.074Z", reason: "stop series: sim 1h last-price low vs live mark-price STOP_MARKET (OPEN.md P2 b)" },
  // Same class (AUDITS 2026-10-03): live's mark-price STOP_MARKET fired at
  // 00:11; the sim's 4% stop on the 1h last-price low fired at 03:00.
  { sleeve: "momentum_crypto", type: "exit_missing_live", symbol: "LINK/USD", date: "2026-09-30T03:00:00.000Z", reason: "stop series: sim 1h last-price low vs live mark-price STOP_MARKET (OPEN.md P2 b)" },
  { sleeve: "momentum_crypto", type: "exit_extra_live", symbol: "LINK/USD", date: "2026-09-30T00:11:43.056Z", reason: "stop series: sim 1h last-price low vs live mark-price STOP_MARKET (OPEN.md P2 b)" },
  // Stop LEVEL (AUDITS 2026-10-03): the sim's stop sits 4% under its
  // modelled fill (0.24672 → 0.23685), live's under the real fill (0.2463 →
  // 0.236448); the 18:00 bar low 0.2367 fell between them. The sim stopped
  // out and re-bought at 19:00, live held.
  { sleeve: "momentum_crypto", type: "exit_missing_live", symbol: "ADA/USD", date: "2026-10-02T19:00:00.000Z", reason: "stop level: sim modelled fill vs live real fill; bar low between the two stops (OPEN.md P2 b)" },
  { sleeve: "momentum_crypto", type: "entry_missing_live", symbol: "ADA/USD", date: "2026-10-02T19:00:00.000Z", reason: "stop level: sim modelled fill vs live real fill; bar low between the two stops (OPEN.md P2 b)" },
];

export function splitAcknowledged(sleeve: LiveSleeveId, divergences: Divergence[]): { fresh: Divergence[]; acknowledged: Divergence[] } {
  const fresh: Divergence[] = [];
  const acknowledged: Divergence[] = [];
  for (const d of divergences) {
    const date = d.simDate ?? d.liveDate;
    const ack = PARITY_ACKNOWLEDGED.some(a => a.sleeve === sleeve && a.type === d.type && a.symbol === d.symbol && a.date === date);
    (ack ? acknowledged : fresh).push(d);
  }
  return { fresh, acknowledged };
}

/** Newest funding settlement common to every universe perp (min over the
 *  per-symbol MAX(funding_time)); 0 when any symbol has none. */
export function fundingTailMs(db: Database, universe: string[]): number {
  let tail = Infinity;
  for (const sym of universe) {
    const perp = sym.replace("/USD", "USDT");
    const row = db.prepare(`SELECT MAX(funding_time) m FROM funding_rates WHERE symbol = ?`).get(perp) as { m: number | null } | null;
    tail = Math.min(tail, row?.m ?? 0);
  }
  return Number.isFinite(tail) ? tail : 0;
}

/** Window end clamped to the funding tail, bar-aligned (floor), so
 *  validateFundingCoverage's "last settlement ≥ window end" holds. */
export function clampToFundingTail(endMs: number, fundingTail: number, barMs: number): number {
  if (fundingTail >= endMs) return endMs;
  return Math.floor(fundingTail / barMs) * barMs;
}

export function renderSummary(results: SleeveParityResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`── ${r.sleeve} (epoch ${r.epoch}) ──`);
    if (r.status === "error") {
      lines.push(`  ❌ check FAILED (other sleeves unaffected): ${r.error ?? "unknown error"}`);
      continue;
    }
    if (r.portfolio) {
      lines.push(`  exact decision replay → ${r.lastSession}; float tolerance ${PORTFOLIO_FLOAT_TOLERANCE}`);
      for (const version of [...new Set(r.portfolio.map(d => d.version))]) {
        const rows = r.portfolio.filter(d => d.version === version);
        const counts = ["PARITY", "DATA REVISED", "DIVERGENCE"].map(c => `${rows.filter(d => d.classification === c).length} ${c}`).join(" / ");
        lines.push(`  ${version}: ${rows.length} decisions; ${counts}; max numeric delta=${Math.max(...rows.map(d => d.maxNumericDelta))}`);
      }
      for (const d of r.divergences) lines.push(`  ❌ DIVERGENCE ${d.liveDate}: ${d.symbol}`);
      for (const d of r.portfolio) {
        if (d.classification === "DATA REVISED") lines.push(`  DATA REVISED ${d.session}: inputs moved [${d.changedSymbols.join(", ") || "unattributed"}]; ${d.differences.length} differences; max delta=${d.maxNumericDelta}`);
        if (d.executionDrift.length) lines.push(`  execution drift (report only) ${d.session}: ${d.executionDrift.map(o => `${o.symbol} ${o.side} ${o.status} ${o.filled}/${o.requested} off-target=${o.offTargetWeight}`).join("; ")}`);
      }
      lines.push(r.divergences.length ? `  ❌ ${r.divergences.length} divergence(s)` : "  ✅ PARITY — no divergences (DATA REVISED / execution drift, if any, reported above)");
      continue;
    }
    if (r.staleSymbols.length > 0) {
      lines.push(`  ⚠️  STALE universe symbols (freeze the comparison window — fix the backfill): ${r.staleSymbols.map(s => `${s.symbol}@${s.lastBar}`).join(", ")}`);
    }
    if (r.status === "nothing_yet") {
      lines.push(`  nothing to compare yet: last complete session ${r.lastSession ?? "none"} < epoch`);
      continue;
    }
    lines.push(`  window: ${r.epoch} → ${r.lastSession}`);
    lines.push(`  sim  entries: ${fmtEvents(r.sim!.entries)}`);
    lines.push(`  live entries: ${fmtEvents(r.live!.entries)}`);
    lines.push(`  sim  exits:   ${fmtEvents(r.sim!.exits)}`);
    lines.push(`  live exits:   ${fmtEvents(r.live!.exits)}`);
    lines.push(`  sim  holdings @end: ${r.sim!.endHoldings.join(", ") || "(none)"}`);
    lines.push(`  live holdings @end: ${r.live!.endHoldings.join(", ") || "(none)"}`);
    for (const d of r.acknowledged ?? []) {
      lines.push(`  ☑️  acknowledged (explained, not paged): ${d.type} ${d.symbol}${d.simDate ? ` sim=${d.simDate}` : ""}${d.liveDate ? ` live=${d.liveDate}` : ""}`);
    }
    for (const e of r.explained ?? []) {
      lines.push(e.liveOnly
        ? `  ☑️  explained (live-only Turtle catastrophe stop): ${e.symbol} entry=${e.entryDate} sim=${e.simDate} live=${e.liveDate}`
        : `  ☑️  explained (stop anchored to the testnet fill): ${e.symbol} entry=${e.entryDate} sim=${e.simDate} live=${e.liveDate} stop=${e.stopPrice} first reference close=${e.referenceDate}`);
    }
    if (r.divergences.length === 0) {
      lines.push("  ✅ PARITY — no divergences");
    } else {
      lines.push(`  ❌ ${r.divergences.length} divergence(s):`);
      for (const d of r.divergences) {
        lines.push(`     - ${d.type} ${d.symbol}${d.simDate ? ` sim=${d.simDate}` : ""}${d.liveDate ? ` live=${d.liveDate}` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

/** ONE message to the OPS chat (watchdog.sh audience). Never the user chat;
 *  deliberately NO fallback to TELEGRAM_CHAT_ID. */
async function notifyOps(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OPS_CHAT_ID;
  if (!token || !chatId) {
    console.error("parity-check: --notify set but TELEGRAM_BOT_TOKEN/TELEGRAM_OPS_CHAT_ID missing — divergence stays in the log only");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) console.error(`parity-check: telegram send failed: HTTP ${res.status}`);
  } catch (e: any) {
    console.error(`parity-check: telegram send failed: ${e?.message ?? e}`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const rootDir = join(import.meta.dir, "..");
  const tradingDbPath = flag("--db") ?? join(rootDir, "data", "trading.db");
  const histPath = flag("--hist") ?? join(rootDir, "data", "historical.db");
  const only = flag("--sleeve");
  // Ad-hoc epoch override (YYYY-MM-DD) for manual investigations — e.g.
  // replaying a past week against the live book after a config incident.
  // The cron path never sets it.
  const epochOverride = flag("--epoch");
  const since = flag("--since"); // Portfolio history only; do not alter crypto's --epoch semantics.
  if (since && !Number.isFinite(Date.parse(since))) throw new Error(`invalid --since ${since}`);
  const notify = args.includes("--notify");

  // The monitor's sleeve list IS PARITY_EPOCHS' keys (module docstring) —
  // momentum_crypto_usdc stays out of the loop entirely until it gets an
  // entry there.
  const sleeves = (Object.keys(PARITY_EPOCHS) as LiveSleeveId[])
    .filter(s => !only || s === only);
  // The stock sleeves run ONLY on the portfolio engine (registry definition or the code's built-in
  // fallback — both the same current model version): always the exact decision replay, whatever
  // the registry says. No registry read is needed: checkPortfolioSleeve resolves each decision's
  // design from MODEL_VERSIONS + its manifest.
  const isStock = (s: LiveSleeveId) => s === "momentum_stocks" || s === "meanrev_stocks";
  const results: SleeveParityResult[] = [];
  for (const sleeve of sleeves) {
    // One sleeve's failure must not blind the monitor to the others
    // (2026-09-29: a momentum_crypto funding-tail throw aborted all four).
    try {
      results.push(
        isStock(sleeve)
          ? checkPortfolioSleeve(sleeve, tradingDbPath, histPath, rootDir, since ?? epochOverride)
          : await checkMomentumCryptoSleeve(tradingDbPath, histPath, rootDir, epochOverride, sleeve),
      );
    } catch (e: any) {
      results.push({ sleeve, status: "error", epoch: isStock(sleeve) ? since ?? epochOverride ?? currentModelVersion(sleeve)?.since ?? "?" : epochOverride ?? PARITY_EPOCHS[sleeve] ?? "?", error: e?.message ?? String(e), staleSymbols: [], divergences: [] });
    }
  }

  for (const r of results) {
    const { fresh, acknowledged } = splitAcknowledged(r.sleeve, r.divergences);
    r.divergences = fresh;
    if (acknowledged.length > 0) r.acknowledged = acknowledged;
  }

  const summary = renderSummary(results);
  console.log(`parity-check @ ${new Date().toISOString()}\n${summary}`);

  const totalDivergences = results.reduce((s, r) => s + r.divergences.length, 0);
  if (totalDivergences > 0) {
    if (notify) {
      await notifyOps(`⚠️ Uncle Carl parity-check: ${totalDivergences} live↔sim divergence(s)\n${summary.slice(0, 3500)}`);
    }
    process.exit(1);
  }
  // Stale universe data is an OPERATIONAL failure (the monitor cannot see
  // new sessions), not a strategy divergence — exit 2, no ops page (the
  // notify contract is: one message, only on divergence).
  if (results.some(r => r.staleSymbols.length > 0 || r.status === "error")) process.exit(2);
  // Explicit exit: the liveSleeveConfigs → src/index.ts import graph
  // constructs module-level singletons that keep the event loop alive.
  process.exit(0);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`parity-check failed: ${err?.message ?? err}`);
    console.error(err);
    process.exit(2);
  });
}
