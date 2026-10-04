// ══════════════════════════════════════════════
// costCalibration — fixture-driven tests. Everything the module reads is
// synthetic (temp sqlite files + temp artifact dirs); no dependency on
// data/backtests or historical.db existing. The reader suites open BOTH
// databases READONLY — an accidental write anywhere in the module throws.
// ══════════════════════════════════════════════

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// require("fs") dodges bun-types' fs shim, which omits rmSync and the
// recursive mkdirSync overload (same dodge as scorecard.test.ts).
const rmSync = (p: string, o: any) => { try { require("fs").rmSync(p, o); } catch {} };
const mkdirpSync = (p: string) => require("fs").mkdirSync(p, { recursive: true });
import {
  bootstrapMeanCI, breakEvenCostBps, calibrateSleeveCosts, computeCostCalibration,
  computeCostStats, costVsOpenBps, interpolateSharpeAt, loadArtifactCostContext,
  readSleeveCostObservations, stopSlipBps,
  PRICE_BASIS_BOUNDARY_MS, COST_SLEEVES,
  type SleeveCostConfig,
} from "./costCalibration";

const tmp = mkdtempSync(join(tmpdir(), "costcal-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ── Pure math ─────────────────────────────────────────────────────────────

describe("costVsOpenBps sign convention (positive = cost)", () => {
  test("buy above the open is a cost", () => {
    expect(costVsOpenBps("buy", 101, 100)).toBeCloseTo(100, 6);
  });
  test("buy below the open is a saving", () => {
    expect(costVsOpenBps("buy", 99, 100)).toBeCloseTo(-100, 6);
  });
  test("sell below the open is a cost", () => {
    expect(costVsOpenBps("sell", 99, 100)).toBeCloseTo(100, 6);
  });
  test("sell above the open is a saving", () => {
    expect(costVsOpenBps("sell", 101, 100)).toBeCloseTo(-100, 6);
  });
  test("non-positive reference never fabricates a number", () => {
    expect(costVsOpenBps("buy", 100, 0)).toBe(0);
    expect(costVsOpenBps("sell", 100, -5)).toBe(0);
  });
});

describe("stopSlipBps (gap the sim does not charge)", () => {
  test("long stop exit (SELL) filling below the level is a cost", () => {
    expect(stopSlipBps("sell", 99, 100)).toBeCloseTo(100, 6);
  });
  test("short stop exit (BUY) filling above the level is a cost", () => {
    expect(stopSlipBps("buy", 101, 100)).toBeCloseTo(100, 6);
  });
});

describe("computeCostStats / bootstrapMeanCI", () => {
  test("known fixture: n, mean, median, p90", () => {
    const s = computeCostStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])!;
    expect(s.n).toBe(10);
    expect(s.meanBps).toBeCloseTo(5.5, 9);
    expect(s.medianBps).toBeCloseTo(5.5, 9);   // linear-interpolated percentile
    expect(s.p90Bps).toBeCloseTo(9.1, 9);
    expect(s.ci95).not.toBeNull();
  });
  test("empty sample → null (never a fabricated zero row)", () => {
    expect(computeCostStats([])).toBeNull();
  });
  test("CI is deterministic (fixed seed), brackets the mean, n<3 → null", () => {
    const xs = [4, 5, 6, 5, 4, 6, 5, 5];
    const a = bootstrapMeanCI(xs)!, b = bootstrapMeanCI(xs)!;
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(5);
    expect(a.hi).toBeGreaterThanOrEqual(5);
    expect(bootstrapMeanCI([1, 2])).toBeNull();
  });
});

const CURVE = [
  { slippageBps: 0, sharpe: 1.0 },
  { slippageBps: 10, sharpe: 0.5 },
  { slippageBps: 20, sharpe: -0.5 },
  { slippageBps: 30, sharpe: -1.5 },
];

describe("breakEvenCurve interpolation", () => {
  test("exact points and midpoints", () => {
    expect(interpolateSharpeAt(CURVE, 0).sharpe).toBeCloseTo(1.0, 9);
    expect(interpolateSharpeAt(CURVE, 10).sharpe).toBeCloseTo(0.5, 9);
    expect(interpolateSharpeAt(CURVE, 5).sharpe).toBeCloseTo(0.75, 9);
    expect(interpolateSharpeAt(CURVE, 15).sharpe).toBeCloseTo(0.0, 9);
  });
  test("no extrapolation outside the curve", () => {
    expect(interpolateSharpeAt(CURVE, -1)).toEqual({ sharpe: null, outOfRange: true });
    expect(interpolateSharpeAt(CURVE, 31)).toEqual({ sharpe: null, outOfRange: true });
  });
  test("zero crossing: 0.5 at 10 → −0.5 at 20 crosses at 15", () => {
    expect(breakEvenCostBps(CURVE)).toEqual({ bps: 15, beyondCurve: false });
  });
  test("all-positive curve → break-even beyond the curve", () => {
    const c = [{ slippageBps: 0, sharpe: 1.2 }, { slippageBps: 30, sharpe: 1.1 }];
    expect(breakEvenCostBps(c)).toEqual({ bps: null, beyondCurve: true });
  });
});

