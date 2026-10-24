// exposureControl — simulator/protocol surface (RW4a, 2026-10-23):
//   1. Hash identity: absent = legacy hash byte for byte; present changes it;
//      values change it again. The two LIVE manifests keep their hashes.
//   2. validateCandidate/validateExposureControl: strict shape, at least one
//      axis, forbidden on meanrev candidates; the 7 RW4a manifests validate.
//   3. candidateToReplayConfig forwards the block verbatim.
//   4. SimBroker.scalePosition: partial reduce realizes pro-rata P&L into
//      cash + partialRealized (netted at the final close — ONE ClosedTrade),
//      add-back averages the entry and keeps the stop anchored at the
//      original entry, margin-rejects like openPosition, counts turnover
//      and `resizes`.
//   5. End to end on synthetic bars (no look-ahead: SimBroker only reveals
//      closed bars): a drawdown produces reductions, recovery produces
//      add-backs, exposureStats is reported, the legacy run has no key.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SimBroker, canonicalJson, hashReplayConfig, runWithConfig, type ReplayConfig } from "./backtest-momentum-wf";
import { candidateToReplayConfig, validateCandidate, validateManifest, type CandidateConfig, type ExperimentManifest } from "./walk-forward";
import type { OHLCV } from "../src/utils/types";
import { INITIAL_RISK_STATE } from "../src/strategies/momentum/RiskGuard";
import { MomentumEngine, exposureScale, type MomentumEngineConfig } from "../src/strategies/momentum/MomentumEngine";
import { FakeBroker, MemoryPersistence, silentLogger } from "../src/test-support/momentum";
import { TestClock } from "../src/utils/clock";

setDefaultTimeout(120_000);

const XC = { drawdown: { startPct: 0.05, endPct: 0.25 }, minScale: 0.25, band: 0.10, minOrderUsd: 100 };
const XC_VOL = { volCap: { annualizedPct: 50, fastBars: 120, slowBars: 504 }, minScale: 0.25, band: 0.10, minOrderUsd: 100 };

const baseCfg: ReplayConfig = {
  sleeve: "crypto",
  universe: ["BTC/USD", "ETH/USD"],
  timeframe: "1h",
  source: "binance_futures",
  refSymbol: "BTC/USD",
  rthOnly: false,
  funding: false,
  barMinutes: 60,
  barMinutesEq: 60,
  slippageBps: 5,
  commissionBps: 4,
  initialEquity: 5000,
  leverage: 2,
  hardStopPct: 0.04,
  cadenceMin: 60,
  notionalPctPerSlot: 0.375,
  entryPct: 5,
  exitPct: -2,
  maxLongs: 4,
  maxShorts: 0,
  shortFunding: "credit",
  warmupDays: 45,
  dbPath: "./data/historical.db",
  risk: { peakHalfLifeDays: 30 },
};

const root = join(import.meta.dir, "..");
function loadManifest(name: string): ExperimentManifest {
  return JSON.parse(readFileSync(join(root, "experiments", name), "utf8")) as ExperimentManifest;
}

