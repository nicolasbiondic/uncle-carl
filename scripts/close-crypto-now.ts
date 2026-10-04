#!/usr/bin/env bun
/**
 * Close all crypto positions right now (Binance Futures testnet + any
 * Alpaca crypto). Skips stocks entirely — those must be closed during
 * US regular hours (see close-stocks-at-open.ts).
 *
 * Safe for paper/testnet. Refuses to run against live without explicit
 * CLOSE_ALL_CONFIRM_LIVE=yes.
 */

import { Database } from "bun:sqlite";
import { config } from "../src/config";
import { BinanceExecutor, isNonProductionBinanceHost } from "../src/executor/binance-executor";
import { boundedCryptoCloseQty } from "./lib/boundedCloseQty";

const DB_PATH = "./data/trading.db";

async function main() {
  // Allowlist check (covers demo-fapi.binance.com too), never substring-sniffing.
  const isPaper = isNonProductionBinanceHost(config.binanceFutures.restBase);
  if (!isPaper && process.env.CLOSE_ALL_CONFIRM_LIVE !== "yes") {
    console.error("✗ REFUSING: Binance not testnet. Set CLOSE_ALL_CONFIRM_LIVE=yes to override.");
    process.exit(2);
  }
  console.log(`▌ Mode: ${isPaper ? "testnet" : "LIVE"}\n`);

  const db = new Database(DB_PATH);
  const openCrypto = db.prepare(
    `SELECT id, symbol, market, side, quantity, entry_price, account_id
     FROM trades WHERE status='open' AND market='crypto' ORDER BY symbol`
  ).all() as Array<any>;
  console.log(`▌ Open crypto trades in DB: ${openCrypto.length}`);
  for (const r of openCrypto) {
    console.log(`    ${r.symbol.padEnd(10)} ${r.side.padEnd(4)} qty=${r.quantity}  @ $${r.entry_price}  [${r.account_id}]`);
  }
  console.log("");

  const binance = new BinanceExecutor();
  const ok = await binance.init();
  if (!ok) {
    console.error("✗ Binance failed to init");
    process.exit(1);
  }

  const positions = await binance.getPositions();
  const active = positions.filter(p => Math.abs(p.positionAmt) > 0);
  console.log(`▌ Binance broker-side positions: ${active.length}`);
  for (const p of active) {
    console.log(`    ${p.symbol.padEnd(10)} amt=${p.positionAmt}  entry=$${p.entryPrice}  unrPnL=$${p.unrealizedProfit.toFixed(2)}`);
  }
  console.log("");

  console.log(`▌ Closing...`);
  const results: Array<{ alpacaSymbol: string; ok: boolean; filledPrice: number; realizedPnl: number; commission: number }> = [];
  for (const p of active) {
    const alpacaSym = BinanceExecutor.toAlpacaSymbol(p.symbol);
    if (!alpacaSym) {
      console.log(`    ${p.symbol}: ✗ no symbol mapping`);
      continue;
    }
    const side: "buy" | "sell" = p.positionAmt > 0 ? "buy" : "sell";
    // Bounded to OUR DB rows (2026-07-29): the broker may hold a position we
    // don't have a row for (manual/unknown) — closing the raw
    // Math.abs(positionAmt) would touch that too. min(our rows, broker),
    // skip if 0.
    const qty = boundedCryptoCloseQty(openCrypto, alpacaSym, Math.abs(p.positionAmt));
    if (!(qty > 0)) {
      console.log(`    ${alpacaSym.padEnd(10)}  • no DB row of ours (manual/unknown) — skipped`);
      continue;
    }
    try {
      const r = await binance.closePosition(alpacaSym, qty, side);
      results.push({ alpacaSymbol: alpacaSym, ok: r.success, filledPrice: r.filledPrice, realizedPnl: r.realizedPnl, commission: r.commission });
      if (r.success) {
        console.log(`    ${alpacaSym.padEnd(10)}  ✓ filled @ $${r.filledPrice.toFixed(4)}  realizedPnl=$${r.realizedPnl.toFixed(4)}  fee=$${r.commission.toFixed(4)}`);
      } else {
        console.log(`    ${alpacaSym.padEnd(10)}  ✗ broker rejected`);
      }
    } catch (e: any) {
      console.log(`    ${alpacaSym.padEnd(10)}  ✗ ${e.message}`);
      results.push({ alpacaSymbol: alpacaSym, ok: false, filledPrice: 0, realizedPnl: 0, commission: 0 });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Reconcile DB
  console.log(`\n▌ Reconciling DB...`);
  const now = Date.now();
  let updated = 0;
  for (const trade of openCrypto) {
    const match = results.find(r => r.alpacaSymbol === trade.symbol && r.ok);
    if (!match) {
      console.log(`    ${trade.symbol.padEnd(10)}  [${trade.account_id}]  • no broker fill; leaving DB row untouched`);
      continue;
    }
    const exitPrice = match.filledPrice;
    // Each DB row is a portion of the broker position (multiple rows per symbol
    // allowed), so allocate broker's realized PnL proportionally by quantity.
    const allSame = openCrypto.filter(t => t.symbol === trade.symbol);
    const totalQty = allSame.reduce((a, b) => a + b.quantity, 0);
    const share = totalQty > 0 ? trade.quantity / totalQty : 0;
    const pnlShare = match.realizedPnl * share;
    const feeShare = match.commission * share;
    const netPnl = pnlShare - feeShare;
    const denom = trade.entry_price * trade.quantity;
    const pnlPct = denom > 0 && Number.isFinite(netPnl) ? (netPnl / denom) * 100 : 0;

    db.prepare(
      `UPDATE trades SET status='closed', exit_price=?, exit_time=?, pnl=?, pnl_pct=?, close_commission=?, close_reason=? WHERE id=? AND status='open'`
    ).run(exitPrice, now, netPnl, pnlPct, feeShare, "MANUAL_CLOSE", trade.id);
    updated++;
    console.log(`    ${trade.symbol.padEnd(10)}  ✓ exit=$${exitPrice.toFixed(4)}  net pnl=$${netPnl.toFixed(4)}`);
  }

  console.log(`\n▌ SUMMARY`);
  console.log(`    Broker OK: ${results.filter(r => r.ok).length}/${results.length}`);
  console.log(`    DB rows updated: ${updated}/${openCrypto.length}`);
  const stillOpen = (db.prepare(`SELECT COUNT(*) n FROM trades WHERE status='open' AND market='crypto'`).get() as any).n;
  console.log(`    Crypto still open in DB: ${stillOpen}`);

  db.close();
  console.log(`\n✅ Crypto done. For stocks run: bun scripts/close-stocks-at-open.ts after 13:30 UTC`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
