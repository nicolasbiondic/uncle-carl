import { expect, test } from "bun:test";
import { stopDistance, stopFillPrice, updateStops } from "./stops";
import type { Position, PriceView, StopConfig } from "./types";

const view = (closes: number[]): PriceView => ({ asOf: "2020-01-03", barCount: () => closes.length,
  history: (_s, n) => closes.map((close, i) => ({ date: `2020-01-0${i + 1}`, close, open: close, high: close, low: close, volume: 1 })).slice(-n) });
const pos: Position = { symbol: "BTC", qty: 1, avgEntryPrice: 100 };
const vol: StopConfig = { mode: "volScaled", kSigma: 3, lookbackBars: 2, minPct: 2, maxPct: 12 };

test("none, fixed average-entry distance, vol scale and both clamps", () => {
  expect(stopDistance({ mode: "none" })).toBeNull();
  expect(updateStops({ mode: "none" }, [pos], view([])).stops).toEqual([]);
  expect(updateStops({ mode: "fixed", pct: 4 }, [pos], view([])).stops).toEqual([{ symbol: "BTC", stopPrice: 96 }]);
  expect(stopDistance(vol, [100, 100, 100])).toBe(0.02);
  expect(stopDistance(vol, [100, 120, 80])).toBe(0.12);
  expect(stopDistance(vol, [100, 101, 99.99])).toBeCloseTo(3 * Math.sqrt(0.0002));
  expect(stopDistance(vol, [100])).toBeNull();
});

test("vol distance persists during hold/reduction and resets on actual increase", () => {
  const initial = updateStops(vol, [pos], view([100, 101, 99.99]));
  const held = updateStops(vol, [pos], view([100, 120, 80]), initial.memory);
  expect(held.stops).toEqual(initial.stops);
  const reduced = updateStops(vol, [{ ...pos, qty: 0.5 }], view([100, 120, 80]), held.memory);
  expect(reduced.stops).toEqual(initial.stops);
  const increased = updateStops(vol, [{ ...pos, qty: 0.75, avgEntryPrice: 110 }], view([100, 120, 80]), reduced.memory);
  expect(increased.stops[0].stopPrice).toBe(110 * 0.88);
  expect(increased.memory.BTC.distance).toBe(0.12);
  const flat = updateStops(vol, [], view([]), increased.memory);
  expect(flat.memory).toEqual({});
  expect(updateStops(vol, [pos], view([100, 100, 100]), flat.memory).stops[0].stopPrice).toBe(98);
});

test("fixed stop follows new average entry, not current close or watermark", () => {
  const old = updateStops({ mode: "fixed", pct: 4 }, [pos], view([]));
  expect(updateStops({ mode: "fixed", pct: 4 }, [{ ...pos, qty: 2, avgEntryPrice: 150 }], view([]), old.memory).stops[0].stopPrice).toBe(144);
});

test("stop bar fill: gap at open, intraday touch at stop, no hit", () => {
  expect(stopFillPrice(96, { open: 90, low: 85 })).toBe(90);
  expect(stopFillPrice(96, { open: 100, low: 96 })).toBe(96);
  expect(stopFillPrice(96, { open: 96, low: 90 })).toBe(96);
  expect(stopFillPrice(96, { open: 100, low: 97 })).toBeNull();
});
