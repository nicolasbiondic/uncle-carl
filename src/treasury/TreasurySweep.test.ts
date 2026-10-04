// ══════════════════════════════════════════════════════════════
// TreasurySweep — the opt-in idle-cash sweep's full contract.
//
// Owner rule enforced here: the sweep is a NEW component on the shared
// Alpaca account's money path, so it ships OFF (ALPACA_TREASURY_SWEEP =
// null in src/index.ts) and only the owner flips it. These tests lock:
//   1. the OFF default itself;
//   2. buy-the-excess sizing and its uc8-treasury- idempotent order id;
//   3. sell-to-cover of negative EOD cash, capped at the ETF we hold —
//      NEVER a sleeve position (the "Alpaca close semantics" invariant:
//      nothing here can liquidate a sleeve's aggregate position);
//   4. once-per-ET-day idempotency of both passes;
//   5. broker failure → does nothing (and retries, marker unset);
//   6. exclusion of the treasury ETF from AccountManager orphan adoption
//      (universe disjunction), BrokerSync *_main adoption and qty-drift;
//   7. the TRADING_ENABLED mirror gates buys only.
// ══════════════════════════════════════════════════════════════

import { describe, test, expect, beforeAll } from "bun:test";
import {
  TreasurySweep,
  TREASURY_SYMBOLS,
  isTreasurySymbol,
  treasurySweepDue,
  treasuryCoverDue,
  TREASURY_SWEEP_ACCOUNT_ID,
  TREASURY_COVER_ACCOUNT_ID,
  type TreasuryBroker,
} from "./TreasurySweep";
import { ALPACA_TREASURY_SWEEP } from "../index";
import { dailyEntryClientOrderId } from "../executor/alpaca-executor";
import { MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "../config/riskProfiles";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import { stockSymbols, cryptoSymbols } from "../config/symbols";
import { BrokerSync, sleeveOwnsSymbol } from "../sync/BrokerSync";
import type { BrokerSyncSource } from "../sync/brokerSyncSource";
import { getDB, getETDayStart } from "../db/database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => {
  makeTestDb();
});

// A Tuesday 17:00 UTC = 12:00/13:00 ET — inside RTH, past 10:30 ET either
// way. Compute an instant safely past 10:30 ET and before 15:50 ET, plus one
// past 15:50 ET, from the ET day start (DST-proof).
const TUESDAY_UTC = Date.UTC(2026, 8, 22, 17, 0, 0); // 2026-09-22 (a trading Tuesday)
const ET_DAY_START = getETDayStart(TUESDAY_UTC);
const AT_11ET = ET_DAY_START + 11 * 60 * 60_000;      // 11:00 ET — sweep window
const AT_1555ET = ET_DAY_START + (15 * 60 + 55) * 60_000; // 15:55 ET — cover window
const AT_1000ET = ET_DAY_START + 10 * 60 * 60_000;    // 10:00 ET — before the sweep window
const NEXT_DAY_11ET = ET_DAY_START + 35 * 60 * 60_000; // next day 11:00 ET (Wednesday)

// ── The owner default: OFF, and structurally so ────────────────────────────

describe("ALPACA_TREASURY_SWEEP (owner rule)", () => {
  test("ON since 2026-09-28 by the OWNER's decision: BOXX with a 10% buffer — any other value needs the owner again", () => {
    // Shipped null ("queda APAGADO por defecto: lo activa el dueño",
    // 2026-09-27); the owner flipped it 2026-09-28 ("Sí, procede con 1 y 2").
    // BOXX because Alpaca paper credits no dividends (SGOV/BIL would earn ~0
    // here). Changing the vehicle or the buffer, or turning it off, is the
    // owner's call — update this test IN THE SAME reviewed change.
    expect(ALPACA_TREASURY_SWEEP).toEqual({ symbol: "BOXX", cashBufferPct: 0.10 });
  });

  test("constructor refuses a symbol outside TREASURY_SYMBOLS (exclusions would not cover it)", () => {
    expect(() => new TreasurySweep({ symbol: "SPY", cashBufferPct: 0.1 }, fakeBroker({}))).toThrow(/TREASURY_SYMBOLS/);
    expect(() => new TreasurySweep({ symbol: "SGOV", cashBufferPct: 0 }, fakeBroker({}))).toThrow(/cashBufferPct/);
    expect(() => new TreasurySweep({ symbol: "SGOV", cashBufferPct: 1.5 }, fakeBroker({}))).toThrow(/cashBufferPct/);
  });
});

