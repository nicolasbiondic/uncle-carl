import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { researchDataPath } from "./researchData";
import { COINS, LIMITS, HyperliquidClient, storeLeaderboard, type Leader, type Portfolio, type State } from "./hyperliquid";

const DAY = 86400000;
interface PnlRow { time_ms: number; closed_pnl: number; fee: number }
export interface SelectionConfig { topN: number; days: number; minFills: number; maxDrawdownPct: number; retrospective?: boolean }
export const DEFAULT_SELECTION: SelectionConfig = { topN: 10, days: 30, minFills: 10, maxDrawdownPct: 30 };
export interface Selected { address: string; pnl: number; score: number; accountValue: number; drawdownPct: number; fills: number }

/** Realized proxy only; equityProxy is an explicitly hypothetical initial
 * balance + realized USDC PnL, NOT historical marked-to-market equity. */
export function realizedPath(rows: PnlRow[], initialBalance = 0) {
  let pnl = 0;
  return [...rows].sort((a, b) => a.time_ms - b.time_ms).map(row => {
    pnl += row.closed_pnl - row.fee;
    return { time: row.time_ms, realizedPnl: pnl, equityProxy: initialBalance + pnl };
  });
}

/** Separate realized proxy from actual, sparsely observed account values. No
 * interpolation or invented transfer/funding/mark-to-market reconstruction.
 * Strict mode uses only information available before t, including retrieval time.
 */
export function addressPaths(db: Database, address: string, t: number, retrospective = false) {
  const knownBefore = retrospective ? Number.MAX_SAFE_INTEGER : t;
  const fills = db.query<PnlRow, [string, number, number]>(`SELECT time_ms,closed_pnl,fee FROM hl_fills
    WHERE address=? AND time_ms<? AND known_ms<? AND fee_token='USDC' AND instr(coin,'@')=0 AND instr(coin,'/')=0 ORDER BY time_ms,fill_key`).all(address, t, knownBefore);
  const equity = db.query<{ time: number; accountValue: number }, [string, number]>(`SELECT snapshot_ms time,account_value accountValue FROM hl_leaderboard
    WHERE address=? AND snapshot_ms<? ORDER BY snapshot_ms`).all(address, t);
  const portfolios = db.query<{ json: string; observed_ms: number }, [string, number]>("SELECT json,observed_ms FROM hl_portfolios WHERE address=? AND observed_ms<? ORDER BY observed_ms").all(address, knownBefore);
  const portfolioEquity = portfolios.flatMap(row => (JSON.parse(row.json) as Portfolio)
    .filter(([window]) => window === "perpAllTime")
    .flatMap(([, p]) => p.accountValueHistory.filter(([time]) => time < t)
      .map(([time, value]) => ({ time, accountValue: Number(value), observedMs: row.observed_ms }))));
  return { realized: realizedPath(fills), observedEquity: equity, portfolioEquity, limits: LIMITS };
}

