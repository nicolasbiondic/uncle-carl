// Tests for the post-restart /healthz gate in auto-deploy.sh.
//
// The script guards `--health-check-only` BEFORE `cd "$REPO"` (auto-deploy.sh:52-55),
// so it's exercisable standalone against a mock server, with no real git repo,
// no bun install/typecheck/test gate, and no ./start.sh restart.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "auto-deploy.sh");

function runHealthCheckOnly(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = Bun.spawn(["bash", SCRIPT, "--health-check-only"], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    (async () => {
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      resolve({ code, out });
    })();
  });
}

describe("auto-deploy.sh --health-check-only", () => {
  test("immediate success: 200 + status ok exits 0", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "ok" }, { status: 200 }),
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "3",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "2",
      });
      expect(code).toBe(0);
      expect(out).toContain("health check OK (attempt 1/3");
    } finally {
      server.stop(true);
    }
  });

  test("retry success: fails twice (503) then 200 ok on 3rd attempt", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        if (hits < 3) return Response.json({ status: "error" }, { status: 503 });
        return Response.json({ status: "ok" }, { status: 200 });
      },
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "5",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "2",
      });
      expect(code).toBe(0);
      expect(hits).toBe(3);
      expect(out).toContain("health check OK (attempt 3/5");
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("timeout: server always down (connection refused) exits 1 after all attempts", async () => {
    // Nothing is listening on this port — every request is a connection refusal.
    const { code, out } = await runHealthCheckOnly({
      HEALTH_URL: "http://127.0.0.1:18999/healthz",
      HEALTH_CHECK_ATTEMPTS: "3",
      HEALTH_CHECK_INTERVAL: "1",
      HEALTH_CHECK_TIMEOUT: "1",
    });
    expect(code).toBe(1);
    expect(out).toContain("health check FAILED after 3 attempts");
  }, 10_000);

  test("HTTP failure: server always 503 exits 1, does not report ok", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "error", error: "db down" }, { status: 503 }),
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "2",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "1",
      });
      expect(code).toBe(1);
      expect(out).toContain("health check FAILED after 2 attempts");
      expect(out).not.toContain("health check OK");
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("non-ok JSON: HTTP 200 but status != ok exits 1 (not fooled by a 200)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "degraded" }, { status: 200 }),
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "2",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "1",
      });
      expect(code).toBe(1);
      expect(out).not.toContain("health check OK");
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("nested status: nested {status:ok} without a top-level status exits 1 (not fooled by a substring match)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ result: { status: "ok" } }, { status: 200 }),
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "1",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "1",
      });
      expect(code).toBe(1);
      expect(out).not.toContain("health check OK");
    } finally {
      server.stop(true);
    }
  });

  test("malformed JSON: 200 with an invalid JSON body exits 1", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("not json{", { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "1",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "1",
      });
      expect(code).toBe(1);
      expect(out).not.toContain("health check OK");
    } finally {
      server.stop(true);
    }
  });

  test("invalid override: non-numeric HEALTH_CHECK_ATTEMPTS falls back to the default of 10", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "ok" }, { status: 200 }),
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "banana",
      });
      expect(code).toBe(0);
      expect(out).toContain("attempt 1/20");
    } finally {
      server.stop(true);
    }
  });

  test("zero override: HEALTH_CHECK_ATTEMPTS=0 is clamped to a minimum of 1 attempt", async () => {
    const { code, out } = await runHealthCheckOnly({
      HEALTH_URL: "http://127.0.0.1:18999/healthz",
      HEALTH_CHECK_ATTEMPTS: "0",
      HEALTH_CHECK_INTERVAL: "1",
      HEALTH_CHECK_TIMEOUT: "1",
    });
    expect(code).toBe(1);
    expect(out).toContain("FAILED after 1 attempts");
  }, 10_000);

  test("huge override: HEALTH_CHECK_ATTEMPTS is clamped to a bounded maximum, not used verbatim", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "ok" }, { status: 200 }),
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "999999999999999999999999",
      });
      expect(code).toBe(0);
      // Succeeds on attempt 1 regardless of the cap; the denominator proves
      // the huge value was clamped (a failing run would otherwise retry an
      // effectively unbounded number of times).
      expect(out).toMatch(/attempt 1\/\d+/);
      expect(out).not.toContain("attempt 1/999999999999999999999999");
    } finally {
      server.stop(true);
    }
  });

  test("per-request timeout: a response slower than HEALTH_CHECK_TIMEOUT is treated as a failed attempt", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(2500);
        return Response.json({ status: "ok" }, { status: 200 });
      },
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "1",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "1",
      });
      expect(code).toBe(1);
      expect(out).toContain("FAILED after 1 attempts");
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("timeout cannot be disabled: HEALTH_CHECK_TIMEOUT=0 is clamped to a minimum, so a slow response still fails", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(2500);
        return Response.json({ status: "ok" }, { status: 200 });
      },
    });
    try {
      // If TIMEOUT=0 disabled curl's --max-time (its literal meaning:
      // unlimited), curl would wait out the 2.5s delay and this would
      // exit 0. Clamped to a minimum > 0, the request aborts first.
      const { code } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "1",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "0",
      });
      expect(code).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("defaults: no attempts/interval overrides — total attempts=20, bounded, sane", async () => {
    // Just proves the defaults exist and are used when no env override is set;
    // doesn't wait out the full ~30-60s budget (points HEALTH_URL at an
    // immediate success so it returns on attempt 1 regardless of the count).
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "ok" }, { status: 200 }),
    });
    try {
      const { code, out } = await runHealthCheckOnly({
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
      });
      expect(code).toBe(0);
      expect(out).toContain("attempt 1/20");
    } finally {
      server.stop(true);
    }
  });
});

