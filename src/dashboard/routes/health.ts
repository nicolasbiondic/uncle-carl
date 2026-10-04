// ═══ Health check endpoints ═══
//
// Two endpoints with different audiences:
//   /healthz       — PUBLIC, returns only liveness (no business data)
//   /healthz/full  — AUTHENTICATED, returns full diagnostic payload
//
// Audit fix (2026-05-04): the previous /healthz leaked open-position counts,
// db size, profile counts and broker status to anonymous callers. Sensitive
// data is now gated by the dashboard auth wall.

import express from "express";
import type { AccountManager } from "../../account/AccountManager";
import { getSession } from "../auth-store";
import { getLastInvariantReport } from "../../portfolio/truth";
import { heartbeats } from "../../ops/heartbeat";
import { isTradingEnabled } from "../../config";
import { DASHBOARD_VERSION } from "../version";
import { RECONCILE_CLOSE_SQL } from "../../db/database";
import { ALL_PROFILE_IDS } from "../../config/riskProfiles";
import { VERSION_INFO } from "../../utils/version";
import { getDefaultRiskEngine } from "../../risk/RiskEngine";
import { getPublishedManifest } from "../../ops/instanceManifest";
import { getLastConstructedSleeveGovernor } from "../../governor/SleeveGovernor";

// Critical loops are the live trading sleeves + sync/SL loops — anything NOT
// observational (shadow_* books and funding_monitor are informational only).
// Shared by both endpoints below so the definition of "critical" lives in
// exactly one place — this is the SAME filter /healthz/full already used.
function staleCriticalLoops(): ReturnType<typeof heartbeats.snapshot> {
  return heartbeats.snapshot().filter(h => h.stale && !h.name.startsWith("shadow_") && h.name !== "funding_monitor");
}

// LIVENESS vs READINESS (2026-09-11, the 83-restart class finally diagnosed).
//
// `stale` means "one pass overran its grace" — sl_loop (15s × 2) is stale
// after 30s of silence, and it beats at the END of a pass, so a pass that
// waits on a slow broker (Alpaca 504 storm 2026-09-11 16:26-16:50, COIN-M
// mark-price misses 2026-09-03) is "stale" while the process is perfectly
// alive. watchdog.sh hits ONLY /healthz with `curl -f`, so a 503 here =
// "restart now". Restart → cold cache → first pass against the same slow
// upstream → stale → 503 → restart: five restarts in 20 minutes today, and
// 83 in the history — none of them a dead process. The public probe must
// answer LIVENESS: is the event loop serving and is anything beating at
// all? A loop is DEAD (503) only when its silence is out of proportion to
// its cadence — the 15s SL loop is the canary and trips at 5 minutes, which
// a true zombie (no beats at all) crosses and a slow pass never does. Mere
// staleness stays visible in the body (`status: "degraded"`,
// `stale_loop_count`) and in /healthz/full's readiness (still 503 there).
export const DEAD_LOOP_FLOOR_MS = 5 * 60_000;
export const DEAD_LOOP_MULTIPLIER = 5;
export function isDeadLoop(h: { ageMs: number; expectedIntervalMs: number }): boolean {
  return h.ageMs > Math.max(DEAD_LOOP_FLOOR_MS, h.expectedIntervalMs * DEAD_LOOP_MULTIPLIER);
}
function deadCriticalLoops(): ReturnType<typeof heartbeats.snapshot> {
  return staleCriticalLoops().filter(isDeadLoop);
}

