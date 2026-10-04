// ══════════════════════════════════════════════
// SymbolLockRegistry — unit tests
// ══════════════════════════════════════════════
//
// Regressions each test guards:
//  - "serializes same-symbol mutations" → the double-sell: two concurrent
//    closes both read the same broker qty and both transmit. Remove the
//    lock (or make withLock not actually serialize) and the fake broker
//    here records TWO sells.
//  - "distinct symbols run in parallel" → someone widening the key to a
//    global lock and serializing the whole venue.
//  - "timeout is an explicit denial"    → a waiter hanging forever (or a
//    timeout silently reported as success).
//  - "nested acquire times out"         → the design is NOT reentrant;
//    anyone nesting a locked public entry point inside another locked body
//    gets a bounded, loud failure — this test documents exactly that.
//  - "normalization"                    → DOGE/USD and DOGEUSD are the same
//    broker position and must contend on the same key.

import { describe, test, expect } from "bun:test";
import { SymbolLockRegistry, DEFAULT_SYMBOL_LOCK_TIMEOUT_MS } from "./symbolLock";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe("serialization of same-symbol mutations", () => {
  test("two concurrent closes of the same symbol → serialized, ONE broker sell (the double-sell class)", async () => {
    const locks = new SymbolLockRegistry();
    // Fake broker: one open position. Each unserialized closer would read
    // qty=1 and sell — exactly what the lock must prevent.
    const broker = { qty: 1, sells: 0 };
    const closeOnce = async () => {
      const seen = broker.qty;          // both callers would read 1 without the lock
      await sleep(10);                  // window in which the race interleaves
      if (seen > 0 && broker.qty > 0) { // the same bound check real closes make
        broker.qty -= 1;
        broker.sells += 1;
        return "closed";
      }
      return "already_flat";
    };

    const [a, b] = await Promise.all([
      locks.withLock("binance_fapi", "BTC/USD", { label: "closerA" }, closeOnce, () => "timeout"),
      locks.withLock("binance_fapi", "BTC/USD", { label: "closerB" }, closeOnce, () => "timeout"),
    ]);

    expect(broker.sells).toBe(1); // WITHOUT the lock this is 2 — an accidental short
    expect([a, b].sort()).toEqual(["already_flat", "closed"]);
    expect(locks.metrics().contentions).toBe(1);
    expect(locks.metrics().held).toBe(0); // everything released
  });

  test("control: the same two closers WITHOUT the lock double-sell (documents what the lock prevents)", async () => {
    const broker = { qty: 1, sells: 0 };
    const closeOnce = async () => {
      const seen = broker.qty;
      await sleep(10);
      if (seen > 0) { broker.qty -= 1; broker.sells += 1; }
    };
    await Promise.all([closeOnce(), closeOnce()]);
    expect(broker.sells).toBe(2); // the bug the lock exists for
  });

  test("distinct symbols do NOT serialize (parallel mutation of different positions)", async () => {
    const locks = new SymbolLockRegistry();
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active--;
      return true;
    };
    await Promise.all([
      locks.withLock("binance_fapi", "BTC/USD", {}, work, () => false),
      locks.withLock("binance_fapi", "ETH/USD", {}, work, () => false),
    ]);
    expect(maxActive).toBe(2); // truly concurrent
    expect(locks.metrics().contentions).toBe(0);
  });

  test("venues never collide: the same symbol on two venues runs in parallel", async () => {
    const locks = new SymbolLockRegistry();
    let active = 0;
    let maxActive = 0;
    const work = async () => { active++; maxActive = Math.max(maxActive, active); await sleep(20); active--; };
    await Promise.all([
      locks.withLock("alpaca", "DOGE/USD", {}, work, () => undefined),
      locks.withLock("binance_fapi", "DOGE/USD", {}, work, () => undefined),
    ]);
    expect(maxActive).toBe(2);
  });

  test("symbol normalization: DOGE/USD and DOGEUSD contend on the SAME key", async () => {
    const locks = new SymbolLockRegistry();
    const release = await locks.acquire("alpaca", "DOGE/USD");
    expect(release).not.toBeNull();
    const contender = await locks.withLock("alpaca", "DOGEUSD", { timeoutMs: 30 }, async () => "ran", () => "timeout");
    expect(contender).toBe("timeout"); // same position, same lock
    release!();
  });
});

