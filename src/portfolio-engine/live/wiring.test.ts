// The portfolio engine wired the way index.ts wires it, on fakes: fake Alpaca executor + client, fake
// Binance transport, in-memory trading DB and historical.db. Observer sends nothing while the incumbent's
// rows stay its own; live adopts without closing or rebuying and releases the incumbent's stops; rollback
// hands the rows back and the stop machinery sees them again; construction failures leave the sleeve to the
// incumbent; Reg-T / treasury-sweep interplay; heartbeat. No broker, no network.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDB, PORTFOLIO_ENGINE_STRATEGY } from "../../db/database";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { makeAccountManager } from "../../test-support/account";
import { TreasurySweep } from "../../treasury/TreasurySweep";
import { builtinPortfolios } from "../../portfolios/builtin";
import type { BinanceUsdmTransport } from "../../executor/binance/usdmTransport";
import { resolvePortfolioWiring, restoreIncumbentRows, type ResolveInput } from "./cutover";
import { buildPortfolioEngines, startPortfolioEngines, type EngineSources } from "./wiring";
import { getPortfolioDecision, listPortfolioDecisions } from "./persistence";
import { loadSleeveRows } from "./rows";
import { grossCapOf, registerGrossCap, resetGrossCapsForTests } from "../../ops/grossCaps";
import { portfolioClientOrderId } from "./clientOrderId";
import { PE_VERSION, fixedDecide, makeHistDb, peDefinition, peVersions, weekdaySessions } from "./testSupport";

const NOW = Date.parse("2026-10-20T14:00:00Z"); // Tuesday 10:00 ET (stocks) / 14:00Z (crypto)
const AS_OF = "2026-10-19";
const SESSION = "2026-10-20";
const READY = { alpaca: null, binance_usdm: null, binance_usdc: null } as const;
const versionsFor = (...sleeves: string[]) => Object.assign({}, ...sleeves.map(s => peVersions(s)));

function resolve(extra: ReturnType<typeof peDefinition>[], over: Partial<ResolveInput> = {}) {
  return resolvePortfolioWiring({
    defs: [...builtinPortfolios(), ...extra], venueReady: READY,
    modelVersions: versionsFor("momentum_stocks", "momentum_crypto_usdc", "meanrev_stocks", "momentum_crypto"), ...over,
  });
}

// ── fake Alpaca ──────────────────────────────────────────────────────────────

interface FakeAlpaca {
  executor: any;
  orders: any[];
  cancelled: string[];
  stops: Array<{ id: string; clientOrderId: string; symbol: string; side: string }>;
  brokerPositions: Array<{ symbol: string; quantity: number; avgEntryPrice: number }>;
  buyingPower: number | null | "throw";
}
function fakeAlpaca(): FakeAlpaca {
  const f: FakeAlpaca = { executor: null, orders: [], cancelled: [], stops: [], brokerPositions: [], buyingPower: 1_000_000 };
  const prices: Record<string, number> = { SPY: 500, TLT: 90, GLD: 200 };
  const client = {
    createOrder: async (p: any) => {
      f.orders.push(p);
      const px = prices[p.symbol] ?? 100;
      const qty = Number(p.qty);
      const pos = f.brokerPositions.find(x => x.symbol === p.symbol);
      if (p.side === "buy") { if (pos) pos.quantity += qty; else f.brokerPositions.push({ symbol: p.symbol, quantity: qty, avgEntryPrice: px }); }
      else if (pos) pos.quantity -= qty;
      return { id: `o${f.orders.length}`, status: "filled", filled_qty: String(qty), filled_avg_price: String(px) };
    },
    getOrder: async () => ({ status: "filled" }), getOrderByClientId: async () => ({ status: "filled" }), cancelOrder: async () => {},
  };
  f.executor = {
    client,
    isConnected: () => true,
    getPositions: async () => f.brokerPositions.map(p => ({ ...p, market: "stock", side: "buy", currentPrice: prices[p.symbol] ?? 100 })),
    getLatestPrice: async (s: string) => prices[s] ?? 0,
    getCachedPrice: () => 0,
    getRegTBuyingPower: async () => { if (f.buyingPower === "throw") throw new Error("account unreadable"); return f.buyingPower; },
    getOpenStopOrders: async () => f.stops.filter(s => !f.cancelled.includes(s.id)),
    cancelOrderById: async (id: string) => { f.cancelled.push(id); return true; },
  };
  return f;
}

