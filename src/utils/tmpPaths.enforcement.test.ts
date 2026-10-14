/**
 * Static enforcement: no code may hard-code the dev host's scratch directory
 * (/tmp/opencode, created by the agent harness on this machine). A test that
 * did `mkdtempSync("/tmp/opencode/...")` passed here and in prod's deploy
 * gate (where the directory happened to exist) and failed on the public
 * repo's CI runner with ENOENT (2026-10-14, line H). Temporary files go
 * through os.tmpdir(), which honours TMPDIR (the deploy gate sets its own).
 *
 * Only quoted string literals are flagged: comments that mention the path
 * as prose (e.g. where an operator once wrote a report) are not code.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCANNED_DIRS = ["src", "scripts", "experiments"];
const EXTENSIONS = [".ts", ".js", ".mjs", ".sh"];
const QUOTED_SCRATCH = /["'`]\/tmp\/opencode\b/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
}

describe("no hard-coded /tmp/opencode in code", () => {
  test("every temporary path goes through os.tmpdir()", () => {
    const files: string[] = [];
    for (const dir of SCANNED_DIRS) walk(join(REPO_ROOT, dir), files);
    const offenders: string[] = [];
    for (const file of files) {
      if (file === import.meta.path) continue;
      readFileSync(file, "utf-8").split("\n").forEach((line, i) => {
        if (QUOTED_SCRATCH.test(line)) offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
