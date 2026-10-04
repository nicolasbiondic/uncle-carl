// momentum_crypto_usdc daily-kernel cutover wiring (2026-09-26): the daily
// model starts with its own risk state (modelVersion) and re-underwrites the
// hourly model's positions once, with a self-expiring window.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  MOMENTUM_USDC_MODEL_VERSION,
  MOMENTUM_USDC_CUTOVER_AT,
  MOMENTUM_USDC_CUTOVER_EXPIRES_AT,
  momentumUsdcCutoverFor,
} from "./index";

describe("momentum_crypto_usdc daily-kernel cutover", () => {
  test("model identity is the daily kernel and is wired into the USDC engine", () => {
    expect(MOMENTUM_USDC_MODEL_VERSION).toBe("daily-s5-blend3-2026-09-26");
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect((src.match(/modelVersion: MOMENTUM_USDC_MODEL_VERSION,/g) ?? []).length).toBe(1);
    expect(src).toContain("reunderwriteBefore: momentumUsdcCutoverFor(Date.now())");
  });

  test("the legacy-position cutover applies to the first daily pass and expires on its own", () => {
    expect(MOMENTUM_USDC_CUTOVER_AT).toBe(Date.UTC(2026, 8, 27));
    expect(momentumUsdcCutoverFor(Date.UTC(2026, 8, 26, 21))).toBe(MOMENTUM_USDC_CUTOVER_AT);
    expect(momentumUsdcCutoverFor(MOMENTUM_USDC_CUTOVER_EXPIRES_AT)).toBeUndefined();
    expect(momentumUsdcCutoverFor(Date.UTC(2027, 0, 1))).toBeUndefined();
  });
});
