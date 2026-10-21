// Cutover semantics (pure): who may run on which sleeve, how a misconfiguration fails closed toward the
// incumbent, the design hash, rollback hand-back, orphan alerts, the claim table of the Binance venue.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDB, PORTFOLIO_ENGINE_STRATEGY } from "../../db/database";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { builtinPortfolios } from "../../portfolios/builtin";
import type { PortfolioDefinition } from "../../portfolios/types";
import { portfolioUniverse } from "../../portfolios/validate";
import {
  PORTFOLIO_SLEEVES, countOpenPortfolioRows, designHash, handBackPortfolioRows, isCryptoDesign, resolvePortfolioWiring,
  restoreIncumbentRows, sleevesWithTwoManagers, type ResolveInput,
} from "./cutover";
import type { PortfolioStrategyConfig } from "../types";

describe("isCryptoDesign — which venue family a design belongs to", () => {
  const vm = (annualization: 252 | 365): PortfolioStrategyConfig => ({
    kind: "volManaged", universe: ["SPY"], inceptionGuardBars: 252, volLookback: 63, covLookback: 21,
    portfolioVolTarget: 0.15, annualization, perAssetCap: 0.25, maxGross: 1,
  });
  test("volManaged follows its annualization: 252 = Alpaca (RW2 E1/E2), 365 = Binance (E3)", () => {
    expect(isCryptoDesign(vm(252))).toBe(false);
    expect(isCryptoDesign(vm(365))).toBe(true);
  });
  test("the trend designs keep their venue: cryptoTrend on Binance, xassetTrend on Alpaca", () => {
    expect(isCryptoDesign({ kind: "cryptoTrend" } as PortfolioStrategyConfig)).toBe(true);
    expect(isCryptoDesign({ kind: "xassetTrend" } as PortfolioStrategyConfig)).toBe(false);
  });
});
import { claimPortfolioOrderId } from "./persistence";
import { XASSET, peDefinition, peVersions } from "./testSupport";

const READY = { alpaca: null, binance_usdm: null, binance_usdc: null } as const;
const incumbents = (): PortfolioDefinition[] => builtinPortfolios();
function resolve(extra: PortfolioDefinition[], over: Partial<ResolveInput> = {}) {
  return resolvePortfolioWiring({
    defs: [...incumbents(), ...extra], venueReady: READY,
    modelVersions: { ...peVersions("momentum_stocks"), ...peVersions("momentum_crypto_usdc"), ...peVersions("meanrev_stocks"), ...peVersions("momentum_crypto") },
    ...over,
  });
}
const msgs = (w: ReturnType<typeof resolve>) => w.problems.map(p => p.message).join(" | ");

