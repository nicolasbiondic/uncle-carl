// ══════════════════════════════════════════════
// FundingMonitor — Binance MAINNET perp funding rates (2026-07-12)
// ══════════════════════════════════════════════
//
// The futures TESTNET pins funding at 0.01% — useless as a signal. All
// funding data here comes from the public MAINNET REST API (no key):
//   /fapi/v1/premiumIndex        live lastFundingRate (poll every 15min)
//   /fapi/v1/fundingRate         settled history (synced daily into
//                                funding_rates in data/historical.db)
//
// Everything FAILS OPEN: a dead mainnet fetch keeps the last-known rates,
// missing history returns neutral percentiles, isCrashRisky() defaults to
// false. The monitor can gate/inform trading but never blocks it by outage.

import { Database } from "bun:sqlite";
import { fetchT } from "../utils/timeout";
import { createLogger } from "../utils/logger";
import { heartbeats } from "../ops/heartbeat";

const log = createLogger("FundingMonitor");

const MAINNET = "https://fapi.binance.com";

/** Our perp universe (mainnet symbols). */
export const FUNDING_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT",
  "ADAUSDT", "AVAXUSDT", "DOGEUSDT", "LINKUSDT",
];

export const FUNDING_DB_PATH = "./data/historical.db";

/** 8h funding ⇒ 3/day × 365. */
export const FUNDING_PERIODS_PER_YEAR = 3 * 365;

export type FetchFn = (url: string, opts?: RequestInit, timeoutMs?: number) => Promise<Response>;