// Broker reachability per venue (2026-09-25, the watchdog-vs-broker-outage
// class): each venue's 60s sync loop is its reachability probe — a loop that
// keeps COMPLETING passes (beatFailed) while its broker times out is alive
// (never 503 here, never a restart) but the venue is down. Derived from the
// SAME heartbeat snapshot, thresholds shared via isBrokerUnreachable.
const VENUE_SYNC_LOOPS: Record<string, string> = {
  alpaca: "sync_alpaca",
  binance_usdm: "sync_binance",
  binance_usdc: "sync_binance_usdc",
  binance_coinm: "sync_binance_coinm",
};
function brokerUnreachableByVenue(): Record<string, { unreachable: boolean; consecutive_failures: number; last_success_ago_seconds: number }> {
  const byName = new Map(heartbeats.snapshot().map(h => [h.name, h]));
  const out: Record<string, { unreachable: boolean; consecutive_failures: number; last_success_ago_seconds: number }> = {};
  for (const [venue, loop] of Object.entries(VENUE_SYNC_LOOPS)) {
    const h = byName.get(loop);
    if (!h) continue; // venue not wired in this process (e.g. COIN-M flag off)
    out[venue] = {
      unreachable: h.brokerUnreachable,
      consecutive_failures: h.consecutiveFailures,
      last_success_ago_seconds: Math.floor(h.successAgeMs / 1000),
    };
  }
  return out;
}
function brokerUnreachableCount(): number {
  return Object.values(brokerUnreachableByVenue()).filter(v => v.unreachable).length;
}

