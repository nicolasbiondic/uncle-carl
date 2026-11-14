import { afterEach, expect, test, spyOn } from "bun:test";
import express from "express";
import {
  getDB, saveEquitySnapshot, getETWindowStart, getETYesterday, getETDayBounds,
  getEquityPnlDisplay, getEquityWindowDisplay, getClosedEpisodeResult, accumulatePartialCloseLedger,
  closeTrade, recordFill, pruneEquitySnapshots, savePnlWindowMarks, closedEpisodePct,
} from "../db/database";
import { makeTestDb, seedOpenTrade } from "../test-support/db";
import { setBrokerTruthAvailable, readDisplayMoneyWindow, publishInvariantEpisodes } from "./truth";
import { readMoneyWindow, readSleeveMoney, readOpenMoney, readOutsideStrategies, tileMoney, readBinanceMarginBreakdown, moneyReportDate } from "./money";
import { computeRealizedAttribution } from "./pnlBreakdown";
import { applyBuyFill, applySellFill, reconcileRowToBroker } from "../portfolio-engine/live/rows";
import { registerProfileRoutes } from "../dashboard/routes/profiles";
import { registerStrategyRoutes } from "../dashboard/routes/strategies";
import { clearApiCache } from "../dashboard/cache";
import { TelegramReporter, fmtCloseAlert } from "../telegram/telegram-reporter";
import { DailyReporter } from "../reports/DailyReporter";
import { eventBus, EVENTS } from "../utils/events";
// @ts-ignore frontend ES module; exercise the real renderers, not a copy.
import { store } from "../dashboard/public/v4/js/store.js";
// @ts-ignore frontend ES module
import { kpiValues, renderKpis } from "../dashboard/public/v4/js/components/kpis.js";
// @ts-ignore frontend ES module
import { renderBreakdown } from "../dashboard/public/v4/js/components/pnl-breakdown.js";
// @ts-ignore frontend ES module
import { sinceStart, renderProfiles } from "../dashboard/public/v4/js/components/profiles.js";
// @ts-ignore frontend ES module
import { renderPositions, positionsTotals } from "../dashboard/public/v4/js/components/positions.js";
// @ts-ignore frontend ES module
import { renderTrades } from "../dashboard/public/v4/js/components/trades.js";
// @ts-ignore frontend ES module
import { strategyFigures, curveGeometry } from "../dashboard/public/v4/js/components/strategy-chart.js";
// @ts-ignore frontend ES module
import { boardModel, outsideLine } from "../dashboard/public/v4/js/components/board.js";

const NOW = Date.parse("2026-11-07T17:00:00Z");
const originalState = { ...store.state };
const clock = () => spyOn(Date, "now").mockReturnValue(NOW);
afterEach(() => { Object.assign(store.state, originalState); spyOn(Date, "now").mockRestore(); delete process.env.DISPLAY_HISTORY_START; clearApiCache(); });

