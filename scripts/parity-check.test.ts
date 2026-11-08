// ═══════════════════════════════════════════════════════════════════════
// parity-check unit tests — synthetic fixtures over the pure comparison
// layer (extractLiveDecisions / extractSimDecisions / compareDecisions).
// The three canonical scenarios: perfect parity, an entry missing live,
// an extra live exit. Plus the tolerance and pre-epoch-ignore semantics
// the monitor's guarantees rest on.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MATCH_TOLERANCE_DAYS,
  MATCH_TOLERANCE_HOURS_CRYPTO,
  compareDailyHoldings,
  compareDecisions,
  compareCryptoReplay,
  checkPortfolioSleeve,
  lastCompletedStockSession,
  PORTFOLIO_FLOAT_TOLERANCE,
  extractLiveDecisions,
  extractSeedPositions,
  extractSimDecisions,
  heldSymbolsAt,
  isoInstant,
  normalizeLiveDecisions,
  normalizeSeedPositions,
  PARITY_EPOCHS,
  renderSummary,
  clampToFundingTail,
  splitAcknowledged,
  fundingTailMs,
  utcDayCloses,
  type SleeveDecisions,
} from "./parity-check";
import { runWithConfig, SimBroker, type ClosedTrade, type SeedPosition } from "./backtest-momentum-wf";
import { candidateToReplayConfig, type ExperimentManifest } from "./walk-forward";
import { getETDayBounds } from "../src/db/database";
import { liveSleeveConfig } from "../src/config/liveSleeveConfigs";
import { currentModelVersion, MODEL_VERSIONS } from "../src/portfolio/modelVersions";
import { decide } from "../src/portfolio-engine/decide";
import { planOrders } from "../src/portfolio-engine/orders";
import { HistoricalPriceView } from "../src/portfolio-engine/live/priceView";
import { latestPortfolioMemory, type PersistedOrder } from "../src/portfolio-engine/live/persistence";
import type { VolManagedConfig, Position } from "../src/portfolio-engine/types";

// ── fixture helpers ───────────────────────────────────────────────────────
const [EPOCH_START] = getETDayBounds("2026-09-25");
const [, WINDOW_END] = getETDayBounds("2026-10-02");

/** ms timestamp inside the ET session of `dateKey` (~09:36 ET). */
function at(dateKey: string): number {
  const [start] = getETDayBounds(dateKey);
  return start + (9 * 60 + 36) * 60_000;
}

