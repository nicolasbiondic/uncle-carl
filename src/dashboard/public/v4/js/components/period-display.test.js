// ══════════════════════════════════════════════
// Dashboard equity-history fix (§5/§6, frontend side): "Since Start" was
// removed from the KPI bar entirely (superseded by the always-visible 7D
// figure); the selected-window top P&L and the fixed 7D KPI now carry a
// server-computed pct beside them (null hides, an actual 0 still renders
// "0.0%" — never a frontend division). The portfolio cells (Alpaca / Binance,
// part of the KPI strip since 2026-10-25) label their P&L with the SELECTED
// window, not a hardcoded "Today", and also carry the server pct.
// ══════════════════════════════════════════════

import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { money } from "../fmt.js";
import { renderKpis } from "./kpis.js";
import { renderProfiles } from "./profiles.js";

const originalState = { ...store.state };

const account = (id, label, broker = "alpaca") => ({
  id, label: label || id, broker, equity: 50_000, cash: 40_000,
  initialEquity: 50_000, totalPnl: 100, totalPnlPct: 0.2,
  positions: 1, paused: false, todayTrades: 2,
});

afterEach(() => Object.assign(store.state, originalState));

// pnlAggregate = the ONE server-computed figure (routes/profiles.ts,
// combining every applicable *_main broker-truth leg) the KPI bar reads
// straight through — see broker-truth.test.js.
const withAggregate = (periodPnl, periodPnlPct) => [{ pnlAggregate: { equity: 106826, periodPnl, periodPnlPct, pnl7d: 0, pnl7dPct: 0 } }];

