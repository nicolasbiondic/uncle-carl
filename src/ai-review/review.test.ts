import { describe, expect, test } from "bun:test";
import type { Exec } from "./analyst";
import { PRIMARIES, SUBSTITUTES, type QuotaReport } from "./models";
import { review } from "./review";
import { caseFile, SESSION } from "./testFixtures";

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
  test("the runner's config reads the same switch as the bot: both strategies inform in what is delivered, and the kill switch only ever lowers", async () => {
    const { loadConfig } = await import("./app");
    expect(loadConfig({}, "/x").apply).toEqual({ momentum_stocks: false, meanrev_stocks: false });
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
