// ── Positions totals row (2026-08-08) ─────────────────────────────────────
// The sum is trivial; the edge cases are not, and each assertion below is
// about refusing to state something we cannot compute.
import { describe, expect, test } from "bun:test";
import {
  positionsTotals, positionNotional, isInverseContractSleeve,
  sleeveExposure, renderPositions, exposureColor,
  positionGroups, isGroupCollapsed, exposurePhrase, renderExposureBar, togglePositionGroup, COLLAPSE_OVER,
  holdProgress, holdText, weekdaysSince, isCryptoRow, pnlBarWidth, PNL_BAR_FLOOR, MAX_HOLD_SESSIONS, MAX_HOLD_HOURS,
} from "./positions.js";
import { store } from "../store.js";
import { dur } from "../fmt.js";

describe("positionsTotals", () => {
  test("sums the unrealized P&L of every priced position", () => {
    const r = positionsTotals([
      { unrealizedPnl: 6057.91 },
      { unrealizedPnl: 487.2 },
      { unrealizedPnl: -74.09 },
    ]);
    expect(r.total).toBeCloseTo(6471.02, 2);
    expect(r.counted).toBe(3);
    expect(r.unpriced).toBe(0);
  });

  test("an UNPRICED position is excluded and reported, never counted as zero", () => {
    // Outside market hours, or on a thin tape, a price is legitimately
    // unavailable. Treating that as break-even would understate a loss and
    // read as a fact — this is the same "never fabricate a zero" rule the
    // slippage decomposition and /metrics follow.
    const r = positionsTotals([
      { unrealizedPnl: 100 },
      { unrealizedPnl: null },
      { unrealizedPnl: undefined },
      { unrealizedPnl: NaN },
      { unrealizedPnl: -40 },
    ]);
    expect(r.total).toBe(60);
    expect(r.counted).toBe(2);
    expect(r.unpriced).toBe(3);
  });

  test("all positions unpriced → counted 0, so the caller can omit the row entirely", () => {
    const r = positionsTotals([{ unrealizedPnl: NaN }, { unrealizedPnl: null }]);
    expect(r.counted).toBe(0);
    expect(r.unpriced).toBe(2);
  });

  test("no positions → zeros, no crash", () => {
    expect(positionsTotals([])).toEqual({ total: 0, counted: 0, unpriced: 0 });
  });

  test("a numeric string still counts (the payload is JSON from the API)", () => {
    const r = positionsTotals([{ unrealizedPnl: "125.5" }, { unrealizedPnl: 10 }]);
    expect(r.total).toBeCloseTo(135.5, 2);
    expect(r.counted).toBe(2);
  });

  test("losses and gains net out — the total is a sum, not an absolute", () => {
    const r = positionsTotals([{ unrealizedPnl: 500 }, { unrealizedPnl: -500 }]);
    expect(r.total).toBe(0);
    expect(r.counted).toBe(2);
  });
});

// ── positionNotional / isInverseContractSleeve (2026-08-19) ────────────────
// The dashboard used to show no $ size at all, so a sleeve could sit at 2x
// its allocation across identical-looking rows. These functions produce the
// notional the table renders — and refuse to for COIN-M, where quantity is
// a contract count (each a fixed $ notional via contractSize) rather than
// units, so quantity*price would be off by roughly contractSize (~$100).
describe("positionNotional", () => {
  test("stock position: |quantity| * entry price", () => {
    expect(positionNotional({ quantity: 130, avgEntryPrice: 195.5 }, undefined)).toBeCloseTo(25_415, 2);
  });

  test("spot/margined crypto position (momentum_crypto, broker=binance): quantity is real units", () => {
    const account = { id: "momentum_crypto", broker: "binance" };
    expect(positionNotional({ quantity: 0.42, avgEntryPrice: 62_000 }, account)).toBeCloseTo(26_040, 2);
  });

  test("a short position's notional is still positive (size deployed, not signed direction)", () => {
    expect(positionNotional({ quantity: -50, avgEntryPrice: 100 }, undefined)).toBe(5_000);
  });

  test("COIN-M (broker=binance_coinm): quantity*price would be absurd (contracts, not units) — returns null, never a fabricated number", () => {
    const account = { id: "momentum_btc", broker: "binance_coinm" };
    // 37 contracts * $65,000 "price" would read as $2,405,000 — nonsense for
    // a sleeve seeded with $1,000. The real notional needs contractSize
    // (positionUsd() in binance-coinm-executor.ts), which isn't on this payload.
    expect(positionNotional({ quantity: 37, avgEntryPrice: 65_000 }, account)).toBeNull();
    expect(isInverseContractSleeve(account)).toBe(true);
  });

  test("a position missing quantity or entry price doesn't crash the row — null, not NaN/0", () => {
    expect(positionNotional({ quantity: undefined, avgEntryPrice: 100 }, undefined)).toBeNull();
    expect(positionNotional({ quantity: 10, avgEntryPrice: null }, undefined)).toBeNull();
    expect(positionNotional({}, undefined)).toBeNull();
  });

  test("no account (single-sleeve view rows resolve profileId but accById lookup can still miss) defaults to the non-COIN-M formula", () => {
    expect(positionNotional({ quantity: 10, avgEntryPrice: 50 }, undefined)).toBe(500);
  });
});

