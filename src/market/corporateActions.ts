// ══════════════════════════════════════════════
// CorporateActions — Alpaca corporate-actions feed + daily pre-open monitor
// ══════════════════════════════════════════════
//
// Why this exists (docs.alpaca.markets, verified 2026-08-03):
//  - Reverse split: "all GTC orders will be canceled that were in the market
//    with a trade date prior to the effective date" — our broker-native GTC
//    stop DISAPPEARS silently, leaving the position naked outside RTH.
//  - Forward split: "GTC buy limits and sell stops are adjusted. The price
//    and quantity will be adjusted" — the stop survives broker-side (our
//    order goes `replaced`, chain via `replaced_by`), but our DB row keeps
//    pre-split entry/qty.
//  - Alpaca's own caveat: "there may be delays ... corporate actions may not
//    be available immediately after they are announced" — this feed is an
//    ADVISORY, never the only defense. The per-status stop reconciliation in
//    AccountManager (canceled → re-place, replaced → adopt) works even when
//    this endpoint never says a word.
//
// Everything here FAILS OPEN: a dead endpoint returns null ("couldn't
// check" ≠ "no events"), logs a warn, and never blocks trading.

import { config } from "../config";
import { getETDateKey } from "../db/database";
import { fetchT } from "../utils/timeout";
import { heartbeats } from "../ops/heartbeat";
import { createLogger } from "../utils/logger";

const log = createLogger("CorporateActions");

export type FetchFn = (url: string, opts?: RequestInit, timeoutMs?: number) => Promise<Response>;

/** F4a: injected Alpaca data-API credentials (ACCOUNTS_SOURCE=registry).
 *  Absent = env mode — config.alpaca.* exactly as before. */
export interface AlpacaDataAuth {
  dataUrl: string;
  headers: Record<string, string>;
}

/** The event types that can cancel/adjust our GTC stops or break position
 *  continuity. Deliberately NO dividends here: a cash dividend adjusts bars
 *  (handled by `adjustment=all` in getBars) but neither cancels orders nor
 *  changes share counts, so it needs no stop/row reconciliation. */
export const CORPORATE_ACTION_TYPES = [
  "forward_split", "reverse_split", "spin_off", "stock_merger",
  "cash_merger", "stock_and_cash_merger", "name_change", "worthless_removal",
] as const;
export type CorporateActionType = (typeof CORPORATE_ACTION_TYPES)[number];

export interface CorporateActionEvent {
  /** The HELD symbol this event touches (old/source/acquiree side). */
  symbol: string;
  type: CorporateActionType;
  /** YYYY-MM-DD — the date the market price/orders reflect the action. */
  exDate: string;
  processDate?: string;
  oldRate?: number;
  newRate?: number;
  /** new_rate / old_rate: forward 1→2 split ⇒ 2 (qty ×2, price ÷2);
   *  reverse 10→1 ⇒ 0.1. Undefined for non-split types. */
  ratio?: number;
  raw: unknown;
}

/** Response arrays are keyed by pluralized type. */
const TYPE_BY_RESPONSE_KEY: Record<string, CorporateActionType> = {
  forward_splits: "forward_split",
  reverse_splits: "reverse_split",
  spin_offs: "spin_off",
  stock_mergers: "stock_merger",
  cash_mergers: "cash_merger",
  stock_and_cash_mergers: "stock_and_cash_merger",
  name_changes: "name_change",
  worthless_removals: "worthless_removal",
};

/** Pull the symbol this event touches from the type-dependent field names
 *  (splits: `symbol`; name changes: `old_symbol`; spin-offs: `source_symbol`;
 *  mergers: `acquiree_symbol`), preferring one we actually hold. */
function eventSymbol(r: any, held: Set<string>): string | null {
  const candidates = [r?.symbol, r?.old_symbol, r?.source_symbol, r?.acquiree_symbol, r?.new_symbol, r?.acquirer_symbol]
    .filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
  return candidates.find(s => held.has(s)) ?? null;
}

/**
 * GET https://data.alpaca.markets/v1/corporate-actions for `symbols` in the
 * [start, end] date window (YYYY-MM-DD, inclusive), normalized to
 * CorporateActionEvent. Paginates via next_page_token.
 *
 * Returns `[]` for a clean "no events" answer and `null` when the check
 * itself failed (network/HTTP/shape) — callers must treat null as UNKNOWN,
 * never as "nothing happened".
 */