// ── Fixture DBs (written once, then ALWAYS opened readonly) ──────────────

const ET_0935 = (utcDay: string) => Date.parse(`${utcDay}T13:35:00Z`); // 09:35 ET (EDT)

function buildTradingDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE fills (id INTEGER PRIMARY KEY, trade_id TEXT, order_id TEXT, account_id TEXT,
      symbol TEXT, side TEXT, market TEXT, expected_px REAL, submitted_px REAL, filled_px REAL,
      filled_qty REAL, slippage_bps REAL, fill_time INTEGER, latency_ms INTEGER, broker TEXT, est_px REAL);
    CREATE TABLE trades (id TEXT PRIMARY KEY, side TEXT, close_reason TEXT, stop_loss REAL,
      trailing_stop REAL, entry_price REAL, exit_price REAL, quantity REAL,
      open_commission REAL, close_commission REAL, entry_time INTEGER, exit_time INTEGER,
      status TEXT, account_id TEXT);
  `);
  const trade = db.prepare(`INSERT INTO trades (id, side, close_reason, stop_loss, trailing_stop, entry_price, exit_price, quantity, open_commission, close_commission, entry_time, exit_time, status, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const fill = db.prepare(`INSERT INTO fills (trade_id, order_id, account_id, symbol, side, market, expected_px, submitted_px, filled_px, filled_qty, slippage_bps, fill_time, latency_ms, broker, est_px) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // ── meanrev_stocks ──
  const d1 = ET_0935("2026-09-21"), d2 = ET_0935("2026-09-22");
  // t1: entry buy 100.5 vs open 100 (+50bps); exit MEANREV_EXIT sell 199 vs open 200 (+50bps)
  trade.run("t1", "buy", "MEANREV_EXIT", 95, null, 100.5, 199, 10, 0, 0, d1, d2, "closed", "meanrev_stocks");
  fill.run("t1", "o1", "meanrev_stocks", "KO", "buy", "stock", 100, 100, 100.5, 10, 0, d1, 100, "alpaca", null);
  fill.run("t1", "o2", "meanrev_stocks", "KO", "sell", "stock", 200, 200, 199, 10, 0, d2, 100, "alpaca", null);
  // t2: STOP_LOSS close — exit fill EXCLUDED from vs-open stats; stop gap from trades:
  // long stop at 90, exit_price 89.1 → (90 − 89.1)/90 = +100bps
  trade.run("t2", "buy", "STOP_LOSS", 90, null, 100, 89.1, 10, 0, 0, d1, d2, "closed", "meanrev_stocks");
  fill.run("t2", "o3", "meanrev_stocks", "KO", "buy", "stock", 100, 100, 100.5, 10, 0, d1, 100, "alpaca", null);
  fill.run("t2", "o4", "meanrev_stocks", "KO", "sell", "stock", 89, 89, 89.1, 10, 0, d2, 100, "alpaca", null);
  // t3: MANUAL_CLOSE exit → nonSim (entry still counts)
  trade.run("t3", "buy", "MANUAL_CLOSE", null, null, 100.5, 99, 10, 0, 0, d1, d2, "closed", "meanrev_stocks");
  fill.run("t3", "o5", "meanrev_stocks", "KO", "buy", "stock", 100, 100, 100.5, 10, 0, d1, 100, "alpaca", null);
  fill.run("t3", "o6", "meanrev_stocks", "sell", "sell", "stock", 99, 99, 99, 10, 0, d2, 100, "alpaca", null);
  // t4: symbol with no daily bar → noBar
  trade.run("t4", "buy", null, null, null, 50, null, 10, 0, 0, d1, null, "open", "meanrev_stocks");
  fill.run("t4", "o7", "meanrev_stocks", "NOBAR", "buy", "stock", 50, 50, 50, 10, 0, d1, 100, "alpaca", null);

  // ── momentum_stocks: fill BEFORE the daily kernel's MODEL_START → preModel ──
  trade.run("t5", "buy", null, null, null, 100, null, 1, 0, 0, d1, null, "open", "momentum_stocks");
  fill.run("t5", "o8", "momentum_stocks", "AAPL", "buy", "stock", 100, 100, 100, 1, 0, d1, 100, "alpaca", null);

  // ── momentum_crypto: one fill each side of the 2026-09-10 boundary ──
  const preTs = PRICE_BASIS_BOUNDARY_MS - 36 * 3600_000 + 20_000;   // 2026-09-08T12:00:20Z
  const postTs = PRICE_BASIS_BOUNDARY_MS + 12 * 3600_000 + 20_000;  // 2026-09-10T12:00:20Z
  // entry buy 20010 vs 1h open 20000 (+5bps), commissions 4bps each side
  trade.run("c1", "buy", "MOMENTUM_REBALANCE", 19000, null, 20010, 30003, 1, 20010 * 4e-4, 30003 * 4e-4, preTs, postTs, "closed", "momentum_crypto");
  fill.run("c1", "b1", "momentum_crypto", "BTC/USD", "buy", "crypto", 20000, 20000, 20010, 1, 0, preTs, 50, "binance", null);
  // exit sell 30003 vs 1h open 30000 (−1bps → saving)
  fill.run("c1", "b2", "momentum_crypto", "BTC/USD", "sell", "crypto", 30000, 30000, 30003, 1, 0, postTs, 50, "binance", null);
  // short SHORT entry (sell) — sell below open is a cost on the entry side
  trade.run("c2", "sell", "BROKER_STOP_LOSS", 31000, null, 29997, 31031, 1, 0, 0, postTs, postTs + 3600_000, "closed", "momentum_crypto");
  fill.run("c2", "b3", "momentum_crypto", "BTC/USD", "sell", "crypto", 30000, 30000, 29997, 1, 0, postTs, 50, "binance", null);
  // its BROKER_STOP_LOSS close never wrote a fills row — stop gap comes from
  // the TRADE: short stop at 31000, exit BUY at 31031 → +10bps

  // ── momentum_crypto_usdc: X/USDC prices off the X/USD mainnet bar ──
  trade.run("u1", "buy", null, null, null, 30015, null, 1, 0, 0, postTs, null, "open", "momentum_crypto_usdc");
  fill.run("u1", "b4", "momentum_crypto_usdc", "BTC/USDC", "buy", "crypto", 30000, 30000, 30015, 1, 0, postTs, 50, "binance", null);
  db.close();
}

function buildHistDb(path: string): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE historical_bars (source TEXT, symbol TEXT, timeframe TEXT, timestamp INTEGER, open REAL, close REAL);`);
  const bar = db.prepare(`INSERT INTO historical_bars (source, symbol, timeframe, timestamp, open, close) VALUES (?,?,?,?,?,?)`);
  // Daily stock bars stamped at 04:00 UTC of the session date (alpaca_wide contract).
  bar.run("alpaca_wide", "KO", "1d", Date.parse("2026-09-21T04:00:00Z"), 100, 101);
  bar.run("alpaca_wide", "KO", "1d", Date.parse("2026-09-22T04:00:00Z"), 200, 201);
  // 1h mainnet bars at the hour containing each crypto fill.
  bar.run("binance_futures", "BTC/USD", "1h", Date.parse("2026-09-08T12:00:00Z"), 20000, 20050);
  bar.run("binance_futures", "BTC/USD", "1h", Date.parse("2026-09-10T12:00:00Z"), 30000, 30020);
  db.close();
}

