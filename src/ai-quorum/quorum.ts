// Pre-registered quorum rule (§12-D, FIXED): a shadow position exists on a
// symbol iff ≥2 of the 3 models give the SAME non-neutral view AND the mean
// confidence of those agreeing models is ≥ 0.6. Equal weights, held one day.
// This file must stay a pure function of the views — no tuning knobs.

import type { ModelViews, QuorumPosition, View } from "./types";
import { QUORUM_MIN_AGREE, QUORUM_MIN_CONFIDENCE } from "./types";

/**
 * @param viewsByModel one validated ModelViews per model that answered.
 * @param symbols the snapshot universe (a symbol missing from a model's
 *        response was already rejected by validation; defensive here anyway).
 */
export function computeQuorum(
  viewsByModel: ModelViews[],
  symbols: string[],
): QuorumPosition[] {
  const out: QuorumPosition[] = [];
  for (const symbol of symbols) {
    for (const side of ["long", "short"] as View[]) {
      const agreeing = viewsByModel
        .map((m) => m[symbol])
        .filter((v): v is NonNullable<typeof v> => v != null && v.view === side);
      if (agreeing.length < QUORUM_MIN_AGREE) continue;
      const meanConfidence = agreeing.reduce((a, v) => a + v.confidence, 0) / agreeing.length;
      if (meanConfidence < QUORUM_MIN_CONFIDENCE) continue;
      out.push({ symbol, direction: side === "long" ? 1 : -1, meanConfidence });
      break; // a symbol can't be long AND short (≥2 of 3 on both is impossible, but be explicit)
    }
  }
  return out;
}
