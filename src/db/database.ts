// ══════════════════════════════════════════════
// SQLite Database Layer (using bun:sqlite)  v4
// ══════════════════════════════════════════════

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { createLogger } from "../utils/logger";
import type { Order, Signal, TradeRecord } from "../utils/types";
// Safe import: riskProfiles is pure config with zero imports (no cycle).
import { ALL_PROFILE_IDS } from "../config/riskProfiles";

const log = createLogger("Database");

let db: Database;

// ── Time helpers (ET-aware) ─────────────────
// Audit fix (2026-05-04): all "today" stats used to call `setHours(0,0,0,0)`,
// which operates in the host's local timezone (UTC on this server). That meant
// "today" = UTC midnight, not ET trading-day midnight, so trades closed in the
// US evening (= early next UTC day) were attributed to the wrong day. The
// helpers below compute boundaries in America/New_York (handling EDT/EST) and
// are the canonical "today" definition across stats, reports, Telegram, etc.

/**
 * Returns the YYYY-MM-DD string for the given epoch (ms) in America/New_York.
 * "en-CA" outputs ISO-style YYYY-MM-DD reliably.
 */
export function getETDateKey(d: Date | number = Date.now()): string {
  const date = typeof d === "number" ? new Date(d) : d;
  return date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Returns the epoch (ms) of midnight at the *start* of the ET day that
 * contains the given timestamp. DST-correct.
 *
 * Iter 6 used a noon-anchor approach which is fine on most days but fails
 * on the 2 DST-transition days/year because noon and midnight are on
 * opposite sides of the jump (noon's offset doesn't apply to midnight).
 *
 * This version probes both candidate UTC offsets (−4 EDT, −5 EST) for the
 * target ET calendar date and picks the one whose ET-formatted day, hour
 * and minute round-trip back to "midnight on that date in ET". On regular
 * days only one candidate matches; on transition days only one matches
 * (the other lands at 23:00 of the previous day or 01:00 of the same).
 */
export function getETDayStart(at: number = Date.now()): number {
  const dateKey = new Date(at).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [y, m, d] = dateKey.split("-").map(Number);

  const partsFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const matches = (utcMs: number) => {
    const parts: any = Object.fromEntries(partsFmt.formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
    const hh = parts.hour === "24" ? "00" : parts.hour;
    return +parts.year === y && +parts.month === m && +parts.day === d && +hh === 0 && +parts.minute === 0;
  };

  // Try EDT (−4h) first since it covers ~8 months/year, then EST (−5h).
  for (const offsetH of [4, 5]) {
    const candidate = Date.UTC(y, m - 1, d, offsetH, 0, 0);
    if (matches(candidate)) return candidate;
  }
  // Fallback (should never hit): use noon-anchor approach.
  const noonUtcAnchor = Date.UTC(y, m - 1, d, 12, 0, 0);
  const parts: any = Object.fromEntries(partsFmt.formatToParts(new Date(noonUtcAnchor)).map(p => [p.type, p.value]));
  const hh = parts.hour === "24" ? "00" : parts.hour;
  const etWallAsUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +hh, +parts.minute, 0);
  const offsetMs = etWallAsUTC - noonUtcAnchor;
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
}

/** Bounds [startMs, endMs) for the ET day specified by the YYYY-MM-DD key. */
export function getETDayBounds(dateKey: string): [number, number] {
  // Build a noon-ET timestamp for that key (avoids DST transition at 02:00),
  // then snap to its day-start.
  const noonGuess = new Date(`${dateKey}T17:00:00Z`).getTime(); // ~noon ET in summer/winter
  const start = getETDayStart(noonGuess);
  const nextNoonGuess = noonGuess + 18 * 3600_000;
  const end = getETDayStart(nextNoonGuess);
  return [start, end];
}

/**
 * Hour-of-day (0-23) and day-of-week (0=Sun … 6=Sat) for a timestamp, in
 * America/New_York. The "Best Hours / Best Days" analytics must bucket by ET
 * wall-clock — the rest of the codebase defines "day"/time in ET, but
 * getHourlyAnalytics/getDailyAnalytics previously used Date#getHours/getDay
 * which read the *server* timezone (UTC in prod), shifting every bucket 4-5h
 * and landing some trades on the wrong weekday.
 */
export function getETHourDow(ms: number): { hour: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York", hour: "2-digit", hour12: false,
  });
  const parts: any = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const hour = (parts.hour === "24" ? 0 : parseInt(parts.hour, 10)) || 0;
  // Day-of-week is time-independent; derive it from the ET calendar date so it
  // is immune to UTC/DST drift (UTC-midnight of the ET date has the same dow).
  const [y, m, d] = getETDateKey(ms).split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { hour, dow };
}

export function initDatabase(path = "./data/trading.db"): Database {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true } as any);

  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  // bun:sqlite inherits SQLite's default busy_timeout=0: a concurrent writer
  // (backup script, ops query, a second process) got an immediate SQLITE_BUSY
  // instead of waiting. 5s eliminates the class (OPEN.md P2, closed 2026-07-31).
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA cache_size = -8000");  // 8MB cache (default is 2MB)
  // Audit fix (P2, 2026-05-07): bun:sqlite defaults foreign_keys=OFF, so
  // declared FK constraints (e.g. broker_accounts.profile_id REFERENCES
  // profiles.id at line 586) were advisory only. Enabling enforcement
  // means future writers cannot insert orphan rows. Existing data is
  // already clean (PRAGMA foreign_key_check = 0 violations on audit).
  db.exec("PRAGMA foreign_keys = ON");

  createTables();
  migrateColumns();
  pruneOldData();
  createIndexes();
  log.info(`Database initialized at ${path}`);
  return db;
}

/**
 * Downsample equity_snapshots so the table stays bounded while the since-start
 * equity curve is preserved. Snapshots are written ~every 60s per profile
 * (≈9k rows/day across 6 profiles), so the previous "delete only older than
 * 5 years" retention never fired — observed at 542k rows / 80 days on the live
 * host, the single biggest contributor to DB size (and to every equity-P&L
 * scan). Policy:
 *   • keep FULL resolution for the last `fullResDays` days (intraday detail for
 *     the Today / 7D views), and
 *   • keep ONE snapshot per (profile, hour) for everything older — ample for the
 *     7D/30D/all-range curves, and the since-start baseline survives because it
 *     is always the earliest row of its hour bucket.
 *   • ALSO always keep the first and last row of every chronological semantics
 *     RUN (per profile), regardless of hour bucket. The display rebase policy
 *     (getDisplayEquitySeries) computes its offsets from exactly those two
 *     rows at each era boundary — pruning either one would silently change a
 *     already-computed rebase gap/offset the next time it's read.
 * Bounds growth to ~24×profiles rows/day beyond the full-res window. Idempotent.
 */
export function pruneEquitySnapshots(fullResDays = 2): number {
  const cutoff = Date.now() - fullResDays * 24 * 60 * 60_000;
  // Single-pass window function: within each (profile, hour) bucket of rows
  // older than the cutoff, keep the earliest (rn=1, the since-start baseline of
  // that hour) and delete the rest — UNLESS the row is the first or last of its
  // chronological (profile, semantics) run (is_first/is_last, via LAG/LEAD over
  // the profile's full unfiltered timeline so a boundary is never missed just
  // because its neighbor sits on the other side of the cutoff). Rows newer than
  // the cutoff are untouched (full resolution). O(n log n) — fast even on the
  // 542k-row live table; the earlier correlated-EXISTS variant was O(n²) and
  // stalled.
  const res = db.prepare(`
    DELETE FROM equity_snapshots
     WHERE id IN (
       SELECT id FROM (
         SELECT id, snapshot_time,
                ROW_NUMBER() OVER (
                  PARTITION BY profile_id, snapshot_time / 3600000
                  ORDER BY snapshot_time ASC, id ASC
                ) AS rn,
                (semantics IS NOT LAG(semantics) OVER (
                  PARTITION BY profile_id ORDER BY snapshot_time ASC, id ASC
                )) AS is_first,
                (semantics IS NOT LEAD(semantics) OVER (
                  PARTITION BY profile_id ORDER BY snapshot_time ASC, id ASC
                )) AS is_last
           FROM equity_snapshots
       )
       WHERE snapshot_time < ? AND rn > 1 AND is_first = 0 AND is_last = 0
     )
  `).run(cutoff);
  return Number(res.changes);
}

// Exported so the runtime can re-run it on a timer (not only at startup) —
// otherwise a long uptime between deploys lets full-resolution equity_snapshots
// accumulate unbounded until the next restart.
export function pruneOldData() {
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60_000;
  // Audit fix (2026-05-04): bump activity_log retention from 3d to 30d. The
  // dashboard activity card was permanently near-empty because the bot only
  // emits ~10-30 events/day in steady state and the prune was eating older ones.
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60_000;
  try {
    // equity_snapshots: downsample (full-res 2d, 1/hour beyond) — the old
    // "delete > 5y" never fired and let the table grow to 542k rows / 80d.
    const eq = { changes: pruneEquitySnapshots() };
    const sg = db.prepare(`DELETE FROM signals WHERE timestamp < ?`).run(threeDaysAgo);
    const al = db.prepare(`DELETE FROM activity_log WHERE created_at < ?`).run(thirtyDaysAgo);
    const total = eq.changes + sg.changes + al.changes;
    if (total > 0) {
      log.info(`DB cleanup: pruned ${total} rows (equity=${eq.changes} signals=${sg.changes} activity=${al.changes})`);
      try { db.exec("PRAGMA incremental_vacuum(100)"); } catch {}
    }
  } catch (e: any) { log.debug(`Prune error: ${e.message}`); }
}

function createIndexes() {
  // Audit fix (2026-05-06): convert idx_daily_reports_profile from
  // non-unique to UNIQUE so saveDailyReport's ON CONFLICT(profile_id,
  // report_date) upsert works. Drop the non-unique one if it exists, then
  // create the unique version. Both DDL statements are idempotent.
  // Pre-existing duplicates (none observed at migration time) would block
  // the unique index creation; if that happens we keep the non-unique one
  // and saveDailyReport falls through to a manual deduplication path.
  try {
    db.exec(`DROP INDEX IF EXISTS idx_daily_reports_profile`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reports_profile_unique
             ON daily_reports(profile_id, report_date)`);
  } catch (e: any) {
    log.warn(`Could not create unique index on daily_reports — duplicates may exist: ${e.message}`);
    // Fallback: keep the non-unique index so queries stay fast.
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_reports_profile ON daily_reports(profile_id, report_date)`); } catch {}
  }

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_trades_account_status ON trades(account_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`,
    `CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time)`,
    // Audit fix (2026-05-06): exit_time index for daily-report range scans.
    `CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades(exit_time) WHERE exit_time IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_equity_snapshots_time ON equity_snapshots(snapshot_time)`,
    `CREATE INDEX IF NOT EXISTS idx_equity_snapshots_profile ON equity_snapshots(profile_id, snapshot_time)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(timestamp)`,
    // ── Wave 1 (2026-05-07): fills indexes
    `CREATE INDEX IF NOT EXISTS idx_fills_time ON fills(fill_time)`,
    `CREATE INDEX IF NOT EXISTS idx_fills_account_time ON fills(account_id, fill_time)`,
  ];
  for (const sql of indexes) {
    try { db.exec(sql); } catch {}
  }
}

// ── Safe ALTER helper ───────────────────────
// "Safe" = idempotent, NOT infallible: only the expected "duplicate column"
// error (re-running a migration that already landed) is swallowed. Anything
// else — locked DB, corrupt file, missing table — rethrows and aborts boot;
// the old catch-all let the bot run on a half-migrated schema and fail later
// at some arbitrary query instead (OPEN.md P3-6, 2026-08-29). Exported for
// safeAddColumn.test.ts only.
export function safeAddColumn(table: string, column: string, type: string, dflt: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} DEFAULT ${dflt}`);
    log.info(`Added column ${table}.${column}`);
  } catch (e: any) {
    if (!String(e?.message ?? e).includes("duplicate column")) throw e;
  }
}

