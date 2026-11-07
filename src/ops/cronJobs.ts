// ══════════════════════════════════════════════
// Cron dead-man's switch — "did every scheduled job succeed when it should?"
// ══════════════════════════════════════════════
//
// Audit F-2 (2026-11-07): every cron job wrote only its own logs/*.log, which
// nobody reads. The off-host backup went to the wrong machine and the AI
// quorum failed for over a day with no page. Now each cron wrapper
// (scripts/lib/cron-job.sh) writes data/cron-markers/<job>.ok (epoch seconds,
// atomic) when it succeeds, and this module says which jobs are overdue.
// Two readers:
//   • scripts/guardian.ts (G7) pages OPS once per stale job per episode;
//   • /healthz exposes only the COUNT (`stale_jobs`), which
//     scripts/uptime-watch.sh, running OUTSIDE prod, pages on, so a guardian
//     that itself stopped running is still noticed.
//
// Schedules are cron's: HOST-LOCAL time (CRON_TZ overrides). A job is stale
// when its most recent scheduled run, plus its grace, is past and no success
// marker was written after that run started. Tracking starts at
// data/cron-markers/.since (written by the first wrapper run or by
// install-cron.sh): a run scheduled before tracking began is not judged, so
// a fresh deploy does not page for jobs that simply have not run yet. No
// .since means "not initialised": nothing is stale.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CronJobSpec {
  /** Marker name: data/cron-markers/<name>.ok */
  name: string;
  /** Host-local minute of the run. */
  minute: number;
  /** Host-local hours; omitted = every hour. */
  hours?: number[];
  /** Host-local weekdays (0 = Sunday); omitted = every day. */
  days?: number[];
  /** Minutes after the scheduled start by which a success marker must exist. */
  graceMin: number;
}

/** Mirrors scripts/install-cron.sh (scripts/cronJobs.schedule.test.ts keeps them identical). */
export const CRON_JOBS: readonly CronJobSpec[] = [
  { name: "backup-db", minute: 30, hours: [4], graceMin: 120 },
  // Full refresh at 04:00. Its stock step is the live money path (the portfolio
  // engines read historical.db) and has its own marker, written by the 04:00
  // run or by the 06:00/08:30 stock-only retries, so it is due only after them.
  { name: "refresh-historical", minute: 0, hours: [4], graceMin: 150 },
  { name: "refresh-stocks", minute: 0, hours: [4], graceMin: 300 },
  { name: "parity-check", minute: 45, hours: [4], days: [2, 3, 4, 5, 6], graceMin: 120 },
  { name: "ai-quorum-stocks", minute: 15, hours: [16], days: [1, 2, 3, 4, 5], graceMin: 120 },
  { name: "ai-quorum-crypto", minute: 15, hours: [19], graceMin: 120 },
  { name: "guardian", minute: 20, graceMin: 90 },
  { name: "restore-drill", minute: 15, hours: [5], days: [0], graceMin: 180 },
];

export const CRON_MARKER_DIR = "data/cron-markers";

/** A marker written up to this long before the scheduled start still counts (clock skew). */
const SLACK_MS = 60_000;

export interface CronJobStatus {
  name: string;
  /** Last success (ms) or null when the job never wrote a marker. */
  lastOkMs: number | null;
  /** Most recent scheduled start whose grace has elapsed (ms), or null. */
  dueRunMs: number | null;
  stale: boolean;
}

function localParts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd };
}

/** UTC instant of a host-local wall-clock time (two-pass offset correction). */
function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - guess;
    guess = wall - offset;
  }
  return guess;
}

/** Most recent scheduled start s with s + grace <= now (searched over 9 days). */
export function lastDueRun(spec: CronJobSpec, now: number, tz: string): number | null {
  const graceMs = spec.graceMin * 60_000;
  const hours = spec.hours ?? Array.from({ length: 24 }, (_, i) => i);
  let best: number | null = null;
  for (let back = 0; back <= 9; back++) {
    const day = localParts(now - back * 86_400_000, tz);
    if (spec.days && !spec.days.includes(day.wd)) continue;
    for (const h of hours) {
      const s = localToUtc(day.y, day.mo, day.d, h, spec.minute, tz);
      if (s + graceMs <= now && (best === null || s > best)) best = s;
    }
    if (best !== null) break; // nothing on an earlier day can be later
  }
  return best;
}

function readMarkerMs(path: string): number | null {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    if (Number.isFinite(n) && n > 0) return n * 1000;
  } catch { return null; }
  try { return statSync(path).mtimeMs; } catch { return null; }
}

export function hostTimeZone(): string {
  return process.env.CRON_TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Status of every job; never throws (an unreadable dir reads as "not initialised"). */
export function cronJobStatuses(opts: { dir?: string; now?: number; tz?: string; jobs?: readonly CronJobSpec[] } = {}): CronJobStatus[] {
  const dir = opts.dir ?? CRON_MARKER_DIR;
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? hostTimeZone();
  const since = readMarkerMs(join(dir, ".since"));
  return (opts.jobs ?? CRON_JOBS).map((spec) => {
    const lastOkMs = readMarkerMs(join(dir, `${spec.name}.ok`));
    const dueRunMs = lastDueRun(spec, now, tz);
    const stale = since !== null && dueRunMs !== null && dueRunMs >= since &&
      (lastOkMs === null || lastOkMs < dueRunMs - SLACK_MS);
    return { name: spec.name, lastOkMs, dueRunMs, stale };
  });
}

/** Number of overdue jobs — the only figure /healthz publishes. */
export function staleCronJobCount(opts: Parameters<typeof cronJobStatuses>[0] = {}): number {
  try { return cronJobStatuses(opts).filter((s) => s.stale).length; } catch { return 0; }
}
