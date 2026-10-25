#!/usr/bin/env bun
// Geometry guard, not a pixel baseline. No DB/broker imports or instance data.
// By default starts the visual harness with generated, synthetic fixtures.
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
  sizes: { type: "string" }, out: { type: "string" },
}, strict: true });
const OUT = resolve(values.out || "reports/dashboard-layout");
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
    id, label, broker, equity: 25_000, initialEquity: 24_000, totalPnl: 1000,
    cash: 8000, openPositions: count, paused: false, mode: "live",
    grossCapMult: id === "momentum_stocks" ? 2.5 : 1.15,
    grossCapBase: id === "meanrev_stocks" ? "allocation" : "equity",
  }));
  const positions = defs.flatMap(([profileId, , , count]) => Array.from({ length: count }, (_, i) => ({
    id: `synthetic-${profileId}-${i}`, profileId,
    symbol: profileId === "momentum_crypto_usdc" ? ["NEAR/USDC", "1000PEPE/USDC", "ETH/USDC", "BTC/USDC"][i] : `DEMO${String(i + 1).padStart(3, "0")}`,
    side: "long", quantity: 1.2345 + i, avgEntryPrice: 12_345.67 + i * 17,
    currentPrice: 12_456.78 + i * 19, unrealizedPnl: (i % 2 ? -1 : 1) * (123.45 + i),
    unrealizedPnlPct: (i % 2 ? -1 : 1) * 1.23,
    stopLoss: i % 3 ? 11_234.56 + i * 17 : null, openedAt: now - 5 * 864e5,
    durationSeconds: 432000,
  })));
  save("dashboard", { accounts, daysRunning: 123, portfolio: {
    positions, openPositions: positions.length, equity: 100_000, cash: 32_000, winRate: 57,
  } });
  const trades = Array.from({ length: 24 }, (_, i) => ({
    id: `synthetic-trade-${i}`, accountId: accounts[i % 4].id, symbol: positions[i].symbol,
    status: "closed", side: "buy", strategy: "synthetic", closeReason: "TRAIL_STOP",
    entryPrice: 12_345.67, exitPrice: 12_456.78, quantity: 1.2345,
    pnl: (i % 2 ? -1 : 1) * 123.45, pnlPct: (i % 2 ? -1 : 1) * 1.23,
    entryTime: now - (i + 5) * 864e5, exitTime: now - i * 3600e3,
  }));
  save("trades", trades);
  const stats = { totalTrades: 60, closedTrades: 40, todayTrades: 8, winRate: 57,
    periodEquityPnl: 234.56, periodEquityPnlPct: 0.23 };
  save("profiles-7d", [{ id: "synthetic", pnlAggregate: {
    equity: 100_000, periodPnl: 234.56, periodPnlPct: 0.23, pnl7d: 1234.56, pnl7dPct: 1.25,
    periodRealized: 123.45, periodRealizedCount: 8, realized7d: 654.32, realized7dCount: 24,
  }, brokerAccounts: ["alpaca", "binance"].map((brokerId) => ({
    brokerId: `${brokerId}_main`, equity: 50_000, firstEquity: 48_000, stats,
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
const HORIZONTAL_ALLOWLIST = ["#newsScroll", ".nav", ".kpis", "#ticker"];
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
      localStorage.setItem("uc4_newsShown", "true");
    });
    try {
      for (const viewport of SIZES) {
        // Fresh SPA per size: opsTab is module-local, and hash navigation alone
        // would carry the last viewport's Trades tab into the Positions check.
        const page = activePage = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.setViewportSize(viewport);
        const desktop = viewport.width >= 981 && viewport.height >= 540;
        const capture = async (view: string) => {
          await settle(page);
          const screenshot = `${viewport.width}x${viewport.height}-${view}.png`;
          await page.screenshot({ path: join(OUT, screenshot), fullPage: !desktop });
          const scrollers = await page.evaluate(scrollContainers, HORIZONTAL_ALLOWLIST);
          const failures = desktop ? scrollers.filter((s) => (s.element === "document" && s.y) || (s.x && !s.allowed))
            .map((s) => s.element) : [];
          report.push({ viewport: `${viewport.width}x${viewport.height}`, view, desktop, screenshot, scrollers, failures });
          for (const s of scrollers.filter((s) => s.x || s.y)) console.log(
            `${failures.includes(s.element) ? "FAIL" : desktop ? "INFO" : "PHONE"}\t${viewport.width}x${viewport.height}\t${view}\t${s.element}\t${s.x ? `${s.sw}/${s.cw}` : "—"}\t${s.y ? `${s.sh}/${s.ch}` : "—"}${s.allowed ? " (carousel)" : ""}`);
        };
        console.log("STATUS\tVIEWPORT\tVIEW\tELEMENT\tX scroll/client\tY scroll/client");
        await page.goto(`${base}/#/resumen`, { waitUntil: "networkidle" });
        await page.locator("#opsBody table tbody tr, #opsBody .empty").first().waitFor();
        // Portfolios with > 12 positions start folded (positions.js): unfold them
        // all so the table carries its 47 rows and a real vertical scrollbar.
        for (let guard = 0; guard < 8 && await page.locator('#opsBody .pgroup-btn[aria-expanded="false"]').count(); guard++) {
          await page.locator('#opsBody .pgroup-btn[aria-expanded="false"]').first().click();
        }
        if (!values.base && await page.locator("#opsBody table tbody tr.pos").count() !== 47) throw new Error("Synthetic Positions fixture did not render all 47 rows");
        await page.locator(values.base ? "#eqChart canvas, #anBody .empty" : "#eqChart canvas").first().waitFor();
        await capture("positions-equity");
        await page.locator('[data-atab="performance"]').click();
        await page.waitForFunction(() => document.querySelector("#anBody")?.textContent?.trim() !== "…");
        await page.locator(values.base ? "#anBody .sc-row, #anBody .empty" : "#anBody .sc-row").first().waitFor();
        if (!values.base && await page.locator("#anBody .sc-row").count() !== 4) throw new Error("Synthetic scorecard did not render all four sleeves");
        await capture("positions-performance");
        await page.locator('[data-opstab="trades"]').click();
        await page.locator("#opsBody table tbody tr, #opsBody .empty").first().waitFor();
        await capture("trades-performance");
        await page.locator('[data-atab="equity"]').click();
        await page.waitForFunction(() => document.querySelector("#anBody")?.textContent?.trim() !== "…");
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