function migrateColumns() {
  // Task 2: add account_id to all relevant tables.
  // account_id is NOT NULL across trades/orders/signals: every live writer
  // binds the sleeve id explicitly (insertTrade requires it; BrokerSync
  // passes *_main). The 'unassigned' sentinel is only SQLite's mandatory
  // ADD-COLUMN default and never materialises — the old 'medium' default was
  // a dead pre-v8 profile id that would silently mis-attribute a row to a
  // nonexistent sleeve.
  safeAddColumn("trades", "account_id", "TEXT NOT NULL", "'unassigned'");
  safeAddColumn("orders", "account_id", "TEXT NOT NULL", "'unassigned'");
  safeAddColumn("signals", "account_id", "TEXT NOT NULL", "'unassigned'");

  // Audit fix: commission tracking on trades
  safeAddColumn("trades", "open_commission", "REAL", "0");
  safeAddColumn("trades", "close_commission", "REAL", "0");

  // Audit fix: order_id link on trades
  safeAddColumn("trades", "order_id", "TEXT", "NULL");

  // 2026-08-03: pre-trade estimated VWAP fill price (bookDepth.ts) recorded
  // NEXT TO the realized fill, so the estimator's quality is measurable
  // (est_px vs expected_px = predicted impact; filled_px vs expected_px =
  // realized). Nullable — estimates are best-effort telemetry.
  safeAddColumn("fills", "est_px", "REAL", "NULL");

  // Wave 3c (2026-05-07): typed order state machine.
  // - state: SUBMITTING | OPEN | PARTIAL | FILLED | CANCELED | REJECTED | FAILED | EXPIRED
  // - cum_qty / avg_px: rolling fill totals (populated by WS in 3d, REST in 3c).
  // - last_state_change: epoch ms of last transition for audit trail.
  safeAddColumn("orders", "state", "TEXT", "'unknown'");
  safeAddColumn("orders", "cum_qty", "REAL", "0");
  safeAddColumn("orders", "avg_px", "REAL", "0");
  safeAddColumn("orders", "last_state_change", "INTEGER", "NULL");

  // Task 6 (v1.4): SL/TP stored per trade
  safeAddColumn("trades", "stop_loss", "REAL", "NULL");
  safeAddColumn("trades", "take_profit", "REAL", "NULL");
  safeAddColumn("trades", "close_reason", "TEXT", "NULL");
  // Exact margin (cash) deducted from the per-profile ledger at open, so the
  // close path credits back the SAME amount instead of a notional/base-leverage
  // estimate (the latter leaked cash whenever a regime override reduced
  // leverage below base — see EquityTracker cash-drift fix).
  safeAddColumn("trades", "margin_used", "REAL", "NULL");

  // Cleanup orphan orders (one-time, safe to re-run)
  try {
    const deleted = db.prepare(`DELETE FROM orders WHERE created_at < ? AND id NOT IN (SELECT DISTINCT order_id FROM trades WHERE order_id IS NOT NULL)`).run(Date.now() - 7 * 24 * 60 * 60_000);
    if (deleted.changes > 0) log.info(`Cleaned up ${deleted.changes} orphan orders older than 7d`);
  } catch {}

  // v2.0: Seed default profile and broker_accounts
  try {
    db.prepare(`INSERT OR IGNORE INTO profiles (id, name, avatar) VALUES ('default', 'Bot Owner', '🤖')`).run();
    db.prepare(`INSERT OR IGNORE INTO broker_accounts (id, profile_id, broker_id, display_name, api_key_ref, strategy_config)
      VALUES ('alpaca_default', 'default', 'alpaca_paper', 'Alpaca Paper', 'ALPACA',
        '{"riskLevel":"medium","maxPositions":10,"leverage":2,"minScore":50,"stopLossPct":2.0,"takeProfitPct":4.0,"maxPositionSizePct":5,"maxDailyDrawdownPct":6,"cooldownMinutes":15,"allowedStrategies":["RSI","MACD","SMA_CROSSOVER","BOLLINGER","VWAP"]}')`).run();
    db.prepare(`INSERT OR IGNORE INTO broker_accounts (id, profile_id, broker_id, display_name, api_key_ref, strategy_config)
      VALUES ('binance_default', 'default', 'binance_testnet', 'Binance Futures', 'BINANCE',
        '{"riskLevel":"high","maxPositions":8,"leverage":5,"minScore":40,"stopLossPct":1.5,"takeProfitPct":3.0,"maxPositionSizePct":8,"maxDailyDrawdownPct":6,"cooldownMinutes":10,"allowedStrategies":["RSI","MACD","BOLLINGER","VWAP"],"allowedSymbols":["BTC/USD","ETH/USD","SOL/USD","ADA/USD","AVAX/USD"]}')`).run();
  } catch {}

  // v2.0: Add profile_id to trades, activity_log, equity_snapshots (for cross-profile queries)
  safeAddColumn("trades", "profile_id", "TEXT", "'default'");
  safeAddColumn("activity_log", "profile_id", "TEXT", "NULL");

  // v2.1: Consolidate 4 fragmented accounts → 2 real broker accounts
  // Insert consolidated broker_accounts rows
  try {
    db.prepare(`INSERT OR IGNORE INTO broker_accounts (id, profile_id, broker_id, display_name, api_key_ref, strategy_config)
      VALUES ('alpaca_main', 'default', 'alpaca_paper', 'Alpaca Paper', 'ALPACA',
        '{"strategies":[{"name":"conservative","leverage":2,"minScore":60,"maxPositions":5,"stopLossPct":1.0,"takeProfitPct":2.5},{"name":"aggressive","leverage":2,"minScore":45,"maxPositions":5,"stopLossPct":1.5,"takeProfitPct":4.0}]}')`).run();
    db.prepare(`INSERT OR IGNORE INTO broker_accounts (id, profile_id, broker_id, display_name, api_key_ref, strategy_config)
      VALUES ('binance_main', 'default', 'binance_testnet', 'Binance Futures', 'BINANCE',
        '{"strategies":[{"name":"conservative","leverage":3,"minScore":50,"maxPositions":4,"stopLossPct":1.5,"takeProfitPct":3.5},{"name":"aggressive","leverage":5,"minScore":40,"maxPositions":4,"stopLossPct":1.5,"takeProfitPct":3.0}]}')`).run();
  } catch {}

  // 2026-07-07 P1: the legacy "restore *_main → *_low" migration is REMOVED.
  // Its original purpose (undoing a bad v2 backfill) was served months ago;
  // today the only rows created under *_main are BrokerSync's phantom-position
  // rows — BY DESIGN, so they stay outside the per-profile ledgers. Re-running
  // the migration on every boot ADOPTED those rows into binance_low, where
  // AccountManager's sync-close then credited margin the profile never paid
  // (+$640 on 2026-07-06 via 2 phantom ATOMUSDT closes).

  // Deactivate old fragmented broker_accounts (keep rows, just mark inactive)
  try {
    db.prepare(`UPDATE broker_accounts SET is_active = 0 WHERE id IN ('alpaca_default', 'binance_default')`).run();
  } catch {}

  // v3.0 (crypto remediation): strategy_version column for data hygiene
  safeAddColumn("signals", "strategy_version", "TEXT", "'legacy'");
  safeAddColumn("trades", "strategy_version", "TEXT", "'legacy'");
  safeAddColumn("orders", "strategy_version", "TEXT", "'legacy'");

  // Phase 5E (2026-05-20): daily_reports.telegram_sent — observability for
  // the 23:59 ET digest. The reporter previously wrapped sendTelegramDigest()
  // in `try/catch {}` (swallows fetch errors silently), so there was no
  // record of whether the operator actually received the summary. The
  // column flips to 1 only after the await resolves; on throw it stays at
  // its default 0. Lets the dashboard surface "last report sent ✓" and
  // makes silent Telegram outages auditable.
  safeAddColumn("daily_reports", "telegram_sent", "INTEGER", "0");

  // Mark existing BROKER_SYNC / SYNC_RECOVERY rows as ops_sync
  try {
    db.prepare(`UPDATE trades SET strategy_version = 'ops_sync' WHERE strategy IN ('BROKER_SYNC', 'SYNC_RECOVERY') AND strategy_version = 'legacy'`).run();
  } catch {}

  // v8.1 (2026-07-13): snapshot SEMANTIC VERSIONING — see EQUITY_SEMANTICS.
  // One-time backfill: every pre-column row gets the LITERAL era in effect
  // when the column was born (2 = per-sleeve-ledger/~10k Binance all-assets era).
  // Deliberately a hardcoded 2, NOT the constant: when the constant bumps to 3,
  // a restored pre-column backup must land at 2 and stay invisible to v3 anchors.
  safeAddColumn("equity_snapshots", "semantics", "INTEGER", "NULL");
  try {
    const bf = db.prepare(`UPDATE equity_snapshots SET semantics = 2 WHERE semantics IS NULL`).run();
    if (bf.changes > 0) log.info(`Backfilled semantics=2 on ${bf.changes} equity_snapshots rows`);
  } catch {}

  // Repository hardening (durable equity-history): the one-time backfill above
  // is the LAST NULL semantics anyone gets. Every INSERT after it goes through
  // saveEquitySnapshot (which always stamps a version) or gets rejected here —
  // a raw INSERT that dodges the writer can no longer resurrect the poisoned-
  // anchor bug class by silently landing an unstamped row.
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_equity_snapshots_semantics_not_null
      BEFORE INSERT ON equity_snapshots
      WHEN NEW.semantics IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'equity_snapshots.semantics must not be NULL — write via saveEquitySnapshot()');
      END;
    `);
  } catch (e: any) { log.warn(`Could not install equity_snapshots semantics trigger: ${e.message}`); }

  // Prune-independent equity-semantics transition metadata (2026-07-19): seed
  // every KNOWN historical (profile, from-era, to-era) declaration — kind
  // classification for all of them, plus the EXACT recovered offset for the
  // 3 real rebases — into equity_semantics_transitions. Idempotent (INSERT OR
  // IGNORE, keyed by the primary key): safe to re-run on every boot, on a
  // fresh :memory: test DB, and on an existing production DB where the table
  // was just created by the CREATE TABLE IF NOT EXISTS above. See
  // seedKnownEquitySemanticsTransitions() below for the full list + forensic
  // provenance of the 3 recovered offsets.
  try { seedKnownEquitySemanticsTransitions(); } catch (e: any) { log.warn(`Could not seed equity_semantics_transitions: ${e.message}`); }

  // COIN-M partial-close ledger (2026-07-19): BinanceCoinMMomentumAdapter can
  // close a position across MULTIPLE reduceOnly orders (broker only reduces
  // 10->4, then 4->0 on a later pass). Each stage's broker-reported
  // realizedPnl/commission (native asset, e.g. BTC) and actually-closed
  // contract count must accumulate atomically across stages so the FINAL
  // close converts the true SUM to USD exactly once — never just the last
  // stage's numbers (which would silently drop every earlier stage's PnL).
  safeAddColumn("trades", "partial_realized_native", "REAL", "0");
  safeAddColumn("trades", "partial_commission_native", "REAL", "0");
  safeAddColumn("trades", "partial_commission_asset", "TEXT", "NULL");
  safeAddColumn("trades", "partial_closed_contracts", "REAL", "0");

  // 2026-07-28: synthetic-snapshot quarantine. `synthetic = 1` marks rows
  // that are NOT real equity observations (fabricated backfills, confirmed
  // bad broker reads). They are kept — deleting history breaks "All" ranges
  // and reversibility — but EVERY P&L/anchor/series read excludes them
  // (`AND synthetic = 0`, see getDisplayEquitySeries and friends below).
  // Fingerprint-based one-time marking (never id-based: prod and this clone
  // carry different rowids for the same history); idempotent and a no-op on
  // a DB that doesn't have the rows.
  safeAddColumn("equity_snapshots", "synthetic", "INTEGER NOT NULL", "0");
  try {
    // (a) The 2026-04-05 → 2026-05-10 linear-interpolation backfill: exactly
    // 24 rows/day for 35 days on BOTH *_main series, every row with
    // cash = $0.01 and open_positions = 0, equity rising EXACTLY $36.80/day
    // (alpaca_main). An equity with one cent of cash and no positions cannot
    // produce P&L — it is fabricated (AGENTS.md 2026-07-27: "April never
    // existed as P&L"). Measured bounds on the live DB (2026-07-28):
    // 2026-04-05T00:35:28Z … 2026-05-10T23:05:28Z, 864 rows per series;
    // no cash=0.01 row exists outside this window or on any other profile.
    const backfill = db.prepare(`
      UPDATE equity_snapshots SET synthetic = 1
       WHERE synthetic = 0 AND profile_id IN ('alpaca_main','binance_main')
         AND cash = 0.01 AND open_positions = 0
         AND snapshot_time BETWEEN ? AND ?
    `).run(Date.parse("2026-04-05T00:00:00Z"), Date.parse("2026-05-11T00:00:00Z"));
    // (b) binance_main 2026-06-19 10:00Z: −6.1% ($10,288.63 → $9,663.10, cash
    // dropping by the same ~$618) for exactly one hourly snapshot with
    // open_positions = 0, exact round-trip by 11:00. That is a partial asset
    // valuation (one asset dropped/priced 0 by the pre-2026-07-18 valuation
    // path), not a movement — the current getAccountTotal already fails
    // CLOSED (returns null, snapshot skipped) on that exact failure mode.
    const badRead = db.prepare(`
      UPDATE equity_snapshots SET synthetic = 1
       WHERE synthetic = 0 AND profile_id = 'binance_main'
         AND snapshot_time BETWEEN ? AND ? AND equity < 10000
    `).run(Date.parse("2026-06-19T09:30:00Z"), Date.parse("2026-06-19T10:30:00Z"));
    // (c) The 2026-08-18 Binance testnet backend outage (01:10–03:55 UTC,
    // /fapi/v2/account 408 storms): between outage waves the backend served a
    // CORRUPT ledger — root totals read as a fresh $5,000 account while
    // assets[] entries summed to ≈ −$1.33e12 — and getAccountTotal faithfully
    // priced it (every field finite, every asset priceable, root cross-check
    // self-consistent), landing 20 binance_main rows with equity ≈
    // −1,330,000,000,000 as synthetic=0. No wallet we track can owe money:
    // a negative equity row is a bad broker read by definition. Same
    // quarantine-not-delete rationale as (a)/(b); the WRITE path now rejects
    // this class outright (see the plausibility guard in saveEquitySnapshot).
    // scripts/quarantine-binance-equity-20260818.ts is the operator-run
    // (dry-run/--apply) twin of this fingerprint for out-of-band remediation.
    const badTotal = db.prepare(`
      UPDATE equity_snapshots SET synthetic = 1
       WHERE synthetic = 0 AND profile_id = 'binance_main'
         AND equity < 0 AND snapshot_time BETWEEN ? AND ?
    `).run(Date.parse("2026-08-18T01:00:00Z"), Date.parse("2026-08-18T04:00:00Z"));
    // (d) The same 2026-08-18 outage on the two Binance SLEEVE series — (c)
    // only caught binance_main's negative rows. In the same waves the sleeve
    // wallets read as the corrupt "fresh account": momentum_crypto $5,000.00,
    // $5,000.00, $10,004.38 and momentum_crypto_usdc $0 (with a LINK position
    // open), $0, $5,000.00 — against real equities of ~$4.35k and ~$4.70k on
    // both sides of the window (momentum_crypto_usdc's trades reconcile to
    // its snapshots within ~$25 before and after: no cash moved). Those six
    // rows were the entire "all-time max drawdown" of both sleeves (100% and
    // 56.5%). Window = the outage bounds documented in (c).
    const badSleeve = db.prepare(`
      UPDATE equity_snapshots SET synthetic = 1
       WHERE synthetic = 0 AND profile_id IN ('momentum_crypto','momentum_crypto_usdc')
         AND snapshot_time BETWEEN ? AND ?
    `).run(Date.parse("2026-08-18T01:10:00Z"), Date.parse("2026-08-18T03:55:00Z"));
    const marked = Number(backfill.changes) + Number(badRead.changes) + Number(badTotal.changes) + Number(badSleeve.changes);
    if (marked > 0) log.info(`Marked ${marked} equity_snapshots rows synthetic=1 (backfill=${backfill.changes}, bad-read=${badRead.changes}, bad-total=${badTotal.changes}, bad-sleeve=${badSleeve.changes})`);
  } catch (e: any) { log.warn(`Could not mark synthetic equity_snapshots: ${e.message}`); }
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      strategy TEXT NOT NULL,
      strength TEXT NOT NULL,
      price REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      indicators TEXT,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      stop_loss REAL,
      take_profit REAL,
      status TEXT NOT NULL,
      external_id TEXT,
      signal_id TEXT,
      filled_at INTEGER,
      filled_price REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      strategy TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL,
      quantity REAL NOT NULL,
      pnl REAL,
      pnl_pct REAL,
      entry_time INTEGER NOT NULL,
      exit_time INTEGER,
      status TEXT NOT NULL DEFAULT 'open'
    );

    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
    CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL DEFAULT 'paper',
      equity REAL NOT NULL,
      cash REAL NOT NULL,
      open_positions INTEGER DEFAULT 0,
      snapshot_time INTEGER NOT NULL
    );

    -- Persisted equity-semantics transition metadata (2026-07-19 prune-
    -- independence hardening — see the SNAPSHOT SEMANTIC VERSIONING doc
    -- below). One row per (profile, from-era, to-era): its kind and, for a
    -- "rebase", its EXACT equity_offset — computed ONCE, either from a
    -- forensic backup recovery or atomically at the first live write of the
    -- new era — and read thereafter regardless of whether the original
    -- boundary rows still exist in equity_snapshots (prune, or any other
    -- deletion, can no longer silently corrupt an already-published rebase).
    CREATE TABLE IF NOT EXISTS equity_semantics_transitions (
      profile_id TEXT NOT NULL,
      from_semantics INTEGER NOT NULL,
      to_semantics INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('continuous','rebase','break')),
      equity_offset REAL,
      boundary_old_time INTEGER,
      boundary_old_equity REAL,
      boundary_new_time INTEGER,
      boundary_new_equity REAL,
      source TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, from_semantics, to_semantics)
    );

    CREATE INDEX IF NOT EXISTS idx_equity_snap_profile ON equity_snapshots(profile_id, snapshot_time);

    -- ═══ Task 1+2: Persistent accounts ═══
    -- equity/cash columns DEPRECATED since v8 — truth lives in equity_snapshots
    -- (latest *_main row per broker, latest sleeve row per sleeve; see
    -- src/portfolio/truth.ts); do not add readers. The only remaining legit
    -- read is EquityTracker's own restore of the sleeve ledger it persists
    -- (loadAccount/saveAccount write-read pair). A regression test scans src/
    -- for new accounts-table equity reads (src/portfolio/no-stale-account-reads.test.ts).
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      equity REAL NOT NULL DEFAULT 100000,
      cash REAL NOT NULL DEFAULT 100000,
      initial_equity REAL NOT NULL DEFAULT 100000,
      total_realized_pnl REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    -- ═══ Activity log ═══
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(event_type);

    -- ═══ v2.0: Profiles + Broker Accounts ═══
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS broker_accounts (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      broker_id TEXT NOT NULL,
      display_name TEXT,
      api_key_ref TEXT,
      strategy_config TEXT,
      is_active BOOLEAN DEFAULT 1,
      FOREIGN KEY (profile_id) REFERENCES profiles(id)
    );
    CREATE INDEX IF NOT EXISTS idx_broker_accounts_profile ON broker_accounts(profile_id);

    -- ═══ v2.0: Daily Reports ═══
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT,
      report_date DATE,
      starting_equity REAL,
      ending_equity REAL,
      realized_pnl REAL,
      unrealized_pnl REAL,
      total_trades INTEGER,
      winning_trades INTEGER,
      win_rate REAL,
      best_trade_symbol TEXT,
      best_trade_pnl REAL,
      worst_trade_symbol TEXT,
      worst_trade_pnl REAL,
      most_active_strategy TEXT,
      generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_daily_reports_profile ON daily_reports(profile_id, report_date);

    -- ═══ v2.1: Broker asset balances (per-asset breakdown) ═══
    CREATE TABLE IF NOT EXISTS broker_asset_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broker_account_id TEXT NOT NULL,
      asset TEXT NOT NULL,
      balance REAL NOT NULL,
      available_balance REAL NOT NULL,
      usd_value REAL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_broker_asset_unique ON broker_asset_balances(broker_account_id, asset);

    -- ═══ 2026-07-25: tiny persisted-state kv, born from BrokerSync's
    -- in-memory drift fingerprint resetting (and re-paging) on every restart ═══
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ═══ Wave 1 (2026-05-07): Slippage / fill telemetry ═══
    CREATE TABLE IF NOT EXISTS fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      market TEXT NOT NULL,
      expected_px REAL NOT NULL,
      submitted_px REAL NOT NULL,
      filled_px REAL NOT NULL,
      filled_qty REAL NOT NULL,
      slippage_bps REAL NOT NULL,
      fill_time INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      broker TEXT NOT NULL,
      est_px REAL
    );

    -- ═══ 2026-08-03: Corporate-actions audit + idempotency ledger ═══
    -- One row per detected (symbol, type, ex_date) touching a held Alpaca
    -- stock. detected_at is the audit trail ("what did we know and when");
    -- applied_at marks that the one-shot reconciliation (split ratio applied
    -- to open rows / occurred-alert emitted) already ran — re-detection on a
    -- later daily check MUST be a no-op (a split ratio applied twice would
    -- corrupt the row's basis). payload keeps the raw broker event.
    CREATE TABLE IF NOT EXISTS corporate_actions (
      symbol TEXT NOT NULL,
      ca_type TEXT NOT NULL,
      ex_date TEXT NOT NULL,
      ratio REAL,
      payload TEXT,
      detected_at INTEGER NOT NULL,
      applied_at INTEGER,
      PRIMARY KEY (symbol, ca_type, ex_date)
    );
  `);
}

