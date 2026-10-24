// The cutover ops script: dry-run by default, the stored definition is the manifest candidate's EXACT block,
// live needs the same design observed first + the version registered, rollback and removal, refusals.
// In-memory DB (and a temp file for the CLI), real committed RW manifests (read-only), no broker.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDB, initDatabase } from "../src/db/database";
import { makeTestDb, seedOpenTrade } from "../src/test-support/db";
import { initPlatformPortfolios, loadPlatformPortfolioRows, loadPlatformPortfolioDefinitions } from "../src/portfolios/store";
import { DEFAULT_MEANREV_CONFIG } from "../src/strategies/meanrev/MeanRevEngine";
import { designHash, resolvePortfolioWiring } from "../src/portfolio-engine/live/cutover";
import { MODEL_VERSIONS } from "../src/portfolio/modelVersions";
import { buildPortfolioEngines } from "../src/portfolio-engine/live/wiring";
import { HistoricalPriceView } from "../src/portfolio-engine/live/priceView";
import { makeHistDb, weekdaySessions } from "../src/portfolio-engine/live/testSupport";
import { decide } from "../src/portfolio-engine/decide";
import { planOrders } from "../src/portfolio-engine/orders";
import { getPortfolioDecision } from "../src/portfolio-engine/live/persistence";
import type { VolManagedConfig } from "../src/portfolio-engine/types";
import { portfolioUniverse } from "../src/portfolios/validate";
import { isTreasurySymbol } from "../src/treasury/treasurySymbols";
import { savePortfolioDecision } from "../src/portfolio-engine/live/persistence";
import type { PortfolioEngineParams } from "../src/portfolios/types";
import { applyCutover, main, parseArgs, planCutover, type CutoverArgs } from "./portfolio-engine-cutover";

const D1 = "experiments/rw-d1-xasset-etf-trend-v1.json";
const D2 = "experiments/rw-d2-sp500-core-v1.json";
const D3 = "experiments/rw-d3-crypto-daily-trend-v1.json";
const tmp = mkdtempSync(join(tmpdir(), "pe-cutover-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const base = (over: Partial<CutoverArgs> = {}): CutoverArgs => ({
  sleeve: "momentum_stocks", mode: "observer", manifest: D1, candidate: "vt12-band0", apply: false, dbPath: "", remove: false, minObserved: 3, ...over,
});
const VERSION = "momentum_stocks@pe-vt12-band0";
const versions = (sleeve = "momentum_stocks", id = VERSION) => ({ [sleeve]: [
  { id: `${sleeve}@old`, since: "1970-01-01T00:00:00Z", modelStart: null, note: "" },
  { id, since: "2026-10-21T00:00:00Z", modelStart: null, note: "" },
] });
const peRow = () => loadPlatformPortfolioRows(getDB()).find(r => r.id === "pe_momentum_stocks");
const manifestBlock = (path: string, name: string) => JSON.parse(readFileSync(path, "utf-8")).candidates.find((c: any) => c.name === name).portfolio;
function observePasses(n: number, version = VERSION) {
  for (let i = 0; i < n; i++) {
    savePortfolioDecision({
      accountId: "momentum_stocks", strategyVersion: version, session: `2026-10-${String(14 + i).padStart(2, "0")}`, asOf: "2026-10-13",
      mode: "observer", status: "observed", equity: 1, book: [], weights: {}, stops: [], memory: {}, diagnostics: {}, orders: [], note: null, decidedAt: 1, updatedAt: 1,
    });
  }
}

beforeEach(() => {
  makeTestDb();
  initPlatformPortfolios(getDB());
});