describe("renderKpis — no Since Start, server-computed period pct", () => {
  test("one row: equity, both portfolios, the P&L windows, return, trades, win rate — no Risk, Running, Fear & Greed or Open", () => {
    Object.assign(store.state, {
      lang: "en", period: 1, profiles: withAggregate(-1794.42, -0.3),
      dashboard: { daysRunning: 99, portfolio: { openPositions: 21 }, accounts: [account("momentum_stocks", "Stocks", "alpaca"), account("momentum_crypto", "Crypto", "binance")] },
      kpis: { ret: { dailyAvgPct30d: 0.1 }, risk: { drawdownPct: 1 } },
    });
    const html = renderKpis();
    // plain labels, then the two portfolio cells (their label line holds the name + status)
    expect([...html.matchAll(/class="kl">([^<]+)</g)].map((m) => m[1])).toEqual([
      "Total equity", "Today P&amp;L", "7D P&amp;L", "Return 30D", "Orders today", "Win rate",
    ]);
    expect([...html.matchAll(/data-broker="(\w+)"/g)].map((m) => m[1])).toEqual(["alpaca", "binance"]);
    // Alpaca and Binance sit between Total equity and Today P&L
    const at = (s) => html.indexOf(s);
    expect(at("Total equity")).toBeLessThan(at('data-broker="alpaca"'));
    expect(at('data-broker="binance"')).toBeLessThan(at("Today P&amp;L"));
    expect(html).not.toMatch(/Risk|Running|Fear|Greed|>Open<|lo2|DD/);
    expect(html).toContain("all-time closes");
  });

  test("sub-lines are plain sentences, not 'A · B · C' strings", () => {
    Object.assign(store.state, {
      lang: "en", period: 1, view: "consolidated", dashboard: {}, profiles: withAggregate(10, 0.1),
      kpis: { ret: { dailyAvgPct30d: -0.17 }, targets: { dailyReturnPct: 0.12, tradesPerDay: 30 }, volume: { today: 0, avg7d: 4.2 } },
    });
    const html = renderKpis();
    expect(html).toContain("goal 0.12%/day");
    expect(html).toContain("7d avg 4.2");
    expect(html).not.toContain("·");
  });

  test("KPI money is whole dollars even below $100; percentages retain precision", () => {
    Object.assign(store.state, {
      lang: "en", period: 1, view: "consolidated", dashboard: {}, kpis: null,
      profiles: [{ pnlAggregate: { equity: 106826.74, periodPnl: -85.04, periodPnlPct: -0.3, pnl7d: -1794.42, pnl7dPct: -1.7, periodRealized: 8.99, periodRealizedCount: 1, realized7d: 7963.43, realized7dCount: 19 } }],
    });
    const html = renderKpis();
    for (const value of ["$106,827", "−$85", "−$1,794", "+$9", "+$7,963", "−0.3%"])
      expect(html).toContain(value);
    expect(html).not.toMatch(/\$[\d,]+\./);
  });

  test("the Since Start KPI is gone", () => {
    Object.assign(store.state, { period: 1, profiles: [], dashboard: { portfolio: {} } });
    expect(renderKpis()).not.toContain("Since Start");
  });

  test("hides the pct when periodPnlPct is null (rebased display anchor)", () => {
    Object.assign(store.state, { period: 1, view: "consolidated", profiles: withAggregate(1234, null), dashboard: { portfolio: {} } });
    const html = renderKpis();
    expect(html).toContain("+$1,234");
    const pnlCell = html.slice(html.indexOf("Today P&L"), html.indexOf("Today P&L") + 200);
    expect(pnlCell).not.toContain("%");
  });

  test("renders the pct when it is a real (non-null) number, including exactly 0", () => {
    Object.assign(store.state, { period: 1, view: "consolidated", profiles: withAggregate(500, 4.2), dashboard: { portfolio: {} } });
    expect(renderKpis()).toContain("+4.2%");

    Object.assign(store.state, { period: 1, view: "consolidated", profiles: withAggregate(0, 0), dashboard: { portfolio: {} } });
    // Zero still shows — it is a real value, not "unavailable".
    expect(renderKpis()).toContain("+0.0%");
  });

  test("falls back to an honest computed % when the server pct is null (rebased anchor)", () => {
    // All P&L → return on seed capital (Σ initialEquity), NOT the rebased anchor;
    // fixed 7D → window-start equity (now − 7d P&L). Both consolidated-only.
    Object.assign(store.state, {
      period: 0, view: "consolidated",
      profiles: [{ pnlAggregate: { equity: 111100, periodPnl: 2200, periodPnlPct: null, pnl7d: 1100, pnl7dPct: null } }],
      dashboard: { accounts: [{ initialEquity: 110000 }] },
    });
    const html = renderKpis();
    expect(html).toContain("+2.0%"); // All: 2200 / Σ initialEquity(110000)
    expect(html).toContain("+1.0%"); // 7D: 1100 / (111100 − 1100 = 110000)
  });

  test("selected 7D window derives its % from window-start equity when the server pct is null", () => {
    // At period=7 the top P&L cell IS the 7D figure (the fixed 7D cell is hidden).
    Object.assign(store.state, {
      period: 7, view: "consolidated",
      profiles: [{ pnlAggregate: { equity: 111000, periodPnl: 1000, periodPnlPct: null, pnl7d: 1000, pnl7dPct: null } }],
      dashboard: { accounts: [{ initialEquity: 90000 }] },
    });
    // 1000 / (111000 − 1000 = 110000) = 0.9%
    expect(renderKpis()).toContain("+0.9%");
  });
});