// ── Signal Operations ───────────────────────

export function insertSignal(signal: Signal, accountId = "shared") {
  db.prepare(`
    INSERT INTO signals (id, symbol, market, side, strategy, strength, price, timestamp, indicators, reason, account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.id, signal.symbol, signal.market, signal.side,
    signal.strategy, signal.strength, signal.price, signal.timestamp,
    JSON.stringify(signal.indicators), signal.reason, accountId,
  );
}

export function getRecentSignals(limit = 50, accountId?: string): Signal[] {
  let rows: any[];
  if (accountId) {
    rows = db.prepare(`SELECT * FROM signals WHERE account_id = ? ORDER BY timestamp DESC LIMIT ?`).all(accountId, limit) as any[];
  } else {
    // Same v8-sleeves-only default scope as getRecentTrades/getTradingStats —
    // the consolidated dashboard view calls this with no accountId.
    rows = db.prepare(`SELECT * FROM signals WHERE account_id IN ${V8_ACCOUNTS_SQL} ORDER BY timestamp DESC LIMIT ?`).all(limit) as any[];
  }
  return rows.map(r => ({
    ...r,
    indicators: JSON.parse(r.indicators || "{}"),
  }));
}

// ── Order Operations ────────────────────────

export function insertOrder(order: Order, accountId: string) {
  // Wave 3c (2026-05-07): also seed the typed state machine columns.
  const initialState = order.status === "filled" ? "FILLED"
    : order.status === "rejected" ? "REJECTED"
    : order.status === "cancelled" ? "CANCELED"
    : order.status === "partial" ? "PARTIAL"
    : "SUBMITTING";
  const now = Date.now();
  db.prepare(`
    INSERT INTO orders (id, symbol, market, side, type, quantity, price, stop_loss, take_profit, status, external_id, signal_id, filled_at, filled_price, created_at, updated_at, account_id, state, cum_qty, avg_px, last_state_change)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.id, order.symbol, order.market, order.side, order.type,
    order.quantity, order.price, order.stopLoss ?? null, order.takeProfit ?? null,
    order.status, order.externalId ?? null, order.signal?.id ?? null,
    order.filledAt ?? null, order.filledPrice ?? null, order.createdAt, order.updatedAt,
    accountId,
    initialState,
    initialState === "FILLED" ? order.quantity : 0,
    initialState === "FILLED" ? (order.filledPrice ?? order.price) : 0,
    now,
  );
}

/**
 * Wave 3c: persist a typed state transition. Updates state +
 * cum_qty/avg_px when present + last_state_change. Idempotent — same
 * (id, state) overwrites with the same data.
 */
export function updateOrderStateFields(
  id: string,
  state: string,
  cumQty?: number,
  avgPx?: number,
): void {
  const now = Date.now();
  if (cumQty !== undefined && avgPx !== undefined) {
    db.prepare(
      `UPDATE orders SET state = ?, cum_qty = ?, avg_px = ?, last_state_change = ?, updated_at = ? WHERE id = ?`
    ).run(state, cumQty, avgPx, now, now, id);
  } else {
    db.prepare(
      `UPDATE orders SET state = ?, last_state_change = ?, updated_at = ? WHERE id = ?`
    ).run(state, now, now, id);
  }
}

// ── Trade Operations ────────────────────────