function makeTradingDb(rows: Array<{
  symbol: string; entry: string; exit?: string; status?: string; account?: string;
  side?: string; entryPrice?: number; quantity?: number; stopLoss?: number | null;
  strategy?: string;
}>): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE trades (
    id TEXT PRIMARY KEY, account_id TEXT, symbol TEXT, side TEXT,
    entry_price REAL, quantity REAL, stop_loss REAL,
    entry_time INTEGER, exit_time INTEGER, status TEXT, close_reason TEXT, strategy TEXT
  )`);
  const ins = db.prepare(
    "INSERT INTO trades (id, account_id, symbol, side, entry_price, quantity, stop_loss, entry_time, exit_time, status, strategy) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  rows.forEach((r, i) => ins.run(
    `t${i}`, r.account ?? "meanrev_stocks", r.symbol, r.side ?? "buy",
    r.entryPrice ?? 100, r.quantity ?? 10, r.stopLoss ?? null,
    at(r.entry), r.exit ? at(r.exit) : null, r.status ?? (r.exit ? "closed" : "open"),
    r.strategy ?? "MOMENTUM",
  ));
  return db;
}

function simTrade(symbol: string, entry: string, exit: string, reason: string): ClosedTrade {
  return { symbol, side: "buy", pnl: 0, exitAt: at(exit), reason, entryAt: at(entry) };
}

// ── extraction ────────────────────────────────────────────────────────────
describe("extractLiveDecisions", () => {
  test("a pre-epoch position's ENTRY is ignored (nothing decided it this window), but its exit/holding is NOT (OPEN.md P2 fix)", () => {
    const db = makeTradingDb([
      { symbol: "XLE", entry: "2026-09-23", exit: "2026-09-29" },      // pre-epoch, exited IN-window → exit counts, no entry
      { symbol: "KO", entry: "2026-09-25" },                            // in-window, still open → holding
      { symbol: "MRK", entry: "2026-09-25", exit: "2026-09-30" },       // in-window round trip
    ]);
    const live = extractLiveDecisions(db, "meanrev_stocks", EPOCH_START, WINDOW_END);
    expect(live.entries).toEqual([
      { symbol: "KO", date: "2026-09-25" },
      { symbol: "MRK", date: "2026-09-25" },
    ]);
    expect(live.exits).toEqual([
      { symbol: "XLE", date: "2026-09-29" },
      { symbol: "MRK", date: "2026-09-30" },
    ]);
    expect(live.endHoldings).toEqual(["KO"]);
  });

  test("a pre-epoch position STILL open at the epoch is a holding, exactly like a seed (extractSeedPositions shares this exact row set)", () => {
    const db = makeTradingDb([{ symbol: "KO", entry: "2026-09-20" }]); // open before AND through the epoch
    const live = extractLiveDecisions(db, "meanrev_stocks", EPOCH_START, WINDOW_END);
    expect(live.entries).toEqual([]); // no in-window decision opened it
    expect(live.endHoldings).toEqual(["KO"]);
  });

  test("a pre-epoch position that ALSO exited before the epoch is invisible (irrelevant by the epoch — nothing to seed or compare)", () => {
    const db = makeTradingDb([{ symbol: "XLE", entry: "2026-09-10", exit: "2026-09-20" }]); // fully closed before EPOCH_START
    const live = extractLiveDecisions(db, "meanrev_stocks", EPOCH_START, WINDOW_END);
    expect(live.entries).toEqual([]);
    expect(live.exits).toEqual([]);
    expect(live.endHoldings).toEqual([]);
  });

  test("an exit AFTER the window end keeps the symbol as a holding", () => {
    const db = makeTradingDb([{ symbol: "PG", entry: "2026-09-28", exit: "2026-10-06", status: "closed" }]);
    const live = extractLiveDecisions(db, "meanrev_stocks", EPOCH_START, WINDOW_END);
    expect(live.exits).toEqual([]);
    expect(live.endHoldings).toEqual(["PG"]);
  });

  test("other accounts' rows are invisible", () => {
    const db = makeTradingDb([{ symbol: "KO", entry: "2026-09-25", account: "momentum_stocks" }]);
    const live = extractLiveDecisions(db, "meanrev_stocks", EPOCH_START, WINDOW_END);
    expect(live.entries).toEqual([]);
  });

  test("a carried-in row closed by MODEL_CUTOVER is fully invisible; its FRESH in-window reopen is a normal entry (2026-10-05 live incident: AAPL/META)", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE trades (
      id TEXT PRIMARY KEY, account_id TEXT, symbol TEXT, side TEXT,
      entry_time INTEGER, exit_time INTEGER, status TEXT, close_reason TEXT, strategy TEXT
    )`);
    const ins = db.prepare(
      "INSERT INTO trades (id, account_id, symbol, side, entry_time, exit_time, status, close_reason) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run("old", "momentum_stocks", "META", "buy", at("2026-09-04"), at("2026-09-28") + 1000, "closed", "MODEL_CUTOVER");
    ins.run("new", "momentum_stocks", "META", "buy", at("2026-09-28") + 2000, null, "open", null);
    const live = extractLiveDecisions(db, "momentum_stocks", EPOCH_START, WINDOW_END);
    expect(live.entries).toEqual([{ symbol: "META", date: "2026-09-28" }]); // only the fresh reopen
    expect(live.exits).toEqual([]); // the cutover close is NOT a comparable decision
    expect(live.endHoldings).toEqual(["META"]); // from the fresh row only
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OPEN.md P2 — "el libro del sim arranca vacío en el epoch": the seed for
// the replay's book (extractSeedPositions), and its USDC symbol mapping.
// ═══════════════════════════════════════════════════════════════════════
describe("extractSeedPositions", () => {
  test("a position open AT the epoch (pre-epoch entry, still open or exited at/after it) is seeded; a fully pre-epoch round trip is not", () => {
    const db = makeTradingDb([
      { symbol: "KO", entry: "2026-09-20", entryPrice: 61.5, quantity: 40, stopLoss: 58.2 },           // still open at the epoch
      { symbol: "XLF", entry: "2026-09-22", exit: "2026-09-29" },                                       // exited exactly at the epoch — still relevant
      { symbol: "OLD", entry: "2026-09-10", exit: "2026-09-18" },                                       // fully closed before the epoch — irrelevant
      { symbol: "FRESH", entry: "2026-09-25" },                                                         // entered AT/after the epoch — not a seed, a normal in-window decision
    ]);
    const seeds = extractSeedPositions(db, "meanrev_stocks", EPOCH_START);
    expect(seeds.map(s => s.symbol).sort()).toEqual(["KO", "XLF"]);
    const ko = seeds.find(s => s.symbol === "KO")!;
    expect(ko).toEqual({ symbol: "KO", side: "buy", qty: 40, entryPrice: 61.5, entryAt: at("2026-09-20"), stopPrice: 58.2 });
  });

  test("other accounts' rows are invisible", () => {
    const db = makeTradingDb([{ symbol: "KO", entry: "2026-09-20", account: "momentum_stocks" }]);
    expect(extractSeedPositions(db, "meanrev_stocks", EPOCH_START)).toEqual([]);
  });

  test("a NULL stop_loss seeds stopPrice: null (SimBroker/SimMeanRevBroker fall back to the sleeve's fixed hardStopPct)", () => {
    const db = makeTradingDb([{ symbol: "KO", entry: "2026-09-20" }]); // stopLoss defaults to null
    expect(extractSeedPositions(db, "meanrev_stocks", EPOCH_START)[0].stopPrice).toBeNull();
  });

  test("side is carried through verbatim (momentum sleeves can hold shorts)", () => {
    const db = makeTradingDb([{ symbol: "BTC/USD", entry: "2026-09-25", side: "sell", account: "momentum_crypto" }]);
    const seeds = extractSeedPositions(db, "momentum_crypto", Date.parse("2026-09-26T19:00:00Z"));
    expect(seeds[0].side).toBe("sell");
  });

  test("a MODEL_CUTOVER close is excluded — it's a one-shot re-underwrite (old row closed, fresh row reopened IN-window), not a continuing position (2026-10-05: seeding it saturated momentum_stocks' gross-exposure cap and blocked every entry)", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE trades (
      id TEXT PRIMARY KEY, account_id TEXT, symbol TEXT, side TEXT,
      entry_price REAL, quantity REAL, stop_loss REAL,
      entry_time INTEGER, exit_time INTEGER, status TEXT, close_reason TEXT, strategy TEXT
    )`);
    const epoch = at("2026-09-28");
    db.prepare(
      "INSERT INTO trades (id, account_id, symbol, side, entry_price, quantity, entry_time, exit_time, status, close_reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("old", "momentum_stocks", "META", "buy", 607.5, 40, at("2026-09-04"), epoch + 1000, "closed", "MODEL_CUTOVER");
    // A genuine carried-in position (e.g. a real STOP_LOSS/TIME_STOP exit
    // within the window) is NOT excluded — only MODEL_CUTOVER is special.
    db.prepare(
      "INSERT INTO trades (id, account_id, symbol, side, entry_price, quantity, entry_time, exit_time, status, close_reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("real", "momentum_stocks", "XLE", "buy", 90, 10, at("2026-09-20"), epoch + 2000, "closed", "TRAIL_STOP");
    const seeds = extractSeedPositions(db, "momentum_stocks", epoch);
    expect(seeds.map(s => s.symbol)).toEqual(["XLE"]);
  });
});

describe("normalizeSeedPositions", () => {
  test("momentum_crypto_usdc: BASE/USDC → BASE/USD, matching normalizeLiveDecisions' mapping", () => {
    const seeds: SeedPosition[] = [{ symbol: "LINK/USDC", side: "buy", qty: 10, entryPrice: 20, entryAt: 0, stopPrice: 18 }];
    expect(normalizeSeedPositions("momentum_crypto_usdc", seeds)).toEqual([
      { symbol: "LINK/USD", side: "buy", qty: 10, entryPrice: 20, entryAt: 0, stopPrice: 18 },
    ]);
  });

  test("other sleeves keep their symbols verbatim (same identity, not just equal value)", () => {
    const seeds: SeedPosition[] = [{ symbol: "SOL/USD", side: "buy", qty: 1, entryPrice: 1, entryAt: 0 }];
    expect(normalizeSeedPositions("momentum_crypto", seeds)).toBe(seeds);
  });
});

describe("Turtle units carried across the parity epoch", () => {
  const H = 3_600_000, D = 24 * H, epoch = Date.parse("2026-11-03T03:00:00Z");

  test.each(["BREAKOUT_SHORT", "BREAKOUT_LONG"])("extracts %s role and preserves it through USDC normalization", strategy => {
    const db = makeTradingDb([{ symbol: "SOL/USDC", account: "momentum_crypto_usdc", entry: "2026-11-02", strategy }]);
    try {
      const seeds = normalizeSeedPositions("momentum_crypto_usdc", extractSeedPositions(db, "momentum_crypto_usdc", epoch));
      expect(seeds[0]).toMatchObject({ symbol: "SOL/USD", role: strategy === "BREAKOUT_SHORT" ? "breakout-short" : "breakout-long" });
    } finally { db.close(); }
  });

  test.each(["hold", "stop", "channel", "age", "long-age", "daily-age"] as const)("seeded unit: %s stays in the breakout book and its exit is still compared", async mode => {
    const dir = mkdtempSync(join(tmpdir(), "parity-breakout-")), path = join(dir, "historical.db");
    const daily = mode === "daily-age", long = mode === "long-age", barMs = daily ? D : H;
    const start = daily ? Math.floor(epoch / D) * D : epoch;
    const end = start + (daily ? 3 * D : mode === "hold" ? 53 * H : 4 * H);
    const entryAt = mode.includes("age") ? start - 119 * H : Date.parse("2026-11-02T18:00:00Z");
    const seed: SeedPosition = { symbol: "SOL/USD", side: long ? "buy" : "sell", qty: 1, entryPrice: 100, entryAt, stopPrice: long ? 60 : 140, role: long ? "breakout-long" : "breakout-short" };
    try {
      const hist = new Database(path);
      hist.exec("CREATE TABLE historical_bars(symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL)");
      const q = hist.query("INSERT INTO historical_bars VALUES ('SOL/USD', ?, 'binance_futures', ?, ?, ?, ?, ?, 1000)");
      hist.transaction(() => {
        for (let t = start - (daily ? 400 : 100) * D; t < end; t += barMs) {
          const p = t >= start && mode === "stop" ? 141 : t >= start && mode === "channel" ? 111 : long ? 111 : 89;
          q.run(daily ? "1d" : "1h", t, p, Math.max(110, p), Math.min(90, p), p);
        }
      })();
      hist.close();
      const sleeve = daily ? "momentum_crypto_usdc" : "momentum_crypto";
      const live = liveSleeveConfig(sleeve);
      const manifest: ExperimentManifest = JSON.parse(readFileSync(join(import.meta.dir, "..", live.manifestPath), "utf8"));
      manifest.data = { ...manifest.data, universe: ["SOL/USD"], refSymbol: "SOL/USD", funding: false };
      const leg = { symbols: ["SOL/USD"], entryDays: 20, exitDays: 10, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 };
      const cfg = candidateToReplayConfig(manifest, { ...live.candidate, entryPct: 100000, volTarget: undefined, exposureControl: undefined,
        breakoutShort: long ? undefined : leg, breakoutLong: long ? leg : undefined }, "base", path);
      const broker = new SimBroker(10000, new Map(), 0, 0, barMs, { leverage: 2, maintRate: 0.005 });
      broker.seedPositions([seed], cfg);
      expect(broker.positions[0]).toMatchObject({ role: seed.role, breakoutN: 20, breakoutStop: seed.stopPrice, stopFrac: null });
      expect((await broker.getOpenPositions())[0]).toMatchObject({ role: seed.role, breakoutN: 20, stopLoss: seed.stopPrice });
      const result = await runWithConfig(cfg, { label: "parity-seeded-unit", from: isoInstant(start), to: isoInstant(end) }, undefined, [seed]);
      expect(result).not.toBeNull();
      expect(result!.closedTrades).toHaveLength(1); // no spurious re-entry on a sustained breach
      const t = result!.closedTrades[0];
      expect(t.entryAt).toBe(entryAt);
      const reason = mode === "hold" ? undefined : mode === "stop" ? "BREAKOUT_SHORT_STOP" : mode === "channel" ? "BREAKOUT_SHORT_EXIT" : long ? "BREAKOUT_LONG_TIME_STOP" : "BREAKOUT_SHORT_TIME_STOP";
      if (reason) expect(t.engineCloseReason).toBe(reason);
      else expect(t.reason).toBe("fold_end");
      const sim = extractSimDecisions(result!.closedTrades, end, isoInstant, [seed]);
      expect(sim.entries).toEqual([]);
      const liveDecisions: SleeveDecisions = { entries: [], exits: reason ? [{ symbol: seed.symbol, date: isoInstant(t.exitAt + 20_000) }] : [], endHoldings: reason ? [] : [seed.symbol] };
      expect(compareDecisions(sim, liveDecisions, MATCH_TOLERANCE_HOURS_CRYPTO / 24)).toEqual([]);
      if (reason) expect(compareDecisions(sim, { entries: [], exits: [], endHoldings: [seed.symbol] }, MATCH_TOLERANCE_HOURS_CRYPTO / 24).map(d => d.type)).toContain("exit_missing_live");
      const liveDb = makeTradingDb([]), referenceDb = new Database(path, { readonly: true });
      try {
        liveDb.query("INSERT INTO trades VALUES ('seed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(sleeve, daily ? "SOL/USDC" : seed.symbol, seed.side, seed.entryPrice, seed.qty, seed.stopPrice!, entryAt,
          reason ? t.exitAt + 20_000 : null, reason ? "closed" : "open", reason ?? null, long ? "BREAKOUT_LONG" : "BREAKOUT_SHORT");
        const check = () => compareCryptoReplay(liveDb, referenceDb, sleeve, manifest.data, result!.closedTrades, [seed], start, end);
        expect(check().divergences).toEqual([]);
        expect(check().explained).toEqual([]); // seeded exits have the real row stop; no blanket waiver
        if (reason) {
          liveDb.exec("UPDATE trades SET status = 'open', exit_time = NULL, close_reason = NULL");
          expect(check().divergences.map(d => d.type)).toContain("exit_missing_live");
        }
      } finally { liveDb.close(); referenceDb.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("testnet-fill-anchored Turtle stops", () => {
  test.each(["momentum_crypto", "momentum_crypto_usdc"] as const)("%s: declared catastrophe exit explains ONLY its matched unit, including a still-open sim", sleeve => {
    const f = fixture();
    try {
      f.db.run("UPDATE trades SET close_reason = 'BREAKOUT_CATASTROPHE_STOP' WHERE id = 'btc'");
      if (sleeve === "momentum_crypto_usdc") f.db.run("UPDATE trades SET account_id = ?, symbol = REPLACE(symbol, '/USD', '/USDC')", [sleeve]);
      f.hist.run("DELETE FROM historical_bars"); // not a close-based crossing
      f.trades[1] = { ...f.trades[1], reason: "fold_end", exitAt: end, engineCloseReason: undefined };
      const r = compareCryptoReplay(f.db, f.hist, sleeve, data, f.trades, f.seeds, epoch, end);
      expect(r.explained).toMatchObject([{ symbol: "BTC/USD", liveOnly: true }]);
      expect(r.divergences).toEqual([]);
      expect(renderSummary([{ sleeve, status: "compared", staleSymbols: [], epoch: isoInstant(epoch), ...r }])).toContain("live-only Turtle catastrophe stop");
      f.trades[1].entryAt = epoch; // unrelated unit: no symbol-wide waiver
      const mismatch = compareCryptoReplay(f.db, f.hist, sleeve, data, f.trades, f.seeds, epoch, end);
      expect(mismatch.explained).toEqual([]); expect(mismatch.divergences.length).toBeGreaterThan(0);
    } finally { f.db.close(); f.hist.close(); }
  });
  const H = 3_600_000, D = 24 * H, epoch = Date.parse("2026-11-03T03:00:00Z"), end = Date.parse("2026-11-05T08:00:00Z");
  const data = { source: "binance_futures", timeframe: "1h", barMinutes: 60 };
  const btcEntry = Date.parse("2026-11-04T03:00:20Z"), liveExit = Date.parse("2026-11-04T23:00:21Z");
  function fixture() {
    const db = makeTradingDb([]), hist = new Database(":memory:");
    db.query(`INSERT INTO trades VALUES ('sol', 'momentum_crypto', 'SOL/USD', 'sell', 100, 1, 140, ?, NULL, 'open', NULL, 'BREAKOUT_SHORT')`).run(Date.parse("2026-11-02T18:00:00Z"));
    db.query(`INSERT INTO trades VALUES ('btc', 'momentum_crypto', 'BTC/USD', 'sell', 76488.2, 1, 80539.86, ?, ?, 'closed', 'BREAKOUT_SHORT_STOP', 'BREAKOUT_SHORT')`).run(btcEntry, liveExit);
    hist.exec("CREATE TABLE historical_bars(symbol TEXT, source TEXT, timeframe TEXT, timestamp INTEGER, close REAL)");
    const q = hist.query("INSERT INTO historical_bars VALUES ('BTC/USD', 'binance_futures', '1h', ?, ?)");
    q.run(btcEntry - 20_000 - H, 90000); // close BEFORE live fill: must not count
    q.run(Date.parse("2026-11-04T15:00:00Z"), 80300); // crosses SIM stop, below LIVE stop
    q.run(Date.parse("2026-11-04T22:00:00Z"), 80600); // first close above LIVE stop = 23:00
    const seeds = extractSeedPositions(db, "momentum_crypto", epoch);
    const trades: ClosedTrade[] = [
      { symbol: "SOL/USD", side: "sell", entryAt: seeds[0].entryAt, exitAt: end, reason: "fold_end", pnl: 0 },
      { symbol: "BTC/USD", side: "sell", entryAt: btcEntry - 19_999, entryPrice: 76128, exitAt: Date.parse("2026-11-04T16:00:00.001Z"), reason: "rebalance", engineCloseReason: "BREAKOUT_SHORT_STOP", pnl: 0 },
    ];
    return { db, hist, seeds, trades };
  }
  test("prod 11-05: carried SOL short + BTC 76488.2 testnet fill / 76128 reference fill → zero divergences, one explained", () => {
    const f = fixture();
    try {
      const r = compareCryptoReplay(f.db, f.hist, "momentum_crypto", data, f.trades, f.seeds, epoch, end);
      expect(r.divergences).toEqual([]);
      expect(r.explained).toHaveLength(1);
      expect(r.explained[0]).toMatchObject({ symbol: "BTC/USD", stopPrice: 80539.86, referenceDate: "2026-11-04T23:00:00.000Z", liveDate: isoInstant(liveExit), simDate: "2026-11-04T16:00:00.001Z" });
      expect(r.sim.exits[0].date).toBe("2026-11-04T16:00:00.001Z"); // output stays honest
      const text = renderSummary([{ sleeve: "momentum_crypto", status: "compared", epoch: isoInstant(epoch), staleSymbols: [], ...r }]);
      expect(text).toContain("explained (stop anchored to the testnet fill)");
      expect(text).toContain("✅ PARITY — no divergences");
    } finally { f.db.close(); f.hist.close(); }
  });
  test.each(["wrong-exit", "earlier-crossing", "no-crossing", "wrong-reason", "other-unit", "other-role"] as const)("%s remains a divergence", mode => {
    const f = fixture();
    try {
      if (mode === "wrong-exit") f.db.query("UPDATE trades SET exit_time = ? WHERE id = 'btc'").run(liveExit - 4 * H);
      if (mode === "earlier-crossing") f.hist.query("UPDATE historical_bars SET close = 80600 WHERE close = 80300").run();
      if (mode === "no-crossing") f.hist.query("UPDATE historical_bars SET close = 80000").run();
      if (mode === "wrong-reason") f.db.query("UPDATE trades SET close_reason = 'BREAKOUT_SHORT_EXIT' WHERE id = 'btc'").run();
      if (mode === "other-unit") f.trades[1].entryAt! -= 5 * H;
      if (mode === "other-role") f.trades[1].engineCloseReason = "TIME_STOP";
      const r = compareCryptoReplay(f.db, f.hist, "momentum_crypto", data, f.trades, f.seeds, epoch, end);
      expect(r.explained).toEqual([]);
      expect(r.divergences.map(d => d.type)).toContain("exit_missing_live");
      expect(r.divergences.map(d => d.type)).toContain("exit_extra_live");
    } finally { f.db.close(); f.hist.close(); }
  });
  test("explaining one unit never suppresses another exit of the same symbol", () => {
    const f = fixture();
    try {
      f.trades.push({ ...f.trades[1], entryAt: liveExit + H, exitAt: liveExit + 2 * H });
      const r = compareCryptoReplay(f.db, f.hist, "momentum_crypto", data, f.trades, f.seeds, epoch, end);
      expect(r.explained).toHaveLength(1);
      expect(r.divergences).toContainEqual({ type: "exit_missing_live", symbol: "BTC/USD", simDate: isoInstant(liveExit + 2 * H) });
    } finally { f.db.close(); f.hist.close(); }
  });
  test("hourly stop evidence uses ±2 decision bars, not a same-day waiver", () => {
    const f = fixture();
    try {
      f.db.query("UPDATE trades SET exit_time = ? WHERE id = 'btc'").run(liveExit - 2 * H);
      expect(compareCryptoReplay(f.db, f.hist, "momentum_crypto", data, f.trades, f.seeds, epoch, end).explained).toHaveLength(1);
      f.db.query("UPDATE trades SET exit_time = ? WHERE id = 'btc'").run(liveExit - 3 * H);
      expect(compareCryptoReplay(f.db, f.hist, "momentum_crypto", data, f.trades, f.seeds, epoch, end).explained).toEqual([]);
    } finally { f.db.close(); f.hist.close(); }
  });
  test.each(["BREAKOUT_SHORT", "BREAKOUT_LONG"])("daily USDC %s requires the same UTC decision day (not daily ±3-day slack)", strategy => {
    const f = fixture(), long = strategy === "BREAKOUT_LONG", entry = Math.floor(epoch / D) * D + 20_000;
    const stopDay = Date.parse("2026-11-04T00:00:00Z"), exit = stopDay + 3 * H;
    try {
      f.db.exec("DELETE FROM trades");
      f.db.query("INSERT INTO trades VALUES ('daily', 'momentum_crypto_usdc', 'BTC/USDC', ?, 100, 1, ?, ?, ?, 'closed', ?, ?)").run(long ? "buy" : "sell", long ? 60 : 140, entry, exit, `${strategy}_STOP`, strategy);
      f.hist.exec("DELETE FROM historical_bars");
      f.hist.query("INSERT INTO historical_bars VALUES ('BTC/USD', 'binance_futures', '1d', ?, ?)").run(stopDay - D, long ? 59 : 141);
      const trades: ClosedTrade[] = [{ symbol: "BTC/USD", side: long ? "buy" : "sell", entryAt: entry - 19_999, exitAt: stopDay - D + 1, reason: "rebalance", engineCloseReason: `${strategy}_STOP`, pnl: 0 }];
      const check = () => compareCryptoReplay(f.db, f.hist, "momentum_crypto_usdc", { ...data, timeframe: "1d", barMinutes: 1440 }, trades, [], entry - 20_000, end);
      expect(check().explained).toHaveLength(1);
      expect(check().divergences).toEqual([]);
      trades[0].exitAt = stopDay + 1; // also explain >2h within one daily decision day
      expect(check().explained).toHaveLength(1);
      expect(check().divergences).toEqual([]);
      f.db.query("UPDATE trades SET exit_time = ?").run(stopDay + D + 20_000);
      expect(check().explained).toEqual([]);
      expect(check().divergences.map(d => d.type)).toContain("exit_extra_live");
    } finally { f.db.close(); f.hist.close(); }
  });
});

describe("extractSimDecisions", () => {
  test("fold_end closes are holdings, not exits; others are exits", () => {
    const sim = extractSimDecisions([
      simTrade("KO", "2026-09-25", "2026-10-02", "fold_end"),
      simTrade("MRK", "2026-09-25", "2026-09-30", "SMA_EXIT"),
    ], WINDOW_END);
    expect(sim.entries.map(e => e.symbol).sort()).toEqual(["KO", "MRK"]);
    expect(sim.exits).toEqual([{ symbol: "MRK", date: "2026-09-30" }]);
    expect(sim.endHoldings).toEqual(["KO"]);
  });

  test("fails closed on a trade without entryAt (pre-2026-09-25 replay shape)", () => {
    expect(() => extractSimDecisions(
      [{ symbol: "KO", side: "buy", pnl: 0, exitAt: at("2026-09-30"), reason: "SMA_EXIT" }],
      WINDOW_END,
    )).toThrow(/entryAt/);
  });

  // ── OPEN.md P2: a seeded (inherited) position's entry is suppressed ────
  test("a closedTrade matching a seed's (symbol, side, entryAt) exactly contributes NO entry event — it was inherited, not decided this window", () => {
    const seeds: SeedPosition[] = [{ symbol: "KO", side: "buy", qty: 40, entryPrice: 61.5, entryAt: at("2026-09-20") }];
    const sim = extractSimDecisions([
      { symbol: "KO", side: "buy", pnl: 10, exitAt: at("2026-09-30"), reason: "fold_end", entryAt: at("2026-09-20") }, // seed → no entry
      simTrade("MRK", "2026-09-25", "2026-09-28", "SMA_EXIT"), // genuine in-window entry → counts normally
    ], WINDOW_END, undefined, seeds);
    expect(sim.entries).toEqual([{ symbol: "MRK", date: "2026-09-25" }]); // KO's inherited entry is absent
    expect(sim.endHoldings).toEqual(["KO"]); // but its holding (fold_end) is still tracked
  });

  test("exact-identity matching: a DIFFERENT entryAt for the same symbol+side is NOT suppressed (e.g. a re-entry after the seed exited)", () => {
    const seeds: SeedPosition[] = [{ symbol: "KO", side: "buy", qty: 40, entryPrice: 61.5, entryAt: at("2026-09-20") }];
    const sim = extractSimDecisions([
      simTrade("KO", "2026-09-26", "2026-09-30", "SMA_EXIT"), // a fresh re-entry, different entryAt — a real decision
    ], WINDOW_END, undefined, seeds);
    expect(sim.entries).toEqual([{ symbol: "KO", date: "2026-09-26" }]);
  });
});

// ── the three canonical scenarios ─────────────────────────────────────────
describe("compareDecisions", () => {
  const simPerfect: SleeveDecisions = {
    entries: [{ symbol: "KO", date: "2026-09-25" }, { symbol: "MRK", date: "2026-09-28" }],
    exits: [{ symbol: "MRK", date: "2026-09-30" }],
    endHoldings: ["KO"],
  };

  test("perfect parity → no divergences (±1 session fill-date skew tolerated)", () => {
    const live: SleeveDecisions = {
      entries: [{ symbol: "KO", date: "2026-09-25" }, { symbol: "MRK", date: "2026-09-29" }], // 1d skew
      exits: [{ symbol: "MRK", date: "2026-09-30" }],
      endHoldings: ["KO"],
    };
    expect(compareDecisions(simPerfect, live)).toEqual([]);
  });

  test("entry the live book is missing → entry_missing_live + holdings_missing_live", () => {
    const live: SleeveDecisions = {
      entries: [{ symbol: "MRK", date: "2026-09-28" }],
      exits: [{ symbol: "MRK", date: "2026-09-30" }],
      endHoldings: [],
    };
    const d = compareDecisions(simPerfect, live);
    expect(d).toContainEqual({ type: "entry_missing_live", symbol: "KO", simDate: "2026-09-25" });
    expect(d).toContainEqual({ type: "holdings_missing_live", symbol: "KO" });
    expect(d.length).toBe(2);
  });

  test("extra live exit (sim still holds) → exit_extra_live + holdings mismatch", () => {
    const live: SleeveDecisions = {
      entries: [{ symbol: "KO", date: "2026-09-25" }, { symbol: "MRK", date: "2026-09-28" }],
      exits: [{ symbol: "MRK", date: "2026-09-30" }, { symbol: "KO", date: "2026-10-01" }],
      endHoldings: [],
    };
    const d = compareDecisions(simPerfect, live);
    expect(d).toContainEqual({ type: "exit_extra_live", symbol: "KO", liveDate: "2026-10-01" });
    expect(d).toContainEqual({ type: "holdings_missing_live", symbol: "KO" });
    expect(d.length).toBe(2);
  });

  test("date skew beyond the tolerance is a divergence, not a match", () => {
    const live: SleeveDecisions = {
      entries: [{ symbol: "KO", date: "2026-09-25" }, { symbol: "MRK", date: "2026-10-05" }], // 7d off
      exits: [{ symbol: "MRK", date: "2026-09-30" }],
      endHoldings: ["KO"],
    };
    const d = compareDecisions(simPerfect, live, MATCH_TOLERANCE_DAYS);
    expect(d).toContainEqual({ type: "entry_missing_live", symbol: "MRK", simDate: "2026-09-28" });
    expect(d).toContainEqual({ type: "entry_extra_live", symbol: "MRK", liveDate: "2026-10-05" });
  });

  test("same symbol re-entered twice matches pairwise, nearest date first", () => {
    const sim: SleeveDecisions = {
      entries: [{ symbol: "KO", date: "2026-09-25" }, { symbol: "KO", date: "2026-10-01" }],
      exits: [], endHoldings: [],
    };
    const live: SleeveDecisions = {
      entries: [{ symbol: "KO", date: "2026-09-25" }, { symbol: "KO", date: "2026-10-01" }],
      exits: [], endHoldings: [],
    };
    expect(compareDecisions(sim, live)).toEqual([]);
  });
});

// ── end-to-end over a fixture DB (no replay) ──────────────────────────────
describe("fixture pipeline: extract → compare", () => {
  test("live mirror of the sim book is parity-clean end to end", () => {
    const db = makeTradingDb([
      { symbol: "KO", entry: "2026-09-25" },
      { symbol: "MRK", entry: "2026-09-25", exit: "2026-09-30" },
    ]);
    const live = extractLiveDecisions(db, "meanrev_stocks", EPOCH_START, WINDOW_END);
    const sim = extractSimDecisions([
      simTrade("KO", "2026-09-25", "2026-10-02", "fold_end"),
      simTrade("MRK", "2026-09-25", "2026-09-30", "TIME_STOP"),
    ], WINDOW_END);
    expect(compareDecisions(sim, live)).toEqual([]);
  });

  test("renderSummary marks divergence with ❌ and parity with ✅", () => {
    const sim = extractSimDecisions([simTrade("KO", "2026-09-25", "2026-10-02", "fold_end")], WINDOW_END);
    const cleanDb = makeTradingDb([{ symbol: "KO", entry: "2026-09-25" }]);
    const clean = extractLiveDecisions(cleanDb, "meanrev_stocks", EPOCH_START, WINDOW_END);
    const dirtyDb = makeTradingDb([]);
    const dirty = extractLiveDecisions(dirtyDb, "meanrev_stocks", EPOCH_START, WINDOW_END);
    const results = [
      { sleeve: "meanrev_stocks" as const, status: "compared" as const, epoch: "2026-09-25", lastSession: "2026-10-02", staleSymbols: [], sim, live: clean, divergences: compareDecisions(sim, clean) },
      { sleeve: "momentum_stocks" as const, status: "compared" as const, epoch: "2026-09-28", lastSession: "2026-10-02", staleSymbols: [{ symbol: "HON", lastBar: "2026-08-06" }], sim, live: dirty, divergences: compareDecisions(sim, dirty) },
    ];
    const text = renderSummary(results as any);
    expect(text).toContain("✅ PARITY");
    expect(text).toContain("❌ 2 divergence(s)");
    expect(text).toContain("entry_missing_live KO");
    expect(text).toContain("STALE universe symbols");
    expect(text).toContain("HON@2026-08-06");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// momentum_crypto — hourly, 24/7, ±2h tolerance (added 2026-09-26 after the
// sleeve ran ~2 weeks on a different model than the validated replay with
// nobody noticing — the daily-only monitor above never covered it).
// ═══════════════════════════════════════════════════════════════════════
const CRYPTO_EPOCH = Date.parse("2026-09-26T19:00:00Z");
const CRYPTO_TOL = MATCH_TOLERANCE_HOURS_CRYPTO / 24;

function makeCryptoTradingDb(rows: Array<{
  symbol: string; entry: string; exit?: string; status?: string; closeReason?: string;
}>): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE trades (
    id TEXT PRIMARY KEY, account_id TEXT, symbol TEXT, side TEXT,
    entry_time INTEGER, exit_time INTEGER, status TEXT, close_reason TEXT
  )`);
  const ins = db.prepare("INSERT INTO trades (id, account_id, symbol, side, entry_time, exit_time, status, close_reason) VALUES (?,?,?,?,?,?,?,?)");
  rows.forEach((r, i) => ins.run(
    `t${i}`, "momentum_crypto", r.symbol, "buy",
    Date.parse(r.entry), r.exit ? Date.parse(r.exit) : null,
    r.status ?? (r.exit ? "closed" : "open"), r.closeReason ?? null,
  ));
  return db;
}

function cryptoSimTrade(symbol: string, entry: string, exit: string, reason: string): ClosedTrade {
  return { symbol, side: "buy", pnl: 0, exitAt: Date.parse(exit), reason, entryAt: Date.parse(entry) };
}

describe("momentum_crypto (hourly, ±2h tolerance)", () => {
  test("perfect parity: bar-close-exact sim vs phase-shifted live tick → no divergences", () => {
    const sim = extractSimDecisions([
      cryptoSimTrade("AVAX/USD", "2026-09-26T20:00:00Z", "2026-09-27T04:00:00Z", "SIGNAL_EXIT"),
    ], Date.parse("2026-09-28T00:00:00Z"), isoInstant);
    // Live decides at bar-close + 15s, and its FIRST tick after the 2026-09-26
    // re-anchor is out of phase with the hour boundary — up to ~90min skew,
    // well inside the 2h tolerance.
    const liveDb = makeCryptoTradingDb([
      { symbol: "AVAX/USD", entry: "2026-09-26T21:12:00Z", exit: "2026-09-27T05:03:00Z" },
    ]);
    const live = extractLiveDecisions(liveDb, "momentum_crypto", CRYPTO_EPOCH, Date.parse("2026-09-28T00:00:00Z"), isoInstant);
    expect(compareDecisions(sim, live, CRYPTO_TOL)).toEqual([]);
  });

  test("entry missing on the live side (the 2-week lockout class) → entry_missing_live", () => {
    const sim = extractSimDecisions([
      cryptoSimTrade("SOL/USD", "2026-09-26T20:00:00Z", "2026-09-27T02:00:00Z", "SIGNAL_EXIT"),
      cryptoSimTrade("LINK/USD", "2026-09-26T21:00:00Z", "2026-09-27T03:00:00Z", "SIGNAL_EXIT"),
    ], Date.parse("2026-09-28T00:00:00Z"), isoInstant);
    const liveDb = makeCryptoTradingDb([
      { symbol: "LINK/USD", entry: "2026-09-26T21:05:00Z", exit: "2026-09-27T03:04:00Z" },
    ]);
    const live = extractLiveDecisions(liveDb, "momentum_crypto", CRYPTO_EPOCH, Date.parse("2026-09-28T00:00:00Z"), isoInstant);
    const d = compareDecisions(sim, live, CRYPTO_TOL);
    expect(d).toContainEqual({ type: "entry_missing_live", symbol: "SOL/USD", simDate: "2026-09-26T20:00:00.000Z" });
  });

  test("extra live exit the sim never made (sim still holds) → exit_extra_live", () => {
    const sim = extractSimDecisions([
      cryptoSimTrade("ADA/USD", "2026-09-26T20:00:00Z", "2026-09-30T00:00:00Z", "fold_end"),
    ], Date.parse("2026-09-30T00:00:00Z"), isoInstant);
    const liveDb = makeCryptoTradingDb([
      { symbol: "ADA/USD", entry: "2026-09-26T20:05:00Z", exit: "2026-09-27T09:00:00Z" },
    ]);
    const live = extractLiveDecisions(liveDb, "momentum_crypto", CRYPTO_EPOCH, Date.parse("2026-09-30T00:00:00Z"), isoInstant);
    const d = compareDecisions(sim, live, CRYPTO_TOL);
    expect(d).toContainEqual(expect.objectContaining({ type: "exit_extra_live", symbol: "ADA/USD" }));
  });

  test("native BROKER_STOP_LOSS within ±2h of the sim's H/L stop matches by symbol, never price/reason", () => {
    const sim = extractSimDecisions([
      cryptoSimTrade("AVAX/USD", "2026-09-26T20:00:00Z", "2026-09-27T01:00:00Z", "stop_loss"),
    ], Date.parse("2026-09-28T00:00:00Z"), isoInstant);
    const liveDb = makeCryptoTradingDb([
      // 15s stop-loss loop fires ~40min after the sim's bar-close H/L stop —
      // different instant, same bar, different trigger price; must still match.
      { symbol: "AVAX/USD", entry: "2026-09-26T20:05:00Z", exit: "2026-09-27T01:41:00Z", closeReason: "BROKER_STOP_LOSS" },
    ]);
    const live = extractLiveDecisions(liveDb, "momentum_crypto", CRYPTO_EPOCH, Date.parse("2026-09-28T00:00:00Z"), isoInstant);
    expect(compareDecisions(sim, live, CRYPTO_TOL)).toEqual([]);
  });

  test("a stop outside ±2h is a real divergence, not tolerated noise", () => {
    const sim = extractSimDecisions([
      cryptoSimTrade("AVAX/USD", "2026-09-26T20:00:00Z", "2026-09-27T01:00:00Z", "stop_loss"),
    ], Date.parse("2026-09-28T00:00:00Z"), isoInstant);
    const liveDb = makeCryptoTradingDb([
      { symbol: "AVAX/USD", entry: "2026-09-26T20:05:00Z", exit: "2026-09-27T04:00:00Z", closeReason: "BROKER_STOP_LOSS" }, // 3h off
    ]);
    const live = extractLiveDecisions(liveDb, "momentum_crypto", CRYPTO_EPOCH, Date.parse("2026-09-28T00:00:00Z"), isoInstant);
    const d = compareDecisions(sim, live, CRYPTO_TOL);
    expect(d.length).toBeGreaterThan(0);
  });
});

describe("utcDayCloses / heldSymbolsAt / compareDailyHoldings (momentum_crypto's 24/7 EOD portfolio check)", () => {
  test("utcDayCloses returns every UTC midnight strictly inside the window", () => {
    const from = Date.parse("2026-09-26T19:00:00Z");
    const to = Date.parse("2026-09-29T02:00:00Z");
    expect(utcDayCloses(from, to)).toEqual([
      Date.parse("2026-09-27T00:00:00Z"),
      Date.parse("2026-09-28T00:00:00Z"),
      Date.parse("2026-09-29T00:00:00Z"),
    ]);
  });

  test("heldSymbolsAt nets entries minus exits up to the given instant", () => {
    const entries = [{ symbol: "SOL/USD", date: "2026-09-26T20:00:00.000Z" }];
    const exits = [{ symbol: "SOL/USD", date: "2026-09-27T05:00:00.000Z" }];
    expect(heldSymbolsAt(entries, exits, Date.parse("2026-09-27T00:00:00Z"))).toEqual(new Set(["SOL/USD"]));
    expect(heldSymbolsAt(entries, exits, Date.parse("2026-09-28T00:00:00Z"))).toEqual(new Set());
  });

  test("live holding a symbol the sim never opened, at a UTC day close → eod_holdings_extra_live", () => {
    const sim: SleeveDecisions = { entries: [], exits: [], endHoldings: [] };
    const live: SleeveDecisions = {
      entries: [{ symbol: "DOGE/USD", date: "2026-09-26T20:00:00.000Z" }],
      exits: [],
      endHoldings: ["DOGE/USD"],
    };
    const d = compareDailyHoldings(sim, live, Date.parse("2026-09-26T19:00:00Z"), Date.parse("2026-09-27T06:00:00Z"));
    expect(d).toContainEqual({ type: "eod_holdings_extra_live", symbol: "DOGE/USD", liveDate: "2026-09-27" });
  });

  test("a midnight decision filled seconds after the boundary is not a divergence (NEAR 2026-10-29, USDC daily pass)", () => {
    const sim: SleeveDecisions = { entries: [{ symbol: "NEAR/USD", date: "2026-10-29T00:00:00.000Z" }], exits: [], endHoldings: ["NEAR/USD"] };
    const live: SleeveDecisions = { entries: [{ symbol: "NEAR/USD", date: "2026-10-29T00:00:20.508Z" }], exits: [], endHoldings: ["NEAR/USD"] };
    const from = Date.parse("2026-10-28T13:00:00Z");
    const to = Date.parse("2026-10-31T00:00:00Z");
    expect(compareDailyHoldings(sim, live, from, to)).toEqual([]);
    expect(compareDailyHoldings(sim, live, from, to, 0)).toContainEqual({ type: "eod_holdings_missing_live", symbol: "NEAR/USD", simDate: "2026-10-29" });
  });

  test("the replay's boundary + 1ms exit and the live fill use the same EOD snapshot slack", () => {
    const entry = { symbol: "SOL/USD", date: "2026-11-02T18:00:00.000Z" };
    const sim = { entries: [entry], exits: [{ symbol: "SOL/USD", date: "2026-11-04T00:00:00.001Z" }], endHoldings: [] };
    const live = { entries: [entry], exits: [{ symbol: "SOL/USD", date: "2026-11-04T00:00:20.000Z" }], endHoldings: [] };
    expect(compareDailyHoldings(sim, live, Date.parse("2026-11-03T03:00:00Z"), Date.parse("2026-11-05T00:00:00Z"))).toEqual([]);
  });

  test("the slack does not hide a live book that never followed the sim", () => {
    const sim: SleeveDecisions = { entries: [{ symbol: "NEAR/USD", date: "2026-10-29T00:00:00.000Z" }], exits: [], endHoldings: ["NEAR/USD"] };
    const live: SleeveDecisions = { entries: [{ symbol: "NEAR/USD", date: "2026-10-29T01:00:20.000Z" }], exits: [], endHoldings: ["NEAR/USD"] };
    const d = compareDailyHoldings(sim, live, Date.parse("2026-10-28T13:00:00Z"), Date.parse("2026-10-31T00:00:00Z"));
    expect(d).toContainEqual({ type: "eod_holdings_missing_live", symbol: "NEAR/USD", simDate: "2026-10-29" });
  });
});

describe("momentum_crypto parity epoch — RW10 System 1 shorts (2026-11-03)", () => {
  test("the epoch is an exact instant not before the current version's `since`: never replay the new entry policy over an old pass", () => {
    const v = currentModelVersion("momentum_crypto")!;
    expect(v.id).toBe("momentum_crypto@vt35-corroff-mh120-nobrakes-bo8s1");
    expect(PARITY_EPOCHS.momentum_crypto).toBe("2026-11-03T03:00:00Z");
    expect(Number.isNaN(Date.parse(PARITY_EPOCHS.momentum_crypto!))).toBe(false);
    expect(Date.parse(PARITY_EPOCHS.momentum_crypto!)).toBeGreaterThanOrEqual(Date.parse(v.since));
  });
  test("the replay the monitor runs for momentum_crypto carries the brake-off regime (live = validated)", () => {
    const cand = liveSleeveConfig("momentum_crypto").candidate;
    expect(cand.regime).toBe("off");
    expect(cand.risk?.mode).toBe("sizeOnly");
    expect(cand.sharpeGate).toBeUndefined();
    expect(cand.allowSameTickReentry).toBe(true);
    expect(cand.timeStop).toEqual({ maxHoldHours: 120 });
    expect(cand.breakoutShort).toMatchObject({ symbols: liveSleeveConfig("momentum_crypto").universe, entryDays: 20, exitDays: 10, maxHoldHours: 120 });
  });
});

describe("momentum_crypto_usdc parity — live BASE/USDC vs the replay's BASE/USD proxies", () => {
  test("bo13: the parity boundary is the approved deploy instant; the first DAILY tick is afterwards, not a pre-Turtle pass", () => {
    const v = currentModelVersion("momentum_crypto_usdc")!;
    expect(v.id).toBe("momentum_crypto_usdc@daily-d13s5-xc-dd-mh120-sizeonly-bo13");
    expect(PARITY_EPOCHS.momentum_crypto_usdc).toBe("2026-11-05T12:00:00Z");
    expect(PARITY_EPOCHS.momentum_crypto_usdc).toBe(v.since);
    expect(Date.parse(PARITY_EPOCHS.momentum_crypto_usdc!)).toBeLessThan(Date.parse("2026-11-06T00:00:15Z"));
    // (Before: 2026-10-08T00:00:00Z — the owner's UNI realign; AUDITS 2026-10-06.)
  });

  test("the replay the monitor runs for momentum_crypto_usdc carries the drawdown exposure control (live = validated)", () => {
    const cand = liveSleeveConfig("momentum_crypto_usdc").candidate;
    expect(cand.exposureControl).toEqual({ drawdown: { startPct: 0.1, endPct: 0.4 }, minScale: 0.25, band: 0.1, minOrderUsd: 100 });
    expect(cand.breakoutShort).toMatchObject({ symbols: liveSleeveConfig("momentum_crypto_usdc").universe, entryDays: 55, exitDays: 20, maxHoldHours: 120 });
    expect(cand.risk?.mode).toBe("sizeOnly");
    expect(cand.timeStop).toEqual({ maxHoldHours: 120 });
  });

  test("live USDC symbols are normalized to the proxy universe, so identical decisions match", () => {
    const live: SleeveDecisions = {
      entries: [{ symbol: "UNI/USDC", date: "2026-09-27T00:00:20.000Z" }, { symbol: "LINK/USDC", date: "2026-09-27T00:00:25.000Z" }],
      exits: [{ symbol: "LINK/USDC", date: "2026-10-02T00:00:20.000Z" }],
      endHoldings: ["UNI/USDC"],
    };
    const sim: SleeveDecisions = {
      entries: [{ symbol: "UNI/USD", date: "2026-09-27T00:00:00.000Z" }, { symbol: "LINK/USD", date: "2026-09-27T00:00:00.000Z" }],
      exits: [{ symbol: "LINK/USD", date: "2026-10-02T00:00:00.000Z" }],
      endHoldings: ["UNI/USD"],
    };
    const n = normalizeLiveDecisions("momentum_crypto_usdc", live);
    expect(n.endHoldings).toEqual(["UNI/USD"]);
    expect(compareDecisions(sim, n, MATCH_TOLERANCE_HOURS_CRYPTO / 24)).toEqual([]);
  });

  test("other sleeves keep their symbols verbatim", () => {
    const d: SleeveDecisions = { entries: [{ symbol: "SOL/USD", date: "x" }], exits: [], endHoldings: ["SOL/USD"] };
    expect(normalizeLiveDecisions("momentum_crypto", d)).toBe(d);
  });
});

describe("funding tail + per-sleeve isolation (2026-09-29: the 09:45 UTC run aborted on momentum_crypto)", () => {
  const H = 3_600_000;
  const t0 = Date.UTC(2026, 8, 29, 0, 0, 0);
  test("hourly window ending 09:00 with funding settled to 08:00 → compared up to 08:00", () => {
    expect(clampToFundingTail(t0 + 9 * H, t0 + 8 * H, H)).toBe(t0 + 8 * H);
  });
  test("daily window (USDC) ending 00:00 with funding at 08:00 → untouched; a lagging tail floors to its day", () => {
    const D = 24 * H;
    expect(clampToFundingTail(t0, t0 + 8 * H, D)).toBe(t0);
    expect(clampToFundingTail(t0, t0 - 8 * H, D)).toBe(t0 - D);
  });
  test("fundingTailMs = newest settlement common to the universe (min of per-perp max); 0 when a perp has none", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL)");
    const ins = db.prepare("INSERT INTO funding_rates VALUES (?, ?, 0.0001)");
    ins.run("BTCUSDT", t0 + 8 * H); ins.run("BTCUSDT", t0); ins.run("ETHUSDT", t0);
    expect(fundingTailMs(db, ["BTC/USD", "ETH/USD"])).toBe(t0);
    expect(fundingTailMs(db, ["BTC/USD", "SOL/USD"])).toBe(0);
  });
  test("an errored sleeve renders its failure and the others still render", () => {
    const text = renderSummary([
      { sleeve: "momentum_crypto", status: "error", epoch: "2026-09-26T19:00:00Z", error: "funding coverage gap: BTCUSDT", staleSymbols: [], divergences: [] },
      { sleeve: "meanrev_stocks", status: "nothing_yet", epoch: "2026-09-28", lastSession: "2026-09-25", staleSymbols: [], divergences: [] },
    ] as any);
    expect(text).toContain("check FAILED (other sleeves unaffected): funding coverage gap: BTCUSDT");
    expect(text).toContain("── meanrev_stocks");
  });
});

