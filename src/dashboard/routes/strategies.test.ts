import express from "express";
import { describe, expect, test } from "bun:test";
import { getDB, saveEquitySnapshot } from "../../db/database";
import { registerStrategyRoutes } from "./strategies";
import { makeTestDb } from "../../test-support/db";

/** The last row carries `moneyWindow` (the tile's window, A-4); the point
 *  rows themselves are unchanged. */
function points(rows: any[]): any[] {
  return rows.map(({ moneyWindow: _w, ...r }) => r);
}

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
      const rows = await response.json();
      expect(points(rows)).toEqual([
        { snapshot_time: old, equity: 105_000, cash: 87_000, rebased: true },
        { snapshot_time: current, equity: 105_100, cash: 83_100, rebased: false },
      ]);
      // An unclassified (discontinuous) alpaca 2→5 boundary: no window P&L
      // header may be invented across it (the frontend renders "—").
      expect(rows.at(-1)).toHaveProperty("moneyWindow", null);
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
      expect(points(rows)[0]).toEqual({
        snapshot_time: oldBucket, equity: 100_000 + 5_000 + 1_000, cash: 80_000 + 4_000 + 1_000, rebased: true,
      });
      // Latest bucket sums the REAL current readings exactly — no fake jump.
      expect(points(rows)[rows.length - 1]).toEqual({
        snapshot_time: nowBucket, equity: 101_000 + 5_200 + 1_000, cash: 81_000 + 4_100 + 1_000, rebased: false,
      });
      // The header window is the tile's: Σ legs' first display rows (the DAPI
      // leg's synthetic pre-genesis baseline makes the start rebased ⇒ no %).
      const w = rows[rows.length - 1].moneyWindow;
      expect(w.pnl).toBe(1_200);
      expect(w.pnlPct).toBeNull();
      expect(w.start).toMatchObject({ at: oldBucket, equity: 106_000, rebased: true });
      expect(rows[rows.length - 1].equity - rows[0].equity).toBe(w.pnl);
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
      expect(points(await response.json())).toEqual([{ snapshot_time: at, equity: 105_000, cash: 84_000, rebased: false }]);
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
      expect(points(rows)).toEqual([{ snapshot_time: genesis, equity: 106_000, cash: 85_000, rebased: false }]);
      expect(rows.at(-1).moneyWindow).toBeNull(); // a stale leg: no window, not a 2-leg partial
      // The stale bucket is dropped entirely — never a FAPI+alpaca-only
      // partial masquerading as the full portfolio total.
      expect(rows.find((r: any) => r.snapshot_time === stale)).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe("GET /api/equity/history for one strategy (the Positions chart)", () => {
  test("days=30&points=120: the window is the strategy's own reader, the series is thinned and keeps its ends, last − first is the window's change", async () => {
    makeTestDb();
    const now = Date.now();
    // Hourly marks for 31 days: a strategy that rose, with a dip in the middle.
    for (let i = 31 * 24; i >= 0; i--) {
      const at = now - i * 3_600_000;
      const equity = 50_000 + (31 * 24 - i) * 2 - (i > 300 && i < 400 ? 600 : 0);
      saveEquitySnapshot("momentum_crypto", equity, 10_000, 0, at);
    }
    const app = express();
    registerStrategyRoutes(app, { getActiveStrategies: () => [] } as any);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const get = async (q: string) => (await fetch(`http://127.0.0.1:${port}/api/equity/history?account=momentum_crypto&${q}`)).json() as Promise<any[]>;
      const full = await get("days=30");
      const thin = await get("days=30&points=120");
      expect(full.length).toBeGreaterThan(120);
      expect(thin.length).toBeLessThanOrEqual(120);
      expect(thin.length).toBeGreaterThan(100);
      const w = thin.at(-1).moneyWindow;
      expect(w).not.toBeNull();
      expect(w).toEqual(full.at(-1).moneyWindow); // thinning never changes the figure
      expect(thin[0].snapshot_time).toBe(full[0].snapshot_time);
      expect(thin.at(-1).snapshot_time).toBe(full.at(-1).snapshot_time);
      expect(thin.at(-1).equity - thin[0].equity).toBeCloseTo(w.pnl, 8);
      expect(thin.at(-1).equity).toBe(w.equity);
      expect(thin[0].equity).toBe(w.start.equity);
    } finally {
      server.close();
    }
  });

  test("a strategy with no marks answers an empty series, nothing invented", async () => {
    makeTestDb();
    const app = express();
    registerStrategyRoutes(app, { getActiveStrategies: () => [] } as any);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const rows = await (await fetch(`http://127.0.0.1:${port}/api/equity/history?account=meanrev_stocks&days=30&points=120`)).json() as any[];
      expect(rows.filter((r) => r.moneyWindow)).toEqual([]);
      expect(rows.length).toBeLessThanOrEqual(1);
    } finally {
      server.close();
    }
  });
});