// accountId is REQUIRED (was `= "medium"` — a stale pre-v8 default that
// silently mislabeled rows; every caller passes the sleeve id explicitly).
export function insertTrade(trade: TradeRecord, accountId: string) {
  // Audit fix (P1, 2026-05-07): trades.profile_id used to fall through to
  // its column default 'default' on every insert (323/323 rows pre-fix),
  // breaking any per-profile JOIN against trades. accountId is already the
  // risk-profile id (alpaca_low/_high/binance_low/_high) so we reuse it.
  db.prepare(`
    INSERT INTO trades (id, symbol, market, side, strategy, entry_price, exit_price, quantity, pnl, pnl_pct, entry_time, exit_time, status, account_id, order_id, open_commission, stop_loss, take_profit, profile_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.id, trade.symbol, trade.market, trade.side, trade.strategy,
    trade.entryPrice, trade.exitPrice ?? null, trade.quantity, trade.pnl ?? null,
    trade.pnlPct ?? null, trade.entryTime, trade.exitTime ?? null, trade.status,
    accountId, (trade as any).orderId ?? null, (trade as any).openCommission ?? 0,
    (trade as any).stopLoss ?? null, (trade as any).takeProfit ?? null,
    accountId,
  );
}

// BrokerSync only ever auto-closes rows whose id starts with "sync_" (or the
// legacy strategy tag "BROKER_SYNC"). SYNC_RECOVERY rows are UUID-id rows
// AccountManager itself inserts when adopting a broker position — they are
// bot-managed, NOT BrokerSync-owned, and must stay eligible for reconciliation
// there or they become permanent phantom open rows.
// THE one definition (2026-07-26): AccountManager's reconcilers skip
// sync-owned rows and BrokerSync auto-closes them — if the two sides used
// different predicates (they did: BrokerSync matched only the sync_ id
// prefix), a UUID row tagged strategy='BROKER_SYNC' was skipped by BOTH and
// stayed open forever. Do NOT widen this to include SYNC_RECOVERY: BrokerSync
// only auto-closes sync_ ids, so that widening creates permanent phantoms
// (Sol review, 2026-07-25 round 1).
export function isSyncOwned(t: { id: string; strategy?: string | null }): boolean {
  return t.id.startsWith("sync_") || t.strategy === "BROKER_SYNC";
}

/**
 * THE canonical price-diff PnL formula. It was hand-copied at 9 call sites
 * (close paths, sync reconcilers, display/state updates, the sleeve ledger)
 * and the entry_price=0 / quantity=0 → ±Infinity guard had been added to only
 * ONE of them (closeTrade) — the #1 recurring defect class in this repo.
 *
 * - `pnl` / `pnlPct` are ALWAYS finite: a non-finite input yields 0, and the
 *   pct divisor (entry×qty) must be > 0.
 * - `raw` is the unguarded formula result (may be NaN/Infinity) — for the ONE
 *   caller (closeTrade) whose semantics require DETECTING non-finiteness to
 *   force close_reason=MANUAL_CLOSE_UNRECONCILED rather than coercing to 0.
 *   Everyone else uses pnl/pnlPct.
 */
export function pnlOf(side: string, entryPrice: number, exitPrice: number, quantity: number): { pnl: number; pnlPct: number; raw: number } {
  const raw = side === "buy"
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
  const pnl = Number.isFinite(raw) ? raw : 0;
  const denom = entryPrice * quantity;
  const pnlPct = Number.isFinite(raw) && denom > 0 ? (raw / denom) * 100 : 0;
  return { pnl, pnlPct, raw };
}

export function closeTrade(id: string, exitPrice: number, exitTime: number, closeCommission = 0, overridePnl?: number) {
  // Atomic close via transaction — prevents race condition when two
  // processes (SL/TP checker + signal scanner) try to close the same trade.
  const txn = db.transaction(() => {
    const trade = db.prepare(`SELECT * FROM trades WHERE id = ? AND status = 'open'`).get(id) as any;
    if (!trade) return null; // already closed by another process

    // Use broker PnL if provided (from Binance realizedPnl - commissions), otherwise calculate.
    // `raw` on purpose: the non-finite detection below drives the forced
    // MANUAL_CLOSE_UNRECONCILED close reason — the guarded value would hide it.
    const rawPnl = pnlOf(trade.side, trade.entry_price, exitPrice, trade.quantity).raw;
    // P1: a non-finite overridePnl (NaN/Infinity from a bad broker calc)
    // must never reach the row. Prefer falling back to the finite
    // price-derived rawPnl over fabricating a zero (a fabricated zero would
    // be a real trade masquerading as a genuine breakeven strategy outcome
    // in RECONCILE_CLOSE_SQL-scoped stats). Only when BOTH are non-finite do
    // we store 0, and in that case the close reason is forced to
    // MANUAL_CLOSE_UNRECONCILED so RECONCILE_CLOSE_SQL excludes the row.
    let pnl = overridePnl !== undefined ? overridePnl : rawPnl;
    let closeReasonOverride: string | null = null;
    if (!Number.isFinite(pnl)) {
      if (Number.isFinite(rawPnl)) {
        log.error(`closeTrade: non-finite overridePnl (${overridePnl}) for trade ${id} — discarding it, using price-derived pnl ${rawPnl} instead`);
        pnl = rawPnl;
      } else {
        log.error(`closeTrade: non-finite overridePnl (${overridePnl}) and non-finite price-derived pnl for trade ${id} — storing pnl=0, close_reason=MANUAL_CLOSE_UNRECONCILED`);
        pnl = 0;
        closeReasonOverride = "MANUAL_CLOSE_UNRECONCILED";
      }
    }
    // Guard quantity too: entry_price*quantity can be 0 (or entry_price can
    // be unset) which previously produced pnl/0 = ±Infinity.
    const denom = trade.entry_price * trade.quantity;
    const pnlPct = denom > 0 && Number.isFinite(pnl) ? (pnl / denom) * 100 : 0;

    db.prepare(`UPDATE trades SET exit_price = ?, exit_time = ?, pnl = ?, pnl_pct = ?, status = 'closed', close_commission = ?, close_reason = COALESCE(?, close_reason) WHERE id = ? AND status = 'open'`)
      .run(exitPrice, exitTime, pnl, pnlPct, closeCommission, closeReasonOverride, id);

    return {
      ...trade, exitPrice, exitTime, pnl, pnlPct, closeCommission, status: "closed",
      closeReason: closeReasonOverride ?? trade.close_reason ?? null,
    };
  });

  return txn();
}

/**
 * Canonical close for products whose pnl_pct is NOT `pnl / (entry*qty)`
 * (inverse contracts, e.g. BTCUSD_PERP COIN-M — see
 * BinanceCoinMMomentumAdapter). closeTrade() always derives pnl_pct from the
 * LINEAR formula even when overridePnl is given, which is wrong for inverse
 * sizing (quantity = contract count, not base units). This helper takes BOTH
 * pnl AND pnl_pct explicitly from the caller and writes them — plus an
 * optional close_reason — atomically in one transaction, replacing a raw
 * `UPDATE trades` seam with a shared, tested writer.
 */
export function closeTradeExplicit(id: string, exitPrice: number, exitTime: number, pnl: number, pnlPct: number, closeReason?: string) {
  const txn = db.transaction(() => {
    const trade = db.prepare(`SELECT * FROM trades WHERE id = ? AND status = 'open'`).get(id) as any;
    if (!trade) return null; // already closed by another process

    let effectivePnl = pnl;
    let effectivePnlPct = pnlPct;
    let closeReasonOverride: string | null = null;
    if (!Number.isFinite(pnl) || !Number.isFinite(pnlPct)) {
      log.error(`closeTradeExplicit: non-finite pnl/pnlPct (${pnl}/${pnlPct}) for trade ${id} — storing pnl=0, close_reason=MANUAL_CLOSE_UNRECONCILED`);
      effectivePnl = 0;
      effectivePnlPct = 0;
      closeReasonOverride = "MANUAL_CLOSE_UNRECONCILED";
    }

    db.prepare(`
       UPDATE trades SET exit_price = ?, exit_time = ?, pnl = ?, pnl_pct = ?, status = 'closed', close_reason = COALESCE(?, close_reason)
       WHERE id = ? AND status = 'open'
    `).run(exitPrice, exitTime, effectivePnl, effectivePnlPct, closeReasonOverride ?? closeReason ?? null, id);

    return {
      ...trade, exitPrice, exitTime, pnl: effectivePnl, pnlPct: effectivePnlPct, status: "closed",
      closeReason: closeReasonOverride ?? closeReason ?? trade.close_reason ?? null,
    };
  });

  return txn();
}

/**
 * Atomic partial-close ledger accumulator for products that can close in
 * MULTIPLE stages (COIN-M inverse contracts: e.g. a reduceOnly order only
 * fills 6 of a requested 10, leaving a remnant closed on a later pass).
 * Each call ADDS this stage's broker-settled realizedPnl/commission (native
 * asset, e.g. BTC) and actually-closed contract count to the row's running
 * totals in ONE transaction — never overwrites, so stage N's numbers can
 * never clobber stage 1..N-1's. Returns the NEW cumulative totals (after
 * this stage), which the caller uses to convert to USD exactly once on the
 * final stage. Returns null if the row isn't open (already closed —
 * mirrors closeTrade/closeTradeExplicit's "already closed" guard).
 */
export function accumulatePartialCloseLedger(
  id: string,
  stage: { realizedNative: number; commissionNative: number; commissionAsset: string; closedContracts: number; remainingContracts?: number },
): { realizedNative: number; commissionNative: number; commissionAsset: string; closedContracts: number } | null {
  const txn = db.transaction(() => {
    const trade = db.prepare(`SELECT id FROM trades WHERE id = ? AND status = 'open'`).get(id) as any;
    if (!trade) return null;
    db.prepare(`
      UPDATE trades SET
        partial_realized_native = COALESCE(partial_realized_native, 0) + ?,
        partial_commission_native = COALESCE(partial_commission_native, 0) + ?,
        partial_commission_asset = COALESCE(?, partial_commission_asset),
        partial_closed_contracts = COALESCE(partial_closed_contracts, 0) + ?
      WHERE id = ? AND status = 'open'
    `).run(stage.realizedNative, stage.commissionNative, stage.commissionAsset || null, stage.closedContracts, id);
    if (stage.remainingContracts !== undefined) {
      db.prepare(`UPDATE trades SET quantity = ? WHERE id = ? AND status = 'open'`).run(stage.remainingContracts, id);
    }
    const row = db.prepare(`SELECT partial_realized_native, partial_commission_native, partial_commission_asset, partial_closed_contracts FROM trades WHERE id = ?`).get(id) as any;
    return {
      realizedNative: row.partial_realized_native ?? 0,
      commissionNative: row.partial_commission_native ?? 0,
      commissionAsset: row.partial_commission_asset ?? "",
      closedContracts: row.partial_closed_contracts ?? 0,
    };
  });
  return txn();
}

export function getPartialCloseLedger(id: string): { realizedNative: number; commissionNative: number; commissionAsset: string; closedContracts: number } {
  const row = db.prepare(`SELECT partial_realized_native, partial_commission_native, partial_commission_asset, partial_closed_contracts FROM trades WHERE id = ?`).get(id) as any;
  return {
    realizedNative: Number(row?.partial_realized_native) || 0,
    commissionNative: Number(row?.partial_commission_native) || 0,
    commissionAsset: row?.partial_commission_asset ?? "",
    closedContracts: Number(row?.partial_closed_contracts) || 0,
  };
}

export function getOpenTrades(accountId?: string): TradeRecord[] {
  let rows: any[];
  if (accountId) {
    rows = db.prepare(`SELECT * FROM trades WHERE status = 'open' AND account_id = ?`).all(accountId) as any[];
  } else {
    rows = db.prepare(`SELECT * FROM trades WHERE status = 'open'`).all() as any[];
  }
  return rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    market: r.market,
    side: r.side,
    strategy: r.strategy,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    quantity: r.quantity,
    pnl: r.pnl,
    pnlPct: r.pnl_pct,
    entryTime: r.entry_time,
    exitTime: r.exit_time,
    status: r.status,
    accountId: r.account_id,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    marginUsed: r.margin_used ?? undefined,
    orderId: r.order_id ?? undefined,
  }));
}

export function getRecentTrades(limit = 100, accountId?: string): TradeRecord[] {
  // Latest ACTIVITY first: a closed row ranks by its exit, an open one by its
  // entry. Ordering by entry_time (until 2026-09-29) kept a position opened
  // weeks ago out of the feed on the day it closed — UNI/USDC (entered
  // 08-29, closed 09-29, +$1,649.46, announced on Telegram) fell past the
  // dashboard's 60-close cut, and META/AAPL (09-04/09-11 → 09-28) sat at the
  // bottom of the list under rows that closed days earlier.
  let rows: any[];
  if (accountId) {
    rows = db.prepare(`SELECT * FROM trades WHERE account_id = ? ORDER BY COALESCE(exit_time, entry_time) DESC LIMIT ?`).all(accountId, limit) as any[];
  } else {
    // Default feed is v8 live sleeves only (dashboard /api/trades + Telegram
    // /trades) — same scope as getTradingStats. Was only excluding shadow_*,
    // which left legacy COMBINED profiles (alpaca_low/high, binance_low/high)
    // and sync_* rows as 90/100 of the default 100-row feed. Pass an account
    // explicitly to inspect shadow_/legacy/sync rows.
    rows = db.prepare(`SELECT * FROM trades WHERE account_id IN ${V8_ACCOUNTS_SQL} ORDER BY COALESCE(exit_time, entry_time) DESC LIMIT ?`).all(limit) as any[];
  }
  return rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    market: r.market,
    side: r.side,
    strategy: r.strategy,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    quantity: r.quantity,
    pnl: r.pnl,
    pnlPct: r.pnl_pct,
    entryTime: r.entry_time,
    exitTime: r.exit_time,
    status: r.status,
    accountId: r.account_id,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    closeReason: r.close_reason,
  }));
}

// Broker-sync reconciliation / backfill closes are NOT real strategy outcomes:
// BACKFILLED_SYNC + SYNC_DETECTED are pnl=0 phantoms (a position the broker
// closed that the bot back-filled), BROKER_GONE_404 + MANUAL_CLOSE_UNRECONCILED
// are pnl=0 reconciles. Counting them as trades inflated the count and — because
// (closed − wins) treats every non-win as a loss — dragged win rate DOWN (e.g.
// alpaca_low showed 27% when it was 70%, its 71 pnl=0 back-fills read as losses).
// Excluding them keeps every count/win-rate honest and consistent with the
// Telegram digest, which already excluded all four. Exported so both callers
// (and the digest) share ONE definition and can't drift apart again.
// v8 additions: MOMENTUM_RECONCILED / MEANREV_RECONCILED are written by the
// v8 momentum/meanrev adapters when a position vanished on the broker and the
// row is closed as a reconcile (placeholder pnl, not a strategy outcome);
// SYNC_DUP_RECONCILED is written by the host reconcile script for duplicate
// sync rows; LEGACY_UNLABELED marks pre-v4 rows backfilled without a real
// close reason. None of them are real strategy exits.
export const RECONCILE_CLOSE_SQL =
  `(close_reason IS NULL OR close_reason NOT IN ('BROKER_GONE_404','MANUAL_CLOSE_UNRECONCILED','BACKFILLED_SYNC','SYNC_DETECTED','MOMENTUM_RECONCILED','MEANREV_RECONCILED','SYNC_DUP_RECONCILED','LEGACY_UNLABELED'))`;

// v8 live sleeves — the default scope for account-less stats queries. The
// trades table also holds legacy profiles (alpaca_low/high, binance_low/high),
// shadow_* simulated books, and sync_*/BROKER_SYNC rows; none of those belong
// in a headline "how is the bot doing" number.
const V8_ACCOUNTS_SQL = `('${ALL_PROFILE_IDS.join("','")}')`;

export function getTradingStats(accountId?: string, periodDays = 1) {
  // No account ⇒ v8 live sleeves only (no shadow_, no legacy, no sync rows).
  const whereAcc = accountId ? ` AND account_id = ?` : ` AND account_id IN ${V8_ACCOUNTS_SQL}`;
  const bindAcc = accountId ? [accountId] : [];

  const totalTrades = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE ${RECONCILE_CLOSE_SQL}${whereAcc}`).get(...bindAcc) as any;

  // All closed-based tallies exclude reconcile/backfill rows (RECONCILE_CLOSE_SQL)
  // so win rate + counts reflect real strategy outcomes, not broker-sync phantoms.
  const closedTrades = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE status = 'closed' AND ${RECONCILE_CLOSE_SQL}${whereAcc}`).get(...bindAcc) as any;
  const winningTrades = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE status = 'closed' AND pnl > 0 AND ${RECONCILE_CLOSE_SQL}${whereAcc}`).get(...bindAcc) as any;
  const openTrades = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE status = 'open'${whereAcc}`).get(...bindAcc) as any;
  const totalPnl = db.prepare(`SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE status = 'closed' AND ${RECONCILE_CLOSE_SQL}${whereAcc}`).get(...bindAcc) as any;

  const todayStart = getETDayStart();
  const RECONCILE_FILTER = ` AND ${RECONCILE_CLOSE_SQL}`;
  // Count trades opened OR closed today — both are today's trading activity
  const todayTrades = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE (entry_time > ? OR (exit_time IS NOT NULL AND exit_time > ?))${RECONCILE_FILTER}${whereAcc}`).get(todayStart, todayStart, ...bindAcc) as any;
  const todayPnl = db.prepare(`SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE status = 'closed' AND exit_time > ?${RECONCILE_FILTER}${whereAcc}`).get(todayStart, ...bindAcc) as any;
  // v6.0: today's closed trades and win rate (separate from all-time)
  const todayClosed = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE status = 'closed' AND exit_time > ?${RECONCILE_FILTER}${whereAcc}`).get(todayStart, ...bindAcc) as any;
  const todayWins = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE status = 'closed' AND pnl > 0 AND exit_time > ?${RECONCILE_FILTER}${whereAcc}`).get(todayStart, ...bindAcc) as any;

  // Period window (dashboard time filter): default 1 day = today. For N>1 we
  // anchor at the ET-day-start of (N-1) days ago so "7d" = the last 7 ET days
  // inclusive (DST-safe day boundary). periodDays===1 ⇒ identical to today*.
  // periodDays===0 ⇒ all-time (epoch 0), for the "All" dashboard window.
  const periodStart = periodDays === 0 ? 0 : periodDays <= 1 ? todayStart : getETDayStart(Date.now() - (periodDays - 1) * 86_400_000);
  const periodPnl = db.prepare(`SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE status = 'closed' AND exit_time > ?${RECONCILE_FILTER}${whereAcc}`).get(periodStart, ...bindAcc) as any;
  const periodTrades = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE (entry_time > ? OR (exit_time IS NOT NULL AND exit_time > ?))${RECONCILE_FILTER}${whereAcc}`).get(periodStart, periodStart, ...bindAcc) as any;
  const periodClosed = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE status = 'closed' AND exit_time > ?${RECONCILE_FILTER}${whereAcc}`).get(periodStart, ...bindAcc) as any;
  const periodWins = db.prepare(`SELECT COUNT(*) as count FROM trades WHERE status = 'closed' AND pnl > 0 AND exit_time > ?${RECONCILE_FILTER}${whereAcc}`).get(periodStart, ...bindAcc) as any;

  return {
    totalTrades: totalTrades.count,
    closedTrades: closedTrades.count,
    openTrades: openTrades.count,
    winningTrades: winningTrades.count,
    winRate: closedTrades.count > 0 ? (winningTrades.count / closedTrades.count) * 100 : 0,
    totalPnl: totalPnl.total,
    todayTrades: todayTrades.count,
    todayClosedTrades: todayClosed.count,
    todayWinRate: todayClosed.count > 0 ? (todayWins.count / todayClosed.count) * 100 : -1, // -1 = no data
    todayPnl: todayPnl.total,
    todayWins: todayWins.count,
    // Period-scoped (time filter). periodDays=1 ⇒ same as today*.
    periodDays,
    periodPnl: periodPnl.total,
    periodTrades: periodTrades.count,
    periodClosedTrades: periodClosed.count,
    periodWinRate: periodClosed.count > 0 ? (periodWins.count / periodClosed.count) * 100 : -1,
    periodWins: periodWins.count,
  };
}

// ── Account persistence ─────────────────────

export interface LoadedAccount {
  equity: number;
  cash: number;
  initialEquity: number;
  totalRealizedPnl: number;
  consecutiveLosses: number;
  consecutiveLossPauseUntil: number;
}

export function loadAccount(id: string): LoadedAccount | null {
  const row = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return {
    equity: row.equity,
    cash: row.cash,
    initialEquity: row.initial_equity,
    totalRealizedPnl: row.total_realized_pnl,
    consecutiveLosses: row.consecutive_losses ?? 0,
    consecutiveLossPauseUntil: row.consecutive_loss_pause_until ?? 0,
  };
}

export function saveAccount(id: string, equity: number, cash: number, initialEquity: number, totalRealizedPnl: number) {
  db.prepare(`
    INSERT INTO accounts (id, equity, cash, initial_equity, total_realized_pnl, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET equity = ?, cash = ?, initial_equity = ?, total_realized_pnl = ?, updated_at = ?
  `).run(id, equity, cash, initialEquity, totalRealizedPnl, Date.now(),
         equity, cash, initialEquity, totalRealizedPnl, Date.now());
}

// ══════════════════════════════════════════════
// SNAPSHOT SEMANTIC VERSIONING — the poisoned-anchor killer.
//
// CONTRACT (read this before touching equity attribution):
// equity_snapshots rows carry the ATTRIBUTION SEMANTICS under which they were
// written. Whenever the MEANING of a profile's equity series changes (e.g. the
// 2026-07 fix that split the shared Alpaca wallet into per-sleeve ledgers —
// momentum_stocks snapshots went from "whole $100k wallet" to "$50k sleeve
// ledger"), rows written under the old meaning poison every anchor that mixes
// them with new rows: first-snapshot "since start" baselines, ET-midnight
// day-P&L anchors, drawdown peaks. That class recurred 6 times.
//
// The fix is structural: every write stamps EQUITY_SEMANTICS; every anchor /
// series read filters `semantics = EQUITY_SEMANTICS`. To change attribution
// semantics again: BUMP THE CONSTANT, document the era below, done —
// all old rows become automatically invisible to anchors. NO manual purge, NO
// backfill script, NO "run reconcile on the host" ever again.
//
// Eras: 1 = pre-v8 (implicit; no such rows survive), 2 = per-sleeve-ledger
// era (2026-07-12: *_main rows are broker truth, sleeve rows are ledgers;
// Binance main included all-assets/~10k broker truth), 3 = single-collateral
// Binance era (2026-07-16: binance_main/momentum_crypto use USDT collateral
// only, matching the configured 5k allocation; v2 anchors would fake a loss),
// 4 = Binance root totalMarginBalance era (2026-07-18: binance_main/
// momentum_crypto use Binance's own `totalMarginBalance` — wallet+unrealized,
// which in single-asset mode is the USDT margin bucket only, ~4.7k),
// 5 = Binance total-assets era (2026-07-18: binance_main shifts from root
// USDT margin (~4.7k) to total account equity valorized from all Binance
// assets (~10.3k); momentum_crypto remains root totalMarginBalance operable;
// mixing era 4 with era 5 would fabricate a jump, so era 4 becomes invisible).
// ══════════════════════════════════════════════
// Per-series registry — the "one number for every series" assumption above
// doesn't hold in general (a Binance-only methodology change must not force
// alpaca_main's era to move too), so readers look this up PER PROFILE. Every
// registered series happens to be on the SAME version today (no migration
// needed), but that's a coincidence of the current era, not a shortcut we
// bake back in: adding a 6th production series means adding it here
// DELIBERATELY, not silently inheriting whatever number is current.
const SEMANTICS_REGISTRY: Record<string, number> = {
  alpaca_main: 5,
  binance_main: 5,
  momentum_stocks: 5,
  momentum_crypto: 5,
  meanrev_stocks: 5,
  // 2026-07-19: new sleeves, own wallets, start at the CURRENT era — no prior
  // rows exist under these ids, so there is nothing to rebase/quarantine.
  momentum_crypto_usdc: 5,
  momentum_btc: 5,
  // New broker-truth series (DAPI COIN-M account total, sole-owned by
  // momentum_btc) — same "starts at current era, nothing to rebase" reasoning.
  binance_coinm_main: 5,
};

/** Current attribution-semantics version for one series. Throws for an
 *  unregistered id — used by the WRITE path (saveEquitySnapshot) so a typo'd
 *  or new profile id can't silently write an unaudited attribution version.
 *  See SEMANTICS_REGISTRY doc above. */
export function currentSemantics(profileId: string): number {
  const v = SEMANTICS_REGISTRY[profileId];
  if (v === undefined) throw new Error(`currentSemantics: unregistered equity series "${profileId}" — add it to SEMANTICS_REGISTRY in src/db/database.ts`);
  return v;
}

// Backward-compat flat constant. Every registered series is on this same
// version today, so it still equals currentSemantics(id) for all 5 canonical
// series — kept for external modules/tests pinned to "the current era
// number" (e.g. src/portfolio/truth.ts).
export const EQUITY_SEMANTICS = 5;

/** READ-path lookup: per-series when registered, else the flat default.
 *  Unlike currentSemantics (write path), this never throws — dashboard
 *  analytics routes (out of this module's control) legitimately query
 *  legacy/shadow profile ids (e.g. "alpaca_low", "shadow_meanrev_wide") that
 *  will never be added to the production registry; they must keep returning
 *  their (possibly empty) series, not 500. */
export function readSemantics(profileId: string): number {
  return SEMANTICS_REGISTRY[profileId] ?? EQUITY_SEMANTICS;
}

