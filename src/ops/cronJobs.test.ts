import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRON_JOBS, cronJobStatuses, lastDueRun, staleCronJobCount, type CronJobSpec } from "./cronJobs";

const TZ = "Etc/GMT+5"; // a fixed UTC−5 host clock, no DST
const local = (iso: string) => Date.parse(`${iso}-05:00`);
const spec = (name: string) => CRON_JOBS.find(j => j.name === name)!;

function withDir<T>(fn: (dir: string, write: (name: string, ms: number) => void) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cron-markers-"));
  try {
    return fn(dir, (name, ms) => writeFileSync(join(dir, name), `${Math.floor(ms / 1000)}\n`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("lastDueRun — host-local schedule + grace", () => {
  test("daily backup 04:30 + 2h: before 06:30 the due run is yesterday's, after it today's", () => {
    expect(lastDueRun(spec("backup-db"), local("2026-11-07T06:29:00"), TZ)).toBe(local("2026-11-06T04:30:00"));
    expect(lastDueRun(spec("backup-db"), local("2026-11-07T06:30:00"), TZ)).toBe(local("2026-11-07T04:30:00"));
  });

  test("parity Tue–Sat: on Monday the due run is still Saturday's", () => {
    // 2026-11-09 is a Monday
    expect(lastDueRun(spec("parity-check"), local("2026-11-09T12:00:00"), TZ)).toBe(local("2026-11-07T04:45:00"));
    expect(lastDueRun(spec("parity-check"), local("2026-11-10T07:00:00"), TZ)).toBe(local("2026-11-10T04:45:00"));
  });

  test("hourly guardian :20 + 90 min", () => {
    expect(lastDueRun(spec("guardian"), local("2026-11-07T12:00:00"), TZ)).toBe(local("2026-11-07T10:20:00"));
  });

  test("weekly restore drill (Sunday 05:15 + 3h)", () => {
    // 2026-11-08 is a Sunday
    expect(lastDueRun(spec("restore-drill"), local("2026-11-08T08:00:00"), TZ)).toBe(local("2026-11-01T05:15:00"));
    expect(lastDueRun(spec("restore-drill"), local("2026-11-08T08:15:00"), TZ)).toBe(local("2026-11-08T05:15:00"));
  });

  test("a DST zone resolves wall-clock times correctly on both sides of the switch", () => {
    const j: CronJobSpec = { name: "x", minute: 0, hours: [4], graceMin: 0 };
    // America/New_York: EDT (UTC−4) until 2026-11-01 02:00, EST (UTC−5) after.
    expect(lastDueRun(j, Date.parse("2026-10-31T12:00:00Z"), "America/New_York")).toBe(Date.parse("2026-10-31T08:00:00Z"));
    expect(lastDueRun(j, Date.parse("2026-11-02T12:00:00Z"), "America/New_York")).toBe(Date.parse("2026-11-02T09:00:00Z"));
  });
});

describe("cronJobStatuses — stale only after tracking started and the due run had no success", () => {
  const now = local("2026-11-07T12:00:00");

  test("no .since ⇒ not initialised ⇒ nothing stale (a fresh deploy never pages)", () => withDir((dir) => {
    expect(cronJobStatuses({ dir, now, tz: TZ }).some(s => s.stale)).toBe(false);
    expect(staleCronJobCount({ dir, now, tz: TZ })).toBe(0);
  }));

  test("a missing directory reads as not initialised", () => {
    expect(staleCronJobCount({ dir: "/nonexistent/cron-markers", now, tz: TZ })).toBe(0);
  });

  test("a run scheduled before .since is not judged; one after it is", () => withDir((dir, write) => {
    write(".since", local("2026-11-07T05:00:00")); // after today's 04:30 backup, before the 10:20 guardian run
    const s = Object.fromEntries(cronJobStatuses({ dir, now, tz: TZ }).map(x => [x.name, x.stale]));
    expect(s["backup-db"]).toBe(false);   // due run 04:30 < since
    expect(s["guardian"]).toBe(true);     // due run 10:20 ≥ since, no marker
  }));

  test("fresh markers ⇒ 0 stale; a marker older than the due run ⇒ stale", () => withDir((dir, write) => {
    write(".since", local("2026-10-01T00:00:00"));
    const fresh: Record<string, number> = {
      "backup-db": local("2026-11-07T04:31:00"), "refresh-historical": local("2026-11-07T04:03:00"),
      "refresh-stocks": local("2026-11-07T06:02:00"), "parity-check": local("2026-11-07T04:46:00"),
      "ai-quorum-stocks": local("2026-11-06T16:16:00"), "ai-quorum-crypto": local("2026-11-06T19:16:00"),
      guardian: local("2026-11-07T11:20:30"), "restore-drill": local("2026-11-01T05:16:00"),
    };
    for (const [k, v] of Object.entries(fresh)) write(`${k}.ok`, v);
    expect(cronJobStatuses({ dir, now, tz: TZ }).filter(s => s.stale).map(s => s.name)).toEqual([]);
    write("backup-db.ok", local("2026-11-06T04:31:00")); // yesterday's: today's 04:30 run never succeeded
    expect(cronJobStatuses({ dir, now, tz: TZ }).filter(s => s.stale).map(s => s.name)).toEqual(["backup-db"]);
    expect(staleCronJobCount({ dir, now, tz: TZ })).toBe(1);
  }));

  test("a garbage marker falls back to its mtime, never throws", () => withDir((dir) => {
    writeFileSync(join(dir, ".since"), "1\n");
    writeFileSync(join(dir, "guardian.ok"), "banana");
    expect(() => cronJobStatuses({ dir, tz: TZ })).not.toThrow();
  }));
});
