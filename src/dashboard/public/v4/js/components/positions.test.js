// ── Positions totals row (2026-08-08) ─────────────────────────────────────
// The sum is trivial; the edge cases are not, and each assertion below is
// about refusing to state something we cannot compute.
import { describe, expect, test } from "bun:test";
import {
  positionsTotals, positionNotional, isInverseContractSleeve,
  sleeveExposure, renderPositions, exposureColor,
  positionGroups, isGroupCollapsed, exposurePhrase, isOverLimit, togglePositionGroup, COLLAPSE_OVER, groupOutcome, outcomeWords,
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
    expect(positionsTotals([])).toEqual({ total: 0, counted: 0, unpriced: 0, pct: null });
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

// The weighted % of the open book (2026-11-14): Σ result ÷ Σ entry amount, the
// same denominator each row's own % uses — never an average of percentages.
describe("positionsTotals — pct", () => {
  const row = (quantity, avgEntryPrice, unrealizedPnl) => ({ quantity, avgEntryPrice, unrealizedPnl });

  test("is the weighted result: Σ unrealizedPnl ÷ Σ |qty| × entry × 100, not the mean of the rows' %", () => {
    // +10 % on $1,000 and −1 % on $9,000: the book is (100 − 90) / 10,000 = +0.1 %, the mean of the rows' % would say +4.5 %
    const r = positionsTotals([row(10, 100, 100), row(90, 100, -90)]);
    expect(r.pct).toBeCloseTo(0.1, 10);
    expect(r.total).toBe(10);
  });

  test("a short counts its size, not its sign (|quantity|)", () => {
    expect(positionsTotals([row(-50, 100, -250)]).pct).toBeCloseTo(-5, 10);
  });

  test("only the counted rows are in the denominator: an unpriced row is in neither part", () => {
    const r = positionsTotals([row(10, 100, 50), { quantity: 1_000, avgEntryPrice: 100, unrealizedPnl: null }]);
    expect(r).toMatchObject({ total: 50, counted: 1, unpriced: 1 });
    expect(r.pct).toBeCloseTo(5, 10);
  });

  test("null — never 0, never a partial denominator — when any counted row has no usable entry amount", () => {
    expect(positionsTotals([row(10, 100, 50), { unrealizedPnl: 10 }]).pct).toBeNull();           // no quantity / entry at all
    expect(positionsTotals([row(10, 100, 50), row(null, 100, 10)]).pct).toBeNull();               // null quantity must not coerce to 0
    expect(positionsTotals([row(10, 100, 50), row(5, "", 10)]).pct).toBeNull();                   // "" entry price
    expect(positionsTotals([row(0, 100, 0)]).pct).toBeNull();                                      // a zero entry amount cannot be a denominator
    expect(positionsTotals([]).pct).toBeNull();
    expect(positionsTotals([{ unrealizedPnl: NaN }]).pct).toBeNull();                             // nothing counted
  });

  test("the caller can say what an entry amount is: COIN-M quantities are contracts, so the book has no %", () => {
    const rows = [row(37, 65_000, 30), row(10, 100, 5)];
    expect(positionsTotals(rows).pct).not.toBeNull(); // from the row alone it cannot tell
    const accounts = { a: { broker: "binance_coinm" }, b: { broker: "alpaca" } };
    const entryAmount = (p) => positionNotional(p, accounts[p === rows[0] ? "a" : "b"]);
    expect(positionsTotals(rows, { entryAmount }).pct).toBeNull();
    expect(positionsTotals([rows[1]], { entryAmount }).pct).toBeCloseTo(0.5, 10);
  });

  test("additive: total, counted and unpriced are what they were, and the group / footer figures use the sleeve-aware amount", () => {
    expect(positionsTotals([{ unrealizedPnl: 6057.91 }, { unrealizedPnl: -74.09 }])).toMatchObject({ total: 5983.82, counted: 2, unpriced: 0, pct: null });
    const coinm = [{ id: "momentum_btc", label: "Momentum BTC (COIN-M)", broker: "binance_coinm", initialEquity: 1_000 }];
    const [g] = positionGroups([{ symbol: "BTC/COIN-M", side: "buy", quantity: 37, avgEntryPrice: 65_000, unrealizedPnl: 30, profileId: "momentum_btc" }], coinm);
    expect(g.pnl).toMatchObject({ total: 30, counted: 1, pct: null });
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
    expect(exposurePhrase(g.exposure).text).toBe("invested 100 % of its capital"); // a cap of 100 % is not repeated
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

describe("group header: a sentence, with the Bot panel's strategy names (2026-11-12)", () => {
  const accounts = [
    { id: "meanrev_stocks", label: "MeanRev Stocks", broker: "alpaca", initialEquity: 50_000, equity: 54_000, grossCapMult: 1, grossCapBase: "equity" },
    { id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000, equity: 50_000, grossCapMult: 2.5 },
  ];
  // 32 meanrev rows at $1,500 market value: 20 up (+$30 each), 1 flat, 11 down (−$7 each)
  const mr = Array.from({ length: 32 }, (_, i) => ({ symbol: `MR${i}`, side: "buy", quantity: 15, avgEntryPrice: 100, currentPrice: 100, unrealizedPnl: i < 20 ? 30 : i === 20 ? 0 : -7, unrealizedPnlPct: 1, profileId: "meanrev_stocks" }));
  const mo = [{ symbol: "SSO", side: "buy", quantity: 100, avgEntryPrice: 80, currentPrice: 80, unrealizedPnl: -50, unrealizedPnlPct: -1, profileId: "momentum_stocks" }];
  const state = { view: "consolidated", posGroups: { meanrev_stocks: "closed" }, dashboard: { accounts, portfolio: { positions: [...mr, ...mo] } } };
  const head = (html, id) => html.slice(html.indexOf(`data-pgroup="${id}"`), html.indexOf("</button>", html.indexOf(`data-pgroup="${id}"`)));

  test("English: one plain sentence — name · positions · $ at market · open result with its weighted %", () => {
    const h = head(renderPositions(state, []), "meanrev_stocks");
    // +$523 on $47,477 entered… = +1.1 %: whole above 1 %
    expect(h).toContain('<span class="pg-name">Mean Reversion Stocks</span><span class="pg-sum"><span class="muted">·</span> 32 positions <span class="muted">·</span> $48,000 <span class="muted">·</span> <span class="pg-pnl" style="color:var(--up)">open +$523 (+1 %)</span></span>');
    expect(h).toContain('aria-expanded="false"'); // still the one clickable row that folds the group
    // no bars, no gauge, no up/down words: the picture lives in the chart view
    for (const gone of ["splitbar", "cgauge", "cg-", "pg-split", "pg-exp", "pg-x", "up, 11 down"]) expect(h).not.toContain(gone);
    expect(h).not.toContain("×");
  });

  test("the exposure moved to the title: the whole sentence, then the market value against the base and the limit", () => {
    const h = head(renderPositions(state, []), "meanrev_stocks");
    expect(h).toMatch(/title="Mean Reversion Stocks · 32 positions · \$48,000 · open \+\$523 \(\+1 %\) · invested 89 % of its capital\. Holds \$48,000 at market against \$54,000 of current equity \(89 %\)\. Limit 100 %\./);
    expect(h).toContain("Click to show or hide its positions.");
    const mo = head(renderPositions(state, []), "momentum_stocks");
    expect(mo).toContain("invested 16 % of its capital · limit 250 %"); // a cap that is not 100 % is said
  });

  test("the group's % is the weighted one, one decimal below 1 % and whole above; absent when an entry amount is unknown", () => {
    const rows = (pnl, id = "momentum_stocks") => [{ symbol: "A", side: "buy", quantity: 100, avgEntryPrice: 80, currentPrice: 80, unrealizedPnl: pnl, profileId: id }];
    const hdr = (pnl) => head(renderPositions({ ...state, dashboard: { accounts, portfolio: { positions: rows(pnl) } } }, []), "momentum_stocks");
    expect(hdr(-50)).toContain("open −$50 (−0.6 %)</span>");   // −50 / 8,000
    expect(hdr(-400)).toContain("open −$400 (−5 %)</span>");
    expect(hdr(80)).toContain("open +$80 (+1 %)</span>");
    const noEntry = [{ symbol: "A", side: "buy", currentPrice: 80, unrealizedPnl: -50, profileId: "momentum_stocks" }];
    const h = head(renderPositions({ ...state, dashboard: { accounts, portfolio: { positions: noEntry } } }, []), "momentum_stocks");
    expect(h).toContain("open −$50</span>");
    expect(h).not.toContain("%)");
  });

  test("Spanish: sin cerrar, and the exposure in the title", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "es";
      const html = renderPositions(state, []);
      const h = head(html, "meanrev_stocks");
      expect(h).toContain('<span class="pg-name">Reversión a la media Acciones</span>');
      expect(h).toContain("32 posiciones");
      expect(h).toContain("sin cerrar +$523 (+1 %)");
      expect(h).toContain("invertido el 89 % de su capital");
      expect(head(html, "momentum_stocks")).toContain("invertido el 16 % de su capital · límite 250 %");
    } finally { store.state.lang = lang; }
  });

  test("groupOutcome counts only priced rows: an unpriced row is in none", () => {
    expect(groupOutcome([{ unrealizedPnl: 5 }, { unrealizedPnl: -5 }, { unrealizedPnl: 0 }, { unrealizedPnl: null }, {}])).toEqual({ up: 1, down: 1, flat: 1 });
    expect(outcomeWords({ up: 0, down: 0, flat: 0 })).toBe("");
    expect(outcomeWords({ up: 1, down: 1, flat: 0 })).toBe("1 up, 1 down");
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

describe("exposurePhrase — 'invested 93 % of its capital', red only past the limit (the title's words)", () => {
  test("far from the cap: whole percentages and the limit, uncoloured", () => {
    const p = exposurePhrase({ ratio: 0.97, cap: 2.5, usage: 0.97 / 2.5 });
    expect(p).toEqual({ text: "invested 97 % of its capital · limit 250 %", body: "97 % of its capital · limit 250 %", color: null, usage: 0.97 / 2.5, ratio: 0.97, cap: 2.5 });
  });
  test("at or near the cap: no warning colour (an always-invested book's design size)", () => {
    const p = exposurePhrase({ ratio: 1.1, cap: 1.15, usage: 1.1 / 1.15 });
    expect(p.text).toBe("invested 110 % of its capital · limit 115 %");
    expect(p.color).toBeNull();
    expect(exposurePhrase({ ratio: 1.15, cap: 1.15, usage: 1 }).color).toBeNull(); // AT the limit is the design size
  });
  test("over the cap: red, and the limit is said even when it is 100 %", () => {
    const p = exposurePhrase({ ratio: 1.0, cap: 0.9659999999, usage: 1.0 / 0.966 });
    expect(p.text).toBe("invested 100 % of its capital · limit 97 %"); // whole percentages, no float noise
    expect(p.color).toBe("var(--down)");
    expect(exposurePhrase({ ratio: 1.05, cap: 1, usage: 1.05 }).text).toBe("invested 105 % of its capital · limit 100 %"); // the red always has a word
  });
  test("without a cap: the percentage alone in words", () => {
    expect(exposurePhrase({ ratio: 1.59, cap: null, usage: null }).text).toBe("invested 159 % of its capital");
  });
  test("the one rule for 'past the limit' is exposureColor's", () => {
    expect(isOverLimit(1.0000746, 1)).toBe(false);
    expect(isOverLimit(1.01, 1)).toBe(true);
    expect(isOverLimit(1.725, 1.725)).toBe(false);
    expect(isOverLimit(0.99, null)).toBe(false);
    expect(isOverLimit(1, null)).toBe(true);
    expect(isOverLimit(null, 1)).toBe(false);
    for (const [ratio, cap] of [[1.1, 1.15], [1.2, 1.15], [1.0000746, 1], [1.01, 1], [0.5, 2.5]]) {
      expect(isOverLimit(ratio, cap)).toBe(exposureColor({ ratio, cap, usage: ratio / cap }) === "var(--down)");
    }
  });
  test("in Spanish, with no '×' anywhere", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "es";
      expect(exposurePhrase({ ratio: 0.934, cap: 2.5, usage: 0.37 }).text).toBe("invertido el 93 % de su capital · límite 250 %");
      expect(exposurePhrase({ ratio: 1, cap: 1, usage: 1 }).text).toBe("invertido el 100 % de su capital");
    } finally { store.state.lang = lang; }
    for (const x of [{ ratio: 0.97, cap: 2.5, usage: 0.39 }, { ratio: 1.59, cap: null, usage: null }]) expect(exposurePhrase(x).text).not.toContain("×");
  });
  test("unknown ratio (COIN-M) -> null, the header simply omits it", () => {
    expect(exposurePhrase({ ratio: null, cap: 1.15, usage: null })).toBeNull();
    expect(exposurePhrase(null)).toBeNull();
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

  test("a stock row: segments filled = days held, 'up to N days left' with N the sessions left", () => {
    const p = { symbol: "SPY", market: "stock", openedAt: mon };
    expect(holdProgress(p, alpaca, mon)).toMatchObject({ unit: "sessions", elapsed: 0, limit: MAX_HOLD_SESSIONS, remaining: 5, days: 0, closing: false });
    expect(holdText(holdProgress(p, alpaca, mon))).toBe("up to 5 days left");
    expect(holdText(holdProgress(p, alpaca, mon + day))).toBe("up to 4 days left");
    expect(holdProgress(p, alpaca, mon + 4 * day)).toMatchObject({ days: 4, remaining: 1 });
    expect(holdText(holdProgress(p, alpaca, mon + 4 * day))).toBe("up to 1 day left");
    expect(holdText(holdProgress(p, alpaca, mon + 6 * day))).toBe("up to 1 day left"); // Sunday: Monday's pass closes it
  });

  test("past the limit the close is pending: five segments and 'due to close'", () => {
    const h = holdProgress({ market: "stock", openedAt: mon }, alpaca, mon + 7 * day);
    expect(h).toMatchObject({ days: 5, remaining: 0, closing: true });
    expect(holdText(h)).toBe("due to close");
    expect(holdProgress({ market: "stock", openedAt: mon }, alpaca, mon + 20 * day)).toMatchObject({ days: 5, closing: true });
  });

  test("a crypto row runs on 120 calendar hours: a segment per day, days rounded up so segments + days left = 5, hours under a day", () => {
    const p = { symbol: "ETH/USDC", openedAt: mon };
    expect(holdProgress(p, binance, mon)).toMatchObject({ unit: "hours", limit: MAX_HOLD_HOURS, remaining: 120, days: 0, closing: false });
    expect(holdText(holdProgress(p, binance, mon + 20 * 36e5))).toBe("up to 5 days left"); // 0 segments + 5
    expect(holdProgress(p, binance, mon + 50 * 36e5)).toMatchObject({ days: 2 });
    expect(holdText(holdProgress(p, binance, mon + 50 * 36e5))).toBe("up to 3 days left"); // 2 segments + 3
    expect(holdText(holdProgress(p, binance, mon + 100 * 36e5))).toBe("up to 20 h left");
    expect(holdText(holdProgress(p, binance, mon + 119.5 * 36e5))).toBe("up to 1 h left");
    expect(holdProgress(p, binance, mon + 120 * 36e5)).toMatchObject({ days: 5, closing: true });
    expect(holdText(holdProgress(p, binance, mon + 130 * 36e5))).toBe("due to close");
  });

  test("durationSeconds stands in for a missing openedAt; neither -> null and a dash", () => {
    expect(holdProgress({ market: "stock", durationSeconds: 2 * 86_400 }, alpaca, mon + 2 * day)).toMatchObject({ days: 2 });
    expect(holdProgress({ market: "stock" }, alpaca, mon)).toBeNull();
    expect(holdText(null)).toBe("—");
  });

  test("the same words in Spanish", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "es";
      const p = { symbol: "SPY", market: "stock", openedAt: mon };
      expect(holdText(holdProgress(p, alpaca, mon + 3 * day))).toBe("le quedan hasta 2 días");
      expect(holdText(holdProgress(p, alpaca, mon + 4 * day))).toBe("le queda hasta 1 día");
      expect(holdText(holdProgress({ symbol: "ETH/USDC", openedAt: mon }, binance, mon + 100 * 36e5))).toBe("le quedan hasta 20 h");
      expect(holdText(holdProgress(p, alpaca, mon + 7 * day))).toBe("toca cerrar");
    } finally { store.state.lang = lang; }
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
    // one plain sentence: name · count · $ at market · open result with its %
    expect(html).toContain('<span class="pg-name">Momentum Crypto</span><span class="pg-sum"><span class="muted">·</span> 1 position <span class="muted">·</span> $2,100 <span class="muted">·</span> <span class="pg-pnl" style="color:var(--up)">open +$100 (+5 %)</span></span>');
    expect(html).toContain('<span class="pg-name">Momentum Crypto USDC</span>');
    expect(html).not.toContain("×");
    expect(html).toMatch(/title="Momentum Crypto · 1 position · \$2,100 · open \+\$100 \(\+5 %\) · invested 42 % of its capital\. Holds \$2,100 at market/);
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
    expect(head).toContain('<span class="pg-sum"><span class="muted">·</span> 1 position <span class="muted">·</span> <span class="pg-pnl" style="color:var(--up)">open +$30</span></span>'); // no % either: a contract count is not an entry amount
    expect(head).not.toContain("%)");
    expect(head).not.toContain("$0");
    expect(head).not.toContain("×");
    expect(head).not.toContain("pg-exp");
    expect(head).toContain("COIN-M"); // the title explains why
    expect(head).toContain("1 position ·"); // the title says it too
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
    expect(html).toContain("· 32 positions ·"); // in the header's title, the whole sentence
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
    expect(renderPositions(state, [])).toContain('<tr class="pgroup"><td colspan="4">'); // position value result time — a stop adds no column
    const tp = { ...state, dashboard: { ...state.dashboard, portfolio: { positions: [{ ...state.dashboard.portfolio.positions[0], takeProfit: 120 }] } } };
    expect(renderPositions(tp, [])).toContain('<tr class="pgroup"><td colspan="5">');
  });

  test("the row reads as a sentence: name, value, a diverging result bar with its amount, the time left; entry/now ride in the symbol's title", () => {
    const now = Date.now();
    const state = { ...baseState, posGroups: {}, dashboard: { ...baseState.dashboard, portfolio: { positions: [
      { symbol: "SPY", side: "buy", market: "stock", quantity: 130, avgEntryPrice: 195.5, currentPrice: 196, unrealizedPnl: 65, unrealizedPnlPct: 0.5, openedAt: now, profileId: "momentum_stocks" },
      { symbol: "IWM", side: "buy", market: "stock", quantity: 50, avgEntryPrice: 200, currentPrice: 202.6, unrealizedPnl: 130, unrealizedPnlPct: 1.3, openedAt: now, profileId: "momentum_stocks" },
      { symbol: "ETH/USDC", side: "buy", market: "crypto", quantity: 1, avgEntryPrice: 2000, currentPrice: 1990, unrealizedPnl: -10, unrealizedPnlPct: -0.5, openedAt: now - 50 * 36e5, profileId: "momentum_crypto_usdc" },
    ] } } };
    const html = renderPositions(state, []);
    // the ticker stays, clickable, its tooltip carries quantity, entry and now; the plain name sits beside it
    expect(html).toContain('title="Qty 130 · Entry $196 · Now $196">SPY</span><span class="symname" title="S&amp;P 500">S&amp;P 500</span>');
    expect(html).toContain('>IWM</span><span class="symname" title="Small US companies">Small US companies</span>');
    expect(html).toContain('>ETH/USDC</span><span class="symname" title="Ethereum">Ethereum</span>');
    expect(html).not.toContain(">Qty<"); expect(html).not.toContain(">SL<"); expect(html).not.toContain('class="opt1"');
    // no side column, no Entry / Now columns, no badge
    expect(html).not.toContain('class="badge'); expect(html).not.toContain('class="opt3"'); expect(html).not.toContain("<th>S</th>");
    expect(html.match(/<th[ >]/g)?.length).toBe(4);
    // a gain grows right of the zero line (0.5 / 1.3 of the half track), a loss grows left; amount and % in their own cells
    expect(html).toContain('<span class="dbar" aria-hidden="true"><span class="dbar-l"></span><span class="dbar-r"><i style="width:38.5%;background:var(--up)"></i></span></span><span class="res-amt" style="color:var(--up)"><span class="vh">gain </span>+$65</span><span class="res-pct muted">+1%</span>');
    expect(html).toContain('<span class="dbar-r"><i style="width:100%;background:var(--up)"></i></span></span><span class="res-amt" style="color:var(--up)"><span class="vh">gain </span>+$130</span>');
    expect(html).toContain('<span class="dbar-l"><i style="width:38.5%;background:var(--down)"></i></span><span class="dbar-r"></span></span><span class="res-amt" style="color:var(--down)"><span class="vh">loss </span>−$10</span><span class="res-pct muted">0%</span>'); // −0.5 % rounds to a whole 0 %
    expect(html).not.toContain("pnlbar");
    // the 5-day clock: five segments, the held days filled, then the words
    expect(html).toContain('<span class="hseg" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="opt2 hold-txt muted">up to 5 days left</span>');
    expect(html).toContain('<span class="hseg" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i><i></i></span><span class="opt2 hold-txt muted">up to 3 days left</span>');
    expect(html).toMatch(/class="hold" title="Held 2d · limit 120 h · Your 5-day rule is the latest a position stays open/);
    // column headers in words, sentence case
    expect(html).toContain(">Position</th>"); expect(html).toContain(">Value</th>");
    expect(html).toContain(">Open (since entry)</th>");
    expect(html).toMatch(/<th class="th-time" title="[^"]*5 market sessions for stocks, 120 h for crypto[^"]*">Time left<\/th>/);
  });

  test("the same row and headers in Spanish", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "es";
      const now = Date.now();
      const state = { ...baseState, posGroups: {}, dashboard: { ...baseState.dashboard, portfolio: { positions: [
        { symbol: "UGL", side: "buy", market: "stock", quantity: 300, avgEntryPrice: 55, currentPrice: 54, unrealizedPnl: -300, unrealizedPnlPct: -1.8, openedAt: now - 2 * 864e5, profileId: "momentum_stocks" },
      ] } } };
      const html = renderPositions(state, []);
      expect(html).toContain('<span class="symname" title="Oro ×2">Oro ×2</span>');
      for (const head of [">Posición</th>", ">Valor</th>", ">Sin cerrar</th>", ">Tiempo</th>"]) expect(html).toContain(head);
      expect(html).toContain('<span class="vh">pérdida </span>−$300</span><span class="res-pct muted">−2%</span>');
      expect(html).toMatch(/hold-txt muted">(le quedan hasta \d días|le queda hasta 1 día|toca cerrar)</); // which one depends on the weekday it runs
      expect(html).toContain("invertido el"); // the group's exposure sentence
    } finally { store.state.lang = lang; }
  });

  test("a row's words: no all-caps header, the bar and the segments are decoration only", () => {
    const state = { ...baseState, posGroups: {}, dashboard: { accounts: [{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000, grossCapMult: 2.5 }], portfolio: { positions: [
      { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 10, unrealizedPnlPct: 1, profileId: "momentum_stocks" },
    ] } } };
    const html = renderPositions(state, []);
    for (const deco of ['class="dbar" aria-hidden="true"', 'class="hseg" aria-hidden="true"']) expect(html).toContain(deco);
    const css = require("fs").readFileSync(require("path").join(import.meta.dir, "../../css/app.css"), "utf-8").replace(/\s+/g, " ");
    expect(css).toContain("#opsBody th { text-transform: none; letter-spacing: 0; }");
    expect(html).not.toMatch(/>(SYM|NOTIONAL|ENTRY|NOW|OPEN|TIME)</);
  });

  test("a pending close reads 'closing' in the text colour; folded groups do not set the bar scale", () => {
    const now = Date.now();
    const many = Array.from({ length: 13 }, (_, i) => ({ symbol: `MR${i}`, side: "buy", market: "stock", quantity: 1, avgEntryPrice: 100, currentPrice: 110, unrealizedPnl: 10, unrealizedPnlPct: 10, openedAt: now, profileId: "meanrev_stocks" }));
    const state = { view: "consolidated", posGroups: {}, dashboard: {
      accounts: [{ id: "meanrev_stocks", label: "MeanRev", broker: "alpaca", initialEquity: 25_000 }, ...baseState.dashboard.accounts],
      portfolio: { positions: [...many, { symbol: "SPY", side: "buy", market: "stock", quantity: 1, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 1, unrealizedPnlPct: 1, openedAt: now - 30 * 864e5, profileId: "momentum_stocks" }] },
    } };
    const html = renderPositions(state, []);
    expect(html).toContain('<span class="opt2 hold-txt">due to close</span>');
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
    expect(html).toContain("$25,480"); // current market value = 130 * 196
    expect(html).not.toContain("$25,415");
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
    expect(html).not.toContain(">Target<");
  });

  test("at least one position carries a takeProfit -> the column reappears", () => {
    const state = {
      ...baseState2,
      dashboard: { ...baseState2.dashboard, portfolio: { positions: [
        { symbol: "AAPL", side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: 10, takeProfit: 120, profileId: "momentum_stocks" },
      ] } },
    };
    const html = renderPositions(state, []);
    expect(html).toContain(">Target</th>"); // in words, not "TP"
    expect(html).not.toContain(">TP<");
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
    expect(html.match(/<th[ >]/g)?.length).toBe(4); // position value result time
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

  test("the cap reads as a whole percentage, without float noise, and only when the book is near it", () => {
    const html = renderPositions({ view: "consolidated", posGroups: {}, dashboard: { accounts: [acc({ equity: 52_960, grossCapMult: 1.7249999999999999 })], portfolio: { positions: book } } }, []);
    expect(html).toMatch(/title="[^"]*invested 150 % of its capital · limit 173 %\. Holds[^"]*Limit 173 %\./); // 87% of the cap: the words are in the title, no colour
    const near = renderPositions({ view: "consolidated", posGroups: {}, dashboard: { accounts: [acc({ equity: 50_000, grossCapMult: 1.7249999999999999 })], portfolio: { positions: book } } }, []);
    expect(near).toMatch(/title="[^"]*invested 159 % of its capital · limit 173 %\./); // near the cap is not a warning
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
    expect(html).toContain('<span class="pg-sum"><span class="muted">·</span> 1 position <span class="muted">·</span> $79,441</span>'); // no priced P&L on this row: count and $ only, no result
    expect(html).toMatch(/class="pgroup-btn"[^>]*title="Momentum Stocks · 1 position · \$79,441 · invested 150 % of its capital · limit 173 %\. Holds \$79,441 at market against \$52,960 of current equity \(150 %\)\. Limit 173 %\. Allocation \$50,000\. Click to show or hide its positions\."/);
  });
});

describe("renderPositions — no side column: a long says nothing, a short is a word", () => {
  const accounts = [{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000 }];
  const row = (symbol, side) => ({ symbol, side, quantity: 1, avgEntryPrice: 100, currentPrice: 101, unrealizedPnl: side === "buy" ? 1 : -1, profileId: "momentum_stocks" });

  test("long-only book (every live strategy today): no S column, no L badge, no tag; the totals label spans the four columns", () => {
    const html = renderPositions({ view: "consolidated", dashboard: { accounts, portfolio: { positions: [row("AAPL", "buy"), row("MSFT", "buy")] } } }, []);
    expect(html).not.toContain("<th>S</th>");
    expect(html).not.toContain("badge");
    expect(html).not.toContain("shorttag");
    expect(html).toContain('<td colspan="4"');
  });

  test("a short position carries a small word tag with what it means; the book gets no extra column", () => {
    const html = renderPositions({ view: "consolidated", dashboard: { accounts, portfolio: { positions: [row("AAPL", "buy"), row("QQQ", "sell"), row("BTC/USDC", "short")] } } }, []);
    expect(html).not.toContain("<th>S</th>");
    expect(html).not.toContain('class="badge');
    expect(html.match(/class="shorttag"/g)).toHaveLength(2);
    expect(html).toContain('<span class="shorttag" title="Gains if the price falls">short</span>');
    expect(html).toContain('>QQQ</span><span class="symname" title="Nasdaq 100">Nasdaq 100</span><span class="shorttag"');
    expect(html).toContain('<td colspan="4"');
    const aapl = html.slice(html.indexOf(">AAPL<"), html.indexOf(">QQQ<"));
    expect(aapl).not.toContain("shorttag"); // the long row next to it says nothing
    const es = store.state.lang;
    try {
      store.state.lang = "es";
      expect(renderPositions({ view: "consolidated", dashboard: { accounts, portfolio: { positions: [row("QQQ", "sell")] } } }, []))
        .toContain('<span class="shorttag" title="Gana si el precio baja">corto</span>');
    } finally { store.state.lang = es; }
  });

  test("a coin that is its own name repeats nothing beside the ticker; an unknown symbol shows the ticker alone", () => {
    const html = renderPositions({ view: "consolidated", dashboard: { accounts, portfolio: { positions: [row("XRP/USDC", "buy"), row("ZZZZ", "buy")] } } }, []);
    expect(html).toContain(">XRP/USDC</span></span>"); // no name: "XRP" would only repeat it
    expect(html).toContain(">ZZZZ</span></span>");
  });
});

describe("renderPositions — compact numbers", () => {
  const state = (positions) => ({ view: "consolidated", dashboard: { accounts: [], portfolio: { positions } } });

  test("prices, notional and total lose cents; P&L percent is whole; entry and now ride in the symbol's title, not in columns", () => {
    const html = renderPositions(state([
      { symbol: "SPY", side: "buy", quantity: 5.59, avgEntryPrice: 540.1, currentPrice: 525.25, stopLoss: 478.4, unrealizedPnl: -85.04, unrealizedPnlPct: -0.3 },
      { symbol: "QQQ", side: "buy", quantity: 10, avgEntryPrice: 540.1, unrealizedPnl: -1709.38 },
    ]), []);
    for (const value of ['title="Qty 6 · Entry $540 · Now $525"', "$2,936<", "−$85</span>", "−$1,794 (−21.3 %)</span>", "0%"])
      expect(html).toContain(value);
    expect(html).not.toContain("<td>$540<"); // Entry and Now are not columns any more
    expect(html).not.toContain("<td>$525<");
    expect(html).not.toContain("$478");
    expect(html).not.toContain("$540.10");
    expect(html).not.toContain("$1,794.42");
  });

  test("small crypto prices, quantities and notionals remain meaningful", () => {
    const html = renderPositions(state([
      { symbol: "DOGE/USD", side: "buy", quantity: 115.7, avgEntryPrice: 0.0777, currentPrice: 0.0789, stopLoss: 0.07, unrealizedPnl: 0.139, unrealizedPnlPct: 1.5 },
      { symbol: "BTC/USD", side: "buy", quantity: 0.0123, avgEntryPrice: 68000, currentPrice: 68100, unrealizedPnl: 1.23 },
    ]), []);
    for (const value of ["Qty 116 ·", "Qty 0.0123 ·", "Entry &lt;$1 ·", "Now &lt;$1", "Entry $68,000", "$9<", "+$0</span>"])
      expect(html).toContain(value);
    expect(html).not.toMatch(/\$[\d,]+\.\d/);
  });
});

// ── The footer: the whole book in one sentence, with its weighted % ──
describe("the totals row reads as a sentence (2026-11-14)", () => {
  const accounts = [{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000 }];
  const row = (i, pnl) => ({ symbol: `T${i}`, side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 100, unrealizedPnl: pnl, profileId: "momentum_stocks" });
  // 19 up (+$10), 33 down (−$13) and one −$10: 53 positions, −$249 on $53,000 invested
  const book = [...Array.from({ length: 19 }, (_, i) => row(i, 10)), ...Array.from({ length: 33 }, (_, i) => row(100 + i, -13)), row(200, -10)];
  const foot = (html) => html.slice(html.indexOf("<tfoot>"), html.indexOf("</tfoot>")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const state = (positions) => ({ view: "consolidated", posGroups: {}, dashboard: { accounts, portfolio: { positions } } });

  test("English: Open, since entry −$249 (−0.5 %) · 53 positions · 19 up, 34 down — words only, no bar", () => {
    const html = renderPositions(state(book), []);
    expect(foot(html)).toBe("Open, since entry −$249 (−0.5 %) · 53 positions · 19 up, 34 down");
    const tfoot = html.slice(html.indexOf("<tfoot>"));
    expect(tfoot).not.toContain("splitbar");
    expect(tfoot).toContain('<span class="pg-pnl" style="color:var(--down)">−$249 (−0.5 %)</span>');
    expect(tfoot).toContain("pgroup-btn pg-foot"); // the width:0 / min-width:100% trick that keeps it out of the column widths
  });

  test("Spanish: Sin cerrar (desde la entrada) … · 53 posiciones · 19 ganan, 34 pierden — the dashboard's one decimal mark", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "es";
      expect(foot(renderPositions(state(book), []))).toBe("Sin cerrar (desde la entrada) −$249 (−0.5 %) · 53 posiciones · 19 ganan, 34 pierden");
    } finally { store.state.lang = lang; }
  });

  test("one decimal on this total even above 1 %; a gain carries its plus", () => {
    expect(foot(renderPositions(state([row(1, 130), row(2, 20)]), []))).toBe("Open, since entry +$150 (+7.5 %) · 2 positions · 2 up");
  });

  test("an unpriced row stays out of the sum, the % and the split, and is said", () => {
    const html = renderPositions(state([row(1, 100), { ...row(2, 0), unrealizedPnl: null }]), []);
    expect(foot(html)).toBe("Open, since entry +$100 (+10.0 %) · 1 position · 1 unpriced · 1 up");
  });

  test("no % when a row's entry amount is unknown (never a partial denominator); COIN-M rows cannot be sized from the payload", () => {
    expect(foot(renderPositions(state([row(1, 100), { symbol: "X", side: "buy", currentPrice: 5, unrealizedPnl: 5, profileId: "momentum_stocks" }]), []))).toBe("Open, since entry +$105 · 2 positions · 2 up");
    const coinm = { view: "consolidated", posGroups: {}, dashboard: { accounts: [...accounts, { id: "momentum_btc", label: "Momentum BTC (COIN-M)", broker: "binance_coinm", initialEquity: 1_000 }],
      portfolio: { positions: [row(1, 100), { symbol: "BTC/COIN-M", side: "buy", quantity: 37, avgEntryPrice: 65_000, currentPrice: 66_000, unrealizedPnl: 30, profileId: "momentum_btc" }] } } };
    expect(foot(renderPositions(coinm, []))).toBe("Open, since entry +$130 · 2 positions · 2 up");
  });
});

// ── The bar scale (2026-11-14) ──────────────────────────────────────────────
describe("the result bars share ONE scale, gains and losses alike", () => {
  const accounts = [{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", initialEquity: 50_000 }];
  const row = (symbol, pct) => ({ symbol, side: "buy", quantity: 10, avgEntryPrice: 100, currentPrice: 100 * (1 + pct / 100), unrealizedPnl: 10 * pct, unrealizedPnlPct: pct, profileId: "momentum_stocks" });
  const widths = (html) => [...html.matchAll(/<i style="width:([\d.]+)%;background:var\(--(up|down)\)">/g)].map((m) => [Number(m[1]), m[2]]);

  test("the row with the largest |%| fills its half; a loss next to a bigger gain fills only its share of it (−5 % beside +7 % is ~71 %)", () => {
    const html = renderPositions({ view: "consolidated", posGroups: {}, dashboard: { accounts, portfolio: { positions: [row("A", 7), row("B", -5), row("C", -2)] } } }, []);
    expect(widths(html)).toEqual([[100, "up"], [71.4, "down"], [28.6, "down"]]);
  });

  test("the largest loss fills its half completely when it is the largest |%| on screen", () => {
    const html = renderPositions({ view: "consolidated", posGroups: {}, dashboard: { accounts, portfolio: { positions: [row("A", 3), row("B", -5)] } } }, []);
    expect(widths(html)).toEqual([[60, "up"], [100, "down"]]);
  });

  test("the scale uses the unrounded %, not the whole percent the row prints", () => {
    const html = renderPositions({ view: "consolidated", posGroups: {}, dashboard: { accounts, portfolio: { positions: [row("A", -4.6), row("B", 2.3)] } } }, []);
    expect(html).toContain("−5%"); // printed whole
    expect(widths(html)).toEqual([[100, "down"], [50, "up"]]);
  });
});
