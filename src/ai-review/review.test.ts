import { describe, expect, test } from "bun:test";
import type { Exec } from "./analyst";
import { isKnownModel, type QuotaReport } from "./models";
import { review } from "./review";
import { caseFile, SESSION } from "./testFixtures";

// The mechanics are tested with a panel of this file's own, never the real one: the real panel (models.ts) changes with the weekly
// adjustment and must be able to change without this file. P: three ids the quota gate knows (their pools). S: three other families
// outside cuotas-ia (an id the table does not know has its prefix as its family and a quota that is always open). B: a second model of
// P[0]'s and of P[1]'s family, on the same quota.
const P = ["anthropic/claude-sonnet-5-5", "codex/gpt-6.1-sol", "antigravity/gemini-3.8-flash-high"];
const S = ["kimi/one", "qwen/one", "deepseek/one"];
const B = ["anthropic/claude-opus-5-5", "codex/gpt-6.1-terra"];
const PRIMARIES = P, SUBSTITUTES = S;

const cf = caseFile();
const ev = (o: unknown) => JSON.stringify(o);
const answer = (symbolActions: Record<string, [string, number]>) =>
  JSON.stringify({ session: SESSION, verdicts: Object.fromEntries(Object.entries(symbolActions).map(([s, [a, c]]) => [s, { action: a, confidence: c, reason: `Motivo ${s}.`, sources: [`https://example.com/${s}/1`] }])) });
const stream = (text: string) => ev({ type: "text", sessionID: "s", part: { text } });
const now = () => Date.parse("2026-11-16T13:15:00Z");

/** model id → what it does: an answer text, "fail", or "bad" (invalid twice). */
function world(behaviour: Record<string, string>) {
  const ran: string[] = [];
  const exec: Exec = async i => {
    if (!ran.includes(i.model)) ran.push(i.model);
    const b = behaviour[i.model] ?? "bad";
    if (b === "fail") return { stdout: ev({ type: "error", error: { message: "boom" } }), stderr: "", code: 1, timedOut: false, seconds: 1 };
    return { stdout: stream(b === "bad" ? "no json" : b), stderr: "", code: 0, timedOut: false, seconds: 1 };
  };
  return { ran, exec };
}
const run = (exec: Exec, quota: QuotaReport | null, extra: Record<string, unknown> = {}) =>
  review({ caseFile: cf, primaries: PRIMARIES, substitutes: SUBSTITUTES, quota, exec, now, deadlineMs: null, modelTimeoutSec: 720, decidedAtMs: now(), ...extra });

const open: QuotaReport = { Claude: [{ error: null, ventanas: [{ nombre: "semanal", clase: "semana", usado: 10 }] }], Codex: [{ error: null, ventanas: [{ nombre: "5 h", clase: "5h", usado: 10 }, { nombre: "semanal", clase: "semana", usado: 10 }] }], Google: [{ error: null, ventanas: [{ nombre: "Gemini", clase: "semana", usado: 10 }] }] };
const closed = (pool: string): QuotaReport => ({ ...open, [pool]: [{ error: null, ventanas: [{ nombre: "semanal", clase: "semana", usado: 95 }, { nombre: "5 h", clase: "5h", usado: 95 }, { nombre: "Gemini", clase: "semana", usado: 99 }] }] });
const NV = answer({ NVDA: ["exit", 0.8] });

describe("the stage of the decision (wording only: the bot acts on its own switch)", () => {
  test("inform by default; apply when the runner says a sleeve's switch is on; the same overrides either way", async () => {
    const w = () => world({ [PRIMARIES[0]]: NV, [PRIMARIES[1]]: NV, [PRIMARIES[2]]: answer({}) });
    const inform = await run(w().exec, open);
    const apply = await run(w().exec, open, { stage: "apply" });
    expect(inform.decision?.stage).toBe("inform");
    expect(apply.decision?.stage).toBe("apply");
    expect(apply.decision?.overrides).toEqual(inform.decision?.overrides);
    expect(apply.decision?.id).not.toBe(inform.decision?.id);
  });
  test("the runner's config reads the same switch as the bot (both strategies apply since 2026-11-14), and the kill switch only ever lowers", async () => {
    const { loadConfig } = await import("./app");
    expect(loadConfig({}, "/x").apply).toEqual({ momentum_stocks: true, meanrev_stocks: true });
    expect(loadConfig({ AI_REVIEW_APPLY: "off" }, "/x").apply).toEqual({ momentum_stocks: false, meanrev_stocks: false });
  });
});

