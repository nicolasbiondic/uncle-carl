// The dead-man's switch (audit F-2): scripts/lib/cron-job.sh's marker/page
// behavior, every cron wrapper wired to it, and src/ops/cronJobs.ts's schedule
// mirror kept equal to what scripts/install-cron.sh installs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRON_JOBS } from "../src/ops/cronJobs";

const ROOT = join(import.meta.dir, "..");
const LIB = join(ROOT, "scripts", "lib", "cron-job.sh");

let dir: string;
let tg: ReturnType<typeof Bun.serve>;
let tgMode: "ok" | "fail";
let sent: { chat: string; text: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-job-"));
  sent = []; tgMode = "ok";
  tg = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (tgMode === "fail") return new Response("no", { status: 500 });
      const f = new URLSearchParams(await req.text());
      sent.push({ chat: f.get("chat_id") ?? "", text: f.get("text") ?? "" });
      return Response.json({ ok: true });
    },
  });
  writeFileSync(join(dir, "env"), "TELEGRAM_BOT_TOKEN=123:SECRET\nTELEGRAM_OPS_CHAT_ID=-100\nTELEGRAM_CHAT_ID=999\n");
});
afterEach(() => { tg.stop(true); rmSync(dir, { recursive: true, force: true }); });

/** Runs a tiny wrapper: `cron_job_start demo <ok codes>` then `exit <rc>`. */
async function job(rc: number, okCodes = "", extra = "") {
  const script = `set -euo pipefail\nsource '${LIB}'\ncron_job_start demo ${okCodes}\n${extra}\nexit ${rc}\n`;
  const p = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, CRON_MARKER_DIR: join(dir, "m"), CRON_ENV_FILE: join(dir, "env"), TELEGRAM_API_BASE: `http://127.0.0.1:${tg.port}` },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}
const marker = () => join(dir, "m", "demo.ok");

describe("scripts/lib/cron-job.sh", () => {
  test("success writes an epoch marker and .since, keeps the exit code, pages nobody", async () => {
    const r = await job(0);
    expect(r.code).toBe(0);
    const v = Number(readFileSync(marker(), "utf8").trim());
    expect(Math.abs(v - Date.now() / 1000)).toBeLessThan(30);
    expect(existsSync(join(dir, "m", ".since"))).toBe(true);
    expect(sent).toEqual([]);
  });

  test("a failure pages the OPS chat ONCE per episode, writes no marker, keeps the exit code; recovery pages once", async () => {
    expect((await job(5)).code).toBe(5);
    expect(existsSync(marker())).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0].chat).toBe("-100");
    expect(sent[0].text).toContain("cron demo");
    expect(sent[0].text).toContain("exit 5");
    await job(5); await job(1);
    expect(sent.length).toBe(1);               // same episode: silent
    expect((await job(0)).code).toBe(0);
    expect(sent.length).toBe(2);
    expect(sent[1].text).toContain("vuelve a terminar bien");
    await job(0);
    expect(sent.length).toBe(2);
  });

  test("extra ok codes count as success (parity divergence / guardian violation are 'ran')", async () => {
    expect((await job(1, "0 1")).code).toBe(1);
    expect(existsSync(marker())).toBe(true);
    expect(sent).toEqual([]);
    expect((await job(2, "0 1")).code).toBe(2);
    expect(sent.length).toBe(1);
  });

  test("set -e aborts still reach the trap", async () => {
    const r = await job(0, "", "false");
    expect(r.code).toBe(1);
    expect(sent.length).toBe(1);
  });

  test("CRON_JOB_SKIP=1 leaves marker and pages alone", async () => {
    const r = await job(0, "", "CRON_JOB_SKIP=1");
    expect(r.code).toBe(0);
    expect(existsSync(marker())).toBe(false);
    expect(sent).toEqual([]);
  });

  test("an undeliverable page is retried by the next failing run, not lost", async () => {
    tgMode = "fail";
    await job(3);
    expect(existsSync(join(dir, "m", "demo.failing"))).toBe(false);
    tgMode = "ok";
    await job(3);
    expect(sent.length).toBe(1);
    expect(existsSync(join(dir, "m", "demo.failing"))).toBe(true);
  });

  test("missing credentials: DROPPED loudly, never the user chat, the token never printed", async () => {
    writeFileSync(join(dir, "env"), "TELEGRAM_BOT_TOKEN=123:SECRET\nTELEGRAM_CHAT_ID=999\n");
    const r = await job(4);
    expect(r.err).toContain("DROPPED");
    expect(sent).toEqual([]);
    expect(r.out + r.err).not.toContain("SECRET");
    const src = readFileSync(LIB, "utf8").split("\n").filter(l => !l.trim().startsWith("#")).join("\n");
    expect(src).not.toMatch(/TELEGRAM_CHAT_ID/);
    expect(src).toContain("-K -");
    expect(src).not.toMatch(/source\s+\S*\.env/);
  });
});

