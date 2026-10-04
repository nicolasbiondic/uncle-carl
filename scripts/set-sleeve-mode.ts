#!/usr/bin/env bun
// ══════════════════════════════════════════════
// set-sleeve-mode.ts — operate SleeveGovernor.setMode() safely (2026-08-06)
// ══════════════════════════════════════════════
//
// Motivation: SleeveGovernor.setMode(sleeve, mode, reason) exists and
// persists in `sleeve_modes`, but there was NO tool to drive it — the only
// alternative was raw SQL against a running production DB, with no
// validation, no audit trail, and no visibility into what a demotion/
// promotion actually does to open positions. This script is that tool.
//
// What demotion/promotion does NOT do (SwitchingAdapter.ts, verified there):
//   - closePosition ALWAYS routes to the REAL broker when a live DB row for
//     that sleeve/symbol exists — "never strand a real position after a
//     demotion".
//   - getOpenPositions ALWAYS returns real rows (plus shadow rows only when
//     mode=shadow) — a demoted engine keeps managing residual real
//     positions to exit while opening only simulated ones from now on.
//   - The 15s stop-loss loop and ensureAlpacaNativeStops work off DB rows,
//     independent of the governor — a demotion does not touch protection.
//
// Guardrails (all enforced, not just documented):
//   (a) sleeve must be one of ALL_PROFILE_IDS.
//   (b) --reason "<why>" is required, non-empty — persisted in sleeve_modes
//       AND activity_log (insertActivity), so the change is auditable from
//       either the DB row or the dashboard's activity feed.
//   (c) before writing, prints how many REAL open positions this sleeve
//       currently has and reminds the operator they keep being managed by
//       the real broker regardless of the new mode.
//   (d) interactive y/N confirmation unless --yes (for automation/CI).
//   (e) idempotent — already-in-target-mode is a no-op that says so.
//   Promoting to "live" additionally prints a loud warning: SleeveGovernor
//   itself NEVER promotes automatically (shadow books have no hard-SL
//   simulation, so a human must review) — this CLI is exactly that manual
//   override, and it must look like one.
//
// Usage:
//   bun run scripts/set-sleeve-mode.ts                                  # show status of every sleeve
//   bun run scripts/set-sleeve-mode.ts <sleeve> <live|shadow> --reason "why" [--yes]

import { createInterface } from "node:readline/promises";
import { initDatabase, getDB, getOpenTrades, insertActivity } from "../src/db/database";
import { ALL_PROFILE_IDS } from "../src/config/riskProfiles";
import { SleeveGovernor, type SleeveMode } from "../src/governor/SleeveGovernor";

const KNOWN_SLEEVES: readonly string[] = ALL_PROFILE_IDS;

export function validateSleeve(sleeve: string): boolean {
  return KNOWN_SLEEVES.includes(sleeve);
}

// SleeveGovernor's constructor is what creates the `sleeve_modes` table
// (CREATE TABLE IF NOT EXISTS) — a live bot always instantiates one before
// this script ever runs, but this script must not assume that (a fresh DB
// has no table yet). NOT cached as a module singleton: getDB() can point at
// a different underlying Database across test runs (fresh :memory: per
// test), so a stale cached instance would skip table creation against the
// new handle. The constructor is cheap (a couple of CREATE TABLE IF NOT
// EXISTS statements) — construct fresh every time.
function gov(): SleeveGovernor {
  return new SleeveGovernor();
}

export interface StatusRow {
  sleeve: string;
  mode: SleeveMode | "unregistered";
  reason: string | null;
  updatedAt: number | null;
}

/** Merges ALL_PROFILE_IDS with whatever sleeve_modes rows exist — a sleeve
 *  with no row yet (never registered by a running bot) is NOT "live" by
 *  assumption, it's explicitly "unregistered". */
export function getStatusRows(): StatusRow[] {
  const bySleeve = new Map(gov().getModes().map((m) => [m.sleeve, m]));
  return ALL_PROFILE_IDS.map((id) => {
    const m = bySleeve.get(id);
    return m
      ? { sleeve: id, mode: m.mode, reason: m.reason, updatedAt: m.updatedAt }
      : { sleeve: id, mode: "unregistered" as const, reason: null, updatedAt: null };
  });
}

function fmtTime(t: number | null): string {
  return t ? new Date(t).toISOString() : "—";
}

function printStatus(): void {
  console.log("\n▌ sleeve modes");
  for (const row of getStatusRows()) {
    console.log(
      `  ${row.sleeve.padEnd(22)} ${row.mode.padEnd(13)} updated=${fmtTime(row.updatedAt)}  reason=${row.reason ?? "—"}`,
    );
  }
  console.log("");
}

export interface ModeChangeResult {
  ok: boolean;
  changed: boolean;
  reason?: string; // error reason when ok=false
  previousMode: SleeveMode | null;
}

/** Current persisted mode, straight from the table — deliberately NOT
 *  SleeveGovernor.getMode(), whose fallback depends on register() having
 *  been called in THIS process (it hasn't; the bot process did that). A
 *  missing row means "never registered", not "live". */
function currentPersistedMode(sleeve: string): SleeveMode | null {
  gov(); // ensure sleeve_modes exists
  const row = getDB().prepare(`SELECT mode FROM sleeve_modes WHERE sleeve = ?`).get(sleeve) as
    | { mode: SleeveMode }
    | undefined;
  return row?.mode ?? null;
}

