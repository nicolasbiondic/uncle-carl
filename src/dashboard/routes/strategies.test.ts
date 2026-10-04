import express from "express";
import { describe, expect, test } from "bun:test";
import { getDB, saveEquitySnapshot } from "../../db/database";
import { registerStrategyRoutes } from "./strategies";
import { makeTestDb } from "../../test-support/db";

function rawSnapshot(profileId: string, equity: number, cash: number, at: number, semantics: number): void {
  getDB().prepare(
    `INSERT INTO equity_snapshots (profile_id, equity, cash, snapshot_time, semantics)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(profileId, equity, cash, at, semantics);
}

describe("GET /api/equity/history consolidated truth", () => {
  test("omits buckets until both broker series are known", async () => {
    makeTestDb();
    const first = Math.floor(Date.now() / 300_000) * 300_000 - 1_200_000;
    const complete = first + 300_000;
    const stale = complete + 900_000;
    saveEquitySnapshot("alpaca_main", 100_000, 80_000, 0, first);
    saveEquitySnapshot("binance_main", 10_000, 7_000, 0, complete);
    saveEquitySnapshot("alpaca_main", 101_000, 81_000, 0, stale);

    const app = express();
    registerStrategyRoutes(app, { getActiveStrategies: () => [] } as any);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/equity/history?account=consolidated&range=1h`);
      expect(await response.json()).toEqual([
        { snapshot_time: complete, equity: 110_000, cash: 87_000, rebased: false },
      ]);
    } finally {
      server.close();
    }
  });

  test("range=all crosses historical eras and marks a synthetic display basis", async () => {
    makeTestDb();
    // This fixture uses round numbers rather than production's recovered
    // transition, so give it its own persisted 2→3 offset.
    getDB().prepare(
      `UPDATE equity_semantics_transitions SET equity_offset = -5000
       WHERE profile_id = 'binance_main' AND from_semantics = 2 AND to_semantics = 3`,
    ).run();
    const old = Math.floor(Date.now() / 300_000) * 300_000 - 7_200_000;
    const current = old + 300_000;
    rawSnapshot("alpaca_main", 100_000, 80_000, old, 2);
    rawSnapshot("binance_main", 10_000, 7_000, old, 2);
    rawSnapshot("alpaca_main", 100_100, 80_100, current, 5);
    rawSnapshot("binance_main", 5_000, 3_000, current, 3);

    const app = express();
    registerStrategyRoutes(app, { getActiveStrategies: () => [] } as any);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/equity/history?account=consolidated&range=all`);
      expect(await response.json()).toEqual([
        { snapshot_time: old, equity: 105_000, cash: 87_000, rebased: true },
        { snapshot_time: current, equity: 105_100, cash: 83_100, rebased: false },
      ]);
    } finally {
      server.close();
    }
  });

  // Mandate 2026-07-19: adding binance_coinm_main (DAPI) as a genuinely new
  // leg must never truncate months of pre-existing alpaca/binance history
  // to DAPI's own launch date, and must never fabricate a jump at the
  // boundary where DAPI's real readings begin.
  test("DAPI starting today does not truncate months-old alpaca/binance history — pre-genesis buckets use a constant baseline, latest sum stays exact", async () => {
    makeTestDb();
    const oldBucket = Math.floor((Date.now() - 90 * 86_400_000) / 300_000) * 300_000;
    const nowBucket = Math.floor(Date.now() / 300_000) * 300_000;
    saveEquitySnapshot("alpaca_main", 100_000, 80_000, 0, oldBucket);
    saveEquitySnapshot("binance_main", 5_000, 4_000, 0, oldBucket);
    saveEquitySnapshot("alpaca_main", 101_000, 81_000, 0, nowBucket);
    saveEquitySnapshot("binance_main", 5_200, 4_100, 0, nowBucket);
    saveEquitySnapshot("binance_coinm_main", 1_000, 1_000, 0, nowBucket); // DAPI genesis = today

    const app = express();
    registerStrategyRoutes(app, { getActiveStrategies: () => [] } as any);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/equity/history?account=consolidated&range=all`);
      const rows = await response.json();

      // Months-old bucket (before DAPI existed) is PRESERVED — not
      // truncated to today — using DAPI's own first-ever reading as a
      // constant synthetic baseline, marked rebased (no simple all-time %
      // off a fabricated basis).
      expect(rows[0]).toEqual({
        snapshot_time: oldBucket, equity: 100_000 + 5_000 + 1_000, cash: 80_000 + 4_000 + 1_000, rebased: true,
      });
      // Latest bucket sums the REAL current readings exactly — no fake jump.
      expect(rows[rows.length - 1]).toEqual({
        snapshot_time: nowBucket, equity: 101_000 + 5_200 + 1_000, cash: 81_000 + 4_100 + 1_000, rebased: false,
      });
    } finally {
      server.close();
    }
  });

  test("DAPI never enabled (no binance_coinm_main snapshot ever) is excluded from the curve entirely — same 2-leg behavior as before", async () => {
    makeTestDb();
    const at = Math.floor(Date.now() / 300_000) * 300_000;
    saveEquitySnapshot("alpaca_main", 100_000, 80_000, 0, at);
    saveEquitySnapshot("binance_main", 5_000, 4_000, 0, at);

    const app = express();
    registerStrategyRoutes(app, { getActiveStrategies: () => [] } as any);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/equity/history?account=consolidated&range=all`);
      expect(await response.json()).toEqual([{ snapshot_time: at, equity: 105_000, cash: 84_000, rebased: false }]);
    } finally {
      server.close();
    }
  });

  test("DAPI applicable but currently stale (gone quiet after genesis) drops the bucket closed, not a FAPI-only partial", async () => {
    makeTestDb();
    const genesis = Math.floor((Date.now() - 60 * 60_000) / 300_000) * 300_000;
    const stale = Math.floor(Date.now() / 300_000) * 300_000; // 1h later — beyond the freshness gate
    saveEquitySnapshot("alpaca_main", 100_000, 80_000, 0, genesis);
    saveEquitySnapshot("binance_main", 5_000, 4_000, 0, genesis);
    saveEquitySnapshot("binance_coinm_main", 1_000, 1_000, 0, genesis);
    saveEquitySnapshot("alpaca_main", 100_100, 80_100, 0, stale);
    saveEquitySnapshot("binance_main", 5_050, 4_050, 0, stale);
    // binance_coinm_main never updates again — goes stale past BROKER_SNAPSHOT_MAX_AGE_MS.

    const app = express();
    registerStrategyRoutes(app, { getActiveStrategies: () => [] } as any);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/equity/history?account=consolidated&range=all`);
      const rows = await response.json();
      expect(rows).toEqual([{ snapshot_time: genesis, equity: 106_000, cash: 85_000, rebased: false }]);
      // The stale bucket is dropped entirely — never a FAPI+alpaca-only
      // partial masquerading as the full portfolio total.
      expect(rows.find((r: any) => r.snapshot_time === stale)).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