describe("every cron wrapper reports to the dead-man's switch", () => {
  for (const [script, job] of [
    ["backup-db.sh", "cron_job_start backup-db"],
    ["refresh-historical.sh", "cron_job_start refresh-historical"],
    ["refresh-historical.sh", "cron_job_start refresh-stocks"],
    ["parity-check.sh", "cron_job_start parity-check 0 1"],
    ["guardian.sh", "cron_job_start guardian 0 1 2"],
    ["ai-quorum.sh", 'cron_job_start "ai-quorum-$MODE"'],
    ["restore-drill.sh", "cron_job_start restore-drill"],
  ] as const) {
    test(`${script}: ${job}`, () => {
      const src = readFileSync(join(ROOT, "scripts", script), "utf8");
      expect(src).toContain('source "$ROOT_DIR/scripts/lib/cron-job.sh"');
      expect(src).toContain(job);
      // `exec` would replace the shell and skip the EXIT trap (the marker/page)
      const code = src.split("\n").filter(l => !l.trim().startsWith("#"));
      const execs = code.filter(l => /^\s*exec\s/.test(l));
      expect(execs.every(l => l.includes("manual fill/status"))).toBe(true);
    });
  }
});

describe("src/ops/cronJobs.ts mirrors scripts/install-cron.sh", () => {
  const cron = readFileSync(join(ROOT, "scripts", "install-cron.sh"), "utf8");
  const line = (v: string) => cron.match(new RegExp(`^${v}="([^"]+)"`, "m"))?.[1] ?? "";
  const fields = (l: string) => l.split(" ").slice(0, 5);
  const days = (f: string) => f === "*" ? undefined : f.includes("-")
    ? (([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))(f.split("-").map(Number)) : f.split(",").map(Number);
  for (const [variable, name] of [
    ["BACKUP_LINE", "backup-db"], ["REFRESH_LINE", "refresh-historical"], ["REFRESH_LINE", "refresh-stocks"],
    ["PARITY_LINE", "parity-check"], ["AIQ_STOCKS_LINE", "ai-quorum-stocks"], ["AIQ_CRYPTO_LINE", "ai-quorum-crypto"],
    ["GUARDIAN_LINE", "guardian"], ["DRILL_LINE", "restore-drill"],
  ] as const) {
    test(`${name} ⇔ ${variable}`, () => {
      const [m, h, , , dow] = fields(line(variable));
      const spec = CRON_JOBS.find(j => j.name === name)!;
      expect(spec).toBeDefined();
      expect(spec.minute).toBe(Number(m));
      expect(spec.hours).toEqual(h === "*" ? undefined : h.split(",").map(Number));
      expect(spec.days).toEqual(days(dow));
    });
  }

  test("the stock-only retries run before refresh-stocks is due (06:00 and 08:30 < 04:00 + grace)", () => {
    const spec = CRON_JOBS.find(j => j.name === "refresh-stocks")!;
    for (const v of ["REFRESH_RETRY1_LINE", "REFRESH_RETRY2_LINE"]) {
      const [m, h] = fields(line(v)).map(Number);
      expect(line(v)).toContain("--retry-stocks");
      expect(h * 60 + m).toBeLessThan(4 * 60 + spec.graceMin);
    }
  });

  test("every job in the mirror is installed (no orphan spec that could only ever be stale)", () => {
    expect(CRON_JOBS.map(j => j.name).sort()).toEqual(
      ["ai-quorum-crypto", "ai-quorum-stocks", "backup-db", "guardian", "parity-check", "refresh-historical", "refresh-stocks", "restore-drill"]);
  });
});

describe("wrapper behavior with a fake bun", () => {
  async function wrap(script: string, args: string[], bunBody: string) {
    const bun = join(dir, "bun-fake"), calls = join(dir, "calls");
    writeFileSync(bun, `#!/bin/bash\necho "$*" >> '${calls}'\n${bunBody}\n`, { mode: 0o755 });
    const p = Bun.spawn(["bash", join(ROOT, "scripts", script), ...args], {
      // bun test runs in UTC; pin the scripts' `date` to the same zone (prod hosts are UTC−5, CI is UTC).
      env: { ...process.env, TZ: "UTC", BUN_BIN: bun, CRON_MARKER_DIR: join(dir, "m"), CRON_ENV_FILE: join(dir, "env"), TELEGRAM_API_BASE: `http://127.0.0.1:${tg.port}` },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const c = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
    return { code: await p.exited, out, err, calls: c };
  }

  test("refresh-historical --retry-stocks: a no-op when today's stock refresh already succeeded", async () => {
    Bun.spawnSync(["mkdir", "-p", join(dir, "m")]);
    // "Today's 04:00" may still be ahead (between midnight and 04:00): succeed after it.
    const today0400 = new Date(); today0400.setUTCHours(4, 0, 0, 0);
    writeFileSync(join(dir, "m", "refresh-stocks.ok"), `${Math.max(Math.floor(Date.now() / 1000), Math.floor(today0400.getTime() / 1000) + 60)}\n`);
    const r = await wrap("refresh-historical.sh", ["--retry-stocks"], "exit 0");
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("refresh-historical --retry-stocks: retries ONLY the stock dailies when no refresh since 04:00, and marks refresh-stocks", async () => {
    const r = await wrap("refresh-historical.sh", ["--retry-stocks"], "exit 0");
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["run scripts/backfill-historical.ts --stocks-only"]);
    expect(existsSync(join(dir, "m", "refresh-stocks.ok"))).toBe(true);
    expect(existsSync(join(dir, "m", "refresh-historical.ok"))).toBe(false);
  });

  test("refresh-historical (04:00): a failing step pages once, marks nothing; the stock step never ran", async () => {
    const r = await wrap("refresh-historical.sh", [], 'case "$*" in *crypto-only*) exit 9;; esac; exit 0');
    expect(r.code).toBe(9);
    expect(r.calls.some(c => c.includes("--stocks-only"))).toBe(false);
    expect(existsSync(join(dir, "m", "refresh-historical.ok"))).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("cron refresh-historical");
  });

  test("refresh-historical (04:00) success marks both refresh-historical and refresh-stocks", async () => {
    const r = await wrap("refresh-historical.sh", [], "exit 0");
    expect(r.code).toBe(0);
    expect(r.calls.at(-1)).toBe("run scripts/backfill-historical.ts --stocks-only");
    expect(existsSync(join(dir, "m", "refresh-historical.ok"))).toBe(true);
    expect(existsSync(join(dir, "m", "refresh-stocks.ok"))).toBe(true);
  });

  test("ai-quorum.sh: a cycle that ends status=failed exits 3 and pages; status ok marks ai-quorum-<mode>", async () => {
    const failed = await wrap("ai-quorum.sh", ["crypto"], `echo '[ai-quorum] x done: {"status":"failed","snapshotId":49,"modelsAnswered":0}'`);
    expect(failed.code).toBe(3);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("cron ai-quorum-crypto");
    const ok = await wrap("ai-quorum.sh", ["stocks"], `echo '[ai-quorum] x done: {"status":"ok","snapshotId":50,"modelsAnswered":3}'`);
    expect(ok.code).toBe(0);
    expect(existsSync(join(dir, "m", "ai-quorum-stocks.ok"))).toBe(true);
    const manual = await wrap("ai-quorum.sh", ["status"], "exit 0");
    expect(manual.code).toBe(0);
    expect(existsSync(join(dir, "m", "ai-quorum-status.ok"))).toBe(false);
  });

  test("parity-check.sh: divergence (1) is a run, operational failure (2) pages", async () => {
    expect((await wrap("parity-check.sh", [], "exit 1")).code).toBe(1);
    expect(existsSync(join(dir, "m", "parity-check.ok"))).toBe(true);
    expect(sent).toEqual([]);
    expect((await wrap("parity-check.sh", [], "exit 2")).code).toBe(2);
    expect(sent.length).toBe(1);
  });
});
