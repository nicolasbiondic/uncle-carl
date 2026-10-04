#!/usr/bin/env bun
/**
 * rehearse-daily-pass — dry-run tomorrow's stock passes (W4 parity, 2026-09-25).
 *
 * READ-ONLY: no broker, no writes anywhere. Builds the LIVE engines of
 * momentum_stocks and meanrev_stocks — the REAL MomentumEngine/MeanRevEngine
 * classes with the REAL index.ts constants (via src/config/liveSleeveConfigs,
 * including `momentumStocksCutoverFor(simNow)`) — over FAKE broker adapters
 * seeded with the open positions and the latest per-sleeve equity snapshot
 * of a trading.db SNAPSHOT, serving completed daily bars from a
 * historical.db. Runs ONE pass at the simulated next trading morning
 * (09:36 ET, after the ≥09:35 discipline) on the last completed daily bar
 * and lists the closes and opens the engines would issue, with estimated
 * quantities, notional and stop distances/prices.
 *
 * Usage:
 *   bun run scripts/rehearse-daily-pass.ts --db <snapshot-of-trading.db> \
 *       --hist <historical.db> [--now <ISO or YYYY-MM-DD>]
 *
 * Defaults: simNow = 09:36 ET of the first trading day AFTER the newest
 * daily bar in --hist (so the signal bar is that newest completed bar). If
 * your historical.db lags prod by a session or two, the rehearsal shows the
 * pass those STALE bars imply — say so when quoting the output.
 *
 * Faithfulness notes (what the dry run cannot carry):
 *   - RiskGuard starts FRESH (the state files data/momentum-state-*.json
 *     live on prod, not in the DB snapshot) — a live pause/loss-streak
 *     would block entries this rehearsal shows.
 *   - Trail watermarks start empty, so TRAIL_STOP exits that depend on a
 *     prior peak cannot fire here (hard stops/signal exits/cutover do).
 *   - The meanrev entry-freshness gate is REAL: if any universe symbol's
 *     bars lag the previous trading session, entries are skipped exactly
 *     like live (status incomplete_data) — check `errors` in the output.
 */

import { Database } from "bun:sqlite";
import { MeanRevEngine, type MeanRevBrokerAdapter, type MeanRevPosition } from "../src/strategies/meanrev/MeanRevEngine";
import {
  MomentumEngine,
  type MomentumBrokerAdapter,
  type MomentumStatePersistence,
} from "../src/strategies/momentum/MomentumEngine";
import { TestClock } from "../src/utils/clock";
import { getETDateKey, getETDayBounds } from "../src/db/database";
import { isTradingDay } from "../src/utils/marketHours";
import {
  MEANREV_STOCKS_VOL_STOP,
  MOMENTUM_SLEEVE_SHARPE_GATE,
  MOMENTUM_STOCKS_SLOT_HYSTERESIS,
  liveMeanRevStocksConfig,
  liveMomentumStocksConfig,
} from "../src/config/liveSleeveConfigs";
import {
  MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_STOCKS_DAILY_HORIZON,
  dailyHorizonMaxLookback,
  MOMENTUM_STOCKS_DAILY_VOL_STOP,
  MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_STOCKS_MAX_LONGS,
  MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT,
  momentumStocksCutoverFor,
} from "../src/index";
import { DEFAULT_MEANREV_CONFIG } from "../src/strategies/meanrev/MeanRevEngine";
import { RISK_PROFILES } from "../src/config/riskProfiles";
import type { OHLCV } from "../src/utils/types";

// ── plan shapes ───────────────────────────────────────────────────────────
export interface PlannedClose { symbol: string; reason: string }
export interface PlannedOpen {
  symbol: string;
  notionalUsd: number;
  estPrice: number;
  estQty: number;
  stopLossPct?: number;
  estStopPrice?: number;
}
export interface RehearsalPlan {
  sleeve: "momentum_stocks" | "meanrev_stocks";
  simNowIso: string;
  simNowEtDate: string;
  signalSession: string; // newest completed bar the decision reads
  equity: number;
  seeded: Array<{ symbol: string; quantity: number; entryPrice: number; entryDate: string }>;
  closes: PlannedClose[];
  opens: PlannedOpen[];
  blockedReason?: string;
  status?: string;
  errors: string[];
}