// ── Groups: one block per portfolio (owner, 2026-10-25: "demasiado ruido") ──
describe("positionGroups", () => {
  test("a portfolio-engine MeanRev at its current 1x equity cap is not red", () => {
    const accounts = [{ id: "meanrev_stocks", label: "MeanRev Stocks", equity: 53_000, initialEquity: 50_000, grossCapMult: 1, grossCapBase: "equity" }];
    const [g] = positionGroups([{ profileId: "meanrev_stocks", quantity: 100, avgEntryPrice: 540, currentPrice: 530 }], accounts);
    expect(g.exposure.ratio).toBe(1);
    expect(exposureColor(g.exposure)).toBe("var(--text)");
    expect(exposurePhrase(g.exposure).text).toBe("1.00× of 1×");
    expect(exposureColor({ ratio: 1.0000746, cap: 1, usage: 1.0000746 })).toBe("var(--text)");
    expect(exposureColor({ ratio: 1.01, cap: 1, usage: 1.01 })).toBe("var(--down)");
  });

  const accounts = [
    { id: "meanrev_stocks", label: "Reversión Stocks", broker: "alpaca", initialEquity: 25_000, equity: 24_500, grossCapMult: 0.966, grossCapBase: "allocation" },
    { id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000, equity: 58_800, grossCapMult: 2.5 },
    { id: "momentum_crypto_usdc", label: "Momentum Cripto USDC", broker: "binance_usdc", initialEquity: 5_000, equity: 7_400, grossCapMult: 1.15 },
  ];
  const stock = (id, symbol, qty, entry, pnl) => ({ symbol, side: "buy", quantity: qty, avgEntryPrice: entry, currentPrice: entry, unrealizedPnl: pnl, profileId: id });
  const book = [
    stock("momentum_crypto_usdc", "ETH/USDC", 1, 2_000, 10),
    stock("meanrev_stocks", "UNH", 10, 300, -50),
    stock("momentum_stocks", "NVDA", 100, 570.21, -1_234),
    stock("meanrev_stocks", "PFE", 100, 30, 20),
  ];

  test("one group per portfolio, biggest invested first, with its own count, $ at cost and unrealized total", () => {
    const groups = positionGroups(book, accounts);
    expect(groups.map((g) => g.id)).toEqual(["momentum_stocks", "meanrev_stocks", "momentum_crypto_usdc"]);
    const [mom, mr, usdc] = groups;
    expect(mom.label).toBe("Momentum Stocks");
    expect(mom.rows.length).toBe(1);
    expect(mom.invested).toBeCloseTo(57_021, 2);
    expect(mom.pnl.total).toBe(-1_234);
    expect(mr.rows.length).toBe(2);
    expect(mr.invested).toBe(6_000);
    expect(mr.pnl.total).toBe(-30);
    expect(usdc.exposure.ratio).toBeCloseTo(2_000 / 7_400, 6);
  });

  test("the group's exposure row is sleeveExposure's (market value over the engine's base)", () => {
    const [mom] = positionGroups(book, accounts);
    expect(mom.exposure.ratio).toBeCloseTo(57_021 / 58_800, 6);
    expect(mom.exposure.cap).toBe(2.5);
  });

  test("a COIN-M group reports invested=null, never a fabricated partial sum", () => {
    const coinm = [{ id: "momentum_btc", label: "Momentum BTC", broker: "binance_coinm", initialEquity: 1_000 }];
    const [g] = positionGroups([{ symbol: "BTC/COIN-M", side: "buy", quantity: 37, avgEntryPrice: 65_000, unrealizedPnl: 30, profileId: "momentum_btc" }], coinm);
    expect(g.invested).toBeNull();
    expect(g.exposure.ratio).toBeNull();
  });

  test("rows without a profileId land in one trailing group, no crash", () => {
    const groups = positionGroups([...book, { symbol: "XYZ", side: "buy", quantity: 1, avgEntryPrice: 1 }], accounts);
    expect(groups.at(-1).id).toBe("");
    expect(groups.at(-1).rows.length).toBe(1);
  });

  test("no positions -> no groups", () => {
    expect(positionGroups([], accounts)).toEqual([]);
  });
});

describe("isGroupCollapsed", () => {
  test(`default: a group with more than ${COLLAPSE_OVER} positions starts collapsed, smaller ones open`, () => {
    expect(isGroupCollapsed("meanrev_stocks", 32, 3, {})).toBe(true);
    expect(isGroupCollapsed("momentum_stocks", 11, 3, {})).toBe(false);
    expect(isGroupCollapsed("x", COLLAPSE_OVER, 3, undefined)).toBe(false);
  });

  test("a lone group never starts collapsed (an empty table would be the result)", () => {
    expect(isGroupCollapsed("meanrev_stocks", 32, 1, {})).toBe(false);
  });

  test("the reader's last click wins over the default, both ways", () => {
    expect(isGroupCollapsed("meanrev_stocks", 32, 3, { meanrev_stocks: "open" })).toBe(false);
    expect(isGroupCollapsed("momentum_stocks", 11, 3, { momentum_stocks: "closed" })).toBe(true);
  });

  test("togglePositionGroup persists the opposite of what is shown", () => {
    const before = store.state.posGroups;
    try {
      store.state.posGroups = {};
      togglePositionGroup("meanrev_stocks", true);
      expect(store.state.posGroups.meanrev_stocks).toBe("open");
      togglePositionGroup("meanrev_stocks", false);
      expect(store.state.posGroups.meanrev_stocks).toBe("closed");
    } finally { store.state.posGroups = before; }
  });
});

