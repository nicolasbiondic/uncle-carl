import { describe, expect, test } from "bun:test";
import { withTimeout } from "./timeout";

describe("withTimeout", () => {
  test("resolves when the promise settles before the deadline", async () => {
    const r = await withTimeout(Promise.resolve(42), 100, "fast");
    expect(r).toBe(42);
  });

  test("rejects when the promise hangs past the deadline (the deadlock guard)", async () => {
    const hang = new Promise<number>(() => {}); // never resolves
    await expect(withTimeout(hang, 20, "hang")).rejects.toThrow(/timeout/);
  });

  test("propagates the underlying rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 100, "x")).rejects.toThrow("boom");
  });

  test("clears its internal timer once the race settles (no leaked timer)", async () => {
    const original = global.clearTimeout;
    const cleared: any[] = [];
    global.clearTimeout = ((id: any) => { cleared.push(id); return original(id); }) as any;
    try {
      await withTimeout(Promise.resolve(1), 1000, "x");
      expect(cleared.length).toBe(1);
    } finally {
      global.clearTimeout = original;
    }
  });
});
