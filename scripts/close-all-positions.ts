#!/usr/bin/env bun
/**
 * Emergency close-all script (v6.1 deployment prep).
 *
 * Purpose: before restarting the bot with the new v6.1 code, we must
 * flush every open position so the new capacity/trailing/close logic
 * starts from a clean slate. The old code had known bugs (403 silencing,
 * trailing-persist gap) that left the DB in states the new code cannot
 * safely reconcile.
 *
 * This script:
 *   1. Connects directly to Alpaca and Binance Futures using the same
 *      executors the bot uses (no new API paths).
 *   2. Closes every broker-side position.
 *   3. Updates data/trading.db — every 'open' row becomes 'closed' with
 *      the filled exit price (or entry price if close failed, so we
 *      don't lose the row but also don't fake a P&L).
 *   4. Prints a per-position result so we can audit.
 *
 * Safety: refuses to run if TRADING_MODE != 'paper' unless
 * CLOSE_ALL_CONFIRM_LIVE=yes is set — avoids nuking a live account by
 * accident.
 */

import { Database } from "bun:sqlite";
import { config } from "../src/config";
import { AlpacaExecutor } from "../src/executor/alpaca-executor";
import { BinanceExecutor, isNonProductionBinanceHost } from "../src/executor/binance-executor";
import { boundedCryptoCloseQty } from "./lib/boundedCloseQty";

const DB_PATH = "./data/trading.db";

