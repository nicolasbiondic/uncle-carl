// ══════════════════════════════════════════════
// Daily digest — target format (2026-07-19 mandate):
//
//   📊 Uncle Carl · 19 jul · cierre ET
//   P&L hoy +$0.00 (0.00%) · P&L 7D +$367.02 (+0.33%)
//   Cobrado hoy +$123.21 en 2 cierres · +$98.00 ya estaba ganado antes de hoy
//   0 trades hoy · 18 en 7D · 6 posiciones abiertas
//
//   Rendimiento 7D realizado
//   Reversión Stocks +$296.03 · 5W/1L
//   Momentum Stocks −$32.86 · 1W/1L
//   Momentum Cripto −$3.91 · 0W/1L
//
//   Binance $10,445 · USDT $4,731 · USDC $5,000 · BTC $714
//   Alpaca $102,168
//   Patrimonio $112,613 · P&L desde el inicio +$367.02 (+0.33%)
//
// The P&L hoy/7D/desde el inicio figures are the change in the accounts'
// value (combineEquityPnlLegs over the applicable *_main broker series —
// never a sleeve sum, never the old accounts-table header). "Cobrado hoy"
// and Rendimiento 7D use filtered closed trades; "ya estaba ganado antes de
// hoy" is the part of today's realized that was already in the P&L (2026-09-29:
// the old line labeled the whole equity delta "no realizado", so realized +
// "no realizado" double-counted every close). Rendimiento 7D lists ACTIVE sleeves with ≥1 weekly close only,
// best→worst, no equity/day/all-time clutter. Top-symbol and reject
// breakdown are gone from the passive digest (operator commands only).
// ══════════════════════════════════════════════

import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  getDB, getETDayStart, saveEquitySnapshot, upsertAssetBalance,
} from "../db/database";
import { setBrokerTruthAvailable } from "../portfolio/truth";
import { TelegramReporter } from "./telegram-reporter";
import { makeTestDb } from "../test-support/db";

function insertClosedTrade(opts: { id: string; accountId: string; pnl: number; exitTime: number; closeReason?: string | null }) {
  getDB().prepare(`
    INSERT INTO trades (id, symbol, market, side, strategy, entry_price, exit_price, quantity, pnl, pnl_pct, entry_time, exit_time, status, account_id, close_reason, profile_id)
    VALUES (?, 'TEST', 'crypto', 'buy', 'TEST', 100, 100, 1, ?, 0, ?, ?, 'closed', ?, ?, ?)
  `).run(opts.id, opts.pnl, opts.exitTime - 1000, opts.exitTime, opts.accountId, opts.closeReason ?? null, opts.accountId);
}

let reporter: TelegramReporter;
let todayStart: number;
let weekStart: number;
let weekTradeTime: number;