const tradingPath = join(tmp, "trading.db");
const histPath = join(tmp, "hist.db");
buildTradingDb(tradingPath);
buildHistDb(histPath);
const roTrading = () => new Database(tradingPath, { readonly: true });
const roHist = () => new Database(histPath, { readonly: true });

const cfgOf = (sleeve: string): SleeveCostConfig => COST_SLEEVES.find(c => c.sleeve === sleeve)!;

// ── Readers (READONLY handles: any write in the module would throw) ──────

describe("readSleeveCostObservations", () => {
  test("stocks: side-aware cost vs the decision day's open; stop closes excluded from slip and measured vs the level; manual closes nonSim; missing bar noBar", () => {
    const db = roTrading(), hist = roHist();
    try {
      const obs = readSleeveCostObservations(db, hist, cfgOf("meanrev_stocks"));
      // slips: t1 entry +50, t1 exit +50, t2 entry +50, t3 entry +50 — NOT t2's stop exit, NOT t3's manual exit
      expect(obs.slip.length).toBe(4);
      for (const s of obs.slip) expect(s.costBps).toBeCloseTo(50, 6);
      expect(obs.slip.filter(s => s.side === "buy").length).toBe(3);
      expect(obs.slip.every(s => s.period === "all")).toBe(true);
      // stop gap from the TRADE: (90 − 89.1)/90 → +100bps
      expect(obs.stops.length).toBe(1);
      expect(obs.stops[0]).toBeCloseTo(100, 6);
      expect(obs.excluded.nonSim).toBe(1);
      expect(obs.excluded.noBar).toBe(1);
    } finally { db.close(); hist.close(); }
  });

  test("momentum_stocks: fills before MODEL_START (daily kernel) are preModel-excluded", () => {
    const db = roTrading(), hist = roHist();
    try {
      const obs = readSleeveCostObservations(db, hist, cfgOf("momentum_stocks"));
      expect(obs.slip.length).toBe(0);
      expect(obs.excluded.preModel).toBe(1);
    } finally { db.close(); hist.close(); }
  });

  test("crypto: 1h-bar reference, 2026-09-10 period split, short-entry sign, trade-level commission bps, USDC→USD symbol map, broker-native stop gap from trades", () => {
    const db = roTrading(), hist = roHist();
    try {
      const obs = readSleeveCostObservations(db, hist, cfgOf("momentum_crypto"));
      expect(obs.slip.length).toBe(3);
      const pre = obs.slip.filter(s => s.period === "pre-2026-09-10");
      const post = obs.slip.filter(s => s.period === "desde-2026-09-10");
      expect(pre.length).toBe(1);
      expect(pre[0].costBps).toBeCloseTo(5, 6);            // buy 20010 vs 20000
      expect(post.length).toBe(2);
      const postSell = post.filter(s => s.side === "sell").map(s => s.costBps).sort((a, b) => a - b);
      expect(postSell[0]).toBeCloseTo(-1, 6);              // exit sell 30003 vs 30000 (saving)
      expect(postSell[1]).toBeCloseTo(1, 6);               // SHORT entry sell 29997 vs 30000 (cost)
      // commissions: 4bps entry (pre) + 4bps exit (post), trade-level
      expect(obs.commissionBps.length).toBe(2);
      for (const cm of obs.commissionBps) expect(cm.bps).toBeCloseTo(4, 6);
      expect(new Set(obs.commissionBps.map(c => c.period))).toEqual(new Set(["pre-2026-09-10", "desde-2026-09-10"]));
      // short's BROKER_STOP_LOSS: exit BUY 31031 vs level 31000 → +10bps
      expect(obs.stops.length).toBe(1);
      expect(obs.stops[0]).toBeCloseTo(10, 6);

      const usdc = readSleeveCostObservations(db, hist, cfgOf("momentum_crypto_usdc"));
      expect(usdc.slip.length).toBe(1);                    // BTC/USDC priced off BTC/USD
      expect(usdc.slip[0].costBps).toBeCloseTo(5, 6);
    } finally { db.close(); hist.close(); }
  });

  test("hist missing → every comparable fill lands in noBar, never a throw", () => {
    const db = roTrading();
    try {
      const obs = readSleeveCostObservations(db, null, cfgOf("meanrev_stocks"));
      expect(obs.slip.length).toBe(0);
      expect(obs.excluded.noBar).toBe(5);
    } finally { db.close(); }
  });

  test("sinceMs filters fills, stops and commissions", () => {
    const db = roTrading(), hist = roHist();
    try {
      const obs = readSleeveCostObservations(db, hist, cfgOf("momentum_crypto"), { sinceMs: PRICE_BASIS_BOUNDARY_MS });
      expect(obs.slip.every(s => s.period === "desde-2026-09-10")).toBe(true);
      expect(obs.commissionBps.length).toBe(1); // only the post-boundary exit leg
    } finally { db.close(); hist.close(); }
  });
});