describe("hash identity — exposureControl", () => {
  test("absent = legacy hash; present changes it; values change it again", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, exposureControl: undefined })).toBe(legacy);
    const withXc = hashReplayConfig({ ...baseCfg, exposureControl: XC });
    expect(withXc).not.toBe(legacy);
    expect(hashReplayConfig({ ...baseCfg, exposureControl: { ...XC, band: 0.05 } })).not.toBe(withXc);
    expect(hashReplayConfig({ ...baseCfg, exposureControl: XC_VOL })).not.toBe(withXc);
    expect(canonicalJson(JSON.parse(JSON.stringify(baseCfg)))).not.toContain('"exposureControl"');
    const dd = { ...XC.drawdown, reference: undefined };
    expect(hashReplayConfig({ ...baseCfg, exposureControl: { ...XC, drawdown: dd } })).toBe(withXc);
    expect(hashReplayConfig({ ...baseCfg, exposureControl: { ...XC, drawdown: { ...dd, reference: "highWaterMark" } } })).not.toBe(withXc);
  });

  test("RW5 HWM candidate is the live manifest with only the pre-registration metadata and reference changed", () => {
    const live = loadManifest("momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1.json");
    const m = validateManifest(loadManifest("momentum-crypto-usdc-daily-s5-rw5-xc-hwm-pure-v1.json"));
    expect(m.name).toBe("momentum-crypto-usdc-daily-s5-rw5-xc-hwm-pure-v1");
    expect(m.description).toContain("PRE-REGISTERED (2026-10-24) BEFORE any run");
    expect(m.description).toContain("§16.9");
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 450, complete: false });
    const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
    expect(cfg.exposureControl!.drawdown!.reference).toBe("highWaterMark");
    const restored = structuredClone(m);
    restored.name = live.name;
    restored.description = live.description;
    restored.trialAccounting = live.trialAccounting;
    delete restored.candidates[0].exposureControl!.drawdown!.reference;
    expect(JSON.stringify(restored)).toBe(JSON.stringify(live));
  });

  test("the two LIVE crypto manifests keep their candidate hashes (RW3 c1 live config; USDC d13-s5) and the RW4a copies differ only by the knob", () => {
    const liveH = loadManifest("momentum-crypto-rw3-vt-35-corroff-pure-v1.json");
    const liveU = loadManifest("momentum-crypto-usdc-daily-s5-pure-v1.json");
    const hH = hashReplayConfig(candidateToReplayConfig(liveH, liveH.candidates[0], "base"));
    const hU = hashReplayConfig(candidateToReplayConfig(liveU, liveU.candidates[0], "base"));
    // Locked values: the live config of momentum_crypto (artifact efc086b4…) and of momentum_crypto_usdc (d0f7fd6f…).
    expect(canonicalJson(candidateToReplayConfig(liveH, liveH.candidates[0], "base"))).not.toContain('"exposureControl"');
    expect(canonicalJson(candidateToReplayConfig(liveU, liveU.candidates[0], "base"))).not.toContain('"exposureControl"');
    const rw4a = readdirSync(join(root, "experiments")).filter(f => f.includes("rw4a")).sort();
    expect(rw4a).toHaveLength(7);
    const seen = new Set<string>();
    for (const f of rw4a) {
      const m = validateManifest(loadManifest(f));
      expect(m.candidates).toHaveLength(1);
      const c = m.candidates[0];
      expect(c.exposureControl).toBeDefined();
      const cfg = candidateToReplayConfig(m, c, "base");
      const h = hashReplayConfig(cfg);
      expect(h).not.toBe(hH);
      expect(h).not.toBe(hU);
      expect(seen.has(h)).toBe(false);
      seen.add(h);
      // Everything but the knob (and, for the no-soft-DD variant, risk.softDrawdownPct) is the live candidate.
      const live = f.startsWith("momentum-crypto-usdc") ? liveU : liveH;
      const { exposureControl: _x, name: _n, risk, ...rest } = c as Record<string, unknown>;
      const { name: _ln, risk: liveRisk, ...liveRest } = live.candidates[0] as Record<string, unknown>;
      expect(rest).toEqual(liveRest);
      if (f.includes("nosoftdd")) expect(risk).toEqual({ ...(liveRisk as object), softDrawdownPct: 1.0 });
      else expect(risk).toEqual(liveRisk);
      expect(m.asOf).toBe(live.asOf);
      expect(m.window).toEqual(live.window);
      expect(m.costs).toEqual(live.costs);
      expect(m.acceptance).toEqual(live.acceptance);
    }
    // Trial accounting continues after RW4 b (424 → 428), one new hypothesis per manifest.
    const priors = rw4a.map(f => loadManifest(f).trialAccounting.priorUniqueTrials).sort((a, b) => a - b);
    expect(priors).toEqual([428, 429, 430, 431, 432, 433, 434]);
  });
});