test("one fixture: tiles 1/7/30/All, cards, since start, curve, bridge, digest, status and profits agree", async () => {
  clock(); makeTestDb(); clearApiCache();
  const bases = { alpaca_main: 100000, binance_main: 10000 };
  const time = getETWindowStart(1, NOW);
  for (const [id, initial] of Object.entries(bases)) {
    const scale = id === "alpaca_main" ? 1 : 0.1;
    for (const [at, move] of [[NOW - 40 * 86400000, 0], [getETWindowStart(30, NOW) - 60000, 100],
      [getETWindowStart(7, NOW) - 60000, 200], [time - 60000, 300], [time + 120000, 320], [NOW, 340.4]]) {
      saveEquitySnapshot(id, initial + move * scale, initial, 0, at);
    }
  }
  setBrokerTruthAvailable("alpaca", true); setBrokerTruthAvailable("binance", true);
  const cfg = { accountId: "momentum_stocks", strategyVersion: "test", market: "stock" as const, quoteAsset: "USD" };
  applyBuyFill(cfg, "SPY", 10, 100, time + 1000);
  applySellFill(cfg, "SPY", 4, 102.7, { nowMs: time + 2000 }); // +10.8, still open
  applySellFill(cfg, "SPY", 6, 104, { nowMs: time + 3000 });   // +24, episode +34.8
  applyBuyFill(cfg, "SPY", 10, 104, time + 4000);
  applySellFill(cfg, "SPY", 1, 105.6, { nowMs: time + 5000 }); // open partial +1.6
  const positions = [{ profileId: "momentum_stocks", symbol: "SPY", market: "stock", side: "buy", quantity: 9,
    avgEntryPrice: 104, currentPrice: 105, openedAt: time + 4000, unrealizedPnl: 9 }];
  const accounts = [{ id: "momentum_stocks", broker: "alpaca", equity: 50045.4, initialEquity: 50000, positions: 1, label: "Momentum Stocks" },
    { id: "meanrev_stocks", broker: "alpaca", equity: 50000, initialEquity: 50000, positions: 0, label: "MeanRev Stocks" },
    { id: "momentum_crypto", broker: "binance", equity: 5000, initialEquity: 5000, positions: 0, label: "Momentum Crypto" }];
  const am = { executor: { alpaca: { isConnected: () => true }, binance: { isConnected: () => true } },
    getAccountSummaries: () => accounts, getConsolidatedState: () => ({ positions }), getBrokerUnrealizedPnl: () => 9,
    getCircuits: () => ({}) } as any;
  const app = express(); registerProfileRoutes(app, am); registerStrategyRoutes(app, am);
  const server = app.listen(0); const { port } = server.address() as { port: number };
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).json() as Promise<any>;
  const reporter = new TelegramReporter(); reporter.openHist = () => null;
  reporter.getAccountSummaries = () => accounts; reporter.getConsolidatedState = am.getConsolidatedState;
  const sent: string[] = []; (reporter as any).send = async (s: string) => { sent.push(s); return true; };
  try {
    for (const days of [1, 7, 30, 0]) {
      const [profile] = await get(`/api/v2/profiles?days=${days}`);
      const agg = profile.pnlAggregate;
      const w = readDisplayMoneyWindow(["alpaca_main", "binance_main"], days)!;
      expect(agg.periodPnl).toBe(w.pnl);
      // The All tile is the since-start figure: it carries the same percentage as the sub-line.
      expect(agg.periodPnlPct).toBe(days === 0 ? w.pnlPct ?? w.pnlPctOnStart ?? null : w.pnlPct);
      expect(profile.brokerAccounts.reduce((s: number, b: any) => s + b.stats.periodEquityPnl, 0)).toBeCloseTo(w.pnl, 8);
      const rows = await get(`/api/equity/history?account=consolidated&days=${days}`);
      expect(rows.at(-1).moneyWindow.pnl).toBe(w.pnl);
      expect(rows.at(-1).equity - rows[0].equity).toBeCloseTo(w.pnl, 8);
      const modal = await get(`/api/v2/pnl-breakdown?days=${days}`);
      expect(modal.pnl).toBe(w.pnl);
      expect(agg.periodBreakdown.closedInWindow).toBe(modal.closedInWindow);
      const rounded = agg.periodBreakdown.rounded;
      expect(rounded.closes + rounded.positions).toBe(Math.round(w.pnl));
      expect(modal.rounded).toEqual(rounded);
      const state = { ...store.state, profiles: [profile], dashboard: { accounts }, view: "consolidated", period: days };
      Object.assign(store.state, state);
      expect(kpiValues(state).periodPnl).toBe(w.pnl);
      expect(sinceStart(state).pnl).toBe(agg.sinceStart.pnl);
      expect(sinceStart(state).displayStart).toEqual(agg.displayStart);
      const all = readDisplayMoneyWindow(["alpaca_main", "binance_main"], 0)!;
      expect(sinceStart(state).pct).toBe(all.pnlPct ?? all.pnlPctOnStart ?? null);
      expect(all.pnlPctOnStart).toBeCloseTo(all.pnl / all.start.equity * 100, 9);
      expect(renderBreakdown(modal)).toContain(`$${Math.abs(rounded.positions).toLocaleString("en-US")}`);
      const daily = readMoneyWindow({ days: 1 });
      expect(daily.breakdown.realized).toBeCloseTo(36.4, 8);
    }
    const digest = reporter.composeDailyDigest();
    await (reporter as any).cmdStatus("test"); await (reporter as any).cmdProfits("test");
    const today = readMoneyWindow({ days: 1 }).window!;
    const fmt = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
    expect(digest).toContain(`Hoy ${fmt(today.pnl)}`);
    expect(sent[0]).toContain(`Hoy ${fmt(today.pnl)}`);
    const realized = readMoneyWindow({ days: 1 }).breakdown.realized;
    const open = readOpenMoney(positions);
    expect(positionsTotals).toBe(readOpenMoney); // one reader, not two lookalike sums
    expect(open.total).toBe(9);
    const closedLine = `Cerradas hoy: 1 operación y 2 cierres parciales, ${fmt(realized)} en total (desde que se abrieron)`;
    const openLine = `Siguen abiertas: 1 posición, ${fmt(open.total)} desde que se abrieron`;
    for (const surface of [digest, sent[0]]) {
      expect(surface).toContain(closedLine); expect(surface).toContain(openLine);
      expect(surface).not.toMatch(/fills|MtM|display|base rebajada|vs asignación|Cierres .*posiciones/);
    }
    Object.assign(store.state, { lang: "es" });
    const footer = renderPositions({ dashboard: { accounts, portfolio: { positions } }, view: "consolidated" });
    expect(footer).toContain("Sin cerrar (desde la entrada)"); expect(footer).toContain(fmt(open.total));
    expect(footer).toContain("1 posición");
    const closed = getDB().query("SELECT * FROM trades WHERE status='closed' AND symbol='SPY'").get() as any;
    const alert = fmtCloseAlert(closed);
    const trades = renderTrades([{ ...closed, status: "closed", pnlPct: closed.pnl_pct }]);
    expect(alert).toContain(fmt(closed.pnl)); expect(trades).toContain(fmt(closed.pnl));
    expect(alert).not.toContain("hoy");
    // Attribution remains available in the detail reader, never on tiles/digest.
    const [tileToday] = await get("/api/v2/profiles?days=1");
    const whole = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US")}`;
    const r1 = tileToday.pnlAggregate.periodBreakdown.rounded;
    expect(digest).not.toContain(`Cierres ${whole(r1.closes)} · posiciones ${whole(r1.positions)} en el día`);
    expect(renderKpis()).not.toContain("cierres <b");
    expect(digest).toContain(`${fmt(readDisplayMoneyWindow(["alpaca_main", "binance_main"], 0)!.pnl)} desde el`);
    // /profits: recognized realized = closed episodes (+34.80) + the open
    // row's partial (+1.60); the footer names what it sums and the display
    // start is the tiles' All anchor.
    expect(sent[1]).toContain(`resultado de lo cerrado ${fmt(realized)}`);
    expect(sent[1]).toContain(`Total de lo cerrado ${fmt(realized)}`);
    expect(sent[1]).toContain("1 operación cerrada"); // not two trades (one is still open)
    expect(sent[1]).toContain(openLine);
    expect(sent[1]).toContain("Ganancia desde el inicio +$374");
    expect(sent[1]).toContain(`Desde el ${readDisplayMoneyWindow(["alpaca_main", "binance_main"], 0)!.start.date}`);
    expect(sent[1]).not.toContain("M-B"); // inactive momentum_btc has no history here: no line at all
    const risk = await get("/api/v2/sleeves/risk");
    const stocksRisk = risk.sleeves.find((s: any) => s.id === "momentum_stocks");
    expect(stocksRisk.closedEpisodeResult).toBeCloseTo(34.8, 8);
    // Broker modal "Realized" = the recognized realized (A-2), labelled.
    expect(stocksRisk.realizedPnl).toBeCloseTo(36.4, 8);
    expect(stocksRisk.realizedLabel).toBe("Resultado de lo cerrado (incluye cierres parciales)");
    // G-2: a portfolio-engine sleeve reports a measure (its own equity history —
    // none seeded here ⇒ null), never a fossil state file or a pause threshold.
    expect(stocksRisk.riskMode).toBe("portfolio");
    expect(stocksRisk.drawdown).toEqual({ currentPct: null, softPct: null, hardPct: null });
    expect(stocksRisk.dailyLoss.capPct).toBeNull();
    saveEquitySnapshot("momentum_stocks", 50000, 50000, 0, NOW - 86400000);
    saveEquitySnapshot("momentum_stocks", 52000, 50000, 0, NOW - 3600000);
    saveEquitySnapshot("momentum_stocks", 50045.4, 50000, 0, NOW);
    const measured = (await get("/api/v2/sleeves/risk")).sleeves.find((s: any) => s.id === "momentum_stocks");
    expect(measured.drawdown.currentPct).toBeCloseTo(1 - 50045.4 / 52000, 8);

    // G-1: keep closing attribution cached while headline changes. Neither
    // tile nor modal may retain the old headline or its position residual.
    saveEquitySnapshot("alpaca_main", 100341.6, 100000, 0, NOW);
    const [fresh] = await get("/api/v2/profiles?days=1");
    const freshModal = await get("/api/v2/pnl-breakdown?days=1");
    expect(fresh.pnlAggregate.periodPnl).toBeCloseTo(today.pnl + 1.2, 8);
    expect(freshModal.pnl).toBe(fresh.pnlAggregate.periodPnl);
    expect(fresh.pnlAggregate.periodBreakdown.positions + fresh.pnlAggregate.periodBreakdown.closedInWindow).toBe(fresh.pnlAggregate.periodPnl);
    const r = fresh.pnlAggregate.periodBreakdown.rounded;
    expect(r.closes + r.positions).toBe(Math.round(fresh.pnlAggregate.periodPnl));
  } finally { server.close(); }
});

