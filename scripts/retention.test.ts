// Log retention floor (2026-10-22 ops review: bot, deploy, watchdog, parity and
// refresh logs must be kept ≥ 90 days; `rotate 14` had already lost September).
// Companion: src/db/retention.test.ts pins the DB tables.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const conf = readFileSync(join(ROOT, "scripts", "logrotate.conf"), "utf8");
const directives = conf.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const has = (d: string) => directives.some((l) => l === d);

describe("scripts/logrotate.conf keeps every log ≥ 90 days", () => {
  const rotate = Number(directives.find((l) => /^rotate\s+\d+$/.test(l))?.split(/\s+/)[1]);
  const period = has("daily") ? 1 : has("weekly") ? 7 : has("monthly") ? 30 : NaN;

  test("rotate × period ≥ 90 days", () => {
    expect(Number.isFinite(period)).toBe(true);
    expect(rotate * period).toBeGreaterThanOrEqual(90);
  });

  test("no age cap shorter than the floor, and archives are kept (compress, missingok)", () => {
    const maxage = directives.find((l) => /^maxage\s+\d+$/.test(l));
    if (maxage) expect(Number(maxage.split(/\s+/)[1])).toBeGreaterThanOrEqual(90);
    expect(has("compress")).toBe(true);
    expect(has("missingok")).toBe(true);
    expect(has("dateext")).toBe(true); // glob order == time order (scripts/logs.sh header)
  });

  test("the glob covers every log the cron jobs and the deploy unit write", () => {
    expect(directives.some((l) => /^__ROOT__\/logs\/\*\.log \{$/.test(l))).toBe(true);
    const sources = [
      readFileSync(join(ROOT, "scripts", "install-cron.sh"), "utf8"),
      readFileSync(join(ROOT, "scripts", "uncle-carl-deploy.service"), "utf8"),
    ].join("\n");
    const logs = new Set([...sources.matchAll(/(?:\$LOG_DIR|__REPO__\/logs)\/([\w.-]+)/g)].map((m) => m[1]));
    for (const name of ["backup.log", "refresh-historical.log", "watchdog.log", "parity-check.log", "deploy.log"]) {
      expect(logs.has(name)).toBe(true);
    }
    for (const name of logs) expect(name.endsWith(".log")).toBe(true);
  });
});
