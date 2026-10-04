// Plausibility predicates — fixtures CAPTURED from the market, not invented
// (AUDITS.md round 9: "money-path fixtures stop being invented and get
// captured from the market, versioned"). Each capture's source is cited.

import { describe, test, expect } from "bun:test";
import {
  checkPrice, checkQuote, plausibilityMode, RejectionTally,
  DEFAULT_PLAUSIBILITY, type Quote,
} from "./plausibility";

const cfg = DEFAULT_PLAUSIBILITY;
const NOW = 1_785_300_000_000; // fixed "now" for determinism
const fresh = NOW - 3_000; // the UNH incident quote was 3s old

const ok = (v: ReturnType<typeof checkQuote>) => v.ok;
const reason = (v: ReturnType<typeof checkQuote>) => (v.ok ? "" : v.reason);

describe("checkQuote — captured real garbage", () => {
  // CAPTURED 2026-07-27 (AUDITS.md round 9, the near-incident): UNH IEX
  // quote bid 392.64 / ask 420.00 at 3s of age, last trade 418.35. The
  // midpoint 406.32 turned a real −0.83% into a fabricated −3.68% with the
  // stop at −4%. Spread over mid = 6.73% > 2%.
  test("UNH near-incident quote (6.7% spread) rejects", () => {
    const q: Quote = { bid: 392.64, ask: 420.00, last: 418.35, ts: fresh };
    const v = checkQuote(q, cfg, NOW);
    expect(ok(v)).toBe(false);
    expect(reason(v)).toBe("wide_spread");
  });

  // CAPTURED 2026-07-27 (AUDITS.md round 9) AND re-observed live 2026-07-29
  // (bid 0.01 / ask 339.87): AAPL's chronic IEX book. On a sell, the old
  // side-touch check accepted bid 0.01 → slippage_bps ≈ 336,920,000.
  test("AAPL bid 0.01 / ask 0 rejects (non-positive touch)", () => {
    const v = checkQuote({ bid: 0.01, ask: 0, ts: fresh }, cfg, NOW);
    expect(ok(v)).toBe(false);
    expect(reason(v)).toBe("non_positive_touch");
  });

  test("AAPL 2026-07-29 live capture: bid 0.01 / ask 339.87 rejects", () => {
    // Not ask=0 this time — a positive book with a 200% spread. Both days'
    // captures must reject, whichever predicate fires first.
    const v = checkQuote({ bid: 0.01, ask: 339.87, last: 340.17, ts: fresh }, cfg, NOW);
    expect(ok(v)).toBe(false);
    expect(reason(v)).toBe("wide_spread");
  });

  test("crossed market rejects (UNH numbers permuted)", () => {
    const v = checkQuote({ bid: 420.00, ask: 392.64, last: 418.35, ts: fresh }, cfg, NOW);
    expect(ok(v)).toBe(false);
    expect(reason(v)).toBe("crossed_market");
  });

  test("future timestamp beyond clock-skew tolerance rejects", () => {
    // SPY healthy book (captured 2026-07-29) but stamped 60s in the future.
    const v = checkQuote({ bid: 740.92, ask: 741.16, last: 740.67, ts: NOW + 60_000 }, cfg, NOW);
    expect(ok(v)).toBe(false);
    expect(reason(v)).toBe("future_timestamp");
  });

  test("stale quote rejects", () => {
    // CAPTURED 2026-07-29 02:30 ET: every wide universe quote was ~10h old.
    const v = checkQuote({ bid: 740.92, ask: 741.16, last: 740.67, ts: NOW - 10 * 3_600_000 }, cfg, NOW);
    expect(ok(v)).toBe(false);
    expect(reason(v)).toBe("stale_quote");
  });

  test("10× deviated last vs reference rejects", () => {
    // A tight, fresh book printing ×10 UNH's real last trade (418.35 as
    // ref): every book-shape predicate passes, only the deviation catches it.
    const v = checkQuote({ bid: 4180.0, ask: 4181.0, last: 4183.5, ts: fresh }, cfg, NOW, 418.35);
    expect(ok(v)).toBe(false);
    expect(reason(v)).toBe("ref_deviation");
  });

  test("malformed fields reject (fail-closed)", () => {
    expect(ok(checkQuote({ bid: NaN, ask: 741.16, ts: fresh }, cfg, NOW))).toBe(false);
    expect(ok(checkQuote({ bid: 740.92, ask: 741.16, ts: NaN }, cfg, NOW))).toBe(false);
  });
});

