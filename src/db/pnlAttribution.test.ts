import { describe, expect, test, beforeAll } from "bun:test";
import { getDB, getPnlAttribution } from "./database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => { makeTestDb(); });

let seq = 0;
function seedAttr(o: { strategy: string; close_reason: string | null; pnl: number; exitTime?: number }) {
  const exit = o.exitTime ?? Date.now() - 60_000;
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity,
       entry_time, status, exit_time, pnl, pnl_pct, profile_id, account_id, close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `a_${seq++}`, "AAPL", "stock", "buy", o.strategy, 100, 1,
    exit - 3_600_000, "closed", exit, o.pnl, o.pnl, "p", "momentum_stocks", o.close_reason,
  );
}
const get = (r: ReturnType<typeof getPnlAttribution>, b: string) => r.buckets.find((x) => x.bucket === b)!;

describe("getPnlAttribution — algo edge vs reconcile vs broker-sync", () => {
  beforeAll(() => {
    // ALGO bucket: bot-opened AND bot-closed on its own terms.
    seedAttr({ strategy: "COMBINED", close_reason: "TAKE_PROFIT", pnl: 20 });
    seedAttr({ strategy: "COMBINED", close_reason: "STOP_LOSS", pnl: -8 });
    seedAttr({ strategy: "MOMENTUM", close_reason: null, pnl: 5 }); // NULL reason → still algo
    // RECONCILE bucket: bot-opened but closed EXTERNALLY (placeholder/real P&L).
    seedAttr({ strategy: "COMBINED", close_reason: "BROKER_GONE_404", pnl: 0 });
    seedAttr({ strategy: "COMBINED", close_reason: "MOMENTUM_RECONCILED", pnl: 3 });
    // SYNC bucket: positions the bot never opened.
    seedAttr({ strategy: "BROKER_SYNC", close_reason: "SYNC_DETECTED", pnl: 50 });
    seedAttr({ strategy: "SYNC_RECOVERY", close_reason: null, pnl: -10 });
  });

  test("splits the three sources by strategy + close_reason", () => {
    const r = getPnlAttribution(0); // 0 = all-time
    expect(get(r, "algo").trades).toBe(3);
    expect(get(r, "reconcile").trades).toBe(2);
    expect(get(r, "sync").trades).toBe(2);
  });

  test("algo bucket carries only bot-managed exits and their net P&L", () => {
    const algo = get(getPnlAttribution(0), "algo");
    expect(algo.totalPnl).toBeCloseTo(17, 6);     // 20 − 8 + 5
    expect(algo.wins).toBe(2);                     // +20, +5 (the −8 is a loss)
    expect(algo.winRate).toBeCloseTo(2 / 3, 6);
    expect(algo.profitFactor).toBeCloseTo(25 / 8, 6); // gross 25 / gross-loss 8
  });

  test("sync bucket is real but NOT attributable to the strategy", () => {
    const sync = get(getPnlAttribution(0), "sync");
    expect(sync.totalPnl).toBeCloseTo(40, 6);      // 50 − 10
    expect(sync.profitFactor).toBeCloseTo(5, 6);   // 50 / 10
  });

  test("profitFactor is null when a bucket has profit but no losses", () => {
    // reconcile = {0, +3}: gross-loss 0, gross-profit 3 → PF undefined (null).
    const recon = get(getPnlAttribution(0), "reconcile");
    expect(recon.totalPnl).toBeCloseTo(3, 6);
    expect(recon.profitFactor).toBeNull();
  });

  test("netPnl is the sum across all three buckets", () => {
    const r = getPnlAttribution(0);
    expect(r.netPnl).toBeCloseTo(17 + 3 + 40, 6);
  });

  test("the days window excludes trades closed before the cutoff", () => {
    seedAttr({ strategy: "COMBINED", close_reason: "TAKE_PROFIT", pnl: 999, exitTime: Date.now() - 40 * 86_400_000 });
    const r30 = getPnlAttribution(30); // 30d window must NOT see the 40-day-old trade
    expect(get(r30, "algo").totalPnl).toBeCloseTo(17, 6);
    const rAll = getPnlAttribution(0); // all-time DOES see it
    expect(get(rAll, "algo").totalPnl).toBeCloseTo(17 + 999, 6);
  });

  // 2026-09-24 audit fix: "Where the P&L comes from" used to sum EVERY
  // account_id — the amputated pre-v8 legacy profiles (alpaca_low/high,
  // binance_low/high, April–July) silently blended into a table a v8-only
  // reader takes as "real algo edge". Now restricted to ALL_PROFILE_IDS,
  // same as getHourlyAnalytics/getSymbolAnalytics/getCloseReasonAttribution.
  test("legacy pre-v8 account_ids (alpaca_low/high, binance_low/high) are excluded — v8 sleeves only", () => {
    const before = getPnlAttribution(0).netPnl;
    getDB().prepare(
      `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity,
         entry_time, status, exit_time, pnl, pnl_pct, profile_id, account_id, close_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(`legacy_${seq++}`, "AAPL", "stock", "buy", "COMBINED", 100, 1,
      Date.now() - 7_200_000, "closed", Date.now() - 60_000, 12_345, 5, "p", "alpaca_high", "TAKE_PROFIT");
    expect(getPnlAttribution(0).netPnl).toBeCloseTo(before, 6);
  });
});