// ── Fake broker ────────────────────────────────────────────────────────────

type PlacedOrder = { side: "buy" | "sell"; symbol: string; qty: number; accountId: string; entryDayKey?: number };

function fakeBroker(opts: {
  cash?: number | string | null;
  equity?: number | string;
  accountNull?: boolean;
  positions?: { symbol: string; quantity: number; avgEntryPrice: number }[];
  price?: number;
  orderResult?: "filled" | "null" | "unknown";
  disconnected?: boolean;
}): TreasuryBroker & { placed: PlacedOrder[] } {
  const placed: PlacedOrder[] = [];
  return {
    placed,
    isConnected: () => !opts.disconnected,
    async getAccount() {
      if (opts.accountNull) return null;
      return { cash: String(opts.cash ?? "0"), equity: String(opts.equity ?? "100000") };
    },
    async getPositions() {
      return opts.positions ?? [];
    },
    async getLatestPrice() {
      return opts.price ?? 100;
    },
    async placeOrder(signal, qty, accountId, o) {
      placed.push({ side: signal.side as any, symbol: signal.symbol, qty, accountId, entryDayKey: o.entryDayKey });
      if (opts.orderResult === "null") return null;
      if (opts.orderResult === "unknown") return { outcome: "unknown", reason: "timeout" } as any;
      return {
        id: "ord1", symbol: signal.symbol, market: "stock", side: signal.side, type: "market",
        quantity: qty, price: signal.price, status: "filled", filledPrice: signal.price,
        createdAt: Date.now(), updatedAt: Date.now(),
      } as any;
    },
  };
}

const CFG = { symbol: "SGOV", cashBufferPct: 0.1 } as const;

// ── Due windows ────────────────────────────────────────────────────────────

describe("due windows", () => {
  test("sweep: not before 10:30 ET, due after, once per ET day", () => {
    expect(treasurySweepDue(AT_1000ET, "")).toBe(false);
    expect(treasurySweepDue(AT_11ET, "")).toBe(true);
    expect(treasurySweepDue(AT_11ET, "2026-09-22")).toBe(false); // already ran today
    expect(treasurySweepDue(NEXT_DAY_11ET, "2026-09-22")).toBe(true);
  });
  test("cover: not before 15:50 ET, due after", () => {
    expect(treasuryCoverDue(AT_11ET, "")).toBe(false);
    expect(treasuryCoverDue(AT_1555ET, "")).toBe(true);
    expect(treasuryCoverDue(AT_1555ET, "2026-09-22")).toBe(false);
  });
  test("market closed → nothing is due (weekend)", () => {
    const saturday = Date.UTC(2026, 8, 26, 17, 0, 0);
    expect(treasurySweepDue(saturday, "")).toBe(false);
    expect(treasuryCoverDue(saturday, "")).toBe(false);
  });
});

// ── Buy the excess ─────────────────────────────────────────────────────────