test("cards preserve null and never invent a return over a rebased display start", () => {
  const state = { ...store.state, view: "consolidated", period: 0,
    dashboard: { accounts: [{ id: "momentum_stocks", broker: "alpaca", equity: 999999, initialEquity: 50000 }] },
    profiles: [{ pnlAggregate: { equity: 100, periodPnl: 10, periodPnlPct: null, sinceStart: {
      pnl: 10, pnlPct: null, start: { at: NOW, date: "2026-11-07", equity: 90, rebased: true } } },
      brokerAccounts: [{ brokerId: "alpaca_paper", equity: null, stats: { periodEquityPnl: null }, firstEquity: 90 }] }] };
  Object.assign(store.state, state);
  expect(renderProfiles()).not.toContain("999,999");
  expect(renderProfiles()).toContain("—");
  expect(sinceStart(state).pct).toBeNull();
  expect(renderKpis()).not.toContain("+0.0%"); // absent server pct is never converted to zero
});

test("a partial then add-back keeps full episode cost; reconciliation is not a filled close", () => {
  clock(); makeTestDb();
  const cfg = { accountId: "momentum_stocks", strategyVersion: "test", market: "stock" as const, quoteAsset: "USD" };
  applyBuyFill(cfg, "SPY", 100, 100, NOW - 10000);
  applySellFill(cfg, "SPY", 90, 100, { nowMs: NOW - 9000 });
  applyBuyFill(cfg, "SPY", 10, 200, NOW - 8000); // total episode cost = 12000
  applySellFill(cfg, "SPY", 20, 200, { nowMs: NOW - 7000 }); // leg +1000 => 8.3333%, not 33%
  const row = getDB().query("SELECT pnl, pnl_pct, episode_basis FROM trades WHERE symbol='SPY'").get() as any;
  expect(row.episode_basis).toBe(12000); expect(row.pnl).toBe(1000); expect(row.pnl_pct).toBeCloseTo(1000 / 12000 * 100, 8);
  // Legacy PE row (no episode_basis persisted): the audit's AAPL case — 23.42
  // shares ever held at 327.04, P&L 382.22 ⇒ 4.99%, not 6.34% on the remnant.
  const legacy = { strategy: "PORTFOLIO", status: "closed", pnl: 382.22079589111, pnl_pct: 6.343467, episode_basis: null,
    entry_price: 327.04, quantity: 18.424119326, partial_closed_contracts: 5 };
  expect(closedEpisodePct(legacy)).toBeCloseTo(4.989421, 5);
  expect(closedEpisodePct({ ...legacy, status: "open", pnl: null, pnl_pct: null })).toBeUndefined();
  expect(closedEpisodePct({ ...legacy, strategy: "MOMENTUM" })).toBe(6.343467);
  applyBuyFill(cfg, "QQQ", 10, 100, NOW - 6000);
  reconcileRowToBroker(cfg, "QQQ", 0, 150, NOW - 5000);
  expect(getClosedEpisodeResult(cfg.accountId)).toBe(1000);
  expect(computeRealizedAttribution(getDB(), null, 0, NOW).realized).toBe(1000);
});