export function selectTraders(db: Database, t: number, config: SelectionConfig = DEFAULT_SELECTION): Selected[] {
  if (!Number.isInteger(config.topN) || config.topN < 1 || config.days <= 0 || config.minFills < 1 || config.maxDrawdownPct < 0) throw new Error("Invalid selector configuration");
  const start = t - config.days * DAY;
  const candidates = db.query<{ address: string }, [number]>(`SELECT address FROM hl_addresses WHERE first_seen_ms < ? ORDER BY address`).all(config.retrospective ? Number.MAX_SAFE_INTEGER : t);
  const out: Selected[] = [];
  for (const { address } of candidates) {
    // No present-day account value in a historical denominator. Require a
    // balance observed at/before the beginning of the trailing window.
    const balance = db.query<{ account_value: number }, [string, number]>("SELECT account_value FROM hl_leaderboard WHERE address=? AND snapshot_ms<=? ORDER BY snapshot_ms DESC LIMIT 1").get(address, start);
    if (!balance || balance.account_value <= 0) continue;
    const rows = db.query<PnlRow, [string, number, number, number]>(`SELECT time_ms,closed_pnl,fee FROM hl_fills WHERE address=? AND time_ms>=? AND time_ms<? AND known_ms<? AND fee_token='USDC' AND instr(coin,'@')=0 AND instr(coin,'/')=0 ORDER BY time_ms,fill_key`).all(address, start, t, config.retrospective ? Number.MAX_SAFE_INTEGER : t);
    if (rows.length < config.minFills) continue;
    const path = realizedPath(rows, balance.account_value);
    let peak = balance.account_value, dd = 0;
    for (const p of path) { peak = Math.max(peak, p.equityProxy); dd = Math.max(dd, 100 * (peak - p.equityProxy) / peak); }
    const pnl = path.at(-1)!.realizedPnl;
    if (pnl <= 0 || dd > config.maxDrawdownPct) continue;
    out.push({ address, pnl, score: pnl / balance.account_value, accountValue: balance.account_value, drawdownPct: dd, fills: rows.length });
  }
  return out.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address)).slice(0, config.topN);
}

