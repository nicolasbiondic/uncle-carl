// ── dashboard audit G (2026-11-07): the owner-facing behaviours added by the fixes ──
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { api } from "../api.js";
import { net, staleNotice, renderHeader } from "./header.js";
import { viewChip } from "./viewchip.js";
import { renderTrades } from "./trades.js";
import { renderPositions } from "./positions.js";
import { activityText, activityLogHtml } from "./activity.js";
import { blocksHtml } from "./funnel.js";
import { renderBotNow } from "./botnow.js";

const original = { ...store.state };
afterEach(() => { Object.assign(store.state, original); Object.assign(net, { lastOkAt: 0, refreshFailed: false, wsUp: null }); });

describe("G-5 — the sleeve filter is visible and never persisted", () => {
  test("whole-account view: no chip", () => {
    store.state.view = "consolidated";
    expect(viewChip()).toBe("");
  });
  test("a filtered view says so, in both languages, and offers the way back", () => {
    store.state.dashboard = { accounts: [{ id: "momentum_stocks", label: "Momentum Stocks" }] };
    store.state.view = "momentum_stocks";
    const en = viewChip();
    expect(en).toContain("Only Momentum Stocks · show all");
    expect(en).toContain('data-act="view-all"');
    store.state.lang = "es";
    expect(viewChip()).toContain("Solo Momentum Acciones · ver todo");
  });
  test("`view` is not a persisted key", async () => {
    const src = await Bun.file(new URL("../store.js", import.meta.url)).text();
    expect(src).toMatch(/const PERSIST = \[[^\]]*\]/);
    expect(src.match(/const PERSIST = \[[^\]]*\]/)[0]).not.toContain('"view"');
  });
});

describe("G-6 — stale/offline notice and error states", () => {
  test("nothing while all is well; names the New York time of the last good data otherwise", () => {
    expect(staleNotice()).toBe("");
    net.lastOkAt = Date.UTC(2026, 10, 6, 15, 5); // 10:05 AM ET
    net.refreshFailed = true;
    expect(staleNotice()).toBe("Server not reachable · data from 10:05 AM ET");
    net.refreshFailed = false; net.wsUp = false;
    expect(staleNotice()).toBe("Live updates paused · data from 10:05 AM ET");
    store.state.lang = "es";
    expect(staleNotice()).toBe("Actualización en vivo en pausa · datos de las 10:05 AM ET");
    net.wsUp = true;
    expect(staleNotice()).toBe("");
  });
  test("the header carries the notice element (hidden when fine)", () => {
    expect(renderHeader()).toContain('id="stale"');
    expect(renderHeader()).toMatch(/id="stale"[^>]* hidden/);
    net.refreshFailed = true;
    expect(renderHeader()).not.toMatch(/id="stale"[^>]* hidden/);
  });
  test("a failed trades feed is an error, not 'no closed trades'; an empty list is the real empty state", () => {
    expect(renderTrades(null)).toContain("Could not load the trades");
    expect(renderTrades([])).toContain("No closed trades yet");
  });
  test("positions that never loaded say so instead of 'no open positions'", () => {
    expect(renderPositions({ dashboard: null }, [])).toContain("Could not load the positions");
    expect(renderPositions({ dashboard: { portfolio: { positions: [] } } }, [])).toContain("No open positions");
  });
  test("the trades feed reports failure as null", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("down"); };
    try { expect(await api.trades(5)).toBeNull(); } finally { globalThis.fetch = real; }
  });
});

describe("G-9/G-13 — the activity log is plain words", () => {
  test("engine sentences and ids are not printed; the symbol survives", () => {
    const rows = [
      { created_at: Date.UTC(2026, 10, 6, 15, 5), account_id: "momentum_crypto_usdc", event_type: "trade", message: "Resized SOL/USDC ×0.794: −3 @ $140.5 (qty 9)" },
      { created_at: Date.UTC(2026, 10, 6, 15, 6), account_id: null, event_type: "circuit", message: "accounts registry: alpaca venue UNLINKED — stock engines not built (reason)" },
    ];
    const html = activityLogHtml(rows);
    expect(html).toContain("Nov 6, 10:05 AM ET");
    expect(html).toContain("Trimmed SOL/USDC");
    expect(html).toContain("Safety notice");
    for (const raw of ["registry", "UNLINKED", "×0.794", "momentum_crypto_usdc", "qty 9"]) expect(html).not.toContain(raw);
  });
  test("known shapes and the Spanish UI", () => {
    store.state.lang = "es";
    expect(activityText({ event_type: "sync", message: "Found AAPL on Alpaca: long 5 @ $1.00" })).toBe("AAPL encontrada en el broker");
    expect(activityText({ event_type: "x", message: "?" })).toBe("Aviso");
  });
  test("prod's commonest rows keep the action and the symbol (orders, closes)", () => {
    store.state.lang = "en";
    expect(activityText({ event_type: "order", message: "SELL 928.8 XRP/USDC @ $1.18" })).toBe("Sold XRP/USDC");
    expect(activityText({ event_type: "order", message: "BUY 41 BOXX @ $118.94" })).toBe("Bought BOXX");
    expect(activityText({ event_type: "close", message: "NEAR/USDC PnL $-193.85 (-19.3%)" })).toBe("Closed NEAR/USDC −$194");
    store.state.lang = "es";
    expect(activityText({ event_type: "close", message: "SOL/USD PnL $1,204.5 (+3.1%)" })).toBe("Cerró SOL/USD +$1,205");
  });
});

describe("G-12 — Volume blocks in words", () => {
  test("engine keys never appear; the same word counts once", () => {
    const html = blocksHtml({ breakout_short_close_failed: 2, idle_overlay_close_failed: 1, gross_cap: 4, brand_new_key: 3 });
    expect(html).toContain("gross cap 4");
    expect(html).toContain("close failed 3");
    expect(html).toContain("other 3");
    for (const raw of ["breakout", "idle_overlay", "brand_new_key", "_"]) expect(html).not.toContain(raw);
    expect(blocksHtml({})).toContain("—");
  });
});

describe("Bot tab", () => {
  test("a missing answer is an error message, with no engine text", () => {
    expect(renderBotNow(null)).toContain("empty");
  });
  test("an hourly crypto sleeve's rebalance is not 'daily'", () => {
    const html = renderBotNow({
      portfolios: [{ id: "momentum_crypto", label: "Momentum Crypto", broker: "binance", state: "invested", positions: 1, investedUsd: 100, equityUsd: 200, cadence: { kind: "hourly", at: ":00" } }],
      events: [{ at: Date.now() - 3600e3, portfolioId: "momentum_crypto", kind: "close", symbol: "ETH/USD", qty: 1, usd: 100, pnlUsd: 5, reason: "MOMENTUM_REBALANCE" }],
    }, { now: Date.now(), tz: "America/New_York" });
    expect(html).toContain("hourly rebalance");
    expect(html).not.toContain("daily rebalance");
  });
  test("the portfolio label is escaped in event lines", () => {
    const html = renderBotNow({ portfolios: [{ id: "x", label: "<img src=x>", state: "flat", positions: 0 }],
      events: [{ at: Date.now() - 1000, portfolioId: "x", kind: "buy", symbol: "A", qty: 1, usd: 10, reason: "ENTRY" }] }, { now: Date.now(), tz: "America/New_York" });
    expect(html).not.toContain("<img src=x>");
  });
});