beforeAll(() => { makeTestDb(); });
beforeEach(() => { getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM portfolio_order_claims;"); });

describe("observer alongside the incumbent", () => {
  test("an observer definition resolves next to the untouched incumbent definition: no problem, not live", () => {
    const w = resolve([peDefinition("momentum_stocks")]);
    expect(w.problems).toEqual([]);
    expect(w.live).toEqual([]);
    expect(w.observers.map(p => p.params.sleeve)).toEqual(["momentum_stocks"]);
    expect(w.observers[0].portfolioId).toBe("pe_momentum_stocks");
  });
  test("a disabled definition is simply off; no definition is the status quo", () => {
    expect(resolve([peDefinition("momentum_stocks", { enabled: false })])).toEqual({ observers: [], live: [], problems: [] });
    expect(resolve([])).toEqual({ observers: [], live: [], problems: [] });
  });
  test("observer needs the venue too (nothing to read otherwise): ignored with a reason", () => {
    const w = resolve([peDefinition("momentum_stocks")], { venueReady: { ...READY, alpaca: "alpaca venue UNLINKED" } });
    expect(w.observers).toEqual([]);
    expect(msgs(w)).toContain("UNLINKED");
  });
});

describe("live = exactly one engine per sleeve", () => {
  test("a valid live definition replaces the incumbent of ITS sleeve only", () => {
    const w = resolve([peDefinition("momentum_stocks", { runMode: "live" }), peDefinition("momentum_crypto_usdc", { runMode: "observer" })]);
    expect(w.problems).toEqual([]);
    expect(w.live.map(p => p.params.sleeve)).toEqual(["momentum_stocks"]);
    expect(w.observers.map(p => p.params.sleeve)).toEqual(["momentum_crypto_usdc"]);
  });
  test("two definitions on one sleeve with one live: ambiguous, NONE runs, the incumbent keeps the sleeve", () => {
    const w = resolve([
      peDefinition("momentum_stocks", { runMode: "live" }),
      peDefinition("momentum_stocks", { id: "pe_momentum_stocks_b", runMode: "observer", params: { strategyVersion: "momentum_stocks@other", heartbeatName: "portfolio:other" } }),
    ]);
    expect(w.live).toEqual([]);
    expect(w.observers).toEqual([]);
    expect(msgs(w)).toContain("ambiguous");
    expect(w.problems.map(p => p.severity).sort()).toEqual(["ignored", "live_refused"]);
  });
  test("two live definitions on one sleeve: none", () => {
    const w = resolve([peDefinition("momentum_stocks", { runMode: "live" }), peDefinition("momentum_stocks", { id: "pe_b", runMode: "live", params: { heartbeatName: "portfolio:b" } })]);
    expect(w.live).toEqual([]);
    expect(w.problems).toHaveLength(2);
  });
  test("two observers with distinct versions coexist; a duplicate version/heartbeat is dropped", () => {
    const w = resolve([
      peDefinition("momentum_stocks"),
      peDefinition("momentum_stocks", { id: "pe_b", params: { strategyVersion: "momentum_stocks@b", heartbeatName: "portfolio:b" } }),
      peDefinition("momentum_stocks", { id: "pe_c" }),
    ]);
    expect(w.observers.map(p => p.portfolioId)).toEqual(["pe_b", "pe_c"]);
    expect(w.problems.map(p => p.definitionId)).toEqual(["pe_momentum_stocks"]);
  });
});

describe("misconfiguration fails closed (live refused, incumbent keeps managing)", () => {
  const refused = (def: PortfolioDefinition, over: Partial<ResolveInput> = {}) => resolve([def], over);

  test("unknown sleeve / sleeve missing / definition id = sleeve id", () => {
    expect(msgs(refused(peDefinition("momentum_stocks", { params: { sleeve: "momentum_btc" } })))).toContain("params.sleeve");
    expect(msgs(refused(peDefinition("momentum_stocks", { params: { sleeve: undefined } })))).toContain("params.sleeve");
    expect(msgs(refused(peDefinition("momentum_stocks", { id: "momentum_stocks" })))).toContain("must not be the sleeve id");
  });
  test("account / venue that do not belong to the sleeve", () => {
    expect(msgs(refused({ ...peDefinition("momentum_stocks", { runMode: "live" }), account: "binance_usdt" }))).toContain("account");
    expect(msgs(refused(peDefinition("momentum_stocks", { runMode: "live", params: { venue: "binance_usdm" } })))).toContain("venue binance_usdm");
  });
  test("runMode live with definition mode shadow (or an unknown runMode): not live", () => {
    const w = refused(peDefinition("momentum_stocks", { runMode: "live", mode: "shadow" }));
    expect(w.live).toEqual([]);
    expect(msgs(w)).toContain("both must say live");
    expect(refused(peDefinition("momentum_stocks", { params: { runMode: "paper" as any } })).live).toEqual([]);
  });
  test("factorCore has no live membership source", () => {
    const w = refused(peDefinition("momentum_stocks", { runMode: "live", params: { strategy: { kind: "factorCore" } as any } }));
    expect(w.live).toEqual([]);
    expect(msgs(w)).toContain("membership");
  });
  test("design/venue mismatch and symbols outside the sleeve's row symbol space", () => {
    expect(msgs(refused(peDefinition("momentum_stocks", { params: { strategy: { ...XASSET, kind: "cryptoTrend" } as any } })))).toContain("does not belong on venue");
    // USDC rows are XXX/USDC: a canonical XXX/USD universe would make an adopted row and the design two positions.
    const usdc = peDefinition("momentum_crypto_usdc", { runMode: "live" });
    const bad = { ...usdc, params: { ...(usdc.params as any), strategy: { ...(usdc.params as any).strategy, universe: ["BTC/USD", "ETH/USD"] } } } as PortfolioDefinition;
    expect(msgs(refused(bad))).toContain("symbol space");
  });
  test("live = tested: no provenance, or a design edited after the script wrote it, is refused; observer is not", () => {
    const live = peDefinition("momentum_stocks", { runMode: "live" });
    const p: any = live.params;
    expect(resolve([{ ...live, params: { ...p, provenance: undefined } }]).live).toEqual([]);
    const edited = { ...live, params: { ...p, strategy: { ...p.strategy, portfolioVolTarget: 0.99 } } } as PortfolioDefinition;
    const w = resolve([edited]);
    expect(w.live).toEqual([]);
    expect(msgs(w)).toContain("no longer matches its provenance hash");
    const obs = peDefinition("momentum_stocks", { runMode: "observer" });
    expect(resolve([{ ...obs, params: { ...(obs.params as any), strategy: { ...p.strategy, portfolioVolTarget: 0.99 } } }]).observers).toHaveLength(1);
  });
  test("designHash is the manifest's whatever the dataSymbols mapping", () => {
    const canonical = designHash({ strategy: { ...XASSET }, venue: "alpaca", minOrderNotional: 5, rebalanceBand: 0 });
    expect(designHash({ strategy: { ...XASSET }, venue: "alpaca", minOrderNotional: 5, rebalanceBand: 0 })).toBe(canonical);
    expect(designHash({ strategy: { ...XASSET, maxGross: 1.7 }, venue: "alpaca", minOrderNotional: 5, rebalanceBand: 0 })).not.toBe(canonical);
    const usdc = peDefinition("momentum_crypto_usdc").params as any;
    const usd = { ...usdc, strategy: { ...usdc.strategy, universe: ["BTC/USD", "ETH/USD"] }, dataSymbols: undefined };
    expect(designHash(usdc)).toBe(designHash(usd));
  });
  test("the scorecard must know the version: it must be the LAST MODEL_VERSIONS entry of the sleeve", () => {
    const live = peDefinition("momentum_stocks", { runMode: "live" });
    const w = resolve([live], { modelVersions: { momentum_stocks: [{ id: "momentum_stocks@old", since: "x", modelStart: null, note: "" }] } });
    expect(w.live).toEqual([]);
    expect(msgs(w)).toContain("MODEL_VERSIONS");
  });
  test("venue not available: live refused (the incumbent runs)", () => {
    const w = resolve([peDefinition("momentum_crypto_usdc", { runMode: "live" })], { venueReady: { ...READY, binance_usdc: "USDC executor not attached" } });
    expect(w.live).toEqual([]);
    expect(msgs(w)).toContain("USDC executor not attached");
  });
  test("treasury ETF in the universe, or a symbol another stock sleeve trades: refused", () => {
    const live = peDefinition("momentum_stocks", { runMode: "live" });
    const withBoxx = { ...live.params, strategy: { ...XASSET, universe: ["SPY", "BOXX"] } } as any;
    withBoxx.provenance = { ...withBoxx.provenance, designSha256: designHash(withBoxx) };
    expect(msgs(resolve([{ ...live, params: withBoxx }]))).toContain("treasury");
    const meanrev = incumbents().find(d => d.id === "meanrev_stocks")!;
    const mrUniverse = portfolioUniverse(meanrev.template, meanrev.params);
    const clash = { ...live.params, strategy: { ...XASSET, universe: ["SPY", mrUniverse[0]] } } as any;
    clash.provenance = { ...clash.provenance, designSha256: designHash(clash) };
    const w = resolve([{ ...live, params: clash }]);
    expect(w.live).toEqual([]);
    expect(msgs(w)).toContain("overlaps 'meanrev_stocks'");
    // but overlapping its OWN incumbent is the point of a cutover
    const own = incumbents().find(d => d.id === "momentum_stocks")!;
    const ownUniverse = (own.params as any).universe as string[];
    const same = { ...live.params, strategy: { ...XASSET, universe: [ownUniverse[0]] } } as any;
    same.provenance = { ...same.provenance, designSha256: designHash(same) };
    expect(resolve([{ ...live, params: same }]).live).toHaveLength(1);
  });
  test("heartbeat colliding with an incumbent's", () => {
    const w = resolve([peDefinition("momentum_stocks", { params: { heartbeatName: "momentum:stocks" } })]);
    expect(w.observers).toEqual([]);
    expect(msgs(w)).toContain("collides");
  });
});

describe("sleeve table", () => {
  test("the sleeves the portfolio engine may run on; row symbol spaces", () => {
    expect(Object.keys(PORTFOLIO_SLEEVES).sort()).toEqual(["meanrev_stocks", "momentum_crypto", "momentum_crypto_usdc", "momentum_stocks"]);
    expect(PORTFOLIO_SLEEVES.momentum_crypto_usdc.symbolOk("BTC/USDC")).toBe(true);
    expect(PORTFOLIO_SLEEVES.momentum_crypto_usdc.symbolOk("BTC/USD")).toBe(false);
    expect(PORTFOLIO_SLEEVES.momentum_stocks.symbolOk("SPY")).toBe(true);
  });
});

describe("rollback: PORTFOLIO rows go back to the incumbent", () => {
  test("handBackPortfolioRows re-tags to the incumbent strategy, keeps strategy_version, is idempotent and sleeve-scoped", () => {
    seedOpenTrade("pf_a", "momentum_stocks", { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY });
    seedOpenTrade("pf_b", "meanrev_stocks", { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY });
    seedOpenTrade("own", "momentum_stocks", { symbol: "AAPL", strategy: "MOMENTUM" });
    getDB().exec("UPDATE trades SET strategy_version = 'momentum_stocks@pe-x' WHERE id = 'pf_a'");
    const rows = handBackPortfolioRows("momentum_stocks");
    expect(rows.map(r => r.id)).toEqual(["pf_a"]);
    const a = getDB().prepare("SELECT strategy, strategy_version, status FROM trades WHERE id='pf_a'").get() as any;
    expect(a).toEqual({ strategy: "MOMENTUM", strategy_version: "momentum_stocks@pe-x", status: "open" });
    expect(countOpenPortfolioRows("meanrev_stocks")).toBe(1); // other sleeve untouched
    expect(handBackPortfolioRows("momentum_stocks")).toEqual([]);
    expect(handBackPortfolioRows("meanrev_stocks").map(r => r.id)).toEqual(["pf_b"]);
    expect((getDB().prepare("SELECT strategy FROM trades WHERE id='pf_b'").get() as any).strategy).toBe("MEANREV");
    expect(() => handBackPortfolioRows("momentum_btc")).toThrow();
  });

  test("restoreIncumbentRows: incumbent → hand back + arm stops; portfolio_live → untouched; none → alert, never silent", async () => {
    seedOpenTrade("pf_s", "momentum_stocks", { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY });
    seedOpenTrade("pf_c", "momentum_crypto_usdc", { symbol: "BTC/USDC", market: "crypto", strategy: PORTFOLIO_ENGINE_STRATEGY, quantity: 0.5, entryPrice: 100 });
    seedOpenTrade("pf_m", "meanrev_stocks", { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY });
    seedOpenTrade("pf_x", "momentum_crypto", { symbol: "ETH/USD", market: "crypto", strategy: PORTFOLIO_ENGINE_STRATEGY });
    const alerts: string[] = [];
    const armed: string[] = [];
    const report = await restoreIncumbentRows(
      { momentum_stocks: "incumbent", momentum_crypto_usdc: "incumbent", meanrev_stocks: "portfolio_live", momentum_crypto: "none" },
      { alert: (_c, m) => alerts.push(m), armStop: async (sleeve, row) => { armed.push(`${sleeve}:${row.symbol}`); return sleeve !== "momentum_stocks"; } },
    );
    expect(Object.keys(report.handedBack).sort()).toEqual(["momentum_crypto_usdc", "momentum_stocks"]);
    expect(armed.sort()).toEqual(["momentum_crypto_usdc:BTC/USDC", "momentum_stocks:SPY"]);
    expect(report.unprotected).toEqual(["momentum_stocks:SPY"]);
    expect(report.orphaned).toEqual({ momentum_crypto: 1 });
    expect(alerts.some(a => a.includes("momentum_crypto: 1 open PORTFOLIO row"))).toBe(true);
    expect(alerts.some(a => a.includes("momentum_stocks SPY") && a.includes("could NOT be armed"))).toBe(true);
    const strat = (id: string) => (getDB().prepare("SELECT strategy FROM trades WHERE id = ?").get(id) as any).strategy;
    expect([strat("pf_s"), strat("pf_c"), strat("pf_m"), strat("pf_x")]).toEqual(["MOMENTUM", "MOMENTUM", PORTFOLIO_ENGINE_STRATEGY, PORTFOLIO_ENGINE_STRATEGY]);
  });
});

describe("single-manager guard", () => {
  test("a live portfolio sleeve whose incumbent was built is reported", () => {
    expect(sleevesWithTwoManagers(["momentum_stocks", "meanrev_stocks"], s => s === "meanrev_stocks")).toEqual(["meanrev_stocks"]);
    expect(sleevesWithTwoManagers([], () => true)).toEqual([]);
  });
});

describe("claimPortfolioOrderId (Binance venue)", () => {
  test("atomic and durable: the first claim wins, the second never, across the same table", async () => {
    expect(await claimPortfolioOrderId("pe-o-abc", 1)).toBe(true);
    expect(await claimPortfolioOrderId("pe-o-abc", 2)).toBe(false);
    expect(await claimPortfolioOrderId("pe-o-def", 3)).toBe(true);
    expect((getDB().prepare("SELECT COUNT(*) c FROM portfolio_order_claims").get() as any).c).toBe(2);
    expect((getDB().prepare("SELECT claimed_at FROM portfolio_order_claims WHERE id='pe-o-abc'").get() as any).claimed_at).toBe(1);
  });
});
