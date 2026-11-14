import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActiveDecision, MAX_DECISION_BYTES } from "./active";
import { sealDecision, type Override } from "./contract";
import { baseDecision } from "./testFixtures";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ai-review-active-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ov = (symbol: string, over: Partial<Override> = {}): Override => ({
  sleeve: "momentum_stocks", symbol, action: "exit", factor: 0, meanConfidence: 0.8,
  votes: [{ family: "claude", action: "exit", confidence: 0.8 }, { family: "gpt", action: "exit", confidence: 0.8 }],
  reason: "Motivo.", sources: ["https://a.com/x"], ...over,
});
const put = (session: string, over: Parameters<typeof baseDecision>[0] = {}, name = `${session}.json`) => {
  const d = sealDecision(baseDecision({ session, decidedAt: `${session}T13:15:00.000Z`, ...over }));
  writeFileSync(join(dir, name), JSON.stringify(d));
  return d;
};
const load = (session: string) => loadActiveDecision({ dir, session });

describe("loadActiveDecision", () => {
  test("nothing there, or no directory: null", () => {
    expect(load("2026-11-16")).toBeNull();
    expect(loadActiveDecision({ dir: join(dir, "missing"), session: "2026-11-16" })).toBeNull();
  });
  test("the same-day decision is active; the NEWEST one whose session ≤ today wins", () => {
    put("2026-11-12", { overrides: [ov("AAPL")] });
    put("2026-11-13", { overrides: [ov("NVDA")] });
    expect(load("2026-11-16")?.session).toBe("2026-11-13");
    put("2026-11-16", { overrides: [ov("MSFT")] });
    expect(load("2026-11-16")?.overrides[0].symbol).toBe("MSFT");
  });
  test("a decision dated after the session asked for is future-dated and ignored", () => {
    put("2026-11-17", { overrides: [ov("NVDA")] });
    expect(load("2026-11-16")).toBeNull();
    put("2026-11-13", { overrides: [ov("AAPL")] });
    expect(load("2026-11-16")?.session).toBe("2026-11-13");
  });
  test("valid for 5 NYSE sessions after its own, then it lapses (the calendar skips weekends)", () => {
    put("2026-11-16", { overrides: [ov("NVDA")] });
    expect(load("2026-11-23")?.session).toBe("2026-11-16"); // 5 sessions later: 17,18,19,20,23
    expect(load("2026-11-24")).toBeNull();                 // the 6th
    rmSync(join(dir, "2026-11-16.json"));
    put("2026-11-13", { overrides: [ov("NVDA")] }); // a Friday: the weekend does not count
    expect(load("2026-11-20")?.session).toBe("2026-11-13"); // Mon 16, 17, 18, 19, Fri 20 = 5
    expect(load("2026-11-23")).toBeNull();                 // Mon 23 is the 6th
  });
  test("the age comes from an injectable session counter", () => {
    put("2026-11-16", { overrides: [ov("NVDA")] });
    expect(loadActiveDecision({ dir, session: "2026-11-17", sessionsBetween: () => 6 })).toBeNull();
    expect(loadActiveDecision({ dir, session: "2026-11-17", sessionsBetween: () => 5 })?.session).toBe("2026-11-16");
  });
  test("a valid decision with NO overrides is a decision: it lifts the earlier one", () => {
    put("2026-11-13", { overrides: [ov("NVDA")] });
    put("2026-11-16", { overrides: [] });
    const d = load("2026-11-16");
    expect(d?.session).toBe("2026-11-16");
    expect(d?.overrides).toEqual([]);
  });
  test("corrupt, tampered, oversized, mis-named and half-written files are ignored, never thrown", () => {
    writeFileSync(join(dir, "2026-11-16.json"), "{ not json");
    expect(load("2026-11-16")).toBeNull();
    const good = put("2026-11-13", { overrides: [ov("AAPL")] });
    // tampered after sealing: the id no longer matches
    writeFileSync(join(dir, "2026-11-16.json"), JSON.stringify({ ...sealDecision(baseDecision({ session: "2026-11-16", overrides: [ov("NVDA")] })), reviewed: 7 }));
    // a decision filed under the wrong date
    put("2026-11-12", { overrides: [ov("MSFT")] }, "2026-11-15.json");
    // a half-written transfer, junk names, a directory with a decision's name
    writeFileSync(join(dir, "2026-11-16.json.tmp"), JSON.stringify(sealDecision(baseDecision({ session: "2026-11-16" }))));
    writeFileSync(join(dir, "notes.txt"), "x");
    mkdirSync(join(dir, "2026-11-14.json"));
    // oversized (also a newer date than the good one, so it would win if it were read)
    const big = sealDecision(baseDecision({ session: "2026-11-11", dropped: Array.from({ length: 3000 }, (_, i) => ({ sleeve: null, symbol: `X${i}`, why: "y".repeat(60) })) }));
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_DECISION_BYTES);
    writeFileSync(join(dir, "2026-11-11.json"), JSON.stringify(big));
    expect(load("2026-11-16")?.id).toBe(good.id);
    rmSync(join(dir, "2026-11-13.json"));
    expect(load("2026-11-16")).toBeNull(); // nothing valid is left: the 11-11 file is oversized
  });
  test("limits are re-applied on read: never more than 3 / 6 names, ranked by confidence then symbol", () => {
    const mom = ["NVDA", "AAPL", "MSFT", "META", "AMZN"].map((s, i) => ov(s, { meanConfidence: 0.7 + i * 0.01, votes: [{ family: "claude", action: "exit", confidence: 0.7 + i * 0.01 }, { family: "gpt", action: "exit", confidence: 0.7 + i * 0.01 }] }));
    const rev = ["ABBV", "AVGO", "BAC", "CAT", "COST", "CVX", "DIS", "GE"].map(s => ov(s, { sleeve: "meanrev_stocks" }));
    put("2026-11-16", { overrides: [...mom, ...rev] });
    const d = load("2026-11-16")!;
    expect(d.overrides.filter(o => o.sleeve === "momentum_stocks").map(o => o.symbol)).toEqual(["AMZN", "META", "MSFT"]);
    expect(d.overrides.filter(o => o.sleeve === "meanrev_stocks").map(o => o.symbol)).toEqual(["ABBV", "AVGO", "BAC", "CAT", "COST", "CVX"]);
  });
  test("numbers are clamped on read: factor from the action, mean from the votes, an unsupported action lowered", () => {
    put("2026-11-16", { overrides: [
      ov("NVDA", { action: "exit", factor: 1, meanConfidence: 0.99 }),
      ov("AAPL", { action: "short", factor: 0, votes: [{ family: "claude", action: "short", confidence: 0.9 }, { family: "gpt", action: "reduce", confidence: 0.9 }] }),
      ov("MSFT", { action: "reduce", factor: 0.9 }),
    ] });
    const by = Object.fromEntries(load("2026-11-16")!.overrides.map(o => [o.symbol, o]));
    expect(by.NVDA).toMatchObject({ action: "exit", factor: 0, meanConfidence: 0.8 });
    expect(by.AAPL).toMatchObject({ action: "reduce", factor: 0.5 }); // one short vote only: degrades to the mildest
    expect(by.MSFT).toMatchObject({ action: "reduce", factor: 0.5 }); // the file says reduce, its votes would allow exit: never stronger than the file
  });
  test("an override its votes cannot justify is dropped: one family, mean below 0.6, no source", () => {
    put("2026-11-16", { overrides: [
      ov("NVDA", { votes: [{ family: "claude", action: "exit", confidence: 0.99 }] }),
      ov("AAPL", { votes: [{ family: "claude", action: "exit", confidence: 0.59 }, { family: "gpt", action: "exit", confidence: 0.59 }] }),
      ov("MSFT", { sources: [] }),
      ov("META"),
    ] });
    expect(load("2026-11-16")!.overrides.map(o => o.symbol)).toEqual(["META"]);
  });
  test("a long reason is cut to 240 and sources to 6 on read", () => {
    put("2026-11-16", { overrides: [ov("NVDA", { reason: "x".repeat(900), sources: Array.from({ length: 12 }, (_, i) => `https://a.com/${i}`) })] });
    const o = load("2026-11-16")!.overrides[0];
    expect(o.reason).toHaveLength(240);
    expect(o.sources).toHaveLength(6);
  });
});
