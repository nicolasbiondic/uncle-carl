// The decision the bot will act on in stage B (built and tested now; nothing reads it for orders yet).
// loadActiveDecision never trusts a file: every file in the inbox is validated again, its limits are
// re-applied and its numbers clamped, and a corrupt, future-dated, oversized or expired file is
// ignored, never thrown. A valid decision with NO overrides is a decision: it lifts earlier ones.
// Enforced: src/ai-review/active.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REASON_MAX_CHARS, isDateKey, parseDecision, type Decision, type Override } from "./contract";
import { sessionsBetween as calendarSessionsBetween } from "./calendar";
import { FACTOR, MAX_AGE_SESSIONS, MAX_SOURCES, capOverrides } from "./limits";
import { MIN_AGREE, MIN_CONFIDENCE, SEVERITY } from "./quorum";

/** A real decision is a few KB (at most 9 overrides); anything bigger is not ours. */
export const MAX_DECISION_BYTES = 64 * 1024;

const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** What the votes of an override can still justify under §3.3; null when they justify nothing. */
function reclamp(o: Override): Override | null {
  const byFamily = new Map<string, Override["votes"][number]>();
  for (const v of o.votes) {
    const prev = byFamily.get(v.family);
    if (!prev || v.confidence > prev.confidence) byFamily.set(v.family, v);
  }
  const votes = [...byFamily.values()];
  if (votes.length < MIN_AGREE) return null;
  const mean = round9(votes.reduce((s, v) => s + v.confidence, 0) / votes.length);
  if (mean < MIN_CONFIDENCE) return null;
  const sorted = [...votes].sort((a, b) => SEVERITY[a.action] - SEVERITY[b.action]);
  let justified = sorted[0].action;
  if (justified === "short" && votes.filter(v => v.action === "short").length < MIN_AGREE) {
    const mild = sorted.find(v => v.action !== "short");
    if (!mild) return null;
    justified = mild.action;
  }
  // Never stronger than the file says, never stronger than its votes justify.
  const action = SEVERITY[justified] < SEVERITY[o.action] ? justified : o.action;
  const sources = [...new Set(o.sources)].slice(0, MAX_SOURCES);
  const reason = o.reason.trim().slice(0, REASON_MAX_CHARS);
  if (sources.length === 0 || !reason) return null;
  return { ...o, action, factor: FACTOR[action], meanConfidence: mean, votes, reason, sources };
}

/** Re-apply the pre-registered limits to a decision read from disk. */
export function clampDecision(d: Decision): Decision {
  const seen = new Set<string>();
  const sane: Override[] = [];
  for (const o of d.overrides) {
    const key = `${o.sleeve}:${o.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = reclamp(o);
    if (c) sane.push(c);
  }
  return { ...d, overrides: capOverrides(sane).kept };
}

export interface ActiveInput {
  dir: string;
  /** The NYSE session the bot is deciding for. */
  session: string;
  /** NYSE sessions in (from, to]; the repo's calendar by default, injectable for tests. */
  sessionsBetween?: (from: string, to: string) => number;
}

/** The newest valid decision whose session ≤ `session` and is at most MAX_AGE_SESSIONS sessions old, else null. */
export function loadActiveDecision(input: ActiveInput): Decision | null {
  const between = input.sessionsBetween ?? calendarSessionsBetween;
  if (!isDateKey(input.session)) return null;
  let names: string[];
  try { names = readdirSync(input.dir); } catch { return null; }
  let best: Decision | null = null;
  for (const name of names.sort()) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m || !isDateKey(m[1]) || m[1] > input.session) continue;
    let parsed: Decision;
    try {
      const path = join(input.dir, name);
      if (statSync(path).size > MAX_DECISION_BYTES) continue;
      const r = parseDecision(JSON.parse(readFileSync(path, "utf8")));
      if (!r.ok) continue;
      parsed = r.value;
    } catch { continue; }
    if (parsed.session !== m[1] || parsed.session > input.session) continue;
    if (between(parsed.session, input.session) > MAX_AGE_SESSIONS) continue;
    if (!best || parsed.session > best.session || (parsed.session === best.session && parsed.decidedAt > best.decidedAt)) best = parsed;
  }
  return best ? clampDecision(best) : null;
}
