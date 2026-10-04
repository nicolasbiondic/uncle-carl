import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
// Stale @types/node in this repo lacks rmSync (same class as the mkdirSync
// options idiom in database.ts) — runtime has it, typings don't.
const { rmSync } = require("fs") as { rmSync: (p: string, o?: any) => void };
import { join } from "path";
import { tmpdir } from "os";
import { TelegramOutbox, OUTBOX_MAX_ENTRIES, type SendOutcome } from "./outbox";
import { TelegramReporter } from "./telegram-reporter";

function withTmp<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tg-outbox-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// A sender that records every (chatId, text) and returns scripted outcomes.
function scriptedSender(outcomes: SendOutcome[] | SendOutcome) {
  const calls: Array<{ chatId: string; text: string }> = [];
  const send = async (chatId: string, text: string): Promise<SendOutcome> => {
    calls.push({ chatId, text });
    return Array.isArray(outcomes) ? (outcomes[calls.length - 1] ?? outcomes[outcomes.length - 1]) : outcomes;
  };
  return { calls, send };
}

describe("TelegramOutbox — durable retry queue (2026-09-25 lost-pages class)", () => {
  test("enqueue + drain delivers with the '(retrasado, original HH:MM UTC)' marker and empties the queue", () => withTmp(async dir => {
    let t = Date.parse("2026-09-25T14:16:00Z");
    const box = new TelegramOutbox(join(dir, "outbox.json"), () => t);
    expect(box.enqueue("OPS", "🚨 broker unreachable")).toBe(true);
    t += 60_000;
    const { calls, send } = scriptedSender("sent");
    await box.drain(send);
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe("OPS");
    expect(calls[0].text).toContain("(retrasado, original 14:16 UTC)");
    expect(calls[0].text).toContain("🚨 broker unreachable");
    expect(box.size()).toBe(0);
  }));

  test("dedupe: an identical (chatId, text) pending entry is not enqueued twice; same text to ANOTHER chat is", () => withTmp(async dir => {
    const box = new TelegramOutbox(join(dir, "outbox.json"), () => 1000);
    expect(box.enqueue("OPS", "same page")).toBe(true);
    expect(box.enqueue("OPS", "same page")).toBe(false);
    expect(box.enqueue("USER", "same page")).toBe(true);
    expect(box.size()).toBe(2);
  }));

  test("bounded at 50: overflow drops the OLDEST entry", () => withTmp(async dir => {
    let t = 0;
    const box = new TelegramOutbox(join(dir, "outbox.json"), () => t);
    for (let i = 0; i < OUTBOX_MAX_ENTRIES + 3; i++) { t = i * 1000; box.enqueue("OPS", `msg ${i}`); }
    expect(box.size()).toBe(OUTBOX_MAX_ENTRIES);
    expect(box.list()[0].text).toBe("msg 3"); // 0..2 dropped, oldest first
    expect(box.list()[OUTBOX_MAX_ENTRIES - 1].text).toBe(`msg ${OUTBOX_MAX_ENTRIES + 2}`);
  }));

  test(">30min old is discarded WITHOUT a send attempt", () => withTmp(async dir => {
    let t = 0;
    const box = new TelegramOutbox(join(dir, "outbox.json"), () => t);
    box.enqueue("OPS", "stale page");
    t = 31 * 60_000;
    const { calls, send } = scriptedSender("sent");
    await box.drain(send);
    expect(calls).toHaveLength(0);
    expect(box.size()).toBe(0);
  }));

  test("a retryable failure ends the pass (network still down), applies backoff, keeps the entry; a permanent one drops it", () => withTmp(async dir => {
    let t = 0;
    const box = new TelegramOutbox(join(dir, "outbox.json"), () => t);
    box.enqueue("OPS", "first");
    box.enqueue("OPS", "second");
    t = 1000;
    const r1 = scriptedSender("retryable");
    await box.drain(r1.send);
    expect(r1.calls).toHaveLength(1); // pass aborted after the first retryable
    expect(box.size()).toBe(2);
    expect(box.list()[0].attempts).toBe(1);
    expect(box.list()[0].nextAttemptAt).toBe(1000 + 30_000); // 30s backoff
    // Before the backoff elapses, the first entry is skipped but the SECOND is due.
    t = 10_000;
    const r2 = scriptedSender("sent");
    await box.drain(r2.send);
    expect(r2.calls).toHaveLength(1);
    expect(r2.calls[0].text).toContain("second");
    expect(box.size()).toBe(1);
    // Permanent rejection drops the survivor for good.
    t = 60_000;
    const r3 = scriptedSender("permanent");
    await box.drain(r3.send);
    expect(box.size()).toBe(0);
  }));

  test("persists across construction (survives a restart), atomically", () => withTmp(async dir => {
    const path = join(dir, "outbox.json");
    const a = new TelegramOutbox(path, () => 5000);
    a.enqueue("OPS", "queued before the restart");
    const reborn = new TelegramOutbox(path, () => 6000);
    expect(reborn.size()).toBe(1);
    expect(reborn.list()[0].text).toBe("queued before the restart");
    expect(reborn.list()[0].firstFailedAt).toBe(5000);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toHaveLength(1);
  }));

  test("a corrupt file starts empty instead of crashing", () => withTmp(async dir => {
    const path = join(dir, "outbox.json");
    writeFileSync(path, "{not json![");
    const box = new TelegramOutbox(path, () => 0);
    expect(box.size()).toBe(0);
    expect(box.enqueue("OPS", "still works")).toBe(true);
  }));
});