/**
 * Return the fixed Alpaca v8 starting-equity anchor.
 *
 * This historical anchor predates the Binance-only semantics bump, so v2
 * snapshots remain eligible across newer global semantics eras.
 */
export function getAlpacaV8StartEquity(): number | null {
  try {
    const row = db.prepare(
      `SELECT equity FROM equity_snapshots WHERE profile_id = 'alpaca_main' AND snapshot_time >= ? AND semantics >= 2 AND synthetic = 0 ORDER BY snapshot_time ASC LIMIT 1`
    ).get(Date.parse("2026-07-10T14:00:00Z")) as { equity: number } | undefined;
    return row?.equity ?? null;
  } catch {
    return null;
  }
}

// ── Snapshot plausibility guard (2026-08-18 incident) ──
//
// During a Binance Futures Testnet backend outage (2026-08-18 01:10–03:55
// UTC, /fapi/v2/account 408 storms), the backend intermittently served a
// corrupt account ledger: the root totals read as a pristine $5,000 account
// while assets[] entries summed to ≈ −$1.33 TRILLION. getAccountTotal
// faithfully priced that garbage — every field was finite, every asset
// priceable, the root cross-check self-consistent — Number.isFinite passed
// in refreshBinanceAccountTotal, and 20 binance_main rows persisted with
// equity ≈ −1,330,000,000,000 marked synthetic=0 ("real"), poisoning the
// dashboard chart, 7D/30D windows, the digest and the consolidated total.
// NOTHING between the broker payload and the DB checked plausibility.
//
// This is that check, placed at the SINGLE writer so it covers every profile
// and every future caller. A rejected reading is a GAP in the series —
// visible and honest; a bogus row silently poisons every anchor and window
// that crosses it. Prefer the gap.
//
// Thresholds and why:
//  • non-finite equity/cash — never representable as an observation.
//  • negative equity — no wallet we track can owe money (Binance futures
//    liquidates before a balance goes negative; Alpaca paper can't either).
//    cash MAY be negative legitimately (Alpaca margin), so only equity.
//  • > EQUITY_JUMP_FACTOR (1000×) the last real snapshot of the SAME profile
//    — a deposit/withdrawal legitimately steps equity, but the largest
//    plausible operator action is depositing a few times the wallet, not
//    999× of it between two 5-min ticks; the incident's rows were ~1.4e8×
//    off, so 1000× rejects the garbage class with orders of magnitude to
//    spare on both sides. Baseline is floored at $100 so a dust wallet
//    doesn't reject its own real first funding.
//  • the DOWNSIDE has no ratio check above zero: a drained, position-free
//    wallet legitimately reads $0. The momentum_crypto_usdc equity=0 rows
//    once cited here as that precedent were NOT a drain — they were corrupt
//    reads of the 2026-08-18 outage (one with a LINK position open; the
//    sleeve's trades reconcile to ~$4.7k on both sides; quarantined by
//    fingerprint (d) in migrateColumns). What IS impossible is $0 while
//    holding a position (futures liquidate long before a funded wallet with
//    an open position reaches exactly zero) — that combination is rejected.
const EQUITY_JUMP_FACTOR = 1000;

function implausibleSnapshotReason(profileId: string, equity: number, cash: number, openPositions = 0): string | null {
  if (!Number.isFinite(equity) || !Number.isFinite(cash)) return `non-finite reading (equity=${equity}, cash=${cash})`;
  if (equity < 0) return `negative equity (${equity}) — no tracked wallet can owe money; this is a corrupt broker read`;
  if (equity === 0 && openPositions > 0) return `zero equity with ${openPositions} open position(s) — a wallet holding a position cannot be worth exactly $0 (the 2026-08-18 corrupt-read shape)`;
  const prev = db.prepare(
    `SELECT equity FROM equity_snapshots WHERE profile_id = ? AND synthetic = 0 AND equity > 0 ORDER BY snapshot_time DESC, id DESC LIMIT 1`
  ).get(profileId) as { equity: number } | undefined;
  if (prev && equity > Math.max(prev.equity, 100) * EQUITY_JUMP_FACTOR) {
    return `equity ${equity} is >${EQUITY_JUMP_FACTOR}× the last real snapshot (${prev.equity}) — implausible as a genuine move or deposit`;
  }
  return null;
}

/** THE canonical writer of equity_snapshots — see the repository-wide guard
 *  in src/db/equitySnapshotsWriterGuard.test.ts. Derives its semantics stamp
 *  from profileId via the registry above; throws for an unregistered id
 *  instead of silently writing an unaudited attribution version.
 *
 *  Returns false (row NOT written, ERROR logged, never throws) when the
 *  reading fails the plausibility guard above — an operator bug (unregistered
 *  id / undeclared transition) still throws, because that's a code problem,
 *  not a data problem, and callers (safeSnap) already contain it.
 *
 *  Also the ONLY place a live semantics TRANSITION gets recorded (§3): if the
 *  profile's most-recently-inserted row is a DIFFERENT semantics value than
 *  this write, that boundary must already be DECLARED in
 *  equity_semantics_transitions (see registerEquitySemanticsTransition) —
 *  an undeclared bump throws instead of silently landing an unaudited jump
 *  that getDisplayEquitySeries would later have to guess about. A declared
 *  "rebase" whose offset isn't known yet gets it computed HERE, exactly
 *  once, from this write's equity vs the latest old-era equity, and
 *  persisted atomically with the snapshot. */