export function openSignals(path = researchDataPath("signals.db")): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS signal_events(source TEXT, symbol TEXT, known_at_ms INTEGER, weight REAL, meta_json TEXT);`);
  return db;
}

/** Snapshot observations, NOT reconstructed historical positions. Missing any
 * selected state fails closed; zero positions intentionally emit zero events. */
export function writeSignals(db: Database, signals: Database, snapshotMs: number, selected: Selected[], config: SelectionConfig, knownMs: number): number {
  const totals = Object.fromEntries(COINS.map(c => [c, 0]));
  const sum = selected.reduce((s, x) => s + x.score, 0);
  for (const trader of selected) {
    const row = db.query<{ json: string; observed_ms: number }, [number, string]>("SELECT json,observed_ms FROM hl_states WHERE snapshot_ms=? AND address=?").get(snapshotMs, trader.address);
    if (!row || row.observed_ms > knownMs) throw new Error("Selected position not yet observed");
    const state = JSON.parse(row.json) as State;
    for (const { position: p } of state.assetPositions) {
      if (!COINS.includes(p.coin)) continue;
      const notional = Number(p.positionValue), size = Number(p.szi);
      if (!Number.isFinite(notional) || !Number.isFinite(size)) throw new Error("Invalid position");
      totals[p.coin]! += Math.sign(size) * Math.abs(notional) * trader.score / sum;
    }
  }
  const meta = JSON.stringify({ snapshot_ms: snapshotMs, selection_at_ms: snapshotMs, selected, config,
    weight_unit: "performance-weighted USD position notional (not portfolio allocation)",
    empty_selection: selected.length === 0, limits: LIMITS });
  signals.transaction(() => {
    // Source-local idempotency; never delete or constrain the SEC producer.
    const exists = signals.query("SELECT 1 FROM signal_events WHERE source='hyperliquid-top' AND json_extract(meta_json,'$.snapshot_ms')=? LIMIT 1").get(snapshotMs);
    if (exists) return;
    for (const coin of COINS) signals.run("INSERT INTO signal_events VALUES (?,?,?,?,?)", ["hyperliquid-top", `${coin}/USD`, knownMs, totals[coin]!, meta]);
  })();
  db.run("INSERT OR IGNORE INTO hl_selections VALUES (?,?,?,?)", [snapshotMs, knownMs, JSON.stringify(selected.map(s => s.address)), JSON.stringify(config)]);
  return COINS.length;
}

/** The pre-registered forward test's selection (docs/reports/RW-reescritura-rentable.md §11.2), using only
 *  what the leaderboard publishes at the snapshot: account value ≥ 250k USD, 30-day volume ≤ 20× the account
 *  value (no market makers or HFT), ranked by the 30-day PnL shown. The top 20 covers every candidate (N ≤ 20). */
export const FORWARD_TEST = { minAccountValue: 250_000, maxMonthVolumeMultiple: 20, top: 20 } as const;
export function forwardTestLeaders(rows: readonly Leader[]): Leader[] {
  const month = (r: Leader) => r.windowPerformances.find(w => w[0] === "month")?.[1];
  return rows
    .filter(r => {
      const value = Number(r.accountValue), m = month(r);
      return value >= FORWARD_TEST.minAccountValue && m !== undefined && Number(m.vlm) <= FORWARD_TEST.maxMonthVolumeMultiple * value;
    })
    .sort((a, b) => Number(month(b)!.pnl) - Number(month(a)!.pnl) || a.ethAddress.localeCompare(b.ethAddress))
    .slice(0, FORWARD_TEST.top);
}

export async function takeSnapshot(client: HyperliquidClient, signals: Database, config: SelectionConfig = DEFAULT_SELECTION) {
  if (config.retrospective) throw new Error("Forward logger cannot use retrospective selection");
  const lb = await client.leaderboard();
  const snapshotMs = lb.observedMs;
  storeLeaderboard(client.db, lb.data.leaderboardRows, snapshotMs);
  const selected = selectTraders(client.db, snapshotMs, config);
  // Also retain the current leaderboard's top N by month PnL for descriptive
  // research. They are NOT substituted for a strict selector still warming up.
  const rawTop = [...lb.data.leaderboardRows].sort((a, b) =>
    Number(b.windowPerformances.find(w => w[0] === "month")?.[1].pnl ?? 0) - Number(a.windowPerformances.find(w => w[0] === "month")?.[1].pnl ?? 0)).slice(0, config.topN);
  const addresses = new Set([...selected.map(s => s.address), ...rawTop.map(s => s.ethAddress.toLowerCase()),
    ...forwardTestLeaders(lb.data.leaderboardRows).map(s => s.ethAddress.toLowerCase())]);
  for (const address of addresses) {
    const state = await client.clearinghouseState(address);
    client.db.run("INSERT OR REPLACE INTO hl_states VALUES (?,?,?,?)", [snapshotMs, address, state.observedMs, JSON.stringify(state.data)]);
  }
  const knownMs = client.now();
  writeSignals(client.db, signals, snapshotMs, selected, config, knownMs);
  return { snapshotMs, knownMs, leaderboard: lb.data.leaderboardRows.length, positions: addresses.size, selected: selected.length };
}

export function descriptiveStats(db: Database) {
  const histories = db.query(`SELECT a.address,a.first_seen_ms,count(f.fill_key) fills,min(f.time_ms) first_fill_ms,max(f.time_ms) last_fill_ms,
    (max(f.time_ms)-min(f.time_ms))/86400000.0 history_days FROM hl_addresses a LEFT JOIN hl_fills f USING(address) GROUP BY a.address`).all();
  const selections = db.query<{ addresses_json: string }, []>("SELECT addresses_json FROM hl_selections ORDER BY snapshot_ms").all();
  const changes = selections.slice(1).map((s, i) => {
    const prev = new Set<string>(JSON.parse(selections[i]!.addresses_json));
    const current = new Set<string>(JSON.parse(s.addresses_json));
    return { entered: [...current].filter(a => !prev.has(a)).length, exited: [...prev].filter(a => !current.has(a)).length };
  });
  return { limits: LIMITS, addresses: histories.length, histories,
    collection: db.query("SELECT count(*) checked,sum(retention_limit) retention_flags,sum(error IS NOT NULL) errors FROM hl_history").get(),
    snapshots: db.query("SELECT count(DISTINCT snapshot_ms) n,min(snapshot_ms) first_ms,max(snapshot_ms) last_ms FROM hl_leaderboard").get(),
    coinCoverage: db.query("SELECT coin,count(*) fills,count(DISTINCT address) addresses FROM hl_fills GROUP BY coin ORDER BY fills DESC").all(),
    topNChanges: { comparisons: changes.length, changed: changes.filter(c => c.entered || c.exited).length, changes } };
}
