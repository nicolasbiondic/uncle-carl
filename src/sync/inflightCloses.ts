// ═══ In-flight engine-close registry (P0 fix, 2026-10-09) ═══
//
// Incident 2026-10-02: three momentum_crypto closes (SOL 08:00:17, XRP
// 15:00:18, SOL 16:00:18 UTC) were labeled MANUAL_CLOSE by the 60s broker
// sync. The engine had just closed them at the decision minute: the broker
// was already flat, but BinanceMomentumAdapter.closePosition hadn't written
// its DB close yet, so the reconciler's "open in DB, flat on broker" pass
// attributed the engine's OWN fills and labeled them MANUAL_CLOSE — the log
// "📡 MANUAL_CLOSE closed … [momentum_crypto]" lands 2–3 s after the
// decision. The P&L was correct; the attribution falsified the funnel.
//
// Fix: the adapter registers (portfolio, symbol) here BEFORE submitting the
// broker close and clears it (finally) once its DB write settles; the
// reconciler leaves such a row alone while the entry is fresh. Entries are
// TIME-BOUNDED (INFLIGHT_CLOSE_MAX_AGE_MS): an adapter that dies mid-close
// stops blocking reconciliation after the window, and the normal
// UnreconciledGrace path then closes the row — truth-vs-DB convergence is
// delayed by at most the window, never lost. Broker = truth is untouched:
// nothing here changes WHAT closes, only WHO writes the row's close.

const inflight = new Map<string, number>();

const keyOf = (accountId: string, symbol: string) => `${accountId}|${symbol}`;

/** An engine close older than this no longer blocks reconciliation — covers
 *  an adapter that crashed between the broker fill and its DB write. Must be
 *  comfortably longer than one close round-trip and shorter than the ~5
 *  sync cycles the UnreconciledGrace already tolerates. */
export const INFLIGHT_CLOSE_MAX_AGE_MS = 2 * 60_000;

/** Called by an engine adapter right BEFORE the broker close is submitted. */
export function beginEngineClose(accountId: string, symbol: string, now: number = Date.now()): void {
  inflight.set(keyOf(accountId, symbol), now);
}

/** Called by the adapter once its DB close write settled (success OR failure
 *  — on failure the reconciler is exactly who must take over). */
export function endEngineClose(accountId: string, symbol: string): void {
  inflight.delete(keyOf(accountId, symbol));
}

/** True while an engine close for this portfolio+symbol is fresh in flight. */
export function hasInflightEngineClose(accountId: string, symbol: string, now: number = Date.now()): boolean {
  const at = inflight.get(keyOf(accountId, symbol));
  if (at === undefined) return false;
  if (now - at > INFLIGHT_CLOSE_MAX_AGE_MS) {
    inflight.delete(keyOf(accountId, symbol));
    return false;
  }
  return true;
}

export function resetInflightClosesForTests(): void {
  inflight.clear();
}