describe("checkQuote — healthy data PASSES (a threshold that blocks real trading is a bug too)", () => {
  // CAPTURED 2026-07-29 via read-only IEX snapshot: SPY latestQuote
  // bid 740.92 / ask 741.16 (spread 0.032%), latestTrade 740.67.
  test("SPY captured healthy quote passes, price = last", () => {
    const v = checkQuote({ bid: 740.92, ask: 741.16, last: 740.67, ts: fresh }, cfg, NOW, 740.0);
    expect(v).toEqual({ ok: true, price: 740.67 });
  });

  test("tight book without a last trade passes on the mid (crypto quotes endpoint)", () => {
    const v = checkQuote({ bid: 740.92, ask: 741.16, ts: fresh }, cfg, NOW);
    expect(v).toEqual({ ok: true, price: (740.92 + 741.16) / 2 });
  });
});

describe("checkPrice", () => {
  test("AAPL midpoint catastrophe (0.005 vs ~340 entry) rejects", () => {
    // AUDITS round 9: "on AAPL the midpoint would have been 0.005 →
    // −99.998% → instant close of the whole position".
    const v = checkPrice(0.005, 340.17, cfg);
    expect(v.ok).toBe(false);
    expect(reason(v)).toBe("ref_deviation");
  });

  test("exactly 10× rejects (boundary is closed)", () => {
    expect(checkPrice(4183.5, 418.35, cfg).ok).toBe(false);
    expect(checkPrice(41.835, 418.35, cfg).ok).toBe(false);
  });

  test("worst measured real universe moves pass with margin", () => {
    // historical.db measurements: worst 30-trading-day −52.7% (HON), +72.7%
    // (QCOM), worst single day 144% (HON). None may reject.
    expect(checkPrice(100 * (1 - 0.527), 100, cfg).ok).toBe(true);
    expect(checkPrice(100 * (1 + 0.727), 100, cfg).ok).toBe(true);
    expect(checkPrice(100 * (1 + 1.442), 100, cfg).ok).toBe(true);
  });

  test("non-positive / non-finite price rejects; no ref means positivity only", () => {
    expect(checkPrice(0, undefined, cfg).ok).toBe(false);
    expect(checkPrice(-5, undefined, cfg).ok).toBe(false);
    expect(checkPrice(NaN, undefined, cfg).ok).toBe(false);
    expect(checkPrice(418.35, undefined, cfg)).toEqual({ ok: true, price: 418.35 });
  });

  test("corrupt reference rejects (fail-closed, not fail-open)", () => {
    expect(checkPrice(418.35, 0, cfg).ok).toBe(false);
    expect(checkPrice(418.35, NaN, cfg).ok).toBe(false);
  });
});

describe("mode switch", () => {
  test("default observe; only the exact string 'enforce' enforces", () => {
    expect(plausibilityMode(undefined)).toBe("observe");
    expect(plausibilityMode("enforce")).toBe("enforce");
    expect(plausibilityMode("yes")).toBe("observe"); // typo fails toward not-blocking
  });
});

describe("RejectionTally — aggregated with cooldown, never a line per evaluation", () => {
  test("aggregates by reason and respects the cooldown window", () => {
    const t = new RejectionTally(5 * 60_000);
    t.add("UNH:wide_spread");
    t.add("UNH:wide_spread");
    t.add("AAPL:non_positive_touch");
    const first = t.flush(NOW);
    expect(first).toContain("3 implausible");
    expect(first).toContain("UNH:wide_spread×2");
    expect(first).toContain("AAPL:non_positive_touch×1");
    t.add("UNH:wide_spread");
    expect(t.flush(NOW + 60_000)).toBeNull(); // inside cooldown: silent
    const second = t.flush(NOW + 5 * 60_000);
    expect(second).toContain("1 implausible"); // counts reset per window
  });

  test("nothing to report → null, at any time", () => {
    const t = new RejectionTally(0);
    expect(t.flush(NOW)).toBeNull();
  });
});
