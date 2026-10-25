// ── Positions totals row (2026-08-08) ─────────────────────────────────────
// The sum is trivial; the edge cases are not, and each assertion below is
// about refusing to state something we cannot compute.
import { describe, expect, test } from "bun:test";
import {
  positionsTotals, positionNotional, isInverseContractSleeve,
  sleeveExposure, renderPositions, stopDistancePct, exposureColor,
  positionGroups, isGroupCollapsed, exposurePhrase, togglePositionGroup, COLLAPSE_OVER,
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
    expect(exposureColor(g.exposure)).toBe("var(--warn)");
    expect(exposurePhrase(g.exposure).text).toContain("cap 1×");
    expect(exposureColor({ ratio: 1.0000746, cap: 1, usage: 1.0000746 })).toBe("var(--warn)");
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

describe("exposurePhrase — plain words, the cap only when it matters", () => {
  test("far from the cap: ratio only, uncoloured", () => {
    expect(exposurePhrase({ ratio: 0.97, cap: 2.5, usage: 0.97 / 2.5 })).toEqual({ text: "0.97× of its capital", color: null });
  });
  test("near the cap: the cap is named and the phrase takes the warning colour", () => {
    const p = exposurePhrase({ ratio: 1.1, cap: 1.15, usage: 1.1 / 1.15 });
    expect(p.text).toBe("1.10× of its capital, cap 1.15×");
    expect(p.color).toBe("var(--warn)");
  });
  test("over the cap: red; cap precision without float noise", () => {
    const p = exposurePhrase({ ratio: 1.0, cap: 0.9659999999, usage: 1.0 / 0.966 });
    expect(p.text).toBe("1.00× of its capital, cap 0.966×");
    expect(p.color).toBe("var(--down)");
  });
  test("unknown ratio (COIN-M) -> null, the header simply omits it", () => {
    expect(exposurePhrase({ ratio: null, cap: 1.15, usage: null })).toBeNull();
    expect(exposurePhrase(null)).toBeNull();
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
    expect(html).toContain('<span class="pg-name">Momentum Crypto</span><span class="pg-sum">1 position, $2,000 invested, 0.42× of its capital</span>'); // invested at cost, exposure at market
    expect(html).toContain('<span class="pg-name">Momentum Crypto USDC</span>');
    expect(html).toContain('<span class="pg-pnl" style="color:var(--up)">+$100</span>');
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
    expect(head).toContain('<span class="pg-sum">1 position</span>');
    expect(head).not.toContain("$0");
    expect(head).not.toContain("×");
    expect(head).toContain("COIN-M"); // the title explains why
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
    expect(html).toContain("32 positions");
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
    expect(renderPositions(state, [])).toContain('<tr class="pgroup"><td colspan="8">'); // sym qty entry notional now pnl time sl
    const noStop = { ...state, dashboard: { ...state.dashboard, portfolio: { positions: [{ ...state.dashboard.portfolio.positions[0], stopLoss: null }] } } };
    expect(renderPositions(noStop, [])).toContain('<tr class="pgroup"><td colspan="7">');
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

// ── stopDistancePct (2026-09-24 audit fix, item 4) ─────────────────────────
describe("stopDistancePct", () => {
  test("long: stop below price -> positive room before it triggers", () => {
    expect(stopDistancePct(100, 96, true)).toBeCloseTo(4, 6); // (100-96)/100
  });

  test("short: stop above price -> positive room before it triggers", () => {
    expect(stopDistancePct(100, 104, false)).toBeCloseTo(4, 6); // (104-100)/100
  });

  test("price already past the stop -> negative (informational, not clamped)", () => {
    expect(stopDistancePct(94, 96, true)).toBeCloseTo(-2.127659574, 6);
  });

  test("missing currentPrice or stopLoss -> null, never a fabricated %", () => {
    expect(stopDistancePct(null, 96, true)).toBeNull();
    expect(stopDistancePct(100, null, true)).toBeNull();
    expect(stopDistancePct(undefined, undefined, true)).toBeNull();
  });
});

// ── TP column hides when unused; SL shows distance% (2026-09-24, item 4) ───
describe("renderPositions — TP column + SL distance%", () => {
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

  test("SL cell shows the stop price AND the distance% to it", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 100, unrealizedPnl: 0, stopLoss: 96, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).toContain("$96 <");
    expect(html).toContain("4.0%"); // (100-96)/100
  });

  test("no stopLoss on any row -> the SL column (header + cells) is entirely absent, like TP", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 10, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).not.toContain(">SL<");
    expect(html).not.toContain('class="opt1"');
  });

  test("one row with a stop brings the column back; the stop-less row shows a dash", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 100, unrealizedPnl: 0, stopLoss: 96, profileId: "momentum_stocks" },
        { symbol: "MSFT", side: "buy", quantity: 5, avgEntryPrice: 200, currentPrice: 201, unrealizedPnl: 5, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).toContain(">SL</th>");
    expect(html).toContain('<td class="opt1">—</td>');
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
    expect(html).toContain("1.50× of its capital</span>"); // 87% of the cap: the cap stays in the title
    expect(html).not.toContain("1.725×</span>");
    expect(html).toMatch(/title="[^"]*Cap 1\.725×\./);
    const near = renderPositions({ view: "consolidated", posGroups: {}, dashboard: { accounts: [acc({ equity: 50_000, grossCapMult: 1.7249999999999999 })], portfolio: { positions: book } } }, []);
    expect(near).toContain('<span style="color:var(--warn)">1.59× of its capital, cap 1.725×</span>');
  });

  test("colour by share of the cap: normal below 90%, amber from 90%, red past the cap", () => {
    expect(exposureColor({ ratio: 1.5, usage: 1.5 / 1.725 })).toBe("var(--text)");
    expect(exposureColor({ ratio: 1.6, usage: 1.6 / 1.725 })).toBe("var(--warn)");
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
    expect(html).toContain('<span class="pg-sum">1 position, $79,441 invested, 1.50× of its capital</span>');
    expect(html).toMatch(/class="pgroup-btn"[^>]*title="Holds \$79,441 at market against \$52,960 of current equity \(1\.50×\)\. Cap 1\.725×\. Allocation \$50,000\. Click to show or hide its positions\."/);
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

  test("prices, notional, stops and total lose cents; P&L percent keeps a decimal", () => {
    const html = renderPositions(state([
      { symbol: "SPY", side: "buy", quantity: 5.59, avgEntryPrice: 540.1, currentPrice: 525.25, stopLoss: 478.4, unrealizedPnl: -85.04, unrealizedPnlPct: -0.3 },
      { symbol: "QQQ", side: "buy", quantity: 10, avgEntryPrice: 540.1, unrealizedPnl: -1709.38 },
    ]), []);
    for (const value of [">6<", "$540<", "$525<", "$3,019<", "−$85 ", "$478 ", "−$1,794<", "−0.3%"])
      expect(html).toContain(value);
    expect(html).not.toContain("$540.10");
    expect(html).not.toContain("$1,794.42");
  });

  test("small crypto prices, quantities and notionals remain meaningful", () => {
    const html = renderPositions(state([
      { symbol: "DOGE/USD", side: "buy", quantity: 115.7, avgEntryPrice: 0.0777, currentPrice: 0.0789, stopLoss: 0.07, unrealizedPnl: 0.139, unrealizedPnlPct: 1.5 },
      { symbol: "BTC/USD", side: "buy", quantity: 0.0123, avgEntryPrice: 68000, currentPrice: 68100, unrealizedPnl: 1.23 },
    ]), []);
    for (const value of [">116<", ">0.0123<", "$0.0777<", "$0.0789<", "$0.07 ", "$8.99<", "+$0 "])
      expect(html).toContain(value);
  });
});
