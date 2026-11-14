#!/usr/bin/env bun
// Geometry guard, not a pixel baseline. No DB/broker imports or instance data.
// By default starts the visual harness with generated, synthetic fixtures.
// Covers the Overview's five analytics tabs (Bot, Equity, Performance, Volume,
// Activity), the P&L bridge and broker modals, the portfolio filter chip, and
// every one of them in English AND Spanish (longer words are what overflow).
// --ci: desktop Overview only; --sizes WxH,...: focused regression replay.
// --base URL [--login]: live, read-only (only login/logout may mutate).
// Screenshots + report.json: reports/dashboard-layout/ or --out DIR.
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  base: { type: "string" }, login: { type: "boolean" }, ci: { type: "boolean" },
  sizes: { type: "string" }, out: { type: "string" }, langs: { type: "string" },
}, strict: true });
const OUT = resolve(values.out || "reports/dashboard-layout");
const LANGS = (values.langs || "en,es").split(",").map((l) => {
  if (l !== "en" && l !== "es") throw new Error(`Invalid language: ${l}`);
  return l;
});
const SIZES = (values.sizes || "1280x720,1366x768,1440x900,1747x892,1920x1080,2000x857,2560x1440,390x844")
  .split(",").map((s) => {
    if (!/^\d+x\d+$/.test(s)) throw new Error(`Invalid viewport: ${s}`);
    const [width, height] = s.split("x").map(Number);
    if (!width || !height) throw new Error(`Invalid viewport: ${s}`);
    return { width, height };
  }).filter((v) => !values.ci || (v.width >= 981 && v.height >= 540));

function chromePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = join(homedir(), ".cache/ms-playwright");
  const cached = (existsSync(cache) ? [...new Bun.Glob("chromium-*/chrome-linux64/chrome").scanSync({
    cwd: cache, absolute: true, onlyFiles: true,
  })] : []).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const path = cached[0] || "/usr/bin/google-chrome";
  if (!existsSync(path)) throw new Error("Chrome not found. Set PLAYWRIGHT_CHROMIUM or install google-chrome.");
  return path;
}

