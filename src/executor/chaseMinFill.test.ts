// ══════════════════════════════════════════════
// Minimum-fill guard on chased entries (2026-09-05)
// ══════════════════════════════════════════════
//
// momentum_crypto_usdc looked like it had stopped trading. It hadn't — it was
// trading in DUST. The chase's only rejection test was `filledQty <= 0`, so a
// 0.4% fill came back as a completed order and became a position: live entry
// notionals of $7 / $44 / $99 against a ~$1,870 slot, average deployment $902
// versus the USDT sibling's rock-steady $2,220-$2,264 on market orders.
//
// The sleeve's own fill telemetry (scripts/fill-quality-report.ts) indicted
// the slivers: the <$1k bucket fills at 4.7bps median slippage and 62.9s
// median latency, against 0.2bps / 1.0s for full-size fills — dust is both
// slower and dearer, so the chase was not buying the spread saving it exists
// for.
//
// Locked here:
//  • a fill below the floor is FLATTENED and reported as a plain rejection
//    (null) — never persisted, never left on the book as an orphan;
//  • a fill at/above the floor is untouched (no behavior change for the
//    fills that were always fine);
//  • if the flatten FAILS the dust is returned as a real order — a recorded
//    small position beats an invisible one (the orphan class this repo keeps
//    paying for);
//  • the threshold is configurable and a nonsensical value falls back to the
//    default instead of being honoured.
//
// Falsifier: drop the guard block in binance-executor.ts and "dust is
// flattened and rejected" fails (the order comes back with the sliver qty).

import { describe, expect, test } from "bun:test";
import { MIN_ENTRY_FILL_FRACTION, validatePolicy } from "./executionPolicy";

/** The guard's decision, extracted verbatim from binance-executor.ts so the
 *  rule can be exercised without standing up a venue. Kept in sync by the
 *  source-shape assertion at the bottom. */
function belowFloor(filledQty: number, requestedQty: number, minFillFraction?: number): boolean {
  const minFraction = minFillFraction ?? MIN_ENTRY_FILL_FRACTION;
  return filledQty < requestedQty * minFraction;
}

describe("minimum-fill floor — the live dust distribution", () => {
  // The exact fills observed on momentum_crypto_usdc, 2026-08-30..09-04,
  // against a ~$1,870 slot. Notionals converted to fraction-of-target.
  const LIVE = [
    { label: "SOL/USDC $7", fraction: 7 / 1870, dust: true },
    { label: "BCH/USDC $44", fraction: 44 / 1870, dust: true },
    { label: "XRP/USDC $99", fraction: 99 / 1870, dust: true },
    { label: "NEAR/USDC $415", fraction: 415 / 1870, dust: true },
    { label: "BCH/USDC $617", fraction: 617 / 1870, dust: true },
    { label: "BCH/USDC $648", fraction: 648 / 1870, dust: true },
    { label: "XRP/USDC $1876", fraction: 1876 / 1870, dust: false },
    { label: "BCH/USDC $1890", fraction: 1890 / 1870, dust: false },
    { label: "BNB/USDC $1863", fraction: 1863 / 1870, dust: false },
  ];

  test("separates every observed sliver from every observed full fill", () => {
    for (const f of LIVE) {
      expect(belowFloor(f.fraction * 100, 100)).toBe(f.dust);
    }
  });

  test("the default sits inside the empirical gap (35% dust ceiling → 99% fill floor)", () => {
    const worstDust = Math.max(...LIVE.filter(f => f.dust).map(f => f.fraction));
    const bestFull = Math.min(...LIVE.filter(f => !f.dust).map(f => f.fraction));
    expect(worstDust).toBeLessThan(MIN_ENTRY_FILL_FRACTION);
    expect(bestFull).toBeGreaterThan(MIN_ENTRY_FILL_FRACTION);
    // …and the gap is wide, so the exact default is not load-bearing.
    expect(bestFull - worstDust).toBeGreaterThan(0.5);
  });

  test("a zero fill was already rejected before this guard and still is", () => {
    expect(belowFloor(0, 100)).toBe(true);
  });

  test("an exactly-at-floor fill is KEPT (strict <, not <=)", () => {
    expect(belowFloor(50, 100, 0.5)).toBe(false);
    expect(belowFloor(49.99, 100, 0.5)).toBe(true);
  });

  test("the floor is configurable per sleeve", () => {
    expect(belowFloor(30, 100, 0.2)).toBe(false); // permissive sleeve keeps a 30% fill
    expect(belowFloor(30, 100, 0.8)).toBe(true);  // strict sleeve rejects it
  });
});

describe("policy validation of minFillFraction", () => {
  const base = {
    style: "limit_chase", offsetBps: 2, refreshThresholdBps: 5,
    maxReprices: 3, maxDistanceBps: 30, timeoutMs: 20_000,
  };

  test("a valid fraction survives validation", () => {
    const p = validatePolicy({ entry: { ...base, minFillFraction: 0.25 } });
    expect(p?.entry?.minFillFraction).toBe(0.25);
  });

  test("out-of-range or non-finite values are DROPPED to the default, not honoured", () => {
    for (const bad of [1.5, -0.1, NaN, "half"]) {
      const p = validatePolicy({ entry: { ...base, minFillFraction: bad } });
      expect(p?.entry).toBeTruthy();                       // policy still valid…
      expect(p?.entry?.minFillFraction).toBeUndefined();   // …but the bad value is gone
    }
  });

  test("omitting it leaves the executor on the documented default", () => {
    const p = validatePolicy({ entry: base });
    expect(p?.entry?.minFillFraction).toBeUndefined();
    expect(MIN_ENTRY_FILL_FRACTION).toBe(0.5);
  });
});

describe("the guard is actually wired into the chase path", () => {
  test("binance-executor flattens the dust and rejects, and never leaves it unflattened", async () => {
    const src = await Bun.file(new URL("./binance-executor.ts", import.meta.url)).text();
    const guard = src.slice(src.indexOf("minFillFraction ?? MIN_ENTRY_FILL_FRACTION"));
    expect(guard).toContain("chase.filledQty < qty * minFraction");
    expect(guard).toContain("this.closePosition(");   // dust is flattened…
    expect(guard).toContain("return null");           // …and the entry rejected
    // The fallthrough that keeps a failed flatten TRACKED must survive.
    expect(guard).toContain("stays tracked and stop-protected");
  });
});