// ── daily-bar store (completed sessions only) ─────────────────────────────
class DailyBarStore {
  private cache = new Map<string, OHLCV[]>();
  constructor(private db: Database, private cutMs: number) {}

  /** All completed daily bars for `symbol` strictly before the sim day
   *  (deduped by ET date, latest stamp wins — the meanrev-replay loader). */
  all(symbol: string): OHLCV[] {
    const hit = this.cache.get(symbol);
    if (hit) return hit;
    const rows = this.db.prepare(
      `SELECT timestamp, open, high, low, close, volume FROM historical_bars
       WHERE symbol = ? AND timeframe = '1d' AND source = 'alpaca_wide' AND timestamp < ?
       ORDER BY timestamp ASC`,
    ).all(symbol, this.cutMs) as OHLCV[];
    const byDate = new Map<string, OHLCV>();
    for (const r of rows) byDate.set(getETDateKey(r.timestamp), r);
    const bars = [...byDate.values()].sort((a, b) => a.timestamp - b.timestamp);
    this.cache.set(symbol, bars);
    return bars;
  }

  last(symbol: string, n: number): OHLCV[] {
    const bars = this.all(symbol);
    return bars.slice(Math.max(0, bars.length - n));
  }

  lastClose(symbol: string): number | undefined {
    const bars = this.all(symbol);
    return bars.length > 0 ? bars[bars.length - 1].close : undefined;
  }
}

// ── seeded read-only fake adapter (both engine contracts) ─────────────────
interface SeededPosition { symbol: string; quantity: number; entryPrice: number; entryTime: number }

class RehearsalBroker implements MomentumBrokerAdapter, MeanRevBrokerAdapter {
  opened: Array<{ symbol: string; side: "buy" | "sell"; notionalUsd: number; stopLossPct?: number }> = [];
  closed: Array<{ symbol: string; side: "buy" | "sell"; closeReason?: string }> = [];
  private live: SeededPosition[];

  constructor(
    seeded: SeededPosition[],
    private equity: number,
    private bars: DailyBarStore,
    private historyBars: number,
  ) {
    this.live = seeded.map(p => ({ ...p }));
  }

  async getOpenPositions(): Promise<Array<MeanRevPosition & { entryTime: number }>> {
    return this.live.map(p => ({
      symbol: p.symbol,
      side: "buy" as const,
      quantity: p.quantity,
      notional: p.quantity * (this.bars.lastClose(p.symbol) ?? p.entryPrice),
      entryTime: p.entryTime,
    }));
  }

  async getEquity(): Promise<number> { return this.equity; }
  async getRealisedPnlSince(_epochMs: number): Promise<number> { return 0; }

  async openPosition(a: { symbol: string; side: "buy" | "sell"; notionalUsd: number; stopLossPct?: number }) {
    this.opened.push({ ...a });
    const price = this.bars.lastClose(a.symbol) ?? 0;
    if (price > 0) {
      this.live.push({ symbol: a.symbol, quantity: Math.floor(a.notionalUsd / price), entryPrice: price, entryTime: Date.now() });
    }
    return { ok: true };
  }

  async closePosition(a: { symbol: string; side: "buy" | "sell"; closeReason?: string }) {
    this.closed.push({ ...a });
    this.live = this.live.filter(p => p.symbol !== a.symbol);
    return { ok: true };
  }

  async fetchCandles(symbol: string, bars: number): Promise<OHLCV[]> {
    return this.bars.last(symbol, Math.max(bars, this.historyBars));
  }
}

// ── snapshot readers ──────────────────────────────────────────────────────
function readSeededPositions(db: Database, accountId: string): SeededPosition[] {
  return (db.prepare(
    `SELECT symbol, quantity, entry_price AS entryPrice, entry_time AS entryTime
     FROM trades WHERE account_id = ? AND status = 'open' ORDER BY entry_time ASC`,
  ).all(accountId) as SeededPosition[]);
}

