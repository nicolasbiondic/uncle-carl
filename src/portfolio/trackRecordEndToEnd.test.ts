// ══════════════════════════════════════════════
// End-to-end: seeded equity_snapshots shaped like production (5-min-ish
// cadence, several snapshots/day, a hole, a shadow sleeve) → daily return
// series → MinTRL/PSR track record → the two exposure surfaces
// (/api/analytics/track-record and /metrics), asserting the SAME numbers
// come out everywhere.
// ══════════════════════════════════════════════

import express from "express";
import { describe, expect, test, beforeAll } from "bun:test";
import { makeTestDb, rawSnap } from "../test-support/db";
import { SleeveGovernor } from "../governor/SleeveGovernor";
import { registerAnalyticsRoutes } from "../dashboard/routes/analytics";
import { registerMetricsEndpoint } from "../metrics/PrometheusExporter";
import { getDailySleeveReturns } from "./sleeveReturns";
import { getSleeveTrackRecord } from "./trackRecord";

const DAY = 86_400_000;
// Fixed winter-2026 window (EST): 40 calendar days ending Thu 2026-02-19.
const T_END = Date.parse("2026-02-19T17:00:00Z"); // noon ET
const N_DAYS = 40;
const MISSING_IDX = 15; // one full day with zero snapshots (pipeline outage)

// Deterministic daily return path: slight positive drift + sinusoidal noise.
const dayRet = (i: number) => 0.0008 + 0.009 * Math.sin(i * 1.7);

beforeAll(() => {
  makeTestDb();

  // momentum_crypto: 3 snapshots per day (08:00/12:00/16:00 ET), the LAST one
  // carrying that day's end-of-day equity; one day missing entirely.
  let equity = 5_000;
  for (let i = N_DAYS - 1; i >= 1; i--) {
    const dayNoon = T_END - i * DAY;
    equity *= 1 + dayRet(i);
    if (i === MISSING_IDX) continue; // outage day: equity still moved, no snapshots
    rawSnap("momentum_crypto", equity * 0.999, dayNoon - 4 * 3_600_000, 5); // intraday noise —
    rawSnap("momentum_crypto", equity * 1.001, dayNoon, 5);                 // must NOT become observations
    rawSnap("momentum_crypto", equity, dayNoon + 4 * 3_600_000, 5);         // end-of-day mark
  }

  // momentum_stocks: shadow sleeve (the exact sleeve whose evidence we want
  // to accumulate) — mode row present, snapshots still flowing.
  const gov = new SleeveGovernor();
  gov.setMode("momentum_stocks", "shadow", "capital-allocation research demotion");
  let se = 50_000;
  for (let i = 10; i >= 1; i--) {
    const dayNoon = T_END - i * DAY;
    const key = new Date(dayNoon).toISOString().slice(0, 10);
    const dow = new Date(Date.parse(`${key}T00:00:00Z`)).getUTCDay();
    if (dow === 0 || dow === 6) continue; // market closed — no ledger movement worth seeding
    se *= 1 + dayRet(i) / 2;
    rawSnap("momentum_stocks", se, dayNoon + 4 * 3_600_000, 5);
  }
});

// Expected observation count: 39 marked days (40 minus the outage day) minus
// the first mark (no predecessor) minus 2 returns destroyed by the hole (the
// outage day itself and the day after, whose predecessor is missing).
const EXPECTED_MARKS = N_DAYS - 1 - 1; // 38: days i=1..39 seeded, minus outage
const EXPECTED_OBS = EXPECTED_MARKS - 1 - 1; // 36