export async function fetchCorporateActions(
  symbols: string[],
  start: string,
  end: string,
  fetchFn: FetchFn = fetchT,
  auth?: AlpacaDataAuth,
): Promise<CorporateActionEvent[] | null> {
  if (symbols.length === 0) return [];
  const dataUrl = auth?.dataUrl ?? config.alpaca.dataUrl;
  const headers = auth?.headers ?? {
    "APCA-API-KEY-ID": config.alpaca.keyId,
    "APCA-API-SECRET-KEY": config.alpaca.secretKey,
  };
  const held = new Set(symbols);
  const events: CorporateActionEvent[] = [];
  try {
    let pageToken: string | undefined;
    for (let page = 0; page < 8; page++) {
      const params = new URLSearchParams({
        symbols: symbols.join(","),
        types: CORPORATE_ACTION_TYPES.join(","),
        start,
        end,
        limit: "1000",
      });
      if (pageToken) params.set("page_token", pageToken);
      // Same credential pattern as alpaca-executor's raw data-API fetches
      // (dataUrl + auth headers, injected in registry mode), same
      // bounded-timeout fetchT.
      const resp = await fetchFn(`${dataUrl}/v1/corporate-actions?${params}`, {
        headers,
      }, 15_000);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const data = await resp.json() as any;
      const groups = data?.corporate_actions ?? {};
      for (const [key, rows] of Object.entries(groups)) {
        const type = TYPE_BY_RESPONSE_KEY[key];
        if (!type || !Array.isArray(rows)) continue;
        for (const r of rows as any[]) {
          const symbol = eventSymbol(r, held);
          const exDate = r?.ex_date ?? r?.process_date ?? r?.effective_date ?? r?.payable_date;
          if (!symbol || typeof exDate !== "string") continue; // unusable — skip, don't guess
          const oldRate = Number(r?.old_rate);
          const newRate = Number(r?.new_rate);
          const hasRates = Number.isFinite(oldRate) && Number.isFinite(newRate) && oldRate > 0 && newRate > 0;
          events.push({
            symbol, type, exDate,
            processDate: typeof r?.process_date === "string" ? r.process_date : undefined,
            oldRate: hasRates ? oldRate : undefined,
            newRate: hasRates ? newRate : undefined,
            ratio: hasRates ? newRate / oldRate : undefined,
            raw: r,
          });
        }
      }
      pageToken = data?.next_page_token || undefined;
      if (!pageToken) break;
    }
    return events;
  } catch (e: any) {
    // Fail-open: a broken advisory feed must never break trading. null tells
    // the caller the answer is UNKNOWN (the per-status stop reconciliation
    // remains the defense that needs no feed at all).
    log.warn(`corporate-actions fetch failed (fail-open, advisory only): ${e?.message ?? e}`);
    return null;
  }
}

// ── Daily pre-open monitor ─────────────────────────────────────────────────

/** How far back the daily check looks. 5 calendar days covers a weekend plus
 *  Alpaca's documented announcement delays and any bot downtime — a past
 *  event is applied idempotently (DB ledger), so re-seeing it is free. */
export const CA_LOOKBACK_DAYS = 5;
/** How far ahead the daily check warns. */
export const CA_LOOKAHEAD_DAYS = 7;
/** Daily run threshold, ET. 08:00 ET is deliberate: AFTER Alpaca's
 *  Beginning-of-Day job (02:15–02:30 ET) has applied splits to positions and
 *  orders — so a past-ex_date event is reconciled against already-adjusted
 *  broker state — and BEFORE the 09:30 open, so both the alert and the
 *  forced stop re-verification land before any trading decision. */
export const CA_DAILY_RUN_HOUR_ET = 8;
/** Scheduler tick — each tick just checks "is the daily run due yet". */
export const CA_TICK_MS = 15 * 60_000;

const ET_HOUR_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", hour12: false,
});

export function getETHour(now: number = Date.now()): number {
  const h = Number(ET_HOUR_FMT.format(new Date(now)));
  return h === 24 ? 0 : h; // Intl quirk: midnight can format as "24"
}