/** Guardrails (a) sleeve exists, (b) reason non-empty, (e) idempotent — then
 *  writes sleeve_modes (via SleeveGovernor.setMode, the existing persisted
 *  path) AND an auditable activity_log row. Pure of any interactive I/O so
 *  it's directly unit-testable. */
export function applyModeChange(sleeve: string, mode: SleeveMode, reasonText: string): ModeChangeResult {
  if (!validateSleeve(sleeve)) {
    return {
      ok: false,
      changed: false,
      previousMode: null,
      reason: `unknown sleeve "${sleeve}" — expected one of: ${ALL_PROFILE_IDS.join(", ")}`,
    };
  }
  const reason = reasonText?.trim() ?? "";
  if (!reason) {
    return { ok: false, changed: false, previousMode: null, reason: `--reason "<why>" is required and must not be empty` };
  }

  const previousMode = currentPersistedMode(sleeve);
  if (previousMode === mode) {
    return { ok: true, changed: false, previousMode };
  }

  gov().setMode(sleeve, mode, reason);
  insertActivity(
    sleeve,
    "circuit",
    `MANUAL MODE CHANGE via set-sleeve-mode.ts: ${previousMode ?? "unregistered"} → ${mode} — ${reason}`,
  );
  return { ok: true, changed: true, previousMode };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

interface ParsedArgs {
  positional: string[];
  reason?: string;
  yes: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const positional: string[] = [];
  let reason: string | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes") { yes = true; continue; }
    if (a === "--reason") { reason = argv[++i]; continue; }
    if (a.startsWith("--reason=")) { reason = a.slice("--reason=".length); continue; }
    if (a.startsWith("--")) return { error: `unknown flag "${a}"` };
    positional.push(a);
  }
  return { positional, reason, yes };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`✗ ${parsed.error}`);
    process.exit(2);
  }

  initDatabase("./data/trading.db");

  if (parsed.positional.length === 0) {
    printStatus();
    return;
  }

  if (parsed.positional.length !== 2) {
    console.error(`Usage: bun run scripts/set-sleeve-mode.ts <sleeve> <live|shadow> --reason "why" [--yes]`);
    console.error(`       bun run scripts/set-sleeve-mode.ts                                  # show status`);
    process.exit(2);
  }

  const [sleeve, modeArg] = parsed.positional as [string, string];
  if (modeArg !== "live" && modeArg !== "shadow") {
    console.error(`✗ mode must be "live" or "shadow", got "${modeArg}"`);
    process.exit(2);
  }
  const mode = modeArg as SleeveMode;

  if (!validateSleeve(sleeve)) {
    console.error(`✗ unknown sleeve "${sleeve}" — expected one of: ${ALL_PROFILE_IDS.join(", ")}`);
    process.exit(2);
  }
  if (!parsed.reason || !parsed.reason.trim()) {
    console.error(`✗ --reason "<why>" is required (persisted in sleeve_modes + activity_log)`);
    process.exit(2);
  }
  const reason = parsed.reason.trim();

  const previousMode = currentPersistedMode(sleeve);
  if (previousMode === mode) {
    console.log(`= ${sleeve} is already in "${mode}" mode — nothing to do.`);
    printStatus();
    return;
  }

  const openCount = getOpenTrades(sleeve).length;
  console.log(`\n▌ ${sleeve}: ${previousMode ?? "unregistered (defaults on next boot)"} → ${mode}`);
  console.log(`  Open REAL positions right now: ${openCount}`);
  if (openCount > 0) {
    console.log(`  These ${openCount} position(s) are NOT affected by this mode change: SwitchingAdapter`);
    console.log(`  always routes closePosition() for an existing real row to the REAL broker and`);
    console.log(`  keeps returning it from getOpenPositions() regardless of live/shadow mode — the`);
    console.log(`  15s stop-loss loop and ensureAlpacaNativeStops also work off DB rows, independent`);
    console.log(`  of the governor. Only NEW opens route through the "${mode}" book from now on.`);
  }
  if (mode === "live") {
    console.log(`\n  ⚠️  PROMOTING TO LIVE — this is a MANUAL override of the evidence gate.`);
    console.log(`  SleeveGovernor never promotes automatically: a positive shadow run only ever`);
    console.log(`  emits RECOMMEND_PROMOTE for a human to review, because ShadowAdapter does not`);
    console.log(`  simulate a hard stop-loss and its book is therefore NOT live-equivalent evidence.`);
    console.log(`  Make sure this promotion is backed by real (live-book) evidence, not a shadow run.`);
  }
  console.log(`\n  Reason: ${reason}\n`);

  if (!parsed.yes) {
    const ok = await confirm(`Proceed with ${sleeve} → ${mode}? [y/N] `);
    if (!ok) {
      console.log("Aborted — no changes made.");
      process.exit(1);
    }
  }

  const result = applyModeChange(sleeve, mode, reason);
  if (!result.ok) {
    console.error(`✗ ${result.reason}`);
    process.exit(1);
  }
  console.log(`✅ ${sleeve} is now "${mode}".`);
  printStatus();
}

if (import.meta.main) {
  main().catch((e: any) => {
    console.error(`✗ fatal: ${e?.message ?? e}`);
    process.exit(1);
  });
}
