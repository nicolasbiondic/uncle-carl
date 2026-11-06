import { describe, expect, test } from "bun:test";
import { addedModelVersionSleeves, hasSecondCutover, isDocsOnlyChange, pushWindow, runRelease, type CommandRunner } from "./release";

const at = (iso: string) => new Date(iso);

describe("release push window", () => {
  test("blocks the stock pass in New York time and opens exactly at 09:50 ET", () => {
    // The stock pass follows New York time: 14:35 UTC in winter (EST), 13:35 UTC in summer (EDT).
    expect(pushWindow(at("2026-11-06T14:25:00Z"))).toMatchObject({ open: false, opensAt: at("2026-11-06T14:50:00Z") });
    expect(pushWindow(at("2026-11-06T14:37:30Z"))).toMatchObject({ open: false, opensAt: at("2026-11-06T14:50:00Z") });
    expect(pushWindow(at("2026-11-06T14:50:00Z")).open).toBe(true);
    expect(pushWindow(at("2026-11-06T13:25:00Z")).open).toBe(true);
    expect(pushWindow(at("2026-10-28T13:25:00Z"))).toMatchObject({ open: false, opensAt: at("2026-10-28T13:50:00Z") });
    expect(pushWindow(at("2026-10-28T13:50:00Z")).open).toBe(true);
  });

  test("blocks each hourly crypto pass at :56 through :01", () => {
    expect(pushWindow(at("2026-11-06T12:56:00Z"))).toMatchObject({ open: false, opensAt: at("2026-11-06T13:02:00Z") });
    expect(pushWindow(at("2026-11-06T13:01:00Z")).open).toBe(false);
    expect(pushWindow(at("2026-11-06T13:02:00Z")).open).toBe(true);
  });
});

describe("release cutover guard", () => {
  const stocks = '+     { id: "momentum_stocks@new", since: "2026-11-06T00:00:00Z", modelStart: null, note: "test" },';
  const crypto = '+     { id: "momentum_crypto@new", since: "2026-11-06T00:00:00Z", modelStart: null, note: "test" },';

  test("extracts added sleeves from a version-list diff", () => {
    expect(addedModelVersionSleeves(`+++ b/src/portfolio/modelVersions.ts\n${stocks}\n${crypto}`)).toEqual(["momentum_stocks", "momentum_crypto"]);
  });

  test("blocks only a second cutover for the same sleeve", () => {
    expect(hasSecondCutover(stocks, [crypto])).toBe(false);
    expect(hasSecondCutover(stocks, [stocks])).toBe(true);
  });
});

describe("release docs-only detection", () => {
  test("accepts Markdown and docs paths, but no code", () => {
    expect(isDocsOnlyChange(["README.md", "docs/reports/result.json"])).toBe(true);
    expect(isDocsOnlyChange(["README.md", "src/index.ts"])).toBe(false);
    expect(isDocsOnlyChange([])).toBe(false);
  });
});

describe("release dry run", () => {
  test("uses injected runners through steps 1–5 and never pushes or executes the real suite", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args.join(" ") === "branch --show-current") return { code: 0, stdout: "master\n", stderr: "" };
      if (args.join(" ") === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (args.join(" ") === "rev-list --count HEAD..origin/master") return { code: 0, stdout: "0\n", stderr: "" };
      if (args.join(" ") === "diff --unified=0 origin/master..HEAD -- src/portfolio/modelVersions.ts") return { code: 0, stdout: "", stderr: "" };
      if (args.join(" ") === "log --since=24 hours ago --format=%H origin/master -- src/portfolio/modelVersions.ts") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    await runRelease({ dryRun: true, run, now: () => at("2026-11-06T12:10:00Z") });
    expect(calls).toContain("nice -n 5 env TMPDIR=/dev/shm bun test");
    expect(calls.some((call) => call === "git push origin master")).toBe(false);
  });
});

describe("release CI wait", () => {
  test("a CI run that appears seconds after the push is awaited, not reported missing", async () => {
    let listed = 0, now = at("2026-11-06T12:10:00Z").getTime();
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      const cmd = [command, ...args].join(" ");
      calls.push(cmd);
      if (cmd === "git branch --show-current") return { code: 0, stdout: "master\n", stderr: "" };
      if (cmd === "git rev-list --count HEAD..origin/master") return { code: 0, stdout: "0\n", stderr: "" };
      if (cmd === "git rev-parse HEAD") return { code: 0, stdout: "abcdef1234567890\n", stderr: "" };
      if (cmd === "git diff --name-only origin/master..HEAD") return { code: 0, stdout: "README.md\n", stderr: "" };
      if (cmd.startsWith("gh run list")) return { code: 0, stdout: ++listed < 3 ? "\n" : "4242\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await runRelease({ run, now: () => new Date(now), sleep: async ms => { now += ms; } });
    expect(listed).toBe(3);
    expect(calls).toContain("gh run watch 4242 --exit-status");
  });

  test("no CI run within 3 minutes aborts the release", async () => {
    let now = at("2026-11-06T12:10:00Z").getTime();
    const run: CommandRunner = async (command, args) => {
      const cmd = [command, ...args].join(" ");
      if (cmd === "git branch --show-current") return { code: 0, stdout: "master\n", stderr: "" };
      if (cmd === "git rev-list --count HEAD..origin/master") return { code: 0, stdout: "0\n", stderr: "" };
      if (cmd === "git rev-parse HEAD") return { code: 0, stdout: "abcdef1234567890\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(runRelease({ run, now: () => new Date(now), sleep: async ms => { now += ms; } })).rejects.toThrow("No GitHub CI run appeared");
  });
});
