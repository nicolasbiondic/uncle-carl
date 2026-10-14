import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearStReversalCaches, hashStConfig, runStReversalReplay, type StReversalConfig } from "./stocks-reversal-replay";

/**
 * Synthetic-fixture invariants for the line-B reversal kernel:
 *   - NO LOOKAHEAD: a crash/spike that happens ON session d (visible in d's
 *     own bar) must not steer d's entries; it must steer d+1's.
 *   - fills at today's open ± slippage, whole shares floored on the raw open;
 *     a symbol whose open doesn't fit one share in the slot never enters.
 *   - membership is point-in-time: no entries after the tramo's end.
 *   - short borrow accrues (> 0) on overnight shorts.
 *   - the book is dollar-neutral by slots: ≤ slotsPerSide per side.
 */

const DAY = 86_400_000;

function sessions(fromIso: string, n: number): number[] {
  // Weekday timestamps at 05:00 UTC (same ET-date mapping as Alpaca dailies).
  const out: number[] = [];
  let t = Date.parse(fromIso) + 5 * 3_600_000;
  while (out.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t);
    t += DAY;
  }
  return out;
}

let dir: string;
let dbPath: string;
let ts: number[];
const CRASH_ISO = "2024-07-01"; // Monday
let crashIdx = -1;

function cfgFor(overrides: Partial<StReversalConfig> = {}): StReversalConfig {
  return {
    sleeve: "streversal",
    dbPath,
    source: "alpaca_wide",
    timeframe: "1d",
    refSymbol: "REF",
    sectorEtfs: ["ETFA"],
    membership: { index: "spx-test", exclude: [] },
    corrLookbackSessions: 30,
    sectorRefreshSessions: 21,
    slippageBps: 2,
    commissionBps: 0,
    shortBorrowAnnual: 0.5, // exaggerated so one night is measurable
    initialEquity: 8300,
    maxGrossMult: 3,
    params: { lookbackDays: 1, holdDays: 1, residual: "none", slotsPerSide: 1 },
    warmupDays: 160,
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
    ...overrides,
  };
}