describe("exposurePhrase + bar — '1.50× of 2.5×', coloured only near the cap (2026-10-26)", () => {
  test("far from the cap: ratio and cap, uncoloured; the bar fills the used share in muted", () => {
    const p = exposurePhrase({ ratio: 0.97, cap: 2.5, usage: 0.97 / 2.5 });
    expect(p).toEqual({ text: "0.97× of 2.5×", color: null, usage: 0.97 / 2.5 });
    expect(renderExposureBar(p)).toBe('<span class="xbar" aria-hidden="true"><span class="xbar-fill" style="width:38.8%;background:var(--muted)"></span></span>');
  });
  test("at or near the cap: no warning colour (an always-invested book's design size)", () => {
    const p = exposurePhrase({ ratio: 1.1, cap: 1.15, usage: 1.1 / 1.15 });
    expect(p.text).toBe("1.10× of 1.15×");
    expect(p.color).toBeNull();
    expect(renderExposureBar(p)).toContain("width:95.7%;background:var(--muted)");
  });
  test("over the cap: red, the bar clipped at the track; cap precision without float noise", () => {
    const p = exposurePhrase({ ratio: 1.0, cap: 0.9659999999, usage: 1.0 / 0.966 });
    expect(p.text).toBe("1.00× of 0.966×");
    expect(p.color).toBe("var(--down)");
    expect(renderExposureBar(p)).toContain("width:100%;background:var(--down)");
  });
  test("without a cap: the ratio alone, no bar (nothing to fill against)", () => {
    const p = exposurePhrase({ ratio: 1.59, cap: null, usage: null });
    expect(p.text).toBe("1.59×");
    expect(renderExposureBar(p)).toBe("");
  });
  test("unknown ratio (COIN-M) -> null, the header simply omits it", () => {
    expect(exposurePhrase({ ratio: null, cap: 1.15, usage: null })).toBeNull();
    expect(exposurePhrase(null)).toBeNull();
    expect(renderExposureBar(null)).toBe("");
  });
});

// ── The 5-day clock (owner rule 2026-10-26: every operation closes at 5 days) ─
describe("holdProgress — sessions for stocks, hours for crypto", () => {
  const alpaca = { id: "momentum_stocks", broker: "alpaca" };
  const binance = { id: "momentum_crypto_usdc", broker: "binance_usdc" };
  const mon = Date.UTC(2026, 9, 26, 14, 0); // Mon 2026-10-26 10:00 ET
  const day = 864e5;

  test("isCryptoRow: Position.market first, the sleeve's broker as fallback", () => {
    expect(isCryptoRow({ market: "crypto" }, alpaca)).toBe(true);
    expect(isCryptoRow({ market: "stock" }, binance)).toBe(false);
    expect(isCryptoRow({}, binance)).toBe(true);
    expect(isCryptoRow({}, alpaca)).toBe(false);
    expect(isCryptoRow({}, undefined)).toBe(false);
  });

  test("weekdaysSince counts the sessions strictly after the entry's ET date (maxHoldExpired's count), skipping weekends", () => {
    expect(weekdaysSince(mon, mon)).toBe(0);
    expect(weekdaysSince(mon, mon + day)).toBe(1);
    expect(weekdaysSince(mon, mon + 4 * day)).toBe(4); // Fri
    expect(weekdaysSince(mon, mon + 6 * day)).toBe(4); // Sun: the weekend adds nothing
    expect(weekdaysSince(mon, mon + 7 * day)).toBe(5); // next Mon: the 5th session, the close
    // Entry at 19:00 ET Monday is still Monday's date in ET even though it is Tuesday in UTC
    expect(weekdaysSince(Date.UTC(2026, 9, 27, 0, 30), Date.UTC(2026, 9, 27, 14))).toBe(1);
  });

  test("a stock row: dots = sessions elapsed, 'closes in N days' with N the sessions left", () => {
    const p = { symbol: "SPY", market: "stock", openedAt: mon };
    expect(holdProgress(p, alpaca, mon)).toMatchObject({ unit: "sessions", elapsed: 0, limit: MAX_HOLD_SESSIONS, remaining: 5, dots: 0, closing: false });
    expect(holdText(holdProgress(p, alpaca, mon))).toBe("closes in 5 days");
    expect(holdText(holdProgress(p, alpaca, mon + day))).toBe("closes in 4 days");
    expect(holdProgress(p, alpaca, mon + 4 * day)).toMatchObject({ dots: 4, remaining: 1 });
    expect(holdText(holdProgress(p, alpaca, mon + 4 * day))).toBe("closes in 1 day");
    expect(holdText(holdProgress(p, alpaca, mon + 6 * day))).toBe("closes in 1 day"); // Sunday: Monday's pass closes it
  });

  test("past the limit the close is pending: five dots and 'closing'", () => {
    const h = holdProgress({ market: "stock", openedAt: mon }, alpaca, mon + 7 * day);
    expect(h).toMatchObject({ dots: 5, remaining: 0, closing: true });
    expect(holdText(h)).toBe("closing");
    expect(holdProgress({ market: "stock", openedAt: mon }, alpaca, mon + 20 * day)).toMatchObject({ dots: 5, closing: true });
  });

  test("a crypto row runs on 120 calendar hours: a dot per day, days rounded up so dots + days = 5, hours under a day", () => {
    const p = { symbol: "ETH/USDC", openedAt: mon };
    expect(holdProgress(p, binance, mon)).toMatchObject({ unit: "hours", limit: MAX_HOLD_HOURS, remaining: 120, dots: 0, closing: false });
    expect(holdText(holdProgress(p, binance, mon + 20 * 36e5))).toBe("closes in 5 days"); // 0 dots + 5
    expect(holdProgress(p, binance, mon + 50 * 36e5)).toMatchObject({ dots: 2 });
    expect(holdText(holdProgress(p, binance, mon + 50 * 36e5))).toBe("closes in 3 days"); // 2 dots + 3
    expect(holdText(holdProgress(p, binance, mon + 100 * 36e5))).toBe("closes in 20 h");
    expect(holdText(holdProgress(p, binance, mon + 119.5 * 36e5))).toBe("closes in 1 h");
    expect(holdProgress(p, binance, mon + 120 * 36e5)).toMatchObject({ dots: 5, closing: true });
    expect(holdText(holdProgress(p, binance, mon + 130 * 36e5))).toBe("closing");
  });

  test("durationSeconds stands in for a missing openedAt; neither -> null and a dash", () => {
    expect(holdProgress({ market: "stock", durationSeconds: 2 * 86_400 }, alpaca, mon + 2 * day)).toMatchObject({ dots: 2 });
    expect(holdProgress({ market: "stock" }, alpaca, mon)).toBeNull();
    expect(holdText(null)).toBe("—");
  });
});