describe("dry-run is the default and writes nothing", () => {
  test("observer plan: valid, describes the write, the registry is untouched until applied", () => {
    const plan = planCutover(getDB(), base());
    expect(plan.ok).toBe(true);
    expect(plan.write.action).toBe("insert");
    expect(plan.lines.join("\n")).toContain("WILL CREATE pe_momentum_stocks as OBSERVER");
    expect(plan.lines.join("\n")).toContain("the incumbent keeps trading");
    expect(peRow()).toBeUndefined();
  });

  test("CLI: no --apply → exit 0, prints DRY-RUN, DB file unchanged; --apply writes and says to restart", () => {
    const path = join(tmp, "dry.db");
    initDatabase(path); initPlatformPortfolios(getDB()); getDB().close();
    const out: string[] = [];
    const log = console.log; console.log = (...a: any[]) => { out.push(a.join(" ")); };
    try {
      expect(main(["--sleeve", "momentum_stocks", "--mode", "observer", "--manifest", D1, "--candidate", "vt12-band0", "--db", path])).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("portfolio-engine-cutover DRY-RUN · observer · momentum_stocks");
      expect(text).toContain("candidate vt12-band0 of experiments/rw-d1-xasset-etf-trend-v1.json: xassetTrend, 18 symbols");
      expect(text).toContain("WILL CREATE pe_momentum_stocks as OBSERVER");
      expect(text).toContain("DRY-RUN: nothing written");
      expect((new Database(path, { readonly: true }).prepare("SELECT COUNT(*) c FROM platform_portfolios WHERE id = 'pe_momentum_stocks'").get() as any).c).toBe(0);
      out.length = 0;
      expect(main(["--sleeve", "momentum_stocks", "--mode", "observer", "--manifest", D1, "--candidate", "vt12-band0", "--db", path, "--apply"])).toBe(0);
      expect(out.join("\n")).toContain("written (insert). Restart the bot to apply.");
      const row = new Database(path, { readonly: true }).prepare("SELECT template, mode, enabled FROM platform_portfolios WHERE id = 'pe_momentum_stocks'").get() as any;
      expect(row).toEqual({ template: "portfolio", mode: "shadow", enabled: 1 });
    } finally { console.log = log; makeTestDb(); }
  });

  test("CLI refusals exit non-zero with nothing written", () => {
    const err = console.error; console.error = () => {};
    try {
      expect(main(["--mode", "observer"])).toBe(2);
      expect(main(["--sleeve", "momentum_stocks", "--mode", "paper"])).toBe(2);
      expect(main(["--sleeve", "momentum_stocks", "--mode", "observer", "--db", join(tmp, "nope.db")])).toBe(2);
    } finally { console.error = err; }
    expect(parseArgs(["--sleeve", "x", "--mode", "live", "--apply", "--min-observed", "0"])).toMatchObject({ apply: true, minObserved: 0, mode: "live" });
  });
});

describe("the definition is the candidate's EXACT block (live = tested)", () => {
  test("stored strategy deep-equals the manifest block; the provenance hash is the manifest block's hash", () => {
    const plan = planCutover(getDB(), base());
    applyCutover(getDB(), plan);
    const row = peRow()!;
    const p = row.params as PortfolioEngineParams;
    const block = manifestBlock(D1, "vt12-band0");
    expect(p.strategy).toEqual(block.strategy);
    expect(p).toMatchObject({ engine: "portfolio", sleeve: "momentum_stocks", venue: "alpaca", runMode: "observer", strategyVersion: VERSION,
      minOrderNotional: block.venue.minOrderNotional, rebalanceBand: block.venue.rebalanceBand, heartbeatName: "portfolio:momentum_stocks" });
    expect(p.provenance).toEqual({ manifest: D1, candidate: "vt12-band0", designSha256: designHash({ strategy: block.strategy, venue: "alpaca", minOrderNotional: 5, rebalanceBand: 0 }) });
    expect(row).toMatchObject({ template: "portfolio", account: "alpaca_main", capital: 50_000, mode: "shadow", enabled: true, status: "pending_restart", validation: "validated" });
  });

  test("USDC sleeve: a binance_usdc candidate's universe is mapped into the rows' symbol space and mapped back for the bars; the hash is still the manifest's", () => {
    const m = JSON.parse(readFileSync(D3, "utf-8"));
    const cand = JSON.parse(JSON.stringify(m.candidates[0]));
    cand.portfolio.venue.venue = "binance_usdc";
    const path = join(tmp, "usdc-manifest.json");
    writeFileSync(path, JSON.stringify({ ...m, candidates: [cand] }));
    const plan = planCutover(getDB(), base({ sleeve: "momentum_crypto_usdc", manifest: path, candidate: cand.name }));
    expect(plan.errors).toEqual([]);
    expect(plan.ok).toBe(true);
    const w = plan.write as { row: { params: PortfolioEngineParams } };
    const p = w.row.params;
    expect((p.strategy as any).universe).toEqual(["BTC/USDC", "ETH/USDC", "SOL/USDC", "XRP/USDC", "DOGE/USDC"]);
    expect(p.dataSymbols).toEqual({ "BTC/USDC": "BTC/USD", "ETH/USDC": "ETH/USD", "SOL/USDC": "SOL/USD", "XRP/USDC": "XRP/USD", "DOGE/USDC": "DOGE/USD" });
    expect(p.provenance!.designSha256).toBe(designHash({ strategy: cand.portfolio.strategy, venue: "binance_usdc", minOrderNotional: 5, rebalanceBand: 0.02 }));
  });

  test("USDT sleeve takes the D3 candidate as is", () => {
    const plan = planCutover(getDB(), base({ sleeve: "momentum_crypto", manifest: D3, candidate: "vt30-stop4" }));
    expect(plan.errors).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(((plan.write as any).row.params as PortfolioEngineParams).strategy).toEqual(manifestBlock(D3, "vt30-stop4").strategy);
  });
});

