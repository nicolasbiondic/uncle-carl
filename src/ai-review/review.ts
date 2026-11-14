// The panel: three slots, one model each, one after another. A slot whose primary has a closed quota or fails
// is filled by the next unused substitute (§3.2); no two models of the same family in one run; the deadline
// stops new models. Then the quorum (code) makes the Decision. Enforced: src/ai-review/review.test.ts.

import { askModel, type AskOptions } from "./analyst";
import type { CaseFile, Decision, ModelRecord } from "./contract";
import { PANEL_SIZE, familyOf, gate, type QuotaReport } from "./models";
import { buildDecision, MIN_AGREE, type FamilyVerdict } from "./quorum";

export interface ReviewInput extends AskOptions {
  caseFile: CaseFile;
  /** One slot each, in order (the three primaries). */
  primaries: readonly string[];
  /** Ordered replacements, shared by all slots. */
  substitutes: readonly string[];
  /** null = cuotas-ia failed: the primaries are tried anyway and `notes` says so. */
  quota: QuotaReport | null;
  decidedAtMs: number;
  /** `apply` when any sleeve's switch is on (wording of the shipped decision); default `inform`. */
  stage?: Decision["stage"];
}

export interface ReviewResult {
  models: ModelRecord[];
  verdicts: FamilyVerdict[];
  decision: Decision | null;
  notes: string[];
  /** Per model that ran: attempts, seconds, pages opened (for the run record). */
  runs: { model: string; attempts: number; seconds: number; fetchedUrls: string[]; costUsd: number }[];
}

export async function review(i: ReviewInput): Promise<ReviewResult> {
  const models: ModelRecord[] = [];
  const verdicts: FamilyVerdict[] = [];
  const notes: string[] = [];
  const runs: ReviewResult["runs"] = [];
  const usedFamilies = new Set<string>();
  const tried = new Set<string>();
  const queue = [...i.substitutes];
  if (i.quota === null) notes.push("cuotas-ia failed: the primaries were tried without the quota gate");

  const nextSubstitute = (): string | undefined => {
    while (queue.length) {
      const m = queue.shift()!;
      if (!tried.has(m) && !usedFamilies.has(familyOf(m))) return m;
    }
    return undefined;
  };
  const timeUp = () => i.deadlineMs !== null && i.now() >= i.deadlineMs - 30_000;

  slots: for (const primary of i.primaries.slice(0, PANEL_SIZE)) {
    let candidate: string | undefined = primary;
    while (candidate !== undefined) {
      const model: string = candidate;
      tried.add(model);
      const family = familyOf(model);
      if (usedFamilies.has(family)) {
        models.push({ model, family, ok: false, error: "family already in this run", searched: false });
      } else {
        const g = gate(model, i.quota);
        if (!g.open) {
          models.push({ model, family, ok: false, error: g.why, searched: false });
        } else {
          if (timeUp()) {
            models.push({ model, family, ok: false, error: "deadline reached before the model could start", searched: false });
            notes.push("deadline reached: no more models started");
            break slots;
          }
          const r = await askModel(model, i.caseFile, i);
          models.push(r.record);
          runs.push({ model, attempts: r.attempts, seconds: r.seconds, fetchedUrls: r.fetchedUrls, costUsd: r.costUsd });
          if (r.record.ok && r.verdict) {
            usedFamilies.add(family);
            verdicts.push({ family, verdict: r.verdict });
            break;
          }
          i.log?.(`${model} failed (${r.record.error}); next substitute`);
        }
      }
      candidate = nextSubstitute();
    }
  }

  const decision = buildDecision({ caseFile: i.caseFile, verdicts, models, decidedAt: new Date(i.decidedAtMs).toISOString(), stage: i.stage });
  if (!decision) notes.push(`${verdicts.length} valid verdict(s) from distinct families; ${MIN_AGREE} are needed: no decision`);
  return { models, verdicts, decision, notes, runs };
}