describe("validateCandidate — exposureControl axis", () => {
  const cand: CandidateConfig = { name: "c", cadenceMin: 60, entryPct: 5, exitPct: -2, maxLongs: 4, maxShorts: 0 };

  test("accepts well-formed configs (dd only, vol only, both)", () => {
    expect(() => validateCandidate({ ...cand, exposureControl: XC })).not.toThrow();
    expect(() => validateCandidate({ ...cand, exposureControl: XC_VOL })).not.toThrow();
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, ...XC_VOL } })).not.toThrow();
    for (const reference of ["decayedPeak", "highWaterMark"]) {
      expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, drawdown: { ...XC.drawdown, reference } } })).not.toThrow();
    }
  });

  test("rejects malformed shapes", () => {
    expect(() => validateCandidate({ ...cand, exposureControl: { minScale: 0.25, band: 0.1, minOrderUsd: 0 } })).toThrow("at least one axis");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, extra: 1 } })).toThrow("unknown keys");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, drawdown: { startPct: 5, endPct: 25 } } })).toThrow("FRACTION");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, drawdown: { startPct: 0.25, endPct: 0.05 } } })).toThrow("endPct");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, drawdown: { startPct: 0.05, endPct: 0.25, minScale: 0.3 } } })).toThrow("unknown keys");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, minScale: 0 } })).toThrow("minScale");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, band: 1 } })).toThrow("band");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, minOrderUsd: -1 } })).toThrow("minOrderUsd");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC_VOL, volCap: { annualizedPct: 0.35, fastBars: 120, slowBars: 504 } } })).toThrow("PERCENT");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC_VOL, volCap: { annualizedPct: 50, fastBars: 504, slowBars: 120 } } })).toThrow("slowBars");
    expect(() => validateCandidate({ ...cand, exposureControl: { ...XC_VOL, volCap: { annualizedPct: 50, fastBars: 120, slowBars: 504, lookbackBars: 1 } } })).toThrow("unknown keys");
    expect(() => validateCandidate({ ...cand, exposureControl: "on" as any })).toThrow("exposureControl");
    for (const reference of ["unknown", null, 1]) {
      expect(() => validateCandidate({ ...cand, exposureControl: { ...XC, drawdown: { ...XC.drawdown, reference } } })).toThrow("drawdown.reference");
    }
  });

  test("forbidden on meanrev candidates", () => {
    const mr = { name: "mr", cadenceMin: 1440, meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 }, exposureControl: XC };
    expect(() => validateCandidate(mr)).toThrow("momentum-only");
  });
});

describe("candidateToReplayConfig — exposureControl forwarding", () => {
  test("forwards the block verbatim; absence stays absent", () => {
    const m = loadManifest("momentum-crypto-rw4a-xc-both-pure-v1.json");
    const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
    expect(cfg.exposureControl).toEqual(m.candidates[0].exposureControl);
    const { exposureControl: _x, ...plain } = m.candidates[0];
    const cfg2 = candidateToReplayConfig(m, plain as CandidateConfig, "base");
    expect(cfg2.exposureControl).toBeUndefined();
    expect(canonicalJson(JSON.parse(JSON.stringify(cfg2)))).not.toContain('"exposureControl"');
  });
});

// ── SimBroker.scalePosition ────────────────────────────────────────────────
const H = 3_600_000;
function hourly(symbol: string, closes: number[], t0: number): OHLCV[] {
  return closes.map((c, i) => ({ timestamp: t0 + i * H, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000 }));
}