test("net immutable legs survive add-backs; their sum equals the final row to the cent", () => {
  clock(); makeTestDb();
  seedOpenTrade("crypto", "momentum_crypto_usdc", { symbol: "SOL/USDC", market: "crypto", side: "sell", entryPrice: 100, quantity: 10, entryTime: NOW - 10000 });
  accumulatePartialCloseLedger("crypto", { realizedNative: 20, commissionNative: 0.4, commissionAsset: "USDC", closedContracts: 2, remainingContracts: 8, fillTime: NOW - 9000 });
  recordFill({ tradeId: "crypto", orderId: "trim", accountId: "momentum_crypto_usdc", symbol: "SOL/USDC", market: "crypto", side: "buy",
    expectedPx: 90, submittedPx: 90, filledPx: 90, filledQty: 2, fillTime: NOW - 9001, latencyMs: 1, broker: "binance" });
  closeTrade("crypto", 95, NOW - 5000, 0.6, 20 - 0.4 + 40 - 0.6);
  const r = computeRealizedAttribution(getDB(), null, 0, NOW);
  expect(r.precision).toBe("exact"); expect(r.realized).toBeCloseTo(59, 8);
  expect(r.realized).toBe(getClosedEpisodeResult("momentum_crypto_usdc"));
  expect(r.closes.find(l => l.kind === "trim")?.exitTime).toBe(NOW - 9001);
  expect(r.closes.find(l => l.kind === "trim")?.realized).toBe(19.6);
});

