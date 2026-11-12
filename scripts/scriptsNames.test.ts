// Guard for names that do not exist in `scripts/`.
//
// `tsconfig.json` only includes `src/`, so `bun run typecheck` never looks at
// `scripts/`. On 2026-11-07 a refactor deleted `lastCompleteSession` from
// scripts/parity-check.ts while another function there still called it; nothing
// failed until the 2026-11-10 04:45 cron (docs/LECCIONES.md, 2026-11-10).
//
// A full strict typecheck of scripts/ needs 64 unrelated type fixes. This guard is
// the cheap part: it runs tsc over scripts/ (`tsconfig.scripts.json`) and fails ONLY
// on the codes that mean "this name/module/export does not exist":
//   TS2304 cannot find name · TS2552 cannot find name, did you mean · TS2305 module
//   has no exported member · TS2307 cannot find module · TS2724 no exported member,
//   did you mean.
// Other type errors are tolerated for now (OPEN.md lists them).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TSC = join(ROOT, "node_modules", ".bin", "tsc");
const MISSING_NAME_CODES = ["TS2304", "TS2552", "TS2305", "TS2307", "TS2724"];

/** Lines of tsc output that report a name, module or export that does not exist. */
export function missingNameErrors(tscOutput: string): string[] {
  return tscOutput
    .split("\n")
    .filter((line) => MISSING_NAME_CODES.some((code) => line.includes(`error ${code}:`)));
}

function runTsc(project: string): string {
  const r = Bun.spawnSync([TSC, "--noEmit", "-p", project], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString() + r.stderr.toString();
}

describe("scripts/ has no names that do not exist", () => {
  test("the detector flags a call to a deleted function (the 2026-11-07 shape)", () => {
    const dir = mkdtempSync(join(tmpdir(), "scripts-names-"));
    try {
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ES2022", moduleResolution: "bundler", types: [] },
          include: ["fixture.ts"],
        }),
      );
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          "export function checkSleeve(): number {",
          "  return lastCompleteSession(new Date()); // deleted by a refactor, still called",
          "}",
          'import { nothingHere } from "./does-not-exist";',
          "export const y = nothingHere;",
          "",
        ].join("\n"),
      );
      const found = missingNameErrors(runTsc(join(dir, "tsconfig.json")));
      expect(found.some((l) => l.includes("lastCompleteSession"))).toBe(true);
      expect(found.some((l) => l.includes("./does-not-exist"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the detector ignores ordinary type errors", () => {
    const sample = [
      "scripts/a.ts(1,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "scripts/a.ts(2,1): error TS2339: Property 'x' does not exist on type 'Y'.",
    ].join("\n");
    expect(missingNameErrors(sample)).toEqual([]);
  });

  test("no script calls a name, module or export that does not exist", () => {
    const found = missingNameErrors(runTsc(join(ROOT, "tsconfig.scripts.json")));
    expect(found).toEqual([]);
  }, 60_000);
});
