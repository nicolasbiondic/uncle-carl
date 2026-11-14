import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nyClock, nyInstant, sessionsBetween } from "./calendar";
import { checkSchedule, markSession, readState, type StateFile, MAX_ATTEMPTS } from "./schedule";

const Z = (iso: string) => Date.parse(iso);
const none: StateFile = { sessions: {} };

describe("New York clock", () => {
  test("winter (EST, UTC−5) and summer (EDT, UTC−4)", () => {
    expect(nyClock(Z("2026-11-16T13:15:00Z"))).toEqual({ date: "2026-11-16", minutes: 8 * 60 + 15 });
    expect(nyClock(Z("2026-07-15T12:15:00Z"))).toEqual({ date: "2026-07-15", minutes: 8 * 60 + 15 });
    expect(nyClock(Z("2026-11-16T03:00:00Z")).date).toBe("2026-11-15"); // still the evening before in New York
  });
  test("a New York wall time back to an instant, in both seasons and on the changeover days", () => {
    expect(new Date(nyInstant("2026-11-16", 9, 25)).toISOString()).toBe("2026-11-16T14:25:00.000Z");
    expect(new Date(nyInstant("2026-07-15", 9, 25)).toISOString()).toBe("2026-07-15T13:25:00.000Z");
    expect(new Date(nyInstant("2026-11-02", 8, 0)).toISOString()).toBe("2026-11-02T13:00:00.000Z"); // the Monday after the clocks went back
    expect(new Date(nyInstant("2026-03-09", 8, 0)).toISOString()).toBe("2026-03-09T12:00:00.000Z"); // the Monday after they went forward
  });
});

describe("sessions between (the repo's calendar)", () => {
  test("counts NYSE sessions after `from` up to and including `to`", () => {
    expect(sessionsBetween("2026-11-16", "2026-11-16")).toBe(0);
    expect(sessionsBetween("2026-11-16", "2026-11-23")).toBe(5);
    expect(sessionsBetween("2026-11-16", "2026-11-24")).toBe(6);
    expect(sessionsBetween("2026-11-13", "2026-11-16")).toBe(1); // Friday → Monday
  });
  test("a holiday is not a session (Thanksgiving)", () => {
    expect(sessionsBetween("2026-11-25", "2026-11-30")).toBe(2); // Fri 27 and Mon 30
  });
});

