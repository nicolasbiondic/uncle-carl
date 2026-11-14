// The panel: three slots, one model each, one after another. A slot whose primary has a closed quota or fails
// is filled by the next unused substitute (§3.2); no two models of the same family in one run; the deadline
// stops new models. Since 2026-11-14 the substitutes may be of a primary's own family (the machine's subscriptions
// hold only the three families of the primaries), so two rules more: a substitute never takes the family of a
// primary that still has its turn (a backup must not displace the primary it backs up), and when fewer than
// MIN_AGREE families answered, the primaries the quota gate stopped are called anyway (the reserve: a closed quota
// keeps what is left "for what has no substitute", and a day without review has none). Then the quorum (code)
// makes the Decision. Enforced: src/ai-review/review.test.ts.

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
  const primaries = i.primaries.slice(0, PANEL_SIZE);
  /** Primaries the quota gate stopped: the reserve pass below may still call them. */
  const gated: string[] = [];
  if (i.quota === null) notes.push("cuotas-ia failed: the primaries were tried without the quota gate");

  /** The next unused substitute whose family is free: it has not answered in this run and it is not the family of a primary that still
   *  has its turn (`reserved`). The ones passed over stay in the queue for a later slot. */
  const nextSubstitute = (reserved: ReadonlySet<string>): string | undefined => {
    const at = queue.findIndex(m => !tried.has(m) && !usedFamilies.has(familyOf(m)) && !reserved.has(familyOf(m)));
    return at === -1 ? undefined : queue.splice(at, 1)[0];
  };
  const timeUp = () => i.deadlineMs !== null && i.now() >= i.deadlineMs - 30_000;

  slots: for (const [slot, primary] of primaries.entries()) {
    const reserved = new Set(primaries.slice(slot + 1).map(familyOf));
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
          if (model === primary) gated.push(model);
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
      candidate = nextSubstitute(reserved);
    }
  }

  // The reserve. The gate closes a quota at 80-90 % so that what is left goes to work that has no substitute (the machine's policy).
  // A day without a review is that work: with fewer than MIN_AGREE families the bot gets no decision at all. So the primaries the gate
  // stopped are called anyway, in order, only until a quorum is possible again. A quota that is truly spent just fails.
  for (const model of gated) {
    if (verdicts.length >= MIN_AGREE || timeUp()) break;
    const family = familyOf(model);
    if (usedFamilies.has(family)) continue;
    const r = await askModel(model, i.caseFile, i);
    const at = models.findIndex(m => m.model === model);
    if (at >= 0) models[at] = r.record; else models.push(r.record);
    runs.push({ model, attempts: r.attempts, seconds: r.seconds, fetchedUrls: r.fetchedUrls, costUsd: r.costUsd });
    notes.push(`quota reserve used for ${model}: fewer than ${MIN_AGREE} families had answered`);
    if (r.record.ok && r.verdict) {
      usedFamilies.add(family);
      verdicts.push({ family, verdict: r.verdict });
    }
  }

  const decision = buildDecision({ caseFile: i.caseFile, verdicts, models, decidedAt: new Date(i.decidedAtMs).toISOString(), stage: i.stage });
  if (!decision) notes.push(`${verdicts.length} valid verdict(s) from distinct families; ${MIN_AGREE} are needed: no decision`);
  return { models, verdicts, decision, notes, runs };
}
