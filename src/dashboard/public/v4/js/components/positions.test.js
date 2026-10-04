// ── Positions totals row (2026-08-08) ─────────────────────────────────────
// The sum is trivial; the edge cases are not, and each assertion below is
// about refusing to state something we cannot compute.
import { describe, expect, test } from "bun:test";
import {
  positionsTotals, positionNotional, isInverseContractSleeve,
  sleeveBadgeCode, sleeveExposure, renderPositions, stopDistancePct,
} from "./positions.js";

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

describe("sleeveBadgeCode", () => {
  test("every currently-declared sleeve id gets a distinct, short code", () => {
    const ids = ["momentum_stocks", "momentum_crypto", "meanrev_stocks", "momentum_crypto_usdc", "momentum_btc"];
    const codes = ids.map(sleeveBadgeCode);
    expect(new Set(codes).size).toBe(ids.length);
    for (const c of codes) expect(c.length).toBeLessThanOrEqual(11);
  });

  test("distinguishes the two Binance quote-asset sleeves at a glance", () => {
    expect(sleeveBadgeCode("momentum_crypto")).toBe("MOM-CRY");
    expect(sleeveBadgeCode("momentum_crypto_usdc")).toBe("MOM-CRY-USD");
  });

  test("no id -> empty, not a crash", () => {
    expect(sleeveBadgeCode(undefined)).toBe("");
  });
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

  test("consolidated view: LINK/USD (momentum_crypto) and LINK/USDC (momentum_crypto_usdc) rows carry distinct sleeve badges", () => {
    const state = {
      ...baseState,
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
    expect(html).toContain("MOM-CRY<");
    expect(html).toContain("MOM-CRY-USD<");
  });

  test("a COIN-M-only sleeve's exposure chip shows — for notional, never a fabricated $0", () => {
    const state = {
      ...baseState,
      dashboard: {
        accounts: [...baseState.dashboard.accounts, { id: "momentum_btc", label: "Momentum BTC (COIN-M)", broker: "binance_coinm", initialEquity: 1_000 }],
        portfolio: { positions: [{ symbol: "BTC/COIN-M", side: "buy", quantity: 37, avgEntryPrice: 65_000, currentPrice: 66_000, unrealizedPnl: 30, profileId: "momentum_btc" }] },
      },
    };
    const html = renderPositions(state, []);
    expect(html).not.toContain("$0 / $1,000");
    expect(html).toContain("MOM-BTC · — / $1,000");
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
    expect(html).toContain("$120.00");
  });

  test("SL cell shows the stop price AND the distance% to it", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 100, unrealizedPnl: 0, stopLoss: 96, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).toContain("$96.00");
    expect(html).toContain("4.0%"); // (100-96)/100
  });

  test("no stopLoss on any row -> SL cell is a plain dash, no fabricated %", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 10, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).toContain('<td class="opt1">—</td>');
  });
});