test("calendar yesterday, final report, and catch-up digest all use the requested 25-hour ET day", async () => {
  const now = Date.parse("2026-11-02T04:30:00Z");
  spyOn(Date, "now").mockReturnValue(now); makeTestDb();
  expect(getETYesterday(now)).toBe("2026-10-31");
  expect(getETWindowStart(7, now)).toBe(getETDayBounds("2026-10-26")[0]);
  const report = new DailyReporter(); report.getAccountSummaries = () => [{ id: "momentum_stocks", initialEquity: 50000, equity: 999999 }];
  await (report as any).checkReportTime();
  expect(getDB().query("SELECT 1 FROM daily_reports WHERE report_date='2026-11-01'").get()).toBeNull();
  spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-02T06:00:00Z"));
  const [start, end] = getETDayBounds("2026-11-01");
  for (const [id, seed] of [["momentum_stocks", 50000], ["alpaca_main", 100000], ["binance_main", 10000]] as const) {
    saveEquitySnapshot(id, seed, seed, 0, start - 60000);
    saveEquitySnapshot(id, seed + 100, seed, 0, end - 60000);
    saveEquitySnapshot(id, seed + 9999, seed, 0, end + 60000);
  }
  let digest = ""; const telegram = new TelegramReporter();
  report.sendTelegramDigest = async () => { expect(moneyReportDate()).toBe("2026-11-01"); digest = telegram.composeDailyDigest(); return true; };
  await (report as any).checkReportTime();
  expect(digest).toContain("domingo 1 nov");
  expect(digest).toContain("Hoy +$200");
  expect(digest).toContain("Posiciones al cierre: sin datos suficientes");
  expect(digest).not.toContain("9999");
  const row = getDB().query("SELECT * FROM daily_reports WHERE report_date='2026-11-01'").get() as any;
  expect(row.starting_equity).toBe(50000); expect(row.ending_equity).toBe(50100); expect(row.telegram_sent).toBe(1);
  expect(moneyReportDate()).toBeUndefined();
});

