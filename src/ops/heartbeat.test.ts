import { describe, expect, test } from "bun:test";
import { HeartbeatRegistry, BROKER_UNREACHABLE_MIN_MS, BROKER_UNREACHABLE_MIN_FAILURES, isBrokerUnreachable } from "./heartbeat";
import { eventBus, EVENTS } from "../utils/events";

// Attach a scoped ERROR_BURST listener, run, always detach (global singleton).
function withCapture(run: (events: any[]) => void) {
  const events: any[] = [];
  const handler = (e: any) => events.push(e);
  eventBus.on(EVENTS.ERROR_BURST, handler);
  try { run(events); } finally { eventBus.removeListener(EVENTS.ERROR_BURST, handler); }
}

// The logger writes every level through console.log; capture to assert warns.
function withConsole(run: (lines: string[]) => void) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: any[]) => { lines.push(args.map(String).join(" ")); };
  try { run(lines); } finally { console.log = orig; }
}

describe("HeartbeatRegistry — silent-loop watchdog", () => {
  test("register + beat + snapshot returns a fresh, not-stale status", () => {
    let t = 1_000_000;
    const hb = new HeartbeatRegistry(() => t);
    hb.register("engine", 60_000);
    hb.beat("engine");
    t = 1_030_000; // 30s later, expected 60s → fresh
    const snap = hb.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].name).toBe("engine");
    expect(snap[0].ageMs).toBe(30_000);
    expect(snap[0].expectedIntervalMs).toBe(60_000);
    expect(snap[0].stale).toBe(false);
  });

  test("a silent loop goes stale past interval×grace and pages exactly once", () => {
    let t = 0;
    const hb = new HeartbeatRegistry(() => t);
    withCapture((events) => {
      hb.register("sync", 1000, { graceMultiplier: 2 }); // stale limit = 2000ms
      hb.beat("sync");
      t = 1500; hb.check(); expect(events.length).toBe(0); // under limit
      t = 2500; hb.check(); expect(events.length).toBe(1); // over → page
      t = 3000; hb.check();
      t = 9999; hb.check();
      expect(events.length).toBe(1); // within 30min cooldown → still once
      const e = events[0];
      expect(e.context).toContain("sync");
      expect(e.count).toBe(1);
      expect(typeof e.windowMs).toBe("number");
      expect(e.message).toContain("silent");
    });
  });

  test("recovery clears stale and re-arms cooldown so a second death pages again", () => {
    let t = 0;
    const hb = new HeartbeatRegistry(() => t);
    withCapture((events) => {
      hb.register("loop", 1000); // limit 2000ms
      hb.beat("loop");
      t = 2500; hb.check(); expect(events.length).toBe(1); // first death
      t = 3000; hb.beat("loop");                            // recovery
      expect(hb.snapshot()[0].stale).toBe(false);
      t = 3100; hb.check(); expect(events.length).toBe(1);  // healthy → no page
      t = 6000; hb.check(); expect(events.length).toBe(2);  // died again → pages
    });
  });

  test("beat() on an unknown name auto-registers it and warns", () => {
    let t = 0;
    const hb = new HeartbeatRegistry(() => t);
    withConsole((lines) => {
      hb.beat("ghost-loop");
      expect(hb.snapshot().some((s) => s.name === "ghost-loop")).toBe(true);
      expect(lines.some((l) => l.includes("ghost-loop") && /warn/i.test(l))).toBe(true);
    });
  });

  test("beatFailed keeps the loop ALIVE: no dead-loop page, not stale, while consecutiveFailures counts up", () => {
    // The 2026-09-23/25 class: sync passes complete but the broker is down.
    let t = 0;
    const hb = new HeartbeatRegistry(() => t);
    withCapture((events) => {
      hb.register("sync_alpaca", 1000, { graceMultiplier: 2 }); // stale limit 2000ms
      hb.beat("sync_alpaca");
      // Fail every second for >5min — liveness must stay fresh throughout.
      for (let i = 1; i <= 400; i++) {
        t = i * 1000;
        hb.beatFailed("sync_alpaca");
        hb.check();
      }
      const s = hb.snapshot()[0];
      expect(s.stale).toBe(false);                         // liveness fresh
      expect(s.consecutiveFailures).toBe(400);
      expect(s.lastSuccessMs).toBe(0);                     // no success since t=0
      // NO dead-loop page ever fired; the ONLY page is the broker episode.
      expect(events.filter((e) => e.message.includes("possible dead loop")).length).toBe(0);
      expect(events.filter((e) => e.context.startsWith("broker_unreachable:")).length).toBe(1);
    });
  });

  test("broker-unreachable episode: pages ONCE past 5min+3 failures, recovery notice on the next success, next episode pages again", () => {
    let t = 0;
    const hb = new HeartbeatRegistry(() => t);
    withCapture((events) => {
      hb.register("sync_alpaca", 60_000);
      hb.beat("sync_alpaca"); // success at t=0
      // Two quick failures within 2min: neither threshold met → no page.
      t = 60_000; hb.beatFailed("sync_alpaca"); hb.check();
      t = 120_000; hb.beatFailed("sync_alpaca"); hb.check();
      expect(events.length).toBe(0);
      // Third failure at 3min: count met (3) but success age < 5min → still quiet.
      t = 180_000; hb.beatFailed("sync_alpaca"); hb.check();
      expect(events.length).toBe(0);
      // 4th/5th failures past 5min: BOTH thresholds met → exactly one page.
      t = 320_000; hb.beatFailed("sync_alpaca"); hb.check();
      expect(events.length).toBe(1);
      expect(events[0].context).toBe("broker_unreachable:sync_alpaca");
      expect(events[0].message).toContain("NOT a dead loop");
      t = 380_000; hb.beatFailed("sync_alpaca"); hb.check();
      expect(events.length).toBe(1); // silent while the episode persists
      // Recovery: next SUCCESS emits the episode-over notice, once.
      t = 440_000; hb.beat("sync_alpaca");
      expect(events.length).toBe(2);
      expect(events[1].context).toBe("broker_unreachable:sync_alpaca");
      expect(events[1].message).toContain("reachable again");
      const s = hb.snapshot()[0];
      expect(s.consecutiveFailures).toBe(0);
      expect(s.brokerUnreachable).toBe(false);
      // A NEW outage pages again (episode state fully reset).
      for (let i = 1; i <= 6; i++) { t = 440_000 + i * 60_000; hb.beatFailed("sync_alpaca"); hb.check(); }
      expect(events.filter((e) => e.message.includes("NOT a dead loop")).length).toBe(2);
    });
  });

  test("a short blip (success within thresholds) never pages and never emits a recovery notice", () => {
    let t = 0;
    const hb = new HeartbeatRegistry(() => t);
    withCapture((events) => {
      hb.register("sync_binance", 60_000);
      hb.beat("sync_binance");
      t = 60_000; hb.beatFailed("sync_binance"); hb.check();
      t = 120_000; hb.beat("sync_binance"); // recovered before any page
      expect(events.length).toBe(0);
      expect(hb.snapshot()[0].consecutiveFailures).toBe(0);
    });
  });

  test("isBrokerUnreachable thresholds are exported and match the snapshot flag", () => {
    expect(isBrokerUnreachable({ successAgeMs: BROKER_UNREACHABLE_MIN_MS, consecutiveFailures: BROKER_UNREACHABLE_MIN_FAILURES })).toBe(true);
    expect(isBrokerUnreachable({ successAgeMs: BROKER_UNREACHABLE_MIN_MS - 1, consecutiveFailures: 99 })).toBe(false);
    expect(isBrokerUnreachable({ successAgeMs: 99 * BROKER_UNREACHABLE_MIN_MS, consecutiveFailures: BROKER_UNREACHABLE_MIN_FAILURES - 1 })).toBe(false);
  });

  test("beat() and check() never throw even if a listener throws", () => {
    let t = 0;
    const hb = new HeartbeatRegistry(() => t);
    const boom = () => { throw new Error("listener blew up"); };
    eventBus.on(EVENTS.ERROR_BURST, boom);
    try {
      hb.register("x", 1000);
      expect(() => hb.beat("x")).not.toThrow();
      t = 5000;
      expect(() => hb.check()).not.toThrow(); // stale → emits into throwing listener
    } finally {
      eventBus.removeListener(EVENTS.ERROR_BURST, boom);
    }
  });
});
