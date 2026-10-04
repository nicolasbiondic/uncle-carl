// Daily-horizon mode for momentum_stocks (R2 research 2026-09-24): wired to
// h126-ma200 by director decision the same day (null = the 5m/hourly kernel,
// byte-identical — flipping it back is one constant). The daily scheduler
// gate must implement the meanrev discipline (market open, ≥ 09:35 ET, once
// per ET trading day).

import { describe, expect, test } from "bun:test";
import {
  MOMENTUM_STOCKS_DAILY_HORIZON,
  MOMENTUM_STOCKS_DAILY_VOL_STOP,
  momentumStocksDailyTickDue,
  momentumStocksCutoverFor,
  dailyHorizonMaxLookback,
  MOMENTUM_STOCKS_CUTOVER_AT,
  MOMENTUM_STOCKS_CUTOVER_EXPIRES_AT,
} from "./index";

describe("MOMENTUM_STOCKS_DAILY_HORIZON — wiring lock", () => {
  test("wired to the validated blend-63-126-252 candidate (artifact cc2f5d69…), nothing else", () => {
    expect(MOMENTUM_STOCKS_DAILY_HORIZON).toEqual({ lookbackDaysList: [63, 126, 252], maLengthDays: 200 });
    expect(dailyHorizonMaxLookback(MOMENTUM_STOCKS_DAILY_HORIZON!)).toBe(252);
  });

  test("daily vol windows are the k8-s8 pure chain's exact parametrization", () => {
    expect(MOMENTUM_STOCKS_DAILY_VOL_STOP).toEqual({ kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 });
  });
});

describe("momentumStocksDailyTickDue — one pass per ET trading day, ≥ 09:35", () => {
  // 2026-09-22 is a Tuesday; September = EDT (UTC-4).
  const t = (utc: string) => Date.parse(utc);

  test("before 09:35 ET: not due (even though the market is open at 09:32)", () => {
    expect(momentumStocksDailyTickDue(t("2026-09-22T13:32:00Z"), "")).toBe(false);
  });

  test("at/after 09:35 ET on a trading day with no run yet: due", () => {
    expect(momentumStocksDailyTickDue(t("2026-09-22T13:36:00Z"), "")).toBe(true);
    expect(momentumStocksDailyTickDue(t("2026-09-22T15:00:00Z"), "2026-09-21")).toBe(true);
  });

  test("already ran today: not due again (idempotent per ET date key)", () => {
    expect(momentumStocksDailyTickDue(t("2026-09-22T13:36:00Z"), "2026-09-22")).toBe(false);
    expect(momentumStocksDailyTickDue(t("2026-09-22T19:00:00Z"), "2026-09-22")).toBe(false);
  });

  test("market closed (after hours / weekend): never due", () => {
    expect(momentumStocksDailyTickDue(t("2026-09-22T20:05:00Z"), "")).toBe(false); // 16:05 ET
    expect(momentumStocksDailyTickDue(t("2026-09-19T15:00:00Z"), "")).toBe(false); // Saturday
  });
});

describe("momentum_stocks one-shot cutover window", () => {
  test("wired only while the window is open, never after it expires", () => {
    expect(MOMENTUM_STOCKS_CUTOVER_AT).not.toBeNull();
    expect(momentumStocksCutoverFor(Date.UTC(2026, 8, 28, 13, 35))).toBe(MOMENTUM_STOCKS_CUTOVER_AT!);
    expect(momentumStocksCutoverFor(MOMENTUM_STOCKS_CUTOVER_EXPIRES_AT)).toBeUndefined();
    expect(momentumStocksCutoverFor(Date.UTC(2027, 0, 1))).toBeUndefined();
  });
});
