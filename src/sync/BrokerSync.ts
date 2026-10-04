// ══════════════════════════════════════════════
// BrokerSync — Centralized broker ↔ SQLite sync
// Runs every 30 seconds. Broker is ALWAYS truth.
// ══════════════════════════════════════════════

import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";
import { heartbeats } from "../ops/heartbeat";
import { insertActivity, getDB, replaceAssetBalances, getSyncState, setSyncState, isSyncOwned, pnlOf } from "../db/database";
import { stockSymbols, cryptoSymbols } from "../config/symbols";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";
import { isTreasurySymbol } from "../treasury/treasurySymbols";
import type { BrokerSyncSource } from "./brokerSyncSource";

const log = createLogger("BrokerSync");

// The exact surface BrokerSync reads off each source, derived from the shim so
// the two can't drift. `account` = getAccount()'s shape; `SyncPosition` = one
// getOpenPositions() element — side is ALREADY normalized to "buy"/"sell" and
// symbols are in alpaca form (the STACK A brokers returned "long"/"short"; the
// shim normalizes, so insertBrokerPosition no longer maps side).
type SyncAccount = Awaited<ReturnType<BrokerSyncSource["getAccount"]>>;
type SyncPosition = Awaited<ReturnType<BrokerSyncSource["getOpenPositions"]>>[number];

// ── Ownership boundary (v8) ────────────────────────────────────────────────
// Each broker's positions are OWNED by its sleeves: momentum_crypto owns the
// whole Binance wallet; momentum_stocks + meanrev_stocks own the Alpaca wallet
// between them. Every sleeve self-adopts its untracked broker positions via its
// OWN 60s AccountManager sync (with a 3-min grace on positionRisk.updateTime).
// A sync_ row filed under *_main is managed by NO engine and NO stop-loss loop
// (checkAllStopLoss iterates sleeve ids only) — so if BrokerSync also adopted a
// sleeve-owned symbol it would create a COMPETING, unmanaged row and could
// double the real position. BrokerSync therefore adopts ONLY genuinely orphaned
// symbols: those OUTSIDE every live sleeve universe (a legacy/manual position no
// engine will ever claim). Sleeve-owned reconciliation is AccountManager's job.
//
// Symbol formats already line up: Alpaca positions are plain tickers (SPY) and
// Binance positions are returned in alpaca form (BTC/USD) by the broker layer,
// matching config/symbols.ts + MEANREV_UNIVERSE.
const SLEEVE_UNIVERSE_ALPACA = new Set<string>([
  ...stockSymbols.map(s => s.symbol),
  ...MEANREV_UNIVERSE,
]);
export const SLEEVE_UNIVERSE_BINANCE = new Set<string>(cryptoSymbols.map(s => s.symbol));

/** True when `symbol` belongs to a live sleeve on `brokerId` (⇒ BrokerSync must
 *  not adopt it under *_main — the sleeve's own sync owns its reconciliation). */
export function sleeveOwnsSymbol(brokerId: string, symbol: string): boolean {
  return brokerId.includes("alpaca")
    ? SLEEVE_UNIVERSE_ALPACA.has(symbol)
    : SLEEVE_UNIVERSE_BINANCE.has(symbol);
}

export interface SyncResult {
  brokerId: string;
  timestamp: number;
  account: SyncAccount | null;
  positions: SyncPosition[];
  changes: SyncChange[];
  driftAlerts: QtyDrift[];
  error?: string;
}

export interface QtyDrift {
  symbol: string;
  brokerQty: number;
  dbQty: number;
}