function readLatestEquity(db: Database, profileId: string): number | null {
  const row = db.prepare(
    `SELECT equity FROM equity_snapshots WHERE profile_id = ? ORDER BY snapshot_time DESC, id DESC LIMIT 1`,
  ).get(profileId) as { equity: number } | null;
  return row?.equity ?? null;
}

// ── sim clock ─────────────────────────────────────────────────────────────
/** 09:36 ET of the first trading day after the newest daily bar in hist. */
export function defaultSimNow(hist: Database): number {
  const row = hist.prepare(
    `SELECT MAX(timestamp) AS ts FROM historical_bars WHERE timeframe = '1d' AND source = 'alpaca_wide'`,
  ).get() as { ts: number | null };
  if (row.ts === null) throw new Error("rehearse: historical.db has no alpaca_wide/1d bars");
  let key = getETDateKey(row.ts);
  for (let i = 0; i < 10; i++) {
    const [, nextStart] = getETDayBounds(key);
    key = getETDateKey(nextStart + 12 * 3_600_000);
    if (isTradingDay(key)) break;
  }
  const [dayStart] = getETDayBounds(key);
  return dayStart + (9 * 60 + 36) * 60_000;
}

// ── engine drivers ────────────────────────────────────────────────────────
const memoryState: () => MomentumStatePersistence = () => {
  let store: any = null;
  return { load: () => store, save: (s: any) => { store = s; } };
};

function toPlan(
  sleeve: RehearsalPlan["sleeve"],
  simNow: number,
  bars: DailyBarStore,
  broker: RehearsalBroker,
  seeded: SeededPosition[],
  equity: number,
  closes: PlannedClose[],
  extra: Pick<RehearsalPlan, "blockedReason" | "status" | "errors">,
): RehearsalPlan {
  const signalSession = ((): string => {
    let newest = 0;
    for (const s of seeded) newest = Math.max(newest, ...(bars.all(s.symbol).slice(-1).map(b => b.timestamp)));
    // Robust: read SPY-equivalent from any opened/seeded symbol; fall back
    // to the first opened symbol's last bar.
    const anySym = broker.opened[0]?.symbol ?? seeded[0]?.symbol;
    if (anySym) newest = Math.max(newest, ...(bars.all(anySym).slice(-1).map(b => b.timestamp)));
    return newest > 0 ? getETDateKey(newest) : "(unknown)";
  })();
  return {
    sleeve,
    simNowIso: new Date(simNow).toISOString(),
    simNowEtDate: getETDateKey(simNow),
    signalSession,
    equity,
    seeded: seeded.map(p => ({ symbol: p.symbol, quantity: p.quantity, entryPrice: p.entryPrice, entryDate: getETDateKey(p.entryTime) })),
    closes,
    opens: broker.opened.map(o => {
      const estPrice = bars.lastClose(o.symbol) ?? 0;
      return {
        symbol: o.symbol,
        notionalUsd: Math.round(o.notionalUsd * 100) / 100,
        estPrice,
        estQty: estPrice > 0 ? Math.floor(o.notionalUsd / estPrice) : 0,
        ...(o.stopLossPct !== undefined ? {
          stopLossPct: Math.round(o.stopLossPct * 100) / 100,
          estStopPrice: Math.round(estPrice * (1 - o.stopLossPct / 100) * 100) / 100,
        } : {}),
      };
    }),
    ...extra,
  };
}

