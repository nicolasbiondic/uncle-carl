// ═══════════════════════════════════════════════════════════════════════
// rehearse-daily-pass fixture test — synthetic snapshot + historical DBs.
//
// Builds ~320 weekday sessions (the wired blend needs 252 + MA margin = 263) of deterministic daily bars for BOTH live
// stock universes, a trading.db snapshot with seeded open positions and
// per-sleeve equity, and asserts the dry run plans the expected pass:
//   - meanrev: crafted RSI2≈0 candidate opens at baseUsd×slotPct with a
//     vol stop; a seeded above-SMA5 position closes SMA_EXIT; a symbol
//     already entered TODAY in the ledger is NOT re-entered (idempotency
//     seam); slot arithmetic respects maxPositions.
//   - momentum: only the crafted uptrends enter, at equity×0.125/slot,
//     with vol-scaled stops inside the {5..30}% band; nothing was written
//     to either DB (read-only contract).
// ═══════════════════════════════════════════════════════════════════════
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rehearse } from "./rehearse-daily-pass";
import { MOMENTUM_STOCKS_UNIVERSE } from "../src/config/riskProfiles";
import { DEFAULT_MEANREV_CONFIG, MEANREV_UNIVERSE } from "../src/strategies/meanrev/MeanRevEngine";
import { getETDayBounds } from "../src/db/database";