// ── Row P&L bar: |%| against the largest on screen, floored to a sliver ─────
describe("pnlBarWidth", () => {
  test("proportional to |pct| over the largest |pct| shown, sign-agnostic", () => {
    expect(pnlBarWidth(1.3, 1.3)).toBe(100);
    expect(pnlBarWidth(-1.3, 1.3)).toBe(100);
    expect(pnlBarWidth(0.65, 1.3)).toBe(50);
  });
  test(`a tiny move still shows a sliver (floor ${PNL_BAR_FLOOR}%); a flat row or unknown pct shows none`, () => {
    expect(pnlBarWidth(0.01, 10)).toBe(PNL_BAR_FLOOR);
    expect(pnlBarWidth(0, 10)).toBe(0);
    expect(pnlBarWidth(null, 10)).toBe(0);
    expect(pnlBarWidth(1, 0)).toBe(0);
    expect(pnlBarWidth(undefined, undefined)).toBe(0);
  });
});

describe("dur — one unit only (owner, 2026-10-25)", () => {
  test.each([
    [12 * 864e5 + 11 * 36e5, "12d"], [864e5, "1d"], [11 * 36e5 + 40 * 6e4, "11h"], [45 * 6e4, "45m"], [12e3, "12s"],
  ])("%s ms → %s", (ms, expected) => { expect(dur(ms)).toBe(expected); });
});

// ── sleeveExposure (2026-08-19) — "4 positions" -> "2.05x" ─────────────────
describe("sleeveExposure", () => {
  const accounts = [
    { id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000 },
    { id: "momentum_btc", label: "Momentum BTC (COIN-M)", broker: "binance_coinm", initialEquity: 1_000 },
  ];

  test("4 positions of ~$25.6k each on a $50k sleeve -> ratio ≈ 2.05x (the reported incident)", () => {
    const positions = [
      { profileId: "momentum_stocks", quantity: 130, avgEntryPrice: 195.5 },
      { profileId: "momentum_stocks", quantity: 130, avgEntryPrice: 195.5 },
      { profileId: "momentum_stocks", quantity: 130, avgEntryPrice: 195.5 },
      { profileId: "momentum_stocks", quantity: 130, avgEntryPrice: 197.7 },
    ];
    const [row] = sleeveExposure(positions, accounts);
    expect(row.id).toBe("momentum_stocks");
    expect(row.allocation).toBe(50_000);
    expect(row.ratio).toBeCloseTo(row.notional / 50_000, 6);
    expect(row.ratio).toBeGreaterThan(2);
  });

  test("a sleeve with any COIN-M (unpriceable) position reports ratio=null, not an understated partial sum", () => {
    const positions = [{ profileId: "momentum_btc", quantity: 37, avgEntryPrice: 65_000 }];
    const [row] = sleeveExposure(positions, accounts);
    expect(row.ratio).toBeNull();
    expect(row.unknown).toBe(1);
  });

  test("a position with no profileId is excluded — can't attribute exposure to an unknown sleeve", () => {
    expect(sleeveExposure([{ quantity: 10, avgEntryPrice: 100 }], accounts)).toEqual([]);
  });

  test("no positions -> empty, no crash", () => {
    expect(sleeveExposure([], accounts)).toEqual([]);
  });
});

