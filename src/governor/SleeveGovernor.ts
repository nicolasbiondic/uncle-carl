// ══════════════════════════════════════════════
// SleeveGovernor — RECOMMENDATION-ONLY lifecycle watchdog for sleeves
// ══════════════════════════════════════════════
//
// NOTHING here changes a sleeve's mode automatically — in either direction.
// Owner mandate (2026-08-08, "always live, never demo"): a sleeve parked in
// shadow neither earns money nor produces live-equivalent evidence
// (ShadowAdapter does not simulate the hard stop-loss — the same reason
// promotion was already recommendation-only), so automatic demotion was
// removed too. Risk while live is controlled WITHOUT turning the sleeve off:
// RiskGuard pauses NEW ENTRIES on drawdown (thresholds declared in
// src/config/riskProfiles.ts SLEEVE_POLICY) while exits and the hard
// stop-loss keep managing open positions. Mode changes are exclusively
// human, via scripts/set-sleeve-mode.ts (which calls setMode below).
//
// Rules (evaluated at boot + every 24h, per-sleeve evidence epoch):
//   - LIVE sleeve, ≥90 days since evidence epoch, ≥30 closed non-null-PnL
//     rows after that epoch → judged against its VALIDATED EXPECTATION BAND
//     (owner, 2026-10-04; src/portfolio/scorecard.ts — the stock bands carry
//     the measured universe selection bias):
//       · band "below" (live return since the model start under the p5 of
//         the validated OOS distribution) → RECOMMEND_REDESIGN, whatever the
//         sign of the P&L;
//       · band "within"/"above" → no recommendation, even with a negative
//         P&L: at honest Sharpes (~1.0 momentum, ~0.5 meanrev) a sleeve that
//         performs exactly as validated is negative after 90 days 30–40% of
//         the time, and the old "PnL < 0" rule asked to redesign it;
//       · band "insufficient_data" (model younger than 5 sessions) → none;
//       · no band (no artifact for the sleeve, no provider, provider error)
//         → the legacy rule, PnL < 0 → RECOMMEND_REDESIGN, so the watchdog
//         is never blind.
//     A recommendation is log.error + activity row + CIRCUIT_BREAKER event →
//     the user's Telegram channel, with a 7-day cooldown per sleeve so a
//     persistent case pages weekly, not daily. The mode NEVER changes. Owner
//     rule (2026-09-26): a failing strategy is REDESIGNED so it keeps
//     trading — never switched off, paused or parked in shadow, and nothing
//     may even propose that. This recommendation used to say "demote"; it
//     now asks for a redesign.
//   - SHADOW sleeve, ≥90 days since evidence epoch, ≥30 closed non-null-PnL
//     rows after that epoch, PnL > 0, AND registration marks it
//     promotion-eligible → RECOMMEND_PROMOTE (log.warn + activity row).
//     Automatic promotion is IMPOSSIBLE: shadow books are not live-equivalent
//     (no hard-SL simulation in ShadowAdapter), so a human must review.
//
// migrateOnce() consequently REFUSES mode="shadow" (see its docstring): a
// deploy-time migration is an automatic path to shadow and is neutralized.
//
// The daily pass also runs the ex-ante evidence review-point check
// (src/portfolio/reviewPoint.ts): a one-time "time to review" alert per
// sleeve when its DECLARED observation target is reached. No action taken.
//
// Each sleeve carries a persisted evidence epoch + stable evidence version.
// Changing the supplied evidenceVersion on registration resets the epoch and
// excludes legacy rows, so a simulator-parity upgrade (for example) starts
// clean evidence.
//
// Modes persist in the sleeve_modes table (created here, own module init).
// getMode() has a 60s in-memory cache so the hot path (SwitchingAdapter
// routing every order) costs nothing.

import { getDB, insertActivity, RECONCILE_CLOSE_SQL } from "../db/database";
import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";
import { checkReviewPoints } from "../portfolio/reviewPoint";
import type { BandReading } from "../portfolio/scorecard";

const log = createLogger("SleeveGovernor");

export type SleeveMode = "live" | "shadow";

/** Minimal mode-lookup interface (SwitchingAdapter + tests depend on this). */
export interface ModeSource {
  getMode(sleeve: string, def?: SleeveMode): SleeveMode;
}

export interface SleeveRegistration {
  sleeve: string;
  /** DEFAULT mode when no sleeve_modes row exists yet. */
  kind: SleeveMode;
  /** Stable evidence version. Changing this resets the evidence epoch. */
  evidenceVersion?: string;
  /** If true, positive shadow evidence may emit a RECOMMEND_PROMOTE. Default false. */
  promotionEligible?: boolean;
}

