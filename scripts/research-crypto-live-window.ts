#!/usr/bin/env bun
/**
 * Research (2026-08-06, investigation 6): momentum_crypto live-vs-replay,
 * operation by operation, over the sleeve's actual live window.
 *
 * Context established from PROD DB (backup daily-20260806.db, read-only):
 *   - The sleeve traded LIVE only 2026-07-10T14:27Z → 2026-07-16 (then a
 *     one-time migration routed all new targets to SHADOW; residual broker
 *     positions were managed until LINK stopped out Jul 20 and ETH was
 *     manually closed Jul 29).
 *   - The "13 closed trades, WR 8%" headline counts 7 pnl=0 SYNC_* row-churn
 *     rows (same broker position re-registered across restarts) as losses.
 *     Economically there were 5 distinct positions + 1 mis-sized blip.
 *   - Live signal candles come from MAINNET fapi.binance.com klines
 *     (src/market/binanceKlines.ts BASE) — the same source historical.db is
 *     backfilled from. Only EXECUTION happens on testnet.
 *
 * This script replays the REAL MomentumEngine (runWithConfig — the same
 * harness the walk-forward protocol uses) over the exact live window with
 * prod-parity config, and prints the sim's op-by-op ledger next to the
 * live one for comparison. Two sizing variants are run because prod itself
 * changed mid-window (slot 0.25 engine-default at go-live, 0.375 deployed
 * ~Jul 13); sizing does not affect symbol/timing selection, only notional.
 *
 * Artifact: data/backtests/<sha256> (kind: research-crypto-live-window-v1).
 * Read-only against prod; writes nothing outside data/backtests/.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { runWithConfig, hashReplayConfig, canonicalJson, type ReplayConfig, type ReplayResult } from "./backtest-momentum-wf";
import { RISK_PROFILES } from "../src/config/riskProfiles";

const UNIVERSE = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "AVAX/USD", "DOGE/USD", "LINK/USD"];

// Live window: first live order 2026-07-10T14:27Z (aligned to the hour grid);
// end = latest common funding/bar asOf in this checkout's historical.db.
const WINDOW = { label: "live-30d", from: "2026-07-10T14:00:00Z", to: "2026-08-06T08:00:00Z" };
// Observed go-live sleeve equity (equity_snapshots era2 first row, prod).
const GO_LIVE_EQUITY = 10_272.72;

function cfgFor(slot: number): ReplayConfig {
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
    initialEquity: GO_LIVE_EQUITY,
    leverage: RISK_PROFILES.momentum_crypto.leverage,
    hardStopPct: RISK_PROFILES.momentum_crypto.stopLossPct / 100,
    cadenceMin: 60,
    notionalPctPerSlot: slot,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 4,
    maxShorts: 0,
    shortFunding: "credit",
    tsmTrail: undefined, // intentionally absent on crypto, per src/index.ts
    sharpeGate: { lookbackDays: 30, minSharpe: 0 },
    volTarget: undefined,
    warmupDays: 32,
    dbPath: "./data/historical.db",
  };
}

// Live economic ledger (prod trades table, account_id='momentum_crypto',
// id NOT LIKE 'sync_%', SYNC row-churn collapsed to the underlying position).
const LIVE_OPS = [
  { symbol: "ADA/USD", entry: "2026-07-10T14:27:07Z", entryPx: 0.1672, exit: "2026-07-10T14:31:23Z", exitPx: 0.1668, pnl: -12.29, reason: "MANUAL_CLOSE (mis-sized 0.5-slot blip, re-entered 1min later)" },
  { symbol: "ADA/USD", entry: "2026-07-10T14:32:04Z", entryPx: 0.1671, exit: "2026-07-12T01:39:45Z", exitPx: 0.1648, pnl: -36.33, reason: "MOMENTUM_REBALANCE" },
  { symbol: "ETH/USD", entry: "2026-07-10T14:32:07Z", entryPx: 1789.09, exit: "2026-07-29T16:36:10Z", exitPx: 1892.77, pnl: 147.28, reason: "MANUAL_CLOSE (post-shadow cleanup)" },
  { symbol: "SOL/USD", entry: "2026-07-10T14:32:10Z", entryPx: 77.71, exit: "2026-07-13T18:00:05Z", exitPx: 74.66, pnl: -101.67, reason: "SYNC_DETECTED (-3.9% ≈ hard SL)" },
  { symbol: "LINK/USD", entry: "2026-07-12T01:39:50Z", entryPx: 7.956, exit: "2026-07-20T07:45:42Z", exitPx: 7.8181, pnl: -45.15, reason: "STOP_LOSS (fill -1.7% from entry — ANOMALY, see report)" },
  { symbol: "ADA/USD", entry: "2026-07-14T17:53:24Z", entryPx: 0.1639, exit: "2026-07-15T03:53:24Z", exitPx: 0.1638, pnl: -3.91, reason: "MOMENTUM_REBALANCE" },
];
// Shadow book (engine decisions post Jul 16, executed nowhere):
const SHADOW_OPS = [
  { symbol: "ADA/USD", entry: "2026-07-30T15:04:08Z", entryPx: 0.17223444, exit: "2026-07-31T23:15:20Z", exitPx: 0.16776644, pnl: -44.14, reason: "MOMENTUM_REBALANCE" },
  { symbol: "ADA/USD", entry: "2026-08-01T13:15:20Z", entryPx: 0.17433486, exit: null, exitPx: null, pnl: null, reason: "still open (as of backup 2026-08-06 04:30Z)" },
];

const iso = (t: number | null | undefined) => (t == null ? "—" : new Date(t).toISOString().replace(".000Z", "Z"));

function printSim(label: string, r: ReplayResult) {
  console.log(`\n▌ SIM ${label} — ${r.trades} closed trades, WR ${(r.winRate * 100).toFixed(0)}%, ret ${(r.totalReturn * 100).toFixed(2)}%, fees $${r.fees.toFixed(2)}, funding $${r.funding.toFixed(2)}, maxDD ${(r.maxDrawdown * 100).toFixed(1)}%`);
  for (const t of r.closedTrades) {
    console.log(
      `  ${t.symbol.padEnd(9)} ${iso(t.entryAt).padEnd(21)} @${String(t.entryPrice?.toPrecision(6)).padEnd(10)} → ${iso(t.exitAt).padEnd(21)} @${String(t.exitPrice?.toPrecision(6)).padEnd(10)} pnl ${t.pnl.toFixed(2).padStart(8)}  ${t.reason}`,
    );
  }
}

async function main() {
  const results: Record<string, ReplayResult> = {};
  for (const [label, slot] of [["slot=0.25 (go-live deploy)", 0.25], ["slot=0.375 (current deploy)", 0.375]] as const) {
    const cfg = cfgFor(slot);
    const r = await runWithConfig(cfg, WINDOW);
    if (!r) throw new Error(`replay returned null for ${label}`);
    results[label] = r;
    printSim(label, r);
  }

  console.log(`\n▌ LIVE economic ledger (prod, live-mode period Jul 10 → Jul 16 + residual closes)`);
  for (const t of LIVE_OPS) {
    console.log(`  ${t.symbol.padEnd(9)} ${t.entry.padEnd(21)} @${String(t.entryPx).padEnd(10)} → ${(t.exit ?? "—").padEnd(21)} @${String(t.exitPx ?? "—").padEnd(10)} pnl ${String(t.pnl).padStart(8)}  ${t.reason}`);
  }
  console.log(`\n▌ SHADOW book (engine decisions after Jul 16 demotion)`);
  for (const t of SHADOW_OPS) {
    console.log(`  ${t.symbol.padEnd(9)} ${t.entry.padEnd(21)} @${String(t.entryPx).padEnd(10)} → ${String(t.exit ?? "—").padEnd(21)} @${String(t.exitPx ?? "—").padEnd(10)} pnl ${String(t.pnl ?? "—").padStart(8)}  ${t.reason}`);
  }

  const FINDINGS = [
    "CONCORDANT: replay makes the same entries at the same hours as live — ADA/ETH/SOL 2026-07-10T14:00 (live 14:27-14:32, first tick after v8 deploy), ADA exit Jul 12 01:00 (live 01:39), SOL exit Jul 13 18:00 (live 18:00:05), ADA re-entry Jul 14 17:00 (live 17:53) and exit Jul 15 03:00 (live 03:53), ETH exit Jul 29 16:00 BY SIGNAL (live manually closed 16:36 the same hour). The engine live and simulated agree.",
    "REGIME, NOT BUG: over this exact 27-day window the sim ALSO loses (ret −2.4% @slot 0.25 / −3.6% @0.375, WR 39%, 18 trades). The multi-year OOS alpha simply does not manifest in this window; the sleeve is in an adverse regime, and live P&L (−$52 economic) is consistent with — actually slightly better than — the sim (−$245 @0.25), because shadow-demotion (Jul 16) kept live out of the sim's late-July churn (XRP/AVAX/BTC stops −$284).",
    "WR 8% IS AN ACCOUNTING ARTIFACT: 7 of the 13 closed rows are SYNC_DETECTED/SYNC_DUP_RECONCILED pnl=0 re-registrations of the same broker positions across restarts, counted as non-wins. Economic ledger: 5 positions + 1 mis-size blip, 1 winner → WR ~17-20%, net −$52.07.",
    "REAL EXECUTION BUG (LINK false stop): live LINK 'STOP_LOSS' filled 2026-07-20T07:45:42Z at 7.8181 = −1.73% from entry 7.956; the 4% stop level was 7.638. Mainnet LINK traded 8.29–8.36 that hour and its minimum low over the whole hold (Jul 12→Jul 29) was 7.788 — the stop could NEVER have fired on mainnet data. The fill price did not exist on mainnet (−6.2% off), and 20min later the USDC sleeve bought LINK/USDC at 8.42. It fired during a restart storm (10 AccountManager restarts 06:19–08:16 that morning). Testnet price path / restart-recovery artifact. Sim rode the same position to +$100 (exit by signal Jul 29 at 8.33). This single event is a ~$150 swing on a $2.5k slot and flips the sleeve's live-period read.",
    "MINOR: live never opened the BTC slot Jul 12–14 that the sim entered (sim net +$7 on those trades — marginal signal at the 39-min tick offset; negligible).",
    "EVIDENCE HOLE: the shadow_momentum_crypto book is EMPTY Jul 16→Jul 30 while the sim shows the engine deciding trades (BTC/XRP/ADA/AVAX) in that span — consistent with the ShadowAdapter 'recorded NOTHING for weeks' bug class (fixed ~Jul 30, see src/governor/ShadowAdapter.ts header). Any demote/promote evidence over that span is incomplete. From Jul 30 on, shadow matches sim op-for-op (ADA Jul 30 −44 vs sim −68 sizing-scaled; ADA open Aug 1 in both).",
  ];

  const body = {
    kind: "research-crypto-live-window-v1",
    generatedAt: new Date().toISOString(),
    question:
      "Does the real-engine replay over the exact live window reproduce momentum_crypto's live operations? Is the live WR/PnL a divergence (bug) or the same regime?",
    findings: FINDINGS,
    window: WINDOW,
    prodSource: "ssh prod backups/daily-20260806.db (read-only copy)",
    liveOps: LIVE_OPS,
    shadowOps: SHADOW_OPS,
    variants: Object.fromEntries(
      Object.entries(results).map(([k, r]) => [
        k,
        {
          configHash: r.hash,
          config: r.config,
          finalEquity: r.finalEquity,
          totalReturn: r.totalReturn,
          winRate: r.winRate,
          trades: r.trades,
          fees: r.fees,
          funding: r.funding,
          maxDrawdown: r.maxDrawdown,
          closedTrades: r.closedTrades,
        },
      ]),
    ),
  };
  const hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const path = `data/backtests/${hash}`;
  writeFileSync(path, JSON.stringify(body, null, 2));
  console.log(`\nartifact: ${path}`);
  console.log(`config hashes: ${Object.values(results).map(r => r.hash.slice(0, 12)).join(", ")}`);
}

if (import.meta.main) await main();
