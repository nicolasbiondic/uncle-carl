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
import { initPlatformPortfolios, loadPlatformPortfolioRows } from "../src/portfolios/store";
import { DEFAULT_MEANREV_CONFIG } from "../src/strategies/meanrev/MeanRevEngine";
import { designHash } from "../src/portfolio-engine/live/cutover";
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