// ── renderPositions smoke tests — a partial/mixed payload must not throw ──
describe("renderPositions (partial data)", () => {
  const baseState = {
    view: "consolidated",
    dashboard: {
      accounts: [
        { id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000 },
        { id: "momentum_crypto", label: "Momentum Crypto", broker: "binance", initialEquity: 5_000 },
        { id: "momentum_crypto_usdc", label: "Momentum Crypto USDC", broker: "binance_usdc", initialEquity: 5_000 },
      ],
      portfolio: { positions: [] },
    },
  };

  test("a position missing most fields renders without throwing", () => {
    const state = {
      ...baseState,
      dashboard: { ...baseState.dashboard, portfolio: { positions: [{ symbol: "XYZ", side: "buy" }] } },
    };
    expect(() => renderPositions(state, [])).not.toThrow();
    expect(renderPositions(state, [])).toContain("XYZ");
  });

  test("consolidated view: each portfolio is a block under a header in plain words; rows carry no badge", () => {
    const state = {
      ...baseState, posGroups: {},
      dashboard: {
        ...baseState.dashboard,
        portfolio: {
          positions: [
            { symbol: "LINK/USD", side: "buy", quantity: 100, avgEntryPrice: 20, currentPrice: 21, unrealizedPnl: 100, profileId: "momentum_crypto" },
            { symbol: "LINK/USDC", side: "buy", quantity: 100, avgEntryPrice: 20, currentPrice: 21, unrealizedPnl: 100, profileId: "momentum_crypto_usdc" },
          ],
        },
      },
    };
    const html = renderPositions(state, []);
    expect(html.match(/class="pgroup"/g)?.length).toBe(2);
    // invested at cost and the P&L on the left; the exposure (at market, over the base) on the right; the count in the title
    expect(html).toContain('<span class="pg-name">Momentum Crypto</span><span class="pg-sum">$2,000 <span class="muted">·</span> <span class="pg-pnl" style="color:var(--up)">+$100</span></span><span class="pg-exp"><span class="muted">exposure</span><span class="pg-x">0.42×</span></span>');
    expect(html).toContain('<span class="pg-name">Momentum Crypto USDC</span>');
    expect(html).toMatch(/title="1 position\. Holds \$2,100 at market/);
    expect(html).not.toContain("sbadge");
    expect(html).not.toContain("MOM-CRY");
    expect(html).not.toContain("xchip");
    // the header comes before its rows, and each block is in order
    expect(html.indexOf("Momentum Crypto</span>")).toBeLessThan(html.indexOf("LINK/USD<"));
  });

  test("a COIN-M-only group: header without a $ invested or an exposure, never a fabricated $0", () => {
    const state = {
      ...baseState, posGroups: {},
      dashboard: {
        accounts: [...baseState.dashboard.accounts, { id: "momentum_btc", label: "Momentum BTC (COIN-M)", broker: "binance_coinm", initialEquity: 1_000 }],
        portfolio: { positions: [{ symbol: "BTC/COIN-M", side: "buy", quantity: 37, avgEntryPrice: 65_000, currentPrice: 66_000, unrealizedPnl: 30, profileId: "momentum_btc" }] },
      },
    };
    const html = renderPositions(state, []);
    const head = html.slice(html.indexOf('class="pgroup"'), html.indexOf("</button>"));
    expect(head).toContain('<span class="pg-sum"><span class="pg-pnl" style="color:var(--up)">+$30</span></span>');
    expect(head).not.toContain("$0");
    expect(head).not.toContain("×");
    expect(head).not.toContain("pg-exp");
    expect(head).toContain("COIN-M"); // the title explains why
    expect(head).toContain("1 position."); // the count lives in the title
  });

  test("big groups start collapsed (header only, rows hidden) while the totals still count every position", () => {
    const many = Array.from({ length: 32 }, (_, i) => ({ symbol: `MR${i}`, side: "buy", quantity: 1, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 1, profileId: "meanrev_stocks" }));
    const few = Array.from({ length: 11 }, (_, i) => ({ symbol: `MO${i}`, side: "buy", quantity: 1, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 1, profileId: "momentum_stocks" }));
    const state = {
      view: "consolidated", posGroups: {},
      dashboard: {
        accounts: [{ id: "meanrev_stocks", label: "Reversión Stocks", broker: "alpaca", initialEquity: 25_000 }, ...baseState.dashboard.accounts],
        portfolio: { positions: [...many, ...few] },
      },
    };
    let html = renderPositions(state, []);
    expect(html.match(/<tr class="pos">/g)?.length).toBe(11);
    expect(html).toContain('data-pgroup="meanrev_stocks" aria-expanded="false"');
    expect(html).toContain('data-pgroup="momentum_stocks" aria-expanded="true"');
    expect(html).toContain("32 positions."); // in the header's title
    expect(html).toContain("· 43"); // totals row still counts the folded rows
    // the reader opened it
    html = renderPositions({ ...state, posGroups: { meanrev_stocks: "open" } }, []);
    expect(html.match(/<tr class="pos">/g)?.length).toBe(43);
    expect(html).toContain('data-pgroup="meanrev_stocks" aria-expanded="true"');
  });

  test("single-sleeve view with one big group: never collapsed by default", () => {
    const many = Array.from({ length: 32 }, (_, i) => ({ symbol: `MR${i}`, side: "buy", quantity: 1, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 1 }));
    const state = { view: "meanrev_stocks", posGroups: {}, dashboard: { accounts: [{ id: "meanrev_stocks", label: "Reversión Stocks", broker: "alpaca", initialEquity: 25_000 }], portfolio: { positions: many } } };
    const html = renderPositions(state, []);
    expect(html.match(/<tr class="pos">/g)?.length).toBe(32);
    expect(html).toContain('aria-expanded="true"');
  });

  test("the header cell spans every column so hidden columns never shift it (colspan = rendered columns)", () => {
    const state = { ...baseState, posGroups: {}, dashboard: { ...baseState.dashboard, portfolio: { positions: [
      { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 10, stopLoss: 96, profileId: "momentum_stocks" },
    ] } } };
    expect(renderPositions(state, [])).toContain('<tr class="pgroup"><td colspan="6">'); // sym notional entry now pnl time — a stop adds no column
    const tp = { ...state, dashboard: { ...state.dashboard, portfolio: { positions: [{ ...state.dashboard.portfolio.positions[0], takeProfit: 120 }] } } };
    expect(renderPositions(tp, [])).toContain('<tr class="pgroup"><td colspan="7">');
  });

  test("the row carries the P&L bar and the 5-day clock; qty/entry/now ride in the symbol's title", () => {
    const now = Date.now();
    const state = { ...baseState, posGroups: {}, dashboard: { ...baseState.dashboard, portfolio: { positions: [
      { symbol: "SPY", side: "buy", market: "stock", quantity: 130, avgEntryPrice: 195.5, currentPrice: 196, unrealizedPnl: 65, unrealizedPnlPct: 0.5, openedAt: now, profileId: "momentum_stocks" },
      { symbol: "IWM", side: "buy", market: "stock", quantity: 50, avgEntryPrice: 200, currentPrice: 202.6, unrealizedPnl: 130, unrealizedPnlPct: 1.3, openedAt: now, profileId: "momentum_stocks" },
      { symbol: "ETH/USDC", side: "buy", market: "crypto", quantity: 1, avgEntryPrice: 2000, currentPrice: 1990, unrealizedPnl: -10, unrealizedPnlPct: -0.5, openedAt: now - 50 * 36e5, profileId: "momentum_crypto_usdc" },
    ] } } };
    const html = renderPositions(state, []);
    expect(html).toContain('title="Qty 130 · Entry $196 · Now $196">SPY</span>');
    expect(html).not.toContain(">Qty<"); expect(html).not.toContain(">SL<"); expect(html).not.toContain('class="opt1"');
    expect(html).toContain('<span class="pnlbar-fill" style="width:38.5%;background:var(--up)"></span></span><span style="color:var(--up)">+$65 <span class="muted">+0.5%</span>'); // 0.5 / 1.3 of the track
    expect(html).toContain('style="width:100%;background:var(--up)"></span></span><span style="color:var(--up)">+$130');
    expect(html).toContain('style="width:38.5%;background:var(--down)"></span></span><span style="color:var(--down)">−$10');
    expect(html).toContain('<span class="hdots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="opt2 hold-txt muted">closes in 5 days</span>');
    expect(html).toContain('<span class="hdots" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i><i></i></span><span class="opt2 hold-txt muted">closes in 3 days</span>');
    expect(html).toMatch(/class="hold" title="Held 2d · limit 120 h · every operation closes at 5 days/);
    expect(html).toMatch(/<th title="[^"]*5 NYSE sessions for stocks, 120 h for crypto[^"]*">Time<\/th>/);
  });

  test("a pending close reads 'closing' in the text colour; folded groups do not set the bar scale", () => {
    const now = Date.now();
    const many = Array.from({ length: 13 }, (_, i) => ({ symbol: `MR${i}`, side: "buy", market: "stock", quantity: 1, avgEntryPrice: 100, currentPrice: 110, unrealizedPnl: 10, unrealizedPnlPct: 10, openedAt: now, profileId: "meanrev_stocks" }));
    const state = { view: "consolidated", posGroups: {}, dashboard: {
      accounts: [{ id: "meanrev_stocks", label: "MeanRev", broker: "alpaca", initialEquity: 25_000 }, ...baseState.dashboard.accounts],
      portfolio: { positions: [...many, { symbol: "SPY", side: "buy", market: "stock", quantity: 1, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 1, unrealizedPnlPct: 1, openedAt: now - 30 * 864e5, profileId: "momentum_stocks" }] },
    } };
    const html = renderPositions(state, []);
    expect(html).toContain('<span class="opt2 hold-txt">closing</span>');
    expect(html).toContain('style="width:100%;background:var(--up)"'); // SPY's 1% is the largest ON SCREEN (the 13 folded 10% rows don't count)
  });

  test("single-sleeve view: positions with no profileId still resolve exposure/notional from state.view", () => {
    const state = {
      ...baseState, view: "momentum_stocks",
      dashboard: {
        ...baseState.dashboard,
        portfolio: { positions: [{ symbol: "SPY", side: "buy", quantity: 130, avgEntryPrice: 195.5, currentPrice: 196, unrealizedPnl: 65 }] },
      },
    };
    const html = renderPositions(state, []);
    expect(html).toContain("$25,415"); // notional = 130 * 195.5, shown as whole dollars
  });
});

// ── TP column hides when unused; no SL column at all (2026-10-26) ──────────
describe("renderPositions — TP column, no SL column", () => {
  const baseState2 = {
    view: "consolidated",
    dashboard: {
      accounts: [{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000 }],
      portfolio: { positions: [] },
    },
  };

  test("no position has a takeProfit -> the TP column (header + cells) is entirely absent", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 10, stopLoss: 96, profileId: "momentum_stocks" },
        { symbol: "MSFT", side: "buy", quantity: 5, avgEntryPrice: 200, currentPrice: 201, unrealizedPnl: 5, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).not.toContain(">TP<");
  });

  test("at least one position carries a takeProfit -> the column reappears", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 10, takeProfit: 120, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).toContain(">TP<");
    expect(html).toContain("$120<");
  });

  test("a row with a stop renders no SL column and no stop price (owner, 2026-10-26: the stop is one click away via the symbol)", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 100, unrealizedPnl: 0, stopLoss: 96, profileId: "momentum_stocks" },
        { symbol: "MSFT", side: "buy", quantity: 5, avgEntryPrice: 200, currentPrice: 201, unrealizedPnl: 5, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).not.toContain(">SL<");
    expect(html).not.toContain("$96");
    expect(html).not.toContain('class="opt1"');
    expect(html.match(/<th[ >]/g)?.length).toBe(6); // sym notional entry now pnl time
  });
});

