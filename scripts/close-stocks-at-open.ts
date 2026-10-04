#!/usr/bin/env bun
/**
 * Close all remaining OPEN stock positions.
 *
 * Must run while US markets are OPEN (09:30-16:00 ET ≈ 13:30-20:00 UTC).
 * Outside those hours Alpaca returns 403 / cancels orders → run exits
 * early with a clear message.
 *
 * Companion to close-crypto-now.ts — together they flush the bot's state
 * before restarting with the v6.1 code base.
 *
 * Usage:
 *   bun run scripts/close-stocks-at-open.ts
 */

import { Database } from "bun:sqlite";
import { config } from "../src/config";
import { AlpacaExecutor } from "../src/executor/alpaca-executor";
import { getMarketStatus } from "../src/utils/marketHours";

const DB_PATH = "./data/trading.db";

async function main() {
  const isPaper = config.alpaca.paper;
  if (!isPaper && process.env.CLOSE_ALL_CONFIRM_LIVE !== "yes") {
    console.error("✗ REFUSING: Alpaca not paper. Set CLOSE_ALL_CONFIRM_LIVE=yes to override.");
    process.exit(2);
  }

  const market = getMarketStatus();
  console.log(`▌ Mode: ${isPaper ? "paper" : "LIVE"}  Market: ${market.status} (${market.untilStr})`);
  if (market.status !== "open") {
    console.error(`\n✗ Market is ${market.status}. US regular hours required to market-close stocks.`);
    console.error(`  Either wait, or close them manually in the Alpaca UI.`);
    process.exit(3);
  }
  console.log("");

  const db = new Database(DB_PATH);
  const openStocks = db.prepare(
    `SELECT id, symbol, side, quantity, entry_price, account_id
     FROM trades WHERE status='open' AND market='stock' ORDER BY symbol`
  ).all() as Array<any>;
  console.log(`▌ Open stock trades in DB: ${openStocks.length}`);
  for (const r of openStocks) {
    console.log(`    ${r.symbol.padEnd(6)} ${r.side.padEnd(4)} qty=${r.quantity}  @ $${r.entry_price}  [${r.account_id}]`);
  }
  console.log("");

  const alpaca = new AlpacaExecutor();
  const ok = await alpaca.init();
  if (!ok) {
    console.error("✗ Alpaca failed to init");
    process.exit(1);
  }

  let positions: Awaited<ReturnType<typeof alpaca.getPositions>> = [];
  let positionEnumerationFailed = false;
  try {
    positions = await alpaca.getPositions();
  } catch (e: any) {
    positionEnumerationFailed = true;
    console.error(`\n⚠️  ALPACA POSITION ENUMERATION FAILED: ${e.message}`);
    console.error(`    Continuing with empty position list.\n`);
  }
  console.log(`▌ Alpaca broker-side positions: ${positions.length}${positionEnumerationFailed ? " (enumeration failed; list may be incomplete)" : ""}`);
  for (const p of positions) {
    console.log(`    ${p.symbol.padEnd(6)} ${p.side.padEnd(4)} qty=${p.quantity}  cur=$${p.currentPrice}  unrPnL=$${p.unrealizedPnl.toFixed(2)}`);
  }
  console.log("");

  // Bounded to OUR DB rows (2026-07-27): the broker may hold a position
  // opened manually or by some other unaccounted process. Close min(our
  // summed rows, broker qty) per symbol; a symbol with no DB row of ours
  // is skipped.
  console.log(`▌ Closing (bounded to our DB rows)...`);
  const results: Array<{ symbol: string; ok: boolean; filledPrice: number; reason?: string }> = [];
  for (const p of positions) {
    const ourQty = openStocks
      .filter(t => t.symbol === p.symbol || t.symbol.replace("/", "") === p.symbol.replace("/", ""))
      .reduce((s, t) => s + t.quantity, 0);
    if (!(ourQty > 0)) {
      console.log(`    ${p.symbol.padEnd(6)}  • no DB row of ours (manual/unknown) — skipped`);
      continue;
    }
    try {
      const r = await alpaca.closePosition(p.symbol, undefined, ourQty);
      results.push({ symbol: p.symbol, ok: r.success, filledPrice: r.filledPrice, reason: r.reason });
      console.log(`    ${p.symbol.padEnd(6)}  ${r.success ? `✓ @ $${r.filledPrice.toFixed(4)}` : `✗ ${r.reason}`}`);
    } catch (e: any) {
      results.push({ symbol: p.symbol, ok: false, filledPrice: 0, reason: e.message });
      console.log(`    ${p.symbol.padEnd(6)}  ✗ ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n▌ Reconciling DB...`);
  const now = Date.now();
  let updated = 0;
  for (const trade of openStocks) {
    const match = results.find(r => r.symbol === trade.symbol && r.ok);
    if (!match) {
      console.log(`    ${trade.symbol.padEnd(6)}  • no broker fill; leaving open`);
      continue;
    }
    const pnl = trade.side === "buy"
      ? (match.filledPrice - trade.entry_price) * trade.quantity
      : (trade.entry_price - match.filledPrice) * trade.quantity;
    const denom = trade.entry_price * trade.quantity;
    const pnlPct = denom > 0 && Number.isFinite(pnl) ? (pnl / denom) * 100 : 0;

    db.prepare(
      `UPDATE trades SET status='closed', exit_price=?, exit_time=?, pnl=?, pnl_pct=?, close_reason=? WHERE id=? AND status='open'`
    ).run(match.filledPrice, now, pnl, pnlPct, "MANUAL_CLOSE", trade.id);
    updated++;
    console.log(`    ${trade.symbol.padEnd(6)}  ✓ exit=$${match.filledPrice.toFixed(4)}  pnl=$${pnl.toFixed(2)}`);
  }

  console.log(`\n▌ SUMMARY`);
  if (positionEnumerationFailed) {
    console.log(`    ⚠️  Alpaca positions were NOT enumerated or closed; DB rows were left open.`);
    console.log(`    ⚠️  Manual intervention is required for Alpaca positions.`);
    process.exitCode = 1;
  }
  console.log(`    Broker OK: ${results.filter(r => r.ok).length}/${results.length}`);
  console.log(`    DB rows updated: ${updated}/${openStocks.length}`);
  const stillOpen = (db.prepare(`SELECT COUNT(*) n FROM trades WHERE status='open' AND market='stock'`).get() as any).n;
  console.log(`    Stocks still open in DB: ${stillOpen}`);

  alpaca.cleanup();
  db.close();
  console.log(positionEnumerationFailed
    ? `\n⚠️  Failed: Alpaca positions were not enumerated or closed; manual intervention is required.`
    : `\n✅ Done.`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
