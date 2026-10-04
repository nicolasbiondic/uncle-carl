#!/usr/bin/env bun
/**
 * Research (2026-10-04, crypto-corrected-sim branch): momentum_crypto
 * live-vs-CORRECTED-replay over the live vt-35 window. NOT a trial — the
 * candidate config is the live kernel verbatim (execution identity of
 * 06e1a160's vt-35), replayed over the live dates on prod's CURRENT
 * historical.db (scp'd 2026-10-04 to wt/data/hist-prod-20261004.db).
 *
 * Question: the live sleeve is −8.48% in 10 sessions since MODEL_START
 * (2026-09-23, EOD 09-22 5557.29 → EOD 10-02 5085.85), below the corrected
 * band's p5 (−7.21%). How much of that is the MODEL (the corrected sim also
 * drawing down over these exact dates) and how much is EXECUTION (testnet
 * spread ~8.5bps vs 0.7 mainnet, mark-price STOP_MARKET vs the sim's 1h
 * last-price low, stop level from the real fill)?
 *
 * Two windows:
 *   A: MODEL_START   2026-09-23T00:00Z → last common bar, eq0 = 5561.98
 *      (prod equity_snapshots momentum_crypto @ 2026-09-23T00:01:40Z)
 *   B: PARITY EPOCH  2026-09-26T19:00Z → last common bar, eq0 = 5333.23
 *      (snapshot @ 2026-09-26T19:02:28Z; parity monitor epoch)
 *
 * Caveat (declared): the sim starts each window with a FRESH RiskState
 * (peak = eq0). Live re-anchored its peak at MODEL_START (modelVersion
 * vt35-2026-09-23), so window A matches live's anchor; window B starts
 * with a lower peak than live carried into 09-26.
 *
 * Artifact: data/backtests/<sha256> (kind: research-crypto-live-vs-sim-v2).
 * Read-only against prod; writes nothing outside data/backtests/.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { runWithConfig, canonicalJson, type ReplayConfig, type ReplayResult } from "./backtest-momentum-wf";

// The 2026-10-04 run read a copy of prod's historical.db taken that day
// (hist-prod-20261004.db); pass that copy as the first argument.
const DB_PATH = process.argv[2] ?? process.env.RESEARCH_DB ?? "data/historical.db";
const UNIVERSE = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "AVAX/USD", "DOGE/USD", "LINK/USD"];

// Live equity (prod equity_snapshots, profile momentum_crypto, read 2026-10-04):
const LIVE_EOD: Array<[string, number]> = [
  ["2026-09-22", 5557.29], ["2026-09-23", 5333.23], ["2026-09-24", 5333.23],
  ["2026-09-25", 5333.23], ["2026-09-26", 5313.21], ["2026-09-27", 5310.92],
  ["2026-09-28", 5190.28], ["2026-09-29", 5202.90], ["2026-09-30", 5148.54],
  ["2026-10-01", 5140.41], ["2026-10-02", 5085.85], ["2026-10-03", 5123.90],
  ["2026-10-04", 5155.59],
];
const LIVE_EQ_MODEL_START = 5561.98; // snapshot 2026-09-23T00:01:40Z
const LIVE_EQ_PARITY = 5333.23; // snapshot 2026-09-26T19:02:28Z
const LIVE_EQ_LAST = 5155.59; // snapshot 2026-10-04T15:39:54Z

// Live closed trades since MODEL_START (prod trades table, momentum_crypto):
const LIVE_TRADES = [
  { exit: "2026-09-23T14:12:59Z", symbol: "SOL/USD", pnl: -79.57, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-09-23T16:02:10Z", symbol: "ADA/USD", pnl: -83.96, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-09-28T05:32:07Z", symbol: "ADA/USD", pnl: -36.56, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-09-28T09:06:25Z", symbol: "LINK/USD", pnl: -39.3, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-09-28T14:29:11Z", symbol: "AVAX/USD", pnl: -34.45, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-09-30T00:11:43Z", symbol: "LINK/USD", pnl: -35.18, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-10-02T08:00:17Z", symbol: "SOL/USD", pnl: 5.93, reason: "MANUAL_CLOSE" },
  { exit: "2026-10-02T15:00:18Z", symbol: "XRP/USD", pnl: -12.77, reason: "MANUAL_CLOSE" },
  { exit: "2026-10-02T16:00:18Z", symbol: "SOL/USD", pnl: -7.92, reason: "MANUAL_CLOSE" },
  { exit: "2026-10-02T18:00:22Z", symbol: "XRP/USD", pnl: -6.27, reason: "SLOT_DISPLACED" },
  { exit: "2026-10-02T18:37:29Z", symbol: "LINK/USD", pnl: -35.45, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-10-02T18:44:08Z", symbol: "AVAX/USD", pnl: -31.64, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-10-02T18:47:37Z", symbol: "DOGE/USD", pnl: -35.04, reason: "BROKER_STOP_LOSS" },
  { exit: "2026-10-03T01:00:20Z", symbol: "XRP/USD", pnl: 14.59, reason: "SLOT_DISPLACED" },
  { exit: "2026-10-03T06:00:20Z", symbol: "DOGE/USD", pnl: -3.63, reason: "SLOT_DISPLACED" },
  { exit: "2026-10-04T12:00:20Z", symbol: "AVAX/USD", pnl: 26.42, reason: "SLOT_DISPLACED" },
];

function liveKernel(initialEquity: number): ReplayConfig {
  return {
    sleeve: "crypto",
    universe: [...UNIVERSE],
    timeframe: "1h",
    source: "binance_futures",
    refSymbol: "BTC/USD",
    rthOnly: false,
    funding: true,
    barMinutes: 60,
    barMinutesEq: 60,
    slippageBps: 5,
    commissionBps: 4,
    initialEquity,
    leverage: 2,
    hardStopPct: 0.04,
    cadenceMin: 60,
    notionalPctPerSlot: 0.375,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 4,
    maxShorts: 0,
    shortFunding: "credit",
    sharpeGate: { lookbackDays: 30, minSharpe: 0 },
    volTarget: { annualizedPct: 35, lookbackBars: 720, minScale: 0.33, maxScale: 1.5 },
    risk: { peakHalfLifeDays: 30 },
    warmupDays: 45,
    dbPath: DB_PATH,
  };
}

function computeAsOf(): number {
  const db = new Database(DB_PATH, { readonly: true });
  let minAsOf = Infinity;
  for (const sym of UNIVERSE) {
    const bar = db.query(`SELECT MAX(timestamp) m FROM historical_bars WHERE symbol = ? AND source = 'binance_futures' AND timeframe = '1h'`).get(sym) as { m: number | null };
    let asOf = (bar.m ?? 0) + 3_600_000;
    const perp = sym.replace("/USD", "USDT");
    const fund = db.query(`SELECT MAX(funding_time) m FROM funding_rates WHERE symbol = ?`).get(perp) as { m: number | null };
    asOf = Math.min(asOf, fund.m ?? 0);
    if (asOf < minAsOf) minAsOf = asOf;
  }
  db.close();
  return minAsOf;
}

const iso = (t: number | null | undefined) => (t == null ? "—" : new Date(t).toISOString().replace(".000Z", "Z"));

function dailyEod(r: ReplayResult): Array<[string, number]> {
  const byDay: Record<string, number> = {};
  for (const p of r.equityHistory) byDay[new Date(p.t).toISOString().slice(0, 10)] = p.eq;
  return Object.keys(byDay).sort().map(d => [d, byDay[d]] as [string, number]);
}

function printSim(label: string, r: ReplayResult) {
  console.log(`\n▌ SIM ${label} — ${r.trades} closed, WR ${(r.winRate * 100).toFixed(0)}%, ret ${(r.totalReturn * 100).toFixed(2)}%, finalEq ${r.finalEquity.toFixed(2)}, fees $${r.fees.toFixed(2)}, funding $${r.funding.toFixed(2)}, maxDD ${(r.maxDrawdown * 100).toFixed(1)}%`);
  const stops = r.closedTrades.filter(t => t.reason === "stop_loss");
  console.log(`  stop_loss closes: ${stops.length}, pnl ${stops.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
  for (const t of r.closedTrades) {
    console.log(`  ${t.symbol.padEnd(9)} ${iso(t.entryAt).padEnd(21)} → ${iso(t.exitAt).padEnd(21)} pnl ${t.pnl.toFixed(2).padStart(8)}  ${t.reason}`);
  }
  console.log(`  gateBlocks: ${JSON.stringify(r.gateBlocks)}`);
  console.log(`  daily EOD equity:`);
  for (const [d, eq] of dailyEod(r)) console.log(`    ${d} ${eq.toFixed(2)}`);
}

async function main() {
  const asOf = computeAsOf();
  console.log(`asOf (last common bar+funding in hist-prod-20261004.db): ${iso(asOf)}`);
  const windows = [
    { label: "A-modelStart", from: "2026-09-23T00:00:00Z", to: iso(asOf), eq0: LIVE_EQ_MODEL_START },
    { label: "B-parityEpoch", from: "2026-09-26T19:00:00Z", to: iso(asOf), eq0: LIVE_EQ_PARITY },
  ];
  const results: Record<string, ReplayResult> = {};
  for (const w of windows) {
    const r = await runWithConfig(liveKernel(w.eq0), { label: w.label, from: w.from, to: w.to });
    if (!r) throw new Error(`replay returned null for ${w.label}`);
    results[w.label] = r;
    printSim(`${w.label} [${w.from} → ${w.to}] eq0=${w.eq0}`, r);
  }

  console.log(`\n▌ LIVE EOD equity (prod equity_snapshots)`);
  for (const [d, eq] of LIVE_EOD) console.log(`  ${d} ${eq.toFixed(2)} (${(((eq / 5557.29) - 1) * 100).toFixed(2)}% vs EOD 09-22)`);
  const liveStops = LIVE_TRADES.filter(t => t.reason === "BROKER_STOP_LOSS");
  console.log(`\n▌ LIVE closed since MODEL_START: ${LIVE_TRADES.length}, pnl ${LIVE_TRADES.reduce((s, t) => s + t.pnl, 0).toFixed(2)}; stops ${liveStops.length}, pnl ${liveStops.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);

  const body = {
    kind: "research-crypto-live-vs-sim-v2",
    generatedAt: new Date().toISOString(),
    question: "Corrected-sim replay of the live vt-35 kernel over the live window vs prod equity_snapshots: model drawdown vs execution gap decomposition.",
    dbPath: DB_PATH,
    asOf: iso(asOf),
    liveEod: LIVE_EOD,
    liveTrades: LIVE_TRADES,
    windows,
    variants: Object.fromEntries(
      Object.entries(results).map(([k, r]) => [k, {
        configHash: r.hash,
        finalEquity: r.finalEquity,
        totalReturn: r.totalReturn,
        maxDrawdown: r.maxDrawdown,
        trades: r.trades,
        winRate: r.winRate,
        fees: r.fees,
        funding: r.funding,
        gateBlocks: r.gateBlocks,
        dailyEod: dailyEod(r),
        closedTrades: r.closedTrades,
      }]),
    ),
  };
  const hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const path = `data/backtests/${hash}`;
  writeFileSync(path, JSON.stringify(body, null, 2));
  console.log(`\nartifact: ${path}`);
}

if (import.meta.main) await main();