test("thinning protects both ET daily endpoints and every referenced mark timestamp", () => {
  clock(); makeTestDb();
  const start = getETDayBounds("2026-10-20")[0];
  for (const minute of [1, 2, 3, 4, 5, 60, 120, 1439]) saveEquitySnapshot("alpaca_main", 100000 + minute, 100000, 0, start + minute * 60000);
  savePnlWindowMarks(start + 86400000, start + 3 * 60000, [{ symbol: "SPY", market: "stock", price: 100 }]);
  const before = getEquityPnlDisplay("alpaca_main", 0);
  pruneEquitySnapshots();
  const times = (getDB().query("SELECT snapshot_time t FROM equity_snapshots").all() as any[]).map(r => r.t);
  expect(times).toContain(start + 60000); expect(times).toContain(start + 1439 * 60000);
  expect(times).toContain(start + 3 * 60000); expect(times).not.toContain(start + 4 * 60000);
  expect(getEquityPnlDisplay("alpaca_main", 0)).toEqual(before);
});

test("invariant episodes page once, survive another check/restart, and page recovery once", () => {
  clock(); makeTestDb(); const events: any[] = []; const listener = (e: any) => events.push(e);
  eventBus.on(EVENTS.ERROR_BURST, listener);
  const report = (ok: boolean) => ({ at: NOW, ok, checks: [{ name: "fixture", ok, detail: "difference" }] });
  try { publishInvariantEpisodes(report(false)); publishInvariantEpisodes(report(false));
    expect(events).toHaveLength(1); expect(events[0].message).toContain("VIOLATION");
    publishInvariantEpisodes(report(true)); publishInvariantEpisodes(report(true));
    expect(events).toHaveLength(2); expect(events[1].message).toContain("RECOVERED");
  } finally { eventBus.off(EVENTS.ERROR_BURST, listener); }
});

test("Binance components are independent margin equities, not wallet USDC plus residual USDT", () => {
  clock(); makeTestDb();
  const b = readBinanceMarginBreakdown([{ id: "momentum_crypto", equity: 4900 }, { id: "momentum_crypto_usdc", equity: 4800 }]);
  expect(b.usdtFutures).toBe(4900); expect(b.usdcFutures).toBe(4800);
  expect(readSleeveMoney("momentum_crypto").labels.unrealized).toBe("Sin cerrar (desde la entrada)");
  const rounded = tileMoney(0.6, { closedInWindow: 0.4, closesCount: 1, trimsCount: 0, startPrices: "marks" }).rounded!;
  expect(rounded).toEqual({ pnl: 1, closes: 0, positions: 1 });
});

