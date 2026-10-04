import { describe, expect, test, beforeAll } from "bun:test";
import { getDB } from "../db/database";
import { SleeveGovernor, redesignVerdict } from "./SleeveGovernor";
import type { BandReading } from "../portfolio/scorecard";
import { SwitchingAdapter } from "./SwitchingAdapter";
import { eventBus, EVENTS } from "../utils/events";
import type { MomentumBrokerAdapter } from "../strategies/momentum/MomentumEngine";
import type { CurrentPosition } from "../strategies/momentum/Rebalancer";
import { makeTestDb } from "../test-support/db";

beforeAll(() => {
  makeTestDb();
});

const DAY = 24 * 60 * 60_000;
let seq = 0;

function seedClosed(account: string, pnl: number | null, opts: { exitTime?: number; closeReason?: string | null } = {}) {
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity,
       entry_time, status, exit_time, pnl, pnl_pct, account_id, profile_id, close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `gov_${seq++}`, "AAPL", "stock", "buy", "TEST", 100, 1,
    (opts.exitTime ?? Date.now()) - 3_600_000, "closed",
    opts.exitTime ?? Date.now(), pnl, pnl, account, account, opts.closeReason ?? null,
  );
}

function seedMany(account: string, n: number, pnlEach: number | null, opts: { exitTime?: number; closeReason?: string | null } = {}) {
  for (let i = 0; i < n; i++) seedClosed(account, pnlEach, opts);
}

function seedOpenLiveRow(account: string, symbol: string) {
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status, account_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(`gov_${seq++}`, symbol, "stock", "buy", "TEST", 100, 1, Date.now(), "open", account, account);
}

function fakeAdapter(name: string, positions: CurrentPosition[] = []) {
  const calls: string[] = [];
  const adapter: MomentumBrokerAdapter = {
    getOpenPositions: async () => { calls.push("positions"); return positions; },
    getEquity: async () => { calls.push("equity"); return name === "real" ? 111 : 999; },
    getRealisedPnlSince: async () => { calls.push("pnl"); return name === "real" ? 11 : 99; },
    openPosition: async () => { calls.push("open"); return { ok: true, reason: name }; },
    closePosition: async () => { calls.push("close"); return { ok: true, reason: name }; },
    fetchCandles: async () => { calls.push("candles"); return []; },
  };
  return { adapter, calls };
}

function activityCount(sleeve: string, like: string): number {
  const row = getDB().prepare(
    `SELECT COUNT(*) c FROM activity_log WHERE account_id = ? AND message LIKE ?`
  ).get(sleeve, like) as any;
  return row?.c ?? 0;
}