function syntheticFixtures(dir: string) {
  mkdirSync(dir, { recursive: true });
  const save = (name: string, data: unknown) => writeFileSync(join(dir, name + ".json"), JSON.stringify(data));
  const now = Date.UTC(2026, 9, 23, 16);
  const defs = [
    ["meanrev_stocks", "MeanRev Stocks", "alpaca", 32],
    ["momentum_stocks", "Momentum Stocks", "alpaca", 11],
    ["momentum_crypto", "Momentum Crypto", "binance", 0],
    ["momentum_crypto_usdc", "Momentum Crypto USDC", "binance", 4],
  ] as const;
  const accounts = defs.map(([id, label, broker, count]) => ({
    // Capital gauge states: momentum_stocks holds ~146 % of its capital (limit 250 %), the
    // USDC sleeve is past its 115 % limit (red), meanrev's limit is 100 % (track ends at 100 %).
    id, label, broker, equity: id === "momentum_stocks" ? 123_700 : id === "momentum_crypto_usdc" ? 18_000 : 25_000, initialEquity: id === "momentum_stocks" ? 96_000 : 24_000, totalPnl: 1000,
    cash: 8000, openPositions: count, paused: false, mode: "live",
    grossCapMult: id === "momentum_stocks" ? 2.5 : id === "meanrev_stocks" ? 1 : 1.15,
    grossCapBase: id === "meanrev_stocks" ? "allocation" : "equity",
  }));
  // The first group (biggest book) reads as the live momentum_stocks sleeve: its
  // real universe, gains and losses, every ticker a human cannot read bare (USD,
  // UGL, SSO, QLD, IWM). The meanrev group keeps the long DEMO### stress list.
  const real = (symbol: string, qty: number, entry: number, last: number, ageDays: number) => ({
    symbol, side: "long", quantity: qty, avgEntryPrice: entry, currentPrice: last,
    unrealizedPnl: qty * (last - entry), unrealizedPnlPct: (last / entry - 1) * 100, ageDays,
  });
  const momentumRows = [
    real("SSO", 190, 78.4, 81.9, 4), real("QLD", 160, 92.3, 88.1, 3), real("UGL", 300, 55.6, 58.2, 1),
    real("USD", 270, 61.2, 57.9, 2), real("AAPL", 70, 231, 238.4, 0), real("MSFT", 38, 441, 433.2, 5),
    real("NVDA", 85, 188, 203.5, 3), real("IWM", 72, 241, 236.4, 1), real("META", 28, 598, 612.9, 2),
    real("GOOGL", 95, 172, 179.6, 4), real("AMZN", 80, 206, 201.3, 0),
  ];
  const nowReal = Date.now();
  const positions = defs.flatMap(([profileId, , , count]) => Array.from({ length: count }, (_, i) => {
    const base = { id: `synthetic-${profileId}-${i}`, profileId, side: "long", stopLoss: i % 3 ? 11_234.56 + i * 17 : null };
    if (profileId === "momentum_stocks") {
      const { ageDays, ...r } = momentumRows[i];
      return { ...base, ...r, market: "stock", openedAt: nowReal - ageDays * 864e5, durationSeconds: ageDays * 86_400 };
    }
    const sign = i % 2 ? -1 : 1;
    if (profileId === "momentum_crypto_usdc") { // every position down (a one-colour split bar); one is a SHORT that loses because the price rose
      const short = i === 3, entry = 12_345.67 + i * 17, qty = 0.3 + 0.1 * i;
      const pct = short ? -2.1 : -(1.23 + i * 0.4); // the result, as a % of what was invested
      return { ...base, symbol: ["NEAR/USDC", "1000PEPE/USDC", "ETH/USDC", "BTC/USDC"][i], market: "crypto",
        side: short ? "sell" : "long", quantity: short ? -qty : qty, avgEntryPrice: entry,
        currentPrice: entry * (1 + (short ? -pct : pct) / 100), unrealizedPnl: qty * entry * pct / 100, unrealizedPnlPct: pct,
        openedAt: nowReal - (i * 41 + 7) * 36e5, durationSeconds: (i * 41 + 7) * 3600 };
    }
    const qty = 3 + (i % 3), entry = 120.5 + i * 3, pct = sign * (0.4 + (i % 7) * 0.45);
    return { ...base, symbol: `DEMO${String(i + 1).padStart(3, "0")}`, market: "stock", quantity: qty, avgEntryPrice: entry,
      currentPrice: entry * (1 + pct / 100), unrealizedPnl: qty * entry * pct / 100, unrealizedPnlPct: pct,
      openedAt: nowReal - (i % 6) * 864e5, durationSeconds: (i % 6) * 86_400 };
  }));
  // Each strategy's 30-day curve as GET /api/equity/history?account=<id>&days=30&points=120 answers it:
  // ~120 rows, the last carrying the reader's `moneyWindow` (value now, change, %). One rises, one falls,
  // one stays flat and then drops, one falls from its peak. All four have a series so the board's "Outside
  // the strategies" line shows (it needs every column's value: 100,000 − 97,033 = $2,967); a strategy with
  // NO series is covered by board.test.js ("a strategy with no series").
  const curve = (id: string, shape: "rise" | "fall" | "flat-then-drop" | "none", start: number, end: number) => {
    if (shape === "none") { save(`equity-history-${id}`, []); return; }
    const N = 120, t0 = now - 30 * 864e5;
    const rows = Array.from({ length: N }, (_, i) => {
      const f = i / (N - 1), wobble = Math.sin(i / 5) * (end - start) * 0.12 + Math.sin(i / 2.3) * (end - start) * 0.04;
      const base = shape === "flat-then-drop" ? (f < 0.8 ? start + wobble * 0.3 : start + (end - start) * ((f - 0.8) / 0.2))
        : start + (end - start) * f + wobble * (1 - f);
      return { snapshot_time: t0 + Math.round(f * 30 * 864e5), equity: i === 0 ? start : i === N - 1 ? end : Math.round(base), cash: 0, rebased: false };
    });
    const pnl = end - start;
    rows[N - 1] = { ...rows[N - 1], moneyWindow: { pnl, pnlPct: (pnl / start) * 100, pnlPctOnStart: (pnl / start) * 100, equity: end, endAt: rows[N - 1].snapshot_time,
      start: { at: rows[0].snapshot_time, date: "2026-09-23", equity: start, rebased: false } } } as typeof rows[number];
    save(`equity-history-${id}`, rows);
  };
  curve("momentum_stocks", "rise", 48_699, 49_903);
  curve("meanrev_stocks", "fall", 25_410, 24_820);
  curve("momentum_crypto", "flat-then-drop", 9_880, 9_310);
  curve("momentum_crypto_usdc", "fall", 15_600, 13_000);
  save("dashboard", { accounts, daysRunning: 123, portfolio: {
    positions, openPositions: positions.length, equity: 100_000, cash: 32_000, winRate: 57,
  } });
  save("api-bot-now", { asOf: now, portfolios: accounts.map((a, i) => ({
    id: a.id, label: a.label, broker: a.broker, engine: a.broker === "alpaca" ? "portfolio" : "momentum",
    version: `${a.id}@synthetic`, state: i === 2 ? "flat" : "invested",
    positions: defs[i][3], investedUsd: i === 2 ? 0 : 24_250, equityUsd: 25_000, grossX: [0.93, 1.46, 0, 1.22][i],
    maxGrossX: a.grossCapMult, cadence: { kind: i === 2 ? "hourly" : "daily",
      at: a.broker === "alpaca" ? "09:35 America/New_York" : i === 2 ? ":00 each hour" : "00:00 UTC" },
    lastDecision: { at: nowReal - [20 * 3600e3, 20 * 3600e3, 9 * 60e3, 6 * 3600e3][i], entries: i === 2 ? 0 : 2, exits: 0, resizes: 0, orders: i === 2 ? 0 : 2,
      rejected: 0, signalsLong: i === 2 ? 0 : null, universe: i === 2 ? 8 : null, note: null },
    nextDecisionAt: nowReal + [4 * 3600e3, 4 * 3600e3, 23 * 60e3, 18 * 3600e3][i],
    blocked: i === 2 ? { reason: "no_signal", detail: "Sin señal larga en 8 activos", until: null }
      : i === 3 ? { reason: "soft_drawdown", detail: "soft drawdown 16.9% — paused 24h", until: nowReal + 864e5 } : null,
    // Both sentences: rising (momentum) and the longest one, falling + defensive mode (the flat crypto card).
    regime: a.id === "momentum_stocks" ? { riskOn: true, ref: "SPY", distancePct: 4.3 }
      : a.id === "momentum_crypto" ? { riskOn: false, ref: "BTC/USD", distancePct: -12.4 } : null,
    exposureScale: i === 3 ? 0.794 : null, drawdownPct: a.broker === "alpaca" ? null : i === 3 ? 16.9 : 0,
  })), events: [
    // The board's "last action" line: a pass at the 5-day limit with its re-buys, a plain rebalance, a trim.
    { at: nowReal - 20 * 3600e3, portfolioId: "momentum_stocks", kind: "rebalance", symbol: null, qty: null, usd: 18_000, pnlUsd: null, reason: "REBALANCE", detail: null, buys: 3, sells: 2, rebought: ["SPY", "QQQ"], newBuyUsd: 6400 },
    { at: nowReal - 20 * 3600e3 + 2000, portfolioId: "momentum_stocks", kind: "close", symbol: "QQQ", qty: 9, usd: 4100, pnlUsd: -134, reason: "MAX_HOLD", detail: null },
    { at: nowReal - 20 * 3600e3 + 4000, portfolioId: "momentum_stocks", kind: "close", symbol: "SPY", qty: 6, usd: 3980, pnlUsd: -210, reason: "MAX_HOLD", detail: null },
    { at: nowReal - 20 * 3600e3, portfolioId: "meanrev_stocks", kind: "rebalance", symbol: null, qty: 8, usd: 12_345, pnlUsd: null, reason: "REBALANCE", detail: null, buys: 5, sells: 3 },
    { at: nowReal - 6 * 3600e3, portfolioId: "momentum_crypto_usdc", kind: "resize", symbol: null, qty: 4, usd: -1250, pnlUsd: null, reason: "drawdown_control", detail: null },
  ] });
  const tradeSymbols = ["SSO", "UGL", "AAPL", "XRP/USDC", "USD", "NVDA", "IWM", "BTC/USDC", "DEMO001", "QLD", "DEMO017", "ETH/USDC"];
  const trades = Array.from({ length: 24 }, (_, i) => ({
    id: `synthetic-trade-${i}`, accountId: accounts[i % 4].id, symbol: tradeSymbols[i % tradeSymbols.length],
    status: "closed", side: i === 7 ? "sell" : "buy", strategy: "synthetic", closeReason: "TRAIL_STOP",
    entryPrice: 12_345.67, exitPrice: 12_456.78, quantity: 1.2345,
    pnl: (i % 2 ? -1 : 1) * 123.45, pnlPct: (i % 2 ? -1 : 1) * 1.23,
    entryTime: now - (i + 5) * 864e5, exitTime: now - i * 3600e3,
  }));
  save("trades", trades);
  const stats = { totalTrades: 60, closedTrades: 40, todayTrades: 8, winRate: 57,
    periodEquityPnl: 234.56, periodEquityPnlPct: 0.23 };
  // One display-start object for "since start", the All tile and the cards (A-1).
  const sinceStart = { pnl: 4_000, pnlPct: 4.17, equity: 100_000, endAt: now,
    start: { at: now - 120 * 864e5, date: "2026-07-10", equity: 96_000, rebased: false } };
  save("profiles-7d", [{ id: "synthetic", pnlAggregate: {
    equity: 100_000, periodPnl: 234.56, periodPnlPct: 0.23, pnl7d: 1234.56, pnl7dPct: 1.25, sinceStart, displayStart: sinceStart.start,
    periodRealized: 123.45, periodRealizedCount: 8, realized7d: 654.32, realized7dCount: 24,
    // Same-window bridge under each P&L tile (closes + positions == the headline); wide figures on purpose.
    periodBreakdown: { closedInWindow: -1234.56, positions: 1469.12, closesCount: 10, trimsCount: 8, startPrices: "bars" },
    breakdown7d: { closedInWindow: -2345.67, positions: 3580.23, closesCount: 48, trimsCount: 30, startPrices: "marks" },
  }, brokerAccounts: ["alpaca", "binance"].map((brokerId) => ({
    brokerId: `${brokerId}_main`, equity: 50_000, firstEquity: 48_000, stats,
    sinceStart: { ...sinceStart, pnl: 2_000, equity: 50_000, start: { ...sinceStart.start, equity: 48_000 } },
    marginBreakdown: brokerId === "binance" ? { usdtFutures: 25_000, usdcFutures: 25_000 } : undefined,
    perAccountStats: Object.fromEntries(accounts.filter((a) => a.broker === brokerId).map((a) => [a.id, stats])),
  })) }]);
  const equity = Array.from({ length: 90 }, (_, i) => ({
    snapshot_time: now - (89 - i) * 864e5, equity: 96_000 + i * 40 + Math.sin(i / 3) * 300,
  }));
  for (const file of ["equity-consolidated-all", "equity-consolidated-30d", "equity-usdc-30d"]) save(file, equity);
  save("portfolios-meta", { writable: false, presets: [], accounts: [] });
  save("portfolios-get", accounts.map((a, i) => ({
    id: a.id, name: a.label, template: i === 0 ? "meanrev_connors" : "momentum_tsm",
    account: a.broker === "alpaca" ? "alpaca_main" : "binance_usdc", capital: 24_000,
    universeSize: defs[i][3], mode: "live", enabled: true, status: "active", validation: "validated",
    rowSource: "builtin", origin: "code", band: { status: "within", liveCumReturnPct: 2.4, p5Pct: -1.1 },
  })));
  save("api-v2-scorecard", { entities: accounts.map((a) => ({
    kind: "sleeve", id: a.id, label: a.label, benchmarkSymbol: "SPY", modelStart: "2026-09-01",
    band: { status: "within", horizonSessions: 60, cumReturnPct: { p5: -4, p50: 3, p95: 12 } },
    windows: [{ window: "model", totalReturnPct: 4.2, alphaAnnPct: 2.1, sharpe: 0.8,
      maxDrawdownPct: 6.4, benchmark: { totalReturnPct: 2.4 } }],
  })) });
  save("api-activity", trades.map((t) => ({ created_at: t.exitTime, account_id: t.accountId,
    message: `Synthetic close ${t.symbol}: confirmed fill (layout fixture)` })));
  save("api-ai-quorum-summary", { status: "none" });
  // Volume tab: every row carries a long run of block reasons, the widest case.
  save("api-funnel", { days: 7, accounts: defs.map(([id], i) => ({
    accountId: id, passes: 168, universe: 8, signalsLong: 12 + i, signalsShort: 3, entries: 14, exits: 11,
    blocks: { risk_gate: 12, regime: 7, market_trend: 5, gross_cap: 3, capacity: 2, no_slot: 4, open_failed: 1, breakout_short_close_failed: 1 },
    lastBlockNote: null, slotsUsed: 6, slotsTotal: 8, liveOrders: 25 + i, liveOrdersPerDay: 3.6, designOpsPerDay: 0.4, designOrdersPerDay: 0.8,
  })), totals: { liveOrdersPerDay: 14.4, designOrdersPerDay: 3.2 } });
  save("api-analytics-slippage", { count: 120, p50: 2.1, p95: 9.4, meanLatencyMs: 380 });
  // P&L bridge modal: wide figures on purpose.
  save("api-v2-pnl-breakdown", { periodDays: 1, windowStart: now - 6 * 3600e3, pnl: 234.56, startPrices: "bars", realized: -11234.56,
    count: 10, closesCount: 10, trimsCount: 8, earnedBefore: -9999.99, closedInWindow: -1234.56, openChange: 1000.12, openCount: 51, holding: 469.0, positions: 1469.12,
    closes: Array.from({ length: 10 }, (_, i) => ({ accountId: "momentum_stocks", symbol: `DEMO${String(i + 1).padStart(3, "0")}`, kind: i % 3 ? "close" : "trim",
      entryTime: now - 5 * 864e5, exitTime: now - 3600e3, quantity: 10, realized: -1234.5 - i * 100, earnedBefore: -999.9 - i * 90, inWindow: -234.6 - i * 10 })) });
  save("api-v2-sleeves-risk", { sleeves: [] });
  save("api-connections", { alpaca: { connected: true }, binance: { connected: true } });
  save("api-config-keys", {});
  save("api-platform-me", { username: "synthetic-owner", displayName: "Demo Owner", role: "admin",
    accountId: "synthetic-account", instanceId: "synthetic-instance", loginMethods: { password: true },
    accountsSource: "registry", portfoliosSource: "code", commit: "fixture", publicUrl: "https://example.com" });
  save("api-platform-accounts", { configured: true, accounts: [{ id: "synthetic-paper", provider: "alpaca",
    label: "Synthetic paper", environment: "paper", authType: "api_key", status: "verified", runtimeLinked: true }] });
  save("api-platform-sessions", { sessions: [{ handle: "synthetic-session", current: true,
    createdAt: now - 864e5, lastActivity: now, device: "Synthetic Chrome Linux", ip: "192.0.2.1" }] });
}