beforeAll(() => {
  makeTestDb();
  setBrokerTruthAvailable("alpaca", true);
  setBrokerTruthAvailable("binance", true);
  todayStart = getETDayStart();
  weekStart = getETDayStart(Date.now() - 6 * 86_400_000);
  weekTradeTime = weekStart + 2 * 86_400_000; // safely inside the 7D window, before today

  // ── alpaca_main / binance_main truth: Inicio (first-ever) → 7D anchor →
  // today anchor (== latest, for the "valid zero pct" case) → latest. ──
  saveEquitySnapshot("alpaca_main", 101_800, 90_000, 0, Date.now() - 20 * 86_400_000);
  saveEquitySnapshot("alpaca_main", 101_850, 90_000, 0, weekStart - 60_000);
  saveEquitySnapshot("alpaca_main", 102_168, 90_100, 0, todayStart - 60_000);
  saveEquitySnapshot("alpaca_main", 102_168, 90_100, 0, Date.now());
  saveEquitySnapshot("binance_main", 10_100, 5_000, 0, Date.now() - 20 * 86_400_000);
  saveEquitySnapshot("binance_main", 10_200, 5_000, 0, weekStart - 59_000);
  saveEquitySnapshot("binance_main", 10_445, 5_100, 0, todayStart - 59_000);
  saveEquitySnapshot("binance_main", 10_445, 5_100, 0, Date.now());

  // FAPI asset breakdown (fresh — upsertAssetBalance stamps CURRENT_TIMESTAMP).
  upsertAssetBalance("binance_testnet", "USDC", 5_000, 5_000, 5_000);
  upsertAssetBalance("binance_testnet", "BTC", 0.01, 0.01, 714);

  // ── Rendimiento 7D fixture (weekTradeTime, all inside the 7D window) ──
  // meanrev_stocks: 5W (100+80+70+50+20=320) / 1L (−23.97) = +296.03
  for (const pnl of [100, 80, 70, 50, 20]) {
    insertClosedTrade({ id: `mr_w_${pnl}`, accountId: "meanrev_stocks", pnl, exitTime: weekTradeTime });
  }
  insertClosedTrade({ id: "mr_l_1", accountId: "meanrev_stocks", pnl: -23.97, exitTime: weekTradeTime });
  // momentum_stocks: 1W (50) / 1L (−82.86) = −32.86
  insertClosedTrade({ id: "ms_w_1", accountId: "momentum_stocks", pnl: 50, exitTime: weekTradeTime });
  insertClosedTrade({ id: "ms_l_1", accountId: "momentum_stocks", pnl: -82.86, exitTime: weekTradeTime });
  // momentum_crypto: 0W / 1L (−3.91)
  insertClosedTrade({ id: "mc_l_1", accountId: "momentum_crypto", pnl: -3.91, exitTime: weekTradeTime });

  // Non-reconcile close (broker-gone, no real fill) — must be invisible to
  // both the Rendimiento 7D row and the trade counts.
  insertClosedTrade({ id: "mr_reconcile", accountId: "meanrev_stocks", pnl: 9_999, exitTime: weekTradeTime, closeReason: "BROKER_GONE_404" });
  // Inactive sleeve (not in getAccountSummaries) — must be invisible too.
  insertClosedTrade({ id: "inactive_win", accountId: "momentum_btc", pnl: 12_345, exitTime: weekTradeTime });

  reporter = new TelegramReporter();
  reporter.getAccountSummaries = () => [
    { id: "meanrev_stocks", equity: 51_500, positions: 3, paused: false },
    { id: "momentum_stocks", equity: 50_600, positions: 2, paused: false },
    { id: "momentum_crypto", equity: 10_445, positions: 1, paused: false },
  ];
});

describe("composeDailyDigest — header: Uncle Carl · date · cierre ET", () => {
  test("title line", () => {
    const msg = reporter.composeDailyDigest();
    expect(msg).toContain("📊 <b>Uncle Carl</b> ·");
    expect(msg).toContain("· cierre ET");
  });

  test("realized Hoy is zero when no real trade closed today", () => {
    const msg = reporter.composeDailyDigest();
    expect(msg).toContain("Sin cierres hoy");
    expect(msg).toContain("P&L hoy +$0.00 (0.00%)");
  });

  test("/status and the digest use the same today equity delta", async () => {
    const sent: string[] = [];
    (reporter as any).send = async (text: string) => { sent.push(text); };
    await (reporter as any).cmdStatus("test");
    const status = sent[0] as string;
    const digest = reporter.composeDailyDigest();
    expect(status.match(/P&L hoy ([+−]\$[\d,]+\.\d{2})/)?.[1]).toBeDefined();
    expect(status.match(/P&L hoy ([+−]\$[\d,]+\.\d{2})/)?.[1]).toBe(digest.match(/P&L hoy ([+−]\$[\d,]+\.\d{2})/)?.[1]);
    expect(status).toContain("cobrado hoy +$0.00");
    expect(status).not.toContain("no realizado");
  });

  test("7D and Inicio are both non-null and DIFFERENT — Inicio is periodDays=0, never the 7D figure or a sleeve sum", () => {
    const msg = reporter.composeDailyDigest();
    // 7D: (102168−101850)+(10445−10200)=563 over start 112050 → +0.50%
    expect(msg).toContain("P&L 7D +$563.00 (+0.50%)");
    // Inicio: (102168−101800)+(10445−10100)=713 over start 111900 → +0.64%
    expect(msg).toContain("P&L desde el inicio +$713.00 (+0.64%)");
    expect(msg).not.toContain("P&L desde el inicio +$563.00");
  });
});

