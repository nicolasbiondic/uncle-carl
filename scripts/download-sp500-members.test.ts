// prepareMemberSeries (scripts/download-sp500-members.ts): pure tape-prep
// pipeline for PIT member symbols — filler removal, tape-identity gap
// segmentation, warmup sacrifice, final-bar artifacts, and real-event
// retention. Fixture-only, no network.
import { describe, expect, test } from "bun:test";
import { prepareMemberSeries, type TramoClip } from "./download-sp500-members";
import type { BarRow } from "../src/data/HistoricalStore";

const DAY = 86_400_000;
const T0 = Date.parse("2016-01-04");

function bar(dayIdx: number, close: number, volume = 1_000): BarRow {
  return {
    symbol: "X", timeframe: "1d", source: "alpaca_wide",
    timestamp: T0 + dayIdx * DAY, open: close, high: close, low: close, close, volume,
  };
}
const clip = (fromDay: number, toDay: number): TramoClip =>
  ({ fromMs: T0 + fromDay * DAY, toMs: T0 + toDay * DAY });

describe("prepareMemberSeries", () => {
  test("drops flat zero-volume filler bars (SIP delisting padding)", () => {
    const raw = [bar(0, 100), bar(1, 101), bar(2, 101, 0), bar(3, 101, 0), bar(4, 101, 0), bar(5, 101, 0)];
    raw[2].volume = raw[3].volume = raw[4].volume = raw[5].volume = 0;
    const p = prepareMemberSeries(raw, [clip(0, 10)]);
    expect(p.bars.map(b => b.timestamp)).toEqual([raw[0].timestamp, raw[1].timestamp]);
  });

  test("keeps the segment that covers the tramo when the tape identity breaks (FB → 2025 shell)", () => {
    const real = [0, 1, 2, 3, 4].map(i => bar(i, 100 + i));
    const shell = [200, 201, 202].map(i => bar(i, 39)); // resumes after a >30d gap
    const p = prepareMemberSeries([...real, ...shell], [clip(0, 6)]);
    expect(p.bars).toHaveLength(5);
    expect(p.bars[p.bars.length - 1].close).toBe(104);
    expect(p.notes.join(" ")).toContain("segments");
    // …and the LATER segment wins when the tramo lives there (SMCI relisting).
    const p2 = prepareMemberSeries([...real, ...shell], [clip(199, 203)]);
    expect(p2.bars.map(b => b.close)).toEqual([39, 39, 39]);
  });

  test("sacrifices warmup bars before a pre-tramo >75% discontinuity (cross-company tape)", () => {
    const raw = [bar(0, 100), bar(1, 100), bar(2, 320), bar(3, 321), bar(4, 322), bar(5, 323)];
    const p = prepareMemberSeries(raw, [clip(3, 10)]); // tramo starts at day 3; jump at day 2 predates it
    expect(p.bars.map(b => b.close)).toEqual([320, 321, 322, 323]);
    expect(p.inSeriesDiscontinuities).toEqual([]);
  });

  test("drops a final-bar >75% artifact but KEEPS real in-tramo events", () => {
    const artifact = [bar(0, 100), bar(1, 101), bar(2, 102), bar(3, 15)]; // last-bar collapse
    const p = prepareMemberSeries(artifact, [clip(0, 10)]);
    expect(p.bars.map(b => b.close)).toEqual([100, 101, 102]);

    const realEvent = [bar(0, 100), bar(1, 63), bar(2, 174), bar(3, 150), bar(4, 145)]; // MRNA-style spike mid-series
    const p2 = prepareMemberSeries(realEvent, [clip(0, 10)]);
    expect(p2.bars).toHaveLength(5);
    expect(p2.inSeriesDiscontinuities).toHaveLength(1);
    expect(p2.inSeriesDiscontinuities[0]).toContain("%");
  });

  test("clips warmup lookback to 630d before the first in-window tramo start", () => {
    const raw = [bar(0, 100), bar(700, 100), bar(701, 101)];
    const p = prepareMemberSeries(raw, [clip(700, 720)]);
    expect(p.bars.map(b => b.timestamp)).toEqual([raw[1].timestamp, raw[2].timestamp]);
  });
});
