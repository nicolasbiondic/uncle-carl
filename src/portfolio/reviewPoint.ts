// ══════════════════════════════════════════════
// Evidence review point — EX-ANTE observation targets per sleeve
//
// The error this module exists to prevent: judging a sleeve on its P&L
// after 8 trades. The correction is a goalpost fixed IN ADVANCE:
//
//   obsTarget = MinTRL (Bailey & López de Prado, 95%, SR* = 0) of the
//   EXPECTED Sharpe declared in SLEEVE_POLICY (riskProfiles.ts) —
//   never of the observed Sharpe, which moves with every observation
//   and would make the goalpost circular (trackRecord.ts's obsNeeded is
//   exactly that observed-Sharpe quantity; useful as a live diagnostic,
//   useless as a stable target).
//
// Ex-ante assumptions (documented, deliberate): Gaussian moments (skew 0,
// kurtosis 3) — before the data exists there are no higher moments to
// plug in; the observed-moment refinement lives in trackRecord.ts and is
// a diagnostic, not the target. Grid (252 trading / 365 calendar obs per
// year) derives from the sleeve's broker, matching sleeveReturns.ts.
//
// Reaching the review point does NOT imply retiring or promoting the
// sleeve. It means one thing only: there is now enough data to decide.
// The one-time alert below says "time to review" and takes no action.
// ══════════════════════════════════════════════

import { getDB, insertActivity } from "../db/database";
import { createLogger } from "../utils/logger";
import { ALL_PROFILE_IDS, RISK_PROFILES, SLEEVE_POLICY, type RiskProfileId } from "../config/riskProfiles";
import { minTrlObservations, normInv, getSleeveTrackRecord, type TrackRecord } from "./trackRecord";

const log = createLogger("ReviewPoint");

const CONFIDENCE = 0.95;

export interface ReviewTarget {
  profileId: string;
  /** Declared EXPECTED annualized Sharpe (see SLEEVE_POLICY provenance). */
  expectedSharpeAnnualized: number;
  /** Grid-consistent annualization (alpaca → 252 trading days, binance* → 365). */
  obsPerYear: 252 | 365;
  confidence: number;
  /** The review point: observations needed for the EXPECTED Sharpe to clear
   *  SR*=0 at `confidence`. Stable — depends only on declared policy. */
  obsTarget: number;
  /** Policy version — bumping it in SLEEVE_POLICY re-arms the alert. */
  version: string;
  provenance: string;
  declaredAt: string;
}

export interface ReviewProgress extends ReviewTarget {
  /** Valid daily-return observations accumulated so far (trackRecord n). */
  nObservations: number;
  reached: boolean;
  /** "N of M" human-readable progress. */
  progress: string;
  /** The contract, spelled out where every consumer sees it. */
  note: string;
}

const NOTE =
  "Reaching the review point does NOT imply retiring or promoting — it means there is now enough data to decide. Target derives from the DECLARED expected Sharpe (SLEEVE_POLICY), never the observed one.";

/** Pure: computed from declared policy only. No DB, no observed data. */
export function getReviewTarget(profileId: RiskProfileId): ReviewTarget {
  const policy = SLEEVE_POLICY[profileId].review;
  const obsPerYear: 252 | 365 = RISK_PROFILES[profileId].broker === "alpaca" ? 252 : 365;
  const srPerObs = policy.expectedSharpeAnnualized / Math.sqrt(obsPerYear);
  // Gaussian ex-ante moments; srPerObs > 0 by declaration, so minTrl is finite.
  const minTrl = minTrlObservations(srPerObs, 0, 0, 3, normInv(CONFIDENCE));
  if (minTrl == null) throw new Error(`review target undefined for ${profileId}: declared expected Sharpe must be > 0`);
  return {
    profileId,
    expectedSharpeAnnualized: policy.expectedSharpeAnnualized,
    obsPerYear,
    confidence: CONFIDENCE,
    obsTarget: Math.ceil(minTrl),
    version: policy.version,
    provenance: policy.provenance,
    declaredAt: policy.declaredAt,
  };
}

/**
 * Progress toward the review point. `tr` (the sleeve's live track record) is
 * only used for its observation COUNT — the target never reads observed
 * statistics. Passing `tr` avoids a second DB read when the caller already
 * computed it; omitted, it is fetched here. Works with zero/insufficient
 * data: target stays finite, n is just small.
 */
export function getReviewProgress(profileId: RiskProfileId, tr?: TrackRecord): ReviewProgress {
  const target = getReviewTarget(profileId);
  const n = (tr ?? getSleeveTrackRecord(profileId).trackRecord).n;
  return {
    ...target,
    nObservations: n,
    reached: n >= target.obsTarget,
    progress: `${n} of ${target.obsTarget} observations`,
    note: NOTE,
  };
}

function alertAlreadySent(profileId: string, version: string): boolean {
  try {
    const row = getDB().prepare(
      `SELECT 1 FROM activity_log WHERE account_id = ? AND message LIKE ? LIMIT 1`
    ).get(profileId, `REVIEW_POINT_REACHED [${version}]%`);
    return !!row;
  } catch (e: any) {
    // Fail closed for alert spam: if we can't check, don't emit.
    log.warn(`review-alert dedupe check failed for ${profileId}: ${e?.message ?? e}`);
    return true;
  }
}

/**
 * One-time "time to review" alert per (sleeve, policy version). Persisted in
 * activity_log, so it survives restarts. Takes NO action — no mode change,
 * no pause, nothing: the alert's entire meaning is "the ex-ante evidence
 * threshold declared before the data arrived has now been met; a human can
 * decide on data instead of noise". Called daily by SleeveGovernor's
 * evaluation loop. `progressFor` is injectable for tests.
 */
export function checkReviewPoints(
  profiles: RiskProfileId[] = ALL_PROFILE_IDS,
  progressFor: (id: RiskProfileId) => ReviewProgress = getReviewProgress,
): void {
  for (const id of profiles) {
    let p: ReviewProgress;
    try {
      p = progressFor(id);
    } catch (e: any) {
      log.warn(`review progress unavailable for ${id}: ${e?.message ?? e}`);
      continue;
    }
    if (!p.reached) continue;
    if (alertAlreadySent(id, p.version)) continue;
    const msg =
      `REVIEW_POINT_REACHED [${p.version}] ${id}: ${p.progress} ` +
      `(target = MinTRL of DECLARED expected Sharpe ${p.expectedSharpeAnnualized} @ ${p.confidence * 100}%, declared ${p.declaredAt}). ` +
      `Time to review — this implies NO action by itself.`;
    insertActivity(id, "system", msg);
    log.warn(`📋 ${msg}`);
  }
}