describe("the panel", () => {
  test("three primaries, in order, all valid: no substitute is touched", async () => {
    const w = world({ [PRIMARIES[0]]: NV, [PRIMARIES[1]]: NV, [PRIMARIES[2]]: answer({}) });
    const r = await run(w.exec, open);
    expect(w.ran).toEqual([...PRIMARIES]);
    expect(r.models.every(m => m.ok)).toBe(true);
    expect(r.decision?.overrides.map(o => `${o.symbol}:${o.action}`)).toEqual(["NVDA:exit"]);
  });
  test("a closed quota replaces that primary with the FIRST substitute, without calling it", async () => {
    const w = world({ [PRIMARIES[0]]: NV, [PRIMARIES[1]]: NV, [SUBSTITUTES[0]]: NV });
    const r = await run(w.exec, closed("Google"));
    expect(w.ran).toEqual([PRIMARIES[0], PRIMARIES[1], SUBSTITUTES[0]]);
    const gem = r.models.find(m => m.model === PRIMARIES[2])!;
    expect(gem.ok).toBe(false);
    expect(gem.error).toContain("quota closed");
    expect(r.models.find(m => m.model === SUBSTITUTES[0])?.ok).toBe(true);
  });
  test("two closed quotas take the first two substitutes in order; a failing substitute passes to the next one", async () => {
    const both: QuotaReport = { ...closed("Claude"), Codex: closed("Codex").Codex };
    const w = world({ [PRIMARIES[2]]: NV, [SUBSTITUTES[0]]: "fail", [SUBSTITUTES[1]]: NV, [SUBSTITUTES[2]]: NV });
    const r = await run(w.exec, both);
    // slot 1 (Claude closed): kimi fails, qwen answers; slot 2 (Codex closed): the next unused one, deepseek; slot 3: gemini itself
    expect(w.ran).toEqual([SUBSTITUTES[0], SUBSTITUTES[1], SUBSTITUTES[2], PRIMARIES[2]]);
    expect(r.verdicts.map(v => v.family)).toEqual(["qwen", "deepseek", "gemini"]);
  });
  test("a primary that FAILS (not just closed) is replaced too, and the substitute is the next UNUSED one", async () => {
    const w = world({ [PRIMARIES[0]]: "fail", [PRIMARIES[1]]: "bad", [PRIMARIES[2]]: NV, [SUBSTITUTES[0]]: NV, [SUBSTITUTES[1]]: NV });
    const r = await run(w.exec, open);
    expect(w.ran).toEqual([PRIMARIES[0], SUBSTITUTES[0], PRIMARIES[1], SUBSTITUTES[1], PRIMARIES[2]]);
    expect(r.verdicts.map(v => v.family)).toEqual(["kimi", "qwen", "gemini"]);
  });
  test("no two models of the same family in one run", async () => {
    const w = world({ [PRIMARIES[0]]: NV, "anthropic/claude-haiku-5-5": NV, [PRIMARIES[1]]: NV });
    const r = await run(w.exec, open, { primaries: [PRIMARIES[0], "anthropic/claude-haiku-5-5", PRIMARIES[1]] });
    expect(w.ran).not.toContain("anthropic/claude-haiku-5-5"); // never called: its family already answered
    expect(r.verdicts.map(v => v.family)).toEqual(["claude", "gpt"]);
    expect(r.models.find(m => m.model === "anthropic/claude-haiku-5-5")?.error).toContain("family already");
  });
  test("cuotas-ia failing (null): the primaries are tried anyway and the notes say so", async () => {
    const w = world({ [PRIMARIES[0]]: NV, [PRIMARIES[1]]: NV, [PRIMARIES[2]]: NV });
    const r = await run(w.exec, null);
    expect(w.ran).toEqual([...PRIMARIES]);
    expect(r.notes.join(" ")).toContain("cuotas-ia failed");
  });
});