export interface SleeveGovernorOptions {
  /** getMode cache TTL, default 60s. */
  cacheMs?: number;
  /** Minimum closed trades after the evidence epoch before any transition, default 30. */
  minTrades?: number;
  /** Re-evaluation interval, default 24h. */
  intervalMs?: number;
  /** Expectation-band readings per sleeve (index.ts wires the scorecard).
   *  Called at most once per evaluation pass, only when a sleeve reaches the
   *  decision. Absent = the legacy P&L rule for every sleeve. */
  bandReadings?: () => Record<string, BandReading>;
}

/** Pure: whether a matured live sleeve gets a redesign recommendation, and
 *  the basis stated in it. `band` is null when no band exists for the sleeve
 *  (no artifact, no provider, provider error — `bandError` says which). */
export function redesignVerdict(pnl: number, band: BandReading | null, bandError?: string): { recommend: boolean; basis: string } {
  const pct = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
  if (band && band.status !== "unavailable") {
    const vs = `live ${pct(band.liveCumReturnPct)} over ${band.horizonSessions} sessions since ${band.modelStart ?? "?"} vs band p5 ${pct(band.p5Pct)}`;
    if (band.status === "below") return { recommend: true, basis: `below its validated expectation band (${vs})` };
    if (band.status === "insufficient_data") return { recommend: false, basis: `model too new for its band (${band.reason ?? `${band.horizonSessions} sessions`})` };
    return { recommend: false, basis: `${band.status} its validated expectation band (${vs})` };
  }
  const why = bandError ?? band?.reason ?? "no band for this sleeve";
  return { recommend: pnl < 0, basis: `no expectation band (${why}) — legacy rule: 90d P&L ${pnl < 0 ? "< 0" : "≥ 0"}` };
}

const DAY_MS = 24 * 60 * 60_000;
const EVIDENCE_DAYS = 90;
/** A persistent bleed re-pages weekly, not on every daily pass. DB-backed
 *  (activity_log), so the cooldown survives restarts. */
const RECOMMEND_REDESIGN_COOLDOWN_MS = 7 * DAY_MS;

