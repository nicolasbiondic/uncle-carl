// ══════════════════════════════════════════════
// SwitchingAdapter.openPosition — stopLossPct passthrough (OPEN.md P2(c))
// ══════════════════════════════════════════════
//
// The old inline action type (`{ symbol; side; notionalUsd }`) worked only
// by structural typing — nothing asserted the vol-scaled `stopLossPct` an
// engine attaches (MomentumEngine/MeanRevEngine, see volStopEntry.test.ts)
// actually reaches either the real or the shadow adapter through this
// router. Locks both the real `Parameters<MomentumBrokerAdapter["openPosition"]>[0]`
// signature and the runtime passthrough.

import { describe, expect, test, beforeAll } from "bun:test";
import { SwitchingAdapter } from "./SwitchingAdapter";
import { makeTestDb } from "../test-support/db";
import { FakeBroker } from "../test-support/momentum";
import type { SleeveMode } from "./SleeveGovernor";

beforeAll(() => { makeTestDb(); });

describe("SwitchingAdapter.openPosition — stopLossPct reaches the routed adapter", () => {
  test("mode=live → the REAL broker receives stopLossPct unchanged", async () => {
    const real = new FakeBroker();
    const shadow = new FakeBroker();
    const sw = new SwitchingAdapter(
      "sleeve_passthrough", { getMode: (): SleeveMode => "live" }, real, shadow, "sw_passthrough_live",
    );

    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000, stopLossPct: 5.5 });

    expect(res.ok).toBe(true);
    expect(real.opened).toHaveLength(1);
    expect(real.opened[0].stopLossPct).toBe(5.5);
    expect(shadow.opened).toHaveLength(0);
  });

  test("mode=shadow → the SHADOW broker receives stopLossPct unchanged", async () => {
    const real = new FakeBroker();
    const shadow = new FakeBroker();
    const sw = new SwitchingAdapter(
      "sleeve_passthrough", { getMode: (): SleeveMode => "shadow" }, real, shadow, "sw_passthrough_shadow",
    );

    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000, stopLossPct: 5.5 });

    expect(res.ok).toBe(true);
    expect(shadow.opened).toHaveLength(1);
    expect(shadow.opened[0].stopLossPct).toBe(5.5);
    expect(real.opened).toHaveLength(0);
  });

  test("no stopLossPct on the action → the routed adapter's open still carries none (legacy unaffected)", async () => {
    const real = new FakeBroker();
    const shadow = new FakeBroker();
    const sw = new SwitchingAdapter(
      "sleeve_passthrough", { getMode: (): SleeveMode => "live" }, real, shadow, "sw_passthrough_legacy",
    );

    await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });

    expect("stopLossPct" in real.opened[0]).toBe(false);
  });
});
