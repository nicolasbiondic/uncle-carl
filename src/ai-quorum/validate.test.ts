import { describe, expect, test } from "bun:test";
import { extractJson, validateModelViews } from "./validate";

describe("extractJson", () => {
  test("plain JSON passes through", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
  test("strips markdown code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  test("ignores prose around the object", () => {
    expect(extractJson('Sure! Here it is: {"a":1} hope it helps')).toBe('{"a":1}');
  });
  test("throws when there is no object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("validateModelViews — strict", () => {
  const SYMS = ["SPY", "BTC/USD"];

  test("valid response normalizes and returns every symbol", () => {
    const raw = JSON.stringify({
      "SPY": { view: "long", confidence: 0.7 },
      "BTC/USD": { view: "neutral", confidence: 0.2 },
    });
    expect(validateModelViews(raw, SYMS)).toEqual({
      "SPY": { view: "long", confidence: 0.7 },
      "BTC/USD": { view: "neutral", confidence: 0.2 },
    });
  });

  test("Spanish views are accepted and normalized", () => {
    const raw = JSON.stringify({
      "SPY": { view: "Largo", confidence: 1 },
      "BTC/USD": { view: "corto", confidence: 0 },
    });
    const v = validateModelViews(raw, SYMS);
    expect(v["SPY"].view).toBe("long");
    expect(v["BTC/USD"].view).toBe("short");
  });

  test("missing symbol → throws", () => {
    expect(() => validateModelViews('{"SPY":{"view":"long","confidence":0.5}}', SYMS)).toThrow(/BTC\/USD/);
  });

  test("confidence out of [0,1], NaN or non-number → throws", () => {
    for (const bad of [1.5, -0.1, "0.5", null]) {
      const raw = JSON.stringify({ "SPY": { view: "long", confidence: bad }, "BTC/USD": { view: "neutral", confidence: 0.1 } });
      expect(() => validateModelViews(raw, SYMS)).toThrow(/confidence/);
    }
  });

  test("unknown view → throws", () => {
    const raw = JSON.stringify({ "SPY": { view: "mega-long", confidence: 0.5 }, "BTC/USD": { view: "neutral", confidence: 0.1 } });
    expect(() => validateModelViews(raw, SYMS)).toThrow(/invalid view/);
  });

  test("array or scalar response → throws", () => {
    expect(() => validateModelViews("[1,2,3]", SYMS)).toThrow();
    expect(() => validateModelViews("42", SYMS)).toThrow();
  });

  test("extra symbols are ignored (only the requested universe is read)", () => {
    const raw = JSON.stringify({
      "SPY": { view: "long", confidence: 0.5 },
      "BTC/USD": { view: "short", confidence: 0.5 },
      "DOGE/USD": { view: "long", confidence: 1 },
    });
    expect(Object.keys(validateModelViews(raw, SYMS))).toEqual(SYMS);
  });
});
