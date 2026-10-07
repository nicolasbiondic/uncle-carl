/**
 * Measured headroom for the live gross-exposure backstops (G diagnostic,
 * docs/reports/G-gross-cap.md, applied 2026-10-07 — owner decision to align
 * live with the validated model).
 *
 * Why not 1.0 (the slot×count product): the engine sizes every NEW entry as
 * equity × notionalPctPerSlot, but the cap counts the held book at MARKET
 * value — in a momentum sleeve the held names have risen by construction, so
 * `marked gross + new slot > product × equity` happens exactly when the
 * strategy trends. Measured on the four authoritative OOS chains re-run with
 * the live cap imposed (same data, bit-identical control reproduction):
 * 27–31 % of validated entry decisions exceeded the 1.0× product on
 * momentum_stocks/momentum_crypto_usdc (max ratios 1.105 / 1.127), costing
 * −1.5 pp / −14.4 pp CAGR; crypto 1.5× and meanrev 0.84× were near-benign
 * (max 1.554 / 0.882). Prod showed the same symptom live: 8 USDC entries
 * blocked the week of 2026-09-26 with 4/5 positions filled.
 *
 * At H = 1.15 the measured activation is 0 decisions on all four validated
 * chains, while a legacy-sized book (~2× product — the 2026-09-25 META/AAPL
 * cutover class the backstop exists for) still trips it. Rollback: set this
 * constant back to 1.0.
 *
 * Lives in its own module because BOTH wiring paths must read it and neither
 * may import the other: src/index.ts (env-wired constants) and
 * src/portfolios/factory.ts (PORTFOLIOS_SOURCE=db — what prod runs), which
 * must NOT import "../index" (see its module docstring). Locked by
 * src/config/riskProfiles.exposureCaps.test.ts and
 * scripts/liveSleeveConfigs.test.ts; factory ≡ index parity by
 * src/portfolios/parity.test.ts.
 */
export const GROSS_CAP_HEADROOM = 1.15;