describe("refusals (nothing written)", () => {
  const refused = (over: Partial<CutoverArgs>, text: string) => {
    const plan = planCutover(getDB(), base(over));
    expect(plan.ok).toBe(false);
    expect(plan.errors.join(" | ")).toContain(text);
    expect(plan.write).toEqual({ action: "none" });
  };
  test("unknown sleeve, unknown candidate, missing manifest", () => {
    refused({ sleeve: "momentum_btc" }, "unknown sleeve");
    refused({ candidate: "nope" }, "not in");
    refused({ manifest: join(tmp, "missing.json") }, "manifest not found");
    refused({ manifest: undefined }, "--manifest and --candidate");
  });
  test("a candidate of another venue / the wrong design for the sleeve", () => {
    refused({ manifest: D3, candidate: "vt30-stop4" }, "candidate venue binance_usdm ≠ alpaca");
    refused({ sleeve: "momentum_crypto_usdc", manifest: D3, candidate: "vt30-stop4" }, "candidate venue binance_usdm ≠ binance_usdc");
  });
  test("factorCore (D2) has no live membership source", () => {
    const name = JSON.parse(readFileSync(D2, "utf-8")).candidates[0].name;
    refused({ manifest: D2, candidate: name }, "factorCore");
  });
  test("Binance rules the candidate did not test", () => {
    const m = JSON.parse(readFileSync(D3, "utf-8"));
    const cand = JSON.parse(JSON.stringify(m.candidates[0]));
    cand.portfolio.venue.rebalanceBand = 0.05;
    const path = join(tmp, "band-manifest.json");
    writeFileSync(path, JSON.stringify({ ...m, candidates: [cand] }));
    refused({ sleeve: "momentum_crypto", manifest: path, candidate: cand.name }, "live would not be tested");
  });
  test("no incumbent registry row to read the capital from", () => {
    getDB().exec("DELETE FROM platform_portfolios WHERE id = 'momentum_stocks'");
    refused({}, "no registry row 'momentum_stocks'");
    getDB().exec("DROP TABLE platform_portfolios");
    refused({}, "platform_portfolios does not exist");
  });
});