describe("SimBroker.scalePosition", () => {
  const T0 = Date.parse("2024-01-01T00:00:00Z");
  function broker(closes: number[], isStock = false) {
    const candles = new Map([["AAA", hourly("AAA", closes, T0)]]);
    const b = new SimBroker(10_000, candles, 10, 10, H, { leverage: 2, maintRate: 0.05 }, 0.04, undefined, isStock);
    return b;
  }

  test("live-adapter seam and SimBroker give identical HWM λ and entry size on the same synthetic equity/bars/state", async () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i);
    const bars = hourly("AAA", closes, T0);
    const now = T0 + (bars.length - 1) * H; // last bar is the next-open fill, not yet a decision bar
    const sim = broker(closes);
    sim.now = now;
    const live = new FakeBroker();
    live.setCandles("AAA", bars.slice(0, -1));
    const cfg: Partial<MomentumEngineConfig> = {
      mode: "time-series", universe: ["AAA"], historyBars: 100,
      notionalPctPerSlot: 0.2,
      tsm: { barMinutes: 60, lookbackDays: 1, maLengthDays: 1, entryThresholdPct: 5, maxLongs: 1, maxShorts: 0 },
      regime: { enabled: false },
      exposureControl: { ...XC, drawdown: { startPct: 0.1, endPct: 0.4, reference: "highWaterMark" } },
    };
    const make = (adapter: FakeBroker | SimBroker) => {
      const persistence = new MemoryPersistence();
      persistence.store = { v: 1, risk: { ...INITIAL_RISK_STATE, peakEquity: 10_000, highWaterMark: 12_500, dayStartEquity: 10_000, dayStartedAt: now, lastEvalAt: now } };
      return new MomentumEngine(cfg, adapter, silentLogger, persistence, new TestClock(now));
    };
    const liveEngine = make(live), simEngine = make(sim);
    const liveReport = await liveEngine.tick(), simReport = await simEngine.tick();
    expect(liveReport.exposureControl).toEqual(simReport.exposureControl);
    expect(liveReport.exposureControl!.scale).toBeCloseTo(2 / 3, 12);
    expect(liveEngine.getRiskState()).toEqual(simEngine.getRiskState());
    expect(live.opened).toHaveLength(1);
    const simPosition = sim.positions[0];
    expect(simPosition.qty * simPosition.entryPrice).toBeCloseTo(live.opened[0].notionalUsd, 9);
  });

  test("reduce: pro-rata gross − fee to cash and partialRealized; qty/margin shrink; ONE ClosedTrade at the end nets it", async () => {
    // Decision at the close of bar 0 (now = T0+1h), execution at bar 1's open.
    const b = broker([100, 100, 110, 110, 110, 110]);
    b.now = T0 + 1 * H;
    expect((await b.openPosition({ symbol: "AAA", side: "buy", notionalUsd: 2000 })).ok).toBe(true);
    const p0 = { ...b.positions[0] };
    // Next decision: bar 1 closed (now = T0+2h), execution at bar 2's open (110).
    b.now = T0 + 2 * H;
    const cashBefore = b.cash;
    const r = await b.scalePosition({ symbol: "AAA", side: "buy", factor: 0.6 });
    expect(r.ok).toBe(true);
    const p = b.positions[0];
    expect(p.qty).toBeCloseTo(p0.qty * 0.6, 12);
    expect(p.entryMargin).toBeCloseTo(p0.entryMargin * 0.6, 12);
    expect(p.entryPrice).toBe(p0.entryPrice); // a reduction never moves the entry
    const closeQty = p0.qty * 0.4;
    const slip = 110 * (1 - 10 / 10_000);
    const gross = (slip - p0.entryPrice) * closeQty;
    const fee = closeQty * slip * (10 / 10_000);
    expect(b.cash - cashBefore).toBeCloseTo(gross - fee, 9);
    expect(p.partialRealized).toBeCloseTo(gross - fee, 9);
    expect(b.resizes).toHaveLength(1);
    expect(b.resizes[0]).toMatchObject({ symbol: "AAA", side: "buy", factor: 0.6 });
    expect(b.resizes[0].qtyDelta).toBeCloseTo(-closeQty, 12);
    expect(b.closed).toHaveLength(0); // no trade row for a partial
    // Final close nets the partial into the single trade's pnl.
    b.now = T0 + 3 * H;
    const cashBeforeClose = b.cash;
    expect((await b.closePosition({ symbol: "AAA", side: "buy" })).ok).toBe(true);
    expect(b.closed).toHaveLength(1);
    const finalCashDelta = b.cash - cashBeforeClose;
    // pnl = (final gross − exit fee) − entry fee + partial realized
    expect(b.closed[0].pnl).toBeCloseTo(finalCashDelta - (p0.entryCommission ?? 0) + (gross - fee), 9);
    expect(b.positions).toHaveLength(0);
  });

  test("add-back: weighted-average entry, stop anchored at the ORIGINAL entry, margin check, turnover and fee counted", async () => {
    const b = broker([100, 100, 120, 120, 120, 120]);
    b.now = T0 + 1 * H;
    expect((await b.openPosition({ symbol: "AAA", side: "buy", notionalUsd: 2000 })).ok).toBe(true);
    const p0 = { ...b.positions[0] };
    const turnoverBefore = b.turnoverNotional;
    b.now = T0 + 2 * H;
    const r = await b.scalePosition({ symbol: "AAA", side: "buy", factor: 1.5 });
    expect(r.ok).toBe(true);
    const p = b.positions[0];
    const addQty = p0.qty * 0.5;
    const slip = 120 * (1 + 10 / 10_000);
    expect(p.qty).toBeCloseTo(p0.qty * 1.5, 12);
    expect(p.entryPrice).toBeCloseTo((p0.entryPrice * p0.qty + slip * addQty) / (p0.qty + addQty), 9);
    expect(p.stopAnchorPrice).toBe(p0.entryPrice);
    expect(p.entryMargin).toBeCloseTo(p0.entryMargin + (addQty * slip) / 2, 9);
    expect(b.turnoverNotional - turnoverBefore).toBeCloseTo(addQty * slip, 9);
    expect(b.resizes[0].qtyDelta).toBeCloseTo(addQty, 12);
    // Hard stop fires off the ORIGINAL entry (4% below 100.1), not the averaged one.
    const stopBar: OHLCV = { timestamp: T0 + 3 * H, open: 97, high: 97, low: 95, close: 96, volume: 1 };
    b.now = T0 + 4 * H;
    b.checkStops(new Map([["AAA", stopBar]]));
    expect(b.closed).toHaveLength(1);
    expect(b.closed[0].reason).toBe("stop_loss");
    expect(b.closed[0].exitPrice).toBeCloseTo(p0.entryPrice * 0.96 * (1 - 10 / 10_000), 9);
  });

  test("add-back beyond available margin is rejected and counted; invalid factors/no position refused; stocks floor to whole shares", async () => {
    const b = broker([100, 100, 100, 100]);
    b.now = T0 + 1 * H;
    expect((await b.openPosition({ symbol: "AAA", side: "buy", notionalUsd: 19_000 })).ok).toBe(true); // 9.5k margin of 10k
    b.now = T0 + 2 * H;
    const r = await b.scalePosition({ symbol: "AAA", side: "buy", factor: 1.5 }); // +9.5k notional → +4.75k margin > 0.5k left
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("margin_insufficient");
    expect(b.marginRejects).toBe(1);
    expect(b.resizes).toHaveLength(0);
    expect((await b.scalePosition({ symbol: "AAA", side: "buy", factor: 1 })).ok).toBe(false);
    expect((await b.scalePosition({ symbol: "AAA", side: "buy", factor: 0 })).ok).toBe(false);
    expect((await b.scalePosition({ symbol: "ZZZ", side: "buy", factor: 0.5 })).ok).toBe(false);
    expect((await b.scalePosition({ symbol: "AAA", side: "buy", factor: 1e-9 })).ok).toBe(false); // would flatten

    const s = broker([100, 100, 100, 100], true);
    s.now = T0 + 1 * H;
    expect((await s.openPosition({ symbol: "AAA", side: "buy", notionalUsd: 1000 })).ok).toBe(true); // 9 shares at 100.1
    s.now = T0 + 2 * H;
    expect((await s.scalePosition({ symbol: "AAA", side: "buy", factor: 0.95 })).ok).toBe(false); // 0.45 share → floors to 0
    expect((await s.scalePosition({ symbol: "AAA", side: "buy", factor: 0.6 })).ok).toBe(true);   // 3.6 → 3 shares
    expect(s.positions[0].qty).toBe(6);
  });
});

