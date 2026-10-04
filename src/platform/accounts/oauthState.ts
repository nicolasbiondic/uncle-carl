// ═══ In-memory OAuth state store — TTL'd, session-bound, single-use ═══
//
// Protects the Alpaca Connect callback against CSRF/code injection: the
// `state` we send to Alpaca must come back verbatim, within the TTL, on the
// SAME dashboard session that started the flow, and is consumed on first
// use (replay = rejection). In-memory is correct for a single-process,
// single-owner installation: a restart mid-flow just means redoing the
// click, no secret is lost.

import crypto from "crypto";

export interface PendingOAuth {
  state: string;
  sessionId: string;
  env: "paper" | "live";
  label: string;
  createdAt: number;
}

export const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60_000;

export class OAuthStateStore {
  private pending = new Map<string, PendingOAuth>();

  constructor(
    private ttlMs: number = DEFAULT_OAUTH_STATE_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  issue(sessionId: string, env: "paper" | "live", label: string): string {
    this.prune();
    const state = crypto.randomBytes(24).toString("hex");
    this.pending.set(state, { state, sessionId, env, label, createdAt: this.now() });
    return state;
  }

  /** Single-use: the entry is deleted whether or not it matches, so a bad
   *  session guess also burns the state instead of leaving it retryable. */
  consume(state: string, sessionId: string): PendingOAuth | null {
    this.prune();
    const entry = this.pending.get(state);
    if (entry) this.pending.delete(state);
    if (!entry || entry.sessionId !== sessionId) return null;
    return entry;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.pending) if (v.createdAt < cutoff) this.pending.delete(k);
  }
}