describe("acknowledged divergences (explained once, never re-paged)", () => {
  test("the AVAX 09-28 stop-series pair is acknowledged; any other AVAX event is still fresh", () => {
    const { fresh, acknowledged } = splitAcknowledged("momentum_crypto", [
      { type: "exit_missing_live", symbol: "AVAX/USD", simDate: "2026-09-28T08:00:00.000Z" },
      { type: "exit_extra_live", symbol: "AVAX/USD", liveDate: "2026-09-28T14:29:11.074Z" },
      { type: "exit_missing_live", symbol: "AVAX/USD", simDate: "2026-10-02T08:00:00.000Z" },
    ]);
    expect(acknowledged).toHaveLength(2);
    expect(fresh).toEqual([{ type: "exit_missing_live", symbol: "AVAX/USD", simDate: "2026-10-02T08:00:00.000Z" }]);
  });
  test("an ack is sleeve-scoped", () => {
    const { fresh } = splitAcknowledged("momentum_crypto_usdc", [{ type: "exit_missing_live", symbol: "AVAX/USD", simDate: "2026-09-28T08:00:00.000Z" }]);
    expect(fresh).toHaveLength(1);
  });
  test("acknowledged events render, and a sleeve with only acks reads as parity", () => {
    const text = renderSummary([{ sleeve: "momentum_crypto", status: "compared", epoch: "2026-09-26T19:00:00Z", lastSession: "2026-09-29T08:00:00.000Z", staleSymbols: [],
      sim: { entries: [], exits: [], endHoldings: [] }, live: { entries: [], exits: [], endHoldings: [] }, divergences: [],
      acknowledged: [{ type: "exit_missing_live", symbol: "AVAX/USD", simDate: "2026-09-28T08:00:00.000Z" }] }] as any);
    expect(text).toContain("acknowledged (explained, not paged): exit_missing_live AVAX/USD");
    expect(text).toContain("✅ PARITY — no divergences");
  });
});

