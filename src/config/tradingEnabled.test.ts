// ══════════════════════════════════════════════
// isTradingEnabled — the no-trade switch's DEFAULT is the safety property
// ══════════════════════════════════════════════
//
// Production auto-deploys origin/master within ~2 minutes and does NOT set
// TRADING_ENABLED. If the default ever flips to "disabled", the next push
// silently stops production from opening positions — a self-inflicted prod
// outage. These tests pin the contract: unset (or anything but the literal
// "false") = TRADE; only the explicit string "false" = no new opens.

import { describe, expect, test } from "bun:test";
import { isTradingEnabled } from "./index";

function withEnv(value: string | undefined, fn: () => void) {
  const saved = process.env.TRADING_ENABLED;
  try {
    if (value === undefined) delete process.env.TRADING_ENABLED;
    else process.env.TRADING_ENABLED = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env.TRADING_ENABLED;
    else process.env.TRADING_ENABLED = saved;
  }
}

describe("isTradingEnabled", () => {
  test("UNSET → enabled (prod has no variable; the default must trade)", () => {
    withEnv(undefined, () => expect(isTradingEnabled()).toBe(true));
  });

  test('only the literal "false" disables', () => {
    withEnv("false", () => expect(isTradingEnabled()).toBe(false));
  });

  test("anything else stays enabled — a typo must fail toward current behavior", () => {
    for (const v of ["true", "", "0", "no", "FALSE", "False", " false"]) {
      withEnv(v, () => expect(isTradingEnabled()).toBe(true));
    }
  });

  test("read per-call, not frozen at import (a restartless toggle is honored)", () => {
    withEnv("false", () => expect(isTradingEnabled()).toBe(false));
    withEnv(undefined, () => expect(isTradingEnabled()).toBe(true));
  });
});