export function ensureFundingTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS funding_rates (
    symbol TEXT NOT NULL,
    funding_time INTEGER NOT NULL,
    rate REAL NOT NULL,
    PRIMARY KEY (symbol, funding_time)
  )`);
}

/**
 * Pull settled funding history from mainnet into funding_rates, paginating
 * by startTime (1000 rows/page). Idempotent: resumes from MAX(funding_time)+1
 * per symbol; re-running when up to date fetches ≤1 page and upserts nothing new.
 * Returns rows upserted per symbol.
 */
export async function syncFundingHistory(
  db: Database,
  opts: { symbols?: string[]; fetchFn?: FetchFn; pageDelayMs?: number } = {},
): Promise<Record<string, number>> {
  const { symbols = FUNDING_SYMBOLS, fetchFn = fetchT, pageDelayMs = 250 } = opts;
  ensureFundingTable(db);
  const upsert = db.prepare(
    `INSERT INTO funding_rates (symbol, funding_time, rate) VALUES (?, ?, ?)
     ON CONFLICT(symbol, funding_time) DO UPDATE SET rate = excluded.rate`,
  );
  const counts: Record<string, number> = {};
  // startTime=0 is treated as ABSENT by the API (returns the most-recent page,
  // breaking forward pagination) — seed empty symbols just before the first
  // perp funding event ever (BTCUSDT 2019-09-10).
  const EPOCH_SEED = Date.parse("2019-09-01");
  for (const sym of symbols) {
    const maxRow = db.prepare(`SELECT MAX(funding_time) t FROM funding_rates WHERE symbol = ?`).get(sym) as { t: number | null };
    let start = maxRow?.t != null ? maxRow.t + 1 : EPOCH_SEED;
    let count = 0;
    for (;;) {
      const res = await fetchFn(`${MAINNET}/fapi/v1/fundingRate?symbol=${sym}&startTime=${start}&limit=1000`, {}, 15_000);
      if (!res.ok) throw new Error(`fundingRate ${sym} HTTP ${res.status}`);
      const rows = (await res.json()) as Array<{ fundingTime: number; fundingRate: string }>;
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) {
        upsert.run(sym, r.fundingTime, parseFloat(r.fundingRate));
        count++;
      }
      start = rows[rows.length - 1].fundingTime + 1;
      if (rows.length < 1000) break;
      if (pageDelayMs > 0) await new Promise((r) => setTimeout(r, pageDelayMs));
    }
    counts[sym] = count;
  }
  return counts;
}

/** Nearest-rank percentile over a pre-sorted ascending array, p in [0,1]. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

export interface FundingInfo {
  /** Current (running) 8h funding rate from premiumIndex. */
  rate: number;
  /** rate × 1095 — simple APR. */
  annualized: number;
  /** Percentile (0-100) of `rate` vs this symbol's trailing-90d settled rates. 50 when no history. */
  pctileVs90d: number;
}

/** Need at least this many trailing samples (~10 days) before crash-flagging. */
const MIN_HIST_SAMPLES = 30;

export interface FundingMonitorOpts {
  db?: Database;
  dbPath?: string;
  symbols?: string[];
  fetchFn?: FetchFn;
  pollMs?: number;
  historyRefreshMs?: number;
}

export class FundingMonitor {
  private readonly db: Database;
  private readonly symbols: string[];
  private readonly fetchFn: FetchFn;
  private readonly pollMs: number;
  private readonly historyRefreshMs: number;
  private live = new Map<string, number>();       // symbol → lastFundingRate
  private hist = new Map<string, number[]>();     // symbol → trailing-90d rates, sorted asc
  private pollTimer?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(opts: FundingMonitorOpts = {}) {
    this.symbols = opts.symbols ?? FUNDING_SYMBOLS;
    this.fetchFn = opts.fetchFn ?? fetchT;
    this.pollMs = opts.pollMs ?? 15 * 60_000;
    this.historyRefreshMs = opts.historyRefreshMs ?? 24 * 3_600_000;
    this.db = opts.db ?? new Database(opts.dbPath ?? FUNDING_DB_PATH);
    ensureFundingTable(this.db);
    this.refreshPercentiles();
  }

  start(): void {
    // Poll-loop liveness (grace 2). Monitoring-only + fail-open by contract, so
    // pollOnce() beats even when the fetch fails — a mainnet outage must NOT
    // page; only a wedged/dead poll loop should.
    heartbeats.register("funding_monitor", this.pollMs);
    void this.pollOnce();
    void this.refreshHistory();
    this.pollTimer = setInterval(() => void this.pollOnce(), this.pollMs);
    this.refreshTimer = setInterval(() => void this.refreshHistory(), this.historyRefreshMs);
    (this.pollTimer as { unref?: () => void }).unref?.();
    (this.refreshTimer as { unref?: () => void }).unref?.();
    log.info(`started — poll ${this.pollMs / 60_000}min, history refresh ${this.historyRefreshMs / 3_600_000}h, ${this.symbols.length} symbols`);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.pollTimer = this.refreshTimer = undefined;
  }

  /** One premiumIndex poll (all symbols in a single call). Fail-open: keeps stale rates. */
  async pollOnce(): Promise<void> {
    try {
      const res = await this.fetchFn(`${MAINNET}/fapi/v1/premiumIndex`, {}, 10_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const all = (await res.json()) as Array<{ symbol: string; lastFundingRate: string }>;
      for (const row of all) {
        if (this.symbols.includes(row.symbol)) this.live.set(row.symbol, parseFloat(row.lastFundingRate));
      }
    } catch (e) {
      log.warn(`premiumIndex poll failed (fail-open, keeping stale rates): ${e instanceof Error ? e.message : e}`);
    }
    // The poll loop ran (success or fail-open) — beat liveness, don't page on
    // a mainnet outage (that's fundingMonitor's fail-open job, not the watchdog's).
    heartbeats.beat("funding_monitor");
  }

  /** Daily: sync settled history from mainnet, then recompute percentile windows. Fail-open. */
  async refreshHistory(): Promise<void> {
    try {
      await syncFundingHistory(this.db, { symbols: this.symbols, fetchFn: this.fetchFn });
    } catch (e) {
      log.warn(`funding history sync failed (fail-open, percentiles use existing rows): ${e instanceof Error ? e.message : e}`);
    }
    this.refreshPercentiles();
  }

  refreshPercentiles(now = Date.now()): void {
    try {
      const q = this.db.prepare(`SELECT rate FROM funding_rates WHERE symbol = ? AND funding_time >= ? ORDER BY rate ASC`);
      for (const sym of this.symbols) {
        const rows = q.all(sym, now - 90 * 86_400_000) as Array<{ rate: number }>;
        this.hist.set(sym, rows.map((r) => r.rate));
      }
    } catch (e) {
      log.warn(`percentile refresh failed (fail-open): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** null until the first successful poll for that symbol. */
  getFunding(symbol: string): FundingInfo | null {
    const rate = this.live.get(symbol);
    if (rate === undefined) return null;
    const hist = this.hist.get(symbol) ?? [];
    let atOrBelow = 0;
    for (const r of hist) if (r <= rate) atOrBelow++;
    return {
      rate,
      annualized: rate * FUNDING_PERIODS_PER_YEAR,
      pctileVs90d: hist.length > 0 ? (atOrBelow / hist.length) * 100 : 50,
    };
  }

  /**
   * BIS crash-predictor gate: current rate above the P90 of the symbol's own
   * trailing-90d settled distribution. Fail-open (false) with no live rate or
   * fewer than 30 historical samples.
   */
  isCrashRisky(symbol: string): boolean {
    const rate = this.live.get(symbol);
    const hist = this.hist.get(symbol) ?? [];
    if (rate === undefined || hist.length < MIN_HIST_SAMPLES) return false;
    return rate > percentile(hist, 0.9);
  }
}
