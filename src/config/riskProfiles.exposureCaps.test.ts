// Locks every sleeve's max THEORETICAL gross exposure (notionalPctPerSlot ×
// maxLongs, or slotPct × maxPositions for meanrev) against REAL production
// wiring — every constant imported below is the SAME one src/index.ts feeds
// into the actual engine constructors in main(), not a duplicated literal.
// This is the distinction the audit flagged: scripts/walk-forward.test.ts's
// own notionalPctPerSlot assertion locks the walk-forward HARNESS's config
// semantics, never production's — a sizing change in index.ts would sail
// past it silently. This file fails loudly instead.
//
// The two numbers behind momentum_stocks' exposure used to live in DIFFERENT
// files: notionalPctPerSlot inline in index.ts, maxLongs never set there so
// it silently inherited DEFAULT_TSM_CONFIG.maxLongs from
// TimeSeriesMomentum.ts. Their product (2.0x) was never written down
// anywhere — see index.ts:753-760 (the notionalPctPerSlot=0.5 comment,
// which documents that this sizing came from a 2026-07-12 sweep the rigorous
// nested-purged walk-forward later contradicted, and is being kept
// UNCHANGED pending a validated re-run — this file does not second-guess
// that; it only makes the resulting multiple visible and locked).
import { describe, expect, test } from "bun:test";
import {
  MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT, MOMENTUM_STOCKS_MAX_LONGS, MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT, MOMENTUM_CRYPTO_MAX_LONGS, MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT, MOMENTUM_USDC_MAX_LONGS, MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_BTC_NOTIONAL_PCT_PER_SLOT, MOMENTUM_BTC_MAX_LONGS, MOMENTUM_BTC_MAX_GROSS_EXPOSURE_MULT,
  MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT,
} from "../index";
import { RISK_PROFILES } from "./riskProfiles";
import { DEFAULT_MEANREV_CONFIG } from "../strategies/meanrev/MeanRevEngine";
import { GROSS_CAP_HEADROOM } from "./grossCap";

