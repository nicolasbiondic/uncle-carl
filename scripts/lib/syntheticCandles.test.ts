import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateGbmBars, mulberry32, writeSyntheticDb, type SyntheticSeriesSpec, type SyntheticTapeSpec } from "./syntheticCandles";

const TAPE: SyntheticTapeSpec = { timeframe: "1d", source: "synthetic", fromMs: Date.parse("2024-01-01T05:00:00Z"), bars: 50 };
const SPEC: SyntheticSeriesSpec = { symbol: "SYN", seed: 42, startPrice: 100, driftAnnual: 0.2, volAnnual: 0.4 };

describe("syntheticCandles", () => {
  test("same seed ⇒ bit-identical series; different seed ⇒ different series", () => {
    const a = generateGbmBars(TAPE, SPEC);
    const b = generateGbmBars(TAPE, SPEC);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generateGbmBars(TAPE, { ...SPEC, seed: 43 });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  test("bars are well-formed: OHLC ordering, positive prices, exact timestamp grid", () => {
    const bars = generateGbmBars(TAPE, SPEC);
    expect(bars.length).toBe(50);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      expect(b.timestamp).toBe(TAPE.fromMs + i * 86_400_000);
      expect(b.low).toBeGreaterThan(0);
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      if (i > 0) expect(b.open).toBeCloseTo(bars[i - 1].close, 3); // no gaps by construction (4dp rounding)
    }
  });

  test("mulberry32 is deterministic and uniform-ish in [0,1)", () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    const xs: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const x = r1();
      expect(x).toBe(r2());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      xs.push(x);
    }
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });

  test("writeSyntheticDb writes the production historical_bars shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "synth-candles-"));
    try {
      const dbPath = join(dir, "h.db");
      writeSyntheticDb(dbPath, TAPE, [SPEC, { ...SPEC, symbol: "SYN2", seed: 9 }]);
      const db = new Database(dbPath, { readonly: true });
      try {
        const n = db.prepare("SELECT COUNT(*) c FROM historical_bars WHERE timeframe='1d' AND source='synthetic'").get() as { c: number };
        expect(n.c).toBe(100);
        const row = db.prepare("SELECT * FROM historical_bars WHERE symbol='SYN' ORDER BY timestamp LIMIT 1").get() as Record<string, unknown>;
        expect(row.open).toBe(100);
        expect(row.volume).toBe(1000);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