/** True when today's (ET) run hasn't happened yet AND it's at/after the
 *  pre-open threshold hour. DST-safe via Intl (never setHours math). */
export function dailyRunDue(lastRunKey: string, now: number = Date.now()): boolean {
  return getETDateKey(now) !== lastRunKey && getETHour(now) >= CA_DAILY_RUN_HOUR_ET;
}

export interface CorporateActionsMonitorDeps {
  /** Symbols with an open Alpaca STOCK row (any sleeve) — the only universe
   *  worth paying the endpoint for. */
  getHeldStockSymbols: () => string[];
  /** Side effects live with the position bookkeeper (AccountManager):
   *  "upcoming" = alert only; "past" = invalidate bar caches, apply split
   *  ratios to rows (idempotent), force stop re-verification. */
  onEvent: (ev: CorporateActionEvent, phase: "past" | "upcoming") => Promise<void> | void;
  fetchFn?: FetchFn;
  nowFn?: () => number;
  /** F4a: registry-mode Alpaca data credentials; absent = env/config. */
  auth?: AlpacaDataAuth;
}

export class CorporateActionsMonitor {
  private readonly deps: CorporateActionsMonitorDeps;
  private readonly nowFn: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private lastRunKey = "";

  constructor(deps: CorporateActionsMonitorDeps) {
    this.deps = deps;
    this.nowFn = deps.nowFn ?? Date.now;
  }

  start(): void {
    // Liveness only pages on a wedged loop, never on a dead endpoint (the
    // fetch fails open by contract) — same idiom as FundingMonitor.
    heartbeats.register("corporate_actions", CA_TICK_MS, { graceMultiplier: 4 });
    // Startup catch-up: a restart must not skip a missed check. Before the
    // 08:00 ET threshold this run does NOT claim the day, so the regular
    // post-BOD run still happens once the threshold passes.
    void this.tick(true);
    this.timer = setInterval(() => void this.tick(false), CA_TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
    log.info(`started — daily check ≥${String(CA_DAILY_RUN_HOUR_ET).padStart(2, "0")}:00 ET (−${CA_LOOKBACK_DAYS}d…+${CA_LOOKAHEAD_DAYS}d window, tick ${CA_TICK_MS / 60_000}min)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(startup: boolean): Promise<void> {
    try {
      const now = this.nowFn();
      if (startup || dailyRunDue(this.lastRunKey, now)) {
        if (getETHour(now) >= CA_DAILY_RUN_HOUR_ET) this.lastRunKey = getETDateKey(now);
        await this.runOnce();
      }
    } catch (e: any) {
      log.warn(`corporate-actions check failed (fail-open): ${e?.message ?? e}`);
    }
    heartbeats.beat("corporate_actions");
  }

  /** One full check: fetch the window for every held stock symbol and hand
   *  each event to the callback with its past/upcoming phase. Fail-open at
   *  every layer — a callback throwing for one event must not starve the
   *  rest. Exposed for tests and for a forced manual run. */
  async runOnce(): Promise<void> {
    const symbols = this.deps.getHeldStockSymbols();
    if (symbols.length === 0) {
      log.debug("no held stock symbols — corporate-actions check skipped");
      return;
    }
    const now = this.nowFn();
    const todayKey = getETDateKey(now);
    const start = getETDateKey(now - CA_LOOKBACK_DAYS * 86_400_000);
    const end = getETDateKey(now + CA_LOOKAHEAD_DAYS * 86_400_000);
    const events = await fetchCorporateActions(symbols, start, end, this.deps.fetchFn, this.deps.auth);
    if (events === null) return; // UNKNOWN — already warned; never "no events"
    if (events.length > 0) {
      log.warn(`🏛 ${events.length} corporate action(s) in [${start} … ${end}] touching held symbols: ${events.map(e => `${e.symbol}:${e.type}@${e.exDate}`).join(", ")}`);
    }
    for (const ev of events) {
      const phase = ev.exDate <= todayKey ? "past" as const : "upcoming" as const;
      try {
        await this.deps.onEvent(ev, phase);
      } catch (e: any) {
        log.error(`corporate-action handler failed for ${ev.symbol} ${ev.type}@${ev.exDate} (${phase}): ${e?.message ?? e}`);
      }
    }
  }
}