test("three legs anchored seconds apart before the same boundary keep their %; a COIN-M leg born inside the window does not", () => {
  clock(); makeTestDb();
  const dayStart = getETWindowStart(1, NOW);
  // alpaca 04:58, binance 04:59, coinm 04:59:30 — the usual 5-min pass spread.
  saveEquitySnapshot("alpaca_main", 100000, 100000, 0, dayStart - 120000);
  saveEquitySnapshot("binance_main", 10000, 10000, 0, dayStart - 60000);
  saveEquitySnapshot("binance_coinm_main", 800, 800, 0, dayStart - 30000);
  for (const [id, eq] of [["alpaca_main", 100100], ["binance_main", 10010], ["binance_coinm_main", 801]] as const) saveEquitySnapshot(id, eq, eq, 0, NOW);
  setBrokerTruthAvailable("alpaca", true); setBrokerTruthAvailable("binance", true); setBrokerTruthAvailable("coinm", true);
  const w = readDisplayMoneyWindow(["alpaca_main", "binance_main", "binance_coinm_main"], 1, NOW)!;
  expect(w.pnl).toBeCloseTo(111, 8);
  expect(w.start.rebased).toBe(false);
  expect(w.pnlPct).toBeCloseTo(111 / 110800 * 100, 8);
  // COIN-M genesis after the window start: its first reading is a deposit, not P&L — no % over a synthetic base.
  getDB().query("DELETE FROM equity_snapshots WHERE profile_id = 'binance_coinm_main' AND snapshot_time < ?").run(dayStart);
  saveEquitySnapshot("binance_coinm_main", 800, 800, 0, dayStart + 60000);
  const late = readDisplayMoneyWindow(["alpaca_main", "binance_main", "binance_coinm_main"], 1, NOW)!;
  expect(late.pnl).toBeCloseTo(111, 8);
  expect(late.start.rebased).toBe(true);
  expect(late.pnlPct).toBeNull();
  // The gain over the starting value stays available beside the strict null;
  // only the since-start figure shows it (a 1-day tile keeps the null above).
  expect(late.pnlPctOnStart).toBeCloseTo(111 / 110800 * 100, 8);
});

// The Overview board (2026-11-14): each strategy column's value, its 30-day change and its % are the display
// reader's (getEquityWindowDisplay), and the curve it draws is the same series: last − first is that change.
test("the board column of a strategy: its figure equals the reader's and equals last − first of the series it draws", async () => {
  clock(); makeTestDb(); clearApiCache();
  const marks: Array<[string, number, number]> = []; // [strategy, days ago, equity]
  for (const [id, base, drift] of [["momentum_stocks", 48_699, 1_204], ["momentum_crypto", 9_880, -570]] as const) {
    for (let d = 40; d >= 0; d--) marks.push([id, d, base + (d >= 31 ? -300 : (31 - d) / 31 * drift) + (d % 3) * 40]);
  }
  for (const [id, daysAgo, equity] of marks) saveEquitySnapshot(id, equity, 1_000, 0, NOW - daysAgo * 86_400_000 - 600_000);
  const accounts = [{ id: "momentum_stocks", broker: "alpaca", equity: 12_345, initialEquity: 50_000, label: "Momentum Stocks" }, // the stale ledger equity must NOT be what the block shows
    { id: "momentum_crypto", broker: "binance", equity: 99, initialEquity: 10_000, label: "Momentum Crypto" }];
  const positions = [{ profileId: "momentum_stocks", symbol: "SPY", market: "stock", side: "buy", quantity: 9, avgEntryPrice: 104, currentPrice: 105, openedAt: NOW - 3_600_000, unrealizedPnl: 9 }];
  const app = express(); registerStrategyRoutes(app, { getActiveStrategies: () => [] } as any);
  const server = app.listen(0); const { port } = server.address() as { port: number };
  try {
    const curves: Record<string, any[]> = {};
    for (const id of ["momentum_stocks", "momentum_crypto"]) {
      const rows = await (await fetch(`http://127.0.0.1:${port}/api/equity/history?account=${id}&days=30&points=120`)).json() as any[];
      curves[id] = rows;
      const w = getEquityWindowDisplay(id, 30)!;
      expect(w).not.toBeNull();
      expect(rows.length).toBeLessThanOrEqual(120);
      expect(rows.at(-1).moneyWindow.pnl).toBe(w.pnl);                    // the route carries the reader's window
      expect(rows.at(-1).moneyWindow.equity).toBe(w.equity);
      expect(rows.at(-1).moneyWindow.pnlPct).toBe(w.pnlPct);
      const fig = strategyFigures(rows);
      expect(fig).toMatchObject({ value: w.equity, pnl: w.pnl, pct: w.pnlPct });
      expect(fig.values.at(-1) - fig.values[0]).toBeCloseTo(w.pnl, 8);     // what the curve draws is the change the head says
      expect(fig.values[0]).toBe(w.start.equity);
      expect(curveGeometry(fig.values).up).toBe(w.pnl >= 0);
    }
    Object.assign(store.state, { lang: "en" });
    const model = boardModel({ view: "consolidated", curves, curvesTried: { momentum_stocks: true, momentum_crypto: true }, botNow: null, dashboard: { accounts, portfolio: { positions } } }, { now: NOW });
    const col = (id: string) => model.cols.find((c: any) => c.id === id).parts;
    const w = getEquityWindowDisplay("momentum_stocks", 30)!, c = getEquityWindowDisplay("momentum_crypto", 30)!;
    const whole = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
    expect(col("momentum_stocks").fig).toContain(`<div class="bc-value">$${Math.round(w.equity).toLocaleString("en-US")}</div>`);
    expect(col("momentum_stocks").fig).toContain(`${whole(w.pnl)} (${w.pnlPct! < 0 ? "−" : "+"}${Math.abs(w.pnlPct!).toFixed(1)} %) in 30 days`);
    expect(col("momentum_crypto").fig).toContain(`<div class="bc-value">$${Math.round(c.equity).toLocaleString("en-US")}</div>`);
    expect(model.cols.map((x: any) => x.parts.fig).join("")).not.toContain("12,345"); // never accounts[].equity
    expect(col("momentum_stocks").lines).toContain("+$9 since entry");
    // the one summary line under the board is the open reader's too
    expect(model.foot).toContain(`1 position open <span class="muted">·</span> <span style="color:var(--up);font-weight:600">${whole(readOpenMoney(positions).total)} since entry`);
  } finally { server.close(); }
});