async function main() {
  // 0. Safety gate
  // isNonProductionBinanceHost, not a "testnet" substring sniff: the sandbox
  // now also answers at demo-fapi.binance.com (allowlist, fail-closed).
  const isPaper = config.alpaca.paper && isNonProductionBinanceHost(config.binanceFutures.restBase);
  if (!isPaper && process.env.CLOSE_ALL_CONFIRM_LIVE !== "yes") {
    console.error("✗ REFUSING TO RUN: TRADING_MODE is not paper/testnet.");
    console.error("  If you really want to close live positions, set");
    console.error("  CLOSE_ALL_CONFIRM_LIVE=yes in the environment.");
    process.exit(2);
  }
  console.log(`▌ Mode: ${isPaper ? "paper/testnet (safe)" : "LIVE (confirmed)"}\n`);

  // 1. DB state
  const db = new Database(DB_PATH);
  const openRows = db.prepare(
    `SELECT id, symbol, market, side, quantity, entry_price, account_id, strategy
     FROM trades WHERE status='open' ORDER BY market, symbol`
  ).all() as Array<{ id: string; symbol: string; market: string; side: string; quantity: number; entry_price: number; account_id: string; strategy: string }>;
  console.log(`▌ Open trades in DB: ${openRows.length}`);
  for (const r of openRows) {
    console.log(`    ${r.market.padEnd(6)} ${r.symbol.padEnd(10)} ${r.side.padEnd(4)} qty=${String(r.quantity).padEnd(9)} @ $${r.entry_price}  [${r.account_id}]`);
  }
  console.log("");

  // 2. Connect brokers
  const alpaca = new AlpacaExecutor();
  const alpacaOk = await alpaca.init();
  const binance = new BinanceExecutor();
  const binanceOk = await binance.init();
  console.log(`▌ Connected: Alpaca=${alpacaOk ? "✓" : "✗"}  Binance=${binanceOk ? "✓" : "✗"}\n`);

  // 3. Enumerate broker-side positions (ground truth)
  let alpacaPositions: ReturnType<typeof alpaca.getPositions> extends Promise<infer T> ? T : never = [];
  let alpacaEnumerationFailed = false;
  if (alpacaOk) {
    try {
      alpacaPositions = await alpaca.getPositions();
    } catch (e: any) {
      alpacaEnumerationFailed = true;
      console.error(`\n⚠️  ALPACA POSITION ENUMERATION FAILED: ${e.message}`);
      console.error(`    Continuing with empty Alpaca position list.`);
      console.error(`    Binance leg will still execute.\n`);
    }
  } else {
    // init() itself failed — same as a failed enumeration: we have NO
    // broker-side ground truth, so stock DB rows must not be reconciled
    // as if the broker confirmed them flat.
    alpacaEnumerationFailed = true;
  }
  console.log(`▌ Alpaca broker-side positions: ${alpacaPositions.length}${alpacaEnumerationFailed ? " (enumeration failed; list may be incomplete)" : ""}`);
  for (const p of alpacaPositions) {
    console.log(`    ${p.symbol.padEnd(10)} ${p.side.padEnd(4)} qty=${p.quantity}  cur=$${p.currentPrice}  unrPnL=$${p.unrealizedPnl.toFixed(2)}`);
  }

  let binancePositions: Awaited<ReturnType<typeof binance.getPositions>> = [];
  let binanceEnumerationFailed = false;
  if (binanceOk) {
    try {
      binancePositions = await binance.getPositions();
    } catch (e: any) {
      binanceEnumerationFailed = true;
      console.error(`\n⚠️  BINANCE POSITION ENUMERATION FAILED: ${e.message}`);
      console.error(`    Continuing with empty Binance position list.`);
      console.error(`    Alpaca leg will still execute.\n`);
    }
  } else {
    // init() itself failed — same as a failed enumeration: we have NO
    // broker-side ground truth, so crypto DB rows must not be reconciled
    // as if the broker confirmed them flat.
    binanceEnumerationFailed = true;
  }
  const activeBinance = binancePositions.filter(p => Math.abs(p.positionAmt) > 0);
  console.log(`\n▌ Binance broker-side positions: ${activeBinance.length}${binanceEnumerationFailed ? " (enumeration failed; list may be incomplete)" : ""}`);
  for (const p of activeBinance) {
    console.log(`    ${p.symbol.padEnd(10)} amt=${p.positionAmt}  entry=$${p.entryPrice}  unrPnL=$${p.unrealizedProfit.toFixed(2)}`);
  }
  console.log("");

  // 4. Close Alpaca positions — bounded to OUR DB rows (2026-07-27). The
  // broker may hold positions opened manually or by some other unaccounted
  // process, so the broker leg closes min(our summed rows, broker qty) per
  // symbol and SKIPS symbols we hold no DB row for — closing those would
  // touch a position that isn't ours to manage.
  const results: Array<{ symbol: string; market: string; ok: boolean; filledPrice: number; reason?: string }> = [];
  if (alpacaOk && alpacaPositions.length > 0) {
    console.log(`▌ Closing Alpaca positions (bounded to our DB rows)...`);
    for (const p of alpacaPositions) {
      const ourQty = openRows
        .filter(t => t.market === "stock" && (t.symbol === p.symbol || t.symbol.replace("/", "") === p.symbol.replace("/", "")))
        .reduce((s, t) => s + t.quantity, 0);
      if (!(ourQty > 0)) {
        console.log(`    ${p.symbol}: • no DB row of ours (manual/unknown) — skipped`);
        continue;
      }
      try {
        const r = await alpaca.closePosition(p.symbol, undefined, ourQty);
        results.push({ symbol: p.symbol, market: "stock", ok: r.success, filledPrice: r.filledPrice, reason: r.reason });
        console.log(`    ${p.symbol}: ${r.success ? `✓ filled @ $${r.filledPrice.toFixed(4)}` : `✗ ${r.reason}`}`);
      } catch (e: any) {
        results.push({ symbol: p.symbol, market: "stock", ok: false, filledPrice: 0, reason: e.message });
        console.log(`    ${p.symbol}: ✗ ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 500)); // rate-limit friendly
    }
  }

  // 5. Close Binance positions — bounded to OUR DB rows (2026-07-29), same
  // rule as the Alpaca leg above: the broker may hold positions we don't
  // have a row for, so close min(our summed rows, broker qty) per symbol
  // and SKIP symbols we hold no row for.
  if (binanceOk && activeBinance.length > 0) {
    console.log(`\n▌ Closing Binance Futures positions (bounded to our DB rows)...`);
    for (const p of activeBinance) {
      // Binance symbols are BTCUSDT; map back to BTC/USD for executor
      const alpacaSym = BinanceExecutor.toAlpacaSymbol(p.symbol);
      if (!alpacaSym) {
        console.log(`    ${p.symbol}: ✗ no symbol mapping`);
        continue;
      }
      const side: "buy" | "sell" = p.positionAmt > 0 ? "buy" : "sell";
      const qty = boundedCryptoCloseQty(openRows, alpacaSym, Math.abs(p.positionAmt));
      if (!(qty > 0)) {
        console.log(`    ${alpacaSym}: • no DB row of ours (manual/unknown) — skipped`);
        continue;
      }
      try {
        const r = await binance.closePosition(alpacaSym, qty, side);
        results.push({ symbol: alpacaSym, market: "crypto", ok: r.success, filledPrice: r.filledPrice, reason: r.success ? undefined : "broker rejected" });
        console.log(`    ${alpacaSym}: ${r.success ? `✓ filled @ $${r.filledPrice.toFixed(4)}  PnL=$${(r.realizedPnl - r.commission).toFixed(4)}` : "✗ broker rejected"}`);
      } catch (e: any) {
        results.push({ symbol: alpacaSym, market: "crypto", ok: false, filledPrice: 0, reason: e.message });
        console.log(`    ${alpacaSym}: ✗ ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // 6. Reconcile DB
  console.log(`\n▌ Reconciling DB...`);
  const now = Date.now();
  let dbUpdated = 0;
  for (const trade of openRows) {
    if (alpacaEnumerationFailed && trade.market === "stock") {
      console.log(`    [${trade.market}] ${trade.symbol.padEnd(10)} • Alpaca enumeration failed; leaving open`);
      continue;
    }
    if (binanceEnumerationFailed && trade.market === "crypto") {
      console.log(`    [${trade.market}] ${trade.symbol.padEnd(10)} • Binance enumeration failed; leaving open`);
      continue;
    }

    // Find matching broker-side result
    const match = results.find(r => r.symbol === trade.symbol && r.market === trade.market);
    const exitPrice = match?.ok && match.filledPrice > 0 ? match.filledPrice : trade.entry_price;
    const isFlat = exitPrice === trade.entry_price;

    const pnl = isFlat
      ? 0
      : trade.side === "buy"
        ? (exitPrice - trade.entry_price) * trade.quantity
        : (trade.entry_price - exitPrice) * trade.quantity;
    const pnlPct = trade.entry_price > 0
      ? (pnl / (trade.entry_price * trade.quantity)) * 100
      : 0;

    const closeReason = match?.ok ? "MANUAL_CLOSE" : "MANUAL_CLOSE_UNRECONCILED";
    db.prepare(
      `UPDATE trades SET status='closed', exit_price=?, exit_time=?, pnl=?, pnl_pct=?, close_reason=? WHERE id=? AND status='open'`
    ).run(exitPrice, now, pnl, pnlPct, closeReason, trade.id);

    // Audit fix (2026-05-04): emit activity rows so the dashboard surface
    // shows manual reconciliations (was silently bypassing the activity log).
    try {
      db.prepare(
        `INSERT INTO activity_log (account_id, event_type, message, created_at) VALUES (?, ?, ?, ?)`
      ).run(
        trade.account_id ?? null,
        "close",
        `MANUAL ${trade.symbol}: ${closeReason} pnl=$${pnl.toFixed(2)} via close-all-positions script`,
        now
      );
    } catch {
      // best-effort; do not block reconciliation
    }

    dbUpdated++;
    console.log(`    [${trade.market}] ${trade.symbol.padEnd(10)} ${match?.ok ? "✓" : "•"} exit=$${exitPrice.toFixed(4)}  pnl=$${pnl.toFixed(2)}  (${closeReason})`);
  }

  // 7. Summary
  console.log(`\n▌ SUMMARY`);
  if (alpacaEnumerationFailed) {
    console.log(`    ⚠️  Alpaca positions were NOT enumerated or closed; stock DB rows were left open.`);
    console.log(`    ⚠️  Manual intervention is required for Alpaca positions.`);
    process.exitCode = 1;
  }
  if (binanceEnumerationFailed) {
    console.log(`    ⚠️  Binance positions were NOT enumerated or closed; crypto DB rows were left open.`);
    console.log(`    ⚠️  Manual intervention is required for Binance positions.`);
    process.exitCode = 1;
  }
  const okResults = results.filter(r => r.ok).length;
  console.log(`    Broker closes OK: ${okResults}/${results.length}`);
  console.log(`    DB rows updated:  ${dbUpdated}`);
  console.log(`    DB rows still open: ${(db.prepare(`SELECT COUNT(*) n FROM trades WHERE status='open'`).get() as any).n}`);

  // 8. Cleanup
  alpaca.cleanup();
  db.close();
  console.log(alpacaEnumerationFailed || binanceEnumerationFailed
    ? `\n⚠️  Failed: some broker positions were not enumerated or closed; manual intervention is required.`
    : `\n✅ Done.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