// ── Artifact context + full calibration ──────────────────────────────────

function writeArtifact(dir: string, base: { slippageBps: number; commissionBps: number }, curve: any[]): void {
  mkdirpSync(dir);
  writeFileSync(join(dir, "manifest-resolved.json"), JSON.stringify({ costs: { base } }));
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ breakEvenCurve: curve }));
}

describe("calibrateSleeveCosts / computeCostCalibration", () => {
  test("assumed from manifest, Sharpe interpolated at the REAL total cost, margin to break-even", () => {
    const dir = join(tmp, "art1");
    writeArtifact(dir, { slippageBps: 2, commissionBps: 0 }, CURVE);
    const db = roTrading(), hist = roHist();
    try {
      const c = calibrateSleeveCosts(db, hist, cfgOf("meanrev_stocks"),
        { dir, shiftDays: 0, manifest: "m.json" });
      expect(c.assumed).toEqual({ slippageBps: 2, commissionBps: 0, totalPerSideBps: 2 });
      expect(c.measured!.n).toBe(4);
      expect(c.measured!.totalPerSideBps).toBeCloseTo(50, 6);   // fixture: every leg +50bps
      // 50bps is beyond the curve's 30 max → out of range ABOVE, bounded by sharpe(30)
      expect(c.breakEven!.measuredOutOfCurveRange).toBe(true);
      expect(c.breakEven!.outOfRangeDirection).toBe("above");
      expect(c.breakEven!.sharpeAtCurveEdge).toBeCloseTo(-1.5, 9);
      expect(c.breakEven!.breakEvenBps).toBeCloseTo(15, 6);
      expect(c.verdict).toContain("por ENCIMA del rango");
    } finally { db.close(); hist.close(); }
  });

  test("commission offset: curve x-axis is slippage with base commission held — real total maps to x = total − base commission", () => {
    const dir = join(tmp, "art2");
    writeArtifact(dir, { slippageBps: 5, commissionBps: 4 }, CURVE);
    const db = roTrading(), hist = roHist();
    try {
      const c = calibrateSleeveCosts(db, hist, cfgOf("momentum_crypto"), { dir, shiftDays: 0, manifest: "m.json" });
      // headline = desde-2026-09-10: slips (−1, +1) → mean 0; commission 4bps → total 4
      expect(c.measured!.period).toBe("desde-2026-09-10");
      expect(c.measured!.totalPerSideBps).toBeCloseTo(4, 6);
      // x = 4 − 4 = 0 → sharpe 1.0; break-even total = 15 + 4 = 19
      expect(c.breakEven!.sharpeAtMeasured).toBeCloseTo(1.0, 9);
      expect(c.breakEven!.breakEvenBps).toBeCloseTo(19, 6);
      expect(c.breakEven!.marginBps).toBeCloseTo(15, 6);
      // n=2 < 10 → the verdict refuses to extrapolate
      expect(c.verdict).toContain("muestra pequeña");
    } finally { db.close(); hist.close(); }
  });

  test("no artifact (momentum_crypto_usdc) → assumed/breakEven null, honest verdict", () => {
    const db = roTrading(), hist = roHist();
    try {
      const cal = computeCostCalibration(db, hist, { artifacts: {} });
      const usdc = cal.sleeves.find(s => s.sleeve === "momentum_crypto_usdc")!;
      expect(usdc.assumed).toBeNull();
      expect(usdc.breakEven).toBeNull();
      expect(usdc.verdict).toContain("sin artefacto autoritativo");
      expect(cal.sleeves.map(s => s.sleeve)).toEqual(COST_SLEEVES.map(c => c.sleeve));
    } finally { db.close(); hist.close(); }
  });

  test("corrupt/missing artifact files fail soft", () => {
    expect(loadArtifactCostContext(null)).toEqual({ manifest: null, assumed: null, curve: null });
    const dir = join(tmp, "art3");
    mkdirpSync(dir);
    writeFileSync(join(dir, "manifest-resolved.json"), "{not json");
    const ctx = loadArtifactCostContext({ dir, shiftDays: 0, manifest: "m.json" });
    expect(ctx.assumed).toBeNull();
    expect(ctx.curve).toBeNull();
  });

  test("empty DB (no comparable fills) → measured null, 'sin fills' verdict", () => {
    const p = join(tmp, "empty.db");
    const w = new Database(p);
    w.exec(`CREATE TABLE fills (trade_id TEXT, order_id TEXT, account_id TEXT, symbol TEXT, side TEXT, market TEXT, expected_px REAL, submitted_px REAL, filled_px REAL, filled_qty REAL, slippage_bps REAL, fill_time INTEGER, latency_ms INTEGER, broker TEXT, est_px REAL);
            CREATE TABLE trades (id TEXT PRIMARY KEY, side TEXT, close_reason TEXT, stop_loss REAL, trailing_stop REAL, entry_price REAL, exit_price REAL, quantity REAL, open_commission REAL, close_commission REAL, entry_time INTEGER, exit_time INTEGER, status TEXT, account_id TEXT);`);
    w.close();
    const db = new Database(p, { readonly: true });
    try {
      const c = calibrateSleeveCosts(db, null, cfgOf("momentum_stocks"), null);
      expect(c.measured).toBeNull();
      expect(c.verdict).toContain("sin fills comparables");
      expect(c.verdict).toContain("2026-09-28");
    } finally { db.close(); }
  });
});
