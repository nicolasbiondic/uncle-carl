import { describe, expect, test } from "bun:test";
import { CLOSE_5H, CLOSE_GEMINI, CLOSE_WEEK, PANEL_SIZE, PRIMARIES, SUBSTITUTES, familyOf, gate, isKnownModel, parseQuota, type QuotaReport } from "./models";

const acct = (windows: [string, string, number][], error: string | null = null) => ({ error, ventanas: windows.map(([nombre, clase, usado]) => ({ nombre, clase, usado })) });
const report = (over: Partial<QuotaReport> = {}): QuotaReport => ({
  Claude: [acct([["semanal", "semana", 20], ["semanal Fable", "modelo", 10]])],
  Codex: [acct([["5 h", "5h", 10], ["semanal", "semana", 40]])],
  Google: [acct([["Gemini", "semana", 30], ["Claude/GPT-OSS", "modelo", 60]])],
  ...over,
});

// The panel itself is NOT pinned by name: the weekly adjustment (docs/reports/IA-ajustes.md, scripts/improvement-loop.sh ai-review-weekly)
// may replace a model that keeps failing or that the proxy stopped serving, and must be able to release that with the gate green.
// What stays fixed is its SHAPE (below) and every threshold (next test); the weekly guard checks that only PRIMARIES, SUBSTITUTES and
// INFO change in models.ts (src/ai-review/weekly.test.ts, "onlyPanelChanged").
describe("the panel's shape (§3.2)", () => {
  test("three primaries of three different families, at least three substitutes, no model twice, every model's family known", () => {
    expect(PANEL_SIZE).toBe(3);
    expect(PRIMARIES).toHaveLength(PANEL_SIZE);
    expect(new Set(PRIMARIES.map(familyOf)).size).toBe(PANEL_SIZE);
    expect(SUBSTITUTES.length).toBeGreaterThanOrEqual(3);
    expect(new Set([...PRIMARIES, ...SUBSTITUTES]).size).toBe(PRIMARIES.length + SUBSTITUTES.length);
    for (const m of [...PRIMARIES, ...SUBSTITUTES]) expect(isKnownModel(m)).toBe(true);
    // the three primaries failing at once still leaves three families to try (a substitute may be a second model of a primary's family)
    expect(new Set(SUBSTITUTES.map(familyOf)).size).toBeGreaterThanOrEqual(3);
  });
  test("policy thresholds", () => {
    expect([CLOSE_5H, CLOSE_WEEK, CLOSE_GEMINI]).toEqual([80, 85, 90]);
  });
});

describe("the runner's panel", () => {
  test("is the one in models.ts unless the environment names another (only tests do)", async () => {
    const { loadConfig } = await import("./app");
    const cfg = loadConfig({}, "/x");
    expect(cfg.primaries).toEqual(PRIMARIES);
    expect(cfg.substitutes).toEqual(SUBSTITUTES);
    const other = loadConfig({ AI_REVIEW_PRIMARIES: "a/x, b/y", AI_REVIEW_SUBSTITUTES: "" }, "/x");
    expect(other.primaries).toEqual(["a/x", "b/y"]);
    expect(other.substitutes).toEqual(SUBSTITUTES);
  });
});

describe("quota gate", () => {
  test("everything below the thresholds is open", () => {
    for (const m of PRIMARIES) expect(gate(m, report()).open).toBe(true);
  });
  test("a 5 h window at 80 % closes Codex; 79 % does not", () => {
    expect(gate("codex/gpt-6.1-sol", report({ Codex: [acct([["5 h", "5h", 80], ["semanal", "semana", 10]])] })).open).toBe(false);
    expect(gate("codex/gpt-6.1-sol", report({ Codex: [acct([["5 h", "5h", 79], ["semanal", "semana", 10]])] })).open).toBe(true);
  });
  test("a week at 85 % closes Claude; 84 % does not; Fable's own window is not Sonnet's", () => {
    expect(gate("anthropic/claude-sonnet-5-5", report({ Claude: [acct([["semanal", "semana", 85]])] })).open).toBe(false);
    expect(gate("anthropic/claude-sonnet-5-5", report({ Claude: [acct([["semanal", "semana", 84]])] })).open).toBe(true);
    expect(gate("anthropic/claude-sonnet-5-5", report({ Claude: [acct([["semanal", "semana", 10], ["semanal Fable", "modelo", 99]])] })).open).toBe(true);
  });
  test("Gemini closes at 90 % of ITS window, not at 85 and not by the Claude/GPT-OSS group", () => {
    const g = (n: number, other = 10) => report({ Google: [acct([["Gemini", "semana", n], ["Claude/GPT-OSS", "modelo", other]])] });
    expect(gate("antigravity/gemini-3.8-flash-high", g(89)).open).toBe(true);
    expect(gate("antigravity/gemini-3.8-flash-high", g(90)).open).toBe(false);
    expect(gate("antigravity/gemini-3.8-flash-high", g(50, 99)).open).toBe(true);
  });
  test("a pool is open when at least ONE of its accounts is", () => {
    const r = report({ Claude: [acct([["semanal", "semana", 95]]), acct([["semanal", "semana", 30]])] });
    expect(gate("anthropic/claude-sonnet-5-5", r).open).toBe(true);
    const closed = report({ Claude: [acct([["semanal", "semana", 95]]), acct([["semanal", "semana", 88]])] });
    const g = gate("anthropic/claude-sonnet-5-5", closed);
    expect(g.open).toBe(false);
    expect(g.why).toContain("Claude quota closed");
  });
  test("models outside cuotas-ia (the free ones, or an id the table does not know) are open; no report = try anyway and say so", () => {
    expect(gate("opencode/deepseek-v4.1-flash-free", report()).open).toBe(true);
    expect(gate("someone/unknown-model", report()).open).toBe(true);
    const none = gate("anthropic/claude-sonnet-5-5", null);
    expect(none.open).toBe(true);
    expect(none.why).toContain("cuotas-ia unavailable");
    expect(gate("anthropic/claude-sonnet-5-5", report({ Claude: [acct([], "token vencido")] })).why).toContain("tried anyway");
  });
  test("parseQuota reads cuotas-ia --json and rejects anything else", () => {
    const text = JSON.stringify({ generado: "x", pools: { Claude: [{ email: "a@b", error: null, ventanas: [{ nombre: "semanal", clase: "semana", usado: 17, reset: "x" }] }] } });
    expect(parseQuota(text)?.Claude[0].ventanas[0]).toEqual({ nombre: "semanal", clase: "semana", usado: 17 });
    for (const bad of ["", "Cuotas IA\n  Claude", "[]", "{}", "null"]) expect(parseQuota(bad)).toBeNull();
  });
});