describe("positions table: the column header and the totals row stay in view (owner, 2026-10-07)", () => {
  const css = require("fs").readFileSync(require("path").join(import.meta.dir, "../../css/app.css"), "utf-8").replace(/\s+/g, " ");
  test("header and totals rows stick inside the table box", () => {
    expect(css).toContain("#opsBody thead th { position: sticky; top: 0;");
    expect(css).toMatch(/tfoot tr\.totals td \{[^}]*position: sticky; bottom: 0;/);
  });
  test("viewport-locked layout: the table box (not the card body) is the scroller, so the sticky rows have something to stick to", () => {
    const lock = css.slice(css.indexOf("@media (min-width: 981px) and (min-height:"));
    expect(lock).toContain("#opsBody { display: flex; flex-direction: column; overflow: hidden; }");
    expect(lock).toContain("#opsBody > .scroll { flex: 1 1 0; min-height: 0; overflow: auto; }");
  });
});

// ── Exposure vs current equity and the sleeve's own cap (2026-10-12) ───────
// Until then the ratio was taken over the initial allocation and painted red
// at ≥ 1×: the approved 1.5× momentum_stocks book and a USDC sleeve whose
// equity grew from $5k to $7.4k both read as alarms at their designed size.
describe("sleeveExposure — current equity base and cap usage", () => {
  const acc = (over = {}) => ({ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000, ...over });
  const book = [{ symbol: "SPY", side: "buy", quantity: 100, avgEntryPrice: 794.41, profileId: "momentum_stocks" }]; // $79,441

  test("the ratio is over the sleeve's CURRENT equity when the payload carries it", () => {
    const [row] = sleeveExposure(book, [acc({ equity: 52_960, grossCapMult: 1.725 })]);
    expect(row.ratio).toBeCloseTo(79_441 / 52_960, 6); // ≈ 1.50×, not 1.59× of the $50k allocation
    expect(row.cap).toBe(1.725);
    expect(row.usage).toBeCloseTo(row.ratio / 1.725, 6);
  });

  test("meanrev's cap is over its allocation (MeanRevEngine baseUsd), even with a current equity", () => {
    const mr = { id: "meanrev_stocks", label: "MeanRev Stocks", broker: "alpaca", initialEquity: 25_000, equity: 24_000, grossCapMult: 0.966, grossCapBase: "allocation" };
    const [row] = sleeveExposure([{ symbol: "UNH", side: "buy", quantity: 10, avgEntryPrice: 300, profileId: "meanrev_stocks" }], [mr]);
    expect(row.baseKind).toBe("allocation");
    expect(row.ratio).toBeCloseTo(3_000 / 25_000, 6);
  });

  test("the ratio is over MARKET value (what the engine's cap check sums), entry price only as fallback", () => {
    const pos = [
      { symbol: "LINK/USDC", side: "buy", quantity: 100, avgEntryPrice: 14, currentPrice: 12, profileId: "momentum_stocks" },
      { symbol: "UNI/USDC", side: "buy", quantity: 100, avgEntryPrice: 10, profileId: "momentum_stocks" },
    ];
    const [row] = sleeveExposure(pos, [acc({ equity: 2_000, grossCapMult: 1.15 })]);
    expect(row.notional).toBe(100 * 12 + 100 * 10);
    expect(row.ratio).toBeCloseTo(2_200 / 2_000, 6);
  });

  test("the cap shows its real precision, without float noise, and only when the book is near it", () => {
    const html = renderPositions({ view: "consolidated", posGroups: {}, dashboard: { accounts: [acc({ equity: 52_960, grossCapMult: 1.7249999999999999 })], portfolio: { positions: book } } }, []);
    expect(html).toContain('<span class="pg-x">1.50× of 1.725×</span>'); // 87% of the cap: uncoloured, muted bar
    expect(html).toContain("width:87%;background:var(--muted)");
    expect(html).toMatch(/title="[^"]*Cap 1\.725×\./);
    const near = renderPositions({ view: "consolidated", posGroups: {}, dashboard: { accounts: [acc({ equity: 50_000, grossCapMult: 1.7249999999999999 })], portfolio: { positions: book } } }, []);
    expect(near).toContain('<span class="pg-x">1.59× of 1.725×</span>');
    expect(near).toContain("width:92.1%;background:var(--muted)"); // at the cap is not a warning
  });

  test("colour by share of the cap: normal below 90%, amber from 90%, red past the cap", () => {
    expect(exposureColor({ ratio: 1.5, usage: 1.5 / 1.725 })).toBe("var(--text)");
    expect(exposureColor({ ratio: 1.6, usage: 1.6 / 1.725 })).toBe("var(--text)");
    expect(exposureColor({ ratio: 1.8, usage: 1.8 / 1.725 })).toBe("var(--down)");
    expect(exposureColor({ ratio: null, usage: null })).toBe("var(--muted)");
  });

  test("without a cap or a current equity it falls back to the old rule over the allocation", () => {
    const [row] = sleeveExposure(book, [acc()]);
    expect(row.ratio).toBeCloseTo(79_441 / 50_000, 6);
    expect(row.cap).toBeNull();
    expect(exposureColor(row)).toBe("var(--down)");
  });

  test("the group header says it in words; the $ at market and the base ride in its title", () => {
    const state = { view: "consolidated", posGroups: {}, dashboard: { accounts: [acc({ equity: 52_960, grossCapMult: 1.725 })], portfolio: { positions: book } } };
    const html = renderPositions(state, []);
    expect(html).toContain('<span class="pg-sum">$79,441</span>'); // no priced P&L on this row: the $ alone
    expect(html).toMatch(/class="pgroup-btn"[^>]*title="1 position\. Holds \$79,441 at market against \$52,960 of current equity \(1\.50×\)\. Cap 1\.725×\. Allocation \$50,000\. Click to show or hide its positions\."/);
  });
});