// Explicit exceptions: intentional hidden-scrollbar horizontal carousels.
// Do NOT allow .scroll, #opsBody or #anBody: those must fit on desktop.
// The KPI strip is NOT exempt on desktop: fit.js drops its sparklines and the
// win rate before it would scroll, so a strip that still overflows is a failure.
// Phones keep the strip's own sideways scroll (their page scrolls anyway).
const DESKTOP_CAROUSELS = ["#newsScroll", ".nav", "#ticker"];
const PHONE_CAROUSELS = [...DESKTOP_CAROUSELS, ".kpis"];
function scrollContainers(allowlist: string[]) {
  const label = (el: Element) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")
    + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
  const doc = document.scrollingElement!;
  const rows = [{ element: "document", x: doc.scrollWidth > innerWidth + 1, y: doc.scrollHeight > innerHeight + 1,
    sw: doc.scrollWidth, cw: innerWidth, sh: doc.scrollHeight, ch: innerHeight, allowed: false }];
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    // Skip hidden/detached tabs, but include tables below the fold of an
    // inner vertical scroller: those are still reachable and must fit too.
    if (!rect.width || !rect.height || style.visibility === "hidden") continue;
    const x = /^(auto|scroll)$/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const y = /^(auto|scroll)$/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const parent = el.parentElement?.closest("[id]");
    if (x || y) rows.push({ element: (parent ? `#${parent.id} > ` : "") + label(el), x, y, sw: el.scrollWidth, cw: el.clientWidth,
      sh: el.scrollHeight, ch: el.clientHeight, allowed: allowlist.some((s) => el.matches(s)) });
  }
  return rows;
}

