// TypeScript mirror of scripts/lib/docs-only.sh (the shell copy drives
// auto-deploy.sh and check-committed.sh; docsOnly.test.ts keeps the two rules
// identical). Documentation = any *.md file or anything under docs/; nothing
// the bot runs reads those paths, so a docs-only commit needs no restart.
import { execFileSync } from "child_process";

export const DOCS_ONLY_RE = /(\.md$|^docs\/)/;

/** True when at least one path changed and every changed path is documentation. */
export function isDocsOnlyChange(paths: string[]): boolean {
  const changed = paths.map((p) => p.trim()).filter(Boolean);
  return changed.length > 0 && changed.every((p) => DOCS_ONLY_RE.test(p));
}

/** isDocsOnlyChange over `git diff --name-only from to` in `cwd`; false when
 *  git cannot diff the range (unknown sha → treat as a real code change). */
export function docsOnlyRange(from: string, to: string, cwd = process.cwd()): boolean {
  try {
    const out = execFileSync("git", ["diff", "--name-only", from, to], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return isDocsOnlyChange(out.split("\n"));
  } catch {
    return false;
  }
}
