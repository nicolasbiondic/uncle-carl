// ══════════════════════════════════════════════
// SwitchingAdapter.openPosition — stopLossPct passthrough (OPEN.md P2(c))
// ══════════════════════════════════════════════
//
// The old inline action type (`{ symbol; side; notionalUsd }`) worked only
// by structural typing — nothing asserted the vol-scaled `stopLossPct` an
// engine attaches (MomentumEngine, see volStopEntry.test.ts) actually
// reaches the real adapter through this wrapper. Locks both the real
// `Parameters<MomentumBrokerAdapter["openPosition"]>[0]` signature and the
// runtime passthrough.

import { describe, expect, test, beforeAll } from "bun:test";
import { SwitchingAdapter } from "./SwitchingAdapter";
import { makeTestDb } from "../test-support/db";
import { FakeBroker } from "../test-support/momentum";

beforeAll(() => { makeTestDb(); });

describe("SwitchingAdapter.openPosition — stopLossPct reaches the real adapter", () => {
  test("the REAL broker receives stopLossPct unchanged", async () => {
    const real = new FakeBroker();
    const sw = new SwitchingAdapter("sleeve_passthrough", real);

    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000, stopLossPct: 5.5 });

    expect(res.ok).toBe(true);
    expect(real.opened).toHaveLength(1);
    expect(real.opened[0].stopLossPct).toBe(5.5);
  });

  test("no stopLossPct on the action → the adapter's open still carries none (legacy unaffected)", async () => {
    const real = new FakeBroker();
    const sw = new SwitchingAdapter("sleeve_passthrough", real);

    await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });

    expect("stopLossPct" in real.opened[0]).toBe(false);
  });
});
