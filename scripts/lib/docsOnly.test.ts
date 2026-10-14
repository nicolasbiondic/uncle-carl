import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { DOCS_ONLY_RE, isDocsOnlyChange } from "./docsOnly";

describe("docs-only rule (no restart for documentation commits)", () => {
  test("*.md anywhere and docs/** are documentation; code, config and data are not", () => {
    expect(isDocsOnlyChange(["AUDITS.md", "docs/reports/V-plan-volumen-rentabilidad.md", "docs/platform/x.png"])).toBe(true);
    expect(isDocsOnlyChange(["README.md", "src/index.ts"])).toBe(false);
    expect(isDocsOnlyChange(["experiments/historical-hypothesis-ledger-v1.json"])).toBe(false);
    expect(isDocsOnlyChange(["scripts/auto-deploy.sh"])).toBe(false);
    expect(isDocsOnlyChange(["src/docs/thing.ts"])).toBe(false);
  });

  test("an empty diff is not docs-only (conservative: deploy normally)", () => {
    expect(isDocsOnlyChange([])).toBe(false);
    expect(isDocsOnlyChange(["", "  "])).toBe(false);
  });

  test("the shell copy (auto-deploy.sh, check-committed.sh) uses the same pattern", () => {
    const sh = readFileSync(join(import.meta.dir, "docs-only.sh"), "utf8");
    const m = sh.match(/^DOCS_ONLY_RE='([^']+)'$/m);
    expect(m?.[1]).toBe(DOCS_ONLY_RE.source.replace("\\/", "/"));
  });
});
