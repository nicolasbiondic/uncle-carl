// The ten inverse funds (stage C): the table read from the paper broker on 2026-11-14, both lookups, the whole-share flag.
import { describe, expect, test } from "bun:test";
import { ESTIMATE_MAX_MOVE, INVERSE_FUNDS, INVERSE_SYMBOLS, WHOLE_SHARE_FUNDS, fundOf, inverseFundEstimate, inverseOf, isInverseSymbol, isWholeShareFund } from "./inverse";

describe("the table", () => {
  test("ten funds, each stock with its own fund, exactly as the broker listed them", () => {
    expect(INVERSE_FUNDS.map(f => `${f.underlying}→${f.symbol}`)).toEqual([
      "NVDA→NVDD", "AAPL→AAPD", "MSFT→MSFD", "META→METD", "GOOGL→GGLS", "AMZN→AMZD", "AVGO→AVS", "NFLX→NFXS", "ORCL→ORCS", "QCOM→QCMD",
    ]);
    expect([...INVERSE_SYMBOLS]).toEqual(["NVDD", "AAPD", "MSFD", "METD", "GGLS", "AMZD", "AVS", "NFXS", "ORCS", "QCMD"]);
  });
  test("only NVDD, AAPD and MSFD are fractionable at the broker; the other seven trade in whole shares", () => {
    expect(INVERSE_FUNDS.filter(f => f.fractionable).map(f => f.symbol)).toEqual(["NVDD", "AAPD", "MSFD"]);
    expect([...WHOLE_SHARE_FUNDS]).toEqual(["METD", "GGLS", "AMZD", "AVS", "NFXS", "ORCS", "QCMD"]);
    for (const s of INVERSE_SYMBOLS) expect(isWholeShareFund(s)).toBe(WHOLE_SHARE_FUNDS.includes(s));
    expect(isWholeShareFund("NVDA")).toBe(false);
    expect(isWholeShareFund("SH")).toBe(false);
  });
  test("no ticker and no stock appears twice, and a fund is never the stock it bets against", () => {
    expect(new Set(INVERSE_SYMBOLS).size).toBe(INVERSE_SYMBOLS.length);
    expect(new Set(INVERSE_FUNDS.map(f => f.underlying)).size).toBe(INVERSE_FUNDS.length);
    for (const f of INVERSE_FUNDS) expect(f.symbol).not.toBe(f.underlying);
    expect(INVERSE_SYMBOLS.filter(s => INVERSE_FUNDS.some(f => f.underlying === s))).toEqual([]);
  });
  test("the table cannot be edited at run time", () => {
    expect(Object.isFrozen(INVERSE_FUNDS)).toBe(true);
    expect(Object.isFrozen(INVERSE_SYMBOLS)).toBe(true);
    expect(Object.isFrozen(INVERSE_FUNDS[0])).toBe(true);
  });
});

describe("the lookups, both ways", () => {
  test("stock → fund", () => {
    expect(inverseOf("NVDA")).toEqual({ underlying: "NVDA", symbol: "NVDD", fractionable: true });
    expect(inverseOf("META")).toEqual({ underlying: "META", symbol: "METD", fractionable: false });
    expect(inverseOf("KO")).toBeNull();      // a stock without a fund is only taken out
    expect(inverseOf("NVDD")).toBeNull();    // a fund has no fund
    expect(inverseOf("")).toBeNull();
  });
  test("fund → stock", () => {
    expect(fundOf("GGLS")).toEqual({ underlying: "GOOGL", symbol: "GGLS", fractionable: false });
    expect(fundOf("NVDA")).toBeNull();
    expect(isInverseSymbol("AVS")).toBe(true);
    expect(isInverseSymbol("SH")).toBe(false);   // SH is the RW8 hedge, a different instrument with its own rules
    expect(isInverseSymbol("avs")).toBe(false);  // tickers are exact
  });
});

describe("the fund's price at the pass, estimated from its last close and today's move of its stock", () => {
  test("the fund moves against the stock: stock −5 % → fund +5 %, stock +8 % → fund −8 %, no move → the close", () => {
    expect(inverseFundEstimate(40, 200, 190)).toBeCloseTo(42, 12);
    expect(inverseFundEstimate(40, 200, 216)).toBeCloseTo(36.8, 12);
    expect(inverseFundEstimate(40, 200, 200)).toBe(40);
  });
  test("a move of more than 25 % is not a move (a split, a wrong price): no estimate; exactly 25 % still is one", () => {
    expect(ESTIMATE_MAX_MOVE).toBe(0.25);
    expect(inverseFundEstimate(40, 200, 20)).toBeNull();      // a 10-for-1 split read as −90 %
    expect(inverseFundEstimate(40, 200, 251)).toBeNull();
    expect(inverseFundEstimate(40, 200, 149)).toBeNull();
    expect(inverseFundEstimate(40, 200, 250)).toBeCloseTo(30, 12);
    expect(inverseFundEstimate(40, 200, 150)).toBeCloseTo(50, 12);
  });
  test("a missing or impossible input gives no estimate, never a throw or a number", () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN, Infinity]) {
      expect(inverseFundEstimate(bad, 200, 190)).toBeNull();
      expect(inverseFundEstimate(40, bad, 190)).toBeNull();
      expect(inverseFundEstimate(40, 200, bad)).toBeNull();
    }
  });
});
