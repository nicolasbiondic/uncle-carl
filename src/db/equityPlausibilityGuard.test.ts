// ══════════════════════════════════════════════
// Snapshot plausibility guard (2026-08-18 incident) — during a Binance
// testnet backend outage, /fapi/v2/account served a corrupt ledger and 20
// binance_main rows persisted with equity ≈ −$1.33e12 as synthetic=0,
// poisoning the chart, 7D/30D windows, the digest and the consolidated
// total. saveEquitySnapshot (the SINGLE writer) now refuses non-finite,
// negative, and order-of-magnitude-implausible readings: the row is NOT
// written (a gap is honest; a bogus row poisons everything), an ERROR is
// logged, and the rejection never throws (the 5-min snapshot loop must
// survive a corrupt broker read untouched).
//
// Falsifiability: remove implausibleSnapshotReason from saveEquitySnapshot
// and every rejection test below fails by finding the poisoned row.
// ══════════════════════════════════════════════
import { describe, expect, test, beforeEach } from "bun:test";
import { getDB, saveEquitySnapshot } from "./database";
import { makeTestDb, rawSnap } from "../test-support/db";

const INCIDENT_VALUE = -1_332_742_285_492.77; // verbatim from the prod DB

const rowCount = (p: string): number =>
  (getDB().prepare(`SELECT COUNT(*) n FROM equity_snapshots WHERE profile_id = ?`).get(p) as any).n;
const latestEquity = (p: string): number | undefined =>
  (getDB().prepare(`SELECT equity FROM equity_snapshots WHERE profile_id = ? ORDER BY snapshot_time DESC, id DESC LIMIT 1`).get(p) as any)?.equity;

beforeEach(() => {
  makeTestDb();
  // Last known real reading, shaped like prod just before the incident.
  rawSnap("binance_main", 9_700, Date.now() - 300_000, 5);
});

describe("rejections — row NOT written, no throw", () => {
  test("the exact incident value (−$1.33e12) is rejected without throwing", () => {
    let result: boolean | undefined;
    expect(() => { result = saveEquitySnapshot("binance_main", INCIDENT_VALUE, 7_270.44, 0); }).not.toThrow();
    expect(result).toBe(false);
    expect(rowCount("binance_main")).toBe(1);
    expect(latestEquity("binance_main")).toBe(9_700);
  });

  test("any negative equity is rejected — no tracked wallet can owe money", () => {
    expect(saveEquitySnapshot("binance_main", -0.01, 5_000, 0)).toBe(false);
    expect(rowCount("binance_main")).toBe(1);
  });

  test("non-finite equity or cash is rejected", () => {
    expect(saveEquitySnapshot("binance_main", NaN, 5_000, 0)).toBe(false);
    expect(saveEquitySnapshot("binance_main", Infinity, 5_000, 0)).toBe(false);
    expect(saveEquitySnapshot("binance_main", 9_700, NaN, 0)).toBe(false);
    expect(rowCount("binance_main")).toBe(1);
  });

  test("a >1000× jump over the last real snapshot is rejected", () => {
    expect(saveEquitySnapshot("binance_main", 9_700 * 1_001, 5_000, 0)).toBe(false);
    expect(rowCount("binance_main")).toBe(1);
  });

  test("a quarantined (synthetic=1) row is never the baseline", () => {
    // Corrupt-but-huge quarantined row must not legitimize more garbage.
    rawSnap("binance_main", 1e12, Date.now() - 60_000, 5, 1);
    expect(saveEquitySnapshot("binance_main", 5e12, 5_000, 0)).toBe(false);
    // …while a sane reading against the 9,700 real baseline still lands.
    expect(saveEquitySnapshot("binance_main", 9_705, 5_000, 0)).toBe(true);
  });
});