describe("sweep pass (buy the excess over the buffer)", () => {
  test("cash $30k, equity $100k, buffer 10% → buys floor($20k/price) with the uc8-treasury- daily id", async () => {
    const broker = fakeBroker({ cash: 30_000, equity: 100_000, price: 100.5 });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    expect(broker.placed.length).toBe(1);
    const o = broker.placed[0];
    expect(o.side).toBe("buy");
    expect(o.symbol).toBe("SGOV");
    expect(o.qty).toBe(Math.floor(20_000 / 100.5)); // 199
    expect(o.accountId).toBe(TREASURY_SWEEP_ACCOUNT_ID);
    expect(o.entryDayKey).toBe(getETDayStart(AT_11ET));
    // The id placeOrder will derive from that (accountId, symbol, day):
    const cid = dailyEntryClientOrderId(o.accountId, o.symbol, o.entryDayKey!);
    expect(cid.startsWith("uc8-treasury-")).toBe(true);
  });

  test("cash at/below the buffer → no order, day marked done", async () => {
    const broker = fakeBroker({ cash: 9_000, equity: 100_000 });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    await ts.tick(AT_11ET + 60_000);
    expect(broker.placed.length).toBe(0);
  });

  test("excess below minOrderNotionalUsd → no crumb orders", async () => {
    const broker = fakeBroker({ cash: 10_500, equity: 100_000 }); // excess $500 < $1000 default
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    expect(broker.placed.length).toBe(0);
  });

  test("idempotent per ET day: a second due tick the same day places nothing; next day places again", async () => {
    const broker = fakeBroker({ cash: 30_000, equity: 100_000 });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    await ts.tick(AT_11ET + 5 * 60_000);
    expect(broker.placed.length).toBe(1);
    await ts.tick(NEXT_DAY_11ET);
    expect(broker.placed.length).toBe(2);
    // and the two days derive DIFFERENT deterministic ids
    const id1 = dailyEntryClientOrderId(TREASURY_SWEEP_ACCOUNT_ID, "SGOV", broker.placed[0].entryDayKey!);
    const id2 = dailyEntryClientOrderId(TREASURY_SWEEP_ACCOUNT_ID, "SGOV", broker.placed[1].entryDayKey!);
    expect(id1).not.toBe(id2);
  });

  test("TRADING_ENABLED=false mirror → buy skipped (day done), no order", async () => {
    const broker = fakeBroker({ cash: 30_000, equity: 100_000 });
    const ts = new TreasurySweep(CFG, broker, () => false);
    await ts.tick(AT_11ET);
    expect(broker.placed.length).toBe(0);
  });

  test("proven order failure (null) → retried within the day (idempotent id makes that safe)", async () => {
    const broker = fakeBroker({ cash: 30_000, equity: 100_000, orderResult: "null" });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    await ts.tick(AT_11ET + 60_000);
    expect(broker.placed.length).toBe(2); // retried — same deterministic id both times
    expect(broker.placed[0].entryDayKey).toBe(broker.placed[1].entryDayKey);
  });

  test("UNKNOWN order outcome → never resent (day done; broker truth reconciles)", async () => {
    const broker = fakeBroker({ cash: 30_000, equity: 100_000, orderResult: "unknown" });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    await ts.tick(AT_11ET + 60_000);
    expect(broker.placed.length).toBe(1);
  });
});

// ── Sell to cover negative EOD cash ────────────────────────────────────────