function stockHist() {
  const sessions = weekdaySessions(AS_OF, 300);
  return makeHistDb(Object.fromEntries(["SPY", "TLT", "GLD"].map(s => [s, { sessions }])));
}

function sources(alpaca: FakeAlpaca | null, over: Partial<EngineSources> = {}) {
  const alerts: string[] = [];
  const beats: string[] = [];
  const registered: any[] = [];
  const src: EngineSources = {
    alpacaExecutor: alpaca?.executor, binanceTransports: {}, historicalDb: () => stockHist(), now: () => NOW,
    heartbeats: { register: (...a: any[]) => registered.push(a), beat: (n: string) => beats.push(n) },
    engineOverrides: { decide: fixedDecide({ SPY: 0.5, TLT: 0.3 }), tradingEnabled: () => true, alert: (_c: string, m: string) => alerts.push(m) },
    ...over,
  };
  return { src, alerts, beats, registered };
}

const strategyOf = (id: string) => (getDB().prepare("SELECT strategy, strategy_version, status FROM trades WHERE id = ?").get(id) as any);

beforeAll(() => { makeTestDb(); });
beforeEach(() => { resetGrossCapsForTests(); getDB().exec("DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM activity_log; DELETE FROM portfolio_order_claims;"); });

describe("dashboard caps follow the engine actually constructed", () => {
  test("live portfolio cap replaces the incumbent's cap and allocation base", () => {
    registerGrossCap("momentum_stocks", 1.725, "equity");
    registerGrossCap("meanrev_stocks", 0.966, "allocation");
    for (const [sleeve, mult] of [["momentum_stocks", 2.5], ["meanrev_stocks", 1]] as const) {
      const def = peDefinition(sleeve, { runMode: "live" });
      const wiring = resolve([def], { defs: [def] });
      const strategy = structuredClone(wiring.live[0].params.strategy);
      if ("maxGross" in strategy) strategy.maxGross = mult;
      wiring.live[0].params.strategy = strategy;
      expect(buildPortfolioEngines(wiring, sources(fakeAlpaca()).src).live.size).toBe(1);
    }
    expect(grossCapOf("momentum_stocks")).toEqual({ mult: 2.5, base: "equity" });
    expect(grossCapOf("meanrev_stocks")).toEqual({ mult: 1, base: "equity" });
  });

  test("observer or failed construction never replaces the incumbent's display cap", () => {
    registerGrossCap("momentum_stocks", 1.725, "equity");
    buildPortfolioEngines(resolve([peDefinition("momentum_stocks", { runMode: "observer" })]), sources(fakeAlpaca()).src);
    expect(grossCapOf("momentum_stocks")?.mult).toBe(1.725);
    buildPortfolioEngines(resolve([peDefinition("momentum_stocks", { runMode: "live" })]), sources(null).src);
    expect(grossCapOf("momentum_stocks")?.mult).toBe(1.725);
  });
});

