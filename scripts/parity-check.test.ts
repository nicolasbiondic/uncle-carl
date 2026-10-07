// ═══════════════════════════════════════════════════════════════════════
// parity-check unit tests — synthetic fixtures over the pure comparison
// layer (extractLiveDecisions / extractSimDecisions / compareDecisions).
// The three canonical scenarios: perfect parity, an entry missing live,
// an extra live exit. Plus the tolerance and pre-epoch-ignore semantics
// the monitor's guarantees rest on.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MATCH_TOLERANCE_DAYS,
  MATCH_TOLERANCE_HOURS_CRYPTO,
  compareDailyHoldings,
  compareDecisions,
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
import type { ClosedTrade, SeedPosition } from "./backtest-momentum-wf";
import { getETDayBounds } from "../src/db/database";

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
}>): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE trades (
    id TEXT PRIMARY KEY, account_id TEXT, symbol TEXT, side TEXT,
    entry_price REAL, quantity REAL, stop_loss REAL,
    entry_time INTEGER, exit_time INTEGER, status TEXT, close_reason TEXT
  )`);
  const ins = db.prepare(
    "INSERT INTO trades (id, account_id, symbol, side, entry_price, quantity, stop_loss, entry_time, exit_time, status) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  rows.forEach((r, i) => ins.run(
    `t${i}`, r.account ?? "meanrev_stocks", r.symbol, r.side ?? "buy",
    r.entryPrice ?? 100, r.quantity ?? 10, r.stopLoss ?? null,
    at(r.entry), r.exit ? at(r.exit) : null, r.status ?? (r.exit ? "closed" : "open"),
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
      entry_time INTEGER, exit_time INTEGER, status TEXT, close_reason TEXT
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
      entry_time INTEGER, exit_time INTEGER, status TEXT, close_reason TEXT
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
});

describe("momentum_crypto_usdc parity — live BASE/USDC vs the replay's BASE/USD proxies", () => {
  test("the sleeve is monitored from the owner's realign decision (10-08 00:00 UTC, UNI closed by its MODEL_CUTOVER)", () => {
    expect(PARITY_EPOCHS.momentum_crypto_usdc).toBe("2026-10-08T00:00:00Z");
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