// ── Quantity-drift detection (NOT adoption — see ownership-boundary note
// above) ────────────────────────────────────────────────────────────────
// The live incident this guards against: Alpaca held ~2x the DB's recorded
// quantity on 7 symbols (one, XLP, had NO db row at all) — invisible to
// every existing check because both the auto-close path (2a) and the
// adoption path (2b) only ask "does a DB row exist for this symbol", never
// "does the size match". Positions with no broker-native stop (Alpaca) had
// their excess half completely unprotected.
//
// Tolerance: a relative epsilon (not exact float equality) — quantities can
// be fractional (fractional shares, crypto lot sizes) and broker/DB rounding
// differs slightly. 0.5% is far below the ~100% drift this exists to catch,
// with an absolute floor so a missing-DB-row case (dbQty=0) is never masked
// by the relative term collapsing to ~0.
const QTY_DRIFT_REL_EPSILON = 0.005;
const QTY_DRIFT_ABS_EPSILON = 0.001;
// Re-notify interval for a drift that has NOT changed: one reminder per DAY.
// It was 6h (commit 2005ad1). Since the two-deployment consolidation to a
// single system, ANY broker≠DB quantity mismatch is a REAL bug — a stale DB
// row, a manual partial close, or a reconciliation gap — that needs someone
// to investigate; it is never an expected/permanent state. It still doesn't
// need paging every cycle while that investigation is pending: re-announcing
// an UNCHANGED, already-known drift every 30s is noise once the first page
// landed. A CHANGED fingerprint (new symbol or a quantity that moved) pages
// only once it survives TWO consecutive syncs with the same shape — see the
// drift-candidate grace period below. That 1-cycle hold is a filter on WHEN
// a real discrepancy pages, not on WHETHER it's real: any broker≠DB mismatch
// still IS a genuine discrepancy once it clears those 2 cycles.
const QTY_DRIFT_RENOTIFY_MS = 24 * 60 * 60_000;

// ── One-cycle grace before paging a NEW/CHANGED drift ──────────────────────
// Incident: ADA/USD (2026-09-04 03:32) and DIS (2026-09-09) each paged once
// for a fingerprint that had already vanished by the very next sync. Root
// cause: a benign broker/DB persistence race, not a real discrepancy —
// BrokerSync read the broker in the same ~30s cycle the adapter was
// persisting the fill's trades row (insertTrade runs immediately after the
// fill in AlpacaMomentumAdapter/BinanceMomentumAdapter, but "immediately"
// can still land after a sync tick that started first), so broker=N/db=0 for
// exactly ONE cycle before the row existed and the fingerprint returned to
// empty. Fix: a fingerprint that's new or differs from the CONFIRMED
// (persisted) one is held as a CANDIDATE — in memory only, not sync_state —
// and is promoted to confirmed (persisted + paged) only if the SAME
// fingerprint is seen on the immediately-following sync too. If it
// disappears first, it was the race: dropped silently. If it changes to
// something else first, the new value becomes the candidate (its own grace
// period starts fresh; the superseded one is never paged). Memory-only is
// deliberate: a restart loses an unconfirmed candidate, which at most delays
// a genuine drift's first page by one more sync (~30s) — the confirmed side
// still persists across restarts via sync_state (see loadDriftState below),
// so this only ever costs one extra cycle, never a missed page.

export interface SyncChange {
  type: "position_added" | "position_closed" | "equity_synced";
  symbol?: string;
  detail: string;
}

export class BrokerSync {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private syncing = false; // reentrancy guard — MUST be separate from `running` (lifecycle flag): start() sets running=true, so reusing it made every syncAll() bail instantly (BrokerSync was a TOTAL NO-OP 2026-07-09→07-13)
  private assetSyncing = new Set<string>();
  private syncIntervalMs: number;
  lastSyncAt = 0;
  // Persisted in sync_state (not just instance fields): an unresolved drift
  // is a real discrepancy on the ACCOUNT/DB awaiting reconciliation, not a
  // condition of this process. Living only in memory meant every restart
  // (deploy/watchdog) reset both and the first sync pass re-paged
  // "nueva/cambiada" about a drift that was already known — 5 pages in one
  // night, one per restart. Lazily loaded on first use so a fresh BrokerSync
  // always starts from whatever the DB last recorded.
  private lastQtyDriftAlertAt = -1; // -1 = not yet loaded from DB
  private lastDriftFingerprint = "";
  // Unconfirmed candidate for the ONE-CYCLE grace period (see top-of-file
  // note). Deliberately NOT persisted to sync_state: it's sub-cycle by
  // construction (the race it filters resolves within one 30s sync), and a
  // restart losing it only costs the next genuine drift one extra cycle
  // before its first page — see the note above for why that's acceptable.
  private driftCandidateFingerprint: string | null = null;
  private driftCandidateSymbols = ""; // for the "transient drift cleared" log line