describe("substitutes of a primary's own family (the machine's subscriptions hold only the primaries' three families)", () => {
  const mine = { substitutes: [...B, S[2]] };   // a second claude, a second gpt, then another family

  test("the ids these tests borrow are in the models table (their family and quota come from it)", () => {
    for (const m of [...P, ...B]) expect(isKnownModel(m)).toBe(true);
  });
  test("a primary that fails as a model is replaced by the backup of ITS family, which takes its seat", async () => {
    const w = world({ [P[0]]: "fail", [B[0]]: NV, [P[1]]: NV, [P[2]]: NV });
    const r = await run(w.exec, open, mine);
    expect(w.ran).toEqual([P[0], B[0], P[1], P[2]]);
    expect(r.verdicts.map(v => v.family)).toEqual(["claude", "gpt", "gemini"]);
  });
  test("a backup never takes the seat of a primary that still has its turn: the gpt backup is passed over in slot 1 and kept for slot 2", async () => {
    // slot 1: claude and its backup fail → the gpt backup is NOT called (gpt's own primary comes next) → the other family answers
    const w = world({ [P[0]]: "fail", [B[0]]: "fail", [S[2]]: NV, [P[1]]: "fail", [B[1]]: NV, [P[2]]: NV });
    const r = await run(w.exec, open, mine);
    expect(w.ran).toEqual([P[0], B[0], S[2], P[1], B[1], P[2]]);
    expect(r.verdicts.map(v => v.family)).toEqual(["deepseek", "gpt", "gemini"]);
    // with gpt's primary healthy its backup is never called at all
    const healthy = world({ [P[0]]: "fail", [B[0]]: "fail", [S[2]]: NV, [P[1]]: NV, [P[2]]: NV });
    await run(healthy.exec, open, mine);
    expect(healthy.ran).toEqual([P[0], B[0], S[2], P[1], P[2]]);
  });
  test("a closed quota closes the backup on that quota too: neither is called, another family takes the seat", async () => {
    const w = world({ [P[0]]: NV, [B[0]]: NV, [S[2]]: NV, [P[1]]: NV, [P[2]]: NV });
    const r = await run(w.exec, closed("Claude"), mine);
    expect(w.ran).toEqual([S[2], P[1], P[2]]);
    expect(r.models.filter(m => m.family === "claude").map(m => [m.model, m.ok, m.error?.includes("quota closed")])).toEqual([[P[0], false, true], [B[0], false, true]]);
    expect(r.notes.join(" ")).not.toContain("reserve");
  });
});

describe("the reserve: a closed quota is spent rather than leaving the day without a review", () => {
  const backups = { substitutes: [...B] };       // no other family to turn to
  const two: QuotaReport = { ...closed("Claude"), Codex: closed("Codex").Codex };
  const three: QuotaReport = { ...two, Google: closed("Google").Google };

  test("two quotas closed and one family answered: the stopped primaries are called anyway, in order, only until two families have answered", async () => {
    const w = world({ [P[0]]: NV, [P[1]]: NV, [P[2]]: NV, [B[0]]: NV, [B[1]]: NV });
    const r = await run(w.exec, two, backups);
    expect(w.ran).toEqual([P[2], P[0]]);                              // gemini in its slot, then claude from the reserve; gpt is not needed
    expect(r.verdicts.map(v => v.family)).toEqual(["gemini", "claude"]);
    expect(r.decision?.overrides.map(o => `${o.symbol}:${o.action}`)).toEqual(["NVDA:exit"]);
    expect(r.notes.join(" ")).toContain(`quota reserve used for ${P[0]}`);
    expect(r.models.find(m => m.model === P[0])).toMatchObject({ ok: true });                      // one record per model: the answer replaces "quota closed"
    expect(r.models.filter(m => m.model === P[0])).toHaveLength(1);
    expect(r.models.find(m => m.model === P[1])).toMatchObject({ ok: false });
    expect(r.models.find(m => m.model === P[1])!.error).toContain("quota closed");
  });
  test("one quota closed and two families answered: the reserve is not touched", async () => {
    const w = world({ [P[0]]: NV, [P[1]]: NV, [P[2]]: NV, [B[0]]: NV });
    const r = await run(w.exec, closed("Claude"), backups);
    expect(w.ran).toEqual([P[1], P[2]]);
    expect(r.notes.join(" ")).not.toContain("reserve");
    expect(r.models.find(m => m.model === P[0])!.error).toContain("quota closed");
  });
  test("a reserve call that fails (a quota that is truly spent) passes to the next stopped primary", async () => {
    const w = world({ [P[0]]: "fail", [P[1]]: NV, [P[2]]: NV });
    const r = await run(w.exec, two, backups);
    expect(w.ran).toEqual([P[2], P[0], P[1]]);
    expect(r.verdicts.map(v => v.family)).toEqual(["gemini", "gpt"]);
    expect(r.models.find(m => m.model === P[0])).toMatchObject({ ok: false });
  });
  test("all three quotas closed: the reserve is what gives the day its review (two families, the third is left alone)", async () => {
    const w = world({ [P[0]]: NV, [P[1]]: NV, [P[2]]: NV });
    const r = await run(w.exec, three, backups);
    expect(w.ran).toEqual([P[0], P[1]]);
    expect(r.decision).not.toBeNull();
  });
  test("only the backups are never called from the reserve, and a family that already answered is not asked twice", async () => {
    // claude is closed; its seat is taken by another family; gpt closed too: one family answered plus the substitute → two, no reserve
    const w = world({ [S[2]]: NV, [P[0]]: NV, [P[1]]: NV, [P[2]]: NV, [B[0]]: NV, [B[1]]: NV });
    const r = await run(w.exec, two, { substitutes: [...B, S[2]] });
    expect(w.ran).toEqual([S[2], P[2]]);
    expect(r.notes.join(" ")).not.toContain("reserve");
  });
  test("past the deadline the reserve is not spent", async () => {
    let t = now();
    const w = world({ [P[0]]: NV, [P[1]]: NV, [P[2]]: NV });
    const slow: Exec = async i => { const r = await w.exec(i); t += 20 * 60_000; return r; };
    const r = await review({ caseFile: cf, primaries: P, substitutes: [...B], quota: two, exec: slow, now: () => t, deadlineMs: now() + 15 * 60_000, modelTimeoutSec: 720, decidedAtMs: t });
    expect(w.ran).toEqual([P[2]]);
    expect(r.decision).toBeNull();
  });
});

