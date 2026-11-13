import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { MONEY_LABELS } from "../portfolio/money";

// The project skill `texto-para-personas` tells agents how to write what the
// owner reads. It names helpers and tests by path; a renamed file would leave
// it pointing nowhere, so every path it cites must exist. The skill is part of
// the public export, where AGENTS.md is AGENTS.public.md and OPEN.md, AUDITS.md
// and HANDOFF.md do not exist: it must not cite those, and both AGENTS files
// carry the pointer.
const ROOT = join(import.meta.dir, "../..");
const SKILL = ".opencode/skills/texto-para-personas/SKILL.md";
const text = readFileSync(join(ROOT, SKILL), "utf8");

test("the skill has the frontmatter OpenCode needs to advertise it", () => {
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  expect(front).toMatch(/^name: \S/m);
  expect(front).toMatch(/^description: \S/m);
});

test("every repo path the skill cites exists", () => {
  const paths = [...text.matchAll(/`((?:src|scripts)\/[\w./-]+\.\w+|[A-Z]+\.md)`/g)].map((m) => m[1]);
  expect(paths.length).toBeGreaterThan(10);
  expect(paths.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
});

test("AGENTS.md points at the skill, and the money words are still the contract's", () => {
  for (const file of ["AGENTS.md", "AGENTS.public.md"]) {
    if (existsSync(join(ROOT, file))) expect(readFileSync(join(ROOT, file), "utf8")).toContain(SKILL);
  }
  expect(text).not.toMatch(/\b(OPEN|AUDITS|HANDOFF)\.md\b/);
  expect(MONEY_LABELS.windowPnl).toContain("Ganancia");
  expect(MONEY_LABELS.unrealized).toContain("Sin cerrar");
  expect(text).toContain("GANANCIA");
  expect(text).toContain("SIN CERRAR");
});