describe("stock sleeves always dispatch to the portfolio-engine replay (the incumbent replay path was deleted 2026-11-07)", () => {
  test("the monitor has no incumbent daily replay for the stock sleeves and reads no registry to decide the dispatch", () => {
    const src = readFileSync(join(import.meta.dir, "parity-check.ts"), "utf8");
    expect(src).not.toContain("runMeanRevReplay");
    expect(src).not.toContain("export async function checkSleeve(");
    expect(src).not.toContain("portfolioEngineLiveSleeves");
    expect(src).toContain('isStock(sleeve)\n          ? checkPortfolioSleeve(sleeve, tradingDbPath, histPath, rootDir, since ?? epochOverride)');
    // liveSleeveConfigs has nothing to say about the stock sleeves any more
    for (const sleeve of ["momentum_stocks", "meanrev_stocks"] as const) {
      expect(() => liveSleeveConfig(sleeve)).toThrow(/no incumbent derivation since 2026-11-07/);
    }
  });
  test("renderSummary prints portfolio decisions and still renders crypto unchanged", () => {
    const text = renderSummary([
      { sleeve: "momentum_stocks", status: "compared", epoch: "2026-10-29", portfolio: [], staleSymbols: [], divergences: [] },
      { sleeve: "momentum_crypto", status: "compared", epoch: "2026-09-26T19:00:00Z", lastSession: "x", staleSymbols: [],
        sim: { entries: [], exits: [], endHoldings: [] }, live: { entries: [], exits: [], endHoldings: [] }, divergences: [] },
    ] as any);
    expect(text).toContain("── momentum_stocks");
    expect(text).toContain("exact decision replay");
    expect(text).not.toContain("SKIPPED");
    expect(text).not.toMatch(/momentum_stocks[^]*❌/);
    expect(text).toContain("── momentum_crypto");
    expect(text).toContain("✅ PARITY — no divergences");
  });
});

