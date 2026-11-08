import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeTestDb, seedOpenTrade } from "../test-support/db";
import { currentModelVersionId } from "../portfolio/modelVersions";
import { buildBotNow, nextBotDecision, type BotNowDeps, type BotNowRuntime } from "./botNow";
import type { VolManagedConfig } from "../portfolio-engine/types";

const NOW = Date.parse("2026-11-07T16:00:00Z"); // after RW10; still a Saturday
const resources: Database[] = [];
afterEach(() => { for (const db of resources.splice(0)) db.close(); });
function fixture(id = "momentum_crypto", engine: BotNowRuntime["engine"] = "momentum") {
  const db = makeTestDb(); resources.push(db);
  const runtime: BotNowRuntime = { id, engine, maxGrossX: engine === "portfolio" ? 2.5 : 1.725, cadenceMinutes: id.includes("stocks") || id.endsWith("usdc") ? 1440 : 60, statePath: "synthetic.json" };
  const deps: BotNowDeps = { db, now: NOW, runtime: [runtime], summaries: [{ id, label: "One human label", broker: id.includes("stocks") ? "alpaca" : "binance", equity: 1000 }], readState: () => null };
  const pass = (over: Record<string, any> = {}) => {
    const row = { account_id: id, ts: NOW - 60_000, universe: 8, evaluated: 8, signals_long: 0, signals_raw_long: null, entries: 0, exits: 0, blocks: "{}", block_note: null, ...over };
    db.query(`INSERT INTO decision_passes (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  };
  const pe = (over: Record<string, any> = {}) => {
    const row = { account_id: id, strategy_version: currentModelVersionId(id)!, session: "2026-10-23", as_of: "2026-10-22", mode: "live", status: "submitted", equity: 1000, book_json: "[]", weights_json: "{}", stops_json: "[]", memory_json: "{}", diagnostics_json: "{}", orders_json: "[]", note: null, decided_at: NOW - 60_000, updated_at: NOW - 30_000, ...over };
    db.query(`INSERT INTO portfolio_decisions (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  };
  const activity = (message: string, type = "trade", at = NOW - 10_000) => db.query("INSERT INTO activity_log (account_id,event_type,message,created_at) VALUES (?,?,?,?)").run(id, type, message, at);
  const order = (over: Record<string, any> = {}) => {
    const row = { id: crypto.randomUUID(), account_id: id, symbol: "BTC/USD", market: "crypto", side: "buy", type: "market", quantity: 2, price: 100, status: "filled", created_at: NOW - 30_000, updated_at: NOW - 20_000, filled_at: NOW - 20_000, filled_price: 101, ...over };
    db.query(`INSERT INTO orders (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  };
  const build = () => { db.exec("PRAGMA query_only=ON"); return buildBotNow(deps); };
  return { db, deps, runtime, pass, pe, activity, order, build };
}
const filled = (side: "buy" | "sell", symbol: string, currentWeight: number, targetWeight: number, qty = 2, price = 100) => ({
  intent: { side, symbol, qty, notional: qty * price, currentWeight, targetWeight, reduceOnly: side === "sell" },
  applied: true, clientOrderId: "synthetic", result: { ok: true, filledQty: qty, avgPrice: price, status: "filled", brokerOrderId: symbol },
});

describe("bot now: states and live sources", () => {
  test("inverse BTC notional uses $100 contract size for the book and close events", () => {
    const f = fixture("momentum_btc");
    f.deps.summaries = [{ id: "momentum_btc", label: "Inverse", broker: "binance_coinm", equity: 1000 }];
    f.deps.positions = [{ profileId: "momentum_btc", symbol: "BTC/USD", quantity: 6, currentPrice: 76000, avgEntryPrice: 75000 }];
    seedOpenTrade("inverse", "momentum_btc", { symbol: "BTC/USD", market: "crypto", quantity: 6, entryPrice: 75000 });
    f.db.query("UPDATE trades SET status='closed', exit_time=?, exit_price=76000, pnl=8 WHERE id='inverse'").run(NOW - 1000);
    const result = f.build();
    expect(result.portfolios[0].investedUsd).toBe(600);
    expect(result.portfolios[0].grossX).toBe(0.6);
    expect(result.events.find(e => e.kind === "close")?.usd).toBe(600);
  });

  test("only recent journal rows plus each version's latest are loaded; old orders cannot hide current events", () => {
    const f = fixture("momentum_stocks", "portfolio");
    f.pe({ session: "old", decided_at: NOW - 9 * 86400000, updated_at: NOW - 9 * 86400000,
      orders_json: JSON.stringify([filled("buy", "old-id", 0, 1)]) });
    f.pe({ session: "latest", decided_at: NOW - 8 * 86400000, updated_at: NOW - 8 * 86400000 });
    f.order({ external_id: "old-id", symbol: "SPY", market: "stock" });
    const r = f.build();
    expect(r.portfolios[0].lastDecision?.at).toBe(NOW - 8 * 86400000);
    expect(r.events.some(e => e.kind === "buy" && e.symbol === "SPY")).toBe(true);
    expect(r.events.some(e => e.kind === "rebalance")).toBe(false);
  });

  test("flat/no_signal is raw signals, not a gate-filtered zero", () => {
    const f = fixture(); f.pass({ signals_long: 0, signals_raw_long: 2, block_note: "regime: vol spike", blocks: '{"regime":2}' });
    const p = f.build().portfolios[0];
    expect(p.state).toBe("flat"); expect(p.lastDecision?.signalsLong).toBe(2);
    expect(p.blocked?.reason).toBe("regime");
  });
  test("zero on the eight-coin universe explains a flat book", () => {
    const f = fixture(); f.pass();
    const p = f.build().portfolios[0];
    expect(p.state).toBe("flat"); expect(p.blocked?.reason).toBe("no_signal");
    expect(p.lastDecision).toMatchObject({ entries: 0, exits: 0, resizes: 0, orders: 0, rejected: 0, universe: 8 });
  });
  test("live marked positions/equity win over stale DB account values", () => {
    const f = fixture(); f.pass(); seedOpenTrade("old", "momentum_crypto", { quantity: 999, entryPrice: 999 });
    f.deps.positions = [{ profileId: "momentum_crypto", quantity: 10, currentPrice: 100, avgEntryPrice: 90 }];
    const p = f.build().portfolios[0];
    expect(p).toMatchObject({ label: "One human label", positions: 1, equityUsd: 1000, investedUsd: 1000, grossX: 1, maxGrossX: 1.725, state: "invested" });
  });
  test("partly invested means below 90% of equity, not below a 2.5x leverage ceiling", () => {
    const f = fixture(); f.pass();
    f.deps.positions = [{ profileId: "momentum_crypto", quantity: 5, currentPrice: 100, avgEntryPrice: 90 }];
    expect(f.build().portfolios[0].state).toBe("partly_invested");
  });
  for (const [detail, reason] of [["soft drawdown 16.9% — paused 24h", "soft_drawdown"], ["hard drawdown 20%", "hard_drawdown"], ["5 consecutive losses", "loss_streak"]]) {
    test(`paused: ${reason}, still exposes open positions and λ`, () => {
      const f = fixture("momentum_crypto_usdc"); f.pass();
      seedOpenTrade("held", "momentum_crypto_usdc");
      f.deps.readState = () => ({ v: 1, risk: { peakEquity: 1200, pausedUntil: NOW + 3600_000, pauseReason: detail }, exposureFracs: { "BTC/USDC|buy": 0.794 } });
      const p = f.build().portfolios[0];
      expect(p.state).toBe("paused"); expect(p.positions).toBe(1); expect(p.exposureScale).toBe(0.794);
      expect(p.drawdownPct).toBeCloseTo(100 / 6); expect(p.blocked).toEqual({ reason, detail, until: NOW + 3600_000 });
    });
  }
  test("an expired risk pause is not a current pause, live risk wins over disk", () => {
    const f = fixture(); f.pass();
    f.deps.readState = () => ({ risk: { peakEquity: 1200, pausedUntil: NOW + 3600_000, pauseReason: "hard drawdown" } });
    f.runtime.risk = { peakEquity: 1000, pausedUntil: NOW - 1, pauseReason: "hard drawdown" } as any;
    expect(f.build().portfolios[0]).toMatchObject({ state: "flat", drawdownPct: 0, blocked: { reason: "no_signal" } });
  });
  test("close-only/missing engine is maintenance, with no imaginary schedule/cap", () => {
    const f = fixture(); f.deps.runtime = [];
    expect(f.build().portfolios[0]).toMatchObject({ state: "paused", maxGrossX: null, nextDecisionAt: null, blocked: { reason: "maintenance" } });
  });
  test("new portfolio version waits its first pass while retaining the inherited book", () => {
    const f = fixture("momentum_stocks", "portfolio");
    f.pe({ strategy_version: "momentum_stocks@pe-vt15" });
    f.deps.positions = [{ profileId: "momentum_stocks", quantity: 9.7, currentPrice: 100, avgEntryPrice: 90 }];
    f.deps.readState = () => ({ risk: { peakEquity: 99999, pausedUntil: NOW + 99999, pauseReason: "hard drawdown" } });
    const p = f.build().portfolios[0];
    expect(p).toMatchObject({ version: "momentum_stocks@pe-vt45-g250-sma200-fv5-mh5-stagger-sh50-etf2x", state: "waiting_first_pass", positions: 1, maxGrossX: 2.5, lastDecision: null, drawdownPct: null, nextDecisionAt: Date.parse("2026-11-09T14:35:00Z") });
    expect(p.grossX).toBeCloseTo(0.97);
    expect(p.blocked?.reason).toBe("market_closed");
  });
  test("portfolio failures show error and never reuse an incumbent decision pass", () => {
    const f = fixture("momentum_stocks", "portfolio"); f.pass(); f.pe({ status: "failed", note: "no current data" });
    expect(f.build().portfolios[0]).toMatchObject({ state: "error", lastDecision: { note: "no current data" }, blocked: { reason: "failed" } });
  });
  test("a portfolio engine's own decision_passes row (Q7 V1 funnel telemetry) never feeds its bot-now card: journal only", () => {
    const f = fixture("momentum_stocks", "portfolio");
    f.pass({ universe: 3, evaluated: 3, signals_long: 2, signals_raw_long: 2, entries: 1, exits: 1, blocks: JSON.stringify({ rejected: 1 }), block_note: "buy TLT: rejected (insufficient buying power)" });
    f.pe({ orders_json: JSON.stringify([filled("buy", "SPY", 0, 0.5)]) });
    const p = f.build().portfolios[0];
    expect(p.lastDecision).toMatchObject({ at: NOW - 60_000, entries: 1, exits: 0, orders: 1, rejected: 0, signalsLong: null, note: null });
    expect(p.blocked?.reason).toBe("market_closed"); // not the pass's block_note
    expect(p.state).toBe("flat"); // no open rows: the pass's entries never stand in for positions
  });
  test("momentum has no first pass if only a previous model's decision exists", () => {
    const f = fixture(); f.pass({ ts: Date.parse("2026-10-22T12:00:00Z") });
    expect(f.build().portfolios[0]).toMatchObject({ state: "waiting_first_pass", lastDecision: null });
  });
  test("regime uses the current definition's price view, not an old version's state", () => {
    const f = fixture("momentum_stocks", "portfolio");
    const hist = new Database(":memory:"); resources.push(hist);
    hist.exec("CREATE TABLE historical_bars(symbol TEXT,timeframe TEXT,timestamp INTEGER,open REAL,high REAL,low REAL,close REAL,volume REAL)");
    for (const [i, close] of [100, 100, 115].entries()) hist.query("INSERT INTO historical_bars VALUES ('SPY','1d',?,?,?,?,?,100)").run(Date.parse(`2026-11-0${4 + i}T05:00:00Z`), close, close, close, close);
    f.runtime.strategy = { kind: "volManaged", maxGross: 2.5, regimeOverlay: { signals: [{ kind: "maTrend", symbol: "SPY", period: 3, sampling: "daily", bandPct: 1 }], combine: "all", coreScale: 0 } } as VolManagedConfig;
    f.deps.historical = hist;
    f.pe({ strategy_version: "momentum_stocks@pe-vt15", memory_json: '{"portfolioCore":{"regime":{"riskOff":true,"ready":true}}}' });
    expect(f.build().portfolios[0].regime).toEqual({ riskOn: true, ref: "SPY", distancePct: (115 / 105 - 1) * 100 });
  });
});

describe("bot now: causal events", () => {
  test("one portfolio rebalance, actual traded dollars, no duplicate orders or full closes", () => {
    const f = fixture("momentum_stocks", "portfolio");
    const orders = [filled("buy", "NEW", 0, 0.2), filled("sell", "OLD", 0.2, 0), filled("buy", "KEPT", 0.1, 0.2, 1)];
    f.pe({ orders_json: JSON.stringify([...orders, { ...filled("buy", "BAD", 0, 0.2), result: { ok: false, filledQty: 0, status: "rejected" } }]) });
    f.order({ symbol: "NEW", external_id: "NEW" });
    seedOpenTrade("old", "momentum_stocks", { symbol: "OLD" });
    f.db.query("UPDATE trades SET status='closed', exit_time=?, exit_price=100, close_reason='PORTFOLIO_REBALANCE' WHERE id='old'").run(NOW - 30_000);
    const result = f.build();
    expect(result.events.filter(e => e.kind === "rebalance")).toHaveLength(1);
    expect(result.events.filter(e => e.kind === "buy" || e.kind === "close")).toHaveLength(0);
    expect(result.events.find(e => e.kind === "rebalance")).toMatchObject({ usd: 500, buys: 2, sells: 1, detail: null });
    expect(result.portfolios[0].lastDecision).toMatchObject({ entries: 1, exits: 1, resizes: 1, orders: 4, rejected: 1 });
  });
  test("portfolio order outcomes distinguish broker rejections from partial and unfilled timeouts", () => {
    const f = fixture("momentum_stocks", "portfolio");
    const failed = (symbol: string, result: Record<string, any>) => ({ ...filled("buy", symbol, 0, 0.2), result });
    f.pe({ orders_json: JSON.stringify([
      failed("REJECTED", { ok: false, filledQty: 0, status: "rejected" }),
      failed("PARTIAL", { ok: false, filledQty: 1, status: "canceled" }),
      failed("UNFILLED", { ok: false, filledQty: 0, status: "expired" }),
      failed("CAP", { ok: false, filledQty: 0, status: "account_gross_cap" }),
    ]) });
    const result = f.build();
    expect(result.portfolios[0].lastDecision).toMatchObject({ rejected: 1, partial: 1, unfilled: 1, accountGrossCap: 1 });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", reason: "REJECTED", count: 1, detail: null }),
      expect.objectContaining({ kind: "warning", reason: "PARTIAL", count: 1, detail: null }),
      expect.objectContaining({ kind: "warning", reason: "UNFILLED", count: 1, detail: null }),
      expect.objectContaining({ kind: "warning", reason: "ACCOUNT_GROSS_CAP", count: 1, detail: null }),
    ]));
  });

  test("broker 9-decimal rounding and a completed same-pass close retry are not partial fills", () => {
    const f = fixture("momentum_stocks", "portfolio");
    const qty = 14.181331139000001;
    const leg = (symbol: string, clientOrderId: string, filledQty: number, status: string, q = qty) =>
      ({ ...filled("sell", symbol, 0.2, 0.2, q), clientOrderId, result: { ok: status === "filled", filledQty, avgPrice: 100, status, brokerOrderId: clientOrderId } });
    f.pe({ orders_json: JSON.stringify([
      leg("NVDA", "pf-nvda", 14.181331139, "filled"),          // complete: broker rounds to 9 decimals
      leg("GLD", "pf-gld", qty - 2e-10, "canceled"),           // cancel acknowledged after a complete fill
      leg("AAPL", "pf-aapl", 5, "canceled", 9.29),             // MAX_HOLD close remainder…
      leg("AAPL", "pf-aapl-r1", 4.29, "filled", 4.29),         // …filled by its same-pass retry
      leg("AMZN", "pf-amzn", 6, "canceled", 7.93),             // a real partial
    ]) });
    const result = f.build();
    expect(result.portfolios[0].lastDecision).toMatchObject({ rejected: 0, partial: 1, unfilled: 0, accountGrossCap: 0 });
  });
  test("resize, pause/resume, stop, cutover, treasury and rejected orders stay distinguishable", () => {
    const f = fixture("momentum_crypto_usdc"); f.pass();
    f.activity("Resized SOL/USDC ×0.794: −2.62 @ $102.65 (remaining 10.16) — exposure control: λ 0.794 vs kept 1.000");
    f.order({ symbol: "SOL/USDC", created_at: NOW - 15_000 }); // must not double-count the resize
    f.order({ symbol: "REJECTED/USDC", status: "rejected", filled_at: null });
    f.activity("pause_started: soft drawdown 16.9% — paused 24h", "circuit");
    f.activity("pause_resolved: soft drawdown 16.9% — paused 24h", "circuit");
    f.activity("tesorería: cash $-100 negative at EOD → SELL 2 BOXX @ ~$118.75 to restore buffer $100", "treasury");
    seedOpenTrade("stop", "momentum_crypto_usdc", { symbol: "STOP/USDC" });
    seedOpenTrade("cut", "momentum_crypto_usdc", { symbol: "CUT/USDC" });
    f.db.query("UPDATE trades SET status='closed', exit_time=?, exit_price=99, pnl=-1, close_reason='TRAIL_STOP' WHERE id='stop'").run(NOW - 1000);
    f.db.query("UPDATE trades SET status='closed', exit_time=?, exit_price=99, pnl=-1, close_reason='MODEL_CUTOVER' WHERE id='cut'").run(NOW - 2000);
    const result = f.build();
    expect(result.events.map(e => e.kind)).toEqual(expect.arrayContaining(["resize", "pause", "resume", "stop", "cutover", "treasury", "error"]));
    expect(result.events.filter(e => e.kind === "buy")).toHaveLength(0);
    expect(result.events.find(e => e.kind === "resize")).toMatchObject({ qty: -2.62, usd: -2.62 * 102.65, reason: "EXPOSURE_CONTROL", detail: null });
    expect(result.events.find(e => e.kind === "treasury")).toMatchObject({ reason: "TREASURY_COVER", symbol: "BOXX", usd: 237.5, portfolioId: null });
    expect(result.portfolios[0].lastDecision).toMatchObject({ resizes: 1, orders: 2, rejected: 1 });
  });
  test("events are newest first, last seven days only, at most 120", () => {
    const f = fixture();
    f.activity("too old", "error", NOW - 8 * 864e5);
    f.activity("from the future", "error", NOW + 1000);
    for (let i = 0; i < 125; i++) f.activity(String(i), "error", NOW - i * 1000);
    const events = f.build().events;
    expect(events).toHaveLength(120);
    expect(events[0].at).toBe(NOW); expect(events.at(-1)?.at).toBe(NOW - 119_000);
  });
  test("a 5-day limit pass: MAX_HOLD closes carry symbol/pnl/reason and the rebalance names the same-pass rebuys", () => {
    const f = fixture("momentum_stocks", "portfolio");
    const rebuy = (symbol: string) => ({ ...filled("buy", symbol, 0.1, 0.1), intent: { ...filled("buy", symbol, 0.1, 0.1).intent, maxHold: "rebuy" } });
    const close = (symbol: string) => ({ ...filled("sell", symbol, 0.1, 0), intent: { ...filled("sell", symbol, 0.1, 0).intent, maxHold: "close" } });
    f.pe({ orders_json: JSON.stringify([close("SPY"), rebuy("SPY"), close("QQQ"), filled("buy", "NEW", 0, 0.2, 2, 100)]) });
    for (const symbol of ["SPY", "QQQ"]) {
      seedOpenTrade(symbol, "momentum_stocks", { symbol });
      f.db.query("UPDATE trades SET status='closed', exit_time=?, exit_price=99, pnl=-210, close_reason='MAX_HOLD' WHERE id=?").run(NOW - 55_000, symbol);
    }
    const events = f.build().events;
    expect(events.filter(e => e.kind === "close")).toHaveLength(2);
    expect(events.filter(e => e.kind === "close")).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "SPY", pnlUsd: -210, reason: "MAX_HOLD", portfolioId: "momentum_stocks" })]));
    expect(events.find(e => e.kind === "rebalance")).toMatchObject({ buys: 2, sells: 2, rebought: ["SPY"], newBuyUsd: 200 });
  });
  test("a confirmed close and same-minute re-entry are not conflated", () => {
    const f = fixture();
    seedOpenTrade("old", "momentum_crypto", { symbol: "BTC/USD" });
    f.db.query("UPDATE trades SET status='closed', exit_time=?, exit_price=99, close_reason='TIME_STOP' WHERE id='old'").run(NOW - 25_000);
    f.order();
    expect(f.build().events.map(e => e.kind)).toEqual(["buy", "stop"]);
  });
});

describe("bot now: scheduler", () => {
  test("weekend, NYSE holiday and DST", () => {
    expect(nextBotDecision(NOW, true, 1440)).toBe(Date.parse("2026-11-09T14:35:00Z"));
    expect(nextBotDecision(Date.parse("2026-11-25T17:00:00Z"), true, 1440)).toBe(Date.parse("2026-11-27T14:35:00Z"));
    expect(nextBotDecision(Date.parse("2026-10-30T17:00:00Z"), true, 1440)).toBe(Date.parse("2026-11-02T14:35:00Z"));
  });
  test("hourly/daily use boundary +15s, including requests in the first fifteen seconds", () => {
    expect(nextBotDecision(Date.parse("2026-10-24T16:00:01Z"), false, 60)).toBe(Date.parse("2026-10-24T16:00:15Z"));
    expect(nextBotDecision(Date.parse("2026-10-24T16:00:15Z"), false, 60)).toBe(Date.parse("2026-10-24T17:00:15Z"));
    expect(nextBotDecision(NOW, false, 1440)).toBe(Date.parse("2026-11-08T00:00:15Z"));
  });
});