describe("live: the same design observed first, the version registered", () => {
  test("live without an observer definition, or with a different design, is refused", () => {
    expect(planCutover(getDB(), base({ mode: "live" }), { modelVersions: versions() }).errors.join(" ")).toContain("observer first");
    applyCutover(getDB(), planCutover(getDB(), base()));
    const other = planCutover(getDB(), base({ mode: "live", candidate: "vt15-band0" }), { modelVersions: versions("momentum_stocks", "momentum_stocks@pe-vt15-band0") });
    expect(other.ok).toBe(false);
    expect(other.errors.join(" ")).toContain("DIFFERENT design");
  });
  test("too few observed passes → refused; --min-observed 0 lets the operator decide", () => {
    applyCutover(getDB(), planCutover(getDB(), base()));
    observePasses(2);
    const plan = planCutover(getDB(), base({ mode: "live" }), { modelVersions: versions() });
    expect(plan.ok).toBe(false);
    expect(plan.errors.join(" ")).toContain("only 2 observed pass(es)");
    expect(planCutover(getDB(), base({ mode: "live", minObserved: 0 }), { modelVersions: versions() }).ok).toBe(true);
  });
  test("version not appended to MODEL_VERSIONS (the real table has none for it) → refused", () => {
    applyCutover(getDB(), planCutover(getDB(), base()));
    observePasses(3);
    const plan = planCutover(getDB(), base({ mode: "live" })); // real MODEL_VERSIONS
    expect(plan.ok).toBe(false);
    expect(plan.errors.join(" ")).toContain("append that version in src/portfolio/modelVersions.ts");
  });
  test("observed + registered → live written with mode live; its description says what happens at boot", () => {
    applyCutover(getDB(), planCutover(getDB(), base()));
    observePasses(3);
    const plan = planCutover(getDB(), base({ mode: "live" }), { modelVersions: versions() });
    expect(plan.errors).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.write.action).toBe("update");
    const text = plan.lines.join("\n");
    expect(text).toContain("observed passes of momentum_stocks@pe-vt12-band0: 3");
    expect(text).toContain("incumbent engine of momentum_stocks is NOT built");
    expect(text).toContain("no close, no rebuy");
    expect(text).toContain("fail-closed");
    applyCutover(getDB(), plan);
    expect(peRow()).toMatchObject({ mode: "live", status: "pending_restart" });
    expect((peRow()!.params as PortfolioEngineParams).runMode).toBe("live");
    // idempotent: the same command again plans the same update
    expect(planCutover(getDB(), base({ mode: "live" }), { modelVersions: versions() }).ok).toBe(true);
  });
  test("the boot-time resolver is part of the check: a design touching another stock sleeve's universe is refused", () => {
    const m = JSON.parse(readFileSync(D1, "utf-8"));
    const cand = JSON.parse(JSON.stringify(m.candidates[0]));
    const meanrev = getDB().prepare("SELECT params_json FROM platform_portfolios WHERE id='momentum_stocks'").get() as any;
    const own = (JSON.parse(meanrev.params_json).universe as string[])[0];
    // meanrev's universe is DEFAULT_MEANREV_CONFIG's: read a member from the registry-independent source
    const mr = DEFAULT_MEANREV_CONFIG.universe[0];
    cand.portfolio.strategy.universe = [own, mr];
    const path = join(tmp, "clash.json");
    writeFileSync(path, JSON.stringify({ ...m, candidates: [cand] }));
    const observer = planCutover(getDB(), base({ manifest: path, candidate: cand.name }));
    expect(observer.ok).toBe(true); // observer sends nothing: no collision to fear
    applyCutover(getDB(), observer);
    observePasses(3, `momentum_stocks@pe-${cand.name}`);
    const live = planCutover(getDB(), base({ mode: "live", manifest: path, candidate: cand.name }), { modelVersions: versions("momentum_stocks", `momentum_stocks@pe-${cand.name}`) });
    expect(live.ok).toBe(false);
    expect(live.errors.join(" ")).toContain("overlaps 'meanrev_stocks'");
  });
});