  constructor(private sources: BrokerSyncSource[], syncIntervalMs = 30_000) {
    this.syncIntervalMs = syncIntervalMs;
  }

  /** Loads the persisted drift state on first access. Cheap point queries,
   *  no reason to cache beyond the instance fields themselves. */
  private loadDriftState() {
    if (this.lastQtyDriftAlertAt >= 0) return; // already loaded (or set this pass)
    this.lastDriftFingerprint = getSyncState("drift_fingerprint") ?? "";
    this.lastQtyDriftAlertAt = Number(getSyncState("drift_alert_at") ?? "0") || 0;
  }

  private saveDriftState() {
    setSyncState("drift_fingerprint", this.lastDriftFingerprint);
    setSyncState("drift_alert_at", String(this.lastQtyDriftAlertAt));
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.info(`BrokerSync started (every ${this.syncIntervalMs / 1000}s)`);
    // Liveness watchdog: beat() at the end of each successful syncAll(). This is
    // the exact loop that silently no-op'd for 4 days (2026-07-09→07-13) with no
    // alert; a dead loop now pages via ERROR_BURST. grace 2 (never throws).
    try { heartbeats.register("broker_sync", this.syncIntervalMs); } catch (e: any) { log.warn(`heartbeat register failed: ${e.message}`); }

    // Initial sync after 5s
    setTimeout(() => this.syncAll(), 5000);
    this.interval = setInterval(() => this.syncAll(), this.syncIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async syncAll(): Promise<SyncResult[]> {
    // 2026-07-09 reliability: reentrancy guard. syncBroker does N broker calls
    // (each ≤10s now); if a slow round exceeds the 30s interval the next tick
    // must not overlap — two concurrent syncs are a TOCTOU that can double-insert
    // sync_ rows (the phantom class). `running` existed but was never enforced.
    if (this.syncing) return [];
    this.syncing = true;
    try {
    const results: SyncResult[] = [];

    for (const source of this.sources) {
      if (source.status !== "connected") continue;
      try {
        const result = await this.syncBroker(source);
        results.push(result);
      } catch (e: any) {
        const errResult: SyncResult = {
          brokerId: source.id,
          timestamp: Date.now(),
          account: null,
          positions: [],
          changes: [],
          driftAlerts: [],
          error: e.message,
        };
        results.push(errResult);
        log.warn(`Sync failed for ${source.name}: ${e.message}`);
        insertActivity(null, "broker_error", `Sync failed: ${source.name} — ${e.message}`);
      }
    }

    this.lastSyncAt = Date.now();

    // Quantity-drift alert — DETECTION ONLY (no order placed, no trade row
    // touched; see detectQuantityDrift). Aggregated across every source into
    // ONE ERROR_BURST per pass, same idiom as AccountManager's stale-price /
    // stuck-close escalation — never a second alerting mechanism.
    // Drift is a STATE, not an event: it persists until someone reconciles it,
    // and re-announcing an unchanged, already-known state every cooldown is
    // pure noise (the first version paged every 5 min about the same 7 symbols
    // while their fix was already queued). Page when the state CHANGES — a new
    // symbol, or a quantity that moved — and otherwise only as a rare reminder.
    this.loadDriftState(); // no-op after the first call (or a restart's first pass)
    const allDrift = results.flatMap(r => r.driftAlerts);
    const detail = allDrift.map(d => `${d.symbol} broker=${d.brokerQty} db=${d.dbQty}`).join(", ");
    const fingerprint = allDrift.map(d => `${d.symbol}:${d.brokerQty}:${d.dbQty}`).sort().join("|");
    const symbols = allDrift.map(d => d.symbol).join(", ");

    if (fingerprint === "") {
      // No drift this pass. An unconfirmed candidate that never reached its
      // 2nd (confirming) sync was a 1-cycle blip — drop it silently, exactly
      // the ADA/USD and DIS false alarms this grace period exists to filter.
      if (this.driftCandidateFingerprint) {
        log.info(`📡 transient drift cleared: ${this.driftCandidateSymbols} (gone before the 2nd confirming sync — not paged)`);
        this.driftCandidateFingerprint = null;
        this.driftCandidateSymbols = "";
      }
      if (this.lastDriftFingerprint) {
        log.info(`📡 Qty drift resuelta — broker y DB coinciden en todos los símbolos`);
        this.lastDriftFingerprint = "";
        this.lastQtyDriftAlertAt = 0;
        this.saveDriftState(); // so a later re-appearance pages again, even across a restart
      }
    } else if (fingerprint === this.lastDriftFingerprint) {
      // Matches the CONFIRMED (persisted) drift — same once-a-day reminder
      // behavior as before the grace period existed; nothing new to confirm.
      this.driftCandidateFingerprint = null; // shouldn't normally be set here; drop defensively
      const stale = Date.now() - this.lastQtyDriftAlertAt >= QTY_DRIFT_RENOTIFY_MS;
      if (stale) {
        const windowMs = this.lastQtyDriftAlertAt > 0 ? Date.now() - this.lastQtyDriftAlertAt : 0;
        this.lastQtyDriftAlertAt = Date.now();
        this.saveDriftState();
        log.error(`📡 Qty drift (sin resolver — recordatorio diario): ${detail}`);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "BrokerSync",
          message: `Qty drift — still unresolved for ${allDrift.length} symbol(s): ${detail}. Daily reminder: this is a real broker≠DB discrepancy pending reconciliation, not an expected state.`,
          count: allDrift.length,
          windowMs,
          firstAt: Date.now() - windowMs,
          lastAt: Date.now(),
        });
      } else {
        log.debug(`📡 Qty drift sin cambios (${allDrift.length} símbolos) — ya notificada`);
      }
    } else {
      // New, or different from the CONFIRMED drift. One-cycle grace: page
      // only once the SAME fingerprint is seen on two CONSECUTIVE syncAll()
      // passes (see top-of-file note) — filters the broker/DB persistence
      // race without weakening "any broker≠DB mismatch is a real
      // discrepancy": it's still exactly that, just observed twice first.
      if (this.driftCandidateFingerprint === fingerprint) {
        // Confirmed: seen on this pass AND the immediately-preceding one.
        const windowMs = this.lastQtyDriftAlertAt > 0 ? Date.now() - this.lastQtyDriftAlertAt : 0;
        this.lastQtyDriftAlertAt = Date.now();
        this.lastDriftFingerprint = fingerprint;
        this.saveDriftState();
        this.driftCandidateFingerprint = null;
        this.driftCandidateSymbols = "";
        log.error(`📡 Qty drift (nueva/cambiada, confirmada en 2 syncs consecutivos): ${detail}`);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "BrokerSync",
          message: `Quantity drift detected for ${allDrift.length} symbol(s): ${detail}. Broker≠DB is a REAL discrepancy — a stale DB row, a manual partial close, or a reconciliation bug — needs investigation.`,
          count: allDrift.length,
          windowMs,
          firstAt: Date.now() - windowMs,
          lastAt: Date.now(),
        });
      } else {
        // First sighting of this fingerprint (or it superseded a different,
        // still-unconfirmed candidate) — hold it, don't page yet.
        this.driftCandidateFingerprint = fingerprint;
        this.driftCandidateSymbols = symbols;
        log.debug(`📡 Qty drift candidate, awaiting 2nd confirming sync before paging: ${detail}`);
      }
    }