// Profile cards are now aggregated PER BROKER (Alpaca / Binance) — one card
// summing every sleeve on that broker; per-sleeve detail moved to the
// broker-modal opened by clicking the card (data-broker, not data-pid).
describe("portfolio cells — broker aggregation + period label", () => {
  const profilesWith = (id, perAccountStats) => [{ brokerAccounts: [{ perAccountStats: { [id]: perAccountStats } }] }];

  test("shows 'Today' at period=1 and '7D' at period=7 — not always 'Today'", () => {
    Object.assign(store.state, { period: 1, profiles: [], dashboard: { accounts: [account("momentum_stocks")] } });
    expect(renderProfiles()).toContain(">Today <b");

    Object.assign(store.state, { period: 7, profiles: [], dashboard: { accounts: [account("momentum_stocks")] } });
    expect(renderProfiles()).toContain(">7D <b");

    Object.assign(store.state, { period: 0, profiles: [], dashboard: { accounts: [account("momentum_stocks")] } });
    expect(renderProfiles()).toContain(">All <b");
  });

  test("sums period P&L across every sleeve on the broker", () => {
    Object.assign(store.state, {
      period: 1,
      profiles: profilesWith("momentum_stocks", { periodEquityPnl: 42, periodEquityPnlPct: null }),
      dashboard: { accounts: [account("momentum_stocks")] },
    });
    const html = renderProfiles();
    const pnlCell = html.slice(html.indexOf(">Today <b"), html.indexOf(">Today <b") + 150);
    expect(pnlCell).toContain("+$42<"); // whole dollars, like the rest of the strip
  });

  test("one cell per broker: two sleeves on the same broker collapse into one cell", () => {
    Object.assign(store.state, {
      period: 1,
      profiles: [],
      dashboard: { accounts: [account("momentum_stocks", "Momentum Stocks", "alpaca"), account("meanrev_stocks", "Meanrev Stocks", "alpaca")] },
    });
    const html = renderProfiles();
    expect((html.match(/data-broker="alpaca"/g) || []).length).toBe(1);
    expect(html).not.toContain("2 sleeves");
    expect(html).not.toContain('class="broker"');
    expect(html).toContain("Live");
    expect(html).not.toMatch(/LIVE|→/);
    expect(html).toContain('title="Details: Alpaca"');
    expect(html).toContain('data-spark="alpaca_main"');
    expect(html).toContain(money(100_000, 0));
  });

  test("broker cells carry data-broker, not data-pid, and are keyboard buttons", () => {
    Object.assign(store.state, {
      period: 1,
      profiles: [],
      dashboard: { accounts: [account("momentum_crypto_usdc", "Momentum Crypto USDC", "binance")] },
    });
    const html = renderProfiles();
    expect(html).toContain('data-broker="binance"');
    expect(html).toMatch(/data-broker="binance" role="button" tabindex="0"/);
    expect(html).not.toContain("data-pid");
  });

  test("a paused sleeve and a disconnected broker say so instead of Live", () => {
    Object.assign(store.state, {
      lang: "en", period: 1, profiles: [],
      dashboard: { accounts: [{ ...account("momentum_crypto", "Crypto", "binance"), paused: true }] },
    });
    expect(renderProfiles()).toContain("1 paused");
    Object.assign(store.state, { connections: { binance: { connected: false, dataConnected: false } } });
    expect(renderProfiles()).toContain("Disconnected");
    expect(renderProfiles()).not.toContain("Live");
  });

  test("broker cell uses broker-truth (brokerAccounts) for equity + period P&L so the cards reconcile with the headline", () => {
    // Per-sleeve today would be −24 (misses unrealized); broker-truth is −326.11.
    // Σ(broker-truth periodEquityPnl) === pnlAggregate.periodPnl (the headline).
    Object.assign(store.state, {
      period: 1,
      profiles: [{
        brokerAccounts: [{
          brokerId: "alpaca_paper", equity: 101909, firstEquity: 100000,
          stats: { periodEquityPnl: -326.11, periodEquityPnlPct: -0.32 },
        }],
      }],
      dashboard: { accounts: [account("momentum_stocks", "Momentum Stocks", "alpaca")] },
    });
    const html = renderProfiles();
    expect(html).toContain(money(101909, 0)); // broker-truth equity, not the 50k sleeve
    const cell = html.slice(html.indexOf(">Today <b"), html.indexOf(">Today <b") + 200);
    expect(cell).toContain("−$326<");          // broker-truth today (−326.11), not the sleeve figure
    expect(cell).toContain("var(--down)");     // rendered as a loss
  });
});