describe("seeded production-shaped series → returns + track record", () => {
  test("daily series: one obs/day from end-of-day marks, the outage is a gap with a cause", () => {
    const s = getDailySleeveReturns("momentum_crypto", { now: T_END });
    expect(s.nDailyMarks).toBe(EXPECTED_MARKS);
    expect(s.nObservations).toBe(EXPECTED_OBS);
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0].cause).toBe("missing_snapshots");
    // Returns must be computed end-of-day-mark to end-of-day-mark — the
    // intraday ±0.1% noise rows never contaminate r_t:
    for (const r of s.returns) {
      expect(Math.abs(r.ret)).toBeLessThan(0.02); // dayRet bounds: |0.0008|+0.009 < 1%… + splice
      expect(Number.isNaN(r.ret)).toBe(false);
    }
  });

  test("track record: honest output — Sharpe never travels without n/PSR/missing-obs", () => {
    const rec = getSleeveTrackRecord("momentum_crypto", { now: T_END });
    const tr = rec.trackRecord;
    expect(tr.n).toBe(EXPECTED_OBS);
    expect(rec.series.obsPerYear).toBe(365); // 24/7 sleeve → calendar annualization
    expect(tr.sharpePerObs).not.toBeNull();
    expect(tr.psr).not.toBeNull();
    expect(tr.psr!).toBeGreaterThan(0); expect(tr.psr!).toBeLessThan(1);
    // 36 daily observations of a weak edge cannot be a sufficient track
    // record; whatever the exact status, sufficiency must NOT be claimed.
    expect(tr.status).not.toBe("track_record_sufficient");
    if (tr.obsNeeded != null) expect(tr.obsMissing).toBe(Math.max(0, tr.obsNeeded - tr.n));
  });

  test("shadow sleeve carries its mode + fresh/stale distinction into the record", () => {
    const rec = getSleeveTrackRecord("momentum_stocks", { now: T_END });
    expect(rec.series.mode).toBe("shadow");
    expect(rec.series.equitySource).toBe("ledger");
    expect(rec.series.grid).toBe("trading_days");
    // Last seeded snapshot is ~1 day before T_END → the pipeline is NOT
    // fresh at T_END; a shadow sleeve with a dead pipeline must still show
    // as stale (shadow explains flatness, never silence).
    expect(rec.series.seriesFresh).toBe(false);
    expect(rec.series.status).toBe("stale");
  });
});

describe("exposure surfaces publish the same numbers", () => {
  async function withServer(register: (app: express.Application) => void, path: string): Promise<{ status: number; text: string }> {
    const app = express();
    register(app);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, text: await res.text() };
    } finally {
      server.close();
    }
  }

  test("GET /api/analytics/track-record: every sleeve, with observations/required/PSR/Sharpe/status together", async () => {
    const { status, text } = await withServer(app => registerAnalyticsRoutes(app, {} as any), "/api/analytics/track-record");
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.sleeves).toHaveLength(5);
    const crypto = body.sleeves.find((s: any) => s.profileId === "momentum_crypto");
    expect(crypto.trackRecord.n).toBe(EXPECTED_OBS);
    expect(crypto.series.gaps).toHaveLength(1);
    // The honest-state fields are always present, even for empty sleeves:
    for (const s of body.sleeves) {
      expect(typeof s.trackRecord.status).toBe("string");
      expect(s.trackRecord).toHaveProperty("psr");
      expect(s.trackRecord).toHaveProperty("obsMissing");
      expect(s.series).toHaveProperty("mode");
      expect(s.series).toHaveProperty("seriesFresh");
    }
    const stocks = body.sleeves.find((s: any) => s.profileId === "momentum_stocks");
    expect(stocks.series.mode).toBe("shadow");
    const btc = body.sleeves.find((s: any) => s.profileId === "momentum_btc");
    expect(btc.trackRecord.status).toBe("no_data"); // never seeded — honestly empty
  });

  test("/metrics: track-record gauges present and consistent with the module's own numbers", async () => {
    const am = {
      getAccount: () => ({ equity: { equity: 0, cash: 0, totalPnl: 0, initialEquity: 0 } }),
    } as any;
    const { status, text } = await withServer(app => registerMetricsEndpoint(app, am), "/metrics");
    expect(status).toBe(200);

    const rec = getSleeveTrackRecord("momentum_crypto"); // real now — same past data
    expect(text).toContain(`trading_track_record_observations{profile="momentum_crypto"} ${rec.trackRecord.n}`);
    expect(text).toContain(`trading_track_record_sufficient{profile="momentum_crypto"} ${rec.trackRecord.status === "track_record_sufficient" ? 1 : 0}`);
    if (rec.trackRecord.obsNeeded != null) {
      expect(text).toContain(`trading_track_record_obs_required{profile="momentum_crypto"} ${rec.trackRecord.obsNeeded}`);
    }
    if (rec.trackRecord.psr != null) {
      expect(text).toContain(`trading_track_record_psr{profile="momentum_crypto"} ${rec.trackRecord.psr.toFixed(4)}`);
    }
    // Empty sleeve: observations gauge exists (0), undefined measures OMITTED
    // — never faked as 0:
    expect(text).toContain(`trading_track_record_observations{profile="momentum_btc"} 0`);
    expect(text).not.toContain(`trading_track_record_psr{profile="momentum_btc"}`);
    expect(text).not.toContain(`trading_track_record_obs_required{profile="momentum_btc"}`);
    // HELP text ships with the metric (self-describing exposition):
    expect(text).toContain("# HELP trading_track_record_obs_required");
  });
});