/** The Overview board must be ONE view: on a locked desktop (≥ 1280 × 700) nothing inside it scrolls or is clipped, in either
 *  direction, and every column shows at least 2 + 2 bars when it has that many. Returns what is wrong and the bars each column shows. */
function boardProblems(locked: boolean) {
  const out: string[] = [];
  const board = document.querySelector(".bd");
  if (!board) return { out: ["no board"], bars: [] as number[] };
  const label = (el: Element) => (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : el.tagName.toLowerCase())
    + ((el as HTMLElement).dataset?.id ? `[${(el as HTMLElement).dataset.id}]` : (el as HTMLElement).dataset?.part ? `[${(el as HTMLElement).dataset.part}]` : "");
  const check = (el: Element) => {
    if (el.scrollHeight > el.clientHeight + 1) out.push(`${label(el)} content ${el.scrollHeight} > box ${el.clientHeight}`);
    if (el.scrollWidth > el.clientWidth + 1) out.push(`${label(el)} width ${el.scrollWidth} > box ${el.clientWidth}`);
  };
  for (const el of [board, ...board.querySelectorAll(".bc, [data-part], .bc-bars")]) {
    if (locked) check(el); else if (el.scrollWidth > el.clientWidth + 1) out.push(`${label(el)} width ${el.scrollWidth} > box ${el.clientWidth}`);
  }
  for (const el of board.querySelectorAll("*")) { const o = getComputedStyle(el); if (/^(auto|scroll)$/.test(o.overflowX) || /^(auto|scroll)$/.test(o.overflowY)) out.push(`${label(el)} is a scroller`); }
  const bars = [...board.querySelectorAll(".bc")].map((c) => [...c.querySelectorAll(".pc-row")].filter((r) => !(r as HTMLElement).hidden).length);
  return { out, bars };
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  // Font swap / ResizeObserver / fit's 150ms resize debounce + fadeUp.
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let harness: Bun.Server<undefined> | undefined;
  let browser: Browser | undefined;
  let activePage: Page | undefined;
  const report: Array<{ viewport: string; view: string; desktop: boolean; screenshot: string;
    scrollers: ReturnType<typeof scrollContainers>; failures: string[] }> = [];
  let csrf = "";
  try {
    if (values.login && !values.base) throw new Error("--login requires --base URL");
    if (!SIZES.length) throw new Error("No viewports selected");
    if (!values.base) {
      const dir = join(OUT, "fixtures");
      syntheticFixtures(dir);
      process.env.LWC_FIXTURES_DIR = dir;
      process.env.PORT = "0";
      process.env.PORTFOLIOS_WRITABLE = "false";
      harness = (await import("./dashboard-visual-harness")).server;
    }
    const base = (values.base || `http://127.0.0.1:${harness!.port}`).replace(/\/$/, "");
    browser = await chromium.launch({ executablePath: chromePath(), ignoreDefaultArgs: ["--hide-scrollbars"] });
    const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce" });
    if (values.login) {
      const username = process.env.UC_DASH_USER, file = process.env.UC_DASH_PASSWORD_FILE;
      if (!username || !file) throw new Error("--login requires UC_DASH_USER and UC_DASH_PASSWORD_FILE");
      const response = await context.request.post(`${base}/api/auth/login`, {
        data: { username, password: readFileSync(file, "utf8").trim() },
      });
      const data = await response.json();
      if (!response.ok() || !data.ok) throw new Error(`Login failed (HTTP ${response.status()})`);
      csrf = data.csrfToken;
    }
    // The SPA cannot place orders or edit settings during this check, even on
    // --base. Also stub decorative public feeds so offline CI is deterministic.
    const origin = new URL(base).origin;
    await context.route("**/*", async (route) => {
      const req = route.request(), url = new URL(req.url());
      if (!["GET", "HEAD"].includes(req.method())) return route.abort("blockedbyclient");
      if (url.origin === origin) return route.continue();
      if (url.hostname === "api.binance.com") return route.fulfill({ json: ["BTCUSDT", "ETHUSDT", "NEARUSDT"].map((symbol) => ({ symbol, lastPrice: "12345.67", priceChangePercent: "1.23" })) });
      if (url.hostname === "api.alternative.me") return route.fulfill({ json: { data: [{ value: "52", value_classification: "Neutral" }] } });
      // Fonts are intentionally offline: exercise shipped CSS + system fallback.
      return route.abort("blockedbyclient");
    });
    const pageErrors: string[] = [];
    await context.addInitScript(() => {
      localStorage.setItem("uc4_theme", '"dark"');
      localStorage.setItem("uc4_lang", '"en"');
      localStorage.setItem("uc4_view", '"consolidated"');
      localStorage.setItem("uc4_tab", '"equity"');
    });
    try {
      for (const viewport of SIZES) for (const lang of (viewport.width >= 981 && viewport.height >= 540 ? LANGS : LANGS.slice(0, 1))) {
        // Fresh SPA per size and language: opsTab is module-local, and hash
        // navigation alone would carry the last viewport's Trades tab into the
        // Positions check.
        const page = activePage = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.addInitScript((l) => localStorage.setItem("uc4_lang", JSON.stringify(l)), lang);
        await page.setViewportSize(viewport);
        const desktop = viewport.width >= 981 && viewport.height >= 540;
        const suffix = lang === "en" ? "" : `-${lang}`;
        const capture = async (name: string, pageScrolls = false) => {
          const view = name + suffix;
          await settle(page);
          const screenshot = `${viewport.width}x${viewport.height}-${view}.png`;
          await page.screenshot({ path: join(OUT, screenshot), fullPage: !desktop });
          const scrollers = await page.evaluate(scrollContainers, desktop ? DESKTOP_CAROUSELS : PHONE_CAROUSELS);
          const failures = desktop ? scrollers.filter((s) => (s.element === "document" && s.y && !pageScrolls) || (s.x && !s.allowed))
            .map((s) => s.element) : [];
          report.push({ viewport: `${viewport.width}x${viewport.height}`, view, desktop, screenshot, scrollers, failures });
          for (const s of scrollers.filter((s) => s.x || s.y)) console.log(
            `${failures.includes(s.element) ? "FAIL" : desktop ? "INFO" : "PHONE"}\t${viewport.width}x${viewport.height}\t${view}\t${s.element}\t${s.x ? `${s.sw}/${s.cw}` : "—"}\t${s.y ? `${s.sh}/${s.ch}` : "—"}${s.allowed ? " (carousel)" : ""}`);
        };
        const loaded = () => page.waitForFunction(() => document.querySelector("#anBody")?.textContent?.trim() !== "…");
        console.log("STATUS\tVIEWPORT\tVIEW\tELEMENT\tX scroll/client\tY scroll/client");
        // ── The Overview: ONE board, a column per strategy, nothing scrolls ──
        await page.goto(`${base}/#/resumen`, { waitUntil: "networkidle" });
        await page.locator(".bd .bc[data-id]").first().waitFor();
        if (!values.base) {
          // The curves arrive after the first paint (one fetch per strategy): the four fixture strategies have a series.
          await page.waitForFunction(() => document.querySelectorAll(".bd .pc-curve").length === 4);
          if (await page.locator(".bd .bc[data-id]").count() !== 4) throw new Error("Synthetic board did not render its four strategy columns");
        }
        const locked = viewport.width >= 1280 && viewport.height >= 700;
        await settle(page);
        const board = await page.evaluate(boardProblems, locked);
        await capture("board", desktop && !locked);
        console.log(`${board.out.length ? "FAIL" : "INFO"}\t${viewport.width}x${viewport.height}\tboard${suffix}\t${board.out.length ? board.out.join("; ") : "nothing scrolls"}\tbars per column: ${board.bars.join(" ")}`);
        if (board.out.length) report[report.length - 1].failures.push(...board.out);
        if (!values.base && locked && board.bars.some((n, i) => n < Math.min(4, [32, 11, 0, 4][i] ?? 4))) report[report.length - 1].failures.push("a column shows fewer than 2 + 2 bars");
        // The room under the board can change with no repaint and no window resize (the news bar arriving, a
        // header reflow, a font swap): the bars must be fitted again. Take 36 px away from the board the way a
        // taller news bar would and require that nothing overflows; then give it back.
        if (locked) {
          await page.evaluate(() => { (document.querySelector("#newsBar") as HTMLElement).style.paddingBottom = "36px"; });
          await settle(page);
          const squeezed = await page.evaluate(boardProblems, locked);
          console.log(`${squeezed.out.length ? "FAIL" : "INFO"}\t${viewport.width}x${viewport.height}\tboard${suffix} (36 px less room)\t${squeezed.out.length ? squeezed.out.join("; ") : "refitted, nothing scrolls"}\tbars per column: ${squeezed.bars.join(" ")}`);
          if (squeezed.out.length) report[report.length - 1].failures.push(...squeezed.out.map((o) => `after losing 36 px: ${o}`));
          await page.evaluate(() => { (document.querySelector("#newsBar") as HTMLElement).style.paddingBottom = ""; });
          await settle(page);
          const restored = await page.evaluate(boardProblems, locked);
          if (restored.out.length) report[report.length - 1].failures.push(...restored.out.map((o) => `after getting the room back: ${o}`));
          if (restored.bars.join(" ") !== board.bars.join(" ")) report[report.length - 1].failures.push(`the board did not return to its fit: ${restored.bars.join(" ")} instead of ${board.bars.join(" ")}`);
        }

        // "… 22 more · see all" opens the Detail page on that strategy: its positions tab, the portfolio filter set.
        // (A screen tall enough to show all 32 has no such line, and that is right.)
        const seeAll = page.locator('.bd .bc-more[data-seeall="meanrev_stocks"]:not([hidden])');
        if (!values.base && (await seeAll.count()) === 1) {
          await seeAll.click();
          await page.locator(".viewchip").waitFor();
          await page.locator('#opsBody table tbody tr').first().waitFor();
          if (!(await page.url()).endsWith("#/detalle")) throw new Error("see all should open the Detail page");
          if (await page.locator('[data-opstab="positions"].on').count() !== 1) throw new Error("see all should open the Positions tab");
          // Back on the Overview the filter is gone: the board is always the whole account, all four columns.
          await page.evaluate(() => { location.hash = "#/resumen"; });
          await page.locator(".bd .bc[data-id]").first().waitFor();
          await page.waitForFunction(() => document.querySelectorAll(".bd .bc[data-id]").length === 4);
          if (await page.locator(".viewchip").count() !== 0) throw new Error("the Overview must not keep a portfolio filter");
        }

        // ── Detail: what the Overview used to be (the two cards) ──
        await page.goto(`${base}/#/detalle`, { waitUntil: "networkidle" });
        await page.locator("#opsBody table tbody tr, #opsBody .empty").first().waitFor();
        // Portfolios with > 12 positions start folded (positions.js): unfold them
        // all so the table carries its 47 rows and a real vertical scrollbar.
        for (let guard = 0; guard < 8 && await page.locator('#opsBody .pgroup-btn[aria-expanded="false"]').count(); guard++) {
          await page.locator('#opsBody .pgroup-btn[aria-expanded="false"]').first().click();
        }
        if (!values.base && await page.locator("#opsBody table tbody tr.pos").count() !== 47) throw new Error("Synthetic Positions fixture did not render all 47 rows");
        // The Bot tab (the recent actions, a log) is the analytics card's default.
        await page.locator('[data-atab="bot"]').click();
        await loaded();
        await page.locator("#anBody .bn-events, #anBody .empty").first().waitFor();
        await capture("positions-bot");
        await page.locator('[data-atab="equity"]').click();
        await page.locator(values.base ? "#eqChart canvas, #anBody .empty" : "#eqChart canvas").first().waitFor();
        await capture("positions-equity");
        await page.locator('[data-atab="performance"]').click();
        await loaded();
        await page.locator(values.base ? "#anBody .sc-row, #anBody .empty" : "#anBody .sc-row").first().waitFor();
        if (!values.base && await page.locator("#anBody .sc-row").count() !== 4) throw new Error("Synthetic scorecard did not render all four sleeves");
        await capture("positions-performance");
        // Volume: nine columns and prose in one of them; the table drops columns instead of scrolling.
        await page.locator('[data-atab="volume"]').click();
        await page.locator("#funnelBody table, #funnelBody .muted:not(:has-text('…'))").first().waitFor();
        if (!values.base && await page.locator("#funnelBody tbody tr").count() !== 4) throw new Error("Synthetic Volume fixture did not render its four rows");
        await capture("positions-volume");
        await page.locator('[data-atab="activity"]').click();
        await loaded();
        await page.locator("#anBody .act-row, #anBody .empty").first().waitFor();
        await capture("positions-activity");
        // The P&L bridge modal (wide figures) and the broker modal, then the portfolio filter chip.
        if (await page.locator('.kfig[data-act="pnl-why"]').count()) {
          await page.locator('.kfig[data-act="pnl-why"]').first().click();
          await page.locator(".pb-modal .pb-bridge, .pb-modal .empty:not(:has-text('Loading')):not(:has-text('Cargando'))").first().waitFor();
          await capture("modal-pnl");
          await page.keyboard.press("Escape");
          await page.locator(".pb-modal").waitFor({ state: "detached" });
        } else if (!values.base) throw new Error("Synthetic KPI strip has no clickable P&L figure");
        if (await page.locator("[data-broker]").count()) {
          await page.locator("[data-broker]").first().click();
          await page.locator(".bm-modal .bm-row").first().waitFor();
          await capture("modal-broker");
          await page.locator(".bm-modal .bm-row").first().click();
          await page.locator(".viewchip").waitFor();
          await capture("positions-filtered");
          await page.locator(".viewchip").click();
          await page.locator(".viewchip").waitFor({ state: "detached" });
        } else if (!values.base) throw new Error("Synthetic KPI strip has no broker cell");
        await page.locator('[data-opstab="trades"]').click();
        await page.locator("#opsBody table tbody tr, #opsBody .empty").first().waitFor();
        await capture("trades-performance");
        await page.locator('[data-atab="equity"]').click();
        await loaded();
        await page.locator(values.base ? "#eqChart canvas, #anBody .empty" : "#eqChart canvas").first().waitFor();
        await capture("trades-equity");
        if (!values.ci) for (const view of ["portafolios", "actividad", "ajustes"]) {
          await page.goto(`${base}/#/${view}`, { waitUntil: "networkidle" });
          await page.locator("#pageBody").waitFor();
          await page.waitForFunction(() => document.querySelector("#pageBody")?.textContent?.trim() !== "…");
          if (!values.base && view === "portafolios") await page.locator("#pfBody tbody tr").first().waitFor();
          await capture(view);
        }
        await page.close();
        activePage = undefined;
      }
      if (pageErrors.length) throw new Error(`SPA errors: ${[...new Set(pageErrors)].join("; ")}`);
    } finally {
      // APIRequestContext bypasses the browser's read-only request guard.
      if (values.login) await context.request.post(`${base}/api/auth/logout`, { headers: { "X-CSRF-Token": csrf } }).catch(() => {});
    }
    const failed = report.filter((r) => r.failures.length);
    console.log(`\n${failed.length ? "FAIL" : "PASS"}: ${report.length} captures, ${failed.length} failed. Screenshots + report: ${OUT}`);
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    await activePage?.screenshot({ path: join(OUT, "error.png") }).catch(() => {});
    console.error(`Dashboard layout check failed: ${error instanceof Error ? error.message : error}\nScreenshots + report: ${OUT}`);
    process.exitCode = 1;
  } finally {
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    harness?.stop(true);
  }
}

await main();
