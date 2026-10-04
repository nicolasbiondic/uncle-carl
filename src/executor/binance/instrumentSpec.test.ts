// ══════════════════════════════════════════════
// parseInstrumentSpec — strict exchangeInfo validation (2026-07-19 reviewer
// finding). A parsed spec feeds directly into order precision; a malformed
// or unsafe row must be rejected outright (null), never coerced into a
// guessed 0/2-decimal default. Rejection is the SAFE outcome here: callers
// (BinanceExecutor) fail closed for a NEW entry and preserve the exact
// broker qty for a risk-reducing close when no spec is found.
// ══════════════════════════════════════════════

import { describe, test, expect } from "bun:test";
import { parseInstrumentSpec, decimalPlaces, floorToStep } from "./instrumentSpec";

/** A fully valid TRADING PERPETUAL row, mirroring a real exchangeInfo entry. */
function rawRow(over: any = {}, filterOver: Record<string, any> = {}): any {
  const filters = [
    { filterType: "PRICE_FILTER", tickSize: "0.10", minPrice: "0", maxPrice: "0", ...filterOver.PRICE_FILTER },
    { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000", ...filterOver.LOT_SIZE },
    { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000", ...filterOver.MARKET_LOT_SIZE },
    { filterType: "MIN_NOTIONAL", notional: "5", ...filterOver.MIN_NOTIONAL },
  ].filter((f) => !(filterOver as any)[`DROP_${f.filterType}`]);
  return {
    symbol: "BTCUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    marginAsset: "USDT",
    filters,
    ...over,
  };
}

function dropFilter(type: string, base = rawRow()): any {
  return { ...base, filters: base.filters.filter((f: any) => f.filterType !== type) };
}

describe("parseInstrumentSpec — accepts a valid row", () => {
  test("parses a valid TRADING PERPETUAL row with all filters", () => {
    const spec = parseInstrumentSpec(rawRow());
    expect(spec).not.toBeNull();
    expect(spec).toMatchObject({ symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", marginAsset: "USDT", tickSize: 0.1, stepSize: 0.001, minNotional: 5 });
  });

  test("MARKET_LOT_SIZE absent falls back to LOT_SIZE (still valid)", () => {
    const spec = parseInstrumentSpec(dropFilter("MARKET_LOT_SIZE"));
    expect(spec).not.toBeNull();
    expect(spec?.marketStepSize).toBe(0.001);
  });

  test("MIN_NOTIONAL filter absent -> minNotional: null (not an error)", () => {
    const spec = parseInstrumentSpec(dropFilter("MIN_NOTIONAL"));
    expect(spec).not.toBeNull();
    expect(spec?.minNotional).toBeNull();
  });
});

describe("parseInstrumentSpec — rejects unsafe/malformed rows (null, never a guessed default)", () => {
  test("malformed row (no symbol) -> null", () => {
    expect(parseInstrumentSpec({})).toBeNull();
    expect(parseInstrumentSpec(null)).toBeNull();
  });

  test("non-TRADING status (BREAK) -> null", () => {
    expect(parseInstrumentSpec(rawRow({ status: "BREAK" }))).toBeNull();
  });

  test("non-TRADING status (SETTLING) -> null", () => {
    expect(parseInstrumentSpec(rawRow({ status: "SETTLING" }))).toBeNull();
  });

  test("wrong contractType (dated future, not perpetual) -> null", () => {
    expect(parseInstrumentSpec(rawRow({ contractType: "CURRENT_QUARTER" }))).toBeNull();
  });

  test("missing contractType -> null", () => {
    expect(parseInstrumentSpec(rawRow({ contractType: undefined }))).toBeNull();
  });

  test("missing marginAsset -> null", () => {
    expect(parseInstrumentSpec(rawRow({ marginAsset: undefined }))).toBeNull();
  });

  test("missing PRICE_FILTER -> null", () => {
    expect(parseInstrumentSpec(dropFilter("PRICE_FILTER"))).toBeNull();
  });

  test("zero PRICE_FILTER tickSize -> null", () => {
    expect(parseInstrumentSpec(rawRow({}, { PRICE_FILTER: { tickSize: "0" } }))).toBeNull();
  });

  test("missing LOT_SIZE -> null", () => {
    expect(parseInstrumentSpec(dropFilter("LOT_SIZE"))).toBeNull();
  });

  test("zero LOT_SIZE stepSize -> null", () => {
    expect(parseInstrumentSpec(rawRow({}, { LOT_SIZE: { stepSize: "0" } }))).toBeNull();
  });

  test("zero LOT_SIZE minQty -> null", () => {
    expect(parseInstrumentSpec(rawRow({}, { LOT_SIZE: { minQty: "0" } }))).toBeNull();
  });

  test("zero LOT_SIZE maxQty -> null", () => {
    expect(parseInstrumentSpec(rawRow({}, { LOT_SIZE: { maxQty: "0" } }))).toBeNull();
  });

  test("zero MARKET_LOT_SIZE step (present but invalid) -> null", () => {
    expect(parseInstrumentSpec(rawRow({}, { MARKET_LOT_SIZE: { stepSize: "0" } }))).toBeNull();
  });

  test("MIN_NOTIONAL filter present but non-numeric -> null (never defaults to 0)", () => {
    expect(parseInstrumentSpec(rawRow({}, { MIN_NOTIONAL: { notional: "not-a-number" } }))).toBeNull();
  });

  test("MIN_NOTIONAL filter present but zero -> null (a 0 gate would pass every qty)", () => {
    expect(parseInstrumentSpec(rawRow({}, { MIN_NOTIONAL: { notional: "0" } }))).toBeNull();
  });
});

describe("floorToStep / decimalPlaces (unaffected regression checks)", () => {
  test("floors, never rounds up", () => {
    expect(floorToStep(12.7, 1)).toBe(12);
    expect(floorToStep(0.1234, 0.0001)).toBeCloseTo(0.1234, 8);
  });

  test("decimal places of a step string", () => {
    expect(decimalPlaces("0.00100000")).toBe(3);
    expect(decimalPlaces("1.00000000")).toBe(0);
  });
});
