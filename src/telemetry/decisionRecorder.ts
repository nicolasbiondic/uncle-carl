// ═══ DecisionRecorder (P0, 2026-10-09) — funnel telemetry sink ═══
//
// Injected into MomentumEngine / MeanRevEngine (setDecisionRecorder — NOT
// part of the portfolio-plan engine configs, which are parity-locked). At
// the end of every decision pass the engine hands it a DecisionPassSnapshot
// and this writes it to decision_passes (90-day retention).
//
// Contract: PURE telemetry. record() never throws (a DB hiccup must never
// abort a trading pass) and nothing in any decision path reads it back —
// locked by src/telemetry/decisionRecorder.test.ts ("same actions with and
// without a recorder").

import { insertDecisionPass, type DecisionPassSnapshot } from "../db/database";
import { createLogger } from "../utils/logger";

export type { DecisionPassSnapshot };

const log = createLogger("DecisionRecorder");

export interface DecisionRecorder {
  record(snapshot: DecisionPassSnapshot): void;
}

/** Production recorder: persists to the decision_passes table, fail-soft. */
export function createDecisionRecorder(): DecisionRecorder {
  return {
    record(snapshot: DecisionPassSnapshot): void {
      try {
        insertDecisionPass(snapshot);
      } catch (e: any) {
        // warn, not error: telemetry loss must never page or burst.
        log.warn(`decision pass not recorded for ${snapshot.accountId}: ${e?.message ?? e}`);
      }
    },
  };
}
