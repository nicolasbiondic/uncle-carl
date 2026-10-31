// fileStatePersistence carries the whole v1 envelope (2026-10-03): it used to
// rebuild `{ v, risk, trailMarks }` on load and save, silently dropping the
// realised-pnl anchor (every restart lost a loss-streak period) and
// entryMarks (a time stop would restart its clock).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
// The repo's stale @types/node lacks rmSync (same workaround as telegram/outbox.test.ts).
const { rmSync } = require("fs") as { rmSync: (p: string, o?: any) => void };
import { tmpdir } from "os";
import { join } from "path";
import { fileStatePersistence } from "./index";
import { EQUITY_SEMANTICS, INITIAL_RISK_STATE } from "./strategies/momentum/RiskGuard";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "uc-envelope-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const store = (path: string) => fileStatePersistence(path, 50_000, 50_000, EQUITY_SEMANTICS.SLEEVE_LEDGER);

describe("fileStatePersistence envelope round-trip", () => {
  test("breakout ages and channel edges round-trip, both legacy BTC and RW8 per-symbol state", () => {
    const path = join(dir, "breakout-list.json"), t = Date.parse("2024-01-01");
    const breakoutBySymbol = {
      "BTC/USD": { daily: { day: t, n: 123.5, close: 40000 }, entryAt: t - 120 * 3600000, belowEntry: true },
      "ETH/USD": { daily: { day: t, n: 23, close: 2000 }, entryAt: t - 3600000, belowEntry: false },
    };
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE, breakoutBySymbol });
    expect(store(path).load()!.breakoutBySymbol).toEqual(breakoutBySymbol);
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE, breakoutEntryAt: t, breakoutBelowEntry: false });
    expect(store(path).load()).toMatchObject({ breakoutEntryAt: t, breakoutBelowEntry: false });
    expect(store(path).load()).not.toHaveProperty("breakoutBySymbol");
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE });
    expect(store(path).load()).not.toHaveProperty("breakoutEntryAt");
    expect(store(path).load()).not.toHaveProperty("breakoutBelowEntry");
  });
  test("Turtle N recurrence survives a fresh atomic-file store; off stays absent", () => {
    const path = join(dir, "turtle.json"), turtleDaily = { day: Date.parse("2024-01-01"), n: 123.5, close: 40000 };
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE, turtleDaily });
    expect(store(path).load()!.turtleDaily).toEqual(turtleDaily);
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE });
    expect(store(path).load()!).not.toHaveProperty("turtleDaily");
  });
  test("idle overlay month survives the atomic file store; absent stays absent", () => {
    const path = join(dir, "idle.json");
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE, idleOverlayMonth: "2026-10", idleOverlayExitPending: true });
    expect(store(path).load()!.idleOverlayMonth).toBe("2026-10");
    expect(store(path).load()!.idleOverlayExitPending).toBe(true);
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE });
    expect(store(path).load()!).not.toHaveProperty("idleOverlayMonth");
    expect(store(path).load()!).not.toHaveProperty("idleOverlayExitPending");
  });
  test("riskAnchorAt and entryMarks survive a write and a fresh read", () => {
    const path = join(dir, "momentum-state-crypto.json");
    store(path).save({ v: 1, risk: { ...INITIAL_RISK_STATE, consecutiveLosses: 3 }, trailMarks: {}, entryMarks: { "LINK/USD|buy": 1_790_960_400_000 }, riskAnchorAt: 1_790_964_000_000 });
    const loaded = store(path).load()!;
    expect(loaded.risk.consecutiveLosses).toBe(3);
    expect(loaded.riskAnchorAt).toBe(1_790_964_000_000);
    expect(loaded.entryMarks).toEqual({ "LINK/USD|buy": 1_790_960_400_000 });
  });

  test("exposureFracs survive a write and a fresh read; a file without them loads without them (lost before 2026-10-24)", () => {
    const path = join(dir, "fracs.json");
    const fracs = { "SOL/USDC|buy": 0.794, "NEAR/USDC|buy": 0.794 };
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE, trailMarks: {}, exposureFracs: fracs });
    expect(store(path).load()!.exposureFracs).toEqual(fracs);
    store(path).save({ v: 1, risk: INITIAL_RISK_STATE, trailMarks: {} });
    expect(store(path).load()!.exposureFracs).toBeUndefined();
  });

  test("files written before the anchor existed load without one (legacy first tick)", () => {
    const envelope = join(dir, "momentum-state-old-envelope.json");
    writeFileSync(envelope, JSON.stringify({ v: 1, risk: { ...INITIAL_RISK_STATE }, trailMarks: {} }));
    expect(store(envelope).load()!.riskAnchorAt).toBeUndefined();

    const flat = join(dir, "momentum-state-flat.json");
    writeFileSync(flat, JSON.stringify({ ...INITIAL_RISK_STATE, riskAnchorAt: 123 })); // pre-envelope flat RiskState
    expect(store(flat).load()!.riskAnchorAt).toBeUndefined();
  });
});