export function saveEquitySnapshot(profileId: string, equity: number, cash: number, openPositions: number, at = Date.now()): boolean {
  const sem = currentSemantics(profileId);
  const reason = implausibleSnapshotReason(profileId, equity, cash, openPositions);
  if (reason) {
    log.error(`equity_snapshots write REJECTED for ${profileId}: ${reason}. Dropping the reading — a gap in the series is honest, a bogus row poisons every window that crosses it. If this persists, the broker is serving corrupt account data (see the 2026-08-18 incident note above this guard).`);
    return false;
  }
  const txn = db.transaction(() => {
    const prev = db.prepare(
      `SELECT semantics FROM equity_snapshots WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
    ).get(profileId) as { semantics: number } | undefined;
    if (prev && prev.semantics !== sem) {
      recordFirstTransitionIfNeeded(profileId, prev.semantics, sem, equity, at);
    }
    db.prepare(`INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(profileId, equity, cash, openPositions, at, sem);
  });
  txn();
  return true;
}

/**
 * Returns the most recent equity snapshot at or before `at` (epoch ms).
 * Falls back to the first snapshot strictly after `at` if none before.
 * Used by DailyReporter to anchor startingEquity / endingEquity to the
 * actual equity at the ET day boundaries instead of the all-time
 * profile.initialEquity (which made unrealizedPnl reflect lifetime
 * drift, not the day's intraday move).
 */
export function getEquityAt(profileId: string, at: number): number | null {
  const sem = readSemantics(profileId);
  const before = db.prepare(
    `SELECT equity FROM equity_snapshots WHERE profile_id = ? AND snapshot_time <= ? AND semantics = ? AND synthetic = 0 ORDER BY snapshot_time DESC LIMIT 1`
  ).get(profileId, at, sem) as { equity: number } | undefined;
  if (before) return before.equity;
  const after = db.prepare(
    `SELECT equity FROM equity_snapshots WHERE profile_id = ? AND snapshot_time > ? AND semantics = ? AND synthetic = 0 ORDER BY snapshot_time ASC LIMIT 1`
  ).get(profileId, at, sem) as { equity: number } | undefined;
  return after ? after.equity : null;
}

/** Earliest timestamp from snapshots or trades — i.e. when the bot started managing money. */
export function getBotStartedAt(): number {
  const snap = db.prepare(`SELECT MIN(snapshot_time) as t FROM equity_snapshots WHERE synthetic = 0`).get() as any;
  const trade = db.prepare(`SELECT MIN(entry_time) as t FROM trades`).get() as any;
  return Math.min(snap?.t || Infinity, trade?.t || Infinity);
}

/**
 * 2026-09-24 audit fix: the dashboard's "RUNNING N days" KPI used
 * getBotStartedAt() above, which is intentionally account-agnostic (the
 * earliest REAL snapshot/trade across the WHOLE table, including the
 * amputated pre-v8 legacy profiles from April) — correct for its own
 * documented purpose, but not for a KPI a reader takes as "how long has
 * the CURRENT (v8) strategy been running" (v8 launched 2026-07-10; the
 * unfiltered figure reads ~173d instead of ~76d). This is a SEPARATE
 * reader, scoped to ALL_PROFILE_IDS the same way getTradingStats/
 * getHourlyAnalytics already are — getBotStartedAt itself is untouched
 * (syntheticSnapshots.test.ts pins its exact unfiltered semantics).
 */
export function getV8StartedAt(): number {
  const snap = db.prepare(`SELECT MIN(snapshot_time) as t FROM equity_snapshots WHERE synthetic = 0 AND profile_id IN ${V8_ACCOUNTS_SQL}`).get() as any;
  const trade = db.prepare(`SELECT MIN(entry_time) as t FROM trades WHERE account_id IN ${V8_ACCOUNTS_SQL}`).get() as any;
  return Math.min(snap?.t || Infinity, trade?.t || Infinity);
}

// ══════════════════════════════════════════════
// Wave 1 (2026-05-07): Fill / slippage telemetry
// ══════════════════════════════════════════════

/**
 * Records a single fill for slippage / latency analysis. Called from
 * OrderExecutor on every confirmed fill. Pure addition — no other code
 * paths read this table yet (Wave 1 is observability only).
 */
export function recordFill(row: {
  tradeId: string;
  orderId: string;
  accountId: string;
  symbol: string;
  side: string;
  market: string;
  expectedPx: number;
  submittedPx: number;
  filledPx: number;
  filledQty: number;
  fillTime: number;
  latencyMs: number;
  broker: string;
  /** Pre-trade estimated VWAP fill price (bookDepth.ts) — optional telemetry. */
  estPx?: number;
}): void {
  // Slippage: signed bps versus expected. Buy: positive bps = bad
  // (paid more than expected). Sell: positive bps = good (got more than
  // expected). Storing the signed direction lets the dashboard show "vs
  // expectation" cleanly per side.
  const signedDelta =
    row.side === "buy" ? row.filledPx - row.expectedPx : row.expectedPx - row.filledPx;
  const slippageBps = row.expectedPx > 0 ? (signedDelta / row.expectedPx) * 10_000 : 0;

  db.prepare(`
    INSERT INTO fills (trade_id, order_id, account_id, symbol, side, market,
      expected_px, submitted_px, filled_px, filled_qty, slippage_bps,
      fill_time, latency_ms, broker, est_px)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.tradeId, row.orderId, row.accountId, row.symbol, row.side, row.market,
    row.expectedPx, row.submittedPx, row.filledPx, row.filledQty, slippageBps,
    row.fillTime, row.latencyMs, row.broker, row.estPx ?? null
  );
}

/**
 * Tanda 5 (2026-08-06): the `fills` table already carries THREE price marks
 * per fill — `expected_px` (decision price), `submitted_px` (quote when the
 * order was sent) and `filled_px` (actual fill) — but `recordFill` only ever
 * turned them into ONE number, `slippage_bps` (decision → fill, total). For
 * a same-tick execution (momentum) that's fine: decision and submission are
 * ~seconds apart, so total ≈ execution quality. For meanrev — which DECIDES
 * off yesterday's daily close and SUBMITS the next morning ≥09:35 ET — the
 * overnight gap between those two marks dwarfs anything the order router did
 * (measured: meanrev's slippage_bps averaged −142.8bps/45 fills, which read
 * as "incredible execution" when it's really the reversion thesis itself
 * playing out in the gap). Mixing them made the number useless for the one
 * thing it exists to answer: is EXECUTION good.
 *
 * This splits the total into its two legs, computed on read (no schema
 * change — the three marks were already there):
 *   - drift:     expected_px → submitted_px. Pure market movement between
 *                DECIDING and SENDING the order. The bot does not control
 *                this (for meanrev, this IS the overnight gap / the thesis).
 *   - execution: submitted_px → filled_px. The only leg that measures order-
 *                routing quality — the only one a chaser/router can act on.
 *
 * Both keep `recordFill`'s per-side sign convention (buy: positive = paid
 * more than the reference = bad; sell: positive = got more than the
 * reference = good) so drift/execution/total are all read the same way.
 *
 * total vs drift+execution — APPROXIMATE, not exact, and that's intentional:
 * each leg is a bps RATE relative to its OWN reference price (drift over
 * expected_px, execution over submitted_px), matching how each leg would
 * actually be traded against (a chaser re-quotes off submitted_px, not the
 * stale decision price). Chaining two percentage rates with different bases
 * doesn't sum linearly — the gap is second-order (drift_pct × execution_pct)
 * and negligible for realistic moves, but NOT zero for a large single leg
 * (see the meanrev-decomposition test). If exact additivity mattered more
 * than "trade against the price you'd actually see", execution could instead
 * be rebased over expected_px — deliberately not done here.
 *
 * submitted_px is REQUIRED for BOTH the drift leg (its own endpoint) and the
 * execution leg (its own reference price): older fills recorded before Wave
 * 1's submitted_px capture (or any row where it's 0/absent) return
 * `driftBps: null, executionBps: null` — only `totalBps` (which only needs
 * expected_px/filled_px) is still computable. Never a fabricated 0/drift,
 * which would silently claim "no overnight move, perfect execution" for a
 * fill we simply have no submit-side mark for.
 */
export function decomposeSlippage(
  side: string,
  expectedPx: number,
  submittedPx: number,
  filledPx: number,
): { totalBps: number; driftBps: number | null; executionBps: number | null } {
  const isBuy = side === "buy";

  const totalDelta = isBuy ? filledPx - expectedPx : expectedPx - filledPx;
  const totalBps = expectedPx > 0 ? (totalDelta / expectedPx) * 10_000 : 0;

  if (submittedPx <= 0) {
    return { totalBps, driftBps: null, executionBps: null };
  }

  const driftDelta = isBuy ? submittedPx - expectedPx : expectedPx - submittedPx;
  const driftBps = expectedPx > 0 ? (driftDelta / expectedPx) * 10_000 : 0;

  const executionDelta = isBuy ? filledPx - submittedPx : submittedPx - filledPx;
  const executionBps = (executionDelta / submittedPx) * 10_000;

  return { totalBps, driftBps, executionBps };
}

/**
 * Returns slippage statistics for the dashboard. p50/p95/count in bps + count
 * over the requested window, PLUS the Tanda 5 decomposition: driftP50/
 * driftP95/driftCount is the decision→submit leg (market move outside the
 * bot's control — for meanrev, the overnight gap), executionP50/executionP95/
 * executionCount is the submit→fill leg (the only leg execution quality
 * actually measures).
 * Both are null/0 when no fill in the window has a usable submitted_px
 * (older rows predating that capture) — `p50`/`p95`/`count` keep their prior
 * meaning (total decision→fill) unchanged and are unaffected, since total
 * only ever needed expected_px/filled_px.
 */
export function getSlippageStats(
  accountId: string | null,
  windowMs: number = 7 * 24 * 3600_000,
): {
  p50: number; p95: number; count: number; meanLatencyMs: number;
  driftP50: number | null; driftP95: number | null; driftCount: number;
  executionP50: number | null; executionP95: number | null; executionCount: number;
} {
  const since = Date.now() - windowMs;
  const where = accountId ? "WHERE account_id = ? AND fill_time > ?" : "WHERE fill_time > ?";
  const args: any[] = accountId ? [accountId, since] : [since];
  const rows = db.prepare(
    `SELECT side, expected_px, submitted_px, filled_px, slippage_bps, latency_ms FROM fills ${where} ORDER BY slippage_bps ASC`
  ).all(...args) as { side: string; expected_px: number; submitted_px: number; filled_px: number; slippage_bps: number; latency_ms: number }[];
  if (rows.length === 0) {
    return {
      p50: 0, p95: 0, count: 0, meanLatencyMs: 0,
      driftP50: null, driftP95: null, driftCount: 0,
      executionP50: null, executionP95: null, executionCount: 0,
    };
  }
  const p50 = rows[Math.floor(rows.length * 0.5)]?.slippage_bps ?? 0;
  const p95 = rows[Math.floor(rows.length * 0.95)]?.slippage_bps ?? 0;
  const meanLat = rows.reduce((s, r) => s + r.latency_ms, 0) / rows.length;

  const drifts: number[] = [];
  const executions: number[] = [];
  for (const r of rows) {
    const d = decomposeSlippage(r.side, r.expected_px, r.submitted_px, r.filled_px);
    if (d.driftBps !== null) drifts.push(d.driftBps);
    if (d.executionBps !== null) executions.push(d.executionBps);
  }
  drifts.sort((a, b) => a - b);
  executions.sort((a, b) => a - b);
  const driftP50 = drifts.length ? drifts[Math.floor(drifts.length * 0.5)] : null;
  const driftP95 = drifts.length ? drifts[Math.floor(drifts.length * 0.95)] : null;
  const executionP50 = executions.length ? executions[Math.floor(executions.length * 0.5)] : null;
  const executionP95 = executions.length ? executions[Math.floor(executions.length * 0.95)] : null;

  return {
    p50, p95, count: rows.length, meanLatencyMs: meanLat,
    driftP50, driftP95, driftCount: drifts.length,
    executionP50, executionP95, executionCount: executions.length,
  };
}

// ══════════════════════════════════════════════
// Tearsheet analytics (2026-06-28, Bloomberg SEAG/PORT-style). Pure MEASUREMENT
// over equity_snapshots — never gates trades.
// ══════════════════════════════════════════════

/** Month-over-month equity return % (last snapshot of each ET month). */
export function getMonthlyReturns(profileId: string, months = 12): { month: string; pct: number }[] {
  const since = Date.now() - (months + 1) * 31 * 86_400_000;
  const rows = db.prepare(
    `SELECT snapshot_time, equity FROM equity_snapshots WHERE profile_id=? AND snapshot_time>=? AND equity>0 AND semantics=? AND synthetic=0 ORDER BY snapshot_time ASC`
  ).all(profileId, since, readSemantics(profileId)) as Array<{ snapshot_time: number; equity: number }>;
  if (rows.length < 2) return [];
  const byMonth = new Map<string, number>();
  for (const r of rows) byMonth.set(getETDateKey(r.snapshot_time).slice(0, 7), r.equity); // YYYY-MM → last equity
  const keys = [...byMonth.keys()];
  const out: { month: string; pct: number }[] = [];
  for (let i = 1; i < keys.length; i++) {
    const prev = byMonth.get(keys[i - 1])!, cur = byMonth.get(keys[i])!;
    out.push({ month: keys[i], pct: prev > 0 ? (cur / prev - 1) * 100 : 0 });
  }
  return out.slice(-months);
}

/** Underwater (drawdown %) series — distance below the running peak, daily. */
export function getDrawdownSeries(profileId: string, days = 90): { t: number; dd: number }[] {
  const since = Date.now() - days * 86_400_000;
  const rows = db.prepare(
    `SELECT snapshot_time, equity FROM equity_snapshots WHERE profile_id=? AND snapshot_time>=? AND equity>0 AND semantics=? AND synthetic=0 ORDER BY snapshot_time ASC`
  ).all(profileId, since, readSemantics(profileId)) as Array<{ snapshot_time: number; equity: number }>;
  const byDay = new Map<string, { t: number; eq: number }>();
  for (const r of rows) byDay.set(getETDateKey(r.snapshot_time), { t: r.snapshot_time, eq: r.equity });
  let peak = 0;
  const out: { t: number; dd: number }[] = [];
  for (const s of byDay.values()) { if (s.eq > peak) peak = s.eq; out.push({ t: s.t, dd: peak > 0 ? (s.eq / peak - 1) * 100 : 0 }); }
  return out;
}

export function updateTradeCloseReason(tradeId: string, reason: string) {
  db.prepare(`UPDATE trades SET close_reason = ? WHERE id = ?`).run(reason, tradeId);
}

/**
 * Record the protective stop actually armed for an OPEN row.
 *
 * The Binance adapters have always written this when they place their native
 * STOP_MARKET; the Alpaca native-stop path (added 2026-08-03) placed the GTC
 * order at the broker but never wrote the price back, so `trades.stop_loss`
 * stayed NULL and every dashboard row showed "—" for positions that were in
 * fact protected. An operator reading that column to answer "is this position
 * covered?" got the wrong answer — the protection was real and invisible.
 *
 * Scoped to `status='open'`: a closed row's stop is history, not state.
 * A non-finite or non-positive price is ignored rather than written, so a bad
 * read can never erase a stop the operator can see.
 */
export function updateTradeStopLoss(tradeId: string, stopPrice: number): void {
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return;
  db.prepare(`UPDATE trades SET stop_loss = ? WHERE id = ? AND status = 'open'`).run(stopPrice, tradeId);
}

// ── Corporate actions (audit + idempotency ledger) ──────────────────────
// See the corporate_actions schema comment above. Param shape is structural
// (not the market/corporateActions type) so db/ never imports from market/.

/** Record a detected event. Returns whether this is the FIRST sighting
 *  (isNew — gate one-shot alerts on it) and whether its one-shot
 *  reconciliation already ran (appliedAt — gate split application on null). */
export function recordCorporateAction(ev: { symbol: string; type: string; exDate: string; ratio?: number; raw?: unknown }): { isNew: boolean; appliedAt: number | null } {
  const res = db.prepare(
    `INSERT OR IGNORE INTO corporate_actions (symbol, ca_type, ex_date, ratio, payload, detected_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ev.symbol, ev.type, ev.exDate, ev.ratio ?? null, ev.raw !== undefined ? JSON.stringify(ev.raw) : null, Date.now());
  const row = db.prepare(`SELECT applied_at FROM corporate_actions WHERE symbol = ? AND ca_type = ? AND ex_date = ?`)
    .get(ev.symbol, ev.type, ev.exDate) as { applied_at: number | null } | undefined;
  return { isNew: res.changes > 0, appliedAt: row?.applied_at ?? null };
}

export function markCorporateActionApplied(symbol: string, type: string, exDate: string): void {
  db.prepare(`UPDATE corporate_actions SET applied_at = ? WHERE symbol = ? AND ca_type = ? AND ex_date = ? AND applied_at IS NULL`)
    .run(Date.now(), symbol, type, exDate);
}

/**
 * Apply a split ratio (new_rate/old_rate: forward 1→2 ⇒ 2, reverse 10→1 ⇒
 * 0.1) to every OPEN stock row on `symbol`: qty ×ratio, entry ÷ratio (cost
 * basis qty×entry is invariant, so realized pnl computed against POST-split
 * exit prices stays correct), and any stored stop/take levels scale with the
 * price axis. Mirrors what Alpaca's Beginning-of-Day job (02:15–02:30 ET)
 * does to the broker position — without this, the DB row's stale basis makes
 * the 15s SL loop read a forward split as a −50% crash and a re-placed
 * native stop trigger instantly. Returns rows changed. Callers MUST gate on
 * the corporate_actions ledger (applied_at) — applying twice corrupts basis.
 *
 * `entryBeforeMs` (OPEN.md P2 2026-08-29): the feed can lag announcements
 * (CA_LOOKBACK_DAYS = 5), so a row ENTERED on/after the ex-date already
 * carries post-split basis — rescaling it fabricates unrealized pnl and
 * re-arms its stop ~an order of magnitude away. Pass the ex-date's ET
 * day-start to only touch rows with entry_time strictly before it; omit it
 * (or pass a non-finite value) to keep the old adjust-everything behavior —
 * the caller's fallback when the event carries no usable ex-date.
 */
export function applySplitToOpenStockTrades(symbol: string, ratio: number, entryBeforeMs?: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return 0;
  const cutoff = typeof entryBeforeMs === "number" && Number.isFinite(entryBeforeMs) ? entryBeforeMs : null;
  const sql = `
    UPDATE trades SET
      quantity = quantity * ?,
      entry_price = entry_price / ?,
      stop_loss = CASE WHEN stop_loss IS NOT NULL THEN stop_loss / ? ELSE NULL END,
      take_profit = CASE WHEN take_profit IS NOT NULL THEN take_profit / ? ELSE NULL END
    WHERE status = 'open' AND symbol = ? AND market = 'stock'
  ` + (cutoff !== null ? ` AND entry_time < ?` : ``);
  const params = cutoff !== null
    ? [ratio, ratio, ratio, ratio, symbol, cutoff]
    : [ratio, ratio, ratio, ratio, symbol];
  const res = db.prepare(sql).run(...params as any);
  return res.changes;
}

// ── Activity Log ────────────────────────────

export function insertActivity(accountId: string | null, eventType: string, message: string) {
  db.prepare(`INSERT INTO activity_log (account_id, event_type, message, created_at) VALUES (?, ?, ?, ?)`)
    .run(accountId, eventType, message, Date.now());
}

export function getActivityLog(limit = 100, eventType?: string, accountId?: string): any[] {
  let sql = `SELECT * FROM activity_log WHERE 1=1`;
  const params: any[] = [];
  if (eventType) { sql += ` AND event_type = ?`; params.push(eventType); }
  if (accountId) { sql += ` AND account_id = ?`; params.push(accountId); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as any[];
}

// ══════════════════════════════════════════════
// DISPLAY-ONLY equity history rebasing (2026-07-18, prune-independence
// hardening 2026-07-19) — the dashboard/Telegram "Since Start"/Equity-tab
// want the FULL history across every semantics era (see the EQUITY_SEMANTICS
// doc above), not just the current one, WITHOUT re-litigating which era is
// "true" for risk/invariant purposes. These helpers are read-only display
// twins of getEquityAt/getEquityHistory*/getRiskMetrics — none
// of those, nor writes, nor the invariant anchors in src/portfolio/truth.ts,
// are touched by this section.
//
// Policy: every (profileId, fromEra, toEra) transition is EXPLICITLY
// DECLARED (registerEquitySemanticsTransition, seeded at init by
// seedKnownEquitySemanticsTransitions — see KNOWN_TRANSITIONS below) as one
// of:
//   • "rebase"     — a real attribution-basis swap; gets a constant EQUITY
//                     offset that cancels the fake jump. Computed LIVE
//                     (nextFirst.equity − curLast.equity) when the two
//                     SURVIVING boundary rows are still within 15min of each
//                     other — the same-moment case, always exact. When they
//                     aren't (thinned by prune, or deleted outright — the
//                     production incident this hardening fixes: prune ate
//                     binance_main/momentum_crypto's 2→3 boundary rows,
//                     leaving only a 56min gap, which used to fail the old
//                     15min check and report a fake −$5,272 loss), falls back
//                     to the PERSISTED `equity_offset` on the declaration row
//                     — computed and frozen once, either from a forensic
//                     backup recovery (the 3 KNOWN_TRANSITIONS rebases) or
//                     atomically at the transition's first live write (see
//                     saveEquitySnapshot) — so correctness no longer depends
//                     on which rows happen to have survived. Only when
//                     NEITHER the live gap NOR a persisted offset is
//                     available does it fall through to unknown, below.
//   • "continuous" — an audited, real continuation (no methodology change,
//                     or a change too small/irrelevant to correct); the raw
//                     delta carries through unchanged, exactly as-is. Never
//                     needs an offset (always 0), so never depends on rows.
//   • "break"      — an audited, EXPLICIT discontinuity (never rebase this
//                     boundary, even if a live gap looks small). Same
//                     display effect as "unknown" below, but documents that
//                     someone looked and decided the jump is real.
//   • undeclared    — UNKNOWN. We have never audited this jump. Silently
//                     treating it as any of the above is how a real
//                     discontinuity gets reported as fabricated performance
//                     (or a real rebase gets missed). The earlier run is
//                     marked `basis: "discontinuous"` and folds into
//                     `rebased` (suppress %); any cross-boundary P&L query
//                     whose start point sits on the far side of it fails
//                     CLOSED (returns null) instead of guessing.
// `cash`/`open_positions` are never touched, only `equity`; the latest run
// always has offset 0, so "latest adjusted equity == latest raw" by
// construction. See the era doc above for which jumps are real vs artifacts.
// ══════════════════════════════════════════════

export type TransitionKind = "continuous" | "rebase" | "break";

interface KnownTransition {
  profileId: string; from: number; to: number; kind: TransitionKind;
  offset?: number;
  boundaryOldTime?: number; boundaryOldEquity?: number;
  boundaryNewTime?: number; boundaryNewEquity?: number;
  source: string;
}

// The one place every historical (and currently-anticipated) equity-
// semantics transition gets declared. Seeded idempotently at every
// initDatabase() — a fresh :memory: test DB and the aged production DB both
// end up with exactly these rows. To ship a FUTURE semantics bump, add its
// (profileId, from, to) pair here BEFORE deploying the code that writes the
// new era — saveEquitySnapshot's write-time guard throws on an undeclared
// transition instead of silently landing an unaudited jump (§3).
//
// The 3 "rebase" rows below carry the EXACT offset recovered read-only from
// a pre-prune backup (2026-07-19 forensic recovery): production's
// pruneEquitySnapshots had already deleted the true boundary rows for
// binance_main/momentum_crypto's 2→3 transition (only ~56min-apart survivors
// remained, past the old 15min live-gap window), silently reporting a fake
// ≈−$5,272 momentum loss. binance_main's 4→5 boundary rows were NOT pruned
// (still <15min apart today) — its persisted offset is included anyway, both
// as a fallback safety net and to make the declaration list complete/uniform.
const KNOWN_TRANSITIONS: KnownTransition[] = [
  {
    profileId: "binance_main", from: 2, to: 3, kind: "rebase",
    offset: -5641.0895599999985,
    boundaryOldTime: Date.parse("2026-07-17T20:14:36.952Z"), boundaryOldEquity: 10239.761283079999,
    boundaryNewTime: Date.parse("2026-07-17T20:16:11.183Z"), boundaryNewEquity: 4598.67172308,
    source: "backup-recovery-2026-07-19: pre-prune backup, exact boundary rows",
  },
  {
    profileId: "momentum_crypto", from: 2, to: 3, kind: "rebase",
    offset: -5641.0895599999985,
    boundaryOldTime: Date.parse("2026-07-17T20:14:36.952Z"), boundaryOldEquity: 10239.761283079999,
    boundaryNewTime: Date.parse("2026-07-17T20:16:11.183Z"), boundaryNewEquity: 4598.67172308,
    source: "backup-recovery-2026-07-19: shared-wallet twin of binance_main's 2→3 event, same exact offset",
  },
  { profileId: "binance_main", from: 3, to: 4, kind: "continuous", source: "policy-declared-2026-07-18" },
  {
    profileId: "binance_main", from: 4, to: 5, kind: "rebase",
    offset: 5648.7809707819015,
    boundaryOldTime: Date.parse("2026-07-18T23:45:25.235Z"), boundaryOldEquity: 4672.30890138,
    boundaryNewTime: Date.parse("2026-07-18T23:48:26.940Z"), boundaryNewEquity: 10321.089872161901,
    source: "backup-recovery-2026-07-19: pre-prune backup, exact boundary rows",
  },
  { profileId: "momentum_crypto", from: 3, to: 4, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "momentum_crypto", from: 4, to: 5, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "alpaca_main", from: 2, to: 3, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "alpaca_main", from: 3, to: 4, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "alpaca_main", from: 4, to: 5, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "momentum_stocks", from: 2, to: 3, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "momentum_stocks", from: 3, to: 4, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "momentum_stocks", from: 4, to: 5, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "meanrev_stocks", from: 2, to: 3, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "meanrev_stocks", from: 3, to: 4, kind: "continuous", source: "policy-declared-2026-07-18" },
  { profileId: "meanrev_stocks", from: 4, to: 5, kind: "continuous", source: "policy-declared-2026-07-18" },
];

/**
 * Explicit declaration API (§3) — the smallest possible surface for
 * registering an equity-semantics transition's classification (and, when
 * already known, its exact rebase offset). Idempotent: INSERT OR IGNORE
 * keyed by the (profile, from, to) primary key, so re-seeding on every boot
 * — or a caller declaring a transition that ends up ALSO being recorded by
 * saveEquitySnapshot's first-write guard — never overwrites an
 * already-persisted row. First declaration wins; nothing else does.
 */
export function registerEquitySemanticsTransition(
  profileId: string, from: number, to: number, kind: TransitionKind,
  opts: {
    offset?: number | null;
    boundaryOldTime?: number | null; boundaryOldEquity?: number | null;
    boundaryNewTime?: number | null; boundaryNewEquity?: number | null;
    source: string;
  },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO equity_semantics_transitions
      (profile_id, from_semantics, to_semantics, kind, equity_offset,
       boundary_old_time, boundary_old_equity, boundary_new_time, boundary_new_equity,
       source, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    profileId, from, to, kind, opts.offset ?? null,
    opts.boundaryOldTime ?? null, opts.boundaryOldEquity ?? null,
    opts.boundaryNewTime ?? null, opts.boundaryNewEquity ?? null,
    opts.source, Date.now(),
  );
}

/** Called once from migrateColumns() on every initDatabase(). */
function seedKnownEquitySemanticsTransitions(): void {
  for (const t of KNOWN_TRANSITIONS) {
    registerEquitySemanticsTransition(t.profileId, t.from, t.to, t.kind, {
      offset: t.offset, boundaryOldTime: t.boundaryOldTime, boundaryOldEquity: t.boundaryOldEquity,
      boundaryNewTime: t.boundaryNewTime, boundaryNewEquity: t.boundaryNewEquity, source: t.source,
    });
  }
}

function getPersistedTransition(profileId: string, from: number, to: number): { kind: TransitionKind; offset: number | null } | null {
  const row = db.prepare(
    `SELECT kind, equity_offset FROM equity_semantics_transitions WHERE profile_id = ? AND from_semantics = ? AND to_semantics = ?`
  ).get(profileId, from, to) as { kind: TransitionKind; equity_offset: number | null } | undefined;
  return row ? { kind: row.kind, offset: row.equity_offset } : null;
}

/**
 * Write-path half of §3: called from saveEquitySnapshot exactly when the
 * profile's previous row's semantics differs from this write's. Throws for
 * an undeclared transition (fail loudly instead of fabricating performance
 * later); for a declared "rebase" whose offset isn't known yet, computes it
 * ONCE (newEquity − latest-old-era-equity) and persists it — every
 * subsequent write of the same (from,to) pair is then a no-op here (offset
 * already non-null). "continuous"/"break" transitions need no offset, so a
 * declared-but-unresolved row for those never exists — nothing to do.
 */
function recordFirstTransitionIfNeeded(profileId: string, fromSem: number, toSem: number, newEquity: number, newAt: number): void {
  const t = getPersistedTransition(profileId, fromSem, toSem);
  if (!t) {
    throw new Error(
      `saveEquitySnapshot: undeclared equity semantics transition ${profileId} ${fromSem}→${toSem} — ` +
      `register it via registerEquitySemanticsTransition() (or add it to KNOWN_TRANSITIONS in src/db/database.ts) before writing`
    );
  }
  if (t.kind === "rebase" && t.offset == null) {
    const latestOld = db.prepare(
      `SELECT equity, snapshot_time FROM equity_snapshots WHERE profile_id = ? AND semantics = ? AND synthetic = 0 ORDER BY snapshot_time DESC, id DESC LIMIT 1`
    ).get(profileId, fromSem) as { equity: number; snapshot_time: number } | undefined;
    if (!latestOld) return; // no prior row to rebase from (shouldn't happen — fromSem was just observed) — leave pending rather than guess
    const offset = newEquity - latestOld.equity;
    db.prepare(`
      UPDATE equity_semantics_transitions
         SET equity_offset = ?, boundary_old_time = ?, boundary_old_equity = ?, boundary_new_time = ?, boundary_new_equity = ?, recorded_at = ?
       WHERE profile_id = ? AND from_semantics = ? AND to_semantics = ? AND equity_offset IS NULL
    `).run(offset, latestOld.snapshot_time, latestOld.equity, newAt, newEquity, Date.now(), profileId, fromSem, toSem);
  }
}

export interface DisplayEquityRow {
  id: number; profile_id: string; equity: number; cash: number;
  open_positions: number; snapshot_time: number; semantics: number;
  rebased: boolean;
  /** "continuous"/"rebase": the path from this row to latest is trusted.
   *  "discontinuous": an unclassified (or gap-failed) transition sits
   *  somewhere between this row and latest — never treat a delta crossing
   *  it as comparable performance (see getEquityPnlDisplay). */
  basis: "continuous" | "rebase" | "discontinuous";
  /** Return-safe segment id: increments at every era boundary that is NOT a
   *  declared "continuous" continuation (i.e. at every rebase, break,
   *  pending-rebase or undeclared transition). A RATE of return between two
   *  rows is only meaningful when both share a segment — a rebase keeps the
   *  $ delta honest but the % base never literally existed, and a
   *  discontinuous boundary trusts neither (same policy getEquityPnlDisplay
   *  applies to pnlPct/null). Consumed by src/portfolio/sleeveReturns.ts. */
  segment: number;
  /** The equity as it was actually recorded — WITHOUT the splice offset that
   *  `equity` carries for pre-rebase eras. Any RATE of return must divide
   *  rawEquity by rawEquity (within one segment): the spliced `equity` keeps
   *  $-deltas comparable across a rebase, but (raw+offset)/(raw'+offset) is
   *  not the return of a balance that ever existed. */
  rawEquity: number;
}

/**
 * Full display series for a profile: every semantics>=2 row (old-semantics/
 * NULL rows stay invisible, same rule as every other anchor), grouped into
 * maximal chronological runs of equal `semantics`, each run classified
 * against the run after it via TRANSITION_POLICY. One-row runs, duplicate
 * timestamps, and out-of-order semantics values fall out of the same
 * grouping + backward pass deterministically — no special-casing.
 *
 * The trailing tail is also quarantined to the latest CURRENT-semantics run:
 * a stray write at a stale semantics value landing chronologically AFTER the
 * true latest (a race around an EQUITY_SEMANTICS bump) would otherwise
 * become its own run and masquerade as "latest".
 */
export function getDisplayEquitySeries(profileId: string): DisplayEquityRow[] {
  const rows = db.prepare(
    `SELECT * FROM equity_snapshots WHERE profile_id = ? AND semantics >= 2 AND synthetic = 0 ORDER BY snapshot_time ASC, id ASC`
  ).all(profileId) as Array<{ id: number; profile_id: string; equity: number; cash: number; open_positions: number; snapshot_time: number; semantics: number }>;
  if (rows.length === 0) return [];

  const runs: { semantics: number; rows: typeof rows }[] = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && last.semantics === r.semantics) last.rows.push(r);
    else runs.push({ semantics: r.semantics, rows: [r] });
  }

  const currentSem = SEMANTICS_REGISTRY[profileId]; // undefined for a non-registered id: skip quarantine, best-effort
  if (currentSem !== undefined) {
    let lastCurrentIdx = -1;
    for (let i = runs.length - 1; i >= 0; i--) { if (runs[i].semantics === currentSem) { lastCurrentIdx = i; break; } }
    if (lastCurrentIdx >= 0 && lastCurrentIdx < runs.length - 1) runs.length = lastCurrentIdx + 1;
  }

  const offsets = new Array<number>(runs.length).fill(0);
  const rebased = new Array<boolean>(runs.length).fill(false);
  const discontinuous = new Array<boolean>(runs.length).fill(false);
  const segments = new Array<number>(runs.length).fill(0);
  for (let i = runs.length - 2; i >= 0; i--) {
    const cur = runs[i], next = runs[i + 1];
    const t = getPersistedTransition(profileId, cur.semantics, next.semantics);
    // Segment id (see DisplayEquityRow.segment): only a declared "continuous"
    // continuation keeps two runs return-compatible. Numbered from the latest
    // run backwards — only equality between two rows matters.
    segments[i] = segments[i + 1] + (t?.kind === "continuous" ? 0 : 1);

    if (t?.kind === "rebase") {
      // The PERSISTED offset is authoritative, always — never re-derive from
      // whatever boundary rows happen to survive. It was measured ONCE, at
      // write time (recordFirstTransitionIfNeeded), from the exact old/new
      // boundary rows at that moment; a "close" live gap on read is NOT proof
      // those are the same rows — thinning/deletion can leave a few-minutes-
      // adjacent survivor that already moved with the market, silently
      // corrupting an already-published rebase. Boundary-row computation is
      // only ever permitted once, at that first new-semantics write, when no
      // offset is persisted yet — never here, on read.
      if (t.offset != null) {
        offsets[i] = offsets[i + 1] + t.offset;
        rebased[i] = true;
        discontinuous[i] = discontinuous[i + 1];
      } else {
        // Declared rebase, but the first new-semantics write hasn't happened
        // yet (nothing has computed/persisted the offset) — genuinely
        // unknown for now, regardless of gap size.
        offsets[i] = offsets[i + 1];
        rebased[i] = rebased[i + 1];
        discontinuous[i] = true;
      }
    } else if (t?.kind === "continuous") {
      offsets[i] = offsets[i + 1];
      rebased[i] = rebased[i + 1];
      discontinuous[i] = discontinuous[i + 1];
    } else {
      // Undeclared, or an explicit "break": preserve the raw numbers (still
      // useful per-era) but never let a P&L/pct computation cross this
      // boundary as comparable performance.
      offsets[i] = offsets[i + 1];
      rebased[i] = rebased[i + 1];
      discontinuous[i] = true;
    }
  }

  const out: DisplayEquityRow[] = [];
  for (let i = 0; i < runs.length; i++) {
    const basis: DisplayEquityRow["basis"] = discontinuous[i] ? "discontinuous" : (rebased[i] ? "rebase" : "continuous");
    const rowRebased = rebased[i] || discontinuous[i]; // discontinuous is strictly less trustworthy than a plain rebase
    for (const r of runs[i].rows) out.push({ ...r, equity: r.equity + offsets[i], rawEquity: r.equity, rebased: rowRebased, basis, segment: segments[i] });
  }
  return out;
}

/** Display-only twin of getEquityHistory (current-era-only) — spans every
 *  classified era (see TRANSITION_POLICY). Same ET-day-aligned window;
 *  `days<=0` means all-time (epoch 0), matching the dashboard's `period=0`
 *  "All" window. */
export function getEquityHistoryDisplay(profileId: string, days = 30): DisplayEquityRow[] {
  const since = days <= 0 ? 0 : days <= 1 ? getETDayStart() : getETDayStart(Date.now() - (days - 1) * 86_400_000);
  return getDisplayEquitySeries(profileId).filter(r => r.snapshot_time > since);
}

/** Display-only twin of getEquityHistoryByRange — "all" genuinely means all
 *  (every classified era spliced together), not just the current one. */
export function getEquityHistoryByRangeDisplay(profileId: string, range: string): DisplayEquityRow[] {
  let since: number;
  const now = Date.now();
  switch (range) {
    case "1h": since = now - 60 * 60_000; break;
    case "1d": since = now - 24 * 60 * 60_000; break;
    case "1w": since = now - 7 * 24 * 60 * 60_000; break;
    case "1m": since = now - 30 * 24 * 60 * 60_000; break;
    case "all": since = 0; break;
    default:   since = now - 24 * 60 * 60_000;
  }
  return getDisplayEquitySeries(profileId).filter(r => r.snapshot_time > since);
}

/**
 * Display-only equity P&L. `periodDays=0` means "all-time": the
 * window start is the FIRST eligible adjusted point (spanning every era),
 * not epoch-vs-today. `pnlPct` is null when the start point required a
 * rebase to reach current values — the $ delta stays accurate (the offset
 * cancels a real methodology jump), but dividing by a synthetically-shifted
 * base would claim a simple return over a balance that never literally
 * existed. When an UNCLASSIFIED transition sits between the start point and
 * latest, the whole result fails closed to `null` (smallest safe surface —
 * every caller already treats a null result as "unavailable"): we can't
 * trust the $ delta either, not just the %.
 */
export function getEquityPnlDisplay(profileId: string, periodDays = 1): { pnl: number; pnlPct: number | null; startEquity: number } | null {
  const series = getDisplayEquitySeries(profileId);
  if (series.length === 0) return null;
  const latest = series[series.length - 1];

  let startRow: DisplayEquityRow | undefined;
  if (periodDays === 0) {
    startRow = series[0];
  } else {
    const todayStart = getETDayStart();
    const periodStart = periodDays <= 1 ? todayStart : getETDayStart(Date.now() - (periodDays - 1) * 86_400_000);
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].snapshot_time <= periodStart) { startRow = series[i]; break; }
    }
    if (!startRow) startRow = series.find(r => r.snapshot_time > periodStart);
  }
  if (!startRow) return null;
  if (startRow.basis === "discontinuous") return null;

  const pnl = latest.equity - startRow.equity;
  const pnlPct = startRow.rebased ? null : (startRow.equity > 0 ? (pnl / startRow.equity) * 100 : 0);
  // startEquity rides along so multi-leg callers (src/portfolio/truth.ts
  // combineEquityPnlLegs) can weight-combine several series' $ pnl into one
  // aggregate % without re-deriving a start value from pnl/pnlPct (undefined
  // when pnl is 0) or a second query.
  return { pnl, pnlPct, startEquity: startRow.equity };
}

