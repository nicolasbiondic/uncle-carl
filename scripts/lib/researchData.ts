// Research datasets too big for the repo (hist-perps.db, hist-intraday.db,
// ...) live in one directory outside it: $UC_RESEARCH_DATA_DIR, or
// ~/code/wt/data when unset (beside the git worktrees research runs in).
// Experiment manifests name them "$UC_RESEARCH_DATA_DIR/<file>"; the manifest
// loaders expand that before anything reads the path, so the identity hashes
// see the same absolute path the manifests used to spell out.
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR_VAR = "$UC_RESEARCH_DATA_DIR";

export function researchDataDir(): string {
  return process.env.UC_RESEARCH_DATA_DIR?.trim() || join(homedir(), "code", "wt", "data");
}

export function researchDataPath(file: string): string {
  return join(researchDataDir(), file);
}

/** "$UC_RESEARCH_DATA_DIR/x.db" -> <research data dir>/x.db, "~/x" -> <home>/x;
 *  any other path (e.g. "./data/historical.db") is returned unchanged. */
export function expandDataPath(path: string): string {
  if (path === DATA_DIR_VAR || path.startsWith(`${DATA_DIR_VAR}/`)) return join(researchDataDir(), path.slice(DATA_DIR_VAR.length));
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
