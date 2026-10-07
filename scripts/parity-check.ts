#!/usr/bin/env bun
/**
 * parity-check — live↔sim DECISION monitor (W4 parity 2026-09-25; crypto
 * added 2026-09-26 after momentum_crypto ran ~2 weeks live on a DIFFERENT
 * model than the validated replay with nobody noticing, because this
 * monitor only covered the two daily stock sleeves).
 *
 * READ-ONLY. Replays the LIVE config (src/config/liveSleeveConfigs.ts — the
 * derivation locked against both index.ts and the authoritative manifests)
 * with the REAL simulators (scripts/backtest-momentum-wf.ts runWithConfig /
 * scripts/meanrev-replay.ts runMeanRevReplay) over data/historical.db, from
 * each sleeve's PARITY EPOCH to the last bar for which EVERY universe
 * symbol has a completed bar, and compares the ENTRY decisions, the EXIT
 * decisions and the holdings against the trades table of data/trading.db
 * (opened readonly).
 *
 * Two sleeve shapes, one comparison contract:
 *   - momentum_stocks / meanrev_stocks: DAILY bars (alpaca_wide/1d), ET
 *     trading sessions, decision stamps compared at day granularity
 *     (MATCH_TOLERANCE_DAYS calendar days) with an end-of-WINDOW holdings
 *     check. See checkSleeve.
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
 *
 * Decisions, not P&L: fill prices/quantities are expected to differ; the
 * SYMBOLS and their approximate TIMES are not. Positions opened before the
 * epoch are ignored on the live side (legacy books are the cutover's
 * problem, not parity's) — this is also why momentum_crypto's epoch is set
 * to the exact instant of its 2026-09-26 risk-state re-anchor: the sim's
 * empty book at the epoch mirrors the live book emptied by that re-anchor.
 *
 * Epochs (PARITY_EPOCHS — the monitor's sleeve list IS this map's keys):
 *   momentum_stocks 2026-09-28 — first daily pass after MODEL_CUTOVER
 *     re-underwrites the legacy 2×-regime positions (META/AAPL).
 *   meanrev_stocks  2026-09-29 — first pass with the IEX sizing-price fix
 *     (737836d, deployed after the 09-28 pass, which skipped ABBV on "no
 *     price"). Same reasoning as the earlier 09-25 → 09-28 move (the QCOM
 *     same-day-retry fix): an epoch before a fix re-pages the fixed
 *     divergence every day.
 *   momentum_crypto 2026-09-26T19:00:00Z — the instant the vt-35 re-anchor
 *     landed (MOMENTUM_CRYPTO_MODEL_VERSION) and reopened AVAX/LINK/ADA/SOL;
 *     first pass whose live risk state starts as clean as the replay's.
 *   momentum_crypto_usdc 2026-09-27T00:00:00Z — first DAILY decision of the
 *     d13-s5 kernel after its MODEL_CUTOVER; live BASE/USDC symbols map to
 *     the replay's BASE/USD proxies (normalizeLiveDecisions).
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
 *   - The sim book starts EMPTY at the epoch; live slots occupied by
 *     pre-epoch positions can admit fewer entries than the sim until they
 *     roll off (small for these epochs: momentum re-underwrites at its
 *     epoch, meanrev had 3 of 7 slots carried in, crypto re-anchors flat).
 *
 * Usage:
 *   bun run scripts/parity-check.ts [--db data/trading.db]
 *       [--hist data/historical.db] [--notify] [--sleeve <id>]
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
import { runMeanRevReplay } from "./meanrev-replay";
import { candidateToReplayConfig, type CandidateConfig, type ExperimentManifest } from "./walk-forward";

// ── epochs ────────────────────────────────────────────────────────────────
// The monitor's sleeve list IS this map's keys (see main()) — adding a
// sleeve here is the only wiring needed to check it (plus a dispatch arm in
// main() if it needs a non-daily comparison shape, like momentum_crypto's).
export const PARITY_EPOCHS: Partial<Record<LiveSleeveId, string>> = {
  // Re-anchored to the owner's realign pass (10-07): GOOGL (kept after its
  // 10-02 exit bounced 403) is closed by that pass's MODEL_CUTOVER, which the
  // extractors exclude, so the sim starts from the live book at the epoch.
  // 09-28..10-06 compared clean apart from GOOGL (AUDITS 2026-10-06).
  momentum_stocks: "2026-10-07",
  meanrev_stocks: "2026-09-29",
  // First pass after the 2026-09-26 vt-35 risk-state re-anchor
  // (MOMENTUM_CRYPTO_MODEL_VERSION) — live's book was emptied by that
  // re-anchor, so the sim's empty-at-epoch book is a true mirror.
  momentum_crypto: "2026-09-26T19:00:00Z",
  // Re-anchored to the owner's realign decision (00:00:15 UTC 10-08): its
  // MODEL_CUTOVER closes UNI/USDC, which the 09-29 cutover's simultaneous
  // re-rank had bought and the model does not hold. From the 09-29 epoch the
  // only divergence left was that UNI (AUDITS 2026-10-06).
  // Live trades are BASE/USDC; the replay runs the BASE/USD USDT-perp proxies
  // (declared in its manifest) — normalizeLiveDecisions.
  momentum_crypto_usdc: "2026-10-08T00:00:00Z",
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
    `SELECT symbol, side, entry_time, entry_price, quantity, stop_loss FROM trades
     WHERE account_id = ? AND entry_time < ? AND (status = 'open' OR exit_time >= ?)
       AND (close_reason IS NULL OR close_reason != ?)
     ORDER BY entry_time ASC`,
  ).all(accountId, epochMs, epochMs, MODEL_CUTOVER_CLOSE_REASON) as Array<{
    symbol: string; side: string; entry_time: number; entry_price: number; quantity: number; stop_loss: number | null;
  }>;
  return rows.map(r => ({
    symbol: r.symbol,
    side: r.side === "sell" ? "sell" as const : "buy" as const,
    qty: r.quantity,
    entryPrice: r.entry_price,
    entryAt: r.entry_time,
    stopPrice: r.stop_loss,
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
  | "eod_holdings_extra_live";

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
 *  DIFFERENT combination than the sim at some point inside the window). */
