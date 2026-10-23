import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
// Stale @types/node in this repo lacks rmSync (same class as the mkdirSync
// options idiom in database.ts) — runtime has it, typings don't.
const { rmSync } = require("fs") as { rmSync: (p: string, o?: any) => void };
import { join } from "path";
import { tmpdir } from "os";
import { TelegramOutbox, OUTBOX_MAX_ENTRIES, type SendOutcome } from "./outbox";
import { TelegramReporter } from "./telegram-reporter";
import { eventBus, EVENTS } from "../utils/events";

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

describe("TelegramReporter boot connection recovery", () => {
  // Fake only this reporter's HTTP/timers; no real API calls, sleeps or data/ writes.
  async function bootTest(fn: (h: any) => Promise<void>) {
    await withTmp(async dir => {
      const cwd = process.cwd();
      process.chdir(dir);
      const reporter = new TelegramReporter();
      const r = reporter as any;
      r.token = "1234567890:FAKE-TEST-TOKEN-ABCDEFGHIJK";
      r.chatId = "USER";
      r.opsChatId = "OPS";
      const boxPath = join(dir, "outbox.json");
      const outbox = new TelegramOutbox(boxPath);
      r.outbox = outbox;
      const timers = new Map<any, { fn: () => any; ms: number }>();
      const intervals = new Map<any, { fn: () => any; ms: number }>();
      let id = 0;
      const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms: number) => {
        const key = ++id; timers.set(key, { fn, ms }); return key;
      }) as any);
      const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((key: any) => { timers.delete(key); }) as any);
      const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: any, ms: number) => {
        const key = ++id; intervals.set(key, { fn, ms }); return key;
      }) as any);
      const clearInt = spyOn(globalThis, "clearInterval").mockImplementation(((key: any) => { intervals.delete(key); }) as any);
      const logs: string[] = [];
      const logger = spyOn(console, "log").mockImplementation((s: any) => { logs.push(String(s)); });
      const calls: Array<{ method: string; body: any }> = [];
      let probe: () => Promise<Response> = async () => Response.json({ ok: true, result: { username: "test_bot" } });
      const http = spyOn(globalThis, "fetch").mockImplementation((async (url: any, init: any) => {
        const method = String(url).split("/").pop()!;
        calls.push({ method, body: init.body ? JSON.parse(init.body) : null });
        return method === "getMe" ? probe() : Response.json({ ok: true, result: [] });
      }) as any);
      const events = [EVENTS.ORDER_FILLED, EVENTS.POSITION_CLOSED, EVENTS.CIRCUIT_BREAKER, EVENTS.ERROR_BURST];
      const before = events.map(e => eventBus.listeners(e));
      try {
        await fn({ reporter, r, outbox, boxPath, timers, intervals, logs, calls,
          setProbe: (p: typeof probe) => { probe = p; },
          retry: async () => {
            expect(timers.size).toBe(1);
            const [key, timer] = [...timers][0];
            timers.delete(key);
            await timer.fn();
          },
          listenerCounts: () => events.map((e, i) => eventBus.listenerCount(e) - before[i].length),
        });
      } finally {
        reporter.stop();
        events.forEach((e, i) => {
          for (const listener of eventBus.listeners(e)) if (!before[i].includes(listener)) eventBus.removeListener(e, listener as (...args: any[]) => void);
        });
        http.mockRestore(); logger.mockRestore(); timeout.mockRestore(); clear.mockRestore(); interval.mockRestore(); clearInt.mockRestore();
        process.chdir(cwd);
      }
    });
  }

  test("network failure at init recovers once, delivering durable user/ops messages queued while pending", () => bootTest(async h => {
    h.setProbe(async () => { throw new Error("ECONNRESET"); });
    await h.reporter.init();
    expect(h.r.enabled).toBe(false);
    expect([...h.timers.values()][0].ms).toBe(15_000);
    expect(await h.reporter.send("daily report")).toBe(false);
    expect(await h.reporter.sendOps("ops page")).toBe(false);
    expect(new TelegramOutbox(h.boxPath).size()).toBe(2);
    expect(h.calls.every((c: any) => c.method === "getMe")).toBe(true);
    h.setProbe(async () => Response.json({ ok: true, result: { username: "test_bot" } }));
    await h.retry();
    expect(h.r.enabled).toBe(true);
    expect(h.listenerCounts()).toEqual([1, 1, 1, 1]);
    expect([...h.intervals.values()].filter((t: any) => t.ms === 10_000)).toHaveLength(1);
    await h.r.drainOutbox(); // the existing 30s drain cadence resumes delivery
    expect(h.outbox.size()).toBe(0);
    const delayed = h.calls.filter((c: any) => c.body?.text?.includes("(retrasado, original"));
    expect(delayed.map((c: any) => c.body.chat_id)).toEqual(["USER", "OPS"]);
    expect(delayed[0].body.text).toContain("daily report");
    await h.reporter.init();
    expect(h.listenerCounts()).toEqual([1, 1, 1, 1]);
    expect(h.calls.filter((c: any) => c.method === "getMe")).toHaveLength(2);
    expect(h.timers.size).toBe(0);
    expect(h.logs.join("\n")).not.toContain("Invalid bot token");
  }));

  for (const status of [400, 401, 404]) {
    test(`getMe ${status} is an invalid token, never retries or queues`, () => bootTest(async h => {
      h.setProbe(async () => Response.json({ ok: false, error_code: status }, { status }));
      await h.reporter.init();
      expect(h.r.enabled).toBe(false);
      expect(h.timers.size).toBe(0);
      expect(h.listenerCounts()).toEqual([0, 0, 0, 0]);
      await h.reporter.send("not queued");
      await h.reporter.sendOps("not queued either");
      expect(h.outbox.size()).toBe(0);
      expect(h.logs.join("\n")).toContain("Invalid bot token");
      await h.r.drainOutbox();
      expect(h.calls).toHaveLength(1);
    }));
  }

  for (const status of [429, 500, 503]) {
    test(`getMe ${status} retries in the background with capped exponential backoff`, () => bootTest(async h => {
      h.setProbe(async () => Response.json({ ok: false, error_code: status, parameters: { retry_after: 3600 } }, { status }));
      await h.reporter.init();
      for (const delay of [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
        expect([...h.timers.values()][0].ms).toBe(delay);
        await h.retry();
      }
      expect(h.logs.join("\n")).not.toContain("Invalid bot token");
      h.reporter.stop();
      expect(h.timers.size).toBe(0);
      expect(h.intervals.size).toBe(0);
      await h.reporter.send("stopped");
      expect(h.outbox.size()).toBe(0);
    }));
  }

  test("a JSON parse failure is retryable, not an invalid token", () => bootTest(async h => {
    h.setProbe(async () => new Response("not JSON", { status: 502 }));
    await h.reporter.init();
    expect(h.timers.size).toBe(1);
    expect(h.logs.join("\n")).not.toContain("Invalid bot token");
  }));

  test("a later definitive rejection stops retries and disables queueing/draining", () => bootTest(async h => {
    h.setProbe(async () => { throw new Error("ECONNRESET"); });
    await h.reporter.init();
    await h.reporter.send("before rejection");
    h.setProbe(async () => Response.json({ ok: false, error_code: 401 }, { status: 200 }));
    await h.retry();
    expect(h.r.enabled).toBe(false);
    expect(h.timers.size).toBe(0);
    expect(h.intervals.size).toBe(0);
    await h.reporter.send("after rejection");
    await h.r.drainOutbox();
    expect(h.outbox.size()).toBe(1); // the durable old entry is retained, not sent
    expect(h.calls.every((c: any) => c.method === "getMe")).toBe(true);
    expect(h.logs.join("\n")).toContain("Invalid bot token");
  }));

  test("pending messages retain the outbox's dedupe, cap and per-entry backoff on recovery", () => bootTest(async h => {
    h.setProbe(async () => { throw new Error("ECONNRESET"); });
    await h.reporter.init();
    for (let i = 0; i < OUTBOX_MAX_ENTRIES + 1; i++) await h.reporter.send(`message ${i}`);
    await h.reporter.send(`message ${OUTBOX_MAX_ENTRIES}`);
    expect(h.outbox.size()).toBe(OUTBOX_MAX_ENTRIES);
    expect(h.outbox.list()[0].text).toBe("message 1");
    await h.outbox.drain(async () => "retryable");
    const nextAttemptAt = h.outbox.list()[0].nextAttemptAt;
    h.setProbe(async () => Response.json({ ok: true, result: { username: "test_bot" } }));
    await h.retry();
    await h.r.drainOutbox();
    expect(h.outbox.size()).toBe(1);
    expect(h.outbox.list()[0].nextAttemptAt).toBe(nextAttemptAt);
    expect(h.outbox.list()[0].text).toBe("message 1");
  }));

  for (const planned of [true, false]) {
    test(`startup banner uses the marker at boot (planned=${planned}), not at late connection`, () => bootTest(async h => {
      mkdirSync("data");
      if (planned) writeFileSync("data/.deploy-restart", "");
      h.setProbe(async () => { throw new Error("ECONNRESET"); });
      await h.reporter.init();
      expect(existsSync("data/.deploy-restart")).toBe(false);
      // Reverse the marker's state while disconnected; only the boot decision counts.
      if (!planned) writeFileSync("data/.deploy-restart", "");
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 600_000);
      try {
        h.setProbe(async () => Response.json({ ok: true, result: { username: "test_bot" } }));
        await h.retry();
        const banners = h.calls.filter((c: any) => c.body?.text?.includes("reinicio inesperado"));
        expect(banners).toHaveLength(planned ? 0 : 1);
        if (!planned) expect(banners[0].body.chat_id).toBe("OPS");
      } finally { clock.mockRestore(); }
    }));
  }

  test("stop during an in-flight getMe cannot resurrect polling or retry timers", () => bootTest(async h => {
    let resolve!: (r: Response) => void;
    h.setProbe(() => new Promise<Response>(r => { resolve = r; }));
    const boot = h.reporter.init();
    h.reporter.stop();
    resolve(Response.json({ ok: true, result: { username: "test_bot" } }));
    await boot;
    expect(h.r.enabled).toBe(false);
    expect(h.listenerCounts()).toEqual([0, 0, 0, 0]);
    expect(h.intervals.size).toBe(0);
    expect(h.timers.size).toBe(0);
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