describe("observer alongside the incumbent", () => {
  test("computes and persists on the sleeve's real rows; sends NOTHING; the incumbent's rows are untouched", async () => {
    seedOpenTrade("inc_spy", "momentum_stocks", { symbol: "SPY", strategy: "MOMENTUM", entryPrice: 500, quantity: 10 });
    const alpaca = fakeAlpaca();
    alpaca.brokerPositions = [{ symbol: "SPY", quantity: 10, avgEntryPrice: 500 }];
    alpaca.stops = [{ id: "stop-1", clientOrderId: "uc8-momentum_stocks-abc", symbol: "SPY", side: "sell" }];
    const wiring = resolve([peDefinition("momentum_stocks", { runMode: "observer" })]);
    const built = buildPortfolioEngines(wiring, sources(alpaca).src);
    expect(built.problems).toEqual([]);
    expect(built.live.size).toBe(0);
    expect(built.observers).toHaveLength(1);
    const rep = await built.observers[0].tick();
    expect(rep.status).toBe("observed");
    expect(alpaca.orders).toEqual([]);                 // nothing sent
    expect(alpaca.cancelled).toEqual([]);              // the incumbent's native stop is left alone
    expect(strategyOf("inc_spy")).toEqual({ strategy: "MOMENTUM", strategy_version: expect.any(String), status: "open" });
    expect(loadSleeveRows("momentum_stocks")).toHaveLength(1);
    const d = getPortfolioDecision("momentum_stocks", `momentum_stocks@${PE_VERSION}`, SESSION)!;
    expect(d.mode).toBe("observer");
    expect(d.status).toBe("observed");
    expect(d.orders.length).toBeGreaterThan(0);
    expect(d.orders.every(o => o.skipped === "observer" && o.clientOrderId === null && !o.applied)).toBe(true);
    expect(d.book).toEqual([{ symbol: "SPY", qty: 10, avgEntryPrice: 500 }]); // its book IS the incumbent's rows
  });

  test("an observer is not a manager: the sleeve is not in the cutover set (the incumbent is built)", () => {
    const wiring = resolve([peDefinition("momentum_stocks", { runMode: "observer" })]);
    expect(wiring.live).toEqual([]);
    const built = buildPortfolioEngines(wiring, sources(fakeAlpaca()).src);
    expect([...built.live.keys()]).toEqual([]);
  });
});

describe("live (cutover)", () => {
  test("adopts the open rows WITHOUT closing or rebuying, releases the incumbent's stops, orders only the delta", async () => {
    // SPY is already at the target weight (10 × 500 = 5000 of 10 000 capital): no SPY order at all.
    seedOpenTrade("inc_spy", "momentum_stocks", { symbol: "SPY", strategy: "MOMENTUM", entryPrice: 500, quantity: 10 });
    const alpaca = fakeAlpaca();
    alpaca.brokerPositions = [{ symbol: "SPY", quantity: 10, avgEntryPrice: 500 }];
    alpaca.stops = [
      { id: "stop-spy", clientOrderId: "uc8-momentum_stocks-abc", symbol: "SPY", side: "sell" },
      { id: "stop-other", clientOrderId: "uc8-meanrev_stocks-abc", symbol: "NVDA", side: "sell" },
    ];
    const wiring = resolve([peDefinition("momentum_stocks", { runMode: "live" })]);
    expect(wiring.live).toHaveLength(1);
    const built = buildPortfolioEngines(wiring, sources(alpaca).src);
    expect([...built.live.keys()]).toEqual(["momentum_stocks"]);
    const rep = await built.live.get("momentum_stocks")!.tick();
    expect(rep.status).toBe("submitted");
    expect(getPortfolioDecision("momentum_stocks", `momentum_stocks@${PE_VERSION}`, SESSION)!.orders.every(o => o.filledAt === NOW)).toBe(true);
    // adoption: same row, re-tagged, still open, same quantity — no close, no rebuy
    expect(strategyOf("inc_spy")).toEqual({ strategy: PORTFOLIO_ENGINE_STRATEGY, strategy_version: `momentum_stocks@${PE_VERSION}`, status: "open" });
    expect((getDB().prepare("SELECT quantity FROM trades WHERE id='inc_spy'").get() as any).quantity).toBe(10);
    expect(alpaca.orders.map(o => `${o.side} ${o.symbol}`)).toEqual(["buy TLT"]);
    expect(alpaca.orders[0].client_order_id).toBe(portfolioClientOrderId("momentum_stocks", SESSION, "TLT"));
    // the incumbent's resting stop on the adopted symbol is gone; another sleeve's is not ours to touch
    expect(alpaca.cancelled).toEqual(["stop-spy"]);
    expect(getDB().prepare("SELECT COUNT(*) c FROM activity_log WHERE message LIKE '%released 1 incumbent stop%'").get()).toEqual({ c: 1 });
    // and a second pass for the same session does nothing
    expect((await built.live.get("momentum_stocks")!.tick()).status).toBe("already_done");
    expect(alpaca.orders).toHaveLength(1);
  });

  test("adopted rows are out of the stop machinery: a -10% breach closes the control row, not the PORTFOLIO one", async () => {
    seedOpenTrade("inc_spy", "momentum_stocks", { symbol: "SPY", strategy: "MOMENTUM", entryPrice: 100, quantity: 10 });
    seedOpenTrade("ctl_aapl", "meanrev_stocks", { symbol: "AAPL", strategy: "MEANREV", entryPrice: 100, quantity: 10 });
    const alpaca = fakeAlpaca();
    alpaca.brokerPositions = [{ symbol: "SPY", quantity: 10, avgEntryPrice: 100 }];
    const built = buildPortfolioEngines(resolve([peDefinition("momentum_stocks", { runMode: "live" })]), sources(alpaca).src);
    await built.live.get("momentum_stocks")!.tick();
    expect(strategyOf("inc_spy").strategy).toBe(PORTFOLIO_ENGINE_STRATEGY);
    expect(await breach()).toEqual(["AAPL"]);
  });
});

