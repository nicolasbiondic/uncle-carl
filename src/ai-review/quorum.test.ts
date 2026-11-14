import { describe, expect, test } from "bun:test";
import { universeOf } from "./contract";
import { MAX_NAMES, MAX_AGE_SESSIONS, FACTOR } from "./limits";
import { MIN_AGREE, MIN_CONFIDENCE, SEVERITY, buildDecision, computeOverrides, decideSymbol } from "./quorum";
import { baseDecision, caseFile, v, verdict } from "./testFixtures";

const vote = (family: string, action: any, confidence: number, extra: any = {}) => ({ family, action, confidence, reason: `Razón de ${family}.`, sources: [`https://${family}.com/a`], ...extra });

describe("pre-registered constants (§3.3, §3.4)", () => {
  test("they are what the document says", () => {
    expect(MIN_AGREE).toBe(2);
    expect(MIN_CONFIDENCE).toBe(0.6);
    expect(SEVERITY).toEqual({ keep: 0, reduce: 1, exit: 2, short: 3 });
    expect(FACTOR).toEqual({ reduce: 0.5, exit: 0, short: 0 });
    expect(MAX_NAMES).toEqual({ momentum_stocks: 3, meanrev_stocks: 6 });
    expect(MAX_AGE_SESSIONS).toBe(5);
  });
});

describe("decideSymbol: the quorum table", () => {
  test("2 of 3 distinct families asking reduce or more, mean confidence ≥ 0.6, acts", () => {
    const d = decideSymbol([vote("claude", "exit", 0.8), vote("gpt", "exit", 0.8), vote("gemini", "keep", 0.9)]);
    expect(d?.action).toBe("exit");
    expect(d?.votes.map(x => x.family)).toEqual(["claude", "gpt"]);
  });
  test("one model alone never acts, however sure", () => {
    expect(decideSymbol([vote("claude", "exit", 1), vote("gpt", "keep", 0.9), vote("gemini", "keep", 0.9)])).toBeNull();
  });
  test("two verdicts of the SAME family are one family: no quorum", () => {
    expect(decideSymbol([vote("claude", "exit", 0.9), vote("claude", "exit", 0.9)])).toBeNull();
  });
  test("mean confidence 0.59 does not act, 0.60 does (the boundary is inclusive)", () => {
    expect(decideSymbol([vote("claude", "reduce", 0.59), vote("gpt", "reduce", 0.59)])).toBeNull();
    expect(decideSymbol([vote("claude", "reduce", 0.6), vote("gpt", "reduce", 0.6)])?.action).toBe("reduce");
    expect(decideSymbol([vote("claude", "reduce", 0.5), vote("gpt", "reduce", 0.7)])?.action).toBe("reduce"); // float: (0.5+0.7)/2
    expect(decideSymbol([vote("claude", "reduce", 0.55), vote("gpt", "reduce", 0.64)])).toBeNull(); // 0.595
    expect(decideSymbol([vote("claude", "reduce", 0.9), vote("gpt", "reduce", 0.3), vote("gemini", "reduce", 0.6)])?.meanConfidence).toBe(0.6);
  });
  test("the mildest of the agreeing actions applies", () => {
    expect(decideSymbol([vote("claude", "exit", 0.9), vote("gpt", "reduce", 0.9)])?.action).toBe("reduce");
    expect(decideSymbol([vote("claude", "exit", 0.9), vote("gpt", "exit", 0.9), vote("gemini", "reduce", 0.9)])?.action).toBe("reduce");
    expect(decideSymbol([vote("claude", "short", 0.9), vote("gpt", "exit", 0.9)])?.action).toBe("exit");
  });
  test("short needs two short votes; otherwise it degrades to the mildest agreeing action", () => {
    expect(decideSymbol([vote("claude", "short", 0.9), vote("gpt", "short", 0.9)])?.action).toBe("short");
    expect(decideSymbol([vote("claude", "short", 0.9), vote("gpt", "short", 0.9), vote("gemini", "exit", 0.9)])?.action).toBe("exit");
    expect(decideSymbol([vote("claude", "short", 0.9), vote("gpt", "reduce", 0.9)])?.action).toBe("reduce");
    expect(decideSymbol([vote("claude", "short", 0.9), vote("gpt", "keep", 0.9)])).toBeNull();
  });
  test("reason = the agreeing model with the highest confidence; sources = their union, deduplicated, at most 6", () => {
    const d = decideSymbol([
      vote("claude", "exit", 0.7, { reason: "Razón claude.", sources: ["https://a.com/1", "https://shared.com/x", "https://a.com/2"] }),
      vote("gpt", "exit", 0.9, { reason: "Razón gpt.", sources: ["https://shared.com/x", "https://g.com/1", "https://g.com/2", "https://g.com/3"] }),
      vote("gemini", "exit", 0.8, { reason: "Razón gemini.", sources: ["https://gem.com/1", "https://gem.com/2"] }),
    ])!;
    expect(d.reason).toBe("Razón gpt.");
    expect(d.sources).toHaveLength(6);
    expect(new Set(d.sources).size).toBe(6);
    expect(d.sources[0]).toBe("https://shared.com/x"); // the most confident model's links come first
  });
  test("a tie on confidence picks the reason deterministically (family order)", () => {
    expect(decideSymbol([vote("gpt", "exit", 0.8), vote("claude", "exit", 0.8)])?.reason).toBe("Razón de claude.");
  });
});