    // Emit sync complete
    eventBus.emit("sync_complete", {
      timestamp: this.lastSyncAt,
      results: results.map(r => ({
        brokerId: r.brokerId,
        error: r.error,
        changesCount: r.changes.length,
        positionsCount: r.positions.length,
      })),
    });

    // Completed a full sweep (even if all brokers were skipped) — the loop
    // is ALIVE either way. beatFailed when every attempted broker errored
    // (the 09-23/09-25 outage class): liveness stays fresh (no dead-loop
    // page, /healthz 200, no watchdog restart), while heartbeat's
    // consecutive-failure episode tracking pages "broker unreachable" once.
    const attempted = results.length;
    const failed = results.filter(r => r.error).length;
    if (attempted > 0 && failed === attempted) heartbeats.beatFailed("broker_sync");
    else heartbeats.beat("broker_sync");
    return results;
    } finally {
      this.syncing = false;
    }
  }

  private async syncBroker(source: BrokerSyncSource): Promise<SyncResult> {
    const changes: SyncChange[] = [];
    const db = getDB();

    // 1. Sync account data
    const account = await source.getAccount();
    // v8: DO NOT write the deprecated accounts.equity/cash columns. They were
    // read by nobody (loadAccount only reads sleeve ids; the *_main / brokerId
    // rows this used to upsert had zero readers), and truth now lives in
    // equity_snapshots via src/portfolio/truth.ts. Keep the change entry so the
    // dashboard's sync-activity feed still surfaces the broker reading.
    // Both sources return finite margin/cash numbers only (BrokerSync is an
    // operational reconciler, not the account-total owner — see
    // brokerSyncSource.ts) — a null/non-finite reading is a genuine failure.
    if (account.totalEquity === null || account.availableCash === null ||
        !Number.isFinite(account.totalEquity) || !Number.isFinite(account.availableCash)) {
      throw new Error(`${source.name} getAccount returned malformed account`);
    }
    changes.push({ type: "equity_synced", detail: `equity=$${account.totalEquity.toFixed(2)}, cash=$${account.availableCash.toFixed(2)}` });

    // 2. Sync positions
    let brokerPositions: SyncPosition[] = [];
    try {
      brokerPositions = await source.getOpenPositions();
    } catch (e: any) {
      throw new Error(`${source.name} getOpenPositions failed: ${e.message}`);
    }

    // 1b (moved after positions). Asset breakdown — Binance only telemetry
    // (Alpaca source omits the method). It is NOT reconciliation and must
    // never block or fail account/position sync: fire-and-forget with an
    // explicit rejection handler so a hang or throw here can't stall
    // syncAll() or surface as an unhandled rejection.
    if (typeof source.getAssetBreakdown === "function" && !this.assetSyncing.has(source.id)) {
      this.assetSyncing.add(source.id);
      void Promise.resolve()
        .then(() => source.getAssetBreakdown!())
        // replaceAssetBalances (not per-asset upsert): atomically swaps this
        // broker's whole asset set so withdrawn/zeroed collateral is removed
        // instead of lingering. It aborts on an empty array, so a failed/empty
        // fetch can't wipe the existing rows.
        .then(assets => { replaceAssetBalances(source.id, assets); })
        .catch((e: any) => log.warn(`${source.name} getAssetBreakdown failed (non-blocking): ${e.message}`))
        .finally(() => this.assetSyncing.delete(source.id));
    }

    // Build map of broker positions by symbol
    const brokerPosMap = new Map<string, SyncPosition>();
    for (const pos of brokerPositions) {
      brokerPosMap.set(pos.symbol, pos);
    }

    // Quantity-drift detection — runs for EVERY broker position, including
    // sleeve-owned ones the adoption skip below (2b) never looks at. Read-only:
    // no order, no trade mutation. See detectQuantityDrift + top-of-file note.
    const driftAlerts = this.detectQuantityDrift(db, brokerPositions);

    // Get DB open trades for this broker's accounts
    const dbTrades = this.getDbOpenTradesForBroker(db, source.id);

    // 2a. Position in DB but NOT in broker → mark closed
    // Only close sync-inserted trades (id starts with 'sync_') automatically.
    // Bot-managed trades are closed by AccountManager with proper PnL calculation.
    for (const dbTrade of dbTrades) {
      if (!brokerPosMap.has(dbTrade.symbol)) {
        // Same predicate as AccountManager's reconcilers (isSyncOwned, now in
        // db/database.ts). Matching only the sync_ id prefix here meant a UUID
        // row tagged strategy='BROKER_SYNC' was skipped by AccountManager
        // (sync-owned) AND never auto-closed here → open forever.
        if (isSyncOwned(dbTrade)) {
          // Audit fix (2026-05-04): write a sensible pnl/pnl_pct based on the
          // price diff so win-rate stats don't silently exclude these rows.
          // Real broker PnL is unknown; use entry price as exit (pnl=0) only
          // when we genuinely have no other anchor.
          this.markTradeClosed(db, dbTrade.id, dbTrade.entry_price, "SYNC_DETECTED");
          changes.push({
            type: "position_closed",
            symbol: dbTrade.symbol,
            detail: `${dbTrade.symbol} closed on broker, synced to DB`,
          });
          log.info(`📡 Sync: ${dbTrade.symbol} closed on ${source.name} → marking closed in DB`);
          // Use type "close" so the dashboard activity card surfaces this
          // alongside bot-managed closes, plus a "sync" row for traceability.
          insertActivity(dbTrade.account_id, "close", `${dbTrade.symbol} closed externally on ${source.name} (sync-detected)`);
          insertActivity(dbTrade.account_id, "sync", `Position ${dbTrade.symbol} closed on broker`);
        } else {
          // Bot-managed trade: log warning but let AccountManager handle the close
          log.debug(`📡 Sync: ${dbTrade.symbol} (${dbTrade.account_id}) not on broker but is bot-managed — skipping auto-close`);
        }
      }
    }

    // 2b. Position in broker but NOT in DB → insert (only if no sub-account has it)
    const dbSymbols = new Set(dbTrades.map(t => t.symbol));
    for (const [symbol, pos] of brokerPosMap) {
      if (!dbSymbols.has(symbol)) {
        // Ownership boundary (see top-of-file note): a symbol owned by a live
        // sleeve is adopted by that sleeve's own 60s sync (3-min grace). Filing
        // a competing sync_ row under *_main here would leave the position
        // unmanaged by every engine and every stop-loss loop — skip it.
        if (sleeveOwnsSymbol(source.id, symbol)) {
          log.debug(`📡 Sync: ${symbol} is sleeve-owned on ${source.name} — leaving adoption to its per-sleeve sync`);
          continue;
        }
        // Treasury ETF (BOXX/SGOV/BIL — src/treasury/treasurySymbols.ts): owned by
        // the opt-in TreasurySweep, which keeps NO trades row by design
        // (broker truth is its ledger). Adopting it under *_main would file a
        // sync_ row no engine manages and re-flag the position forever after
        // the sweep sells part of it. Never adopted, ON or OFF.
        if (isTreasurySymbol(symbol)) {
          log.debug(`📡 Sync: ${symbol} is the treasury sweep's ETF — never adopted (TreasurySweep owns it, broker truth is its ledger)`);
          continue;
        }
        // Double-check: is there ANY open trade for this symbol across ALL accounts?
        // This prevents duplicates when bot just opened a trade but sync query missed it
        // shadow_* rows are simulated (no broker position behind them) —
        // they must not suppress adoption of a real untracked position.
        const existing = db.prepare(
          `SELECT COUNT(*) as c FROM trades WHERE status = 'open' AND symbol = ? AND account_id NOT LIKE 'shadow_%'`
        ).get(symbol) as any;
        if (existing?.c > 0) {
          log.debug(`📡 Sync: ${symbol} already tracked in another account — skipping insert`);
          continue;
        }
        this.insertBrokerPosition(db, source.id, pos);
        changes.push({
          type: "position_added",
          symbol,
          detail: `${symbol} found on broker, added to DB`,
        });
        log.info(`📡 Sync: ${symbol} found on ${source.name} → inserting into DB`);
        insertActivity(null, "sync", `Found ${symbol} on ${source.name}: ${pos.side} ${pos.quantity} @ $${pos.entryPrice.toFixed(2)}`);
      }
    }

    // 2c. Position in both → live data is served directly from brokerPositions[]
    // (dashboard reads from SyncResult.positions, not from the trades table).
    // No DB write needed here: trades table has no current_price column and
    // emitting noisy position_updated events with no state was a WS payload waste.

    return {
      brokerId: source.id,
      timestamp: Date.now(),
      account,
      positions: brokerPositions,
      changes,
      driftAlerts,
    };
  }

  /** Read-only comparison: broker-reported quantity vs SUM of open DB
   *  quantities for that symbol across every non-shadow account (a symbol can
   *  legitimately be split across sleeves). Never places an order, never
   *  touches a trade row — detection + alerting only, see top-of-file note. */
  private detectQuantityDrift(db: any, brokerPositions: SyncPosition[]): QtyDrift[] {
    const drifts: QtyDrift[] = [];
    for (const pos of brokerPositions) {
      // The treasury ETF deliberately has NO trades row (TreasurySweep reads
      // broker truth directly) — comparing it against the DB would page a
      // permanent phantom "drift" every day the sweep holds anything.
      if (isTreasurySymbol(pos.symbol)) continue;
      const row = db.prepare(
        `SELECT COALESCE(SUM(quantity), 0) as q FROM trades WHERE status = 'open' AND symbol = ? AND account_id NOT LIKE 'shadow_%'`
      ).get(pos.symbol) as { q: number };
      const dbQty = row?.q ?? 0;
      const tolerance = Math.max(QTY_DRIFT_ABS_EPSILON, QTY_DRIFT_REL_EPSILON * Math.max(pos.quantity, dbQty));
      if (Math.abs(pos.quantity - dbQty) > tolerance) {
        drifts.push({ symbol: pos.symbol, brokerQty: pos.quantity, dbQty });
      }
    }
    return drifts;
  }

  // ── SQLite operations ─────────────────────
  // v8: upsertAccountData REMOVED — it wrote the deprecated accounts.equity/cash
  // columns (brokerId + *_main rows) that nothing reads. Truth is equity_snapshots
  // (src/portfolio/truth.ts). See BrokerSync.syncBroker step 1.

  private getDbOpenTradesForBroker(db: any, brokerId: string): any[] {
    // Trades that belong to this broker: the v8 sleeves plus legacy
    // prefixed account ids (alpaca_*/binance_* rows predating v8).
    const isAlpaca = brokerId.includes("alpaca");
    const sleeveIds = isAlpaca ? ["momentum_stocks", "meanrev_stocks"] : ["momentum_crypto"];
    const brokerPrefix = isAlpaca ? "alpaca" : "binance";
    return db.prepare(
      `SELECT * FROM trades WHERE status = 'open' AND (account_id LIKE ? OR account_id IN (${sleeveIds.map(() => "?").join(",")}))`
    ).all(`${brokerPrefix}%`, ...sleeveIds) as any[];
  }

  private markTradeClosed(db: any, tradeId: string, exitPrice: number, closeReason = "SYNC_DETECTED") {
    // Audit fix (2026-05-04): the previous implementation left pnl = NULL
    // forever ("real PnL comes from broker" — but nothing ever filled it in).
    // That excluded these rows from win-rate stats and inflated denominators.
    // We now compute a price-diff-based pnl/pnl_pct as a *best estimate*.
    // For SYNC_DETECTED rows where exitPrice = entry_price the PnL is 0,
    // which is at least defensible and consistent with BROKER_GONE_404.
    const trade = db.prepare(`SELECT * FROM trades WHERE id = ? AND status = 'open'`).get(tradeId) as any;
    if (!trade) return;
    // Canonical formula + guards (pnlOf): finiteness and entry×qty > 0 —
    // this was the fourth close writer and the only one without them.
    const { pnl, pnlPct } = pnlOf(trade.side, trade.entry_price, exitPrice, trade.quantity);
    db.prepare(`
      UPDATE trades SET status = 'closed', exit_price = ?, exit_time = ?, pnl = ?, pnl_pct = ?, close_reason = COALESCE(close_reason, ?)
      WHERE id = ? AND status = 'open'
    `).run(exitPrice, Date.now(), pnl, pnlPct, closeReason, tradeId);
  }

  private insertBrokerPosition(db: any, brokerId: string, pos: SyncPosition) {
    const id = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const side = pos.side; // shim already normalizes to "buy"/"sell" (was "long"/"short" under STACK A)
    const market = pos.symbol.includes("/") ? "crypto" : "stock";
    const accountId = brokerId.includes("alpaca") ? "alpaca_main" : "binance_main";

    db.prepare(`
      INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status, account_id, strategy_version)
      VALUES (?, ?, ?, ?, 'BROKER_SYNC', ?, ?, ?, 'open', ?, 'ops_sync')
    `).run(id, pos.symbol, market, side, pos.entryPrice, pos.quantity, Date.now(), accountId);
  }
}
