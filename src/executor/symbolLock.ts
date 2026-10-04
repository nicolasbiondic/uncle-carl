// ══════════════════════════════════════════════
// Per-(venue, symbol) mutation lock (2026-08-06)
// ══════════════════════════════════════════════
//
// Motivation: the DB side of a close is a correct compare-and-swap
// (closeTrade's WHERE status='open' transaction — a row can never close
// twice), but the BROKER side never was: the 15s stop-loss loop
// (AccountManager.closeTradeDirectly → executor.closePosition) and an
// engine rebalance can both transmit a sell for the SAME symbol before
// either writes to the DB. closePosition bounds itself to min(our qty,
// broker qty) by RE-READING the broker — but two concurrent callers read
// the SAME broker qty, so both bounds pass and the position is sold twice:
// an accidental short. This module serializes MUTATING broker actions
// (open / close / place-or-cancel stop) per (venue, symbol).
//
// Semantics — chosen and enforced by symbolLock.test.ts:
//  - Scope: MUTATIONS only. Reads (prices, enumerations, positions) are
//    never routed through the lock — serializing them would slow the very
//    loops the lock exists to protect.
//  - Bounded acquisition, never a hang: a waiter that can't get the lock
//    within timeoutMs resolves to an explicit denial (null / the caller's
//    onTimeout result, which the executors map into their existing failure
//    shapes — proven_failed in the OrderOutcome taxonomy, since nothing was
//    transmitted). The 15s/60s loops simply retry later, by which time the
//    winning mutation has finished and the broker re-read tells the truth.
//  - NOT reentrant, BY DESIGN: the executors take the lock ONLY at their
//    public mutating entry points (placeOrder / closePosition /
//    placeStop* / cancel*), and every internal step those bodies share is
//    an UNLOCKED private core (e.g. BinanceExecutor.cancelAllOrders is a
//    locked wrapper over cancelAllOrdersCore; closePosition calls the
//    core). So a lock holder never re-enters acquire() for its own key. If
//    a future edit violates that, the failure mode is a bounded, loudly
//    logged timeout — never a silent deadlock (fixed by the "nested acquire
//    times out with an explicit denial" test).
//  - Holder crash-safety: release() sits in `finally` at every call site
//    and is idempotent. There is deliberately NO forced expiry of a live
//    holder — force-releasing while the first close is still in flight
//    would recreate the exact double-sell this lock exists to prevent.

import { createLogger } from "../utils/logger";

const log = createLogger("SymbolLock");

export const DEFAULT_SYMBOL_LOCK_TIMEOUT_MS = 10_000;

export interface SymbolLockMetricsSnapshot {
  acquires: number;
  contentions: number;
  timeouts: number;
  held: number;
}

interface Waiter {
  done: boolean;
  label: string;
  timer: ReturnType<typeof setTimeout> | null;
  grant: () => void;
}

interface KeyState {
  holderLabel: string;
  since: number;
  queue: Waiter[];
}

export type ReleaseFn = () => void;

/** `alpaca:DOGE/USD` and `alpaca:DOGEUSD` are the same position — normalize
 *  so both spellings contend on the same key. Venues never collide (the key
 *  is prefixed) and the two FAPI instances can't either (their internal
 *  symbols are disjoint: BTC/USD vs BTC/USDC). */
function lockKey(venue: string, symbol: string): string {
  return `${venue}:${symbol.replace(/\//g, "").toUpperCase()}`;
}

export class SymbolLockRegistry {
  private locks = new Map<string, KeyState>();
  private m = { acquires: 0, contentions: 0, timeouts: 0 };

  /**
   * Acquire the mutation lock for (venue, symbol). Resolves to a release
   * function, or to null when the lock could not be acquired within
   * timeoutMs — an explicit, bounded denial, never a hang.
   */
  async acquire(venue: string, symbol: string, opts: { timeoutMs?: number; label?: string } = {}): Promise<ReleaseFn | null> {
    const key = lockKey(venue, symbol);
    const label = opts.label ?? "";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SYMBOL_LOCK_TIMEOUT_MS;
    this.m.acquires++;

    const existing = this.locks.get(key);
    if (!existing) {
      this.locks.set(key, { holderLabel: label, since: Date.now(), queue: [] });
      return this.makeRelease(key);
    }

    this.m.contentions++;
    return new Promise<ReleaseFn | null>((resolve) => {
      const w: Waiter = { done: false, label, timer: null, grant: () => {} };
      w.grant = () => {
        if (w.done) return;
        w.done = true;
        if (w.timer) clearTimeout(w.timer);
        resolve(this.makeRelease(key));
      };
      w.timer = setTimeout(() => {
        if (w.done) return;
        w.done = true;
        this.m.timeouts++;
        const st = this.locks.get(key);
        log.warn(`lock timeout on ${key} after ${timeoutMs}ms (wanted by "${label}", held by "${st?.holderLabel ?? "?"}" for ${st ? Date.now() - st.since : 0}ms) — caller gets an explicit denial`);
        resolve(null);
      }, timeoutMs);
      (w.timer as any)?.unref?.();
      existing.queue.push(w);
    });
  }

  private makeRelease(key: string): ReleaseFn {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;
      const st = this.locks.get(key);
      if (!st) return;
      // Hand off to the first waiter still alive (FIFO), else free the key.
      while (st.queue.length > 0) {
        const next = st.queue.shift()!;
        if (!next.done) {
          st.holderLabel = next.label;
          st.since = Date.now();
          next.grant();
          return;
        }
      }
      this.locks.delete(key);
    };
  }

  /**
   * Run `fn` under the (venue, symbol) mutation lock. On acquisition
   * timeout, `onTimeout` produces the caller's explicit failure result —
   * nothing was transmitted, so proven_failed shapes are safe.
   */
  async withLock<T, F>(
    venue: string,
    symbol: string,
    opts: { timeoutMs?: number; label?: string },
    fn: () => Promise<T>,
    onTimeout: () => F,
  ): Promise<T | F> {
    const release = await this.acquire(venue, symbol, opts);
    if (!release) return onTimeout();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  metrics(): SymbolLockMetricsSnapshot {
    return { ...this.m, held: this.locks.size };
  }

  /** TEST-ONLY: drop all lock state and counters. */
  __resetForTests(): void {
    this.locks.clear();
    this.m = { acquires: 0, contentions: 0, timeouts: 0 };
  }
}

/** The shared registry every executor uses — one lock space per process. */
export const symbolLocks = new SymbolLockRegistry();

export function symbolLockMetrics(): SymbolLockMetricsSnapshot {
  return symbolLocks.metrics();
}