// ── Reporter integration: classification + chat separation ─────────────────
describe("TelegramReporter × outbox — what queues, what doesn't, and to which chat it drains", () => {
  function reporterWithOutbox(dir: string) {
    const reporter = new TelegramReporter();
    (reporter as any).enabled = true;
    (reporter as any).token = "1234567890:FAKE-TEST-TOKEN-ABCDEFGHIJK";
    (reporter as any).chatId = "USER";
    (reporter as any).opsChatId = "OPS";
    const outbox = new TelegramOutbox(join(dir, "outbox.json"));
    (reporter as any).outbox = outbox;
    return { reporter, outbox };
  }

  test("network failure queues (to the resolved chat) and a later drain delivers to that SAME chat, delayed-marked", () => withTmp(async dir => {
    const { reporter, outbox } = reporterWithOutbox(dir);
    const realFetch = globalThis.fetch;
    const delivered: Array<{ url: string; body: any }> = [];
    let down = true;
    globalThis.fetch = (async (url: any, init: any) => {
      if (down) throw new Error("getaddrinfo ETIMEOUT api.telegram.org");
      delivered.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: {} }, { status: 200 });
    }) as any;
    try {
      // sendOps → resolved to the OPS chat, fails on the dead network, queues.
      expect(await (reporter as any).sendOps("🚨 página perdida 14:16")).toBe(false);
      expect(outbox.size()).toBe(1);
      expect(outbox.list()[0].chatId).toBe("OPS");
      // Network returns; the drain delivers to OPS — never the user chat.
      down = false;
      await (reporter as any).drainOutbox();
      expect(outbox.size()).toBe(0);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].body.chat_id).toBe("OPS");
      expect(delivered[0].body.text).toContain("(retrasado, original");
      expect(delivered[0].body.text).toContain("página perdida 14:16");
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

  test("a permanent 400 does NOT queue (retrying can't fix a bad request)", () => withTmp(async dir => {
    const { reporter, outbox } = reporterWithOutbox(dir);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ ok: false, error_code: 400, description: "chat not found" }, { status: 400 })) as any;
    try {
      expect(await reporter.send("hola")).toBe(false);
      expect(outbox.size()).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

  test("a 5xx queues; an exhausted 429 queues", () => withTmp(async dir => {
    const { reporter, outbox } = reporterWithOutbox(dir);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ ok: false, error_code: 502 }, { status: 502 })) as any;
    try {
      expect(await reporter.send("cinco-equis-equis")).toBe(false);
      expect(outbox.size()).toBe(1);
      expect(outbox.list()[0].chatId).toBe("USER");
      // Exhausted 429 (both attempts limited) — also retryable.
      globalThis.fetch = (async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0 } }, { status: 429 })) as any;
      expect(await reporter.send("rate-limited page")).toBe(false);
      expect(outbox.size()).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));
});