/** Display-only "first point" anchor — spans every classified era (unlike
 *  getEquityAt(id,0), which is current-era-only). `rebased` tells callers
 *  whether reaching this point required a rebase OR crossed an unclassified
 *  (discontinuous) boundary, so they can suppress a synthetic-basis
 *  percentage. */
export function getEquityDisplayStart(profileId: string): { equity: number; rebased: boolean } | null {
  const series = getDisplayEquitySeries(profileId);
  if (series.length === 0) return null;
  const first = series[0];
  return { equity: first.equity, rebased: first.rebased };
}

export function getDB(): Database {
  return db;
}

// ═══════════════════════════════════════════
// v2.0 Profile Operations
// ═══════════════════════════════════════════

export function getProfiles(): any[] {
  return db.prepare(`SELECT * FROM profiles WHERE is_active = 1 ORDER BY created_at ASC`).all() as any[];
}

export function getBrokerAccounts(profileId?: string): any[] {
  if (profileId) {
    return db.prepare(`SELECT * FROM broker_accounts WHERE profile_id = ? AND is_active = 1`).all(profileId) as any[];
  }
  return db.prepare(`SELECT * FROM broker_accounts WHERE is_active = 1`).all() as any[];
}

export function saveDailyReport(report: any): void {
  // Audit fix (2026-05-06): switched from blind INSERT to upsert so
  // regenerating a report (e.g. backfill, manual rerun, post-close crypto
  // refresh) overwrites the existing row instead of creating duplicates.
  // The unique index on (profile_id, report_date) is created in
  // createIndexes() — see migrateColumns() / createIndexes().
  db.prepare(`
    INSERT INTO daily_reports (profile_id, report_date, starting_equity, ending_equity,
      realized_pnl, unrealized_pnl, total_trades, winning_trades, win_rate,
      best_trade_symbol, best_trade_pnl, worst_trade_symbol, worst_trade_pnl,
      most_active_strategy, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(profile_id, report_date) DO UPDATE SET
      starting_equity      = excluded.starting_equity,
      ending_equity        = excluded.ending_equity,
      realized_pnl         = excluded.realized_pnl,
      unrealized_pnl       = excluded.unrealized_pnl,
      total_trades         = excluded.total_trades,
      winning_trades       = excluded.winning_trades,
      win_rate             = excluded.win_rate,
      best_trade_symbol    = excluded.best_trade_symbol,
      best_trade_pnl       = excluded.best_trade_pnl,
      worst_trade_symbol   = excluded.worst_trade_symbol,
      worst_trade_pnl      = excluded.worst_trade_pnl,
      most_active_strategy = excluded.most_active_strategy,
      generated_at         = CURRENT_TIMESTAMP
  `).run(
    report.profileId, report.reportDate, report.startingEquity, report.endingEquity,
    report.realizedPnl, report.unrealizedPnl, report.totalTrades, report.winningTrades,
    report.winRate, report.bestTradeSymbol, report.bestTradePnl,
    report.worstTradeSymbol, report.worstTradePnl, report.mostActiveStrategy
  );
}

