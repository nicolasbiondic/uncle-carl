/**
 * §12-septies G0 — meanrev execution="close1545" invariants over a
 * hand-crafted fixture (REAL MeanRevEngine through the sim adapter):
 *
 *   - NO LOOKAHEAD / 15:45 DECIDES: a symbol whose 15:45 price fires
 *     RSI(2)<5 + >SMA while its OFFICIAL close spikes (close-based RSI =
 *     100) must still be entered, and nothing after 15:45 may steer any
 *     decision (the official close only prices the fill).
 *   - ENTRY fills in the SIGNAL session's closing auction: close ± slippage,
 *     whole shares fixed at 15:45 (floor(slot / p1545)).
 *   - EXIT at the close of the first session whose 15:45 price exceeds the
 *     SMA(smaExit) of the prior closes + that price (SMA_EXIT), or at the
 *     close of the timeStopDays-th session after entry (TIME_STOP).
 *   - A session with NO 15:45 slice has no signal (no entry).
 *   - The vol-scaled hard stop: gap-through fills at the NEXT open; the
 *     entry session itself never fires the intraday stop (the position only
 *     exists from the close).
 *   - Legacy identity: the SAME config without `execution` takes the exact
 *     legacy next-open path (zero trades on this fixture, no execSplit) —
 *     the byte-identity of the legacy path is additionally anchored by
 *     scripts/regression-fingerprint.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMeanRevReplay } from "./meanrev-replay";
import type { ReplayConfig } from "./backtest-momentum-wf";

const DAY = 86_400_000;

function sessions(fromIso: string, n: number): number[] {
  const out: number[] = [];
  let t = Date.parse(fromIso) + 5 * 3_600_000; // 05:00Z = midnight ET
  while (out.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t);
    t += DAY;
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "mr1545-test-"));
const dbPath = join(dir, "fixture.db");
const sliceDbPath = join(dir, "slices.db");
const ts = sessions("2024-01-01", 70);
const K = 40; // signal session index
const dateOf = (i: number) => new Date(ts[i]).toISOString().slice(0, 10);
const sliceStartOf = (i: number) => ts[i] + 15.5 * 3_600_000; // 15:30/16:30 ET — same ET date

// ── fixture: dailies + slices ──────────────────────────────────────────────
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE historical_bars (
    symbol TEXT NOT NULL, timeframe TEXT NOT NULL, timestamp INTEGER NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL NOT NULL, source TEXT NOT NULL, fetched_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, timeframe, timestamp));`);
  const ins = db.prepare(
    "INSERT INTO historical_bars (symbol, timeframe, timestamp, open, high, low, close, volume, source) VALUES (?, '1d', ?, ?, ?, ?, ?, 0, 'alpaca_wide')",
  );
  const put = (sym: string, i: number, open: number, close: number, low?: number, high?: number) =>
    ins.run(sym, ts[i], open, high ?? Math.max(open, close) + 1, low ?? Math.min(open, close) - 1, close);

  // Signal shape shared by SIG / NOSLICE / SIG2 / SIG3:
  //   closes 100+i up to K−2 (uptrend), K−1 dips one point, session K's
  //   official bar SPIKES to close at trend+2 — only the 15:45 print dips.
  const shapedClose = (i: number): number => (i <= K - 2 ? 100 + i : i === K - 1 ? 100 + (K - 2) - 1 : 0);
  for (const sym of ["SIG", "NOSLICE", "SIG2", "SIG3"]) {
    for (let i = 0; i < K; i++) {
      const close = shapedClose(i);
      const open = i === 0 ? close : shapedClose(i - 1);
      put(sym, i, open, close);
    }
  }
  const cPrev = 100 + (K - 2) - 1; // 137 — close of session K−1
  // Session K: open at the prior close, official close spikes to 140.
  put("SIG", K, cPrev, 140);
  put("NOSLICE", K, cPrev, 140);
  put("SIG2", K, cPrev, 140);
  put("SIG3", K, cPrev, 140, 100); // low 100: would breach any stop INTRADAY — must not fire on the entry session
  // SIG: K+1 rebounds (open 140 → close 144); flat 144 afterwards.
  put("SIG", K + 1, 140, 144);
  for (let i = K + 2; i < ts.length; i++) put("SIG", i, 144, 144);
  // NOSLICE mirrors SIG after K (but never has slices).
  put("NOSLICE", K + 1, 140, 144);
  for (let i = K + 2; i < ts.length; i++) put("NOSLICE", i, 144, 144);
  // SIG2: flat 140 closes after K (time-stop path).
  for (let i = K + 1; i < ts.length; i++) put("SIG2", i, 140, 140);
  // SIG3: K+1 GAPS to 120 (through a 5% stop from ~140); flat afterwards.
  put("SIG3", K + 1, 120, 125, 118);
  for (let i = K + 2; i < ts.length; i++) put("SIG3", i, 125, 125);
  // SIG4 (director review 2026-10-14): K+1 opens ABOVE the 5% stop (139) but
  // the session's LOW (130) touches it, while the 15:45 print (143) clears
  // the SMA3 — the stop must win (fires before the 15:45 decision in live).
  for (const [sym] of [["SIG4"]]) {
    for (let i = 0; i < K; i++) {
      const close = shapedClose(i);
      const open = i === 0 ? close : shapedClose(i - 1);
      put(sym, i, open, close);
    }
  }
  put("SIG4", K, cPrev, 140);
  put("SIG4", K + 1, 139, 144, 130);
  for (let i = K + 2; i < ts.length; i++) put("SIG4", i, 144, 144);
  // REFX: flat benchmark with full coverage.
  for (let i = 0; i < ts.length; i++) put("REFX", i, 100, 100);
  db.close();

  const sdb = new Database(sliceDbPath);
  sdb.exec(`
    CREATE TABLE close_slices (symbol TEXT NOT NULL, session TEXT NOT NULL, slice_start_ms INTEGER NOT NULL, raw_c1545 REAL NOT NULL, PRIMARY KEY (symbol, session));
    CREATE TABLE raw_daily_closes (symbol TEXT NOT NULL, session TEXT NOT NULL, raw_close REAL NOT NULL, PRIMARY KEY (symbol, session));`);
  const insS = sdb.prepare("INSERT INTO close_slices (symbol, session, slice_start_ms, raw_c1545) VALUES (?, ?, ?, ?)");
  const insD = sdb.prepare("INSERT INTO raw_daily_closes (symbol, session, raw_close) VALUES (?, ?, ?)");
  // Fixture raws sit on the adjusted basis (raw_close = adjusted close), so
  // p1545_adj = adjClose × raw1545/rawClose = raw1545 exactly.
  const slice = (sym: string, i: number, p1545: number, rawClose: number) => {
    insS.run(sym, dateOf(i), sliceStartOf(i), p1545);
    insD.run(sym, dateOf(i), rawClose);
  };
  // SIG: 15:45 of K prints 136 (two down values → Cutler RSI 0; SMA10 of
  // the priors ≈ 134.3 < 136). K+1 prints 143 > SMA3(137, 140, 143) = 140.
  slice("SIG", K, 136, 140);
  slice("SIG", K + 1, 143, 144);
  // SIG2: same entry; then 130 prints keep it under the SMA3 until the
  // time stop. Slices must exist for the exit checks to run at all.
  slice("SIG2", K, 136, 140);
  for (let i = K + 1; i <= K + 6; i++) slice("SIG2", i, 130, 140);
  // SIG3: same entry; no slices afterwards (the gap stop needs none).
  slice("SIG3", K, 136, 140);
  // SIG4: same entry; K+1 slice would fire the SMA3 exit (143 > 140) — the
  // intraday stop must pre-empt it.
  slice("SIG4", K, 136, 140);
  slice("SIG4", K + 1, 143, 144);
  // NOSLICE: deliberately NO rows.
  sdb.close();
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cfgFor(universe: string[], overrides: Partial<ReplayConfig> = {}, stop: { minPct: number; maxPct: number } = { minPct: 50, maxPct: 50 }): ReplayConfig {
  return {
    sleeve: "meanrev",
    universe,
    timeframe: "1d",
    source: "alpaca_wide",
    refSymbol: "REFX",
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
    slippageBps: 2,
    commissionBps: 0,
    initialEquity: 50_000,
    leverage: 1,
    hardStopPct: 0.04,
    hardStop: { mode: "volScaled", kSigma: 3, lookbackBars: 20, ...stop },
    cadenceMin: 1440,
    notionalPctPerSlot: 0.25,
    entryPct: 0,
    exitPct: 0,
    maxLongs: 0,
    maxShorts: 0,
    shortFunding: "credit",
    meanrev: { entryRsi: 5, smaLong: 10, smaExit: 3, timeStopDays: 4, maxPositions: 2, slotPct: 0.2, execution: "close1545" },
    warmupDays: 40,
    dbPath,
    sliceDbPath,
    ...overrides,
  };
}

const win = { label: "t", from: new Date(ts[30]).toISOString(), to: new Date(ts[69] + DAY).toISOString() };
const SLIP = 2 / 10_000;

describe("meanrev close1545 execution (§12-septies G0)", () => {
  test("15:45 decides, MOC entry at the signal close, SMA5-at-15:45 exit at the close, night/day split", async () => {
    const r = await runMeanRevReplay(cfgFor(["SIG", "NOSLICE"]), win);
    expect(r).not.toBeNull();
    const res = r!;
    // Exactly one trade: SIG. NOSLICE (identical tape, no slices) never signals.
    expect(res.closedTrades).toHaveLength(1);
    const t = res.closedTrades[0];
    expect(t.symbol).toBe("SIG");
    // Entry decided at 15:45 (official close spiked: close-based RSI(2) is
    // 100 — an entry proves the 15:45 series drove the signal), filled at
    // the SIGNAL session's close ± slippage, whole shares on the 15:45 print.
    expect(t.entryPrice).toBeCloseTo(140 * (1 + SLIP), 10);
    expect(t.qty).toBe(Math.floor(50_000 * 0.2 / 136)); // 73 shares fixed at 15:45
    expect(t.entryAt).toBe(sliceStartOf(K) + 15 * 60_000); // the 15:45 decision instant
    // Exit at the close of the FIRST session whose 15:45 print beats the
    // SMA3 (137, 140 + the print): 143 > 140 → SMA_EXIT at close 144.
    expect(t.reason).toBe("SMA_EXIT");
    expect(t.exitPrice).toBeCloseTo(144 * (1 - SLIP), 10);
    // Night/day split: flat overnight (close 140 → open 140), +4/share day.
    expect(res.execSplit).toBeDefined();
    expect(res.execSplit!.nightPnl).toBeCloseTo(0, 8);
    expect(res.execSplit!.dayPnl).toBeCloseTo(t.qty! * 4, 8);
  }, 30_000);

  test("TIME_STOP fires at the close of the timeStopDays-th session after the entry close", async () => {
    const r = await runMeanRevReplay(cfgFor(["SIG2"]), win);
    const res = r!;
    expect(res.closedTrades).toHaveLength(1);
    const t = res.closedTrades[0];
    expect(t.symbol).toBe("SIG2");
    expect(t.reason).toBe("TIME_STOP");
    // Entered at close of session K; timeStopDays=4 → exits at the CLOSE of
    // session K+4 (4 overnights — same duration semantics as live's
    // open-to-open hold). Flat tape: close 140.
    expect(t.exitPrice).toBeCloseTo(140 * (1 - SLIP), 10);
    // The night/day split walked exactly 4 sessions: all legs flat → 0.
    expect(res.execSplit!.nightPnl).toBeCloseTo(0, 8);
    expect(res.execSplit!.dayPnl).toBeCloseTo(0, 8);
  }, 30_000);

  test("hard stop: never on the entry session (filled at the close), gap-through fills at the next open", async () => {
    const r = await runMeanRevReplay(cfgFor(["SIG3"], {}, { minPct: 5, maxPct: 5 }), win);
    const res = r!;
    // Entry session K has low 100 — far below any stop — yet the position
    // (born at the close) survives to K+1, where the open gaps through the
    // 5% stop and fills AT THE OPEN.
    expect(res.closedTrades).toHaveLength(1);
    const t = res.closedTrades[0];
    expect(t.reason).toBe("STOP_LOSS");
    expect(t.exitPrice).toBeCloseTo(120 * (1 - SLIP), 10);
    // Split: the stop is an OPEN fill — the whole loss is the overnight leg.
    expect(res.execSplit!.nightPnl).toBeCloseTo(t.qty! * (120 - 140), 8);
    expect(res.execSplit!.dayPnl).toBeCloseTo(0, 8);
  }, 30_000);

  test("intraday stop pre-empts the 15:45 SMA exit (director review 2026-10-14: the low prints before the decision)", async () => {
    const r = await runMeanRevReplay(cfgFor(["SIG4"], {}, { minPct: 5, maxPct: 5 }), win);
    const res = r!;
    expect(res.closedTrades).toHaveLength(1);
    const t = res.closedTrades[0];
    // K+1: open 139 > stop (≈133.03) but low 130 touches it, AND the 15:45
    // print (143) clears the SMA3 — the conservative ordering books the
    // STOP at the level BEFORE the 15:45 decision, never SMA_EXIT at 144.
    expect(t.reason).toBe("STOP_LOSS");
    const stopLevel = 140 * (1 + SLIP) * 0.95;
    expect(t.exitPrice).toBeCloseTo(stopLevel * (1 - SLIP), 10);
    // Split: overnight 140→139, then an intraday leg down to the stop.
    expect(res.execSplit!.nightPnl).toBeCloseTo(t.qty! * (139 - 140), 8);
    expect(res.execSplit!.dayPnl).toBeCloseTo(t.qty! * (stopLevel - 139), 8);
  }, 30_000);

  test("legacy identity: the same config WITHOUT execution takes the next-open path (no trade on this fixture, no execSplit)", async () => {
    const cfg = cfgFor(["SIG", "NOSLICE"]);
    delete cfg.meanrev!.execution;
    delete cfg.sliceDbPath;
    const r = await runMeanRevReplay(cfg, win);
    const res = r!;
    // Legacy signals read the COMPLETED official closes: the K−1 dip is one
    // down close after an up close (RSI 50) and session K spikes — no entry.
    expect(res.closedTrades).toHaveLength(0);
    expect(res.execSplit).toBeUndefined();
  }, 30_000);

  test("close1545 refuses membership/crypto/missing-slice configs (fail closed)", async () => {
    await expect(runMeanRevReplay(cfgFor(["SIG"], { sliceDbPath: undefined }), win)).rejects.toThrow(/sliceDbPath/);
    await expect(
      runMeanRevReplay(cfgFor(["SIG"], { membership: { index: "x" } }), win),
    ).rejects.toThrow(/membership/);
  });
});
