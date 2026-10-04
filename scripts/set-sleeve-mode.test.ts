// ══════════════════════════════════════════════
// set-sleeve-mode.ts — guardrail unit tests
// ══════════════════════════════════════════════
//
// Exercises the exported pure/DB functions directly (no subprocess spawn,
// no stdin prompt) against a fresh in-memory DB — same pattern as
// SleeveGovernor.test.ts. Interactive confirmation (readline) and argv
// parsing for the CLI entrypoint are deliberately out of scope here; the
// guardrails that actually protect state (sleeve validation, non-empty
// reason, idempotency, persistence readable by SleeveGovernor) are not.

import { describe, test, expect, beforeEach } from "bun:test";
import { getDB, getActivityLog } from "../src/db/database";
import { makeTestDb } from "../src/test-support/db";
import { SleeveGovernor } from "../src/governor/SleeveGovernor";
import { ALL_PROFILE_IDS } from "../src/config/riskProfiles";
import { validateSleeve, applyModeChange, getStatusRows, parseArgs } from "./set-sleeve-mode";

beforeEach(() => {
  makeTestDb();
});

describe("validateSleeve", () => {
  test("accepts every ALL_PROFILE_IDS entry", () => {
    for (const id of ALL_PROFILE_IDS) expect(validateSleeve(id)).toBe(true);
  });

  test("rejects an unknown sleeve", () => {
    expect(validateSleeve("momentum_bogus")).toBe(false);
    expect(validateSleeve("")).toBe(false);
  });
});

describe("applyModeChange — guardrails", () => {
  test("nonexistent sleeve is refused, nothing written", () => {
    const result = applyModeChange("momentum_bogus", "shadow", "test reason");
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/unknown sleeve/);
    // No row was ever written for any sleeve — not just the bogus one.
    expect(getStatusRows().every((r) => r.mode === "unregistered")).toBe(true);
  });

  test("empty/whitespace reason is refused, nothing written", () => {
    for (const bad of ["", "   ", undefined as unknown as string]) {
      const result = applyModeChange("momentum_stocks", "shadow", bad);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/--reason/);
    }
    const row = getStatusRows().find((r) => r.sleeve === "momentum_stocks")!;
    expect(row.mode).toBe("unregistered");
  });

  test("idempotent: already in the target mode is a no-op, not a re-write", () => {
    const first = applyModeChange("momentum_stocks", "shadow", "initial demotion — evidence-based");
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);

    const before = getDB().prepare(`SELECT updated_at, reason FROM sleeve_modes WHERE sleeve = 'momentum_stocks'`).get() as any;

    const second = applyModeChange("momentum_stocks", "shadow", "trying again, should be a no-op");
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.previousMode).toBe("shadow");

    const after = getDB().prepare(`SELECT updated_at, reason FROM sleeve_modes WHERE sleeve = 'momentum_stocks'`).get() as any;
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.reason).toBe(before.reason); // second call's reason was NEVER written
  });

  test("a real change persists and is readable by a fresh SleeveGovernor instance", () => {
    const result = applyModeChange(
      "momentum_stocks",
      "shadow",
      "−$4.806/30d, WR 38%, avg loser $1.103 vs avg winner $237; backtest +7.6% vs SPY +43%",
    );
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.previousMode).toBeNull(); // never registered before

    const gov = new SleeveGovernor({ cacheMs: 0 });
    expect(gov.getMode("momentum_stocks")).toBe("shadow");

    // Also readable via the raw persisted row (what the dashboard/other
    // processes would see).
    const row = getDB().prepare(`SELECT mode, reason FROM sleeve_modes WHERE sleeve = 'momentum_stocks'`).get() as any;
    expect(row.mode).toBe("shadow");
    expect(row.reason).toContain("−$4.806/30d");
  });

  test("records an auditable activity_log row on a real change", () => {
    applyModeChange("momentum_stocks", "shadow", "demote for evidence");
    const activity = getActivityLog(10, "circuit", "momentum_stocks");
    expect(activity.some((a: any) => a.message.includes("MANUAL MODE CHANGE") && a.message.includes("shadow"))).toBe(true);
  });

  test("does NOT write an activity_log row when idempotent (no-op)", () => {
    applyModeChange("momentum_stocks", "shadow", "first");
    const before = getActivityLog(50, "circuit", "momentum_stocks").length;
    applyModeChange("momentum_stocks", "shadow", "second, no-op");
    const after = getActivityLog(50, "circuit", "momentum_stocks").length;
    expect(after).toBe(before);
  });
});

describe("getStatusRows", () => {
  test("every ALL_PROFILE_IDS sleeve appears, unregistered ones say so", () => {
    const rows = getStatusRows();
    expect(rows.map((r) => r.sleeve)).toEqual(ALL_PROFILE_IDS);
    for (const r of rows) expect(r.mode).toBe("unregistered");
  });

  test("a changed sleeve reflects its persisted mode and reason", () => {
    applyModeChange("meanrev_stocks", "shadow", "why not");
    const row = getStatusRows().find((r) => r.sleeve === "meanrev_stocks")!;
    expect(row.mode).toBe("shadow");
    expect(row.reason).toBe("why not");
    expect(row.updatedAt).not.toBeNull();
  });
});

describe("parseArgs", () => {
  test("no args → empty positional (status mode)", () => {
    const parsed = parseArgs([]);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) expect(parsed.positional).toEqual([]);
  });

  test("sleeve + mode + --reason + --yes", () => {
    const parsed = parseArgs(["momentum_stocks", "shadow", "--reason", "bad WR", "--yes"]);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.positional).toEqual(["momentum_stocks", "shadow"]);
      expect(parsed.reason).toBe("bad WR");
      expect(parsed.yes).toBe(true);
    }
  });

  test("--reason=value form", () => {
    const parsed = parseArgs(["momentum_stocks", "live", "--reason=promote"]);
    if (!("error" in parsed)) expect(parsed.reason).toBe("promote");
  });

  test("unknown flag is a hard error", () => {
    const parsed = parseArgs(["momentum_stocks", "shadow", "--forcce"]);
    expect("error" in parsed).toBe(true);
  });
});