// Fixture built at MODULE scope (no hook timeout: a cold transpile of the
// kernel's import graph once pushed a beforeAll past bun's 5s hook budget).
{
  dir = mkdtempSync(join(tmpdir(), "strev-test-"));
  dbPath = join(dir, "fixture.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE historical_bars (
    symbol TEXT NOT NULL, timeframe TEXT NOT NULL, timestamp INTEGER NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL NOT NULL, source TEXT NOT NULL, fetched_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, timeframe, timestamp));
  CREATE TABLE index_membership (
    index_id TEXT NOT NULL, ticker TEXT NOT NULL, start_date TEXT NOT NULL,
    end_date TEXT, source TEXT NOT NULL, source_commit TEXT NOT NULL,
    PRIMARY KEY (index_id, ticker, start_date));`);

  ts = sessions("2024-01-01", 200);
  crashIdx = ts.findIndex(t => new Date(t).toISOString().slice(0, 10) === CRASH_ISO);
  if (crashIdx <= 0) throw new Error("fixture: crash session not found");

  const insert = db.prepare(
    "INSERT INTO historical_bars (symbol, timeframe, timestamp, open, high, low, close, volume, source) VALUES (?, '1d', ?, ?, ?, ?, ?, 1000000, 'alpaca_wide')",
  );
  const put = (sym: string, i: number, open: number, close: number) =>
    insert.run(sym, ts[i], open, Math.max(open, close), Math.min(open, close), close);

  // Drifting fillers give every session a STRICT ranking so MCRASH/MRISE
  // (1-day score exactly 0) sit mid-ranking and are never slot-picked until
  // their event: AFLAT −0.10%/session, BFLAT −0.05%, YFLAT +0.05%, ZFLAT
  // +0.10%; XEXMEM −0.20% (the best long pick — while still a member).
  // open[i] = close[i−1] for the drifters.
  const drift = (sym: string, rate: number) => {
    let close = 100;
    for (let i = 0; i < ts.length; i++) {
      const open = close;
      close = close * (1 + rate);
      put(sym, i, open, close);
    }
  };
  drift("AFLAT", -0.0010);
  drift("BFLAT", -0.0005);
  drift("YFLAT", +0.0005);
  drift("ZFLAT", +0.0010);
  drift("XEXMEM", -0.0020);
  for (let i = 0; i < ts.length; i++) {
    // REF: flat timeline/benchmark. ETFA: flat (residual "none" in tests).
    put("REF", i, 100, 100);
    put("ETFA", i, 100, 100);
    // MCRASH: flat 100 until the crash SESSION, whose own bar opens/closes
    // at 50; flat 50 afterwards. MRISE: mirror up at 150.
    put("MCRASH", i, i < crashIdx ? 100 : 50, i < crashIdx ? 100 : 50);
    put("MRISE", i, i < crashIdx ? 100 : 150, i < crashIdx ? 100 : 150);
    // BIGPX: flat but never fits one share in a $12,450 slot.
    put("BIGPX", i, 99_999, 99_999);
  }
  const mem = db.prepare(
    "INSERT INTO index_membership (index_id, ticker, start_date, end_date, source, source_commit) VALUES ('spx-test', ?, '2023-01-01', ?, 'test', 'test')",
  );
  for (const sym of ["AFLAT", "BFLAT", "YFLAT", "ZFLAT", "MCRASH", "MRISE", "BIGPX"]) mem.run(sym, null);
  mem.run("XEXMEM", "2024-06-15");
  db.close();
  clearStReversalCaches();
}

afterAll(() => {
  clearStReversalCaches();
  rmSync(dir, { recursive: true, force: true });
});

describe("stocks-reversal-replay kernel", () => {
  test("no lookahead, open fills ± slippage, whole shares, PIT membership, borrow, neutrality", async () => {
    const cfg = cfgFor();
    const win = { label: "t", from: "2024-06-03T00:00:00Z", to: "2024-09-02T00:00:00Z" };
    const r = await runStReversalReplay(cfg, win);
    expect(r).not.toBeNull();
    const res = r!;
    expect(res.trades).toBeGreaterThan(0);

    const crashTs = ts[crashIdx];
    const slip = cfg.slippageBps / 10_000;

    // NO LOOKAHEAD: on the crash session itself MCRASH/MRISE's COMPLETED
    // signals are still 0 (mid-ranking vs the drifting fillers) — the crash
    // visible in that session's own bar must not steer that session's picks.
    const enteredOnCrashDay = res.closedTrades.filter(t => t.entryAt === crashTs);
    expect(enteredOnCrashDay.every(t => t.symbol !== "MCRASH" && t.symbol !== "MRISE")).toBe(true);

    // NEXT session the completed −50%/+50% returns must drive both sides:
    // long MCRASH at open 50×(1+slip), short MRISE at open 150×(1−slip).
    const nextTs = ts[crashIdx + 1];
    const longCrash = res.closedTrades.find(t => t.entryAt === nextTs && t.symbol === "MCRASH");
    const shortRise = res.closedTrades.find(t => t.entryAt === nextTs && t.symbol === "MRISE");
    expect(longCrash?.side).toBe("buy");
    expect(longCrash?.entryPrice).toBeCloseTo(50 * (1 + slip), 10);
    expect(shortRise?.side).toBe("sell");
    expect(shortRise?.entryPrice).toBeCloseTo(150 * (1 - slip), 10);
    // Whole shares floored on the raw open: slot $12,450 → 249 @ 50, 83 @ 150.
    expect(longCrash?.qty).toBe(Math.floor(12_450 / 50));
    expect(shortRise?.qty).toBe(Math.floor(12_450 / 150));

    // holdDays=1: both exit at the NEXT session's open (flat tapes → open 50/150).
    expect(longCrash?.exitAt).toBe(ts[crashIdx + 2]);
    expect(longCrash?.exitPrice).toBeCloseTo(50 * (1 - slip), 10);
    expect(shortRise?.exitPrice).toBeCloseTo(150 * (1 + slip), 10);

    // Price exclusion: BIGPX never fits one share.
    expect(res.closedTrades.every(t => t.symbol !== "BIGPX")).toBe(true);

    // PIT membership: XEXMEM's tramo ends 2024-06-15 — no entries at/after it.
    const exmemAfter = res.closedTrades.filter(
      t => t.symbol === "XEXMEM" && (t.entryAt ?? 0) >= Date.parse("2024-06-15"),
    );
    expect(exmemAfter).toHaveLength(0);

    // Short borrow accrued on overnight shorts (0.5/yr exaggerated rate).
    expect(res.funding).toBeGreaterThan(0);
    const expectedOneNight = shortRise!.qty! * 150 * 0.5 * (1 / 365);
    expect(shortRise!.pnl).toBeCloseTo(
      (shortRise!.entryPrice! - shortRise!.exitPrice!) * shortRise!.qty! - expectedOneNight, 6,
    );

    // Dollar-neutral by construction: both sides filled every session the
    // book is active (1 long + 1 short per the fixture's ample candidates).
    // Orders = 2 × closed trades.
    expect(res.ordersPerSession).toBeCloseTo((res.trades * 2) / res.sessions, 12);
  }, 30_000);

  test("B2 sizing: equity-proportional slots, fractional longs, whole-share shorts, gross ≤ 2× equity", async () => {
    const cfg = cfgFor({
      maxGrossMult: 2,
      sizing: "equityProportional",
      fractionalLongs: true,
      shortBorrowAnnual: 0.005,
    });
    const win = { label: "b2", from: "2024-06-03T00:00:00Z", to: "2024-09-02T00:00:00Z" };
    const r = await runStReversalReplay(cfg, win);
    expect(r).not.toBeNull();
    const res = r!;
    expect(res.trades).toBeGreaterThan(0);

    // Shorts stay WHOLE shares (§12-bis); longs size exactly (fractional).
    const shorts = res.closedTrades.filter(t => t.side === "sell");
    const longs = res.closedTrades.filter(t => t.side === "buy");
    expect(shorts.length).toBeGreaterThan(0);
    expect(longs.length).toBeGreaterThan(0);
    for (const t of shorts) expect(Number.isInteger(t.qty)).toBe(true);
    expect(longs.some(t => !Number.isInteger(t.qty))).toBe(true);

    // First session (equity exactly $8,300, empty book): slot = 8300×2/2 =
    // $8,300 → the long's entry NOTIONAL equals the slot exactly (fractional
    // sizing on the raw open; fill carries the slippage).
    const slip = cfg.slippageBps / 10_000;
    const firstLong = longs.sort((a, b) => (a.entryAt ?? 0) - (b.entryAt ?? 0))[0];
    expect(firstLong.qty! * (firstLong.entryPrice! / (1 + slip))).toBeCloseTo(8300, 6);

    // Equity-proportional sizing: later slots move with equity — some long
    // entry notional must differ from the first session's $8,300 slot.
    expect(longs.some(t => Math.abs(t.qty! * (t.entryPrice! / (1 + slip)) - 8300) > 1)).toBe(true);

    // Gross cap: never above 2× the running peak equity (loose bound: the
    // cap compares against DECISION-TIME equity; marks drift after entry).
    const peakEq = Math.max(...res.equityHistory.map(p => p.eq));
    expect(res.maxGrossSeen).toBeLessThanOrEqual(2 * peakEq * 1.05);
  }, 30_000);

  test("config hash excludes dbPath and moves with every semantic knob", () => {
    const a = cfgFor();
    const b = cfgFor();
    expect(hashStConfig(a)).toBe(hashStConfig(b));
    expect(hashStConfig({ ...a, dbPath: "/elsewhere.db" })).toBe(hashStConfig(a));
    expect(hashStConfig({ ...a, slippageBps: 5 })).not.toBe(hashStConfig(a));
    expect(hashStConfig({ ...a, shortBorrowAnnual: 0.01 })).not.toBe(hashStConfig(a));
    expect(hashStConfig({ ...a, params: { ...a.params, holdDays: 5 } })).not.toBe(hashStConfig(a));
    expect(hashStConfig({ ...a, membership: { ...a.membership, exclude: ["X"] } })).not.toBe(hashStConfig(a));
    // B2 axis is opt-in: absent keys keep the legacy hash; set keys move it.
    expect(hashStConfig({ ...a, sizing: undefined, fractionalLongs: undefined })).toBe(hashStConfig(a));
    expect(hashStConfig({ ...a, sizing: "equityProportional" })).not.toBe(hashStConfig(a));
    expect(hashStConfig({ ...a, fractionalLongs: true })).not.toBe(hashStConfig(a));
  }, 30_000);
});