const dir = mkdtempSync(join(tmpdir(), "rehearse-fixture-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ── deterministic sessions: weekdays ending 2026-09-24 ──────────────────
const SESSIONS: string[] = (() => {
  const out: string[] = [];
  const d = new Date(Date.UTC(2026, 8, 24, 12, 0, 0)); // noon UTC = same ET date
  while (out.length < 320) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
})();
const N = SESSIONS.length;
const ts = (dateKey: string) => Date.parse(`${dateKey}T12:00:00Z`);

/** Price path per symbol: crafted signals, decorrelated wiggles. */
function priceAt(symbol: string, i: number): number {
  const wiggle = (freq: number, amp: number) => 1 + amp * Math.sin(i / freq + symbol.length);
  switch (symbol) {
    // momentum uptrends (TSM 126d return ≫ 5%, above MA200):
    case "NVDA": return 100 * Math.pow(1.002, i) * wiggle(7, 0.01);
    case "MSFT": return 300 * Math.pow(1.0018, i) * wiggle(11, 0.012);
    case "SMH": return 200 * Math.pow(1.0016, i) * wiggle(13, 0.008);
    // meanrev entry candidates: long uptrend, two down closes at the end:
    case "COST":
    case "KO": {
      const base = 100 + 0.3 * i;
      return i >= N - 2 ? base * (i === N - 2 ? 0.99 : 0.975) : base;
    }
    // seeded meanrev position that must SMA_EXIT (close > SMA5):
    case "PG": return 80 * Math.pow(1.005, i);
    // everything else: gentle drift down + alternation (no TSM entry,
    // RSI2 ≈ 50, below no MA threshold drama):
    default: {
      const alt = i % 2 === 0 ? 1.001 : 0.999;
      return 100 * Math.pow(0.9997, i) * alt * wiggle(17, 0.004);
    }
  }
}

function buildHist(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE historical_bars (
    symbol TEXT NOT NULL, timeframe TEXT NOT NULL, timestamp INTEGER NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY (symbol, timeframe, timestamp))`);
  const ins = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
  const symbols = [...new Set([...MOMENTUM_STOCKS_UNIVERSE, ...MEANREV_UNIVERSE])];
  const tx = db.transaction(() => {
    for (const sym of symbols) {
      for (let i = 0; i < N; i++) {
        const c = priceAt(sym, i);
        ins.run(sym, "1d", ts(SESSIONS[i]), c * 0.999, c * 1.005, c * 0.995, c, 1000, "alpaca_wide");
      }
    }
  });
  tx();
  db.close();
}

const SIM_NOW = Date.parse("2026-09-25T13:36:00Z"); // Friday 09:36 ET, next session after 09-24

function buildSnapshot(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE trades (
    id TEXT PRIMARY KEY, account_id TEXT, symbol TEXT, side TEXT, entry_price REAL,
    quantity REAL, entry_time INTEGER, exit_time INTEGER, status TEXT)`);
  db.run(`CREATE TABLE equity_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, equity REAL, cash REAL, snapshot_time INTEGER)`);
  const insTrade = db.prepare("INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?)");
  // Seeded meanrev position, entered 6 sessions ago — rising, so SMA_EXIT.
  insTrade.run("t1", "meanrev_stocks", "PG", "buy", 118, 42, ts(SESSIONS[N - 6]) + 3_600_000, null, "open");
  // KO entered AND exited TODAY (the QCOM 2026-09-25 class): the durable
  // once-per-symbol/day barrier must block a re-entry this pass.
  const [todayStart] = getETDayBounds("2026-09-25");
  insTrade.run("t2", "meanrev_stocks", "KO", "buy", 170, 29, todayStart + (9 * 60 + 36) * 60_000 - 120_000, todayStart + (9 * 60 + 41) * 60_000, "closed");
  const insEq = db.prepare("INSERT INTO equity_snapshots (profile_id, equity, cash, snapshot_time) VALUES (?,?,?,?)");
  insEq.run("momentum_stocks", 60_000, 0, SIM_NOW - 300_000);
  insEq.run("meanrev_stocks", 50_000, 30_000, SIM_NOW - 300_000);
  // Stale older snapshot rows must NOT win:
  insEq.run("momentum_stocks", 11_111, 0, SIM_NOW - 86_400_000);
  db.close();
}

const histPath = join(dir, "hist.db");
const dbPath = join(dir, "snapshot.db");
buildHist(histPath);
buildSnapshot(dbPath);

const plans = await rehearse({ dbPath, histPath, nowMs: SIM_NOW });

describe("rehearse-daily-pass — meanrev plan", () => {
  test("status ok (all universe bars fresh through the previous session)", () => {
    expect(plans.meanrev.status).toBe("ok");
    expect(plans.meanrev.errors).toEqual([]);
    expect(plans.meanrev.signalSession).toBe("2026-09-24");
  });

  test("seeded PG (close > SMA5) closes with SMA_EXIT", () => {
    expect(plans.meanrev.closes).toContainEqual({ symbol: "PG", reason: "SMA_EXIT" });
  });

  test("crafted RSI2≈0 candidate COST opens at baseUsd×slotPct with a vol stop in [2,12]%", () => {
    const cost = plans.meanrev.opens.find(o => o.symbol === "COST");
    expect(cost).toBeDefined();
    expect(cost!.notionalUsd).toBeCloseTo(50_000 * DEFAULT_MEANREV_CONFIG.slotPct, 2);
    expect(cost!.estQty).toBeGreaterThan(0);
    expect(cost!.stopLossPct).toBeGreaterThanOrEqual(2);
    expect(cost!.stopLossPct).toBeLessThanOrEqual(12);
    expect(cost!.estStopPrice).toBeLessThan(cost!.estPrice);
  });

  test("KO (already entered today in the snapshot ledger) is NOT re-entered", () => {
    expect(plans.meanrev.opens.map(o => o.symbol)).not.toContain("KO");
  });

  test("equity comes from the LATEST equity_snapshots row", () => {
    expect(plans.meanrev.equity).toBe(50_000);
  });
});

describe("rehearse-daily-pass — momentum plan", () => {
  test("only the crafted uptrends enter, ≤ maxLongs, sized equity×0.125/slot", () => {
    const symbols = plans.momentum.opens.map(o => o.symbol).sort();
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.length).toBeLessThanOrEqual(8);
    for (const s of symbols) expect(["NVDA", "MSFT", "SMH"]).toContain(s);
    for (const o of plans.momentum.opens) {
      expect(o.notionalUsd).toBeCloseTo(60_000 * 0.125, 2);
      expect(o.stopLossPct).toBeGreaterThanOrEqual(5);
      expect(o.stopLossPct).toBeLessThanOrEqual(30);
    }
  });

  test("latest snapshot equity wins over the stale row", () => {
    expect(plans.momentum.equity).toBe(60_000);
  });

  test("no seeded momentum positions → no closes", () => {
    expect(plans.momentum.seeded).toEqual([]);
    expect(plans.momentum.closes).toEqual([]);
  });
});

describe("read-only contract", () => {
  test("neither fixture DB gained rows", () => {
    const snap = new Database(dbPath, { readonly: true });
    expect((snap.prepare("SELECT COUNT(*) c FROM trades").get() as any).c).toBe(2);
    snap.close();
    const hist = new Database(histPath, { readonly: true });
    const c = (hist.prepare("SELECT COUNT(*) c FROM historical_bars").get() as any).c;
    expect(c).toBe(N * new Set([...MOMENTUM_STOCKS_UNIVERSE, ...MEANREV_UNIVERSE]).size);
    hist.close();
  });
});