export class SleeveGovernor implements ModeSource {
  private registered = new Map<string, SleeveRegistration>();
  private cache = new Map<string, { mode: SleeveMode; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<Omit<SleeveGovernorOptions, "bandReadings">>;
  private bandReadings?: () => Record<string, BandReading>;

  constructor(opts: SleeveGovernorOptions = {}) {
    this.opts = {
      cacheMs: opts.cacheMs ?? 60_000,
      minTrades: opts.minTrades ?? 30,
      intervalMs: opts.intervalMs ?? 24 * 60 * 60_000,
    };
    this.bandReadings = opts.bandReadings;
    // Diagnostics-only publication (2026-09-09, docs/healthz audit): the
    // bot builds exactly one governor per process (index.ts). Publishing
    // the last-constructed instance lets /healthz/full read the REGISTERED
    // default kind (governor.register(..., kind:)) next to the persisted
    // sleeve_modes row, without index.ts wiring the instance through
    // DashboardServer's constructor. Harmless in tests: each test's own
    // SleeveGovernor() simply becomes "the" instance for its own scope.
    lastConstructedGovernor = this;
    getDB().exec(`
      CREATE TABLE IF NOT EXISTS sleeve_modes (
        sleeve TEXT PRIMARY KEY,
        mode TEXT CHECK(mode IN ('live','shadow')),
        updated_at INTEGER,
        reason TEXT,
        evidence_epoch INTEGER,
        evidence_version TEXT,
        promotion_eligible INTEGER DEFAULT 0
      )
    `);
    getDB().exec(`
      CREATE TABLE IF NOT EXISTS governor_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER
      )
    `);
    this.ensureColumns();
  }

  private ensureColumns(): void {
    const info = getDB().prepare("PRAGMA table_info(sleeve_modes)").all() as Array<{ name: string }>;
    const names = new Set(info.map(c => c.name));
    const add = (col: string, def: string) => {
      if (!names.has(col)) {
        try {
          getDB().exec(`ALTER TABLE sleeve_modes ADD COLUMN ${col} ${def}`);
        } catch (e: any) {
          log.warn(`sleeve_modes add ${col} skipped: ${e?.message ?? e}`);
        }
      }
    };
    add("evidence_epoch", "INTEGER");
    add("evidence_version", "TEXT");
    add("promotion_eligible", "INTEGER DEFAULT 0");
  }

  register(reg: SleeveRegistration): void {
    this.registered.set(reg.sleeve, reg);

    const version = reg.evidenceVersion ?? "default";
    const eligible = reg.promotionEligible ? 1 : 0;
    const existing = getDB().prepare(
      `SELECT mode, evidence_version, promotion_eligible, evidence_epoch FROM sleeve_modes WHERE sleeve = ?`
    ).get(reg.sleeve) as any;

    const now = Date.now();
    if (!existing) {
      getDB().prepare(
        `INSERT INTO sleeve_modes (sleeve, mode, updated_at, reason, evidence_epoch, evidence_version, promotion_eligible)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(reg.sleeve, reg.kind, now, "registered", now, version, eligible);
      this.cache.set(reg.sleeve, { mode: reg.kind, at: now });
      return;
    }

    if (existing.evidence_version !== version) {
      // New evidence regime: exclude legacy rows from this sleeve's gate.
      getDB().prepare(
        `UPDATE sleeve_modes
         SET evidence_version = ?, evidence_epoch = ?, promotion_eligible = ?, updated_at = ?, reason = ?
         WHERE sleeve = ?`
      ).run(version, now, eligible, now, `evidence version reset: ${existing.evidence_version ?? "null"} → ${version}`, reg.sleeve);
    } else if (existing.promotion_eligible !== eligible) {
      getDB().prepare(
        `UPDATE sleeve_modes
         SET promotion_eligible = ?, updated_at = ?, reason = ?
         WHERE sleeve = ?`
      ).run(eligible, now, `promotion eligibility changed: ${existing.promotion_eligible} → ${eligible}`, reg.sleeve);
    }
  }

  getMode(sleeve: string, def?: SleeveMode): SleeveMode {
    const fallback = def ?? this.registered.get(sleeve)?.kind ?? "live";
    const cached = this.cache.get(sleeve);
    if (cached && Date.now() - cached.at < this.opts.cacheMs) return cached.mode;
    let mode = fallback;
    try {
      const row = getDB().prepare(`SELECT mode FROM sleeve_modes WHERE sleeve = ?`).get(sleeve) as any;
      if (row?.mode === "live" || row?.mode === "shadow") mode = row.mode;
    } catch (e: any) {
      log.warn(`getMode(${sleeve}) read failed, using ${fallback}: ${e?.message ?? e}`);
    }
    this.cache.set(sleeve, { mode, at: Date.now() });
    return mode;
  }

  setMode(sleeve: string, mode: SleeveMode, reason: string): void {
    const now = Date.now();
    getDB().prepare(`
      INSERT INTO sleeve_modes (sleeve, mode, updated_at, reason) VALUES (?, ?, ?, ?)
      ON CONFLICT(sleeve) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, reason = excluded.reason
    `).run(sleeve, mode, now, reason);
    this.cache.set(sleeve, { mode, at: now });
  }

  /**
   * Test/audit hook to back-date (or forward-date) a sleeve's evidence epoch.
   * Does NOT change the mode.
   */
  setEvidenceEpoch(sleeve: string, epochMs: number, version?: string): void {
    const now = Date.now();
    const row = getDB().prepare(`SELECT evidence_version FROM sleeve_modes WHERE sleeve = ?`).get(sleeve) as any;
    const v = version ?? row?.evidence_version ?? "default";
    getDB().prepare(
      `UPDATE sleeve_modes SET evidence_epoch = ?, evidence_version = ?, updated_at = ?, reason = ? WHERE sleeve = ?`
    ).run(epochMs, v, now, "evidence epoch set (audit/test)", sleeve);
  }

  /**
   * Forces a mode ONCE, keyed by `name` — for a deploy-time policy change
   * that must win over a legacy persisted row, without permanently pinning
   * the sleeve: a later setMode() (manual ops) is a legitimate mode change
   * and is NEVER re-clobbered on a restart, because `name` marks the
   * migration itself as applied, not the mode.
   *
   * mode="shadow" is REFUSED (owner mandate 2026-08-08, "always live"): a
   * deploy-time migration is an automatic path into shadow — e.g. index.ts's
   * 2026-07-16 momentum_crypto migration would re-fire on any DB whose
   * governor_migrations marker is missing (fresh restore, wiped table) and
   * silently shadow a sleeve a human had put live. A refused migration is
   * still marked applied (idempotent, no boot spam) and leaves an audit
   * activity row; the mode is untouched.
   */
  migrateOnce(name: string, sleeve: string, mode: SleeveMode, reason: string): void {
    const applied = getDB().prepare(`SELECT 1 FROM governor_migrations WHERE name = ?`).get(name);
    if (applied) return;
    if (mode === "shadow") {
      const msg = `migrateOnce('${name}') requested shadow for ${sleeve} — NEUTRALIZED (owner mandate: no automatic path to shadow; modes change only via scripts/set-sleeve-mode.ts). Mode unchanged. Original reason: ${reason}`;
      log.warn(msg);
      insertActivity(sleeve, "system", msg);
      getDB().prepare(`INSERT INTO governor_migrations (name, applied_at) VALUES (?, ?)`).run(name, Date.now());
      return;
    }
    this.setMode(sleeve, mode, reason);
    getDB().prepare(`INSERT INTO governor_migrations (name, applied_at) VALUES (?, ?)`).run(name, Date.now());
  }

  start(): void {
    this.safeEvaluate();
    this.timer = setInterval(() => this.safeEvaluate(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs one evaluation pass over every registered sleeve. Public for tests. */
  evaluate(): void {
    const now = Date.now();
    // Band readings: computed lazily, at most once per pass. A throwing
    // provider leaves every sleeve on the legacy rule for this pass.
    let readings: Record<string, BandReading> | null | undefined;
    let readingsError: string | undefined;
    const bandFor = (sleeve: string): BandReading | null => {
      if (!this.bandReadings) return null;
      if (readings === undefined) {
        try {
          readings = this.bandReadings();
          log.info(`band readings: ${Object.entries(readings).map(([s, r]) => `${s}=${r.status}`).join(", ") || "none"}`);
        } catch (e: any) {
          readings = null;
          readingsError = `provider failed: ${e?.message ?? e}`;
          log.warn(`band readings unavailable this pass (${readingsError}) — legacy P&L rule`);
        }
      }
      return readings?.[sleeve] ?? null;
    };
    for (const sleeve of this.registered.keys()) {
      const mode = this.getMode(sleeve);
      const meta = getDB().prepare(
        `SELECT evidence_epoch, evidence_version, promotion_eligible FROM sleeve_modes WHERE sleeve = ?`
      ).get(sleeve) as any;
      if (!meta) continue; // should not happen after register()

      const epoch = meta.evidence_epoch ?? now;
      if (now - epoch < EVIDENCE_DAYS * DAY_MS) continue;

      // Evidence account: live → own book; shadow → its shadow book.
      const account = mode === "live" || sleeve.startsWith("shadow_") ? sleeve : `shadow_${sleeve}`;
      // Rolling 90d window, not lifetime-since-epoch: maturation (line above)
      // still requires 90d since the epoch, but the stats query itself only
      // looks at trades closed within the last 90d.
      const windowStart = Math.max(epoch, now - EVIDENCE_DAYS * DAY_MS);
      const { pnl, n } = this.windowStats(account, windowStart);

      if (n < this.opts.minTrades) continue;

      const detail = `${EVIDENCE_DAYS}d PnL $${pnl.toFixed(2)} over ${n} trades (evidence ${meta.evidence_version ?? "default"})`;

      if (mode === "live") {
        const band = bandFor(sleeve);
        const verdict = redesignVerdict(pnl, band, band ? undefined : readingsError);
        if (verdict.recommend) {
          // Recommendation ONLY. Owner rules: the governor NEVER changes a
          // mode (2026-08-08), and a failing strategy is REDESIGNED so it
          // keeps trading — never switched off, paused or moved to shadow,
          // and never even proposed (2026-09-26). The sleeve keeps
          // operating; the recommendation asks for a pre-registered redesign
          // (experiments/).
          const reason = `${detail} — ${verdict.basis} — the sleeve keeps trading; recommend a strategy REDESIGN (pre-registered, experiments/)`;
          if (!this.hasRecentActivity(sleeve, "RECOMMEND_REDESIGN%", RECOMMEND_REDESIGN_COOLDOWN_MS)) {
            insertActivity(sleeve, "circuit", `RECOMMEND_REDESIGN: ${sleeve} — ${reason}`);
            log.error(`📉 RECOMMEND_REDESIGN ${sleeve}: ${reason}`);
            eventBus.emit(EVENTS.CIRCUIT_BREAKER, { sleeve, profileId: sleeve, action: "recommend_redesign", reason });
          }
        } else if (pnl < 0) {
          // The legacy rule would have paged here; say why it doesn't.
          log.info(`${sleeve}: ${detail} — ${verdict.basis}; no redesign recommendation`);
        }
      } else if (mode === "shadow" && pnl > 0 && meta.promotion_eligible) {
        // Recommendation only — promotion moves capital; a human decides.
        insertActivity(sleeve, "circuit", `RECOMMEND_PROMOTE: ${sleeve} — ${detail} — manual review required`);
        log.warn(`💡 RECOMMEND_PROMOTE ${sleeve}: ${detail}`);
      }
    }
  }

  private safeEvaluate(): void {
    try {
      this.evaluate();
    } catch (e: any) {
      log.error(`evaluate failed: ${e?.message ?? e}`);
    }
    // Daily ex-ante review-point check (one-time "time to review" alert per
    // sleeve/policy-version; takes no action — see portfolio/reviewPoint.ts).
    try {
      checkReviewPoints();
    } catch (e: any) {
      log.error(`review-point check failed: ${e?.message ?? e}`);
    }
  }

  /** DB-backed cooldown lookup (survives restarts, unlike in-memory state). */
  private hasRecentActivity(sleeve: string, messageLike: string, windowMs: number): boolean {
    try {
      const row = getDB().prepare(
        `SELECT 1 FROM activity_log WHERE account_id = ? AND message LIKE ? AND created_at > ? LIMIT 1`
      ).get(sleeve, messageLike, Date.now() - windowMs);
      return !!row;
    } catch (e: any) {
      // Fail closed for alert spam: if the check is broken, don't re-page.
      log.warn(`activity cooldown check failed (${sleeve}): ${e?.message ?? e}`);
      return true;
    }
  }

  private windowStats(account: string, since: number): { pnl: number; n: number } {
    const row = getDB().prepare(
      // Canonical reconcile filter: phantom/reconcile rows must not count
      // toward the evidence gate. pnl must be non-null (a closed row with no
      // outcome is not independent evidence).
      `SELECT COALESCE(SUM(pnl), 0) pnl, COUNT(*) n FROM trades
       WHERE account_id = ? AND status = 'closed' AND exit_time > ? AND pnl IS NOT NULL
         AND ${RECONCILE_CLOSE_SQL}`
    ).get(account, since) as any;
    return { pnl: row?.pnl ?? 0, n: row?.n ?? 0 };
  }

  /** Diagnostics-only: the DEFAULT kind index.ts registered for a sleeve via
   *  governor.register(..., kind:) — independent of any later sleeve_modes
   *  override. null if the sleeve was never registered on this instance. */
  getRegisteredKind(sleeve: string): SleeveMode | null {
    return this.registered.get(sleeve)?.kind ?? null;
  }

  /** Diagnostics-only: every sleeve name registered on this instance. */
  getRegisteredSleeves(): string[] {
    return [...this.registered.keys()];
  }

  /** Dashboard/health surface: all persisted modes. */
  getModes(): Array<{
    sleeve: string;
    mode: SleeveMode;
    updatedAt: number;
    reason: string | null;
    evidenceEpoch: number | null;
    evidenceVersion: string | null;
    promotionEligible: boolean;
  }> {
    try {
      const rows = getDB().prepare(
        `SELECT sleeve, mode, updated_at, reason, evidence_epoch, evidence_version, promotion_eligible FROM sleeve_modes`
      ).all() as any[];
      return rows.map(r => ({
        sleeve: r.sleeve,
        mode: r.mode,
        updatedAt: r.updated_at,
        reason: r.reason ?? null,
        evidenceEpoch: r.evidence_epoch ?? null,
        evidenceVersion: r.evidence_version ?? null,
        promotionEligible: !!r.promotion_eligible,
      }));
    } catch {
      return [];
    }
  }
}

// ── Last-constructed instance (diagnostics only) ───────────────────────────
//
// See the constructor comment above for why this exists. NOT a
// dependency-injection replacement — nothing in the trading path reads this;
// only /healthz/full (src/dashboard/routes/health.ts) does, to show the
// REGISTERED kind next to the persisted sleeve_modes row.
let lastConstructedGovernor: SleeveGovernor | null = null;
export function getLastConstructedSleeveGovernor(): SleeveGovernor | null {
  return lastConstructedGovernor;
}

/** Test-only escape hatch: forces the next getLastConstructedSleeveGovernor()
 *  call to return null until a new SleeveGovernor() is built. Not used by
 *  production code. */
export function _resetLastConstructedSleeveGovernorForTests(): void {
  lastConstructedGovernor = null;
}