// Since 2026-10-07 every runtime backstop is slot×count × GROSS_CAP_HEADROOM
// (measured 1.15 — G diagnostic, docs/reports/G-gross-cap.md): at the bare
// product the cap blocked validated-size entries exactly in trends (27-31% of
// OOS entry decisions on the two 1.0x sleeves; 8 live USDC blocks the week of
// 2026-09-26). The SIZING products below stay locked unchanged — the headroom
// multiplies the backstop only, never the per-slot notional.
describe("sleeve max gross-exposure caps (locked against REAL production wiring, not duplicated literals)", () => {
  test("GROSS_CAP_HEADROOM is the measured 1.15 (G diagnostic; rollback = 1.0)", () => {
    expect(GROSS_CAP_HEADROOM).toBe(1.15);
  });

  test("momentum_stocks: sizing 0.125 x 8 = 1.0x — since 2026-09-25 (k8-s8 pure chain 5a5a9577); backstop 1.15x since 2026-10-07", () => {
    expect(MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT).toBe(0.125);
    expect(MOMENTUM_STOCKS_MAX_LONGS).toBe(8);
    expect(MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT * MOMENTUM_STOCKS_MAX_LONGS).toBe(1.0);
    expect(MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT).toBeCloseTo(1.15, 10);
  });

  test("momentum_crypto: sizing 0.375 x 4 = 1.5x; backstop 1.725x since 2026-10-07", () => {
    expect(MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT).toBe(0.375);
    expect(MOMENTUM_CRYPTO_MAX_LONGS).toBe(4);
    expect(MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT * MOMENTUM_CRYPTO_MAX_LONGS).toBeCloseTo(1.5, 10);
    expect(MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT).toBeCloseTo(1.725, 10);
  });

  test("momentum_crypto_usdc: sizing 0.20 x 5 = 1.0x (daily kernel, U1 artifact 752767ae…); backstop 1.15x since 2026-10-07 (the sleeve prod blocked 8x)", () => {
    expect(MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT).toBe(0.2);
    expect(MOMENTUM_USDC_MAX_LONGS).toBe(5);
    expect(MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT * MOMENTUM_USDC_MAX_LONGS).toBeCloseTo(1.0, 10);
    expect(MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT).toBeCloseTo(1.15, 10);
  });

  test("momentum_btc: sizing 1 x 1 = 1.0x (single symbol IS the one slot); backstop 1.15x since 2026-10-07", () => {
    expect(MOMENTUM_BTC_NOTIONAL_PCT_PER_SLOT).toBe(1);
    expect(MOMENTUM_BTC_MAX_LONGS).toBe(1);
    expect(MOMENTUM_BTC_MAX_GROSS_EXPOSURE_MULT).toBeCloseTo(1.15, 10);
  });

  test("meanrev_stocks: sizing 0.12 x 7 = 0.84x since 2026-09-28 (slot12 pure chain 624d50e9); backstop 0.966x since 2026-10-07 — DEFAULT_MEANREV_CONFIG, index.ts doesn't override slotPct/maxPositions", () => {
    expect(DEFAULT_MEANREV_CONFIG.slotPct).toBe(0.12);
    expect(DEFAULT_MEANREV_CONFIG.maxPositions).toBe(7);
    expect(DEFAULT_MEANREV_CONFIG.slotPct * DEFAULT_MEANREV_CONFIG.maxPositions).toBeCloseTo(0.84, 10);
    expect(MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT).toBeCloseTo(0.966, 10);
  });

  test("the two Alpaca sleeves' caps fit inside the shared account without margin", () => {
    // momentum_stocks 1.15x of its ledger + meanrev 0.966x of its base, both
    // ledgers seeded at $50k: the theoretical max is 2.116 x $50k = $105.8k —
    // still below the ~$110k Alpaca paper equity (tighter than the pre-G
    // 1.84x = $92k, re-checked consciously when applying the headroom), so
    // neither sleeve's entries can be starved of cash by the other (Reg-T 2x
    // is not needed; the shared-account guard in AlpacaMomentumAdapter is the
    // belt for the residual overlap). Locked to the exact sum so raising
    // either cap forces a conscious re-check.
    expect(MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT + MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT).toBeCloseTo(2.116, 10);
  });

  test("would FAIL if momentum_stocks' theoretical cap silently escalated (e.g. maxLongs 8->9, or notionalPctPerSlot 0.125->0.25)", () => {
    // Simulates the exact drift the audit found possible today: nothing
    // currently stops either number from moving independently. This test
    // hardcodes the EXPECTED product so any future change to either
    // MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT or MOMENTUM_STOCKS_MAX_LONGS in
    // index.ts must also consciously update this literal for the suite to
    // stay green — that's the "someone raised leverage without updating it"
    // trip-wire.
    const declaredTheoreticalMax = 1.0; // 2.0 until 2026-09-23
    expect(MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT * MOMENTUM_STOCKS_MAX_LONGS).toBe(declaredTheoreticalMax);
    // The next escalation this audit specifically flagged as "wouldn't break
    // anything today" — proving it WOULD break this lock now.
    expect(9 * MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT).not.toBe(declaredTheoreticalMax);
    expect(MOMENTUM_STOCKS_MAX_LONGS * 0.25).not.toBe(declaredTheoreticalMax);
  });

  test("RISK_PROFILES.momentum_stocks.leverage is no longer a lying field — matches its real 1.0x SIZING gross (the backstop above it carries the measured headroom)", () => {
    expect(RISK_PROFILES.momentum_stocks.leverage).toBe(MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT * MOMENTUM_STOCKS_MAX_LONGS);
    expect(RISK_PROFILES.momentum_stocks.leverage * GROSS_CAP_HEADROOM).toBeCloseTo(MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT, 10);
  });
});