describe("cover pass (negative cash at EOD → sell back to the buffer)", () => {
  test("cash −$5k, equity $100k → sells ceil($15k/price) of the ETF with the uc8-treasury-eod- id", async () => {
    const broker = fakeBroker({ cash: -5_000, equity: 100_000, price: 100, positions: [{ symbol: "SGOV", quantity: 500, avgEntryPrice: 99.5 }] });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_1555ET);
    expect(broker.placed.length).toBe(1);
    const o = broker.placed[0];
    expect(o.side).toBe("sell");
    expect(o.symbol).toBe("SGOV");
    expect(o.qty).toBe(Math.ceil(15_000 / 100)); // buffer 10k − (−5k) = 15k deficit
    expect(o.accountId).toBe(TREASURY_COVER_ACCOUNT_ID);
    const cid = dailyEntryClientOrderId(o.accountId, o.symbol, o.entryDayKey!);
    expect(cid.startsWith("uc8-treasury-eod-")).toBe(true);
  });

  test("sell is CAPPED at the ETF quantity we actually hold", async () => {
    const broker = fakeBroker({ cash: -5_000, equity: 100_000, price: 100, positions: [{ symbol: "SGOV", quantity: 40, avgEntryPrice: 99.5 }] });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_1555ET);
    expect(broker.placed[0].qty).toBe(40);
  });

  test("negative cash but NO ETF held → sells NOTHING (sleeve positions are never touched)", async () => {
    const broker = fakeBroker({
      cash: -5_000, equity: 100_000,
      positions: [
        { symbol: "AAPL", quantity: 75, avgEntryPrice: 332 },  // momentum_stocks
        { symbol: "KO", quantity: 57, avgEntryPrice: 87.7 },   // meanrev_stocks
      ],
    });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_1555ET);
    expect(broker.placed.length).toBe(0);
  });

  test("cover only ever submits orders on the configured treasury ETF, whatever else the account holds", async () => {
    const broker = fakeBroker({
      cash: -50_000, equity: 100_000, price: 100,
      positions: [
        { symbol: "META", quantity: 40, avgEntryPrice: 607 },
        { symbol: "SGOV", quantity: 10, avgEntryPrice: 100 },
      ],
    });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_1555ET);
    expect(broker.placed.length).toBe(1);
    expect(broker.placed[0].symbol).toBe("SGOV");
    expect(broker.placed[0].qty).toBe(10); // capped at held — even a $60k deficit can't reach META
  });

  test("non-negative cash → nothing to cover, day done", async () => {
    // cash under the buffer so the (also-due) sweep pass is a no-op too —
    // this test isolates the cover pass's ≥0 branch.
    const broker = fakeBroker({ cash: 9_000, equity: 100_000, positions: [{ symbol: "SGOV", quantity: 500, avgEntryPrice: 99.5 }] });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_1555ET);
    await ts.tick(AT_1555ET + 60_000);
    expect(broker.placed.length).toBe(0);
  });

  test("idempotent per ET day", async () => {
    const broker = fakeBroker({ cash: -5_000, equity: 100_000, price: 100, positions: [{ symbol: "SGOV", quantity: 500, avgEntryPrice: 99.5 }] });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_1555ET);
    await ts.tick(AT_1555ET + 60_000);
    expect(broker.placed.length).toBe(1);
  });
});

// ── Broker failure → do nothing ────────────────────────────────────────────

describe("broker failure (fail closed, retry)", () => {
  test("getAccount null → no order, marker unset (retries next tick)", async () => {
    const broker = fakeBroker({ accountNull: true });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    await ts.tick(AT_1555ET);
    expect(broker.placed.length).toBe(0);
  });

  test("disconnected executor → no order", async () => {
    const broker = fakeBroker({ cash: 30_000, equity: 100_000, disconnected: true });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    expect(broker.placed.length).toBe(0);
  });

  test("unparseable account numbers → no order", async () => {
    const broker = fakeBroker({ cash: "not-a-number", equity: "100000" });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    expect(broker.placed.length).toBe(0);
  });

  test("no price → no order, marker unset (retries)", async () => {
    const broker = fakeBroker({ cash: 30_000, equity: 100_000, price: 0 });
    const ts = new TreasurySweep(CFG, broker);
    await ts.tick(AT_11ET);
    expect(broker.placed.length).toBe(0);
    // price recovers on a later tick the same day → the sweep completes
    (broker as any).getLatestPrice = async () => 100;
    await ts.tick(AT_11ET + 60_000);
    expect(broker.placed.length).toBe(1);
  });
});

// ── Exclusions: universes, orphan adoption, drift, native stops ────────────

