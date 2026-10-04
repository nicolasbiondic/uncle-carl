// Runtime code-version identity.
//
// Built for the 2026-07-27 zombie-process incident: a fix was deployed,
// `./start.sh status` said active, `/healthz` said 200, `bun test` was green
// — and NONE of it was running the new code. An orphaned process from a
// previous restart was still bound to the port while the real systemd
// restart hung mid-bind. The only thing that caught it was a `grep` for a
// log string the new commit introduced. This module answers, at any time,
// "what commit is this process actually running" without needing luck.
//
// The commit hash is read directly from `.git/HEAD` + the ref it points at
// (or `packed-refs` if the branch ref has been packed) instead of spawning
// `git rev-parse`. Rationale: these are plain text files, so reading them
// can't hang, can't fail if the `git` binary isn't installed on the host,
// and adds zero process-spawn risk to startup — a stuck git subprocess at
// boot would recreate exactly the kind of "looks alive but isn't" failure
// this module exists to prevent. It degrades to "unknown" on ANY read
// failure (missing .git, detached worktree, corrupted ref) — startup must
// never fail because of this.
//
// The "dirty" (uncommitted changes) flag is a different story: correctly
// answering "does the worktree differ from HEAD" means replicating git's
// index/worktree/untracked-file comparison, which is not worth
// reimplementing from raw files. It's a best-effort, time-boxed
// `git diff-index` call; any failure (git missing, timeout, not a repo)
// reports `dirty: null` ("unknown") rather than guessing.

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

export interface GitVersionInfo {
  /** Short (7-char) commit hash, or "unknown" if it couldn't be determined. */
  commit: string;
  /** true/false if determinable, null if undeterminable (never blocks startup). */
  dirty: boolean | null;
  /** epoch ms captured once, at module load (i.e. process start). */
  startedAt: number;
}

function readHeadCommit(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    let hash = "";
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      const refPath = join(gitDir, ref);
      if (existsSync(refPath)) {
        hash = readFileSync(refPath, "utf8").trim();
      } else {
        // Loose ref file is gone (e.g. after `git gc` packs branch refs) —
        // look it up in packed-refs instead.
        const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
        const line = packed.split("\n").find(l => l.trim().endsWith(` ${ref}`));
        hash = line?.trim().split(/\s+/)[0] ?? "";
      }
    } else {
      hash = head; // detached HEAD: HEAD already holds the full hash
    }
    return /^[0-9a-f]{7,40}$/i.test(hash) ? hash.slice(0, 7) : null;
  } catch {
    return null;
  }
}

function readDirtyFlag(cwd: string): boolean | null {
  try {
    // Exit 0 = clean, exit 1 = differences exist — both are a successful,
    // meaningful answer. Anything else (git missing, timeout, not a repo,
    // no HEAD commit) is undeterminable.
    execSync("git diff-index --quiet HEAD --", { cwd, timeout: 2000, stdio: "ignore" });
    return false;
  } catch (e: any) {
    if (e.status === 1) return true;
    return null;
  }
}

/** Reads current commit/dirty state from the .git directory at `cwd`. Never throws. */
export function getVersionInfo(cwd: string = process.cwd(), startedAt: number = Date.now()): GitVersionInfo {
  const commit = readHeadCommit(join(cwd, ".git")) ?? "unknown";
  const dirty = commit === "unknown" ? null : readDirtyFlag(cwd);
  return { commit, dirty, startedAt };
}

// Computed once, when this module is first imported (i.e. at process start).
// Both src/index.ts (startup log) and the /healthz route import THIS constant
// so they agree on exactly the same reading without re-touching the filesystem
// on every health check.
export const VERSION_INFO: GitVersionInfo = getVersionInfo();
