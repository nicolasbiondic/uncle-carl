import { test, expect, beforeAll } from "bun:test";
import { getDB, pruneEquitySnapshots } from "./database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => { makeTestDb(); });

// Verifies the equity_snapshots retention: full resolution within the last
// `fullResDays`, exactly one row per (profile, hour) for anything older, and the
// earliest row of each old hour bucket (the since-start baseline) is preserved.
test("pruneEquitySnapshots keeps full-res recent + 1/hour older", () => {
  const db = getDB();
  const P = "__prune_test__";
  // All rows share one semantics value (era 5) — this fixture is about the
  // hourly downsample, not run-boundary preservation (see
  // pruneTransitionInvariance.test.ts for that).
  const ins = db.prepare(
    "INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics) VALUES (?,?,?,?,?,5)",
  );
  db.prepare("DELETE FROM equity_snapshots WHERE profile_id = ?").run(P);

  const now = Date.now();
  const HOUR = 3600_000;
  const DAY = 86_400_000;

  // 3 recent rows (< full-res window) — must all survive.
  ins.run(P, 100, 100, 0, now - 1 * 60_000);
  ins.run(P, 100, 100, 0, now - 2 * 60_000);
  ins.run(P, 100, 100, 0, now - 3 * 60_000);

  // 5 OLD rows (5 days ago) inside ONE hour bucket — only the earliest survives.
  const oldHour = Math.floor((now - 5 * DAY) / HOUR) * HOUR; // aligned to hour start
  for (let i = 0; i < 5; i++) ins.run(P, 100, 100, 0, oldHour + i * 60_000);

  // 3 OLD rows (6 days ago) in three DIFFERENT hour buckets — all survive.
  const old2 = Math.floor((now - 6 * DAY) / HOUR) * HOUR;
  ins.run(P, 100, 100, 0, old2);
  ins.run(P, 100, 100, 0, old2 + HOUR);
  ins.run(P, 100, 100, 0, old2 + 2 * HOUR);

  expect((db.prepare("SELECT COUNT(*) c FROM equity_snapshots WHERE profile_id=?").get(P) as any).c).toBe(11);

  pruneEquitySnapshots(2);

  const rows = (db.prepare("SELECT snapshot_time FROM equity_snapshots WHERE profile_id=? ORDER BY snapshot_time ASC").all(P) as any[]).map(r => r.snapshot_time);
  // 3 recent + 1 (earliest of the 5 same-hour) + 3 distinct-hour = 7
  expect(rows.length).toBe(7);
  expect(rows).toContain(oldHour);              // baseline of the old hour kept
  expect(rows).not.toContain(oldHour + 60_000); // later same-hour rows pruned
  expect(rows.filter(t => t > now - 10 * 60_000).length).toBe(3); // recent intact
  expect(rows).toContain(old2 + HOUR);          // distinct hours all kept

  db.prepare("DELETE FROM equity_snapshots WHERE profile_id = ?").run(P);
});