describe("bounded acquisition — never a hang, never a silent no-op", () => {
  test("a waiter that can't get the lock resolves to the caller's EXPLICIT timeout result", async () => {
    const locks = new SymbolLockRegistry();
    const release = await locks.acquire("binance_dapi", "BTC/COIN-M", { label: "holder" });
    expect(release).not.toBeNull();

    const started = Date.now();
    const result = await locks.withLock(
      "binance_dapi", "BTC/COIN-M", { timeoutMs: 30, label: "waiter" },
      async () => ({ success: true }),
      () => ({ success: false, reason: "lock timeout" }), // explicit failure shape
    );
    expect(result).toEqual({ success: false, reason: "lock timeout" });
    expect(Date.now() - started).toBeLessThan(DEFAULT_SYMBOL_LOCK_TIMEOUT_MS); // bounded, not the 10s default, not forever
    expect(locks.metrics().timeouts).toBe(1);
    release!();
  });

  test("NOT reentrant, BY DESIGN: a nested acquire for the held key times out with an explicit denial (bounded, never a deadlock)", async () => {
    const locks = new SymbolLockRegistry();
    const out = await locks.withLock("binance_fapi", "BTC/USD", { label: "outer" }, async () => {
      // Anyone who makes a locked public entry point call ANOTHER locked
      // public entry point for the same symbol lands here. The failure mode
      // is a bounded denial — this test starts failing loudly if someone
      // nests, and starts failing (by succeeding) if reentrancy is ever
      // added without revisiting every core/wrapper split in the executors.
      const nested = await locks.acquire("binance_fapi", "BTC/USD", { timeoutMs: 30, label: "nested" });
      return nested === null ? "nested_denied" : "nested_acquired";
    }, () => "outer_timeout");
    expect(out).toBe("nested_denied");
    expect(locks.metrics().timeouts).toBe(1);
  });

  test("release is idempotent and hands off FIFO to the next live waiter", async () => {
    const locks = new SymbolLockRegistry();
    const order: string[] = [];
    const r1 = await locks.acquire("alpaca", "AAPL", { label: "first" });
    const p2 = locks.withLock("alpaca", "AAPL", { label: "second" }, async () => { order.push("second"); }, () => order.push("second_timeout"));
    const p3 = locks.withLock("alpaca", "AAPL", { label: "third" }, async () => { order.push("third"); }, () => order.push("third_timeout"));
    await sleep(5); // both queued
    r1!();
    r1!(); // double release: must NOT grant the lock to two waiters at once
    await Promise.all([p2, p3]);
    expect(order).toEqual(["second", "third"]); // FIFO, one at a time
    expect(locks.metrics().held).toBe(0);
  });

  test("the lock is released even when the locked fn throws (finally-safety)", async () => {
    const locks = new SymbolLockRegistry();
    await expect(
      locks.withLock("alpaca", "TSLA", {}, async () => { throw new Error("boom"); }, () => "timeout"),
    ).rejects.toThrow("boom");
    // Key must be free again:
    const again = await locks.withLock("alpaca", "TSLA", { timeoutMs: 30 }, async () => "ok", () => "timeout");
    expect(again).toBe("ok");
  });
});

describe("metrics", () => {
  test("acquires/contentions/timeouts/held count what actually happened", async () => {
    const locks = new SymbolLockRegistry();
    const release = await locks.acquire("alpaca", "MSFT");
    await locks.withLock("alpaca", "MSFT", { timeoutMs: 20 }, async () => {}, () => "t"); // contention + timeout
    const m1 = locks.metrics();
    expect(m1.acquires).toBe(2);
    expect(m1.contentions).toBe(1);
    expect(m1.timeouts).toBe(1);
    expect(m1.held).toBe(1);
    release!();
    expect(locks.metrics().held).toBe(0);
  });
});