describe("legitimate readings still persist", () => {
  test("a normal reading is written and returns true", () => {
    expect(saveEquitySnapshot("binance_main", 9_705.12, 5_815.74, 0)).toBe(true);
    expect(rowCount("binance_main")).toBe(2);
    expect(latestEquity("binance_main")).toBe(9_705.12);
  });

  test("a large but plausible step (deposit ~10×) is NOT blocked", () => {
    expect(saveEquitySnapshot("binance_main", 97_000, 97_000, 0)).toBe(true);
    expect(latestEquity("binance_main")).toBe(97_000);
  });

  test("negative CASH is allowed (Alpaca margin) — only equity has a sign rule", () => {
    rawSnap("alpaca_main", 100_000, Date.now() - 300_000, 5);
    expect(saveEquitySnapshot("alpaca_main", 100_100, -2_500, 0)).toBe(true);
  });

  test("a drained, position-free wallet reading $0 is still accepted", () => {
    rawSnap("momentum_crypto_usdc", 5_000, Date.now() - 300_000, 5);
    expect(saveEquitySnapshot("momentum_crypto_usdc", 0, 0, 0)).toBe(true);
  });

  test("$0 equity while holding a position is rejected — the 2026-08-18 corrupt-read shape", () => {
    rawSnap("momentum_crypto_usdc", 4_700, Date.now() - 300_000, 5);
    expect(saveEquitySnapshot("momentum_crypto_usdc", 0, 0, 1)).toBe(false);
    expect(rowCount("momentum_crypto_usdc")).toBe(1);
  });

  test("a profile's first-ever snapshot has no baseline and is accepted", () => {
    expect(saveEquitySnapshot("momentum_btc", 1_000, 1_000, 0)).toBe(true);
    expect(rowCount("momentum_btc")).toBe(1);
  });
});

// The standalone operator script this described (scripts/quarantine-binance-
// equity-20260818.ts) was deleted 2026-09-25: it was the out-of-band twin of
// migrateDatabase's fingerprint (c) (src/db/database.ts, "2026-08-18 Binance
// testnet backend outage" comment), which runs the SAME quarantine
// automatically on every boot/DB-open — the standalone script had been fully
// redundant since that migration shipped. The plausibility guard tests above
// (saveEquitySnapshot rejecting the incident shape outright) are the live
// protection; this file no longer needs a subprocess-spawning test.

// Fingerprint (d): the 2026-08-18 outage rows on the two Binance SLEEVE series
// (exact prod shapes). They were the whole "all-time max drawdown" of both
// sleeves (momentum_crypto_usdc 100%, momentum_crypto 56.5%).
describe("migration fingerprint (d) — 2026-08-18 sleeve rows quarantined on DB open", () => {
  test("marks the six outage-window rows synthetic, leaves the neighbours and other profiles real", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const { initDatabase } = require("./database");
    const dir = mkdtempSync(join(tmpdir(), "uc-fp-d-"));
    const path = join(dir, "t.db");
    try {
      initDatabase(path);
      const at = (iso: string) => Date.parse(`2026-08-18T${iso}:00Z`);
      const rows: Array<[string, number, string]> = [
        ["momentum_crypto_usdc", 4_701, "00:30"],
        ["momentum_crypto_usdc", 0, "01:20"],
        ["momentum_crypto_usdc", 0, "02:10"],
        ["momentum_crypto_usdc", 5_000, "03:40"],
        ["momentum_crypto_usdc", 4_696.82, "04:00"],
        ["momentum_crypto", 5_000, "01:20"],
        ["momentum_crypto", 5_000, "02:00"],
        ["momentum_crypto", 10_004.38, "03:00"],
        ["momentum_crypto", 4_352.93, "04:00"],
        ["momentum_stocks", 50_000, "02:00"],
      ];
      for (const [p, e, t] of rows) rawSnap(p, e, at(t), 5);
      initDatabase(path); // re-open: migrateColumns runs the fingerprints
      const synth = (getDB().prepare(`SELECT profile_id p, snapshot_time t FROM equity_snapshots WHERE synthetic = 1 ORDER BY p, t`).all() as any[])
        .map(r => `${r.p}@${new Date(r.t).toISOString().slice(11, 16)}`);
      expect(synth).toEqual([
        "momentum_crypto@01:20", "momentum_crypto@02:00", "momentum_crypto@03:00",
        "momentum_crypto_usdc@01:20", "momentum_crypto_usdc@02:10", "momentum_crypto_usdc@03:40",
      ]);
    } finally {
      makeTestDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