describe("SleeveGovernor — demotion is RECOMMENDATION-ONLY (owner mandate: always live)", () => {
  test("live sleeve meeting every bleed criterion → RECOMMEND_REDESIGN (never a demotion), mode NEVER changes", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_demote", kind: "live" });
    gov.setEvidenceEpoch("gov_demote", Date.now() - 91 * DAY);
    seedMany("gov_demote", 30, -5);

    let event: any = null;
    eventBus.once(EVENTS.CIRCUIT_BREAKER, (e: any) => { event = e; });
    gov.evaluate();

    // REVERT CANARY: if evaluate() ever calls setMode("shadow") again, this
    // is the line that fails.
    expect(gov.getMode("gov_demote")).toBe("live");
    expect(activityCount("gov_demote", "SLEEVE DEMOTED%")).toBe(0);
    // The recommendation is loud: activity row + CIRCUIT_BREAKER (→ Telegram).
    expect(activityCount("gov_demote", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(event?.sleeve).toBe("gov_demote");
    expect(event?.action).toBe("recommend_redesign");

    // Exactly once: a second daily pass inside the cooldown re-emits nothing.
    gov.evaluate();
    expect(activityCount("gov_demote", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(gov.getMode("gov_demote")).toBe("live");
  });

  test("29 trades is below the minimum — no recommendation", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_29", kind: "live" });
    gov.setEvidenceEpoch("gov_29", Date.now() - 91 * DAY);
    seedMany("gov_29", 29, -5);
    gov.evaluate();
    expect(gov.getMode("gov_29")).toBe("live");
    expect(activityCount("gov_29", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("losses older than the evidence epoch don't count", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_old", kind: "live" });
    gov.setEvidenceEpoch("gov_old", Date.now() - 30 * DAY);
    seedMany("gov_old", 30, -5, { exitTime: Date.now() - 31 * DAY });
    gov.evaluate();
    expect(gov.getMode("gov_old")).toBe("live");
    expect(activityCount("gov_old", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("reconciled close_reasons are excluded from the tally", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_rec", kind: "live" });
    gov.setEvidenceEpoch("gov_rec", Date.now() - 91 * DAY);
    seedMany("gov_rec", 30, -5, { closeReason: "BROKER_GONE_404" });
    seedMany("gov_rec", 10, -5, { closeReason: "MANUAL_CLOSE_UNRECONCILED" });
    seedMany("gov_rec", 10, -5, { closeReason: "SYNC_DUP_RECONCILED" });
    gov.evaluate();
    expect(activityCount("gov_rec", "RECOMMEND_REDESIGN%")).toBe(0); // only 0 qualifying trades

    // 30 qualifying losers on top → now it recommends (and still never demotes).
    seedMany("gov_rec", 30, -5);
    gov.evaluate();
    expect(activityCount("gov_rec", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(gov.getMode("gov_rec")).toBe("live");
  });

  test("null-pnl rows are excluded from the tally", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_null", kind: "live" });
    gov.setEvidenceEpoch("gov_null", Date.now() - 91 * DAY);
    seedMany("gov_null", 30, null);
    gov.evaluate();
    expect(activityCount("gov_null", "RECOMMEND_REDESIGN%")).toBe(0);

    // 30 real losers on top → now it recommends (and still never demotes).
    seedMany("gov_null", 30, -5);
    gov.evaluate();
    expect(activityCount("gov_null", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(gov.getMode("gov_null")).toBe("live");
  });

  test("profitable live sleeve: no recommendation", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_win", kind: "live" });
    gov.setEvidenceEpoch("gov_win", Date.now() - 91 * DAY);
    seedMany("gov_win", 40, +5);
    gov.evaluate();
    expect(gov.getMode("gov_win")).toBe("live");
    expect(activityCount("gov_win", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("windowStats uses a rolling 90d window, not lifetime from epoch", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    const sleeve = "gov_rolling";
    gov.register({ sleeve, kind: "live" });
    gov.setEvidenceEpoch(sleeve, Date.now() - 200 * DAY); // mature, well past 90d
    // Outside the 90d window: a lifetime-since-epoch bug would still count
    // these. Rolling must not.
    seedMany(sleeve, 30, -10, { exitTime: Date.now() - 120 * DAY });
    // Inside the 90d window: should be the ONLY trades counted.
    seedMany(sleeve, 30, +5, { exitTime: Date.now() - 10 * DAY });

    gov.evaluate();

    // Lifetime sum would be -150 (recommend). Rolling 90d sum is +150 (quiet).
    expect(gov.getMode(sleeve)).toBe("live");
    expect(activityCount(sleeve, "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("maturation guard is preserved: epoch <90d old is never evaluated", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    const sleeve = "gov_immature";
    gov.register({ sleeve, kind: "live" });
    gov.setEvidenceEpoch(sleeve, Date.now() - 10 * DAY);
    seedMany(sleeve, 30, -5, { exitTime: Date.now() - 5 * DAY });
    gov.evaluate();
    expect(gov.getMode(sleeve)).toBe("live");
    expect(activityCount(sleeve, "RECOMMEND_REDESIGN%")).toBe(0);
  });
});

describe("SleeveGovernor — judged against the validated expectation band (owner, 2026-10-04)", () => {
  const reading = (status: BandReading["status"], live: number | null = -9.1, p5: number | null = -7.2): BandReading =>
    ({ status, liveCumReturnPct: live, p5Pct: p5, horizonSessions: 40, modelStart: "2026-09-23", reason: status === "insufficient_data" ? "solo 3 sesiones vivas (mínimo 5)" : null });

  function matured(sleeve: string, pnlEach: number, band: (() => Record<string, BandReading>) | undefined) {
    const gov = new SleeveGovernor({ cacheMs: 0, bandReadings: band });
    gov.register({ sleeve, kind: "live" });
    gov.setEvidenceEpoch(sleeve, Date.now() - 91 * DAY);
    seedMany(sleeve, 30, pnlEach);
    return gov;
  }

  test("below the band → RECOMMEND_REDESIGN even with a positive 90d P&L, stating the band; the mode never changes", () => {
    const gov = matured("gov_band_below", +5, () => ({ gov_band_below: reading("below") }));
    let event: any = null;
    eventBus.once(EVENTS.CIRCUIT_BREAKER, (e: any) => { event = e; });
    gov.evaluate();
    expect(activityCount("gov_band_below", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(event?.action).toBe("recommend_redesign");
    expect(event?.reason).toContain("below its validated expectation band");
    expect(event?.reason).toContain("p5 -7.20%");
    expect(gov.getMode("gov_band_below")).toBe("live");
  });

  test("within or above the band → no recommendation, even with a negative 90d P&L (the old rule paged here)", () => {
    for (const status of ["within", "above"] as const) {
      const sleeve = `gov_band_${status}`;
      matured(sleeve, -5, () => ({ [sleeve]: reading(status, -3.0) })).evaluate();
      expect(activityCount(sleeve, "RECOMMEND_REDESIGN%")).toBe(0);
    }
  });

  test("a model too new for its band → no recommendation", () => {
    matured("gov_band_new", -5, () => ({ gov_band_new: reading("insufficient_data", -1, null) })).evaluate();
    expect(activityCount("gov_band_new", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("no band for the sleeve, or a throwing provider → the legacy rule (a negative 90d P&L recommends) and evaluate() never throws", () => {
    matured("gov_band_none", -5, () => ({ other_sleeve: reading("below") })).evaluate();
    expect(activityCount("gov_band_none", "RECOMMEND_REDESIGN%")).toBe(1);

    matured("gov_band_unavail", -5, () => ({ gov_band_unavail: reading("unavailable", null, null) })).evaluate();
    expect(activityCount("gov_band_unavail", "RECOMMEND_REDESIGN%")).toBe(1);

    const throwing = matured("gov_band_throw", -5, () => { throw new Error("historical.db locked"); });
    let event: any = null;
    eventBus.once(EVENTS.CIRCUIT_BREAKER, (e: any) => { event = e; });
    expect(() => throwing.evaluate()).not.toThrow();
    expect(activityCount("gov_band_throw", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(event?.reason).toContain("provider failed: historical.db locked");

    matured("gov_band_throw_win", +5, () => { throw new Error("x"); }).evaluate();
    expect(activityCount("gov_band_throw_win", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("the provider runs at most once per pass, and only when a sleeve reaches the decision", () => {
    let calls = 0;
    const provider = () => { calls++; return { gov_once_a: reading("within"), gov_once_b: reading("within") }; };
    const gov = new SleeveGovernor({ cacheMs: 0, bandReadings: provider });
    for (const s of ["gov_once_a", "gov_once_b"]) {
      gov.register({ sleeve: s, kind: "live" });
      gov.setEvidenceEpoch(s, Date.now() - 91 * DAY);
      seedMany(s, 30, -5);
    }
    gov.register({ sleeve: "gov_once_young", kind: "live" }); // immature: never needs a band
    gov.evaluate();
    expect(calls).toBe(1);

    const idle = new SleeveGovernor({ cacheMs: 0, bandReadings: provider });
    idle.register({ sleeve: "gov_once_idle", kind: "live" });
    idle.evaluate();
    expect(calls).toBe(1); // nobody matured → no scorecard computed
  });

  test("redesignVerdict is the single decision table", () => {
    expect(redesignVerdict(+100, reading("below")).recommend).toBe(true);
    expect(redesignVerdict(-100, reading("within")).recommend).toBe(false);
    expect(redesignVerdict(-100, reading("above")).recommend).toBe(false);
    expect(redesignVerdict(-100, reading("insufficient_data")).recommend).toBe(false);
    expect(redesignVerdict(-100, reading("unavailable")).recommend).toBe(true);
    expect(redesignVerdict(+100, reading("unavailable")).recommend).toBe(false);
    expect(redesignVerdict(-100, null).basis).toContain("legacy rule");
  });
});

describe("SleeveGovernor — migrateOnce cannot send a sleeve to shadow", () => {
  test("a shadow migration on a live sleeve is neutralized: mode stays live, migration marked applied", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_mig_live", kind: "live" });
    expect(gov.getMode("gov_mig_live")).toBe("live");

    gov.migrateOnce("test_shadow_mig", "gov_mig_live", "shadow", "deploy-time shadow default");

    // REVERT CANARY: the pre-mandate migrateOnce called setMode("shadow") here.
    expect(gov.getMode("gov_mig_live")).toBe("live");
    // Audit trail of the refusal exists…
    expect(activityCount("gov_mig_live", "%NEUTRALIZED%")).toBe(1);
    // …and the migration is marked applied (idempotent: re-run adds nothing).
    gov.migrateOnce("test_shadow_mig", "gov_mig_live", "shadow", "deploy-time shadow default");
    expect(gov.getMode("gov_mig_live")).toBe("live");
    expect(activityCount("gov_mig_live", "%NEUTRALIZED%")).toBe(1);
  });

  test("a migration to LIVE still works (only the shadow direction is forbidden)", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.setMode("gov_mig_up", "shadow", "legacy persisted shadow row");
    gov.register({ sleeve: "gov_mig_up", kind: "live" });
    expect(gov.getMode("gov_mig_up")).toBe("shadow"); // persisted row wins

    gov.migrateOnce("test_live_mig", "gov_mig_up", "live", "owner mandate: all sleeves live");
    expect(gov.getMode("gov_mig_up")).toBe("live");
  });
});

describe("SleeveGovernor — promotion is recommendation-only and gated", () => {
  test("promotion-eligible shadow sleeve with ≥30 winners → RECOMMEND_PROMOTE, stays shadow", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "shadow_rec_prom", kind: "shadow", promotionEligible: true, evidenceVersion: "v1" });
    gov.setEvidenceEpoch("shadow_rec_prom", Date.now() - 91 * DAY);
    seedMany("shadow_rec_prom", 30, +5);
    gov.evaluate();
    expect(gov.getMode("shadow_rec_prom")).toBe("shadow");
    expect(activityCount("shadow_rec_prom", "RECOMMEND_PROMOTE%")).toBe(1);
  });

  test("direct shadow sleeves registered WITHOUT promotionEligible are not promotion-eligible by default", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    for (const sleeve of ["shadow_example_a", "shadow_example_b", "shadow_example_c"]) {
      gov.register({ sleeve, kind: "shadow" });
      gov.setEvidenceEpoch(sleeve, Date.now() - 91 * DAY);
      seedMany(sleeve, 30, +5);
    }
    gov.evaluate();
    for (const sleeve of ["shadow_example_a", "shadow_example_b", "shadow_example_c"]) {
      expect(gov.getMode(sleeve)).toBe("shadow");
      expect(activityCount(sleeve, "RECOMMEND_PROMOTE%")).toBe(0);
    }
  });

  test("<90 days since evidence epoch → no recommendation even with 30 winners", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "shadow_young", kind: "shadow", promotionEligible: true, evidenceVersion: "v1" });
    gov.setEvidenceEpoch("shadow_young", Date.now() - 89 * DAY);
    seedMany("shadow_young", 30, +5);
    gov.evaluate();
    expect(gov.getMode("shadow_young")).toBe("shadow");
    expect(activityCount("shadow_young", "RECOMMEND_PROMOTE%")).toBe(0);
  });

  test("changing evidenceVersion resets the epoch and excludes legacy rows", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "shadow_version", kind: "shadow", promotionEligible: true, evidenceVersion: "v1" });
    gov.setEvidenceEpoch("shadow_version", Date.now() - 91 * DAY);
    seedMany("shadow_version", 30, +5);
    gov.evaluate();
    expect(activityCount("shadow_version", "RECOMMEND_PROMOTE%")).toBe(1);

    // New evidence regime: legacy rows must not count toward the new gate.
    gov.register({ sleeve: "shadow_version", kind: "shadow", promotionEligible: true, evidenceVersion: "v2" });
    gov.evaluate();
    expect(activityCount("shadow_version", "RECOMMEND_PROMOTE%")).toBe(1);
  });

  test("a DEMOTED live sleeve is judged on its shadow_ book for re-promotion", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_repromote", kind: "live", promotionEligible: true, evidenceVersion: "v1" });
    gov.setEvidenceEpoch("gov_repromote", Date.now() - 91 * DAY);
    gov.setMode("gov_repromote", "shadow", "test demotion");
    // Winners live in the shadow book, not the (dead) live book.
    seedMany("shadow_gov_repromote", 30, +5);
    gov.evaluate();
    expect(gov.getMode("gov_repromote")).toBe("shadow");
    expect(activityCount("gov_repromote", "RECOMMEND_PROMOTE%")).toBe(1);
  });
});

describe("SleeveGovernor — manual demotion preserves real-position drain", () => {
  test("after a HUMAN demotion (setMode), SwitchingAdapter still closes a residual real position via the real broker", async () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    const sleeve = "gov_drain";
    gov.register({ sleeve, kind: "live" });
    seedOpenLiveRow(sleeve, "AAPL");

    // evaluate() no longer demotes (owner mandate); the only demotion path
    // left is the human one — scripts/set-sleeve-mode.ts → setMode().
    gov.setMode(sleeve, "shadow", "manual demotion (human, set-sleeve-mode.ts)");
    expect(gov.getMode(sleeve)).toBe("shadow");

    const real = fakeAdapter("real");
    const shadow = fakeAdapter("shadow");
    const sw = new SwitchingAdapter(sleeve, gov, real.adapter, shadow.adapter, sleeve);
    const res = await sw.closePosition({ symbol: "AAPL", side: "buy" });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("close");
    expect(shadow.calls).not.toContain("close");
  });
});

describe("SleeveGovernor — getMode defaults and caching", () => {
  test("no row → registered default; unregistered → provided default → 'live'", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "gov_defaults", kind: "shadow" });
    expect(gov.getMode("gov_defaults")).toBe("shadow");
    expect(gov.getMode("gov_unknown", "shadow")).toBe("shadow");
    expect(gov.getMode("gov_unknown2")).toBe("live");
  });

  test("setMode is visible immediately; external DB writes hide behind the cache TTL", () => {
    const gov = new SleeveGovernor({ cacheMs: 60_000 });
    gov.setMode("gov_cache", "shadow", "test");
    expect(gov.getMode("gov_cache")).toBe("shadow"); // cache primed by setMode

    // External write (another process / manual ops) — cached value survives.
    getDB().prepare(`UPDATE sleeve_modes SET mode = 'live' WHERE sleeve = 'gov_cache'`).run();
    expect(gov.getMode("gov_cache")).toBe("shadow");

    // Fresh governor (cold cache) sees the DB truth.
    const gov2 = new SleeveGovernor({ cacheMs: 0 });
    expect(gov2.getMode("gov_cache")).toBe("live");
  });

  test("getModes surfaces persisted rows for /healthz/full", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.setMode("gov_surface", "shadow", "why not");
    const modes = gov.getModes();
    const row = modes.find(m => m.sleeve === "gov_surface");
    expect(row?.mode).toBe("shadow");
    expect(row?.reason).toBe("why not");
    expect(row?.promotionEligible).toBe(false);
  });
});