describe("auto-deploy.sh source: no DEPLOYED without a passing health check", () => {
  const src = readFileSync(SCRIPT, "utf8");

  test("script does not source .env", () => {
    expect(src).not.toMatch(/source\s+\.env|\.\s+\.env|source\s+"\$REPO\/\.env"/);
  });

  test("the post-restart block gates the DEPLOYED log behind health_check, with an exit 1 else", () => {
    const deployBlock = src.slice(src.indexOf('bash -c "$START_CMD" >/dev/null 2>&1; then'));
    // Structural shape: on restart success, health_check must run and gate the
    // DEPLOYED log; the failure branch must exit 1 and must NOT log DEPLOYED.
    const ifStart = deployBlock.indexOf("if health_check; then");
    const deployedIdx = deployBlock.indexOf("DEPLOYED");
    const elseIdx = deployBlock.indexOf("else", ifStart);
    const failLogIdx = deployBlock.indexOf("GATE FAIL: health check", elseIdx);
    const exitIdx = deployBlock.indexOf("exit 1", failLogIdx);

    expect(ifStart).toBeGreaterThan(-1);
    expect(deployedIdx).toBeGreaterThan(ifStart); // DEPLOYED only appears after entering the health_check branch
    expect(elseIdx).toBeGreaterThan(deployedIdx); // the else (failure) branch comes after the success log
    expect(failLogIdx).toBeGreaterThan(elseIdx);
    expect(exitIdx).toBeGreaterThan(failLogIdx);

    // The failure branch's own text (from else to its exit 1) must not contain DEPLOYED.
    const failureBranchText = deployBlock.slice(elseIdx, exitIdx + "exit 1".length);
    expect(failureBranchText).not.toContain("DEPLOYED");
  });

  test("health failure branch rolls back via git reset --hard, no restart loop", () => {
    const deployBlock = src.slice(src.indexOf("if health_check; then"));
    const failureBranch = deployBlock.slice(0, deployBlock.indexOf("fi\n"));
    expect(failureBranch).toMatch(/git reset --hard "\$LOCAL"/);
    expect(failureBranch).not.toMatch(/while\s*:|for\s*\(\(/);
  });
});

// ── Full-run tests: execute the real script (not --health-check-only)
// against a temporary git repo, with GATE_*/START_CMD/REPO injected so no
// real typecheck/tests/bot/broker is touched. HEALTH_URL (already supported
// by health_check) controls the post-restart outcome.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** origin (bare-ish plain repo) + work (clone, this is what REPO points to). */
function makeRepoPair() {
  const root = mkdtempSync(join(tmpdir(), "auto-deploy-"));
  const origin = join(root, "origin");
  const work = join(root, "work");
  mkdirSync(origin);
  git(origin, "init", "--quiet", "-b", "master");
  git(origin, "config", "user.email", "t@t.t");
  git(origin, "config", "user.name", "t");
  // data/ holds .deploy-restart / .deploy-rejected-sha, gitignored in prod;
  // mirrored here so writing those markers doesn't dirty the working tree.
  writeFileSync(join(origin, ".gitignore"), "data/\n");
  git(origin, "add", ".gitignore");
  git(origin, "commit", "-m", "commit A", "--quiet");
  const shaA = git(origin, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", origin, work);
  git(work, "config", "user.email", "t@t.t");
  git(work, "config", "user.name", "t");
  mkdirSync(join(work, "data")); // holds .deploy-restart / .deploy-rejected-sha, mirrors prod layout
  git(origin, "commit", "--allow-empty", "-m", "commit B", "--quiet");
  const shaB = git(origin, "rev-parse", "HEAD");
  return { root, origin, work, shaA, shaB };
}

function runScript(env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const proc = Bun.spawn(["bash", SCRIPT], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    (async () => {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      resolve({ code, out, err });
    })();
  });
}

describe("auto-deploy.sh full run (temp repo, injected commands)", () => {
  test("gate fails: START_CMD never invoked, exits nonzero, no deploy", async () => {
    const { root, work } = makeRepoPair();
    const sentinel = join(root, "started.marker");
    try {
      const { code } = await runScript({
        REPO: work,
        GATE_TYPECHECK_CMD: "true",
        GATE_TEST_CMD: "exit 1",
        START_CMD: `touch ${sentinel}`,
        HEALTH_URL: "http://127.0.0.1:1/healthz",
      });
      expect(code).not.toBe(0);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("health check never confirms ok: rolls back to the pre-pull SHA and marks it rejected", async () => {
    const { root, work, shaA, shaB } = makeRepoPair();
    const sentinel = join(root, "started.marker");
    try {
      // HEALTH_URL never answers, so both the post-deploy AND the post-rollback
      // health_check fail — the rollback itself (reset+marker) must still
      // complete; only the "now healthy" claim is unavailable (CRITICAL instead).
      const { code, err } = await runScript({
        REPO: work,
        GATE_TYPECHECK_CMD: "true",
        GATE_TEST_CMD: "true",
        START_CMD: `touch ${sentinel}`,
        HEALTH_URL: "http://127.0.0.1:18999/healthz", // nothing listening
        HEALTH_CHECK_ATTEMPTS: "1",
        HEALTH_CHECK_INTERVAL: "0",
        HEALTH_CHECK_TIMEOUT: "1",
      });
      expect(code).not.toBe(0);
      expect(existsSync(sentinel)).toBe(true); // START_CMD did run (pre-rollback restart)
      expect(git(work, "rev-parse", "HEAD")).toBe(shaA); // rolled back to pre-pull SHA
      expect(readFileSync(join(work, "data", ".deploy-rejected-sha"), "utf8").trim()).toBe(shaB);
      expect(err).toContain("CRITICAL: rollback to");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("rejected SHA is not re-deployed on the next run", async () => {
    const { root, work, shaA, shaB } = makeRepoPair();
    const sentinel = join(root, "started.marker");
    // Simulates the state left behind by a prior rollback: origin/master is
    // still at the SHA that was already rejected as unhealthy.
    writeFileSync(join(work, "data", ".deploy-rejected-sha"), `${shaB}\n`);
    try {
      const { code, out } = await runScript({
        REPO: work,
        GATE_TYPECHECK_CMD: "true",
        GATE_TEST_CMD: "true",
        START_CMD: `touch ${sentinel}`,
        HEALTH_URL: "http://127.0.0.1:18999/healthz",
      });
      expect(code).toBe(0);
      expect(existsSync(sentinel)).toBe(false); // never restarted — no re-deploy attempt
      expect(git(work, "rev-parse", "HEAD")).toBe(shaA); // never pulled either
      expect(out).toContain("skipping until a new commit lands");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("stale rejected-SHA marker is cleared once origin/master advances past it, deploy proceeds", async () => {
    const { root, work, shaA, shaB } = makeRepoPair();
    const sentinel = join(root, "started.marker");
    // Marker names a DIFFERENT (already-superseded) SHA than current origin/master.
    writeFileSync(join(work, "data", ".deploy-rejected-sha"), `${shaA}\n`);
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "ok" }, { status: 200 }) });
    try {
      const { code, out } = await runScript({
        REPO: work,
        GATE_TYPECHECK_CMD: "true",
        GATE_TEST_CMD: "true",
        START_CMD: `touch ${sentinel}`,
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "3",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "2",
      });
      expect(code).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      expect(git(work, "rev-parse", "HEAD")).toBe(shaB);
      expect(out).toContain("DEPLOYED");
      expect(existsSync(join(work, "data", ".deploy-rejected-sha"))).toBe(false); // cleared, not stale
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("parked SHA (pulled but never deployed): gate is retried and deploy completes — not silent until the next commit", async () => {
    // Reproduces the 2026-07-30 prod incident: HEAD == origin/master because a
    // prior run pulled, but the gate failed, so the RUNNING bot is older. The
    // old script exited 0 ("up to date") forever; now .deployed-sha disagreeing
    // (or missing) must force a gate retry + restart.
    const { root, work, shaB } = makeRepoPair();
    git(work, "fetch", "--quiet", "origin", "master");
    git(work, "merge", "--ff-only", "--quiet", "origin/master"); // parked: HEAD=shaB, nothing deployed
    const sentinel = join(root, "started.marker");
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "ok" }, { status: 200 }) });
    try {
      const { code, out } = await runScript({
        REPO: work,
        GATE_TYPECHECK_CMD: "true",
        GATE_TEST_CMD: "true",
        START_CMD: `touch ${sentinel}`,
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "3",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "2",
      });
      expect(code).toBe(0);
      expect(out).toContain("never deployed");
      expect(existsSync(sentinel)).toBe(true); // restart DID happen
      expect(out).toContain("DEPLOYED");
      expect(readFileSync(join(work, "data", ".deployed-sha"), "utf8").trim()).toBe(shaB);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("up to date AND deployed: exits 0 silently, no gate, no restart", async () => {
    const { root, work, shaB } = makeRepoPair();
    git(work, "fetch", "--quiet", "origin", "master");
    git(work, "merge", "--ff-only", "--quiet", "origin/master");
    writeFileSync(join(work, "data", ".deployed-sha"), `${shaB}\n`);
    const sentinel = join(root, "started.marker");
    try {
      const { code, out } = await runScript({
        REPO: work,
        GATE_TYPECHECK_CMD: "exit 1", // would fail loudly if the gate ran at all
        GATE_TEST_CMD: "exit 1",
        START_CMD: `touch ${sentinel}`,
        HEALTH_URL: "http://127.0.0.1:18999/healthz",
      });
      expect(code).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      expect(out).not.toContain("GATE FAIL");
      expect(out).not.toContain("DEPLOYED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("a dirty tree that persists PAGES instead of skipping forever (2026-08-07: 2h of silent blocked deploys)", async () => {
    // Two stray .env.bak-* files made the tree dirty and auto-deploy did the
    // right thing (never clobber local work) in the worst possible way:
    // silently, every 2 minutes, for two hours. Refusing must stay; being
    // quiet about it must not.
    const { root, work } = makeRepoPair();
    writeFileSync(join(work, "stray-file.txt"), "an operator's leftover\n");
    try {
      // First tick: dirty, but not yet past the threshold → no page.
      const first = await runScript({
        REPO: work, GATE_TYPECHECK_CMD: "true", GATE_TEST_CMD: "true",
        START_CMD: "true", HEALTH_URL: "http://127.0.0.1:18999/healthz",
        DIRTY_PAGE_AFTER_SEC: "99999",
      });
      expect(first.code).toBe(0);
      expect(first.out).toContain("working tree dirty");
      expect(existsSync(join(work, "data", ".deploy-dirty-since"))).toBe(true);

      // Threshold of 0 → the very next tick is past it and must page.
      const second = await runScript({
        REPO: work, GATE_TYPECHECK_CMD: "true", GATE_TEST_CMD: "true",
        START_CMD: "true", HEALTH_URL: "http://127.0.0.1:18999/healthz",
        DIRTY_PAGE_AFTER_SEC: "0",
      });
      expect(second.code).toBe(0);
      expect(existsSync(join(work, "data", ".deploy-dirty-paged"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("the dirty markers clear once the tree is clean, so the next block pages again", async () => {
    const { root, work } = makeRepoPair();
    const sentinel = join(root, "started.marker");
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "ok" }, { status: 200 }) });
    try {
      writeFileSync(join(work, "data", ".deploy-dirty-since"), "1");
      writeFileSync(join(work, "data", ".deploy-dirty-paged"), "1");
      const { code } = await runScript({
        REPO: work, GATE_TYPECHECK_CMD: "true", GATE_TEST_CMD: "true",
        START_CMD: `touch ${sentinel}`,
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "3", HEALTH_CHECK_INTERVAL: "1", HEALTH_CHECK_TIMEOUT: "2",
      });
      expect(code).toBe(0);
      expect(existsSync(join(work, "data", ".deploy-dirty-since"))).toBe(false);
      expect(existsSync(join(work, "data", ".deploy-dirty-paged"))).toBe(false);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  // ── git fetch failure paging (B-ops-alerts.md #9) ────────────────────────
  // 2026-09-24: 4× "git@github.com: Permission denied (publickey)" fetch
  // failures — every subsequent push silently never deployed, nothing paged,
  // exit 0 every time. `notify()` shells out to curl (no network in tests),
  // so these assert on the LOG line + the persisted marker files, exactly
  // like the dirty-tree tests above (which use the same technique).
  test("fetch failures below the count/age thresholds do not page yet", async () => {
    const { root, work } = makeRepoPair();
    git(work, "remote", "set-url", "origin", join(root, "does-not-exist"));
    try {
      const { code, out } = await runScript({
        REPO: work, GATE_TYPECHECK_CMD: "true", GATE_TEST_CMD: "true",
        START_CMD: "true", HEALTH_URL: "http://127.0.0.1:18999/healthz",
        FETCH_FAIL_COUNT_THRESHOLD: "5", FETCH_FAIL_AGE_THRESHOLD_SEC: "99999",
      });
      expect(code).toBe(0);
      expect(out).toContain("git fetch failed — skip");
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-since"))).toBe(true);
      expect(readFileSync(join(work, "data", ".deploy-fetch-fail-count"), "utf8").trim()).toBe("1");
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-paged"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("N consecutive fetch failures page ops exactly once (not once per poll)", async () => {
    const { root, work } = makeRepoPair();
    git(work, "remote", "set-url", "origin", join(root, "does-not-exist"));
    try {
      const opts = {
        REPO: work, GATE_TYPECHECK_CMD: "true", GATE_TEST_CMD: "true",
        START_CMD: "true", HEALTH_URL: "http://127.0.0.1:18999/healthz",
        FETCH_FAIL_COUNT_THRESHOLD: "3", FETCH_FAIL_AGE_THRESHOLD_SEC: "99999",
      };
      await runScript(opts); // 1
      await runScript(opts); // 2 — still shy of the threshold
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-paged"))).toBe(false);
      await runScript(opts); // 3 — crosses the count threshold → pages
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-paged"))).toBe(true);
      expect(readFileSync(join(work, "data", ".deploy-fetch-fail-count"), "utf8").trim()).toBe("3");

      // A 4th consecutive failure must NOT page again (once per incident).
      const before = readFileSync(join(work, "data", ".deploy-fetch-fail-paged"), "utf8");
      await runScript(opts);
      expect(readFileSync(join(work, "data", ".deploy-fetch-fail-paged"), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("staleness alone (age threshold) also pages, independent of the count threshold", async () => {
    const { root, work } = makeRepoPair();
    git(work, "remote", "set-url", "origin", join(root, "does-not-exist"));
    try {
      const { code } = await runScript({
        REPO: work, GATE_TYPECHECK_CMD: "true", GATE_TEST_CMD: "true",
        START_CMD: "true", HEALTH_URL: "http://127.0.0.1:18999/healthz",
        FETCH_FAIL_COUNT_THRESHOLD: "99999", // never reached by count alone
        FETCH_FAIL_AGE_THRESHOLD_SEC: "0",   // any failure is already "stale"
      });
      expect(code).toBe(0);
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-paged"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("a recovered fetch clears the failure state and pages a recovery notice", async () => {
    const { root, work, shaB } = makeRepoPair();
    const badUrl = join(root, "does-not-exist");
    const goodUrl = join(root, "origin");
    git(work, "remote", "set-url", "origin", badUrl);
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "ok" }, { status: 200 }) });
    try {
      const opts = {
        REPO: work, GATE_TYPECHECK_CMD: "true", GATE_TEST_CMD: "true",
        START_CMD: "true", HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        FETCH_FAIL_COUNT_THRESHOLD: "1", FETCH_FAIL_AGE_THRESHOLD_SEC: "99999",
      };
      await runScript(opts); // fails once → crosses count=1 → pages
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-paged"))).toBe(true);

      git(work, "remote", "set-url", "origin", goodUrl); // SSH key fixed
      const { code, out } = await runScript({
        ...opts, START_CMD: `touch ${join(root, "started.marker")}`,
        HEALTH_CHECK_ATTEMPTS: "3", HEALTH_CHECK_INTERVAL: "1", HEALTH_CHECK_TIMEOUT: "2",
      });
      expect(code).toBe(0);
      expect(out).not.toContain("git fetch failed");
      // All fetch-failure markers cleared — a FUTURE failure streak starts fresh.
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-paged"))).toBe(false);
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-since"))).toBe(false);
      expect(existsSync(join(work, "data", ".deploy-fetch-fail-count"))).toBe(false);
      expect(git(work, "rev-parse", "HEAD")).toBe(shaB); // and the deploy itself proceeded normally
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("happy path: gate + restart + healthy — deploy completes on the new SHA", async () => {
    const { root, work, shaB } = makeRepoPair();
    const sentinel = join(root, "started.marker");
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "ok" }, { status: 200 }) });
    try {
      const { code, out } = await runScript({
        REPO: work,
        GATE_TYPECHECK_CMD: "true",
        GATE_TEST_CMD: "true",
        START_CMD: `touch ${sentinel}`,
        HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        HEALTH_CHECK_ATTEMPTS: "3",
        HEALTH_CHECK_INTERVAL: "1",
        HEALTH_CHECK_TIMEOUT: "2",
      });
      expect(code).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      expect(git(work, "rev-parse", "HEAD")).toBe(shaB);
      expect(out).toContain("DEPLOYED");
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