describe("Q5 RW5d: pe-vt15 → cash design, without handing the sleeve back to TSM", () => {
  const manifest = "experiments/rw5-e1-lev-vt30-g250-sma200-fastvol5-cash-v1.json";
  const candidate = "e1-lev-vt30-g250-sma200-fastvol5";
  const versionName = "pe-vt30-g250-sma200-fv5";
  const version = `momentum_stocks@${versionName}`;
  const next = (over: Partial<CutoverArgs> = {}) => base({ manifest, candidate, versionName, ...over });
  const ready = { alpaca: null, binance_usdm: null, binance_usdc: null } as const;
  const oldArgs = base({ manifest: "experiments/rw2-e1-stocks-volmanaged-v1.json", candidate: "vt15", versionName: "pe-vt15" });
  const oldVersions = { ...MODEL_VERSIONS, momentum_stocks: MODEL_VERSIONS.momentum_stocks.slice(0, -1) };
  function oldLive() {
    applyCutover(getDB(), planCutover(getDB(), oldArgs));
    const plan = planCutover(getDB(), { ...oldArgs, mode: "live", minObserved: 0 }, { modelVersions: oldVersions });
    expect(plan.errors).toEqual([]); applyCutover(getDB(), plan);
  }

  test("cannot run the new observer next to live pe-vt15; deploying the new last version alone refuses pe-vt15", () => {
    oldLive();
    const defs = loadPlatformPortfolioDefinitions(getDB());
    const alone = resolvePortfolioWiring({ defs, venueReady: ready });
    expect(alone.live).toEqual([]);
    expect(alone.problems.some(p => p.message.includes("not the LAST entry"))).toBe(true);
    const observer = planCutover(getDB(), next());
    expect(observer.ok).toBe(true);
    const row = (observer.write as any).row;
    const alongside = resolvePortfolioWiring({ defs: [...defs, { ...row, id: "rw5_observer" }], venueReady: ready, modelVersions: oldVersions });
    expect(alongside.live).toEqual([]); expect(alongside.observers).toEqual([]);
    expect(alongside.problems.some(p => p.message.includes("ambiguous, none runs"))).toBe(true);
  });

  test("observer then live in ONE transaction, no observer boot: explicit override 0, exact manifest and no treasury holdings", () => {
    oldLive(); observePasses(3, "momentum_stocks@pe-vt15");
    expect(planCutover(getDB(), next({ mode: "live", minObserved: 0 })).errors.join(" ")).toContain("DIFFERENT design");
    getDB().transaction(() => {
      applyCutover(getDB(), planCutover(getDB(), next()));
      const normal = planCutover(getDB(), next({ mode: "live" }));
      expect(normal.ok).toBe(false); // old-version evidence does not count
      expect(normal.errors.join(" ")).toContain("only 0 observed");
      const live = planCutover(getDB(), next({ mode: "live", minObserved: 0 }));
      expect(live.errors).toEqual([]); applyCutover(getDB(), live);
    })();
    const params = peRow()!.params as PortfolioEngineParams;
    const block = manifestBlock(manifest, candidate);
    expect(params.strategy).toEqual(block.strategy);
    expect(params).toMatchObject({ venue: block.venue.venue, minOrderNotional: block.venue.minOrderNotional, rebalanceBand: block.venue.rebalanceBand });
    expect(params.provenance!.designSha256).toBe(designHash({ strategy: block.strategy, venue: block.venue.venue, minOrderNotional: block.venue.minOrderNotional, rebalanceBand: block.venue.rebalanceBand }));
    expect(portfolioUniverse("portfolio", params).some(isTreasurySymbol)).toBe(false);
    const wiring = resolvePortfolioWiring({ defs: loadPlatformPortfolioDefinitions(getDB()), venueReady: ready });
    expect(wiring.problems).toEqual([]); expect(wiring.live.map(p => p.params.strategyVersion)).toEqual([version]);
  });

  test("runbook dry-run uses an in-memory snapshot; a failed live validation rolls back even the staged observer", () => {
    oldLive();
    const before = peRow();
    const copy = Database.deserialize(getDB().serialize());
    try {
      copy.transaction(() => {
        applyCutover(copy, planCutover(copy, next()));
        const live = planCutover(copy, next({ mode: "live", minObserved: 0 }));
        expect(live.errors).toEqual([]); applyCutover(copy, live);
      })();
      expect(peRow()).toEqual(before);
    } finally { copy.close(); }
    expect(() => getDB().transaction(() => {
      applyCutover(getDB(), planCutover(getDB(), next()));
      const live = planCutover(getDB(), next({ mode: "live", minObserved: 0 }), { modelVersions: oldVersions });
      expect(live.errors.join(" ")).toContain("append that version");
      if (!live.ok) throw Error("REFUSED: transaction rolled back");
      applyCutover(getDB(), live);
    })()).toThrow("REFUSED");
    expect(peRow()).toEqual(before);
  });

  for (const scenario of ["on", "off", "cold-band"] as const) test(`synthetic prod-like factory + LIVE runner = decide/planOrders (${scenario}); no observer/research trial`, async () => {
    const asOf = "2026-10-23", session = "2026-10-26";
    const config = manifestBlock(manifest, candidate).strategy as VolManagedConfig;
    const sessions = weekdaySessions(asOf, 300);
    const hist = makeHistDb(Object.fromEntries(config.universe.map((s, j) => [s, { sessions, close: (i: number) =>
      s === "SPY" ? (i === 299 ? (scenario === "on" ? 140 : scenario === "off" ? 80 : 100) : 100 + Math.sin(i))
        : 100 + i * 0.04 + 2 * Math.sin(i * (0.3 + j * 0.1)) }] )));
    try {
      const view = new HistoricalPriceView({ db: hist, asOf, symbols: config.universe });
      const prices = Object.fromEntries(config.universe.map(s => [s, view.lastClose(s)!]));
      seedOpenTrade("old_spy", "momentum_stocks", { symbol: "SPY", strategy: "PORTFOLIO", strategyVersion: "momentum_stocks@pe-vt15", quantity: 10, entryPrice: prices.SPY });
      // Realistic old-version state exists, but the new version MUST cold-start independently.
      savePortfolioDecision({ accountId: "momentum_stocks", strategyVersion: "momentum_stocks@pe-vt15", session: "2026-10-23", asOf: "2026-10-22",
        mode: "live", status: "submitted", equity: 50000, book: [], weights: {}, stops: [], memory: { oldVersionOnly: true }, diagnostics: {}, orders: [], note: null, decidedAt: 1, updatedAt: 1 });
      const book = { equity: 50000, positions: [{ symbol: "SPY", qty: 10, avgEntryPrice: prices.SPY }], memory: {} };
      const expected = decide({ view, config, book, executionSession: session });
      expect((expected.memory.portfolioCore as any).regime.riskOff).toBe(scenario !== "on");
      if (scenario === "on") expect(Object.keys(expected.weights).length).toBeGreaterThan(0);
      else expect(expected.weights).toEqual({}); // core to 0, no BIL/BOXX/SGOV: all cash
      const sent: any[] = [];
      const executor: any = { isConnected: () => true, getPositions: async () => [{ symbol: "SPY", market: "stock", side: "buy", quantity: 10, avgEntryPrice: prices.SPY, currentPrice: prices.SPY }],
        getLatestPrice: async (s: string) => prices[s], getRegTBuyingPower: async () => 1000000,
        getAccount: async () => ({ equity: "100000", long_market_value: "50000" }),
        client: { createOrder: async (p: any) => { sent.push(p); return { id: `o${sent.length}`, status: "filled", filled_qty: p.qty, filled_avg_price: String(prices[p.symbol]) }; },
          getOrderByClientId: async () => { throw Object.assign(new Error("absent"), { status: 404 }); } } };
      applyCutover(getDB(), planCutover(getDB(), next()));
      const live = planCutover(getDB(), next({ mode: "live", minObserved: 0 }));
      expect(live.errors).toEqual([]); applyCutover(getDB(), live);
      const wiring = resolvePortfolioWiring({ defs: loadPlatformPortfolioDefinitions(getDB()), venueReady: ready });
      const built = buildPortfolioEngines(wiring, { alpacaExecutor: executor, binanceTransports: {}, historicalDb: () => hist,
        now: () => Date.parse("2026-10-26T13:35:00Z"), engineOverrides: { tradingEnabled: () => true } });
      expect(built.problems).toEqual([]);
      const report = await built.live.get("momentum_stocks")!.tick();
      expect(report.status).toBe("submitted"); expect(report.rejected).toBe(0);
      const stored = getPortfolioDecision("momentum_stocks", version, session)!;
      expect(stored.weights).toEqual(expected.weights); expect(stored.memory).toEqual(expected.memory);
      expect(stored.orders.map(o => o.intent)).toEqual(planOrders(expected, book, prices, { venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0.01 }));
      expect(sent.every(p => !isTreasurySymbol(p.symbol))).toBe(true);
      expect((getDB().prepare("SELECT strategy_version v FROM trades WHERE id='old_spy'").get() as any).v).toBe("momentum_stocks@pe-vt15");
      expect((await built.live.get("momentum_stocks")!.tick()).status).toBe("already_done");
    } finally { hist.close(); }
  });

  test("rollback to pe-vt15 is a versioned portfolio→portfolio transition, NOT --mode rollback (TSM)", () => {
    applyCutover(getDB(), planCutover(getDB(), next()));
    applyCutover(getDB(), planCutover(getDB(), next({ mode: "live", minObserved: 0 })));
    const args = { ...oldArgs, versionName: "pe-vt15-rw5d-rollback" };
    const rollbackVersion = "momentum_stocks@pe-vt15-rw5d-rollback";
    const modelVersions = { ...MODEL_VERSIONS, momentum_stocks: [...MODEL_VERSIONS.momentum_stocks,
      { ...oldVersions.momentum_stocks.at(-1)!, id: rollbackVersion, since: "2026-10-27T13:35:00Z" }] };
    getDB().transaction(() => {
      applyCutover(getDB(), planCutover(getDB(), args, { modelVersions }));
      const live = planCutover(getDB(), { ...args, mode: "live", minObserved: 0 }, { modelVersions });
      expect(live.errors).toEqual([]); applyCutover(getDB(), live);
    })();
    expect((peRow()!.params as PortfolioEngineParams).strategy).toEqual(manifestBlock(oldArgs.manifest!, "vt15").strategy);
    const wiring = resolvePortfolioWiring({ defs: loadPlatformPortfolioDefinitions(getDB()), venueReady: ready, modelVersions });
    expect(wiring.problems).toEqual([]); expect(wiring.live[0].params.strategyVersion).toBe(rollbackVersion);
  });
});