// The board shows each strategy's value under the account's total equity; they do
// not add up because some money belongs to no strategy. ONE formula says how much,
// for the digest ("Fuera de las estrategias: …") and for the board's line, each fed
// the figures it shows, rounded first: the strategies + this = the total, to the dollar.
test("outside the strategies: one formula for the digest and the board, and the screen adds up", () => {
  const total = 118_479.4, values = [49_372.3, 5_370.2, 54_633.4, 6_384.3];
  const out = readOutsideStrategies(total, values)!;
  expect(out).toBe(118_479 - (49_372 + 5_370 + 54_633 + 6_384));
  expect(values.reduce((s, v) => s + Math.round(v), 0) + out).toBe(Math.round(total));
  // unknown stays unknown: no figure over a partial sum
  expect(readOutsideStrategies(null as any, values)).toBeNull();
  expect(readOutsideStrategies(total, [49_372.3, NaN])).toBeNull();
  expect(readOutsideStrategies(total, [49_372.3, undefined as any])).toBeNull();
  expect(readOutsideStrategies(total, [])).toBeNull();
  const lang = store.state.lang;
  try {
    Object.assign(store.state, { lang: "es" });
    // the digest's very words (src/telegram/digest.test.ts pins them there)
    expect(outsideLine(total, values)!.text).toBe(`Fuera de las estrategias: $${out.toLocaleString("en-US")} (efectivo inicial de Alpaca y garantía en BTC)`);
    expect(outsideLine(total, values)!.title).toBe("Patrimonio $118,479 = las estrategias $115,759 + $2,720 fuera de ellas");
    Object.assign(store.state, { lang: "en" });
    expect(outsideLine(total, values)!.text).toBe("Outside the strategies: $2,720 (Alpaca's initial cash and BTC collateral)");
    expect(outsideLine(100_040, [50_000, 50_000])).toBeNull(); // rounding and timing, not a holding
    expect(outsideLine(total, [49_372.3, null as any])).toBeNull();
  } finally { Object.assign(store.state, { lang }); }
});