async function withMarketOpen<T>(fn: () => Promise<T>): Promise<T> {
  const realDate = Date;
  const openNow = realDate.parse("2026-07-24T14:00:00.000Z");
  globalThis.Date = class extends realDate {
    constructor(...args: any[]) { super(args.length ? args[0] : openNow); }
    static now() { return openNow; }
  } as DateConstructor;
  const realLog = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = realLog; globalThis.Date = realDate; }
}
/** One 15s stop-loss pass with the price 10% under every entry: which symbols did it close? */
async function breach(): Promise<string[]> {
  const closed: string[] = [];
  const manager = makeAccountManager({ alpaca: {
    isConnected: () => true, getCachedPrice: () => 0, getRiskPrice: async () => 90,
    closePosition: async (symbol: string) => { closed.push(symbol); return { success: true, filledPrice: 90, commission: 0 }; },
  } });
  await withMarketOpen(() => (manager as any).checkAllStopLoss());
  return closed;
}

describe("rollback by configuration", () => {
  test("live → rollback: the rows go back to the incumbent and its stop machinery manages them again", async () => {
    seedOpenTrade("inc_spy", "momentum_stocks", { symbol: "SPY", strategy: "MOMENTUM", entryPrice: 100, quantity: 10 });
    const alpaca = fakeAlpaca();
    alpaca.brokerPositions = [{ symbol: "SPY", quantity: 10, avgEntryPrice: 100 }];
    const built = buildPortfolioEngines(resolve([peDefinition("momentum_stocks", { runMode: "live" })]), sources(alpaca).src);
    await built.live.get("momentum_stocks")!.tick();                    // adopts SPY, buys TLT
    expect(loadSleeveRows("momentum_stocks").every(r => r.strategy === PORTFOLIO_ENGINE_STRATEGY)).toBe(true);
    expect(await breach()).toEqual([]);                                  // exempt while the engine owns them

    // Next boot: the definition is back to observer (same function main() calls, before any incumbent starts).
    const after = resolve([peDefinition("momentum_stocks", { runMode: "observer" })]);
    expect(after.live).toEqual([]);
    const alerts: string[] = [];
    const report = await restoreIncumbentRows({ momentum_stocks: "incumbent", meanrev_stocks: "incumbent", momentum_crypto: "incumbent", momentum_crypto_usdc: "incumbent" }, { alert: (_c, m) => alerts.push(m) });
    expect(report.handedBack.momentum_stocks.map(r => r.symbol).sort()).toEqual(["SPY", "TLT"]);
    expect(loadSleeveRows("momentum_stocks").map(r => r.strategy)).toEqual(["MOMENTUM", "MOMENTUM"]);
    expect(alerts.some(a => a.includes("handed back"))).toBe(true);
    expect(await breach()).toEqual(["SPY"]);                             // protected again: the 15s loop closes the breach (TLT: bought at the mark, no breach)
  });

  test("definition REMOVED behaves like observer-off: rows handed back, nothing left unmanaged", async () => {
    seedOpenTrade("inc_spy", "momentum_stocks", { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY });
    expect(resolve([]).live).toEqual([]);
    const report = await restoreIncumbentRows({ momentum_stocks: "incumbent" }, { alert: () => {} });
    expect(Object.keys(report.handedBack)).toEqual(["momentum_stocks"]);
    expect(strategyOf("inc_spy").strategy).toBe("MOMENTUM");
  });
});