export function registerHealthRoutes(app: express.Application, am: AccountManager): void {
  // Public liveness probe — no business data.
  app.get("/healthz", (_req, res) => {
    try {
      const { getDB } = require("../../db/database");
      const db = getDB();
      db.prepare("SELECT 1").get();

      // P1 fix (2026-07-27): this used to return 200 as long as SQLite could
      // answer "SELECT 1" — a bot with every trading loop silently dead (the
      // zombie incident: no SL loop, no heartbeats) still reported healthy.
      // AGENTS.md already claimed "a stale critical loop makes /healthz 503";
      // it was only true for /healthz/full, which nothing automated queries
      // (watchdog.sh only ever hits /healthz). Reuses the SAME critical-loop
      // filter /healthz/full uses below — conservative on purpose: a false
      // 503 here makes the watchdog restart a bot that's actually fine.
      const staleCritical = staleCriticalLoops();
      const deadCritical = deadCriticalLoops();
      if (deadCritical.length > 0) {
        // Genuinely dead (see isDeadLoop): the zombie case the 2026-07-27 fix
        // was for. 503 → the watchdog restarts, correctly.
        return res.status(503).json({
          status: "dead",
          version: DASHBOARD_VERSION,
          commit: VERSION_INFO.commit,
          dirty: VERSION_INFO.dirty,
          started_at: new Date(VERSION_INFO.startedAt).toISOString(),
          uptime_seconds: Math.floor(process.uptime()),
          stale_loop_count: staleCritical.length,
          dead_loop_count: deadCritical.length,
          // Forensics for the watchdog log: a dead loop WITH the broker also
          // down is still a dead loop (restart is correct); the field just
          // records the coincidence.
          broker_unreachable_count: brokerUnreachableCount(),
        });
      }

      // Alive. Stale-but-not-dead is reported, NOT used to fail liveness —
      // that is exactly the false 503 the comment above warned about.
      // Same doctrine for a broker outage (2026-09-23/25): loops that keep
      // completing passes against an unreachable broker beat as alive, so
      // they never reach "dead" above — this endpoint answers 200 and the
      // watchdog must NOT restart (a restart cannot cure a broker outage).
      // The count is surfaced (non-sensitive) so the watchdog log / an
      // external monitor can tell "degraded: broker down" from "healthy".
      const brokerDown = brokerUnreachableCount();
      res.status(200).json({
        status: staleCritical.length > 0 || brokerDown > 0 ? "degraded" : "ok",
        ...(staleCritical.length > 0 ? { stale_loop_count: staleCritical.length } : {}),
        ...(brokerDown > 0 ? { broker_unreachable_count: brokerDown } : {}),
        version: DASHBOARD_VERSION,
        // Runtime code-version identity (2026-07-27 zombie-process fix): lets
        // a post-deploy check confirm the LIVE process is on the commit that
        // was just pushed, instead of trusting an orphaned process that
        // happens to still answer this port. Deliberately only commit/dirty/
        // started_at — no file paths, hostnames, positions, or equity.
        commit: VERSION_INFO.commit,
        dirty: VERSION_INFO.dirty,
        started_at: new Date(VERSION_INFO.startedAt).toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
      });
    } catch (e: any) {
      res.status(503).json({ status: "error", error: e.message });
    }
  });

  // Detailed diagnostic — authenticated.
  app.get("/healthz/full", (req: any, res) => {
    if (!getSession(req)) return res.status(401).json({ error: "Authentication required" });
    try {
      const { getDB } = require("../../db/database");
      const db = getDB();
      db.prepare("SELECT 1").get();

      // v8: liveness = broker sync cadence (60s loops), not the removed scan.
      const lastSync = am.lastSyncAt;
      const agoSec   = lastSync > 0 ? Math.floor((Date.now() - lastSync) / 1000) : -1;
      const totalPos = Array.from(am.accounts.values()).reduce((s, a) => s + a.positions.size, 0);

      // Loop-liveness watchdog snapshot. A stale CRITICAL loop (the live trading
      // sleeves: momentum:*, meanrev:*) degrades health to 503; shadow_* and
      // funding_monitor are observational — surfaced but not health-degrading.
      const hbSnapshot     = heartbeats.snapshot();
      const staleCritical  = staleCriticalLoops();
      const ok             = agoSec >= 0 && agoSec < 180 && staleCritical.length === 0;

      let profileCount = 0;
      try { profileCount = (db.prepare("SELECT COUNT(*) as c FROM profiles").get() as any)?.c || 0; } catch {}

      let dbSizeMb = 0;
      try {
        const fs = require("fs");
        const stat = fs.statSync("./data/trading.db");
        dbSizeMb = parseFloat((stat.size / 1024 / 1024).toFixed(2));
      } catch {}

      const alpacaLastMsg  = am.executor.alpaca.lastMessageAt;
      const binanceLastMsg = (am.executor.binance as any).lastMessageAt ?? 0;
      const brokerStatus: any = {
        alpaca_paper: {
          status: am.executor.alpaca.isConnected() ? "connected" : "disconnected",
          last_price: alpacaLastMsg > 0 ? `${Math.floor((Date.now() - alpacaLastMsg) / 1000)}s ago` : "none",
        },
        binance_testnet: {
          status: am.executor.binance.isConnected() ? "connected" : "disconnected",
          last_price: binanceLastMsg > 0 ? `${Math.floor((Date.now() - binanceLastMsg) / 1000)}s ago` : "none",
        },
      };

      // Surface WHY the bot might not be trading — sync liveness + active
      // engine (RiskGuard) pauses. `sync_stale` flips the probe to 503 so an
      // external monitor pages.
      const syncStale = agoSec < 0 || agoSec > 180;
      const pauses: any[] = [];
      try {
        for (const [id, st] of Object.entries(am.getCircuits())) {
          if (st.paused) pauses.push({ profile: id, reason: st.reason || "?", resumeAt: st.resumeAt || null });
        }
      } catch {}
      // "traded today" sanity: closes+opens in the ET day (0 with market open ⇒ suspicious)
      let tradesToday = -1;
      try {
        const { getETDayStart } = require("../../db/database");
        const v8AccountSlots = ALL_PROFILE_IDS.map(() => "?").join(",");
        tradesToday = (db.prepare(`SELECT COUNT(*) c FROM trades WHERE entry_time >= ? AND ${RECONCILE_CLOSE_SQL} AND account_id IN (${v8AccountSlots})`).get(getETDayStart(), ...ALL_PROFILE_IDS) as any)?.c ?? -1;
      } catch {}

      // Sleeve governor modes — REGISTERED (governor.register(..., kind:) in
      // index.ts, the code default) vs EFFECTIVE (the sleeve_modes row, which
      // wins whenever the owner has manually overridden it via
      // scripts/set-sleeve-mode.ts — see SleeveGovernor.getMode). Audit fix
      // (2026-09-09): README's sleeve table + docs.test.ts only ever enforced
      // the REGISTERED default, so a manual override (e.g. momentum_crypto
      // registered shadow, running live since 2026-08-08) was invisible from
      // the repo. This field is the operative truth an external reader must
      // use instead of the README table alone.
      let sleeveModes: Array<{
        sleeve: string;
        registeredKind: "live" | "shadow" | null;
        effectiveMode: "live" | "shadow" | null;
        reason: string | null;
        updatedAt: number | null;
      }> = [];
      try {
        const governor = getLastConstructedSleeveGovernor();
        const rows: Array<{ sleeve: string; mode: string; updatedAt: number; reason: string | null }> = governor
          ? governor.getModes().map(m => ({ sleeve: m.sleeve, mode: m.mode, updatedAt: m.updatedAt, reason: m.reason }))
          : (db.prepare("SELECT sleeve, mode, updated_at, reason FROM sleeve_modes").all() as any[])
              .map(r => ({ sleeve: r.sleeve, mode: r.mode, updatedAt: r.updated_at, reason: r.reason }));
        const bySleeve = new Map(rows.map(r => [r.sleeve, r]));
        const allSleeves = new Set<string>([...bySleeve.keys(), ...(governor?.getRegisteredSleeves() ?? [])]);
        sleeveModes = Array.from(allSleeves).map(sleeve => {
          const row = bySleeve.get(sleeve);
          const registeredKind = governor?.getRegisteredKind(sleeve) ?? (row?.mode as "live" | "shadow" | undefined) ?? null;
          return {
            sleeve,
            registeredKind,
            effectiveMode: (row?.mode as "live" | "shadow" | undefined) ?? registeredKind,
            reason: row?.reason ?? null,
            updatedAt: row?.updatedAt ?? null,
          };
        });
      } catch {}

      res.status(ok ? 200 : 503).json({
        status: ok ? "ok" : "degraded",
        version: DASHBOARD_VERSION,
        uptime_seconds: Math.floor(process.uptime()),
        brokers: brokerStatus,
        profiles: profileCount,
        open_positions: totalPos,
        db_size_mb: dbSizeMb,
        last_sync_ago_seconds: agoSec,
        engine: {
          sync_stale: syncStale,
          trades_today: tradesToday,
          paused_profiles: pauses,
          stale_loops: staleCritical.map(h => h.name),
        },
        // Loop-liveness watchdog: every engine/index loop + its age/staleness.
        heartbeats: hbSnapshot,
        // Per-venue broker reachability (loops alive, broker failing) —
        // distinguishes "restart-worthy dead loop" from "wait out the
        // broker outage" for on-call and external monitors.
        broker_unreachable: brokerUnreachableByVenue(),
        // Daily portfolio invariant reconciliation (src/portfolio/truth.ts);
        // null until the first check of this process runs.
        invariants: getLastInvariantReport(),
        sleeveModes,
        // Maintenance kill-switch state (TRADING_ENABLED): false means this
        // process blocks NEW opens only — closes/stops keep running.
        trading_enabled: isTradingEnabled(),
        // Broker-enforced kill switch (Alpaca `trade_suspended_by_user`). Worth
        // surfacing next to our own flag precisely because it is NOT ours: it
        // holds across a zombie process, a stale deploy or a second host with
        // the same keys — the failure mode our in-process switches cannot cover.
        // Optional-chained on purpose: a diagnostics endpoint must never fail
        // because one field is unreadable. Written flat it took the whole
        // payload down against an executor lacking the getter.
        alpaca_trade_suspended: am.executor?.alpaca?.isTradeSuspendedByBroker?.() ?? null,
        // RiskEngine global pre-trade veto state (src/risk/RiskEngine.ts):
        // ACTIVE=normal, HALTED=denies all new opens, REDUCING=denies only
        // exposure-increasing opens. Never affects closePosition.
        risk_engine: getDefaultRiskEngine().getState(),
        // Instance manifest (src/ops/instanceManifest.ts): effective config
        // (value + origin per money flag) + per-broker account fingerprints
        // published at startup. Secrets never appear — identities are
        // truncated sha256 fingerprints by construction. null until
        // publishInstanceManifest ran (i.e. outside the real bot process).
        manifest: getPublishedManifest(),
      });
    } catch (e: any) {
      res.status(503).json({ status: "error", error: e.message });
    }
  });
}
