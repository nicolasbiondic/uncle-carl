#!/usr/bin/env bun
// scripts/cleanup-boot-snapshots.ts — remove the equity_snapshots rows that a
// restart wrote with a sleeve's frozen accounts-table value instead of a
// synced reading (bug fixed 2026-10-06, see EquityTracker.synced). On the
// dashboard they were one-point spikes (−9% momentum_stocks, −4%
// meanrev_stocks at every restart) that stretched the y-axis until the real
// moves looked flat.
//
//   bun scripts/cleanup-boot-snapshots.ts [--db data/trading.db]          list only
//   bun scripts/cleanup-boot-snapshots.ts [--db data/trading.db] --apply  back up, then delete
//
// A row is removed only when ALL hold — a pure spike, nothing else:
//   - its equity equals the profile's frozen accounts value (±$0.005);
//   - it belongs to a run of such rows of ≤5 rows spanning ≤15 min;
//   - the rows right before and after the run exist, are both >1% away from
//     that value, and agree with each other within 1% (the curve comes back).
// A sleeve that really sat flat at that value (no positions) is a long run
// and is never touched. --apply first writes a consistent copy of the DB
// (VACUUM INTO data/backups/pre-boot-snapshot-cleanup-<ts>.db).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const dbPath = arg("db", "data/trading.db");
const apply = process.argv.includes("--apply");
const MAX_RUN_ROWS = 5;
const MAX_RUN_MS = 15 * 60_000;
const FAR = 0.01;

const db = new Database(dbPath, apply ? undefined : { readonly: true });
db.run("PRAGMA busy_timeout = 10000");
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

type Row = { id: number; t: number; e: number };
const doomed: { profile: string; row: Row; prev: Row; next: Row }[] = [];
for (const acct of db.query("SELECT id, equity, cash FROM accounts ORDER BY id").all() as { id: string; equity: number; cash: number }[]) {
  const frozen = acct.equity > 0 ? acct.equity : acct.cash;
  if (!(frozen > 0)) continue;
  const rows = db.query("SELECT id, snapshot_time t, equity e FROM equity_snapshots WHERE profile_id = ? ORDER BY snapshot_time, id").all(acct.id) as Row[];
  const isFrozen = (r: Row) => Math.abs(r.e - frozen) <= 0.005;
  for (let i = 0; i < rows.length; i++) {
    if (!isFrozen(rows[i])) continue;
    let j = i;
    while (j + 1 < rows.length && isFrozen(rows[j + 1])) j++;
    const prev = rows[i - 1], next = rows[j + 1];
    const run = rows.slice(i, j + 1);
    const pureSpike = prev && next
      && run.length <= MAX_RUN_ROWS
      && rows[j].t - rows[i].t <= MAX_RUN_MS
      && Math.abs(prev.e - frozen) / frozen > FAR
      && Math.abs(next.e - frozen) / frozen > FAR
      && Math.abs(next.e - prev.e) / prev.e < FAR;
    if (pureSpike) for (const row of run) doomed.push({ profile: acct.id, row, prev, next });
    i = j;
  }
}

for (const d of doomed) {
  console.log(`${d.profile.padEnd(22)} ${iso(d.row.t)}  ${d.prev.e.toFixed(2)} → ${d.row.e.toFixed(2)} → ${d.next.e.toFixed(2)}`);
}
const byProfile = new Map<string, number>();
for (const d of doomed) byProfile.set(d.profile, (byProfile.get(d.profile) ?? 0) + 1);
console.log(`${doomed.length} spike row(s): ${[...byProfile].map(([p, n]) => `${p}=${n}`).join(", ") || "none"}`);

if (apply && doomed.length > 0) {
  mkdirSync("data/backups", { recursive: true });
  const backup = `data/backups/pre-boot-snapshot-cleanup-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.db`;
  db.run(`VACUUM INTO '${backup}'`);
  console.log(`backup: ${backup}`);
  const del = db.prepare("DELETE FROM equity_snapshots WHERE id = ?");
  const tx = db.transaction(() => { let n = 0; for (const d of doomed) n += del.run(d.row.id).changes; return n; });
  console.log(`deleted ${tx()} row(s)`);
} else if (!apply) {
  console.log("(list only — pass --apply to back up and delete)");
}
