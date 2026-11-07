import { describe, expect, test, beforeAll } from "bun:test";
import { getDB } from "../db/database";
import { SleeveGovernor, redesignVerdict } from "./SleeveGovernor";
import type { BandReading } from "../portfolio/scorecard";
import { eventBus, EVENTS } from "../utils/events";
import { makeTestDb, rawSnap } from "../test-support/db";

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

/** The compatibility column every governor row carries; nothing reads it. */
function persistedMode(sleeve: string): string | null {
  const row = getDB().prepare(`SELECT mode FROM sleeve_modes WHERE sleeve = ?`).get(sleeve) as any;
  return row?.mode ?? null;
}

function activityCount(sleeve: string, like: string): number {
  const row = getDB().prepare(
    `SELECT COUNT(*) c FROM activity_log WHERE account_id = ? AND message LIKE ?`
  ).get(sleeve, like) as any;
  return row?.c ?? 0;
}

describe("SleeveGovernor — a bleed is RECOMMENDATION-ONLY (owner mandate: always live)", () => {
  test("without a band, live equity loss is not hidden by realizing pre-window gains", () => {
    const sleeve = "momentum_crypto";
    const gov = new SleeveGovernor();
    gov.register({ sleeve });
    gov.setEvidenceEpoch(sleeve, Date.now() - 91 * DAY);
    seedMany(sleeve, 30, 100, { closeReason: "MODEL_CUTOVER" });
    rawSnap(sleeve, 5000, Date.now() - 91 * DAY, 5);
    rawSnap(sleeve, 4900, Date.now() - DAY, 5);
    try {
      gov.evaluate();
      const row = getDB().prepare("SELECT message FROM activity_log WHERE account_id=? AND message LIKE 'RECOMMEND_REDESIGN%' ORDER BY id DESC LIMIT 1").get(sleeve) as { message: string };
      expect(row.message).toContain("PnL $-100.00 (MtM");
      expect(row.message).toContain("realized $3000.00");
      expect(persistedMode(sleeve)).toBe("live");
    } finally {
      for (const table of ["trades", "activity_log"]) getDB().prepare(`DELETE FROM ${table} WHERE account_id=?`).run(sleeve);
      getDB().prepare("DELETE FROM equity_snapshots WHERE profile_id=?").run(sleeve);
      getDB().prepare("DELETE FROM sleeve_modes WHERE sleeve=?").run(sleeve);
    }
  });
  test("live sleeve meeting every bleed criterion → RECOMMEND_REDESIGN (never a demotion), mode NEVER changes", () => {
    const gov = new SleeveGovernor();
    gov.register({ sleeve: "gov_demote" });
    gov.setEvidenceEpoch("gov_demote", Date.now() - 91 * DAY);
    seedMany("gov_demote", 30, -5);

    let event: any = null;
    eventBus.once(EVENTS.CIRCUIT_BREAKER, (e: any) => { event = e; });
    gov.evaluate();

    // REVERT CANARY: if evaluate() ever writes a mode again, this line fails.
    expect(persistedMode("gov_demote")).toBe("live");
    expect(activityCount("gov_demote", "SLEEVE DEMOTED%")).toBe(0);
    // The recommendation is loud: activity row + CIRCUIT_BREAKER (→ Telegram).
    expect(activityCount("gov_demote", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(event?.sleeve).toBe("gov_demote");
    expect(event?.action).toBe("recommend_redesign");

    // Exactly once: a second daily pass inside the cooldown re-emits nothing.
    gov.evaluate();
    expect(activityCount("gov_demote", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(persistedMode("gov_demote")).toBe("live");
  });

  test("29 trades is below the minimum — no recommendation", () => {
    const gov = new SleeveGovernor();
    gov.register({ sleeve: "gov_29" });
    gov.setEvidenceEpoch("gov_29", Date.now() - 91 * DAY);
    seedMany("gov_29", 29, -5);
    gov.evaluate();
    expect(persistedMode("gov_29")).toBe("live");
    expect(activityCount("gov_29", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("losses older than the evidence epoch don't count", () => {
    const gov = new SleeveGovernor();
    gov.register({ sleeve: "gov_old" });
    gov.setEvidenceEpoch("gov_old", Date.now() - 30 * DAY);
    seedMany("gov_old", 30, -5, { exitTime: Date.now() - 31 * DAY });
    gov.evaluate();
    expect(persistedMode("gov_old")).toBe("live");
    expect(activityCount("gov_old", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("reconciled close_reasons are excluded from the tally", () => {
    const gov = new SleeveGovernor();
    gov.register({ sleeve: "gov_rec" });
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
    expect(persistedMode("gov_rec")).toBe("live");
  });

  test("null-pnl rows are excluded from the tally", () => {
    const gov = new SleeveGovernor();
    gov.register({ sleeve: "gov_null" });
    gov.setEvidenceEpoch("gov_null", Date.now() - 91 * DAY);
    seedMany("gov_null", 30, null);
    gov.evaluate();
    expect(activityCount("gov_null", "RECOMMEND_REDESIGN%")).toBe(0);

    // 30 real losers on top → now it recommends (and still never demotes).
    seedMany("gov_null", 30, -5);
    gov.evaluate();
    expect(activityCount("gov_null", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(persistedMode("gov_null")).toBe("live");
  });

  test("profitable live sleeve: no recommendation", () => {
    const gov = new SleeveGovernor();
    gov.register({ sleeve: "gov_win" });
    gov.setEvidenceEpoch("gov_win", Date.now() - 91 * DAY);
    seedMany("gov_win", 40, +5);
    gov.evaluate();
    expect(persistedMode("gov_win")).toBe("live");
    expect(activityCount("gov_win", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("windowStats uses a rolling 90d window, not lifetime from epoch", () => {
    const gov = new SleeveGovernor();
    const sleeve = "gov_rolling";
    gov.register({ sleeve });
    gov.setEvidenceEpoch(sleeve, Date.now() - 200 * DAY); // mature, well past 90d
    // Outside the 90d window: a lifetime-since-epoch bug would still count
    // these. Rolling must not.
    seedMany(sleeve, 30, -10, { exitTime: Date.now() - 120 * DAY });
    // Inside the 90d window: should be the ONLY trades counted.
    seedMany(sleeve, 30, +5, { exitTime: Date.now() - 10 * DAY });

    gov.evaluate();

    // Lifetime sum would be -150 (recommend). Rolling 90d sum is +150 (quiet).
    expect(persistedMode(sleeve)).toBe("live");
    expect(activityCount(sleeve, "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("maturation guard is preserved: epoch <90d old is never evaluated", () => {
    const gov = new SleeveGovernor();
    const sleeve = "gov_immature";
    gov.register({ sleeve });
    gov.setEvidenceEpoch(sleeve, Date.now() - 10 * DAY);
    seedMany(sleeve, 30, -5, { exitTime: Date.now() - 5 * DAY });
    gov.evaluate();
    expect(persistedMode(sleeve)).toBe("live");
    expect(activityCount(sleeve, "RECOMMEND_REDESIGN%")).toBe(0);
  });
});

describe("SleeveGovernor — judged against the validated expectation band (owner, 2026-10-04)", () => {
  const reading = (status: BandReading["status"], live: number | null = -9.1, p5: number | null = -7.2): BandReading =>
    ({ status, liveCumReturnPct: live, p5Pct: p5, horizonSessions: 40, modelStart: "2026-09-23", reason: status === "insufficient_data" ? "solo 3 sesiones vivas (mínimo 5)" : null });

  function matured(sleeve: string, pnlEach: number, band: (() => Record<string, BandReading>) | undefined) {
    const gov = new SleeveGovernor({ bandReadings: band });
    gov.register({ sleeve });
    gov.setEvidenceEpoch(sleeve, Date.now() - 91 * DAY);
    seedMany(sleeve, 30, pnlEach);
    return gov;
  }

  test("below the band → RECOMMEND_REDESIGN even with a positive 90d P&L, stating the band; nothing else changes", () => {
    const gov = matured("gov_band_below", +5, () => ({ gov_band_below: reading("below") }));
    let event: any = null;
    eventBus.once(EVENTS.CIRCUIT_BREAKER, (e: any) => { event = e; });
    gov.evaluate();
    expect(activityCount("gov_band_below", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(event?.action).toBe("recommend_redesign");
    expect(event?.reason).toContain("below its validated expectation band");
    expect(event?.reason).toContain("p5 -7.20%");
    expect(persistedMode("gov_band_below")).toBe("live");
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
    const gov = new SleeveGovernor({ bandReadings: provider });
    for (const s of ["gov_once_a", "gov_once_b"]) {
      gov.register({ sleeve: s });
      gov.setEvidenceEpoch(s, Date.now() - 91 * DAY);
      seedMany(s, 30, -5);
    }
    gov.register({ sleeve: "gov_once_young" }); // immature: never needs a band
    gov.evaluate();
    expect(calls).toBe(1);

    const idle = new SleeveGovernor({ bandReadings: provider });
    idle.register({ sleeve: "gov_once_idle" });
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

describe("SleeveGovernor — there is no mode: a sleeve can neither be demoted nor promoted (owner rule, shadow mode removed 2026-11-07)", () => {
  test("the API exposes no setMode/getMode/migrateOnce and evaluate() never writes a mode", () => {
    const gov = new SleeveGovernor() as any;
    expect(gov.setMode).toBeUndefined();
    expect(gov.getMode).toBeUndefined();
    expect(gov.migrateOnce).toBeUndefined();
    gov.register({ sleeve: "gov_nomode", evidenceVersion: "v1" });
    gov.setEvidenceEpoch("gov_nomode", Date.now() - 91 * DAY);
    seedMany("gov_nomode", 30, -5);
    gov.evaluate();
    // The persisted row carries the compatibility value 'live' and nothing else; the
    // recommendation never touches it.
    const row = getDB().prepare("SELECT mode FROM sleeve_modes WHERE sleeve = ?").get("gov_nomode") as any;
    expect(row.mode).toBe("live");
    expect(activityCount("gov_nomode", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(activityCount("gov_nomode", "RECOMMEND_PROMOTE%")).toBe(0);
    expect(activityCount("gov_nomode", "SLEEVE DEMOTED%")).toBe(0);
  });

  test("a legacy 'shadow' row in sleeve_modes (restored backup) changes nothing: the sleeve is judged on its own live book", () => {
    const gov = new SleeveGovernor();
    getDB().prepare("INSERT INTO sleeve_modes (sleeve, mode, updated_at, reason) VALUES (?, 'shadow', ?, 'legacy row')").run("gov_legacy_shadow", Date.now());
    gov.register({ sleeve: "gov_legacy_shadow", evidenceVersion: "v1" });
    gov.setEvidenceEpoch("gov_legacy_shadow", Date.now() - 91 * DAY);
    seedMany("gov_legacy_shadow", 30, -5);            // the live book bleeds
    seedMany("shadow_gov_legacy_shadow", 30, +5);     // a stale shadow_ book would have said "promote"
    gov.evaluate();
    expect(activityCount("gov_legacy_shadow", "RECOMMEND_REDESIGN%")).toBe(1);
    expect(activityCount("gov_legacy_shadow", "RECOMMEND_PROMOTE%")).toBe(0);
  });

  test("changing evidenceVersion resets the epoch and excludes legacy rows", () => {
    const gov = new SleeveGovernor();
    gov.register({ sleeve: "gov_version", evidenceVersion: "v1" });
    gov.setEvidenceEpoch("gov_version", Date.now() - 91 * DAY);
    seedMany("gov_version", 30, -5);
    gov.evaluate();
    expect(activityCount("gov_version", "RECOMMEND_REDESIGN%")).toBe(1);

    // New evidence regime: the epoch restarts now, so the sleeve is immature again
    // and the legacy losers are not evidence against the new model.
    getDB().prepare("DELETE FROM activity_log WHERE account_id = ?").run("gov_version");
    gov.register({ sleeve: "gov_version", evidenceVersion: "v2" });
    const meta = getDB().prepare("SELECT evidence_version, evidence_epoch FROM sleeve_modes WHERE sleeve = ?").get("gov_version") as any;
    expect(meta.evidence_version).toBe("v2");
    expect(Date.now() - meta.evidence_epoch).toBeLessThan(60_000);
    gov.evaluate();
    expect(activityCount("gov_version", "RECOMMEND_REDESIGN%")).toBe(0);
  });

  test("getEvidence surfaces the persisted epochs for /healthz/full", () => {
    const gov = new SleeveGovernor();
    gov.register({ sleeve: "gov_surface", evidenceVersion: "v-surface" });
    const row = gov.getEvidence().find(m => m.sleeve === "gov_surface");
    expect(row?.evidenceVersion).toBe("v-surface");
    expect(typeof row?.evidenceEpoch).toBe("number");
    expect(row?.reason).toBe("registered");
    expect(gov.getRegisteredSleeves()).toContain("gov_surface");
  });
});