/**
 * Existence check across ALL profiles for a given report_date — used by
 * DailyReporter as the idempotency latch instead of an in-memory flag
 * (which resets on restart and drops the day forever).
 */
export function hasDailyReport(date: string): boolean {
  const row = db.prepare(`SELECT 1 FROM daily_reports WHERE report_date = ? LIMIT 1`).get(date);
  return row != null;
}

/**
 * Phase 5E (2026-05-20): mark every daily_reports row for the given
 * report_date as telegram_sent=1. Called by DailyReporter immediately
 * after `await sendTelegramDigest()` resolves; if the await throws,
 * this helper is never reached and the flag stays at its default 0.
 *
 * Idempotent: rerunning the report (backfill, manual rerun) regenerates
 * the rows in the same transaction; this helper just flips the flag.
 * Returns the number of rows actually updated.
 */
export function markDailyReportTelegramSent(reportDate: string): number {
  try {
    const res = db.prepare(
      `UPDATE daily_reports SET telegram_sent = 1 WHERE report_date = ?`
    ).run(reportDate);
    return Number(res.changes ?? 0);
  } catch {
    // Column missing on a stale schema would throw; safeAddColumn at boot
    // means this is practically impossible, but never let a reporter
    // observability flag throw past the digest itself.
    return 0;
  }
}

/**
 * Returns all closed trades for a profile whose `exit_time` falls within
 * [startMs, endMs). Excludes back-filled reconciliation rows
 * (BROKER_GONE_404, MANUAL_CLOSE_UNRECONCILED) so daily reports don't
 * count ghost closes as real bot activity.
 *
 * Audit fix (2026-05-06): replaces the previous DailyReporter pattern of
 * `getRecentTrades(100, acc).filter(...)` which capped at 100 by entry_time.
 */
export function getClosedTradesInETDayRange(
  accountId: string,
  startMs: number,
  endMs: number,
): any[] {
  const rows = db.prepare(`
    SELECT * FROM trades
    WHERE account_id = ?
      AND status = 'closed'
      AND exit_time IS NOT NULL
      AND exit_time >= ?
      AND exit_time < ?
      AND ${RECONCILE_CLOSE_SQL}
    ORDER BY exit_time ASC
  `).all(accountId, startMs, endMs) as any[];
  return rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    market: r.market,
    side: r.side,
    strategy: r.strategy,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    quantity: r.quantity,
    pnl: r.pnl,
    pnlPct: r.pnl_pct,
    entryTime: r.entry_time,
    exitTime: r.exit_time,
    status: r.status,
    accountId: r.account_id,
    closeReason: r.close_reason,
  }));
}

export function getClosedTradesInRange(profileId: string | null, from: string, to: string): any[] {
  if (profileId) {
    return db.prepare(`
      SELECT * FROM trades WHERE status = 'closed' AND profile_id = ? AND ${RECONCILE_CLOSE_SQL}
      AND exit_time >= ? AND exit_time <= ?
      ORDER BY exit_time ASC
    `).all(profileId, new Date(from).getTime(), new Date(to + "T23:59:59").getTime()) as any[];
  }
  return db.prepare(`
    SELECT * FROM trades WHERE status = 'closed' AND ${RECONCILE_CLOSE_SQL}
    AND exit_time >= ? AND exit_time <= ?
    ORDER BY exit_time ASC
  `).all(new Date(from).getTime(), new Date(to + "T23:59:59").getTime()) as any[];
}

export function getHourlyAnalytics(profileId: string | null, days: number): any[] {
  const since = Date.now() - days * 24 * 60 * 60_000;
  // SQLi fix: parameterize profileId instead of string-interpolating it (the
  // /api/analytics/hourly?profile=<x> param reaches here unsanitized).
  // No profile ⇒ v8 live sleeves only (not shadow_/legacy/sync rows).
  const whereProfile = profileId ? ` AND profile_id = ?` : ` AND profile_id IN ${V8_ACCOUNTS_SQL}`;
  const args: any[] = profileId ? [since, profileId] : [since];
  const rows = db.prepare(`
    SELECT * FROM trades WHERE status = 'closed' AND ${RECONCILE_CLOSE_SQL} AND exit_time > ?${whereProfile}
  `).all(...args) as any[];

  const hourMap: Record<number, { pnl: number; count: number; wins: number }> = {};
  for (let h = 0; h < 24; h++) hourMap[h] = { pnl: 0, count: 0, wins: 0 };

  for (const r of rows) {
    const h = getETHourDow(r.exit_time).hour; // ET, not server-UTC
    hourMap[h].pnl += r.pnl || 0;
    hourMap[h].count++;
    if ((r.pnl || 0) > 0) hourMap[h].wins++;
  }

  return Object.entries(hourMap).map(([hour, data]) => ({
    hour: parseInt(hour),
    avgPnl: data.count > 0 ? data.pnl / data.count : 0,
    tradeCount: data.count,
    winRate: data.count > 0 ? data.wins / data.count : 0,
  }));
}

// ── Broker Asset Balances ────────────────────

export function upsertAssetBalance(brokerAccountId: string, asset: string, balance: number, availableBalance: number, usdValue: number) {
  db.prepare(`INSERT INTO broker_asset_balances (broker_account_id, asset, balance, available_balance, usd_value, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(broker_account_id, asset) DO UPDATE SET balance = ?, available_balance = ?, usd_value = ?, updated_at = CURRENT_TIMESTAMP`)
    .run(brokerAccountId, asset, balance, availableBalance, usdValue, balance, availableBalance, usdValue);
}

export function getAssetBalances(brokerAccountId: string): any[] {
  return db.prepare(`SELECT * FROM broker_asset_balances WHERE broker_account_id = ? AND balance != 0 ORDER BY usd_value DESC`).all(brokerAccountId) as any[];
}

/**
 * Atomically replace ALL asset-balance rows for a broker with the given
 * complete set — mirrors HistoricalStore's replaceBars pattern. A withdrawn/
 * zeroed asset that's simply ABSENT from the latest response (rather than
 * present with balance=0) would otherwise never be deleted by upsertAssetBalance
 * alone, leaving stale collateral rows contaminating marginBreakdown forever.
 * Callers MUST only invoke this with a known-COMPLETE, successful refresh
 * (never on a failed/empty fetch) — an empty `assets` array aborts before the
 * transaction so a bad fetch can't wipe the existing rows.
 */
export function replaceAssetBalances(
  brokerAccountId: string,
  assets: Array<{ asset: string; balance: number; availableBalance: number; usdValue: number }>,
): { written: number; deleted: number; error?: string } {
  if (assets.length === 0) {
    return { written: 0, deleted: 0, error: `${brokerAccountId}: empty replacement set` };
  }
  const delStmt = db.prepare(`DELETE FROM broker_asset_balances WHERE broker_account_id = ?`);
  const insStmt = db.prepare(`INSERT INTO broker_asset_balances (broker_account_id, asset, balance, available_balance, usd_value, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
  let written = 0;
  let deleted = 0;
  const txn = db.transaction((rows: typeof assets) => {
    deleted = delStmt.run(brokerAccountId).changes;
    for (const a of rows) {
      insStmt.run(brokerAccountId, a.asset, a.balance, a.availableBalance, a.usdValue);
      written++;
    }
  });
  txn(assets);
  return { written, deleted };
}

// ── Tiny persisted-state kv (sync_state) ───────────────────────────────────
// Born from BrokerSync's drift fingerprint/timestamp living in instance
// fields: every restart reset them, so the first sync pass after ANY deploy
// or watchdog restart re-paged about a drift that was already known. Keys are
// namespaced by caller (e.g. "drift_fingerprint", "drift_alert_at").
export function getSyncState(key: string): string | null {
  const row = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as any;
  return row ? row.value : null;
}

export function setSyncState(key: string, value: string): void {
  db.prepare(`
    INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

export function getSymbolAnalytics(profileId: string | null, days: number): any[] {
  const since = Date.now() - days * 24 * 60 * 60_000;
  // SQLi fix: parameterize profileId (see getHourlyAnalytics).
  const whereProfile = profileId ? ` AND profile_id = ?` : ` AND profile_id IN ${V8_ACCOUNTS_SQL}`;
  const args: any[] = profileId ? [since, profileId] : [since];
  const rows = db.prepare(`
    SELECT symbol, COUNT(*) as count, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           COALESCE(SUM(pnl), 0) as total_pnl, AVG(pnl) as avg_pnl
    FROM trades WHERE status = 'closed' AND ${RECONCILE_CLOSE_SQL} AND exit_time > ?${whereProfile}
    GROUP BY symbol ORDER BY total_pnl DESC
  `).all(...args) as any[];

  return rows.map((r: any) => ({
    symbol: r.symbol,
    tradeCount: r.count,
    winRate: r.count > 0 ? (r.wins / r.count) : 0,
    totalPnl: r.total_pnl,
    avgPnl: r.avg_pnl,
  }));
}

/**
 * Tanda 3 (2026-08-06): close-REASON attribution — how many closes, how much
 * P&L, and how long the average hold, PER `close_reason`. Born from
 * TRAIL_STOP becoming distinguishable from the amputated legacy stack's
 * TRAILING_SL 3 days ago (the first real v8 trail exit, AMZN +269.32 after
 * 147h, just happened) — this is the query that will tell us whether the
 * trailing stop should become momentum's primary exit instead of the hard
 * stop/rebalance flip.
 *
 * Reuses RECONCILE_CLOSE_SQL (not a new filter) so a phantom broker-sync
 * close (BROKER_GONE_404, MOMENTUM_RECONCILED, …) never gets counted as a
 * strategy exit here either — same exclusion list the rest of the stats
 * pipeline already trusts.
 */
export interface CloseReasonAttributionRow {
  closeReason: string;
  count: number;
  totalPnl: number;
  avgPnl: number;
  avgHoldMs: number;
}

export function getCloseReasonAttribution(profileId: string | null, days: number): CloseReasonAttributionRow[] {
  const since = Date.now() - days * 24 * 60 * 60_000;
  // Same parameterized-profile / v8-default-scope pattern as getSymbolAnalytics.
  const whereProfile = profileId ? ` AND profile_id = ?` : ` AND profile_id IN ${V8_ACCOUNTS_SQL}`;
  const args: any[] = profileId ? [since, profileId] : [since];
  const rows = db.prepare(`
    SELECT COALESCE(close_reason, 'UNLABELED') as close_reason,
           COUNT(*) as count,
           COALESCE(SUM(pnl), 0) as total_pnl,
           COALESCE(AVG(pnl), 0) as avg_pnl,
           COALESCE(AVG(exit_time - entry_time), 0) as avg_hold_ms
    FROM trades
    WHERE status = 'closed' AND ${RECONCILE_CLOSE_SQL} AND exit_time > ?${whereProfile}
    GROUP BY close_reason
    ORDER BY total_pnl DESC
  `).all(...args) as any[];

  return rows.map((r: any) => ({
    closeReason: r.close_reason,
    count: r.count,
    totalPnl: r.total_pnl,
    avgPnl: r.avg_pnl,
    avgHoldMs: r.avg_hold_ms,
  }));
}

/**
 * P&L attribution: splits realized P&L into three sources so we can tell
 * whether the trading ALGORITHM itself has an edge, separate from positions
 * that were merely reconciled from the broker.
 *
 *  - `algo`     : bot-opened AND bot-closed on its own terms (STOP_LOSS /
 *                 TAKE_PROFIT / TRAILING_SL / MAX_HOLD / REVERSE_SIGNAL …).
 *                 THIS is the real strategy edge. Watch its PF/total go
 *                 positive after the trailing(#1) + dynamic-TP(#3) fixes.
 *  - `reconcile`: bot-opened but closed EXTERNALLY (broker 404, manual,
 *                 sync-detected, momentum-reconciled). P&L here is mostly a
 *                 $0 placeholder, so trust the `count`, not the dollars.
 *  - `sync`     : positions the bot did NOT open (BrokerSync/recovery rows).
 *                 Real price-diff P&L, but not attributable to the strategy.
 *
 * Portfolio-wide on purpose (no profile filter): BROKER_SYNC rows carry
 * profile_id='default', so a per-profile filter would silently drop them.
 */
export interface PnlAttributionBucket {
  bucket: "algo" | "reconcile" | "sync";
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  profitFactor: number | null; // null when there are no losses (undefined PF)
}

export function getPnlAttribution(days: number): {
  buckets: PnlAttributionBucket[];
  netPnl: number;
  windowDays: number;
} {
  const sinceClause = days > 0 ? ` AND exit_time > ?` : "";
  const args: any[] = days > 0 ? [Date.now() - days * 24 * 60 * 60_000] : [];
  // v8-only (2026-09-24 audit fix): this table used to sum EVERY trade
  // regardless of account_id, so the pre-v8 legacy profiles (alpaca_low/
  // high, binance_low/high — amputated April–July history, see AGENTS.md)
  // silently blended into "Algorithm edge / Reconcile / Broker sync",
  // inflating the trade counts and P&L a v8-only reader would attribute to
  // the live sleeves. Same restriction getHourlyAnalytics/getSymbolAnalytics/
  // getCloseReasonAttribution already apply when no explicit profile is given.
  const rows = db.prepare(`
    SELECT
      CASE
        WHEN strategy IN ('BROKER_SYNC','SYNC_RECOVERY') THEN 'sync'
        WHEN NOT ${RECONCILE_CLOSE_SQL} THEN 'reconcile'
        ELSE 'algo'
      END AS bucket,
      COUNT(*) AS n,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
      COALESCE(SUM(pnl), 0) AS total_pnl,
      COALESCE(AVG(pnl), 0) AS avg_pnl,
      COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 0) AS gross_profit,
      COALESCE(SUM(CASE WHEN pnl < 0 THEN -pnl ELSE 0 END), 0) AS gross_loss
    FROM trades
    WHERE status = 'closed' AND pnl IS NOT NULL
      AND account_id IN ${V8_ACCOUNTS_SQL}${sinceClause}
    GROUP BY bucket
  `).all(...args) as any[];

  const byBucket = new Map<string, any>(rows.map((r) => [r.bucket, r]));
  const order: Array<PnlAttributionBucket["bucket"]> = ["algo", "reconcile", "sync"];
  const buckets: PnlAttributionBucket[] = order.map((b) => {
    const r = byBucket.get(b);
    const n = r?.n ?? 0;
    const wins = r?.wins ?? 0;
    const grossLoss = r?.gross_loss ?? 0;
    const grossProfit = r?.gross_profit ?? 0;
    return {
      bucket: b,
      trades: n,
      wins,
      winRate: n > 0 ? wins / n : 0,
      totalPnl: r?.total_pnl ?? 0,
      avgPnl: r?.avg_pnl ?? 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
    };
  });
  const netPnl = buckets.reduce((s, b) => s + b.totalPnl, 0);
  return { buckets, netPnl, windowDays: days };
}