describe("renderPositions — side column only when a short exists", () => {
  const accounts = [{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000 }];
  const row = (symbol, side) => ({ symbol, side, quantity: 1, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: side === "buy" ? 1 : -1, profileId: "momentum_stocks" });

  test("long-only book (every live strategy today): no S column, totals label spans one column", () => {
    const html = renderPositions({ view: "consolidated", dashboard: { accounts, portfolio: { positions: [row("AAPL", "buy"), row("MSFT", "buy")] } } }, []);
    expect(html).not.toContain("<th>S</th>");
    expect(html).not.toContain('class="badge l"');
    expect(html).toContain('<td colspan="1"');
  });

  test("a short position brings the column back, with its badge", () => {
    const html = renderPositions({ view: "consolidated", dashboard: { accounts, portfolio: { positions: [row("AAPL", "buy"), row("QQQ", "sell")] } } }, []);
    expect(html).toContain("<th>S</th>");
    expect(html).toContain('class="badge s"');
    expect(html).toContain('<td colspan="2"');
  });
});

describe("renderPositions — compact numbers", () => {
  const state = (positions) => ({ view: "consolidated", dashboard: { accounts: [], portfolio: { positions } } });

  test("prices, notional and total lose cents; P&L percent keeps a decimal; the quantity rides in the symbol's title", () => {
    const html = renderPositions(state([
      { symbol: "SPY", side: "buy", quantity: 5.59, avgEntryPrice: 540.1, currentPrice: 525.25, stopLoss: 478.4, unrealizedPnl: -85.04, unrealizedPnlPct: -0.3 },
      { symbol: "QQQ", side: "buy", quantity: 10, avgEntryPrice: 540.1, unrealizedPnl: -1709.38 },
    ]), []);
    for (const value of ['title="Qty 6 · Entry $540 · Now $525"', "$540<", "$525<", "$3,019<", "−$85 ", "−$1,794<", "−0.3%"])
      expect(html).toContain(value);
    expect(html).not.toContain("$478");
    expect(html).not.toContain("$540.10");
    expect(html).not.toContain("$1,794.42");
  });

  test("small crypto prices, quantities and notionals remain meaningful", () => {
    const html = renderPositions(state([
      { symbol: "DOGE/USD", side: "buy", quantity: 115.7, avgEntryPrice: 0.0777, currentPrice: 0.0789, stopLoss: 0.07, unrealizedPnl: 0.139, unrealizedPnlPct: 1.5 },
      { symbol: "BTC/USD", side: "buy", quantity: 0.0123, avgEntryPrice: 68000, currentPrice: 68100, unrealizedPnl: 1.23 },
    ]), []);
    for (const value of ["Qty 116 ·", "Qty 0.0123 ·", "$0.0777<", "$0.0789<", "$8.99<", "+$0 "])
      expect(html).toContain(value);
  });
});
