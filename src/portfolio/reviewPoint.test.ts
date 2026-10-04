// ══════════════════════════════════════════════
// Review point — the goalpost is EX ANTE and the alert fires ONCE.
//
// Each test here is a revert canary for a specific protection:
//   1. target derives from the DECLARED expected Sharpe, never the observed
//      one (the circularity that made "decide after 8 trades" possible);
//   2. the "time to review" alert is emitted exactly once per
//      (sleeve, policy version) and takes no action;
//   3. progress is well-formed even with zero data — the goalpost exists
//      before the observations do.
// ══════════════════════════════════════════════

import { describe, expect, test, beforeAll } from "bun:test";
import { makeTestDb } from "../test-support/db";
import { getDB } from "../db/database";
import { getReviewTarget, getReviewProgress, checkReviewPoints, type ReviewProgress } from "./reviewPoint";
import { minTrlObservations, normInv, type TrackRecord } from "./trackRecord";
import { ALL_PROFILE_IDS, SLEEVE_POLICY, RISK_PROFILES } from "../config/riskProfiles";

beforeAll(() => {
  makeTestDb();
});

function activityCount(sleeve: string, like: string): number {
  const row = getDB().prepare(
    `SELECT COUNT(*) c FROM activity_log WHERE account_id = ? AND message LIKE ?`
  ).get(sleeve, like) as any;
  return row?.c ?? 0;
}

/** A fabricated observed track record with an absurdly good Sharpe: its
 *  observed-Sharpe MinTRL (obsNeeded) is tiny. If the review target ever
 *  reads observed statistics, the tests below catch it. */
const ABSURD_OBSERVED: TrackRecord = {
  n: 8, meanPerObs: 0.05, sdPerObs: 0.01, skew: 0, kurtosis: 3,
  momentsSource: "estimated", sharpePerObs: 5, sharpeAnnualized: 79,
  psr: 0.9999, srBenchmarkPerObs: 0, confidence: 0.95, obsPerYear: 252,
  minTrlObs: 2, obsNeeded: 2, obsMissing: 0, status: "track_record_sufficient",
};

describe("review target — ex ante, from the DECLARED expected Sharpe", () => {
  test("target equals MinTRL of the declared Sharpe (Gaussian, SR*=0, 95%) for every sleeve", () => {
    for (const id of ALL_PROFILE_IDS) {
      const t = getReviewTarget(id);
      const obsPerYear = RISK_PROFILES[id].broker === "alpaca" ? 252 : 365;
      const srObs = SLEEVE_POLICY[id].review.expectedSharpeAnnualized / Math.sqrt(obsPerYear);
      const expected = Math.ceil(minTrlObservations(srObs, 0, 0, 3, normInv(0.95))!);
      expect(t.obsPerYear).toBe(obsPerYear as 252 | 365);
      expect(t.obsTarget).toBe(expected);
      expect(Number.isFinite(t.obsTarget)).toBe(true);
      // Sanity: daily-Sharpe evidence takes years, not weeks. A target this
      // small would mean someone switched to the observed Sharpe or broke
      // the per-observation conversion.
      expect(t.obsTarget).toBeGreaterThan(100);
    }
  });

  test("REVERT CANARY: an absurd OBSERVED Sharpe (obsNeeded=2 after 8 trades) does not move the target", () => {
    const target = getReviewTarget("momentum_stocks");
    const progress = getReviewProgress("momentum_stocks", ABSURD_OBSERVED);
    // The observed diagnostic says "2 observations suffice" — the declared
    // goalpost must ignore it completely.
    expect(progress.obsTarget).toBe(target.obsTarget);
    expect(progress.obsTarget).not.toBe(ABSURD_OBSERVED.obsNeeded!);
    expect(progress.nObservations).toBe(8);
    expect(progress.reached).toBe(false);
  });
});

describe("review progress — well-formed even with insufficient data", () => {
  test("empty DB: n=0, finite target, not reached, explicit no-action note", () => {
    for (const id of ALL_PROFILE_IDS) {
      const p = getReviewProgress(id); // reads the real (empty) test DB
      expect(p.nObservations).toBe(0);
      expect(Number.isFinite(p.obsTarget)).toBe(true);
      expect(p.reached).toBe(false);
      expect(p.progress).toBe(`0 of ${p.obsTarget} observations`);
      expect(p.note).toContain("does NOT imply retiring or promoting");
    }
  });
});

describe("review alert — exactly once per (sleeve, policy version), no action", () => {
  const reachedStub = (over: Partial<ReviewProgress> = {}) => (id: (typeof ALL_PROFILE_IDS)[number]): ReviewProgress => ({
    ...getReviewProgress(id, ABSURD_OBSERVED),
    nObservations: 9_999,
    reached: true,
    progress: `9999 of X observations`,
    ...over,
  });

  test("reached → one activity row; a second (and third) pass adds nothing", () => {
    checkReviewPoints(["momentum_crypto"], reachedStub());
    expect(activityCount("momentum_crypto", "REVIEW_POINT_REACHED%")).toBe(1);

    // REVERT CANARY: without the persisted once-guard these become 2 and 3.
    checkReviewPoints(["momentum_crypto"], reachedStub());
    checkReviewPoints(["momentum_crypto"], reachedStub());
    expect(activityCount("momentum_crypto", "REVIEW_POINT_REACHED%")).toBe(1);
  });

  test("the alert says 'time to review' and explicitly implies no action", () => {
    const row = getDB().prepare(
      `SELECT message FROM activity_log WHERE account_id = 'momentum_crypto' AND message LIKE 'REVIEW_POINT_REACHED%'`
    ).get() as any;
    expect(row.message).toContain("Time to review");
    expect(row.message).toContain("NO action");
  });

  test("not reached → no alert", () => {
    checkReviewPoints(["momentum_btc"]); // empty DB: n=0, never reached
    expect(activityCount("momentum_btc", "REVIEW_POINT_REACHED%")).toBe(0);
  });

  test("bumping the policy version re-arms the alert (new goalpost, new review)", () => {
    checkReviewPoints(["momentum_crypto"], reachedStub({ version: "v2-test-bump" }));
    expect(activityCount("momentum_crypto", "REVIEW_POINT_REACHED [v2-test-bump]%")).toBe(1);
    expect(activityCount("momentum_crypto", "REVIEW_POINT_REACHED%")).toBe(2); // v1 + v2, one each
  });
});
