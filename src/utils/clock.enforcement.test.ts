/**
 * Static enforcement of the clock seam (src/utils/clock.ts) — the
 * NautilusTrader pre-commit-hook pattern, expressed as a test because this
 * repo's gate is `bun test`, not a hook: DECISION-PATH code must not read
 * the system clock directly. A raw `Date.now` (call OR bare function
 * reference) or a bare `new Date()` in src/strategies/ or src/risk/ fails
 * this test unless the line carries an explicit, justified exception
 * marker.
 *
 * WHY THIS SCOPE — determinism of DECISIONS, not purism:
 *   - src/strategies/** and src/risk/** are the kernels replays execute
 *     (scripts/backtest-momentum-wf.ts, scripts/meanrev-replay.ts drive the
 *     REAL engines; scripts/regression-fingerprint.test.ts pins their
 *     output bit-for-bit). A stray system-clock read here silently
 *     diverges backtest from live — the exact bug class the old
 *     `(Date as any).now = ...` monkeypatch papered over.
 *   - Infrastructure (logs, telemetry timestamps, heartbeats, network
 *     timeouts, alert cooldowns, dashboard, executors' order ids) is
 *     deliberately NOT scanned: there the real clock is correct, and
 *     forcing injection would be noise without value.
 *
 * EXCEPTION MECHANISM — append to the offending line:
 *     // clock-ok: <reason>
 * Legitimate reasons seen today (each marker carries its own):
 *   - seam defaults: `now: number = Date.now()` default parameters and
 *     `deps?.now ?? Date.now` fallbacks ARE the seam — production's real
 *     clock enters only there, and every replay/test overrides it;
 *   - operator-action telemetry (RiskEngine.setTradingState changedAt):
 *     a wall-time stamp of a human/ops action, never read by decisions.
 * `new Date(ms)` with arguments is NOT flagged: converting a given epoch-ms
 * value for formatting is a pure function of its input, not a clock read.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Decision-path directories (relative to repo root) under enforcement. */
const SCANNED_DIRS = ["src/strategies", "src/risk"];

/**
 * Whole-file exemptions: live-broker PLUMBING that happens to live under
 * src/strategies/ (deterministic order ids, trades-row timestamps, sync
 * bookkeeping — the same category as src/executor/, where the wall clock
 * is correct). Replays never execute these files: SimBroker implements
 * MomentumBrokerAdapter in their place, so their clock reads cannot touch
 * replay determinism. Keep DECISION code out of these files — anything
 * that chooses WHAT to trade belongs in the engine, where the seam is.
 */
const EXEMPT_FILES = new Set([
  "src/strategies/momentum/AlpacaMomentumAdapter.ts",
  "src/strategies/momentum/BinanceMomentumAdapter.ts",
  "src/strategies/momentum/BinanceCoinMMomentumAdapter.ts",
]);

/** A system-clock read: `Date.now` (called or passed as a function) or a
 *  zero-argument `new Date()`. `new Date(<expr>)` is pure formatting. */
const CLOCK_READ = /\bDate\.now\b|new Date\s*\(\s*\)/;

const EXCEPTION_MARKER = "clock-ok";

function tsSourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir) as string[]) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsSourcesUnder(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("clock seam enforcement — no raw system-clock reads in decision paths", () => {
  test(`every Date.now / bare new Date() under ${SCANNED_DIRS.join(", ")} carries a justified "// ${EXCEPTION_MARKER}:" marker`, () => {
    const violations: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of tsSourcesUnder(join(REPO_ROOT, dir))) {
        if (EXEMPT_FILES.has(file.slice(REPO_ROOT.length + 1))) continue;
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line: string, i: number) => {
          if (CLOCK_READ.test(line) && !line.includes(EXCEPTION_MARKER)) {
            violations.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Raw system-clock read(s) in decision-path code — inject a Clock ` +
        `(src/utils/clock.ts) or the existing now-seam instead; if the wall ` +
        `clock is genuinely correct here, append "// ${EXCEPTION_MARKER}: <reason>":\n` +
        violations.join("\n"),
      );
    }
  });

  test("the scan is not vacuous: it sees the seam-default exception lines it exists to police", () => {
    // If the marker count ever hits 0, the scanner is probably scanning
    // nothing (moved dirs, renamed marker) — fail loudly rather than pass
    // green on an empty scan. Seam defaults exist today in RiskGuard,
    // MeanRevEngine, RiskEngine (PairsEngine/CarryShadowEngine's markers
    // went with them when those dead sleeves were deleted 2026-09-25).
    let markers = 0;
    let filesScanned = 0;
    for (const dir of SCANNED_DIRS) {
      for (const file of tsSourcesUnder(join(REPO_ROOT, dir))) {
        filesScanned++;
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (CLOCK_READ.test(line) && line.includes(EXCEPTION_MARKER)) markers++;
        }
      }
    }
    expect(filesScanned).toBeGreaterThan(10);
    expect(markers).toBeGreaterThanOrEqual(4);
    // A renamed/deleted exempt file must not leave a stale exemption behind
    // that could silently blanket a future file of the same name.
    for (const f of EXEMPT_FILES) {
      expect(() => readFileSync(join(REPO_ROOT, f))).not.toThrow();
    }
  });
});