// ── End to end on synthetic bars ──────────────────────────────────────────
const SRC = "binance_vision_um";
function insertSeries(db: Database, symbol: string, startMs: number, closes: number[]): void {
  const stmt = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
  closes.forEach((px, i) => stmt.run(symbol, "1h", SRC, startMs + i * H, px, px * 1.001, px * 0.999, px, 1000));
}
/** +0.3%/bar for `upBars`, then −0.5%/bar for `downBars`, then +0.3%/bar for `recoverBars`. */
function path(upBars: number, downBars: number, recoverBars: number, p0 = 100): number[] {
  const out: number[] = [];
  let px = p0;
  for (let i = 0; i < upBars; i++) { out.push(px); px *= 1.003; }
  for (let i = 0; i < downBars; i++) { out.push(px); px *= 0.995; }
  for (let i = 0; i < recoverBars; i++) { out.push(px); px *= 1.003; }
  return out;
}
const START = Date.parse("2023-12-20T00:00:00Z");
const WIN = { label: "t", from: "2024-01-05T00:00:00Z", to: "2024-02-05T00:00:00Z" };

function e2eCfg(dbPath: string, overrides: Partial<ReplayConfig> = {}): ReplayConfig {
  return {
    sleeve: "crypto",
    universe: ["AAAUSDT", "BBBUSDT"],
    timeframe: "1h",
    source: SRC,
    refSymbol: "AAAUSDT",
    rthOnly: false,
    funding: false,
    barMinutes: 60,
    barMinutesEq: 60,
    slippageBps: 5,
    commissionBps: 4,
    initialEquity: 5000,
    leverage: 2,
    hardStopPct: 0.04,
    hardStop: { mode: "none" }, // isolate the control: no hard stops closing the book on the drop
    cadenceMin: 60,
    notionalPctPerSlot: 0.4,
    entryPct: 5,
    exitPct: -15, // keep the signal "long" through the drop so the book is HELD, not exited
    maxLongs: 2,
    maxShorts: 0,
    lookbackDays: 2,
    maLengthDays: 3,
    regime: { enabled: false },
    // No pauses: the test isolates the resize mechanics from the breakers.
    risk: { peakHalfLifeDays: 0, softDrawdownPct: 1.0, hardDrawdownPct: 1.0, dailyLossCapPct: 1.0, consecutiveLossLimit: 10_000 },
    shortFunding: "credit",
    warmupDays: 10,
    dbPath,
    ...overrides,
  };
}
function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rw4a-xc-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
function makeDb(dir: string): string {
  const dbPath = join(dir, "xc.db");
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE historical_bars (
      symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      PRIMARY KEY(symbol, timeframe, source, timestamp)
    )`);
    db.run("CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))");
    // Dec 20 → ~Jan 12 up (560 bars), 48 bars down (−21%), then up again to Feb 5+.
    const series = path(560, 48, 560);
    insertSeries(db, "AAAUSDT", START, series);
    insertSeries(db, "BBBUSDT", START, series.map(x => x * 2));
  } finally {
    db.close();
  }
  return dbPath;
}

describe("momentum replay — exposure control end to end", () => {
  test("synthetic replay chains the HWM input and matches the live engine's pure λ, leaving breakers decayed", () => withTmp(async dir => {
    const dbPath = makeDb(dir);
    const xc = { ...XC, drawdown: { startPct: 0.1, endPct: 0.4, reference: "highWaterMark" as const } };
    const seed = { ...INITIAL_RISK_STATE, peakEquity: 5_000, highWaterMark: 20_000 };
    const cfg = e2eCfg(dbPath, { exposureControl: xc, risk: { ...e2eCfg(dbPath).risk, peakHalfLifeDays: 30 } });
    const result = (await runWithConfig(cfg, WIN, seed))!;
    expect(result).not.toBeNull();
    // Synthetic path never recovers this inherited high. HWM survives every
    // engine evaluation in the replay, independently of the decaying peak.
    expect(result.finalRiskState.highWaterMark).toBe(20_000);
    expect(result.finalRiskState.peakEquity).toBeLessThan(20_000);
    const pure = exposureScale({ cfg: xc, book: [], barsPerYear: 24 * 365, drawdown: 1 - 5_000 / 20_000 });
    expect(result.exposureStats!.minScale).toBe(pure.scale);
    expect(result.exposureStats!.minScale).toBe(0.25);
    expect(result.exposureStats!.ticksBelowOne).toBe(result.exposureStats!.ticks);
    expect(seed.highWaterMark).toBe(20_000);
  }));

  test("drawdown axis reduces the HELD book on the drop and adds back on recovery; legacy run has no exposureStats; one ClosedTrade per position", () => withTmp(async dir => {
    const dbPath = makeDb(dir);
    const xc = { drawdown: { startPct: 0.02, endPct: 0.20 }, minScale: 0.25, band: 0.05, minOrderUsd: 1 };
    const legacy = await runWithConfig(e2eCfg(dbPath), WIN);
    const withXc = await runWithConfig(e2eCfg(dbPath, { exposureControl: xc }), WIN);
    expect(legacy).not.toBeNull();
    expect(withXc).not.toBeNull();

    expect(legacy!).not.toHaveProperty("exposureStats");
    const st = withXc!.exposureStats!;
    expect(st).toBeDefined();
    expect(st.ticks).toBeGreaterThan(0);
    expect(st.ticksBelowOne).toBeGreaterThan(0);
    expect(st.minScale).toBeLessThan(1);
    expect(st.reductions).toBeGreaterThan(0);
    expect(st.addBacks).toBeGreaterThan(0);
    expect(st.resizes).toBe(st.reductions + st.addBacks);
    expect(st.resizeNotionalUsd).toBeGreaterThan(0);
    // Extra orders are counted and cost money: Σ|Δnotional| of the resizes is
    // positive and already inside fees/turnover (SimBroker unit tests above
    // lock the per-order accounting; turnoverAnnual is equity-normalized, so
    // it is not monotone across two different equity paths).
    expect(withXc!.fees).toBeGreaterThan(0);
    // Partial resizes never create trade rows: every closed trade is a whole position.
    for (const t of withXc!.closedTrades) expect(["rebalance", "fold_end", "stop_loss", "liquidation"]).toContain(t.reason);
    // The control shallowed the drawdown of the drop (that is its whole point on this fixture).
    expect(withXc!.maxDrawdown).toBeLessThan(legacy!.maxDrawdown);
    // Identity: the result hash follows the config (knob present ⇒ different hash).
    expect(withXc!.hash).not.toBe(legacy!.hash);
    expect(withXc!.config.exposureControl).toEqual(xc);
  }));
});
