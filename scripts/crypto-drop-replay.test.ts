import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hourlyDropZ, runDropReplay, type DropReplayResult } from "./crypto-drop-replay";
import { runXslsReplay } from "./crypto-xsls-replay";
import { candidateToReplayConfig, loadManifest, type WalkForwardSummary } from "./walk-forward";
import { evaluateXslsCriteria } from "./crypto-xsls-wf";
import type { ReplayConfig } from "./backtest-momentum-wf";

const HOUR = 3_600_000;
const start = Date.parse("2020-08-01T01:00:00Z");
const entry = Date.parse("2020-09-01T01:00:00Z");
const symbols = ["AAVEUSDT", "COMPUSDT", "CRVUSDT", "LTCUSDT", "BCHUSDT", "DOTUSDT"];
const dirs: string[] = [];
const withLiveArtifacts = existsSync(join("data/backtests", "5f03d68daed8572ebb73d5c283dfd80ec1064d5b47e8afb9c1f871d8537f091d", "runs.jsonl")) ? test : test.skip;
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

export function dropFixture(opts: { btcDrop?: number; fundingGap?: boolean; barGap?: boolean; delist?: boolean; entryAndExitFunding?: boolean; furtherDrop?: boolean } = {}) {
  const dir = mkdtempSync("/tmp/opencode/drop-test-");
  dirs.push(dir);
  const path = join(dir, "perps.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE historical_bars(symbol TEXT, timeframe TEXT, timestamp INTEGER, close REAL);
    CREATE INDEX bars ON historical_bars(symbol,timeframe,timestamp);
    CREATE TABLE funding_rates(symbol TEXT, funding_time INTEGER, rate REAL);
    CREATE TABLE quote_volume_1d(symbol TEXT, timestamp INTEGER, quote_volume REAL);`);
  const bar = db.prepare("INSERT INTO historical_bars VALUES(?,'1h',?,?)");
  const funding = db.prepare("INSERT INTO funding_rates VALUES(?,?,?)");
  const volume = db.prepare("INSERT INTO quote_volume_1d VALUES(?,?,?)");
  const prices: Record<string, number> = {};
  db.transaction(() => {
    for (const [si, sym] of [...symbols, "BTCUSDT"].entries()) {
      for (let d = 0; d < 31; d++) volume.run(sym, Date.parse("2020-08-01") + d * 24 * HOUR, 1e8 - si);
      let price = 100;
      for (let i = 0; i < 800; i++) {
        const t = start + i * HOUR;
        const ret = t === entry ? (sym === "BTCUSDT" ? opts.btcDrop ?? 0.01 : -0.10 + si * 0.005)
          : opts.furtherDrop && sym !== "BTCUSDT" && t === entry + HOUR ? -0.30 : (i % 2 ? 0.01 : -0.01);
        price *= Math.exp(ret);
        if (t === entry) prices[sym] = price;
        if (!(opts.barGap && t === entry + 4 * HOUR) && !(opts.delist && sym !== "BTCUSDT" && t > entry)) {
          bar.run(sym, t - HOUR, price);
        }
        if (t % (8 * HOUR) === 0 && !(opts.fundingGap && t > entry - 48 * HOUR)) funding.run(sym, t + 1, 0.0001);
      }
      if (opts.entryAndExitFunding) {
        funding.run(sym, entry + 1, 0.1234);
        funding.run(sym, entry + 4 * HOUR + 1, 0.001);
      }
    }
  })();
  db.close();
  const m = loadManifest(join(import.meta.dir, "..", "experiments", "crypto-drop-reversal-v1.json"));
  const cfg = candidateToReplayConfig(m, m.candidates[0], "base", path);
  cfg.universe = [...symbols, "BTCUSDT"];
  const win = { label: "fixture", from: new Date(entry).toISOString(), to: new Date(entry + 32 * HOUR).toISOString() };
  return { cfg, win, prices };
}

describe("H causal standardized hourly drop", () => {
  test("uses only closes <=t, excludes t from sd, includes exactly 720 previous hours", () => {
    const times = Array.from({ length: 1000 }, (_, i) => i * HOUR);
    const closes = times.map((_, i) => Math.exp(i % 2 ? 0.01 : 0));
    closes[900] = closes[899] * Math.exp(-0.10);
    const z = hourlyDropZ(times, closes);
    const past = Array.from({ length: 720 }, (_, j) => Math.log(closes[180 + j] / closes[179 + j]));
    const mean = past.reduce((s, r) => s + r, 0) / 720;
    const sd = Math.sqrt(past.reduce((s, r) => s + (r - mean) ** 2, 0) / 719);
    expect(z[900]).toBeCloseTo(-0.10 / sd, 10);
    const futureChanged = closes.map((c, i) => i > 900 ? c * 1e6 : c);
    expect([...hourlyDropZ(times, futureChanged).slice(0, 901)]).toEqual([...z.slice(0, 901)]);
    // Changing the current shock changes only the numerator, not the sd.
    const changed = [...closes]; changed[900] = closes[899] * Math.exp(-0.20);
    expect(hourlyDropZ(times, changed)[900]).toBeCloseTo(z[900] * 2, 10);
    // An observation older than the 720 previous hours cannot change sd.
    const old = [...closes]; old[100] *= 20;
    expect(hourlyDropZ(times, old)[900]).toBeCloseTo(z[900], 10);
  });

  test("requires 600 valid returns; gaps are not multi-hour returns; zero sd fails closed", () => {
    const times = Array.from({ length: 722 }, (_, i) => i * HOUR);
    const closes = times.map((_, i) => Math.exp(i % 2 ? 0.01 : 0));
    const z = hourlyDropZ(times, closes);
    expect(Number.isNaN(z[600])).toBe(true);
    expect(Number.isFinite(z[601])).toBe(true);
    expect(Number.isNaN(hourlyDropZ(times, times.map(() => 100))[721])).toBe(true);
    times[721] += HOUR;
    expect(Number.isNaN(hourlyDropZ(times, closes)[721])).toBe(true);
    const bad = closes.map((c, i) => i >= 300 && i <= 421 ? 0 : c);
    expect(Number.isNaN(hourlyDropZ(Array.from({ length: 722 }, (_, i) => i * HOUR), bad)[721])).toBe(true);
  });
});

describe("H execution overlay", () => {
  test.each([4, 12])("fills close_t, exits exactly %i bars later, most negative first, 5 slots, no BTC or stops", async h => {
    const { cfg, win, prices } = dropFixture(); cfg.exitPct = h;
    const r = await runDropReplay(cfg, win) as DropReplayResult;
    expect(r.trades).toBe(5);
    expect(r.orders).toBe(10);
    expect(r.closedTrades.map(t => t.symbol)).toEqual(symbols.slice(0, 5));
    expect(r.closedTrades.every(t => t.entryAt === entry && t.exitAt === entry + h * HOUR && t.reason === "time_exit")).toBe(true);
    for (const t of r.closedTrades) expect(t.entryPrice).toBe(prices[t.symbol]);
    const notional = r.closedTrades.reduce((s, t) => s + t.qty! * t.entryPrice!, 0);
    expect(notional * 1.0009).toBeLessThanOrEqual(1600 + 1e-9);
    expect(r.closedTrades[0].qty! * r.closedTrades[0].entryPrice!).toBeCloseTo(320, 10);
    expect(r.dropDiagnostics.capacityBlocked).toBe(1);
    expect(r.dropDiagnostics.rebound.every(p => p.count === 5)).toBe(true);
    expect(r.gateBlocks).toEqual({});
    expect(r.funding).toBeLessThanOrEqual(0);
  });

  test("BTC same-hour crash blocks all signals; LOO refSymbol rewrite cannot disable filter", async () => {
    const { cfg, win } = dropFixture({ btcDrop: -0.03 });
    cfg.refSymbol = "AAVEUSDT";
    cfg.universe = symbols;
    const r = await runDropReplay(cfg, win) as DropReplayResult;
    expect(r.trades).toBe(0);
    expect(r.dropDiagnostics.btcBlocked).toBe(6);
  });

  test("future crash cannot alter entry z/ranking/size and does not install a stop", async () => {
    const regular = dropFixture();
    const crash = dropFixture({ furtherDrop: true });
    const a = await runDropReplay(regular.cfg, regular.win) as DropReplayResult;
    const b = await runDropReplay(crash.cfg, crash.win) as DropReplayResult;
    const firstEntries = (r: DropReplayResult) => r.closedTrades.filter(t => t.entryAt === entry)
      .map(t => ({ symbol: t.symbol, entryAt: t.entryAt, entryPrice: t.entryPrice, qty: t.qty }));
    expect(firstEntries(b)).toEqual(firstEntries(a));
    const trades = b.closedTrades.filter(t => t.entryAt === entry);
    expect(trades.every(t => t.exitAt === entry + 4 * HOUR && t.reason === "time_exit")).toBe(true);
    expect(trades.every(t => t.pnl < -80)).toBe(true);
  });

  test("funding freshness <=9h fails closed only at entry", async () => {
    const { cfg, win } = dropFixture({ fundingGap: true });
    const r = await runDropReplay(cfg, win) as DropReplayResult;
    expect(r.trades).toBe(0);
    expect(r.dropDiagnostics.fundingBlocked).toBe(6);
  });

  test("settlement ms after entry belongs to prior holders; exit-hour funding is charged before close", async () => {
    const { cfg, win } = dropFixture({ entryAndExitFunding: true });
    const r = await runDropReplay(cfg, win) as DropReplayResult;
    const expectedPayment = r.closedTrades.reduce((sum, t) => sum + t.qty! * t.exitPrice! * 0.001, 0);
    expect(r.funding).toBeCloseTo(-expectedPayment, 10);
    expect(r.trades).toBe(5);
  });

  test("no shortened time exit at fold boundary", async () => {
    const { cfg, win } = dropFixture();
    win.to = new Date(entry + 4 * HOUR).toISOString();
    const r = await runDropReplay(cfg, win) as DropReplayResult;
    expect(r.trades).toBe(0);
    expect(r.dropDiagnostics.boundaryBlocked).toBe(6);
  });

  test("missing exit bar is reported, not filled with a future or stale close", async () => {
    const { cfg, win } = dropFixture({ barGap: true });
    const r = await runDropReplay(cfg, win) as DropReplayResult;
    expect(r.closedTrades.every(t => t.exitAt === entry + 5 * HOUR)).toBe(true);
    expect(r.dropDiagnostics.delayedExits).toBe(5);
  });

  test("delisting uses A's last-price convention after 24h, funding gap stays optimistic", async () => {
    const { cfg, win } = dropFixture({ delist: true });
    const r = await runDropReplay(cfg, win) as DropReplayResult;
    expect(r.closedTrades.every(t => t.exitAt === entry + 24 * HOUR && t.reason === "delist")).toBe(true);
    expect(r.closedTrades.every(t => t.exitPrice === t.entryPrice)).toBe(true);
  });

  test("overlay absent is byte-identical to preregistration A/F2 baseline", async () => {
    const { cfg, win } = dropFixture();
    cfg.maxLongs = 2; cfg.maxShorts = 2; cfg.notionalPctPerSlot = 0.25; cfg.cadenceMin = 480; cfg.lookbackDays = 7;
    const results = [];
    for (const signal of ["priceMomentum", "fundingCarry"] as const) {
      const r = await runXslsReplay(cfg, win, undefined, { signal });
      if (!r) throw new Error("fixture failed");
      expect(r.trades).toBeGreaterThan(0);
      r.config = { ...r.config, dbPath: "fixture" };
      results.push(r);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(results)).digest("hex");
    // Recorded by running this fixture against 0394628's original kernel.
    expect(fingerprint).toBe("2de19feb8d069dd0247f41cdf58e85187bd0324149b5903520ce9f2ac6fab3ac");
  });

  test("manifest grid, capital, prior trials, data, window, costs and acceptance are frozen", () => {
    const h = JSON.parse(readFileSync(join(import.meta.dir, "../experiments/crypto-drop-reversal-v1.json"), "utf8"));
    const a = JSON.parse(readFileSync(join(import.meta.dir, "../experiments/crypto-xsls-v1.json"), "utf8"));
    for (const key of ["data", "window", "costs", "acceptance", "asOf"]) expect(h[key]).toEqual(a[key]);
    expect(h.candidates.map((c: ReplayConfig) => `${c.entryPct}/${c.exitPct}`)).toEqual(["3/4", "3/12", "4/4", "4/12"]);
    expect(h.ledger.initialEquity).toBe(1600);
    expect(h.trialAccounting).toEqual({ priorUniqueTrials: 380, complete: false });
  });

  withLiveArtifacts("shared criterion evaluator absent options matches original A/F2 evaluator fingerprint", async () => {
    const { cfg, win } = dropFixture();
    const m = loadManifest(join(import.meta.dir, "../experiments/crypto-xsls-v1.json"));
    m.data.dbPath = cfg.dbPath!;
    m.data.universe = cfg.universe;
    m.candidates = [{ ...m.candidates[0], maxLongs: 2, maxShorts: 2, cadenceMin: 480, notionalPctPerSlot: 0.25 }];
    const c = candidateToReplayConfig(m, m.candidates[0], "base");
    const result = await runXslsReplay(c, win);
    if (!result) throw new Error("fixture failed");
    const summary = {
      manifestHash: "fixture", complete: true, skippedFolds: [],
      outerSelection: [0, 1, 2].map(i => ({ foldPath: `${i}/test`, candidateName: m.candidates[0].name })),
      outerTests: [0, 1, 2].map(i => ({ foldPath: `${i}/test`, result })),
      stitchedOos: { sharpe: 1.2, maxDrawdown: 0.1, trades: 12 }, outerPsr: 0.96, breakEvenSlippageBps: 30,
      acceptance: Object.fromEntries(Object.entries(m.acceptance).filter(([, v]) => typeof v === "number")
        .map(([k, v]) => [k, { pass: true, threshold: v, value: v }])),
    } as unknown as WalkForwardSummary;
    const out = await evaluateXslsCriteria(m, summary, "/nonexistent", "fixture");
    const { generatedAt: _time, ...semantic } = out;
    // Original 0394628 evaluator body, same fixture, generatedAt excluded.
    expect(createHash("sha256").update(JSON.stringify(semantic)).digest("hex"))
      .toBe("0ed76ad26f53623e1f1689e333c6870aed97481d999bab03e153196675f626ac");
  });
});