describe("treasury ETF exclusions", () => {
  test("universe disjunction: no treasury symbol appears in ANY sleeve universe or symbol config", () => {
    for (const sym of TREASURY_SYMBOLS) {
      expect(MOMENTUM_STOCKS_UNIVERSE.includes(sym)).toBe(false);
      expect(MEANREV_UNIVERSE.includes(sym)).toBe(false);
      expect(MOMENTUM_CRYPTO_UNIVERSE.includes(sym)).toBe(false);
      expect(Object.keys(USDC_SYMBOL_MAP).includes(sym)).toBe(false);
      expect(stockSymbols.some(s => s.symbol === sym)).toBe(false);
      expect(cryptoSymbols.some(s => s.symbol === sym)).toBe(false);
      // ⇒ AccountManager's orphan adoption (ownerOf: MEANREV → momentum →
      // null) can never claim it for a sleeve, and no engine ever ranks it.
    }
  });

  test("sleeveOwnsSymbol does NOT own the treasury ETF (so only the explicit skip protects it)", () => {
    expect(sleeveOwnsSymbol("alpaca_paper", "SGOV")).toBe(false);
  });

  test("BrokerSync never adopts the treasury ETF under *_main and never counts it as qty drift", async () => {
    getDB().prepare(`DELETE FROM trades`).run();
    getDB().prepare(`DELETE FROM sync_state`).run();
    const source: BrokerSyncSource = {
      id: "alpaca_paper",
      name: "FakeAlpaca",
      status: "connected",
      async getAccount() { return { totalEquity: 100_000, availableCash: 10_000 }; },
      async getOpenPositions() {
        return [{ symbol: "SGOV", side: "buy", quantity: 250, entryPrice: 100.4 }] as any;
      },
    } as any;
    const bs = new BrokerSync([source], 30_000);
    const [result] = await bs.syncAll();
    expect(result.error).toBeUndefined();
    // no adoption: no trades row was filed for SGOV
    const row = getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE symbol = 'SGOV'`).get() as any;
    expect(row.c).toBe(0);
    // no drift alert despite broker=250 vs DB=0
    expect(result.driftAlerts.length).toBe(0);
    // …whereas a NON-treasury orphan in the same book still gets both:
    (source as any).getOpenPositions = async () => [{ symbol: "TSLA", side: "buy", quantity: 5, entryPrice: 400 }];
    const [r2] = await bs.syncAll();
    expect(r2.changes.some(c => c.type === "position_added" && c.symbol === "TSLA")).toBe(true);
    getDB().prepare(`DELETE FROM trades WHERE symbol = 'TSLA'`).run();
  });

  test("isTreasurySymbol covers the configured default (SGOV) and the alternate (BIL)", () => {
    expect(isTreasurySymbol("SGOV")).toBe(true);
    expect(isTreasurySymbol("BIL")).toBe(true);
    expect(isTreasurySymbol("SPY")).toBe(false);
  });
});

describe("treasury vehicle for a PAPER account (2026-09-28)", () => {
  test("BOXX is a recognized treasury symbol — the only one whose carry shows up without dividend crediting", () => {
    expect(isTreasurySymbol("BOXX")).toBe(true);
    expect(() => new TreasurySweep({ symbol: "BOXX", cashBufferPct: 0.1 }, fakeBroker({}))).not.toThrow();
  });
});

describe("sparse IEX tape (2026-09-28): the share count falls back to the ≤5-min last trade", () => {
  test("no <30s price but a sizing price → the sweep still buys, sized off it", async () => {
    const broker = { ...fakeBroker({ cash: 48_690, equity: 107_920 }), getLatestPrice: async () => 0, getSizingPrice: async () => 118.34 };
    const placed: any[] = [];
    broker.placeOrder = async (signal: any, qty: number) => { placed.push({ side: signal.side, symbol: signal.symbol, qty }); return { id: "o", symbol: signal.symbol, market: "stock", side: signal.side, type: "market", quantity: qty, status: "filled" } as any; };
    const ts = new TreasurySweep({ symbol: "BOXX", cashBufferPct: 0.1 }, broker as any);
    await ts.tick(AT_11ET);
    expect(placed).toEqual([{ side: "buy", symbol: "BOXX", qty: Math.floor((48_690 - 10_792) / 118.34) }]);
  });

  test("neither price available → no order, the day stays open for the next tick", async () => {
    const broker = { ...fakeBroker({ cash: 48_690, equity: 107_920 }), getLatestPrice: async () => 0, getSizingPrice: async () => 0 };
    let calls = 0;
    broker.placeOrder = async () => { calls++; return null; };
    const ts = new TreasurySweep({ symbol: "BOXX", cashBufferPct: 0.1 }, broker as any);
    await ts.tick(AT_11ET);
    expect(calls).toBe(0);
    (broker as any).getSizingPrice = async () => 118.34;
    await ts.tick(AT_11ET + 60_000);
    expect(calls).toBe(1);
  });
});