describe("composeDailyDigest — trade/position counts (active summaries only)", () => {
  test("no trades closed today, 9 real closes in 7D (reconcile + inactive-sleeve rows excluded), 6 open positions", () => {
    const msg = reporter.composeDailyDigest();
    expect(msg).toContain("0 trades hoy · 9 en 7D · 6 posiciones abiertas");
  });

  test("singular Spanish/English forms render correctly", () => {
    const solo = new TelegramReporter();
    const soloTime = Date.now(); // today, not just "in the 7D window"
    insertClosedTrade({ id: "solo_trade", accountId: "solo_acct", pnl: 5, exitTime: soloTime });
    solo.getAccountSummaries = () => [{ id: "solo_acct", equity: 1_000, positions: 1, paused: false }];
    const msg = solo.composeDailyDigest();
    expect(msg).toContain("1 trade hoy · 1 en 7D · 1 posición abierta");
  });
});

describe("Rendimiento 7D — active sleeves, ≥1 weekly close, best→worst, no clutter", () => {
  test("sorted descending by 7D pnl with exact W/L", () => {
    const msg = reporter.composeDailyDigest();
    const lines = msg.split("\n");
    const idx = lines.indexOf("<b>Rendimiento 7D realizado</b>");
    expect(idx).toBeGreaterThan(-1);
    // Best→worst by 7D pnl: +296.03, then −3.91 (still beats −32.86).
    expect(lines[idx + 1]).toBe("Reversión Stocks realizado +$296.03 · 5W/1L");
    expect(lines[idx + 2]).toBe("Momentum Cripto realizado −$3.91 · 0W/1L");
    expect(lines[idx + 3]).toBe("Momentum Stocks realizado −$32.86 · 1W/1L");
  });

  test("the reconcile close never inflates meanrev_stocks' 7D pnl or W count", () => {
    const msg = reporter.composeDailyDigest();
    expect(msg).not.toContain("9999");
    expect(msg).not.toContain("6W"); // would be 6W if the reconcile row counted as a win
  });

  test("no per-row equity/day/all-time clutter, no 'tr' trade-count suffix", () => {
    const msg = reporter.composeDailyDigest();
    expect(msg).not.toMatch(/Reversión Stocks \$/); // no $equity before the pnl
    expect(msg).not.toMatch(/\d+\s*tr\b/); // old "5tr"/"0 tr" cell format is gone
    expect(msg).not.toContain("sem "); // old "sem +$x (WL)" cell is gone
  });
});

describe("realized vs. mark-to-market — the numbers cannot be misread", () => {
  test("open positions moving with no closes report realized zero and non-zero unrealized", () => {
    const now = Date.now();
    saveEquitySnapshot("alpaca_main", 102_668, 90_100, 3, now);
    saveEquitySnapshot("binance_main", 10_945, 5_100, 1, now + 1);
    try {
      const msg = reporter.composeDailyDigest();
      expect(msg).toContain("Sin cierres hoy");
      expect(msg).toContain("P&L hoy +$1000.00");
      expect(msg).not.toContain("Cobrado hoy +$1000.00");
    } finally {
      getDB().prepare("DELETE FROM equity_snapshots WHERE snapshot_time >= ?").run(now);
    }
  });

  test("realized Hoy includes only filtered closed P&L", () => {
    const now = Date.now();
    insertClosedTrade({ id: "today_real_close", accountId: "momentum_stocks", pnl: 42.5, exitTime: now });
    insertClosedTrade({
      id: "today_manual_reconcile", accountId: "momentum_stocks", pnl: 9_999,
      exitTime: now, closeReason: "MANUAL_CLOSE_UNRECONCILED",
    });
    try {
      const msg = reporter.composeDailyDigest();
      expect(msg).toContain("Cobrado hoy +$42.50 en 1 cierre");
      expect(msg).not.toContain("$10,041.50");
    } finally {
      getDB().prepare("DELETE FROM trades WHERE id IN ('today_real_close', 'today_manual_reconcile')").run();
    }
  });
});