describe("what ships", () => {
  test("fewer than two valid verdicts from distinct families: NO decision", async () => {
    const w = world({ [PRIMARIES[0]]: NV }); // everything else fails or is invalid
    const r = await run(w.exec, open);
    expect(r.verdicts).toHaveLength(1);
    expect(r.decision).toBeNull();
    expect(r.notes.join(" ")).toContain("no decision");
  });
  test("exactly two valid verdicts are enough", async () => {
    const w = world({ [PRIMARIES[0]]: NV, [PRIMARIES[1]]: NV });
    const r = await run(w.exec, open);
    expect(r.verdicts).toHaveLength(2);
    expect(r.decision?.overrides).toHaveLength(1);
  });
  test("a malformed answer never reaches the quorum, whatever it says", async () => {
    const poison = `{"session":"${SESSION}","verdicts":{"NVDA":{"action":"short","confidence":1,"reason":"x"}}}`; // no source
    const w = world({ [PRIMARIES[0]]: poison, [PRIMARIES[1]]: poison, [PRIMARIES[2]]: answer({}) });
    const r = await run(w.exec, open);
    expect(r.verdicts.map(v => v.family)).not.toContain("claude");
    expect(r.decision?.overrides ?? []).toEqual([]);
  });
  test("two models that agree on nothing give an empty decision, which still exists", async () => {
    const w = world({ [PRIMARIES[0]]: answer({}), [PRIMARIES[1]]: answer({}) });
    const r = await run(w.exec, open);
    expect(r.decision).not.toBeNull();
    expect(r.decision!.overrides).toEqual([]);
  });
  test("past the deadline no new model starts, and what is valid by then ships", async () => {
    let t = now();
    const w = world({ [PRIMARIES[0]]: NV, [PRIMARIES[1]]: NV, [PRIMARIES[2]]: NV });
    const slow: Exec = async i => { const r = await w.exec(i); t += 20 * 60_000; return r; };
    const r = await review({ caseFile: cf, primaries: PRIMARIES, substitutes: SUBSTITUTES, quota: open, exec: slow, now: () => t, deadlineMs: now() + 25 * 60_000, modelTimeoutSec: 720, decidedAtMs: t });
    expect(w.ran).toEqual([PRIMARIES[0], PRIMARIES[1]]);
    expect(r.notes.join(" ")).toContain("deadline");
    expect(r.decision?.overrides).toHaveLength(1); // two agreeing verdicts still ship
  });
});