describe("portfolio-engine exact decision replay", () => {
  const sleeve = "momentum_stocks", version = currentModelVersion(sleeve)!;
  // Pinned to the CURRENT version's epoch (RW11: since 2026-11-09T14:00Z, first NYSE session 11-09).
  const session = "2026-11-09", asOf = "2026-11-06", now = Date.parse("2026-11-09T22:00:00Z");
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pe-parity-")), dbPath = join(root, "trading.db"), histPath = join(root, "historical.db");
    const db = new Database(dbPath), hist = new Database(histPath);
    db.exec(`CREATE TABLE portfolio_decisions (id INTEGER PRIMARY KEY, account_id TEXT, strategy_version TEXT,
      session TEXT, as_of TEXT, mode TEXT, status TEXT, equity REAL, book_json TEXT, memory_json TEXT,
      weights_json TEXT, diagnostics_json TEXT, orders_json TEXT)`);
    hist.exec(`CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
      open REAL, high REAL, low REAL, close REAL, volume REAL)`);
    const config: VolManagedConfig = { kind: "volManaged", universe: ["AAA", "BBB"], inceptionGuardBars: 4,
      volLookback: 3, covLookback: 3, portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 0.8, maxGross: 1,
      maxHoldSessions: 5, maxHoldStagger: true,
      regimeOverlay: { signals: [{ kind: "maTrend", symbol: "AAA", period: 3, sampling: "daily", bandPct: 1 }], combine: "any", coreScale: 0 } };
    const manifestPath = join(root, version.manifest!);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ candidates: [{ name: version.candidate, portfolio: { strategy: config } }], data: {} }));
    for (const symbol of config.universe) for (const [i, date] of ["2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", asOf].entries()) {
      const close = symbol === "AAA" ? [95, 99, 97, 102, 101, 106][i] : [85, 87, 86, 89, 91, 92][i];
      hist.query("INSERT INTO historical_bars VALUES (?, '1d', 'alpaca_wide', ?, ?, ?, ?, ?, 1000)")
        .run(symbol, Date.parse(`${date}T04:00:00Z`), close, close + 1, close - 1, close);
    }
    const book: Position[] = [{ symbol: "AAA", qty: 3, avgEntryPrice: 100, entrySession: "2026-11-03" }];
    // Observer memory of THIS version is eligible; another version's newer memory never is.
    const priorMemory = { portfolioCore: { version: 1, signals: {}, stops: {}, regime: {
      session: "2026-11-05", riskOff: false, signalOff: [false], pending: 0, switched: false, ready: true } } };
    const insert = db.query("INSERT INTO portfolio_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(1, sleeve, version.id, "2026-11-05", "2026-11-04", "observer", "observed", 1000, "[]", JSON.stringify(priorMemory), "{}", "{}", "[]");
    insert.run(2, sleeve, "other-version", asOf, "2026-11-05", "observer", "observed", 1000, "[]", '{"wrong":true}', "{}", "{}", "[]");
    const memory = latestPortfolioMemory(sleeve, version.id, { db, beforeSession: session });
    const view = new HistoricalPriceView({ db: hist, asOf, symbols: config.universe });
    const target = decide({ view, config, book: { equity: 1000, positions: book, memory }, executionSession: session });
    const prices = { AAA: 106, BBB: 92 };
    const orders: PersistedOrder[] = planOrders(target, { equity: 1000, positions: book, memory }, prices,
      { venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0.01 }).map(intent => ({
        intent, clientOrderId: null, result: { ok: true, filledQty: intent.qty, avgPrice: prices[intent.symbol as keyof typeof prices], status: "filled" }, applied: true,
      }));
    insert.run(3, sleeve, version.id, session, asOf, "live", "submitted", 1000, JSON.stringify(book), JSON.stringify(target.memory),
      JSON.stringify(target.weights), JSON.stringify({ ...target.diagnostics, freshness: view.freshness(config.universe), prices, rules: {}, drift: [] }), JSON.stringify(orders));
    return { db, hist, root, dbPath, histPath, orders, memory, target,
      run: (since?: string, clock = now) => checkPortfolioSleeve(sleeve, dbPath, histPath, root, since, clock),
      close() { db.close(); hist.close(); rmSync(root, { recursive: true, force: true }); } };
  }
  test("synthetic fixture: same kernel, exact input book/memory, weights, regime, maxHold and diagnostics → parity", () => {
    const f = fixture();
    try {
      expect(f.memory).not.toHaveProperty("wrong");
      const r = f.run();
      expect(r.divergences).toEqual([]);
      expect(r.portfolio).toHaveLength(1);
      expect(r.portfolio![0]).toMatchObject({ classification: "PARITY", maxNumericDelta: 0, differences: [], executionDrift: [] });
      expect(f.target.maxHold).toEqual(["AAA"]);
    } finally { f.close(); }
  });
  test("tampered weight with identical input diagnostics → DIVERGENCE", () => {
    const f = fixture();
    try {
      f.db.query("UPDATE portfolio_decisions SET weights_json = ? WHERE id = 3").run(JSON.stringify({ ...f.target.weights, AAA: 0.7 }));
      expect(f.run().portfolio![0].classification).toBe("DIVERGENCE");
      expect(f.run().divergences.map(d => d.type)).toContain("portfolio_decision");
    } finally { f.close(); }
  });
  test("a revised input bar changes diagnostics/weights, names the symbol, but does not page without a regime/target-set flip", () => {
    const f = fixture();
    try {
      f.hist.exec("UPDATE historical_bars SET close = close * 1.001 WHERE symbol = 'AAA' AND timestamp = (SELECT MAX(timestamp) FROM historical_bars)");
      const r = f.run();
      expect(r.portfolio![0].classification).toBe("DATA REVISED");
      expect(r.portfolio![0].changedSymbols).toEqual(["AAA"]);
      expect(r.divergences).toEqual([]);
      expect(renderSummary([r])).toContain("DATA REVISED");
    } finally { f.close(); }
  });
  test("revised bars that flip the regime/target set DO page", () => {
    const f = fixture();
    try {
      f.hist.exec("UPDATE historical_bars SET close = 50 WHERE symbol = 'AAA' AND timestamp = (SELECT MAX(timestamp) FROM historical_bars)");
      const r = f.run();
      expect(r.portfolio![0].classification).toBe("DATA REVISED");
      expect(r.divergences.map(d => d.type)).toContain("portfolio_data_flip");
    } finally { f.close(); }
  });
  test.each(["missing", "duplicate"])("%s NYSE session is a divergence, even across strategy versions", mode => {
    const f = fixture();
    try {
      if (mode === "missing") f.db.exec("DELETE FROM portfolio_decisions WHERE id = 3");
      else {
        f.db.exec(`INSERT INTO portfolio_decisions SELECT 4, account_id, strategy_version, session, as_of, mode, status,
          equity, book_json, memory_json, weights_json, diagnostics_json, orders_json FROM portfolio_decisions WHERE id = 3`);
        const old = MODEL_VERSIONS[sleeve].at(-2)!;
        const m = JSON.parse(readFileSync(join(f.root, version.manifest!), "utf8"));
        m.candidates[0].name = old.candidate;
        writeFileSync(join(f.root, old.manifest!), JSON.stringify(m));
        f.db.query("UPDATE portfolio_decisions SET strategy_version = ? WHERE id = 4").run(old.id);
      }
      expect(f.run().divergences).toContainEqual(expect.objectContaining({ type: "portfolio_session", symbol: expect.stringContaining(mode) }));
    } finally { f.close(); }
  });
  test("maxHold set tampering is a logic divergence", () => {
    const f = fixture();
    try {
      f.db.query("UPDATE portfolio_decisions SET orders_json = ? WHERE id = 3").run(JSON.stringify(f.orders.map(o => ({ ...o, intent: { ...o.intent, maxHold: undefined } }))));
      expect(f.run().portfolio![0]).toMatchObject({ classification: "DIVERGENCE" });
      expect(f.run().divergences).not.toEqual([]);
    } finally { f.close(); }
  });
  test("tampering only a derived diagnostic is NOT evidence of revised input bars", () => {
    const f = fixture();
    try {
      const d = f.db.query("SELECT diagnostics_json FROM portfolio_decisions WHERE id = 3").get() as any;
      const diagnostics = JSON.parse(d.diagnostics_json);
      diagnostics.scale += 0.1;
      f.db.query("UPDATE portfolio_decisions SET diagnostics_json = ? WHERE id = 3").run(JSON.stringify(diagnostics));
      expect(f.run().portfolio![0].classification).toBe("DIVERGENCE");
    } finally { f.close(); }
  });
  test("memory loader excludes failed/stale and future decisions, including across an older --since window", () => {
    const f = fixture();
    try {
      f.db.exec(`INSERT INTO portfolio_decisions SELECT 4, account_id, strategy_version, '2026-11-06', '2026-11-05', 'live', 'failed',
        equity, book_json, '{"bad":true}', weights_json, diagnostics_json, orders_json FROM portfolio_decisions WHERE id = 3`);
      expect(latestPortfolioMemory(sleeve, version.id, { db: f.db, beforeSession: session })).toEqual(f.memory);
      expect(f.run().portfolio![0].classification).toBe("PARITY");
      f.db.exec("UPDATE portfolio_decisions SET status = 'skipped_stale' WHERE id = 4");
      expect(latestPortfolioMemory(sleeve, version.id, { db: f.db, beforeSession: session })).toEqual(f.memory);
    } finally { f.close(); }
  });
  test("missing target bar and invalid as_of cannot be hidden as DATA REVISED", () => {
    const f = fixture();
    try {
      f.hist.exec("DELETE FROM historical_bars WHERE symbol = 'BBB' AND timestamp = (SELECT MAX(timestamp) FROM historical_bars)");
      expect(f.run().divergences[0].symbol).toContain("missing target bar BBB");
      f.db.exec("UPDATE portfolio_decisions SET as_of = session WHERE id = 3");
      expect(f.run().portfolio![0].classification).toBe("DIVERGENCE");
    } finally { f.close(); }
  });
  test.each(["canceled", "rejected", "account_gross_cap"])("%s execution drift reports resulting reference-weight error, never pages", status => {
    const f = fixture();
    try {
      const orders = f.orders.map((o, i) => i ? o : { ...o, result: { ok: false, filledQty: o.intent.qty / 2, avgPrice: 106, status } });
      f.db.query("UPDATE portfolio_decisions SET orders_json = ? WHERE id = 3").run(JSON.stringify(orders));
      const r = f.run();
      expect(r.divergences).toEqual([]);
      expect(r.portfolio![0].executionDrift[0]).toMatchObject({ status, filled: orders[0].intent.qty / 2 });
      expect(r.portfolio![0].executionDrift[0].offTargetWeight).not.toBe(0);
    } finally { f.close(); }
  });
  test("roundoff tolerance is tiny; raw calibration deltas remain visible", () => {
    const f = fixture();
    try {
      const key = Object.keys(f.target.weights)[0];
      f.db.query("UPDATE portfolio_decisions SET weights_json = ? WHERE id = 3").run(JSON.stringify({ ...f.target.weights, [key]: f.target.weights[key] + PORTFOLIO_FLOAT_TOLERANCE / 2 }));
      expect(f.run().divergences).toEqual([]);
      expect(f.run().portfolio![0].maxNumericDelta).toBeGreaterThan(0);
    } finally { f.close(); }
  });
  test("--since expands coverage without changing each recorded version's config", () => {
    const f = fixture();
    try {
      const r = f.run("2026-11-04");
      expect(r.divergences.filter(d => d.type === "portfolio_session")).toHaveLength(3); // 11-04, 11-05, 11-06 (observer ≠ live)
      expect(r.portfolio![0].classification).toBe("PARITY");
    } finally { f.close(); }
  });
  test("completed-session calendar handles holidays, early close and DST; today's early pass is replayed but not yet required", () => {
    expect(lastCompletedStockSession(Date.parse("2026-11-27T17:59:00Z"))).toBe("2026-11-25");
    expect(lastCompletedStockSession(Date.parse("2026-11-27T18:00:00Z"))).toBe("2026-11-27");
    expect(lastCompletedStockSession(Date.parse("2026-11-02T20:59:00Z"))).toBe("2026-10-30");
    const f = fixture();
    try {
      expect(f.run(undefined, Date.parse("2026-11-09T15:00:00Z")).portfolio![0].classification).toBe("PARITY"); // 10:00 EST: today not completed
      f.db.exec("DELETE FROM portfolio_decisions WHERE id = 3");
      expect(f.run(undefined, Date.parse("2026-11-09T15:00:00Z")).divergences).toEqual([]);
    } finally { f.close(); }
  });
  test("an unknown version fails operationally, never silently compares the incumbent", () => {
    const f = fixture();
    try {
      f.db.exec("UPDATE portfolio_decisions SET strategy_version = 'unknown' WHERE id = 3");
      expect(() => f.run()).toThrow("unknown portfolio version");
    } finally { f.close(); }
  });
});