describe("construction failures leave the sleeve to the incumbent", () => {
  test("a live engine that cannot be built is NOT in the cutover set and pages", () => {
    const wiring = resolve([peDefinition("momentum_stocks", { runMode: "live" })]);
    const noClient = { ...fakeAlpaca().executor, client: undefined };
    const built = buildPortfolioEngines(wiring, sources(null, { alpacaExecutor: noClient as any }).src);
    expect(built.live.size).toBe(0);
    expect(built.problems.map(p => p.message).join(" ")).toContain("the incumbent keeps managing the sleeve");
    const noExec = buildPortfolioEngines(wiring, sources(null, { alpacaExecutor: null }).src);
    expect(noExec.live.size).toBe(0);
    const noHist = buildPortfolioEngines(wiring, sources(fakeAlpaca(), { historicalDb: () => { throw new Error("unable to open database file"); } }).src);
    expect(noHist.live.size).toBe(0);
    expect(noHist.problems[0]).toMatchObject({ definitionId: "pe_momentum_stocks", sleeve: "momentum_stocks", severity: "live_refused" });
  });
  test("an observer that cannot be built is ignored with a problem; it never blocks the incumbent", () => {
    const wiring = resolve([peDefinition("momentum_stocks", { runMode: "observer" })]);
    const built = buildPortfolioEngines(wiring, sources(null, { alpacaExecutor: null }).src);
    expect(built.observers).toEqual([]);
    expect(built.problems[0].severity).toBe("ignored");
  });
});

describe("heartbeat and scheduler", () => {
  test("start() registers the plan's heartbeat (daily, grace 5) and a tick beats it; stop() clears the timers", async () => {
    const alpaca = fakeAlpaca();
    const wiring = resolve([peDefinition("momentum_stocks", { runMode: "observer" })]);
    const s = sources(alpaca, { engineOverrides: { decide: fixedDecide({ SPY: 0.5 }), tradingEnabled: () => true, tickMs: 3_600_000 } });
    const built = buildPortfolioEngines(wiring, s.src);
    const stop = startPortfolioEngines(built.observers);
    expect(s.registered).toEqual([["portfolio:momentum_stocks", 86_400_000, { graceMultiplier: 5 }]]);
    await built.observers[0].tick();
    expect(s.beats).toContain("portfolio:momentum_stocks");
    stop();
  });
  test("stocks: not due before 09:35 ET or on a closed day (beats, decides nothing); crypto runs at 00:00:15 UTC", async () => {
    const alpaca = fakeAlpaca();
    const wiring = resolve([peDefinition("momentum_stocks", { runMode: "observer" })]);
    let now = Date.parse("2026-10-20T13:34:00Z"); // 09:34 ET
    const s = sources(alpaca, { now: () => now });
    const built = buildPortfolioEngines(wiring, s.src);
    expect((await built.observers[0].tick()).status).toBe("not_due");
    now = Date.parse("2026-10-24T15:00:00Z"); // Saturday
    expect((await built.observers[0].tick()).status).toBe("not_due");
    expect(s.beats).toEqual(["portfolio:momentum_stocks", "portfolio:momentum_stocks"]);
    expect(listPortfolioDecisions("momentum_stocks")).toEqual([]);
  });
});