describe("computeOverrides / buildDecision", () => {
  const cf = caseFile();
  const two = (symbol: string, action: any, c: number) => [
    { family: "claude", verdict: verdict({ [symbol]: v(action, c) }) },
    { family: "gpt", verdict: verdict({ [symbol]: v(action, c) }) },
  ];
  test("an override carries its sleeve, the factor of its action and its votes", () => {
    const r = computeOverrides(universeOf(cf), two("NVDA", "reduce", 0.7));
    expect(r.overrides).toHaveLength(1);
    expect(r.overrides[0]).toMatchObject({ sleeve: "momentum_stocks", symbol: "NVDA", action: "reduce", factor: 0.5, meanConfidence: 0.7 });
    expect(computeOverrides(universeOf(cf), two("NVDA", "exit", 0.7)).overrides[0].factor).toBe(0);
  });
  test("a symbol only counts in a sleeve whose universe has it; an invented symbol is dropped, never overridden", () => {
    const r = computeOverrides(universeOf(cf), two("ZZZZ", "exit", 0.9));
    expect(r.overrides).toHaveLength(0);
    expect(r.dropped).toEqual([{ sleeve: null, symbol: "ZZZZ", why: "outside_universe" }]);
    const only = computeOverrides({ momentum_stocks: ["AAPL"], meanrev_stocks: ["JNJ"] }, two("JNJ", "exit", 0.9));
    expect(only.overrides[0].sleeve).toBe("meanrev_stocks");
  });
  test("never more than 3 names in momentum and 6 in mean reversion; ranked by mean confidence, then symbol", () => {
    const momentum = ["NVDA", "AAPL", "MSFT", "META", "AMZN"];
    const meanrev = ["ABBV", "AVGO", "BAC", "CAT", "COST", "CVX", "DIS", "GE"];
    const all = [...momentum, ...meanrev];
    // equal confidence for most, so the symbol breaks the tie; META/AMZN more confident
    const conf = (s: string) => (s === "AMZN" ? 0.95 : s === "META" ? 0.9 : s === "GE" ? 0.99 : 0.7);
    const verdicts = [
      { family: "claude", verdict: verdict(Object.fromEntries(all.map(s => [s, v("exit", conf(s))]))) },
      { family: "gpt", verdict: verdict(Object.fromEntries(all.map(s => [s, v("exit", conf(s))]))) },
    ];
    const r = computeOverrides(universeOf(cf), verdicts);
    const bySleeve = (id: string) => r.overrides.filter(o => o.sleeve === id).map(o => o.symbol);
    expect(bySleeve("momentum_stocks")).toEqual(["AMZN", "META", "AAPL"]); // 0.95, 0.9, then 0.7 ties by symbol: AAPL < MSFT < NVDA
    expect(bySleeve("meanrev_stocks")).toEqual(["GE", "ABBV", "AVGO", "BAC", "CAT", "COST"]);
    expect(r.dropped.map(d => `${d.sleeve}:${d.symbol}`).sort()).toEqual(["meanrev_stocks:CVX", "meanrev_stocks:DIS", "momentum_stocks:MSFT", "momentum_stocks:NVDA"]);
    expect(r.dropped.every(d => d.why.startsWith("over_limit"))).toBe(true);
  });
  test("fewer than two families with a valid verdict: no decision at all", () => {
    const base = { caseFile: cf, models: baseDecision().models, decidedAt: "2026-11-16T13:00:00.000Z" };
    expect(buildDecision({ ...base, verdicts: [] })).toBeNull();
    expect(buildDecision({ ...base, verdicts: [two("NVDA", "exit", 0.9)[0]] })).toBeNull();
    expect(buildDecision({ ...base, verdicts: [{ family: "claude", verdict: verdict({}) }, { family: "claude", verdict: verdict({}) }] })).toBeNull();
  });
  test("two valid verdicts with nothing to do give an EMPTY decision (it still ships and lifts the previous one)", () => {
    const d = buildDecision({ caseFile: cf, models: baseDecision().models, decidedAt: "2026-11-16T13:00:00.000Z", verdicts: [{ family: "claude", verdict: verdict({}) }, { family: "gpt", verdict: verdict({}) }] })!;
    expect(d.overrides).toEqual([]);
    expect(d.reviewed).toBe(43);
    expect(d.stage).toBe("inform");
    expect(d.id).toMatch(/^[0-9a-f]{12}$/);
  });
});
