#!/usr/bin/env bun
// Post-deploy check: is the LIVE process actually running the commit on disk?
//
// This is the check the 2026-07-27 zombie-process incident needed. Every
// other post-deploy check that day passed (`./start.sh status` active,
// `/healthz` 200, `bun test` green) while an orphaned OLD process kept
// answering the health port and the real systemd restart hung mid-bind. The
// only thing that caught it was a `grep` for a log string the new commit
// introduced. This compares /healthz's `commit` field against this
// checkout's git HEAD and fails loudly on any mismatch — that grep, in two
// seconds, every time.
//
// Usage: bun run verify:deploy
import dotenv from "dotenv";
import { readdirSync, readFileSync, readlinkSync } from "fs";
import { getVersionInfo } from "../src/utils/version";

// Only when EXECUTED as a script — an import-time dotenv({override:true})
// re-clobbered process.env for every test file that ran after
// verify-deploy.test.ts imported us (on a host whose .env sets
// TRADING_ENABLED=false, that flipped 29 unrelated engine tests red,
// 2026-07-31). Top-of-file placement still runs before the PORT consts below
// when invoked as main.
if (import.meta.main) dotenv.config({ override: true });

const PORT = process.env.DASHBOARD_PORT || "3789";
const HEALTH_URL = process.env.VERIFY_DEPLOY_URL || `http://127.0.0.1:${PORT}/healthz`;

/** Pure comparator — exported so tests can exercise match/mismatch directly. */
export function commitsMatch(remote: string | undefined | null, local: string): boolean {
  return !!remote && !!local && local !== "unknown" && remote === local;
}

/**
 * Best-effort "more than one bot process for this checkout" detector, Linux
 * /proc only (matches start.sh's own kill_orphans_by_cwd approach — same
 * false-positive profile it already accepts in production).
 * ponytail: no PID-namespace/container awareness; good enough for this host.
 */
function findMatchingPids(cwd: string): number[] {
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids; // not Linux, or /proc unreadable — skip silently
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readlinkSync(`/proc/${entry}/cwd`) !== cwd) continue;
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.includes("bun") && cmdline.includes("src/index")) pids.push(parseInt(entry, 10));
    } catch {
      // process exited mid-scan, or unreadable (different user) — skip it
    }
  }
  return pids;
}

async function main() {
  const local = getVersionInfo();
  console.log(`Local HEAD commit:   ${local.commit}${local.dirty ? " (dirty worktree)" : ""}`);

  let remoteCommit: string | undefined;
  try {
    const res = await fetch(HEALTH_URL);
    const body = (await res.json()) as any;
    remoteCommit = body.commit;
    console.log(`Live process commit:  ${remoteCommit ?? "(missing from response)"}  [${HEALTH_URL}]`);
  } catch (e: any) {
    console.error(`❌ Could not reach ${HEALTH_URL}: ${e.message}`);
    process.exit(1);
  }

  let failed = false;

  if (!commitsMatch(remoteCommit, local.commit)) {
    console.error(
      `❌ MISMATCH — the running process is NOT on this checkout's commit.\n` +
      `   live=${remoteCommit ?? "unknown"}  disk=${local.commit}\n` +
      `   This is the zombie-process failure mode: the deploy likely did not take effect.`
    );
    failed = true;
  } else {
    console.log("✅ Live process commit matches disk HEAD.");
  }

  const pids = findMatchingPids(process.cwd());
  if (pids.length > 1) {
    console.error(`⚠️  ${pids.length} bot processes share this checkout's cwd (pids: ${pids.join(", ")}) — possible orphan running alongside the real one.`);
    failed = true;
  }

  process.exit(failed ? 1 : 0);
}

// Only run when executed directly (`bun run scripts/verify-deploy.ts`), not
// when imported for its exported `commitsMatch` comparator (verify-deploy.test.ts).
if (import.meta.main) {
  main();
}