describe("Reg-T buying power guard of the shared Alpaca wallet", () => {
  test("a buy beyond the account's buying power is blocked PRE-submit (reported, never sent); sells are never guarded", async () => {
    seedOpenTrade("inc_gld", "momentum_stocks", { symbol: "GLD", strategy: "MOMENTUM", entryPrice: 200, quantity: 5 });
    const alpaca = fakeAlpaca();
    alpaca.brokerPositions = [{ symbol: "GLD", quantity: 5, avgEntryPrice: 200 }];
    alpaca.buyingPower = 100; // $100 of Reg-T buying power: nothing fits
    const s = sources(alpaca);
    const built = buildPortfolioEngines(resolve([peDefinition("momentum_stocks", { runMode: "live" })]), s.src);
    const rep = await built.live.get("momentum_stocks")!.tick();
    expect(rep.status).toBe("submitted");
    expect(rep.rejected).toBe(2); // SPY and TLT buys
    expect(alpaca.orders.map(o => `${o.side} ${o.symbol}`)).toEqual(["sell GLD"]); // the sell went, the buys never reached the broker
    const d = getPortfolioDecision("momentum_stocks", `momentum_stocks@${PE_VERSION}`, SESSION)!;
    expect(d.orders.filter(o => o.result?.status === "insufficient_buying_power")).toHaveLength(2);
    expect(s.alerts.join(" ")).toContain("insufficient_buying_power");
  });

  test("fails OPEN when buying power is unreadable (the broker stays the real enforcer)", async () => {
    for (const bp of [null, "throw"] as const) {
      getDB().exec("DELETE FROM trades; DELETE FROM portfolio_decisions;");
      const alpaca = fakeAlpaca();
      alpaca.buyingPower = bp;
      const built = buildPortfolioEngines(resolve([peDefinition("momentum_stocks", { runMode: "live" })]), sources(alpaca).src);
      await built.live.get("momentum_stocks")!.tick();
      expect(alpaca.orders.map(o => o.symbol)).toEqual(["SPY", "TLT"]);
    }
  });
});

describe("treasury sweep (BOXX) interplay", () => {
  test("buys find cash the way the incumbents' do: margin buying power, not account cash (no pre-sell)", async () => {
    // The sweep parked the cash in BOXX and the account is on margin (cash −$20k): sizing is the sleeve ledger's,
    // the only gate is buying power. BOXX is not in the sleeve's universe, so the engine never sees it.
    const alpaca = fakeAlpaca();
    alpaca.brokerPositions = [{ symbol: "BOXX", quantity: 800, avgEntryPrice: 100 }];
    alpaca.executor.getAccount = async () => ({ cash: "-20000", equity: "100000" });
    alpaca.buyingPower = 150_000;
    const built = buildPortfolioEngines(resolve([peDefinition("momentum_stocks", { runMode: "live" })]), sources(alpaca).src);
    await built.live.get("momentum_stocks")!.tick();
    expect(alpaca.orders.map(o => `${o.side} ${o.symbol}`)).toEqual(["buy SPY", "buy TLT"]);
    expect(loadSleeveRows("momentum_stocks").map(r => r.symbol).sort()).toEqual(["SPY", "TLT"]);
  });

  test("the 15:50 cover sells ONLY the treasury ETF, never a position of the portfolio sleeve", async () => {
    const placed: Array<{ symbol: string; side: string }> = [];
    const broker = {
      isConnected: () => true,
      getAccount: async () => ({ cash: "-5000", equity: "100000" }),
      getPositions: async () => [
        { symbol: "BOXX", quantity: 200, avgEntryPrice: 100 },
        { symbol: "SPY", quantity: 10, avgEntryPrice: 500 },
        { symbol: "TLT", quantity: 33, avgEntryPrice: 90 },
      ],
      getLatestPrice: async () => 100,
      placeOrder: async (signal: any) => { placed.push({ symbol: signal.symbol, side: signal.side }); return { id: "x", symbol: signal.symbol, side: signal.side, status: "filled" } as any; },
    };
    const sweep = new TreasurySweep({ symbol: "BOXX", cashBufferPct: 0.1 }, broker as any, () => true);
    await sweep.tick(Date.parse("2026-10-20T19:55:00Z")); // 15:55 ET: the cover window
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every(o => o.symbol === "BOXX" && o.side === "sell")).toBe(true);
  });
});

// ── Binance: durable claims, no order without them ───────────────────────────

