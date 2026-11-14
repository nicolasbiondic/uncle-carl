// When the review may run: only on a NYSE session, from 08:00 until 09:20 New York time, once per session,
// with a hard deadline at 09:25 (pre-registration §3, stage A). The dev crontab is in Lima time, which has no
// daylight saving, so cron fires at fixed Lima hours (07:15, 07:45, 08:15 and 08:45 on weekdays) and THIS
// decides by New York time: in winter 08:15 Lima is 08:15 New York (the run) and 08:45 its retry; in summer
// 07:15 Lima is 08:15 New York (the run), 07:45 its retry, and the later lines find the session done.
// A session whose run shipped is closed. One that FAILED or reached no decision (an ssh hiccup, two models
// down) gets ONE more attempt while the window is open (MAX_ATTEMPTS): without it a transient failure at
// 08:15 meant no review at all that day.
// Enforced: src/ai-review/schedule.test.ts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isTradingDay, nyClock, nyInstant } from "./calendar";

export const WINDOW_START_MIN = 8 * 60;       // 08:00 New York
export const LAST_START_MIN = 9 * 60 + 20;    // no new run starts at or after 09:20
export const DEADLINE_HM = { h: 9, m: 25 };   // what is valid by then ships; nothing new starts

/** Attempts per session: the run and one retry after a failure or a run without a decision. */
export const MAX_ATTEMPTS = 2;

export type RunStatus = "started" | "shipped" | "no_decision" | "failed";
/** `attempts` absent = 1 (state files written before the retry existed). */
export interface SessionState { status: RunStatus; at: string; detail?: string; attempts?: number }
export interface StateFile { sessions: Record<string, SessionState> }

export type ScheduleVerdict =
  | { go: true; session: string; deadlineMs: number; attempt: number }
  | { go: false; reason: "not_a_session" | "before_window" | "after_window" | "already_done"; session: string };

export function readState(path: string): StateFile {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (j && typeof j === "object" && j.sessions && typeof j.sessions === "object") return j as StateFile;
  } catch { /* first run or a damaged file: start clean, the worst case is one repeated run */ }
  return { sessions: {} };
}

export function writeState(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const keep = Object.keys(state.sessions).sort().slice(-40);
  const trimmed: StateFile = { sessions: Object.fromEntries(keep.map(k => [k, state.sessions[k]])) };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2) + "\n");
  renameSync(tmp, path);
}

export function markSession(path: string, session: string, s: SessionState): void {
  const st = readState(path);
  st.sessions[session] = s;
  writeState(path, st);
}

/**
 * A shipped decision closes the session. A failed attempt, or one that reached no decision, leaves room for
 * ONE retry (MAX_ATTEMPTS) while the window is open. A run that was only `started` and left no result (the
 * machine died mid-run) may run again as the same attempt.
 */
export function checkSchedule(nowMs: number, state: StateFile): ScheduleVerdict {
  const { date, minutes } = nyClock(nowMs);
  if (!isTradingDay(date)) return { go: false, reason: "not_a_session", session: date };
  if (minutes < WINDOW_START_MIN) return { go: false, reason: "before_window", session: date };
  if (minutes >= LAST_START_MIN) return { go: false, reason: "after_window", session: date };
  const prev = state.sessions[date];
  const made = prev ? Math.max(1, prev.attempts ?? 1) : 0;
  if (prev && prev.status === "shipped") return { go: false, reason: "already_done", session: date };
  if (prev && prev.status !== "started" && made >= MAX_ATTEMPTS) return { go: false, reason: "already_done", session: date };
  const attempt = prev && prev.status === "started" ? made : made + 1;
  return { go: true, session: date, deadlineMs: nyInstant(date, DEADLINE_HM.h, DEADLINE_HM.m), attempt };
}
