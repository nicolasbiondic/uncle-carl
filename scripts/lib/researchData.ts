// Research datasets too big for the repo (hist-perps.db, hist-intraday.db,
// ...) live in one directory outside it: $UC_RESEARCH_DATA_DIR, or
// ~/code/wt/data when unset (beside the git worktrees research runs in).
// Experiment manifests name them "$UC_RESEARCH_DATA_DIR/<file>"; the manifest
// loaders expand that before anything reads the path, so the identity hashes
// see the same absolute path the manifests used to spell out.
import { homedir } from "node:os";
import { join } from "node:path";
import type { BarRow } from "../../src/data/HistoricalStore";

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

/** Shared Alpaca SIP page decoder; no dependency on either downloader CLI. */
export function mergeBarPages(pages: Array<Record<string, any[]>>): Record<string, BarRow[]> {
  const out: Record<string, BarRow[]> = {};
  for (const page of pages) {
    for (const [sym, raw] of Object.entries(page ?? {})) {
      const rows = raw.map((b: any) => ({
          symbol: sym,
          timeframe: "1d" as const,
          timestamp: Date.parse(b.t),
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
          volume: b.v ?? 0,
          source: "alpaca_wide" as const,
        }));
      (out[sym] ??= []).push(...rows);
    }
  }
  for (const sym of Object.keys(out)) {
    out[sym].sort((a, b) => a.timestamp - b.timestamp);
  }
  return out;
}