describe("rollback", () => {
  test("live → rollback sets observer + shadow, keeps the design, reports the rows handed back at the next boot", () => {
    applyCutover(getDB(), planCutover(getDB(), base()));
    observePasses(3);
    applyCutover(getDB(), planCutover(getDB(), base({ mode: "live" }), { modelVersions: versions() }));
    seedOpenTrade("pf_1", "momentum_stocks", { symbol: "SPY", strategy: "PORTFOLIO", quantity: 3 });
    const plan = planCutover(getDB(), base({ mode: "rollback", manifest: undefined, candidate: undefined }));
    expect(plan.ok).toBe(true);
    const text = plan.lines.join("\n");
    expect(text).toContain("back to observer");
    expect(text).toContain("1 open PORTFOLIO row(s) are re-tagged to MOMENTUM");
    expect(text).toContain("SPY 3 (PORTFOLIO)");
    applyCutover(getDB(), plan);
    const row = peRow()!;
    expect(row).toMatchObject({ mode: "shadow", enabled: true, status: "pending_restart" });
    expect((row.params as PortfolioEngineParams).runMode).toBe("observer");
    expect((row.params as PortfolioEngineParams).provenance?.candidate).toBe("vt12-band0");
    // the incumbent definition is never touched
    expect(loadPlatformPortfolioRows(getDB()).find(r => r.id === "momentum_stocks")!.template).toBe("momentum_tsm");
  });
  test("--remove deletes the definition; with none there is nothing to do", () => {
    applyCutover(getDB(), planCutover(getDB(), base()));
    const plan = planCutover(getDB(), base({ mode: "rollback", remove: true, manifest: undefined, candidate: undefined }));
    expect(plan.write).toEqual({ action: "delete", id: "pe_momentum_stocks" });
    applyCutover(getDB(), plan);
    expect(peRow()).toBeUndefined();
    const none = planCutover(getDB(), base({ mode: "rollback", manifest: undefined, candidate: undefined }));
    expect(none.ok).toBe(true);
    expect(none.write).toEqual({ action: "none" });
    expect(none.lines.join("\n")).toContain("the incumbent already manages the sleeve");
  });
});