function fakeBinance() {
  const requests: Array<{ method: string; path: string; p: Record<string, string> }> = [];
  const orders = new Map<string, any>();
  let position = 0;
  const transport = {
    kind: "fake",
    async publicRequest(path: string, query: Record<string, string> = {}) {
      requests.push({ method: "GET", path, p: query });
      if (path === "/fapi/v1/exchangeInfo") {
        return Response.json({ symbols: ["BTCUSDC", "ETHUSDC"].map(symbol => ({ symbol, status: "TRADING", contractType: "PERPETUAL", marginAsset: "USDC", filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.1", minPrice: "0.1", maxPrice: "1000000" },
          { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
          { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
        ] })) });
      }
      if (path === "/fapi/v1/premiumIndex") return Response.json({ symbol: query.symbol, markPrice: "50000" });
      throw new Error(`unexpected public ${path}`);
    },
    async serverTime() { return Response.json({ serverTime: NOW }); },
    async signedRequest(method: string, path: string, p: Record<string, string> = {}) {
      requests.push({ method, path, p });
      if (path === "/fapi/v1/positionSide/dual") return { dualSidePosition: false };
      if (path === "/fapi/v2/positionRisk") return position > 0 ? [{ symbol: "BTCUSDC", positionSide: "BOTH", positionAmt: String(position), entryPrice: "50000" }] : [];
      if (path === "/fapi/v1/openOrders") return [];
      if (path === "/fapi/v1/openAlgoOrders") return { orders: [] };
      if (method === "GET" && path === "/fapi/v1/order") {
        const o = orders.get(p.origClientOrderId);
        if (!o) throw Object.assign(new Error("Order does not exist"), { code: -2013 });
        return o;
      }
      if (method === "POST" && path === "/fapi/v1/order" && p.type === "MARKET") {
        const o = { symbol: p.symbol, orderId: orders.size + 1, status: "FILLED", executedQty: p.quantity, avgPrice: "50000", cumQuote: "0" };
        orders.set(p.newClientOrderId, o);
        position += Number(p.quantity);
        return o;
      }
      throw new Error(`unexpected signed ${method} ${path}`);
    },
  } as unknown as BinanceUsdmTransport;
  return { transport, requests, orders };
}

function cryptoHist() {
  const sessions = weekdaySessions(AS_OF, 300).concat([]); // calendar gaps are irrelevant to the fake decide
  return makeHistDb({ "BTC/USD": { sessions }, "ETH/USD": { sessions } }, 0);
}

describe("Binance venue (momentum_crypto_usdc)", () => {
  const crypto = (runMode: "observer" | "live") => resolve([peDefinition("momentum_crypto_usdc", { runMode })]);
  const cryptoSources = (fake: ReturnType<typeof fakeBinance>) => sources(null, {
    binanceTransports: { binance_usdc: fake.transport }, historicalDb: () => cryptoHist(),
    engineOverrides: { decide: fixedDecide({ "BTC/USDC": 0.5 }), tradingEnabled: () => true, alert: () => {} },
  });

  test("observer reads, sends no order and claims no id", async () => {
    const fake = fakeBinance();
    const built = buildPortfolioEngines(crypto("observer"), cryptoSources(fake).src);
    expect(built.problems).toEqual([]);
    expect((await built.observers[0].tick()).status).toBe("observed");
    expect(fake.requests.filter(r => r.method !== "GET")).toEqual([]);
    expect(getDB().prepare("SELECT COUNT(*) c FROM portfolio_order_claims").get()).toEqual({ c: 0 });
  });

  test("live: the order id is claimed in the DB BEFORE the POST; the row is a PORTFOLIO row in the USDC symbol space", async () => {
    const fake = fakeBinance();
    const built = buildPortfolioEngines(crypto("live"), cryptoSources(fake).src);
    expect([...built.live.keys()]).toEqual(["momentum_crypto_usdc"]);
    const rep = await built.live.get("momentum_crypto_usdc")!.tick();
    expect(rep.status).toBe("submitted");
    const posts = fake.requests.filter(r => r.method === "POST" && r.p.type === "MARKET");
    expect(posts).toHaveLength(1);
    expect(posts[0].p.symbol).toBe("BTCUSDC");
    const claims = getDB().prepare("SELECT id FROM portfolio_order_claims").all() as any[];
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe(posts[0].p.newClientOrderId);
    const rows = loadSleeveRows("momentum_crypto_usdc");
    expect(rows.map(r => [r.symbol, r.strategy])).toEqual([["BTC/USDC", PORTFOLIO_ENGINE_STRATEGY]]);
  });
});
