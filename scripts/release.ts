#!/usr/bin/env bun
/** Safe, serialized release path for origin/master. */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], env?: Record<string, string>) => Promise<CommandResult>;

export interface ReleaseOptions {
  dryRun?: boolean;
  noWait?: boolean;
  allowSecondCutover?: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  run?: CommandRunner;
  healthFetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  healthUrl?: string;
}

export interface PushWindow {
  open: boolean;
  opensAt: Date;
  reason?: string;
}

const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Hour and minute in New York (DST-aware): the stock pass runs at 09:35 ET, 13:35 UTC in summer, 14:35 UTC in winter. */
function newYorkClock(now: Date): { hour: number; minute: number } {
  const parts = Object.fromEntries(NEW_YORK_CLOCK.formatToParts(now).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** The next safe instant under the stock (09:25–09:50 New York) and hourly crypto (:56–:01 UTC) pass windows. */
export function pushWindow(now: Date): PushWindow {
  const next = new Date(now);
  const minute = now.getUTCMinutes();
  const ny = newYorkClock(now);
  if (ny.hour === 9 && ny.minute >= 25 && ny.minute < 50) {
    // New York and UTC minutes are aligned (whole-hour offsets): 09:50 ET is (50 - minute) minutes away.
    next.setUTCMinutes(minute + (50 - ny.minute), 0, 0);
    return { open: false, opensAt: next, reason: "stock pass (09:25–09:50 New York)" };
  }
  if (minute >= 56) {
    next.setUTCHours(now.getUTCHours() + 1, 2, 0, 0);
    return { open: false, opensAt: next, reason: "hourly crypto pass (:56–:01 UTC)" };
  }
  if (minute <= 1) {
    next.setUTCMinutes(2, 0, 0);
    return { open: false, opensAt: next, reason: "hourly crypto pass (:56–:01 UTC)" };
  }
  return { open: true, opensAt: now };
}

/** Sleeves whose version list receives a new `id: "<sleeve>@..."` entry. */
export function addedModelVersionSleeves(versionListDiff: string): string[] {
  const sleeves = new Set<string>();
  for (const line of versionListDiff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const id = line.match(/\bid:\s*["']([^"']+)["']/)?.[1];
    const sleeve = id?.split("@", 1)[0];
    if (sleeve) sleeves.add(sleeve);
  }
  return [...sleeves];
}

/** True when a candidate cutover repeats a sleeve found in recent version diffs. */
export function hasSecondCutover(candidateDiff: string, recentVersionDiffs: string[]): boolean {
  const candidates = new Set(addedModelVersionSleeves(candidateDiff));
  if (candidates.size === 0) return false;
  const recent = recentVersionDiffs.flatMap(addedModelVersionSleeves);
  return recent.some((sleeve) => candidates.has(sleeve));
}

/** Documentation is Markdown anywhere, or any path below docs/. */
export function isDocsOnlyChange(paths: string[]): boolean {
  const changed = paths.map((path) => path.trim()).filter(Boolean);
  return changed.length > 0 && changed.every((path) => path.endsWith(".md") || path.startsWith("docs/"));
}

const defaultRun: CommandRunner = async (command, args, extraEnv) => {
  const proc = Bun.spawn([command, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function output(result: CommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

async function required(run: CommandRunner, command: string, args: string[], message: string, env?: Record<string, string>): Promise<string> {
  const result = await run(command, args, env);
  if (result.code !== 0) {
    const detail = output(result);
    throw new Error(`${message}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function shortCommit(head: string): string {
  return head.slice(0, 7);
}

async function waitForPushWindow(now: () => Date, sleep: (ms: number) => Promise<void>, noWait: boolean): Promise<void> {
  for (;;) {
    const window = pushWindow(now());
    if (window.open) return;
    const message = `Push blocked during ${window.reason}; safe at ${window.opensAt.toISOString()}.`;
    if (noWait) throw new Error(`${message} --no-wait requested, aborting.`);
    console.log(`${message} Waiting.`);
    await sleep(Math.max(1, window.opensAt.getTime() - now().getTime()));
  }
}

async function recentVersionDiffs(run: CommandRunner): Promise<string[]> {
  const commits = await required(
    run,
    "git",
    ["log", "--since=24 hours ago", "--format=%H", "origin/master", "--", "src/portfolio/modelVersions.ts"],
    "Could not inspect model-version cutovers.",
  );
  const diffs: string[] = [];
  for (const commit of commits.split("\n").filter(Boolean)) {
    diffs.push(await required(
      run,
      "git",
      ["show", "--format=", "--unified=0", commit, "--", "src/portfolio/modelVersions.ts"],
      `Could not inspect model-version commit ${commit}.`,
    ));
  }
  return diffs;
}

async function waitForCi(run: CommandRunner, head: string, sleep: (ms: number) => Promise<void>, now: () => Date): Promise<void> {
  // GitHub creates the run a few seconds after the push: wait for it instead of failing.
  const deadline = now().getTime() + 3 * 60_000;
  let runId = "";
  for (;;) {
    runId = await required(
      run,
      "gh",
      ["run", "list", "--commit", head, "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"],
      "Could not list GitHub CI runs for HEAD.",
    );
    if (runId && runId !== "null") break;
    if (now().getTime() > deadline) throw new Error("No GitHub CI run appeared for HEAD within 3 minutes.");
    await sleep(10_000);
  }
  await required(run, "gh", ["run", "watch", runId, "--exit-status"], "GitHub CI failed.");
  console.log(`GitHub CI passed for ${shortCommit(head)}.`);
}

async function waitForHealth(
  healthUrl: string,
  head: string,
  sleep: (ms: number) => Promise<void>,
  healthFetch: NonNullable<ReleaseOptions["healthFetch"]>,
  now: () => Date,
): Promise<void> {
  const deadline = now().getTime() + 10 * 60_000;
  const expected = shortCommit(head);
  while (now().getTime() <= deadline) {
    try {
      const response = await healthFetch(healthUrl);
      const body = response.ok ? await response.json() as { commit?: unknown } : {};
      if (typeof body.commit === "string" && (body.commit === expected || body.commit === head)) {
        console.log(`Production healthz reports ${body.commit}.`);
        return;
      }
    } catch {
      // Deployment may not have opened its health endpoint yet.
    }
    await sleep(5_000);
  }
  throw new Error(`Production healthz did not report ${expected} within 10 minutes.`);
}

/** Runs the release gate. Dependencies are injectable so its tests never push or run the full suite. */
export async function runRelease(options: ReleaseOptions = {}): Promise<void> {
  const run = options.run ?? defaultRun;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const healthUrl = options.healthUrl ?? process.env.UC_PROD_HEALTHZ_URL;

  const branch = await required(run, "git", ["branch", "--show-current"], "Could not determine the current branch.");
  if (branch !== "master") throw new Error(`Release refuses branch ${branch || "(detached)"}; checkout master first.`);
  const status = await required(run, "git", ["status", "--porcelain"], "Could not verify the worktree is clean.");
  if (status) throw new Error("Release refuses a dirty worktree; commit or remove every change first.");
  await required(run, "git", ["fetch", "origin"], "git fetch origin failed; remote state is unknown.");
  const behind = await required(run, "git", ["rev-list", "--count", "HEAD..origin/master"], "Could not compare HEAD with origin/master.");
  if (Number(behind) > 0) throw new Error(`Release refuses: local master is ${behind} commit(s) behind origin/master.`);

  await required(run, "bun", ["run", "typecheck"], "Typecheck failed; release aborted.");
  const tests = await run("nice", ["-n", "5", "env", "TMPDIR=/dev/shm", "bun", "test"]);
  if (tests.code !== 0) {
    throw new Error(`Full test suite failed; release aborted. Failing test output:\n${output(tests) || "(test runner returned no output)"}`);
  }

  await waitForPushWindow(now, sleep, !!options.noWait);
  const candidateDiff = await required(
    run,
    "git",
    ["diff", "--unified=0", "origin/master..HEAD", "--", "src/portfolio/modelVersions.ts"],
    "Could not inspect candidate model-version changes.",
  );
  if (!options.allowSecondCutover && hasSecondCutover(candidateDiff, await recentVersionDiffs(run))) {
    throw new Error("Release refuses a second model cutover for the same sleeve within 24 hours; use --allow-second-cutover only with explicit approval.");
  }

  if (options.dryRun) {
    console.log("Dry run passed release steps 1–5; nothing was pushed.");
    return;
  }

  const head = await required(run, "git", ["rev-parse", "HEAD"], "Could not resolve HEAD.");
  const changedPaths = await required(run, "git", ["diff", "--name-only", "origin/master..HEAD"], "Could not inspect release paths.");
  await required(run, "git", ["push", "origin", "master"], "git push origin master failed; release aborted.");
  await waitForCi(run, head, sleep, now);
  if (healthUrl && !isDocsOnlyChange(changedPaths.split("\n"))) {
    await waitForHealth(healthUrl, head, sleep, options.healthFetch ?? (fetch as ReleaseOptions["healthFetch"]), now);
  }
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const allowed = new Set(["--dry-run", "--no-wait", "--allow-second-cutover"]);
  const unknown = [...args].filter((arg) => !allowed.has(arg));
  if (unknown.length) {
    console.error(`Unknown option(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
  try {
    await runRelease({
      dryRun: args.has("--dry-run"),
      noWait: args.has("--no-wait"),
      allowSecondCutover: args.has("--allow-second-cutover"),
    });
  } catch (error: any) {
    console.error(`Release aborted: ${error.message}`);
    process.exit(1);
  }
}
