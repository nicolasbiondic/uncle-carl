import { describe, expect, test } from "bun:test";
import { decisionId, extractJsonText, parseCaseFile, parseDecision, parseModelVerdict, sealDecision, universeOf, countSymbols } from "./contract";
import { baseDecision, caseFile, sym } from "./testFixtures";

const cf = caseFile();
const ok = (o: unknown) => JSON.stringify({ session: "2026-11-16", verdicts: o });
const good = { NVDA: { action: "exit", confidence: 0.8, reason: "El director fue destituido.", sources: ["https://reuters.com/a"] } };

describe("CaseFile validation", () => {
  test("the fixture and a JSON round trip are valid", () => {
    expect(parseCaseFile(cf).ok).toBe(true);
    expect(parseCaseFile(JSON.parse(JSON.stringify(cf))).ok).toBe(true);
    expect(countSymbols(cf)).toBe(43);
    expect(universeOf(cf).momentum_stocks).toContain("NVDA");
  });
  test("rejects a bad session, a duplicate symbol, a non-http source link and a null lastClose", () => {
    expect(parseCaseFile({ ...cf, session: "16/11/2026" }).ok).toBe(false);
    const dup = caseFile(); dup.sleeves[0].symbols.push(sym("NVDA"));
    expect(parseCaseFile(dup).ok).toBe(false);
    const badUrl = caseFile(); badUrl.sleeves[0].symbols[0].news[0].url = "javascript:alert(1)";
    expect(parseCaseFile(badUrl).ok).toBe(false);
    const noClose = caseFile(); (noClose.sleeves[0].symbols[0] as any).lastClose = null;
    expect(parseCaseFile(noClose).ok).toBe(false);
  });
  test("warnings are optional strings", () => {
    expect(parseCaseFile({ ...cf, warnings: ["pre-market unavailable"] }).ok).toBe(true);
    expect(parseCaseFile({ ...cf, warnings: [1] }).ok).toBe(false);
  });
});

describe("ModelVerdict validation", () => {
  test("a clean verdict passes; a symbol left out is simply absent (= keep)", () => {
    const r = parseModelVerdict(ok(good), cf);
    expect(r.ok && r.value.verdicts.NVDA.action).toBe("exit");
    expect(r.ok && Object.keys(r.value.verdicts)).toEqual(["NVDA"]);
    expect(parseModelVerdict(ok({}), cf).ok).toBe(true);
  });
  test("strips ```json fences and tolerates a sentence around the JSON", () => {
    expect(parseModelVerdict("```json\n" + ok(good) + "\n```", cf).ok).toBe(true);
    expect(parseModelVerdict("Aquí está:\n" + ok(good), cf).ok).toBe(true);
    expect(extractJsonText("```\n{}\n```")).toBe("{}");
  });
  test("rejects the whole verdict: wrong session, a symbol not in the case file, an unknown action", () => {
    expect(parseModelVerdict(JSON.stringify({ session: "2026-11-17", verdicts: {} }), cf).ok).toBe(false);
    expect(parseModelVerdict(ok({ ZZZZ: good.NVDA }), cf).ok).toBe(false);
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, action: "sell" } }), cf).ok).toBe(false);
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, action: "EXIT" } }), cf).ok).toBe(false);
  });
  test("rejects confidence outside [0,1] or not a number", () => {
    for (const c of [1.01, -0.1, "0.8", null, NaN]) {
      expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, confidence: c } }), cf).ok).toBe(false);
    }
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, confidence: 0 } }), cf).ok).toBe(true);
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, confidence: 1 } }), cf).ok).toBe(true);
  });
  test("a non-keep needs a source (http or https) and a reason of at most 240 characters", () => {
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, sources: [] } }), cf).ok).toBe(false);
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, sources: ["ftp://x/y"] } }), cf).ok).toBe(false);
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, sources: ["no es un enlace"] } }), cf).ok).toBe(false);
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, reason: "x".repeat(241) } }), cf).ok).toBe(false);
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, reason: "x".repeat(240) } }), cf).ok).toBe(true);
    expect(parseModelVerdict(ok({ NVDA: { ...good.NVDA, reason: "" } }), cf).ok).toBe(false);
    // a keep needs neither
    expect(parseModelVerdict(ok({ NVDA: { action: "keep", confidence: 0.9 } }), cf).ok).toBe(true);
  });
  test("extra top-level keys: a string is tolerated, any other type rejects", () => {
    expect(parseModelVerdict(JSON.stringify({ session: "2026-11-16", verdicts: {}, notes: "nada" }), cf).ok).toBe(true);
    expect(parseModelVerdict(JSON.stringify({ session: "2026-11-16", verdicts: {}, extra: { a: 1 } }), cf).ok).toBe(false);
    expect(parseModelVerdict(JSON.stringify({ session: "2026-11-16", verdicts: [] }), cf).ok).toBe(false);
  });
  test("garbage is an error, not a throw", () => {
    for (const raw of ["", "no json", "[1,2]", "{", "null"]) expect(parseModelVerdict(raw, cf).ok).toBe(false);
  });
});

describe("Decision", () => {
  const override = { sleeve: "momentum_stocks" as const, symbol: "NVDA", action: "exit" as const, factor: 0, meanConfidence: 0.8, votes: [{ family: "claude", action: "exit" as const, confidence: 0.8 }, { family: "gpt", action: "exit" as const, confidence: 0.8 }], reason: "Motivo.", sources: ["https://a.com/x"] };
  test("id = first 12 hex of the sha256 of the canonical content, independent of key order", () => {
    const d = sealDecision(baseDecision({ overrides: [override] }));
    expect(d.id).toMatch(/^[0-9a-f]{12}$/);
    const { id, ...rest } = d;
    const shuffled = Object.fromEntries(Object.entries(rest).reverse()) as any;
    expect(decisionId(shuffled)).toBe(id);
    expect(decisionId({ ...rest, reviewed: 44 })).not.toBe(id);
  });
  test("a sealed decision parses; any change after sealing is refused", () => {
    const d = sealDecision(baseDecision({ overrides: [override] }));
    expect(parseDecision(JSON.parse(JSON.stringify(d))).ok).toBe(true);
    expect(parseDecision({ ...d, reviewed: 99 }).ok).toBe(false);
    expect(parseDecision({ ...d, stage: "apply" }).ok).toBe(false);
    expect(parseDecision({ ...d, overrides: [{ ...override, action: "nuke" }] }).ok).toBe(false);
    expect(parseDecision("nope").ok).toBe(false);
  });
  test("an empty decision (no overrides) is valid", () => {
    expect(parseDecision(sealDecision(baseDecision())).ok).toBe(true);
  });
});
