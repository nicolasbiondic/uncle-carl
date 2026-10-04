// ══════════════════════════════════════════════
// Telegram outbox — durable retry queue for pages lost to network cuts
// ══════════════════════════════════════════════
//
// 2026-09-25 14:16 UTC: a DNS/network cut ("API sendMessage: fetch timeout
// 15000ms", "getaddrinfo ETIMEOUT api.telegram.org") hit at the exact moment
// the ops pages about that SAME cut were being sent — they were logged and
// lost forever. send()/sendOps() already report honest booleans (data.ok
// checked, one in-band 429 retry), but a false return had nowhere to go.
//
// This queue is the durable layer: a send that failed for a RETRYABLE cause
// (network/parse failure, HTTP 5xx, exhausted 429) is enqueued and retried
// with per-entry exponential backoff until it is ~30 minutes old, then
// discarded loudly. Delivered retries are prefixed "⏱ (retrasado, original
// HH:MM UTC)" so a late page can't masquerade as a fresh one. Permanent 4xx
// (bad chat, malformed HTML…) are never queued — retrying can't fix them.
//
// Bounded and deduplicated BY DESIGN: ≤50 entries (oldest dropped first — in
// a long outage the newest state of the world matters more), one entry per
// (chatId, text). Persisted to data/ (gitignored) with atomic tmp+rename so
// the queue survives the restart that often accompanies a network incident.
// The chat separation (user vs ops) is preserved by queuing the RESOLVED
// chat id — a queued ops page can only ever drain to the ops chat.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { createLogger } from "../utils/logger";

const log = createLogger("TelegramOutbox");

export type SendOutcome = "sent" | "retryable" | "permanent";

export interface OutboxEntry {
  chatId: string;
  text: string;
  /** Epoch ms of the ORIGINAL failure — TTL anchor and "(retrasado …)" stamp. */
  firstFailedAt: number;
  attempts: number;
  /** Backoff gate: drain skips entries not yet due. */
  nextAttemptAt: number;
}

export const OUTBOX_MAX_ENTRIES = 50;
export const OUTBOX_MAX_AGE_MS = 30 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 5 * 60_000;

function hhmmUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

export class TelegramOutbox {
  private entries: OutboxEntry[] = [];

  constructor(
    private path: string,
    private now: () => number = Date.now,
    private maxEntries: number = OUTBOX_MAX_ENTRIES,
    private maxAgeMs: number = OUTBOX_MAX_AGE_MS,
  ) {
    this.load();
  }

  size(): number { return this.entries.length; }
  /** Read-only view for tests/diagnostics. */
  list(): ReadonlyArray<OutboxEntry> { return this.entries; }

  /** Queue a failed send. Returns false when an identical (chatId, text)
   *  entry is already pending — the retry of the FIRST failure covers both. */
  enqueue(chatId: string, text: string): boolean {
    if (this.entries.some(e => e.chatId === chatId && e.text === text)) return false;
    if (this.entries.length >= this.maxEntries) {
      const dropped = this.entries.shift()!;
      log.warn(`outbox full (${this.maxEntries}) — dropped OLDEST queued message from ${hhmmUtc(dropped.firstFailedAt)} UTC: ${dropped.text.slice(0, 80)}`);
    }
    const now = this.now();
    this.entries.push({ chatId, text, firstFailedAt: now, attempts: 0, nextAttemptAt: now });
    this.persist();
    return true;
  }

  /**
   * One drain pass, FIFO. `send` must return the outcome class, never throw.
   * A RETRYABLE failure aborts the pass (the network is still down — hammering
   * the remaining entries only burns the 15s fetch timeout N more times) and
   * pushes that entry's next attempt out exponentially (30s → 60s → … → 5min).
   */
  async drain(send: (chatId: string, text: string) => Promise<SendOutcome>): Promise<void> {
    const now = this.now();
    let dirty = false;
    for (const entry of [...this.entries]) {
      if (now - entry.firstFailedAt > this.maxAgeMs) {
        this.remove(entry);
        dirty = true;
        log.error(`outbox: DISCARDED after >${Math.round(this.maxAgeMs / 60_000)}min unsendable (original ${hhmmUtc(entry.firstFailedAt)} UTC, ${entry.attempts} attempts): ${entry.text.slice(0, 120)}`);
        continue;
      }
      if (entry.nextAttemptAt > now) continue; // backoff not elapsed
      const delayed = `⏱ (retrasado, original ${hhmmUtc(entry.firstFailedAt)} UTC)\n${entry.text}`;
      const outcome = await send(entry.chatId, delayed);
      if (outcome === "sent") {
        this.remove(entry);
        dirty = true;
      } else if (outcome === "permanent") {
        this.remove(entry);
        dirty = true;
        log.error(`outbox: dropped on permanent rejection (original ${hhmmUtc(entry.firstFailedAt)} UTC): ${entry.text.slice(0, 120)}`);
      } else {
        entry.attempts += 1;
        entry.nextAttemptAt = now + Math.min(BACKOFF_BASE_MS * 2 ** (entry.attempts - 1), BACKOFF_CAP_MS);
        dirty = true;
        break; // network still down — end this pass
      }
    }
    if (dirty) this.persist();
  }

  private remove(entry: OutboxEntry): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
  }

  /** Corrupted/missing file → start empty with a WARN; a broken queue file
   *  must never take the reporter (or the process) down. */
  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      if (!Array.isArray(raw)) throw new Error("not an array");
      this.entries = raw.filter((e: any) =>
        e && typeof e.chatId === "string" && typeof e.text === "string" &&
        Number.isFinite(e.firstFailedAt) && Number.isFinite(e.attempts) && Number.isFinite(e.nextAttemptAt),
      ).slice(0, this.maxEntries);
      if (this.entries.length > 0) log.info(`outbox: reloaded ${this.entries.length} undelivered message(s) from ${this.path}`);
    } catch (e: any) {
      log.warn(`outbox: ${this.path} unreadable/corrupt (${e?.message ?? e}) — starting empty`);
      this.entries = [];
    }
  }

  /** Atomic tmp+rename so a crash mid-write can't corrupt the queue. */
  private persist(): void {
    try {
      const dir = dirname(this.path);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true } as any); // repo-wide idiom (database.ts): stale fs typings lack the options overload
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.entries, null, 2));
      renameSync(tmp, this.path);
    } catch (e: any) {
      log.warn(`outbox: persist failed (${e?.message ?? e}) — queue continues in memory only`);
    }
  }
}