export function compareDailyHoldings(
  sim: SleeveDecisions,
  live: SleeveDecisions,
  fromMs: number,
  toMs: number,
): Divergence[] {
  const out: Divergence[] = [];
  for (const closeMs of utcDayCloses(fromMs, toMs)) {
    const dayKey = new Date(closeMs).toISOString().slice(0, 10);
    const simHeld = heldSymbolsAt(sim.entries, sim.exits, closeMs);
    const liveHeld = heldSymbolsAt(live.entries, live.exits, closeMs);
    for (const s of simHeld) if (!liveHeld.has(s)) out.push({ type: "eod_holdings_missing_live", symbol: s, simDate: dayKey });
    for (const s of liveHeld) if (!simHeld.has(s)) out.push({ type: "eod_holdings_extra_live", symbol: s, liveDate: dayKey });
  }
  return out;
}

// ── replay drivers ────────────────────────────────────────────────────────
interface SleeveParityResult {
  sleeve: LiveSleeveId;
  status: "compared" | "nothing_yet" | "error";
  epoch: string;
  /** status "error": why this sleeve's check threw (the others still run). */
  error?: string;
  /** Divergences matched by PARITY_ACKNOWLEDGED — shown, never counted. */
  acknowledged?: Divergence[];
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

/** Last session (ET date key + max bar ts) covered by EVERY universe symbol
 *  — a lagging symbol must clamp the window, or the replay fails closed.
 *  Also surfaces which symbols are stale relative to the freshest one. */
function lastCompleteSession(
  hist: Database,
  m: ExperimentManifest,
): { key: string; ts: number; stale: Array<{ symbol: string; lastBar: string }> } | null {
  const placeholders = m.data.universe.map(() => "?").join(",");
  const rows = hist.prepare(
    `SELECT symbol, MAX(timestamp) AS mx FROM historical_bars
     WHERE source = ? AND timeframe = ? AND symbol IN (${placeholders})
     GROUP BY symbol`,
  ).all(m.data.source, m.data.timeframe, ...m.data.universe) as Array<{ symbol: string; mx: number }>;
  if (rows.length === 0) return null;
  const missing = m.data.universe.filter(s => !rows.some(r => r.symbol === s));
  if (missing.length > 0) {
    return { key: "0000-00-00", ts: 0, stale: missing.map(symbol => ({ symbol, lastBar: "(no bars)" })) };
  }
  const minTs = Math.min(...rows.map(r => r.mx));
  const maxTs = Math.max(...rows.map(r => r.mx));
  const stale = rows
    .filter(r => maxTs - r.mx > STALE_SYMBOL_DAYS * 86_400_000)
    .map(r => ({ symbol: r.symbol, lastBar: getETDateKey(r.mx) }));
  return { key: getETDateKey(minTs), ts: minTs, stale };
}

export async function checkSleeve(
  sleeve: LiveSleeveId,
  tradingDbPath: string,
  histPath: string,
  rootDir: string,
  epochOverride?: string,
): Promise<SleeveParityResult> {
  const epoch = epochOverride ?? PARITY_EPOCHS[sleeve];
  if (!epoch) throw new Error(`checkSleeve: no PARITY_EPOCHS entry for "${sleeve}" and no --epoch override given`);
  const liveCfg = liveSleeveConfig(sleeve);
  const manifest: ExperimentManifest = JSON.parse(readFileSync(join(rootDir, liveCfg.manifestPath), "utf-8"));

  const hist = new Database(histPath, { readonly: true });
  let last: { key: string; ts: number } | null;
  try {
    last = lastCompleteSession(hist, manifest);
  } finally {
    hist.close();
  }
  if (!last || last.key < epoch) {
    return { sleeve, status: "nothing_yet", epoch, lastSession: last?.key, staleSymbols: last?.stale ?? [], divergences: [] };
  }

  const [epochStart] = getETDayBounds(epoch);
  const [, endMs] = getETDayBounds(last.key); // exclusive end of the last complete session
  // Momentum daily replays stamp the decision for live-day D at the CLOSE
  // of D's previous bar (+barMinutes): the epoch-day pass decides on the
  // last bar BEFORE the epoch. Start the window exactly at that bar's
  // decision instant, so the epoch pass is produced and nothing earlier is.
  // Meanrev's replay timeline IS the live pass dates: start at the epoch.
  const isMeanrev = sleeve === "meanrev_stocks";
  let fromMs = epochStart;
  if (!isMeanrev) {
    const hist2 = new Database(histPath, { readonly: true });
    try {
      const prev = hist2.prepare(
        `SELECT MAX(timestamp) AS ts FROM historical_bars
         WHERE source = ? AND timeframe = ? AND symbol = ? AND timestamp < ?`,
      ).get(manifest.data.source, manifest.data.timeframe, manifest.data.refSymbol, epochStart) as { ts: number | null };
      if (prev.ts !== null) fromMs = prev.ts + manifest.data.barMinutes * 60_000;
    } finally {
      hist2.close();
    }
  }
  const win = {
    label: `parity:${sleeve}`,
    from: new Date(fromMs).toISOString(),
    to: new Date(last.ts + 12 * 3_600_000).toISOString(),
  };

  const cfg = candidateToReplayConfig(manifest, liveCfg.candidate as CandidateConfig, "base", histPath);

  // Seed the sim's book with live positions already open AT THE EPOCH
  // (OPEN.md P2 "el libro del sim arranca vacío en el epoch") — read from
  // the same trading.db connection the live decisions come from, open for
  // the rest of this function.
  const tradingDb = new Database(tradingDbPath, { readonly: true });
  let sim: SleeveDecisions;
  let live: SleeveDecisions;
  try {
    const seeds = extractSeedPositions(tradingDb, sleeve, epochStart);
    const result: ReplayResult | null = isMeanrev
      ? await runMeanRevReplay(cfg, win, undefined, seeds)
      : await runWithConfig(cfg, win, undefined, seeds);
    if (!result) {
      return { sleeve, status: "nothing_yet", epoch, lastSession: last.key, staleSymbols: last.stale, divergences: [] };
    }
    sim = extractSimDecisions(result.closedTrades, endMs, getETDateKey, seeds);
    live = extractLiveDecisions(tradingDb, sleeve, epochStart, endMs);
  } finally {
    tradingDb.close();
  }
  return {
    sleeve,
    status: "compared",
    epoch,
    lastSession: last.key,
    staleSymbols: last.stale,
    sim,
    live,
    divergences: compareDecisions(sim, live),
  };
}

/** momentum_crypto — 24/7 hourly binance_futures replay. Unlike checkSleeve
 *  (daily ET sessions), the epoch IS the exact instant (no day-bounds
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
  let sim: SleeveDecisions;
  let live: SleeveDecisions;
  try {
    const seeds = normalizeSeedPositions(sleeve, extractSeedPositions(tradingDb, sleeve, epochMs));
    const result = await runWithConfig(cfg, win, undefined, seeds);
    if (!result) {
      return { sleeve, status: "nothing_yet", epoch, lastSession: new Date(last.ts).toISOString(), staleSymbols: last.stale, divergences: [] };
    }
    sim = extractSimDecisions(result.closedTrades, endMs, isoInstant, seeds);
    live = normalizeLiveDecisions(sleeve, extractLiveDecisions(tradingDb, sleeve, epochMs, endMs, isoInstant));
  } finally {
    tradingDb.close();
  }
  const divergences = [
    ...compareDecisions(sim, live, MATCH_TOLERANCE_HOURS_CRYPTO / 24),
    ...compareDailyHoldings(sim, live, epochMs, endMs),
  ];
  return {
    sleeve,
    status: "compared",
    epoch,
    lastSession: new Date(last.ts).toISOString(),
    staleSymbols: last.stale,
    sim,
    live,
    divergences,
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
  const notify = args.includes("--notify");

  // The monitor's sleeve list IS PARITY_EPOCHS' keys (module docstring) —
  // momentum_crypto_usdc stays out of the loop entirely until it gets an
  // entry there.
  const sleeves = (Object.keys(PARITY_EPOCHS) as LiveSleeveId[])
    .filter(s => !only || s === only);
  const results: SleeveParityResult[] = [];
  for (const sleeve of sleeves) {
    // One sleeve's failure must not blind the monitor to the others
    // (2026-09-29: a momentum_crypto funding-tail throw aborted all four).
    try {
      results.push(
        sleeve === "momentum_crypto" || sleeve === "momentum_crypto_usdc"
          ? await checkMomentumCryptoSleeve(tradingDbPath, histPath, rootDir, epochOverride, sleeve)
          : await checkSleeve(sleeve, tradingDbPath, histPath, rootDir, epochOverride),
      );
    } catch (e: any) {
      results.push({ sleeve, status: "error", epoch: epochOverride ?? PARITY_EPOCHS[sleeve] ?? "?", error: e?.message ?? String(e), staleSymbols: [], divergences: [] });
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