describe("schedule guard", () => {
  test("winter: 07:15 New York is too early, 08:15 runs, 09:19 runs, 09:20 is too late", () => {
    expect(checkSchedule(Z("2026-11-16T12:15:00Z"), none)).toMatchObject({ go: false, reason: "before_window" });
    expect(checkSchedule(Z("2026-11-16T13:00:00Z"), none)).toMatchObject({ go: true, session: "2026-11-16" });
    expect(checkSchedule(Z("2026-11-16T13:15:00Z"), none)).toMatchObject({ go: true });
    expect(checkSchedule(Z("2026-11-16T14:19:59Z"), none)).toMatchObject({ go: true });
    expect(checkSchedule(Z("2026-11-16T14:20:00Z"), none)).toMatchObject({ go: false, reason: "after_window" });
  });
  test("summer: the same cron hours land an hour later in New York and the window still decides", () => {
    // Lima has no daylight saving: 07:15 Lima = 12:15Z, 08:15 Lima = 13:15Z, all year.
    const early = checkSchedule(Z("2026-07-15T12:15:00Z"), none);  // 08:15 EDT
    const late = checkSchedule(Z("2026-07-15T13:15:00Z"), none);   // 09:15 EDT
    expect(early).toMatchObject({ go: true, session: "2026-07-15" });
    expect(late).toMatchObject({ go: true }); // inside the window when nothing ran yet
    expect(checkSchedule(Z("2026-07-15T13:20:00Z"), none)).toMatchObject({ go: false, reason: "after_window" }); // 09:20 EDT
    expect(checkSchedule(Z("2026-07-15T11:59:00Z"), none)).toMatchObject({ go: false, reason: "before_window" }); // 07:59 EDT
  });
  test("a weekend and a holiday are not sessions", () => {
    expect(checkSchedule(Z("2026-11-14T13:15:00Z"), none)).toMatchObject({ go: false, reason: "not_a_session" }); // Saturday
    expect(checkSchedule(Z("2026-11-26T13:15:00Z"), none)).toMatchObject({ go: false, reason: "not_a_session" }); // Thanksgiving
    expect(checkSchedule(Z("2026-07-03T12:15:00Z"), none)).toMatchObject({ go: false, reason: "not_a_session" }); // July 4th observed
  });
  test("the deadline is 09:25 New York of that session, in winter and in summer", () => {
    const w = checkSchedule(Z("2026-11-16T13:15:00Z"), none);
    const s = checkSchedule(Z("2026-07-15T12:15:00Z"), none);
    expect(w.go && new Date(w.deadlineMs).toISOString()).toBe("2026-11-16T14:25:00.000Z");
    expect(s.go && new Date(s.deadlineMs).toISOString()).toBe("2026-07-15T13:25:00.000Z");
  });
  test("a shipped decision closes the session; the next session is free", () => {
    const st: StateFile = { sessions: { "2026-11-16": { status: "shipped", at: "x", attempts: 1 } } };
    expect(checkSchedule(Z("2026-11-16T13:45:00Z"), st)).toMatchObject({ go: false, reason: "already_done" });
    expect(checkSchedule(Z("2026-11-17T13:15:00Z"), st)).toMatchObject({ go: true, attempt: 1 });
  });
  test(`a failed run, or one without a decision, gets ONE retry while the window is open (${MAX_ATTEMPTS} attempts), then the session closes`, () => {
    expect(checkSchedule(Z("2026-11-16T13:15:00Z"), { sessions: {} })).toMatchObject({ go: true, attempt: 1 });
    for (const status of ["no_decision", "failed"] as const) {
      // 08:45 New York: the retry line
      expect(checkSchedule(Z("2026-11-16T13:45:00Z"), { sessions: { "2026-11-16": { status, at: "x", attempts: 1 } } })).toMatchObject({ go: true, attempt: 2 });
      // a state file written before `attempts` existed counts as one attempt
      expect(checkSchedule(Z("2026-11-16T13:45:00Z"), { sessions: { "2026-11-16": { status, at: "x" } } })).toMatchObject({ go: true, attempt: 2 });
      // the retry failed too: closed (summer's 09:15 line, or any later tick, does nothing)
      expect(checkSchedule(Z("2026-11-16T14:15:00Z"), { sessions: { "2026-11-16": { status, at: "x", attempts: 2 } } })).toMatchObject({ go: false, reason: "already_done" });
      // the retry never starts outside the window
      expect(checkSchedule(Z("2026-11-16T14:20:00Z"), { sessions: { "2026-11-16": { status, at: "x", attempts: 1 } } })).toMatchObject({ go: false, reason: "after_window" });
    }
  });
  test("summer double fire: the 09:15 line finds the 08:15 run done and does nothing", () => {
    const st: StateFile = { sessions: { "2026-07-15": { status: "shipped", at: "x" } } };
    expect(checkSchedule(Z("2026-07-15T13:15:00Z"), st)).toMatchObject({ go: false, reason: "already_done" });
  });
  test("a run that only `started` (the machine died) may run again as the same attempt while the window is open", () => {
    const st: StateFile = { sessions: { "2026-11-16": { status: "started", at: "x" } } };
    expect(checkSchedule(Z("2026-11-16T13:15:00Z"), st)).toMatchObject({ go: true, attempt: 1 });
    expect(checkSchedule(Z("2026-11-16T13:45:00Z"), { sessions: { "2026-11-16": { status: "started", at: "x", attempts: 2 } } })).toMatchObject({ go: true, attempt: 2 });
  });
});

describe("state file", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ai-review-state-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  test("round trip, a damaged file starts clean, and old sessions are trimmed", () => {
    const p = join(dir, "sub", "state.json");
    expect(readState(p)).toEqual({ sessions: {} });
    markSession(p, "2026-11-16", { status: "shipped", at: "t", detail: "abc" });
    expect(readState(p).sessions["2026-11-16"]).toEqual({ status: "shipped", at: "t", detail: "abc" });
    for (let i = 0; i < 50; i++) markSession(p, `2027-01-${String(i + 1).padStart(2, "0")}x`, { status: "failed", at: "t" });
    expect(Object.keys(readState(p).sessions).length).toBeLessThanOrEqual(40);
    Bun.write(p, "{ not json");
    expect(readState(p)).toEqual({ sessions: {} });
  });
});