describe("composeDailyDigest — no top-symbol, no reject breakdown (operator-only now)", () => {
  test("passive digest omits both", () => {
    const msg = reporter.composeDailyDigest();
    expect(msg).not.toContain("Top sem");
    expect(msg).not.toContain("Señales descartadas");
  });
});

describe("Binance decomposition — FAPI + DAPI reconcile exactly, no double count", () => {
  test("USDT + USDC + BTC == Total, sourced from fresh asset rows", () => {
    const msg = reporter.composeDailyDigest();
    expect(msg).toContain("Binance $10,445 · USDT $4,731 · USDC $5,000 · BTC $714");
    // 4,731 + 5,000 + 714 = 10,445 — reconciles exactly (whole-dollar fixture).
  });

  test("Alpaca and Patrimonio lines", () => {
    const msg = reporter.composeDailyDigest();
    expect(msg).toContain("Alpaca $102,168");
    expect(msg).toContain("Patrimonio $112,613 · P&L desde el inicio +$713.00 (+0.64%)");
  });

  test("stale FAPI asset rows omit the USDT/USDC/BTC parts but keep the Binance total", () => {
    getDB().prepare(`UPDATE broker_asset_balances SET updated_at = datetime('now', '-1 hour') WHERE broker_account_id = 'binance_testnet'`).run();
    try {
      const msg = reporter.composeDailyDigest();
      expect(msg).toContain("Binance $10,445");
      expect(msg).not.toContain("USDT $");
    } finally {
      // Re-freshen for later tests.
      getDB().prepare(`UPDATE broker_asset_balances SET updated_at = CURRENT_TIMESTAMP WHERE broker_account_id = 'binance_testnet'`).run();
    }
  });
});

describe("composeDailyDigest — incomplete broker truth fails closed, never partial", () => {
  test("a missing binance_main leg blanks Hoy/7D/Inicio/Patrimonio/Binance, never an Alpaca-only or sleeve-sum substitute", () => {
    const db = getDB();
    // Genuinely hide the series (empty display + live snapshot), not just a
    // semantics bump — getDisplayEquitySeries reads `semantics >= 2`, so a
    // 5→4 downgrade alone stays visible to combineEquityPnlLegs.
    db.prepare(`UPDATE equity_snapshots SET profile_id = 'binance_main_HIDDEN_FOR_TEST' WHERE profile_id = 'binance_main'`).run();
    try {
      const msg = reporter.composeDailyDigest();
      expect(msg).toContain("P&L hoy — · P&L 7D —");
      expect(msg).toContain("Patrimonio — · P&L desde el inicio —");
      expect(msg).not.toContain("Binance $");
      expect(msg).toContain("Alpaca $102,168"); // the healthy leg still renders on its own line
    } finally {
      db.prepare(`UPDATE equity_snapshots SET profile_id = 'binance_main' WHERE profile_id = 'binance_main_HIDDEN_FOR_TEST'`).run();
    }
  });
});

