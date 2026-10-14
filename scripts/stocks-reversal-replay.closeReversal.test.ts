/**
 * §12-septies line G — closeReversal kernel invariants over hand-crafted
 * fixtures (one scenario symbol per test, flat fillers everywhere else):
 *
 *   - NO LOOKAHEAD / 15:45 DECIDES: the long (short) signal is RSI(2) over
 *     [prior closes…, p1545] — a session whose OFFICIAL close moves the
 *     other way must still be decided by the 15:45 print, and the close
 *     only prices the MOC fill.
 *   - ENTRIES fill at the SIGNAL session's close ± slippage, whole shares
 *     fixed at 15:45 (floor(slot / p1545)).
 *   - G1 ("nextOpen", hold 1): exit at the NEXT session's open ∓ slippage.
 *   - G2 ("nextClose", hold ≤ 5): held while still among the top-N signal
 *     names at 15:45 (no sell+rebuy), exit at the close when the signal
 *     drops out, TIME_EXIT at the 5th session's close.
 *   - G3 ("sma5", hold ≤ 10, meanrev vol stop): SMA(5-at-15:45) exit at the
 *     close; gap-through stop at the next OPEN; the entry session never
 *     fires the intraday stop.
 *   - G4 (mirror short): RSI(2) > 95 and p1545 < SMA(prior) sells the close,
 *     covers the next open; borrow accrues on the short night.
 *   - Legacy identity: absent closeReversal the kernel is the line-B/B2
 *     path (its own test file still passes) and the config hash ignores the
 *     runtime-only sliceDbPath.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearStReversalCaches, hashStConfig, runStReversalReplay, type CloseReversalSpec, type StReversalConfig } from "./stocks-reversal-replay";

const DAY = 86_400_000;

function sessions(fromIso: string, n: number): number[] {
  const out: number[] = [];
  let t = Date.parse(fromIso) + 5 * 3_600_000;
  while (out.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t);
    t += DAY;
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "strev1545-test-"));
const dbPath = join(dir, "fixture.db");
const sliceDbPath = join(dir, "slices.db");
const ts = sessions("2024-01-01", 70);
const K = 40;
const dateOf = (i: number) => new Date(ts[i]).toISOString().slice(0, 10);
const sliceStartOf = (i: number) => ts[i] + 15.5 * 3_600_000;

{
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
  const ins = db.prepare(
    "INSERT INTO historical_bars (symbol, timeframe, timestamp, open, high, low, close, volume, source) VALUES (?, '1d', ?, ?, ?, ?, ?, 1000, 'alpaca_wide')",
  );
  const put = (sym: string, i: number, open: number, close: number, low?: number, high?: number) =>
    ins.run(sym, ts[i], open, high ?? Math.max(open, close) + 0.5, low ?? Math.min(open, close) - 0.5, close);

  // Long-dip shape: +1/session to K−2, one-point dip at K−1, official bar K
  // spikes to 140 while only the 15:45 print dips (no-lookahead probe).
  const upDip = (sym: string) => {
    for (let i = 0; i < K; i++) {
      const close = i <= K - 2 ? 100 + i : 100 + (K - 2) - 1;
      const open = i === 0 ? close : i - 1 <= K - 2 ? 100 + (i - 1) : 0;
      put(sym, i, open, close);
    }
    put(sym, K, 100 + (K - 2) - 1, 140);
  };
  upDip("LG1"); // G1/G4 long leg: K+1 opens 141
  put("LG1", K + 1, 141, 141);
  for (let i = K + 2; i < ts.length; i++) put("LG1", i, 141, 141);
  upDip("LG3"); // G3 SMA-exit: K+1 opens 140, closes 144
  put("LG3", K + 1, 140, 144);
  for (let i = K + 2; i < ts.length; i++) put("LG3", i, 144, 144);
  upDip("GDN"); // G3 gap stop: entry-session low 100 (must NOT stop), K+1 gaps to 120
  db.prepare("DELETE FROM historical_bars WHERE symbol='GDN' AND timestamp=?").run(ts[K]);
  put("GDN", K, 100 + (K - 2) - 1, 140, 100);
  put("GDN", K + 1, 120, 125, 118);
  for (let i = K + 2; i < ts.length; i++) put("GDN", i, 125, 125);

  // G2 keep-then-drop: declining closes 136, 135, then a 137.5 rebound.
  for (let i = 0; i < K; i++) {
    const close = i <= K - 2 ? 100 + i : 100 + (K - 2) - 1;
    put("LGB", i, i === 0 ? close : i - 1 <= K - 2 ? 100 + (i - 1) : 0, close);
  }
  put("LGB", K, 137, 136);
  put("LGB", K + 1, 136, 135);
  put("LGB", K + 2, 135, 137.5);
  for (let i = K + 3; i < ts.length; i++) put("LGB", i, 137.5, 137.5);

  // G2 max-hold: steep +3/session uptrend, then −1/session declines whose
  // 15:45 prints keep the signal alive past the 5-session cap.
  for (let i = 0; i < K; i++) {
    const close = i <= K - 2 ? 100 + 3 * i : 100 + 3 * (K - 2) - 1; // 213 at K−1
    put("LGC", i, i === 0 ? close : i - 1 <= K - 2 ? 100 + 3 * (i - 1) : 0, close);
  }
  for (let i = K; i < ts.length; i++) {
    const close = 212 - (i - K);
    put("LGC", i, close + 1, close);
  }

  // G4 short mirror: downtrend −1/session with a 2-step 15:45 rally at K
  // while the OFFICIAL close crashes to 110 (no-lookahead probe: a
  // close-based RSI(2) would be ~0, far from >95).
  for (let i = 0; i < K; i++) {
    const close = i <= K - 2 ? 160 - i : 160 - (K - 2) + 1; // 123 at K−1
    put("DNT", i, i === 0 ? close : i - 1 <= K - 2 ? 160 - (i - 1) : 0, close);
  }
  put("DNT", K, 123, 110, 109);
  put("DNT", K + 1, 109, 109);
  for (let i = K + 2; i < ts.length; i++) put("DNT", i, 109, 109);

  // Timeline + sector ETF (flat; residual is "none" in this mode).
  for (let i = 0; i < ts.length; i++) {
    put("REF", i, 100, 100);
    put("ETFA", i, 100, 100);
  }
  const mem = db.prepare(
    "INSERT INTO index_membership (index_id, ticker, start_date, end_date, source, source_commit) VALUES ('spx-test', ?, '2023-01-01', NULL, 'test', 'test')",
  );
  for (const sym of ["LG1", "LG3", "GDN", "LGB", "LGC", "DNT"]) mem.run(sym);
  db.close();

  const sdb = new Database(sliceDbPath);
  sdb.exec(`
    CREATE TABLE close_slices (symbol TEXT NOT NULL, session TEXT NOT NULL, slice_start_ms INTEGER NOT NULL, raw_c1545 REAL NOT NULL, PRIMARY KEY (symbol, session));
    CREATE TABLE raw_daily_closes (symbol TEXT NOT NULL, session TEXT NOT NULL, raw_close REAL NOT NULL, PRIMARY KEY (symbol, session));`);
  const insS = sdb.prepare("INSERT INTO close_slices (symbol, session, slice_start_ms, raw_c1545) VALUES (?, ?, ?, ?)");
  const insD = sdb.prepare("INSERT INTO raw_daily_closes (symbol, session, raw_close) VALUES (?, ?, ?)");
  const slice = (sym: string, i: number, p1545: number, rawClose: number) => {
    insS.run(sym, dateOf(i), sliceStartOf(i), p1545);
    insD.run(sym, dateOf(i), rawClose);
  };
  slice("LG1", K, 136, 140);
  slice("LG3", K, 136, 140);
  slice("LG3", K + 1, 143, 144); // > SMA5 of (137,138,137,140,+p) ⇒ SMA_EXIT
  slice("GDN", K, 136, 140);
  slice("LGB", K, 135.5, 136);   // RSI 0, > SMA20(prior)
  slice("LGB", K + 1, 134.5, 135); // still signalling → kept
  slice("LGB", K + 2, 137, 137.5); // RSI ~67 → drops out → close exit
  // Slices only through K+4: the keep decisions at K+1..K+4 see the signal,
  // the cap exit at K+5 needs no slice, and no re-entry can follow it.
  for (let j = 0; j <= 4; j++) slice("LGC", K + j, (212 - j) - 0.5, 212 - j);
  slice("DNT", K, 124, 110);     // RSI 100 (two up 15:45 steps), < SMA20(prior)
  sdb.close();
  clearStReversalCaches();
}

afterAll(() => {
  clearStReversalCaches();
  rmSync(dir, { recursive: true, force: true });
});

const CR_BASE: CloseReversalSpec = { entryRsi: 5, smaLong: 20, minPrice: 5, minPriorCloses: 25, exit: "nextOpen" };

function cfgFor(cr: CloseReversalSpec, holdDays: number, overrides: Partial<StReversalConfig> = {}): StReversalConfig {
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
    shortBorrowAnnual: 0.005,
    initialEquity: 10_000,
    maxGrossMult: 2,
    params: { lookbackDays: 1, holdDays, residual: "none", slotsPerSide: 10 },
    warmupDays: 40,
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
    sizing: "equityProportional",
    closeReversal: cr,
    sliceDbPath,
    ...overrides,
  };
}

const win = { label: "t", from: new Date(ts[30]).toISOString(), to: new Date(ts[69] + DAY).toISOString() };
const SLIP = 2 / 10_000;
const SLOT = 10_000 * 2 / (2 * 10); // $1,000 at the initial equity

describe("stocks-reversal closeReversal (§12-septies G)", () => {
  test("G1: 15:45 decides, MOC entry at the signal close, exit at the next OPEN; night split", async () => {
    const r = await runStReversalReplay(cfgFor({ ...CR_BASE }, 1, { dbPath, membership: { index: "spx-test", exclude: ["LG3", "GDN", "LGB", "LGC", "DNT"] } }), win);
    const res = r!;
    expect(res.closedTrades).toHaveLength(1);
    const t = res.closedTrades[0];
    expect(t.symbol).toBe("LG1");
    expect(t.side).toBe("buy");
    // Official close spiked to 140 (close-based RSI(2) = 100): the entry
    // proves the 15:45 series (…138, 137, 136 → RSI 0) drove the decision.
    expect(t.entryPrice).toBeCloseTo(140 * (1 + SLIP), 10);
    expect(t.qty).toBe(Math.floor(SLOT / 136)); // whole shares fixed at 15:45
    // Exit at the NEXT session's open − slippage (G1 "una noche").
    expect(t.reason).toBe("OPEN_EXIT");
    expect(t.exitPrice).toBeCloseTo(141 * (1 - SLIP), 10);
    // Night/day: the whole gross move is the overnight leg (exit AT the open).
    expect(res.nightPnl!).toBeCloseTo(t.qty! * (141 - 140), 8);
    expect(res.dayPnl!).toBeCloseTo(0, 8);
    expect(res.signalStats).toBeDefined();
  }, 30_000);

  test("G2: kept while still in the top-N at 15:45 (no churn), exits at the close when the signal drops; TIME_EXIT at the 5th", async () => {
    const r = await runStReversalReplay(
      cfgFor({ ...CR_BASE, exit: "nextClose" }, 5, { membership: { index: "spx-test", exclude: ["LG1", "LG3", "GDN", "DNT"] } }),
      win,
    );
    const res = r!;
    const lgb = res.closedTrades.filter(t => t.symbol === "LGB");
    const lgc = res.closedTrades.filter(t => t.symbol === "LGC");
    // LGB: one position held K→K+2 (kept at K+1 — still signalling), sold at
    // the K+2 close when the 15:45 print lost the signal. NO sell+rebuy.
    expect(lgb).toHaveLength(1);
    expect(lgb[0].entryPrice).toBeCloseTo(136 * (1 + SLIP), 10);
    expect(lgb[0].reason).toBe("CLOSE_EXIT");
    expect(lgb[0].exitPrice).toBeCloseTo(137.5 * (1 - SLIP), 10);
    // LGC: signal persists past the cap → TIME_EXIT at the 5th session's close.
    expect(lgc).toHaveLength(1);
    expect(lgc[0].reason).toBe("TIME_EXIT");
    expect(lgc[0].exitPrice).toBeCloseTo((212 - 5) * (1 - SLIP), 10);
  }, 30_000);

  test("G3: SMA5-at-15:45 exit at the close; gap-through stop at the next open, never on the entry session", async () => {
    const r = await runStReversalReplay(
      cfgFor(
        { ...CR_BASE, exit: "sma5", smaExit: 5, hardStop: { kSigma: 3, lookbackBars: 20, minPct: 5, maxPct: 5 } },
        10,
        { membership: { index: "spx-test", exclude: ["LG1", "LGB", "LGC", "DNT"] } },
      ),
      win,
    );
    const res = r!;
    const lg3 = res.closedTrades.filter(t => t.symbol === "LG3");
    const gdn = res.closedTrades.filter(t => t.symbol === "GDN");
    expect(lg3).toHaveLength(1);
    expect(lg3[0].reason).toBe("SMA_EXIT"); // 143 > SMA5(137,138,137,140,143)=139
    expect(lg3[0].exitPrice).toBeCloseTo(144 * (1 - SLIP), 10);
    // GDN: entry-session low 100 is FAR below the 5% stop yet no stop fires
    // on the entry session (position born at the close); the K+1 open gaps
    // through the stop and fills AT THE OPEN.
    expect(gdn).toHaveLength(1);
    expect(gdn[0].reason).toBe("STOP_LOSS");
    expect(gdn[0].exitPrice).toBeCloseTo(120 * (1 - SLIP), 10);
  }, 30_000);

  test("G4: mirror short sells the close on a 15:45 rally (official close crashed), covers the next open, pays borrow", async () => {
    const r = await runStReversalReplay(
      cfgFor({ ...CR_BASE, short: { entryRsi: 95 } }, 1, { membership: { index: "spx-test", exclude: ["LG3", "GDN", "LGB", "LGC"] } }),
      win,
    );
    const res = r!;
    const short = res.closedTrades.find(t => t.symbol === "DNT");
    const long = res.closedTrades.find(t => t.symbol === "LG1");
    expect(long?.side).toBe("buy"); // G1 long leg still trades
    expect(short?.side).toBe("sell");
    // 15:45 printed a 2-step rally (122→123→124: RSI 100 > 95, below the
    // SMA20 of the downtrend) while the OFFICIAL close crashed to 110 — a
    // close-based signal would be the opposite side. Fill at the close.
    expect(short?.entryPrice).toBeCloseTo(110 * (1 - SLIP), 10);
    expect(short?.qty).toBe(Math.floor(SLOT / 124)); // whole shares at the 15:45 print
    // Cover at the next OPEN + slippage; one short night pays borrow.
    expect(short?.exitPrice).toBeCloseTo(109 * (1 + SLIP), 10);
    expect(res.funding).toBeGreaterThan(0);
    // Per-leg P&L signs: short gained (110→109) minus borrow.
    expect(short!.pnl).toBeGreaterThan(0);
    expect(res.signalStats?.avgShortSignals).toBeGreaterThan(0);
  }, 30_000);

  test("legacy identity: hashStConfig ignores the runtime-only sliceDbPath; legacy results carry no closeReversal extras", async () => {
    const legacy: StReversalConfig = { ...cfgFor({ ...CR_BASE }, 1), closeReversal: undefined, sliceDbPath: undefined, sizing: undefined, params: { lookbackDays: 1, holdDays: 1, residual: "none", slotsPerSide: 2 } };
    const withPath: StReversalConfig = { ...legacy, sliceDbPath: "/tmp/irrelevant.db" };
    expect(hashStConfig(withPath)).toBe(hashStConfig(legacy));
    const r = await runStReversalReplay(legacy, win);
    expect(r!.nightPnl).toBeUndefined();
    expect(r!.signalStats).toBeUndefined();
  }, 30_000);
});
