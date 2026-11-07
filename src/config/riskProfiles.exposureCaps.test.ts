// Locks every sleeve's max gross exposure against REAL production wiring:
// the crypto momentum sleeves' notionalPctPerSlot × maxLongs (the SAME
// constants src/index.ts feeds into the engine constructors in main(), not
// duplicated literals) and the stock sleeves' portfolio-engine maxGross (the
// built-in definition src/index.ts falls back to). scripts/walk-forward.test.ts's
// own notionalPctPerSlot assertion locks the walk-forward HARNESS's config
// semantics, never production's — a sizing change in index.ts would sail past
// it silently. This file fails loudly instead.
import { describe, expect, test } from "bun:test";
import {
  MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT, MOMENTUM_CRYPTO_MAX_LONGS, MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT, MOMENTUM_USDC_MAX_LONGS, MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT,
} from "../index";
import { RISK_PROFILES } from "./riskProfiles";
import { builtinPortfolio } from "../portfolios/builtin";
import { ALPACA_ACCOUNT_MAX_GROSS } from "../ops/grossCaps";
import { GROSS_CAP_HEADROOM } from "./grossCap";

const peMaxGross = (id: string): number => {
  const p = builtinPortfolio(id).params as { strategy: { maxGross?: number } };
  if (typeof p.strategy.maxGross !== "number") throw new Error(`${id}: no maxGross`);
  return p.strategy.maxGross;
};

// Since 2026-10-07 every momentum-engine runtime backstop is slot×count × GROSS_CAP_HEADROOM
// (measured 1.15 — G diagnostic, docs/reports/G-gross-cap.md): at the bare
// product the cap blocked validated-size entries exactly in trends. The SIZING
// products below stay locked unchanged — the headroom multiplies the backstop
// only, never the per-slot notional. The two stock sleeves run on the portfolio
// engine (RW2; the TSM/Connors incumbents were retired 2026-11-07): their cap is
// the definition's strategy.maxGross, clipped by the shared account's 1.9×.
describe("sleeve max gross-exposure caps (locked against REAL production wiring, not duplicated literals)", () => {
  test("GROSS_CAP_HEADROOM is the measured 1.15 (G diagnostic; rollback = 1.0)", () => {
    expect(GROSS_CAP_HEADROOM).toBe(1.15);
  });

  test("momentum_stocks (portfolio engine): maxGross 2.5x (Q5, vt30-g250), SH hedge inside the 0.25 per-asset cap", () => {
    expect(peMaxGross("pe_momentum_stocks")).toBe(2.5);
    const strategy = (builtinPortfolio("pe_momentum_stocks").params as any).strategy;
    expect(strategy.perAssetCap).toBe(0.25);
    expect(strategy.portfolioVolTarget).toBe(0.3);
    expect(strategy.regimeOverlay?.hedge).toEqual({ symbol: "SH", fraction: 0.5 });
  });

  test("meanrev_stocks (portfolio engine): maxGross 1.0x, vol target 15%, per-asset 0.10", () => {
    expect(peMaxGross("pe_meanrev_stocks")).toBe(1);
    const strategy = (builtinPortfolio("pe_meanrev_stocks").params as any).strategy;
    expect(strategy.perAssetCap).toBe(0.1);
    expect(strategy.portfolioVolTarget).toBe(0.15);
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

  test("the shared Alpaca account: the two sleeves' caps (2.5x + 1.0x of $50k each = $175k) use margin on purpose (Q5) and stay under the venue's 1.9x account clip", () => {
    const theoretical = (peMaxGross("pe_momentum_stocks") + peMaxGross("pe_meanrev_stocks")) * 50_000;
    expect(theoretical).toBe(175_000);
    expect(ALPACA_ACCOUNT_MAX_GROSS).toBe(1.9);
    const alpacaEquity = 108_300; // 2026-10-10
    expect(theoretical).toBeGreaterThan(alpacaEquity);                        // above equity: Reg-T margin by design (k150/Q5)
    expect(theoretical / alpacaEquity).toBeLessThan(ALPACA_ACCOUNT_MAX_GROSS); // ~1.62x: inside the account clip the venue enforces on every buy
  });

  test("RISK_PROFILES.*.leverage (display) matches each stock sleeve's REAL gross cap — the portfolio definition's maxGross", () => {
    expect(RISK_PROFILES.momentum_stocks.leverage).toBe(peMaxGross("pe_momentum_stocks"));
    expect(RISK_PROFILES.meanrev_stocks.leverage).toBe(peMaxGross("pe_meanrev_stocks"));
  });
});