describe("Inicio null-pct — a configured rebase keeps the dollar delta, omits the %", () => {
  test("pnl renders without parens when the display start required a rebase", () => {
    const db = getDB();
    // binance_main has a configured 4→5 rebase transition (TRANSITION_POLICY).
    // Insert an era-4 row just before the earliest era-5 row, gap-eligible
    // (<15min) — this makes getEquityPnlDisplay's periodDays=0 (Inicio) start
    // point `rebased: true`: pnl stays a real $ delta, pnlPct is suppressed.
    const earliest = db.prepare(
      `SELECT snapshot_time FROM equity_snapshots WHERE profile_id='binance_main' ORDER BY snapshot_time ASC LIMIT 1`
    ).get() as { snapshot_time: number };
    db.prepare(
      `INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics) VALUES (?,?,?,?,?,?)`
    ).run("binance_main", 9_500, 9_500, 0, earliest.snapshot_time - 5 * 60_000, 4);

    const msg = reporter.composeDailyDigest();
    expect(msg).toMatch(/P&L desde el inicio [+\u2212]\$[\d,]+\.\d{2}/); // dollar delta remains available
    expect(msg).not.toMatch(/P&L desde el inicio [+\u2212]\$[\d,]+\.\d{2} \(/); // synthetic-basis percent stays hidden
  });
});

describe("Binance decomposition includes CoinM (DAPI) exactly once, once applicable", () => {
  test("Total = FAPI main + DAPI main; USDT/USDC/BTC still reconcile to that total", () => {
    setBrokerTruthAvailable("coinm", true);
    saveEquitySnapshot("binance_coinm_main", 480, 480, 0, Date.now() - 15 * 86_400_000);
    saveEquitySnapshot("binance_coinm_main", 500, 500, 0, Date.now());
    try {
      // Total = binance_main (10,445) + coinm (500) = 10,945.
      // BTC = FAPI BTC (714) + coinm (500) = 1,214. USDC unchanged (5,000).
      // USDT = 10,945 − 5,000 − 1,214 = 4,731 (coinm cancels out of USDT by construction).
      const msg = reporter.composeDailyDigest();
      expect(msg).toContain("Binance $10,945 · USDT $4,731 · USDC $5,000 · BTC $1,214");
      // Never counted twice: FAPI-only would read $10,445, DAPI-only $500.
      expect(msg).not.toContain("Binance $10,445");
    } finally {
      setBrokerTruthAvailable("coinm", false);
    }
  });
});

describe("realized today vs P&L today — a gain earned before today (2026-09-28: META)", () => {
  test("the digest says how much of today's realized was already in the P&L before today", () => {
    const hist = new Database(":memory:");
    hist.exec(`CREATE TABLE historical_bars (symbol TEXT NOT NULL, timeframe TEXT NOT NULL, timestamp INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY (symbol, timeframe, timestamp))`);
    // The previous session's close, stamped 00:00 ET of its day.
    hist.prepare(`INSERT INTO historical_bars VALUES ('META', '1d', ?, 736.6, 736.6, 736.6, 736.6, 1, 'alpaca_wide')`).run(getETDayStart() - 86_400_000);
    getDB().prepare(`
      INSERT INTO trades (id, symbol, market, side, strategy, entry_price, exit_price, quantity, pnl, pnl_pct, entry_time, exit_time, status, account_id, close_reason, profile_id)
      VALUES ('meta_cutover', 'META', 'stock', 'buy', 'MOMENTUM', 607.516501, 726.71, 40, 4767.74, 19.6, ?, ?, 'closed', 'momentum_stocks', 'MODEL_CUTOVER', 'momentum_stocks')
    `).run(getETDayStart() - 24 * 86_400_000, Date.now());
    const original = (reporter as any).openHist;
    (reporter as any).openHist = () => hist;
    try {
      const msg = reporter.composeDailyDigest();
      expect(msg).toContain("Cobrado hoy +$4767.74 en 1 cierre · +$5163.34 ya estaba ganado antes de hoy");
      expect(msg).not.toContain("no realizado");
    } finally {
      (reporter as any).openHist = original;
      getDB().prepare("DELETE FROM trades WHERE id = 'meta_cutover'").run();
    }
  });
});