export async function rehearse(opts: { dbPath: string; histPath: string; nowMs?: number }): Promise<{
  momentum: RehearsalPlan;
  meanrev: RehearsalPlan;
}> {
  const snapshot = new Database(opts.dbPath, { readonly: true });
  const hist = new Database(opts.histPath, { readonly: true });
  // The live maintenance kill-switch would zero the rehearsal exactly like
  // it zeroed the 2026-08-02 replay artifacts — neutralize and restore.
  const prevTradingEnabled = process.env.TRADING_ENABLED;
  delete process.env.TRADING_ENABLED;
  try {
    const simNow = opts.nowMs ?? defaultSimNow(hist);
    const [dayStart] = getETDayBounds(getETDateKey(simNow));
    const cutMs = dayStart; // completed bars = strictly before the sim day

    // ── momentum_stocks ──────────────────────────────────────────────────
    const horizon = MOMENTUM_STOCKS_DAILY_HORIZON;
    if (!horizon) throw new Error("rehearse: momentum_stocks daily horizon is OFF — this rehearsal only models the daily kernel");
    const mCfg = liveMomentumStocksConfig();
    const mHistoryBars = Math.max(dailyHorizonMaxLookback(horizon), horizon.maLengthDays) + 11; // index.ts stocksHistoryBars
    const mBars = new DailyBarStore(hist, cutMs);
    const mSeeded = readSeededPositions(snapshot, "momentum_stocks");
    const mEquity = readLatestEquity(snapshot, "momentum_stocks");
    if (mEquity === null) throw new Error("rehearse: no equity_snapshots row for momentum_stocks in the snapshot");
    const mBroker = new RehearsalBroker(mSeeded, mEquity, mBars, mHistoryBars);
    const cutover = momentumStocksCutoverFor(simNow);
    const mEngine = new MomentumEngine(
      {
        mode: "time-series",
        universe: mCfg.universe,
        rebalanceMinutes: 60, // informational (index.ts drives the tick)
        historyBars: mHistoryBars,
        notionalPctPerSlot: MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT,
        tsm: {
          barMinutes: 1440,
          maxLongs: MOMENTUM_STOCKS_MAX_LONGS,
          slotHysteresis: MOMENTUM_STOCKS_SLOT_HYSTERESIS,
          ...(horizon.lookbackDaysList
            ? { lookbackDaysList: [...horizon.lookbackDaysList] }
            : { lookbackDays: horizon.lookbackDays }),
          maLengthDays: horizon.maLengthDays,
        },
        regime: { barMinutes: 1440 },
        scorer: { barMinutes: 1440 },
        tsmTrail: { ...MOMENTUM_STOCKS_DAILY_VOL_STOP },
        volStop: { ...MOMENTUM_STOCKS_DAILY_VOL_STOP },
        sharpeGate: { ...MOMENTUM_SLEEVE_SHARPE_GATE },
        risk: {},
        maxGrossExposureMult: MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT,
        ...(cutover !== undefined ? { reunderwriteBefore: cutover } : {}),
      },
      mBroker,
      { info: () => {}, warn: () => {}, error: () => {} },
      memoryState(),
      new TestClock(simNow),
    );
    const mReport = await mEngine.tick();
    const momentum = toPlan(
      "momentum_stocks", simNow, mBars, mBroker, mSeeded, mEquity,
      mBroker.closed.map(c => ({ symbol: c.symbol, reason: c.closeReason ?? "MOMENTUM_REBALANCE" })),
      { blockedReason: mReport.blockedReason, status: mReport.tradeable ? "ok" : "blocked", errors: [] },
    );

    // ── meanrev_stocks ───────────────────────────────────────────────────
    const mrBars = new DailyBarStore(hist, cutMs);
    const mrSeeded = readSeededPositions(snapshot, "meanrev_stocks");
    const mrEquity = readLatestEquity(snapshot, "meanrev_stocks");
    if (mrEquity === null) throw new Error("rehearse: no equity_snapshots row for meanrev_stocks in the snapshot");
    const mrBroker = new RehearsalBroker(mrSeeded, mrEquity, mrBars, DEFAULT_MEANREV_CONFIG.historyBars);
    const [todayStart, todayEnd] = getETDayBounds(getETDateKey(simNow));
    const mrEngine = new MeanRevEngine(
      {
        accountId: "meanrev_stocks",
        // Exactly index.ts's wiring: capital base from RISK_PROFILES (env
        // MEANREV_BASE_USD honored); slotPct/maxPositions/RSI/SMA/timeStop
        // stay DEFAULT_MEANREV_CONFIG (the single source).
        baseUsd: RISK_PROFILES.meanrev_stocks.initialEquity,
        risk: {},
        maxGrossExposureMult: MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT,
        volStop: { ...MEANREV_STOCKS_VOL_STOP },
      },
      mrBroker,
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        now: () => simNow,
        // Production calendar (default isTradingDay) is kept; the entry
        // idempotency probe reads the SNAPSHOT's ledger like live reads its
        // trading.db (a symbol entered today in the snapshot won't re-enter).
        alreadyEnteredToday: (accountId, symbol) =>
          snapshot.prepare(
            `SELECT 1 FROM trades WHERE account_id = ? AND symbol = ?
             AND (status = 'open' OR (entry_time >= ? AND entry_time < ?)) LIMIT 1`,
          ).get(accountId, symbol, todayStart, todayEnd) !== null,
      },
      memoryState(),
    );
    const mrReport = await mrEngine.runDaily();
    const meanrev = toPlan(
      "meanrev_stocks", simNow, mrBars, mrBroker, mrSeeded, mrEquity,
      mrReport.closes.filter(c => c.ok).map(c => ({ symbol: c.symbol, reason: c.reason })),
      { blockedReason: mrReport.blockedReason, status: mrReport.status, errors: mrReport.errors },
    );

    return { momentum, meanrev };
  } finally {
    if (prevTradingEnabled !== undefined) process.env.TRADING_ENABLED = prevTradingEnabled;
    hist.close();
    snapshot.close();
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────
function renderPlan(p: RehearsalPlan): string {
  const lines: string[] = [];
  lines.push(`── ${p.sleeve} ──`);
  lines.push(`  sim now: ${p.simNowIso} (ET ${p.simNowEtDate}) · signal bar: ${p.signalSession} · equity $${p.equity.toFixed(2)}`);
  lines.push(`  seeded positions: ${p.seeded.length === 0 ? "(none)" : p.seeded.map(s => `${s.symbol}×${s.quantity}@${s.entryPrice} (${s.entryDate})`).join(", ")}`);
  if (p.status && p.status !== "ok") lines.push(`  status: ${p.status}${p.blockedReason ? ` — ${p.blockedReason}` : ""}`);
  for (const e of p.errors) lines.push(`  ⚠️  ${e}`);
  lines.push(p.closes.length === 0 ? "  closes: (none)" : "  closes:");
  for (const c of p.closes) lines.push(`    - ${c.symbol} (${c.reason})`);
  lines.push(p.opens.length === 0 ? "  opens: (none)" : "  opens:");
  for (const o of p.opens) {
    const stop = o.stopLossPct !== undefined ? ` · stop ${o.stopLossPct}% ≈ $${o.estStopPrice}` : "";
    lines.push(`    - ${o.symbol}: $${o.notionalUsd} ≈ ${o.estQty} sh @ ~$${o.estPrice}${stop}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const dbPath = flag("--db");
  const histPath = flag("--hist");
  if (!dbPath || !histPath) {
    console.error("usage: bun run scripts/rehearse-daily-pass.ts --db <trading.db snapshot> --hist <historical.db> [--now <ISO>]");
    process.exit(2);
  }
  const nowArg = flag("--now");
  const nowMs = nowArg ? Date.parse(nowArg.length === 10 ? `${nowArg}T13:36:00Z` : nowArg) : undefined;
  if (nowArg && !Number.isFinite(nowMs)) {
    console.error(`rehearse: cannot parse --now ${nowArg}`);
    process.exit(2);
  }

  const { momentum, meanrev } = await rehearse({ dbPath, histPath, nowMs });
  console.log(`rehearse-daily-pass @ ${new Date().toISOString()} (READ-ONLY dry run — nothing was ordered)`);
  console.log(renderPlan(momentum));
  console.log(renderPlan(meanrev));
  // Explicit exit — the src/index.ts import graph keeps handles alive.
  process.exit(0);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`rehearse-daily-pass failed: ${err?.message ?? err}`);
    console.error(err);
    process.exit(2);
  });
}
