// The runner of the AI review on the DEV machine (where OpenCode, the model policy and `cuotas-ia` live).
// scripts/ai-review.sh sets the environment, takes the lock and the systemd scope; this file is the logic, with
// every external program a knob (env) so tests run it with fake `opencode`, `cuotas-ia`, `ssh`, `scp` and `curl`.
//
//   run      cron: schedule guard → case file from prod (ssh) → panel → quorum → ship to prod → Telegram
//   dry-run  --casefile <path> [--models a,b,c]: the same without ssh, shipping or Telegram; prints the decision
//   status   prints the state, changes nothing
//
// Enforced: scripts/ai-review.test.ts (end to end with fake binaries), src/ai-review/*.test.ts (the pieces).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./analyst";
import { reviewApplies } from "./apply";
import { SLEEVE_IDS, parseCaseFile, parseDecision, type CaseFile, type Decision, type SleeveId } from "./contract";
import { familyOf, parseQuota, PRIMARIES, SUBSTITUTES } from "./models";
import { review } from "./review";
import { checkSchedule, markSession, readState, MAX_ATTEMPTS } from "./schedule";
import { serializeForModel } from "./casefile";
import { opsFailure, opsNoDecision, opsShipped, ownerMessage, type Applies } from "./texts";

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

export interface Config {
  root: string;
  stateDir: string;
  prodSsh: string;
  prodDir: string;
  ssh: string[];
  scp: string[];
  opencode: string[];
  quota: string[];
  curl: string[];
  envFile: string;
  apiBase: string;
  modelTimeoutSec: number;
  authFile: string;
  nowMs: () => number;
  /** Which strategies the bot acts on, as THIS machine sees the switch (src/ai-review/apply.ts and this environment).
   *  Only the fallback: a case file built on the bot's host says it itself (`applies`), and that wins, because the
   *  bot's deployed code and its kill switch are what decide. Wording only (the message's tense, the decision's
   *  `stage`); the bot never trusts it. */
  apply: Applies;
}

export function loadConfig(env: Record<string, string | undefined>, root: string): Config {
  const pick = (a: string, b: string, d: string) => env[a] ?? env[b] ?? d;
  const startReal = Date.now();
  const fixed = env.AI_REVIEW_NOW ? Number(env.AI_REVIEW_NOW) * 1000 : null;
  return {
    root,
    stateDir: env.AI_REVIEW_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "uncle-carl-ai-review"),
    // No instance default here (the public export carries this file): scripts/ai-review.sh supplies them.
    prodSsh: pick("AI_REVIEW_PROD_SSH", "IMPROVE_PROD_SSH", ""),
    prodDir: pick("AI_REVIEW_PROD_DIR", "IMPROVE_PROD_DIR", ""),
    ssh: words(pick("AI_REVIEW_SSH", "IMPROVE_SSH", "ssh -o BatchMode=yes -o ConnectTimeout=10")),
    scp: words(env.AI_REVIEW_SCP ?? "scp -o BatchMode=yes -o ConnectTimeout=10"),
    opencode: words(env.AI_REVIEW_OPENCODE ?? "opencode"),
    quota: words(env.AI_REVIEW_QUOTA_CMD ?? "cuotas-ia"),
    curl: words(env.AI_REVIEW_CURL ?? "curl"),
    envFile: env.AI_REVIEW_ENV_FILE ?? join(root, ".env"),
    apiBase: env.TELEGRAM_API_BASE ?? "https://api.telegram.org",
    modelTimeoutSec: Number(env.AI_REVIEW_MODEL_TIMEOUT ?? 720),
    authFile: env.AI_REVIEW_AUTH_FILE ?? join(homedir(), ".local", "share", "opencode", "auth.json"),
    // A test clock moves with real elapsed time, so deadlines still work.
    nowMs: fixed === null ? () => Date.now() : () => fixed + (Date.now() - startReal),
    apply: Object.fromEntries(SLEEVE_IDS.map(s => [s, reviewApplies(s, env)])) as Record<SleeveId, boolean>,
  };
}

// ── processes ────────────────────────────────────────────────────────────
interface Ran { code: number; stdout: string; stderr: string }
async function run(cmd: string[], o: { input?: string; cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<Ran> {
  try {
    const p = Bun.spawn(cmd, { cwd: o.cwd, env: o.env as Record<string, string>, stdin: o.input === undefined ? "ignore" : new Blob([o.input]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: String((e as Error)?.message ?? e) };
  }
}

// ── Telegram: token grepped from .env, handed to curl on stdin, never echoed ──
function envValue(file: string, key: string): string {
  try {
    const m = [...readFileSync(file, "utf8").matchAll(new RegExp(`^${key}=(.+)$`, "gm"))].at(-1);
    return m ? m[1].replace(/["'\s]/g, "") : "";
  } catch { return ""; }
}

export async function sendTelegram(cfg: Config, kind: "owner" | "ops", text: string, log: (m: string) => void): Promise<boolean> {
  // UPTIME_TELEGRAM_BOT_TOKEN first, for the owner's chat too: on the dev machine TELEGRAM_BOT_TOKEN is not a
  // live token (the decommissioned clone must never poll or speak as the bot; same rule as uptime-watch.sh),
  // so reading only it meant the owner's message could never leave (found on the real machine, 2026-11-14:
  // getMe 404 with one, 200 with the other; both chats reachable with the live one).
  const token = envValue(cfg.envFile, "UPTIME_TELEGRAM_BOT_TOKEN") || envValue(cfg.envFile, "TELEGRAM_BOT_TOKEN");
  const chat = envValue(cfg.envFile, kind === "ops" ? "TELEGRAM_OPS_CHAT_ID" : "TELEGRAM_CHAT_ID");
  if (!token || !chat) { log(`${kind} message DROPPED (no token/chat in ${cfg.envFile}): ${text.slice(0, 100)}`); return false; }
  const r = await run([...cfg.curl, "-fsS", "-m", "15", "-K", "-", "-d", `chat_id=${chat}`, "--data-urlencode", `text=${text.slice(0, 3900)}`], { input: `url = "${cfg.apiBase}/bot${token}/sendMessage"\n` });
  if (r.code !== 0) { log(`${kind} message FAILED (curl ${r.code}): ${text.slice(0, 100)}`); return false; }
  return true;
}

// ── prod: case file in, decision out ─────────────────────────────────────
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function fetchCaseFile(cfg: Config, session: string): Promise<{ ok: true; text: string; cf: CaseFile } | { ok: false; error: string }> {
  const remote = `cd ${q(cfg.prodDir)} && PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$PATH" bun scripts/ai-review-casefile.ts --session ${session}`;
  const r = await run([...cfg.ssh, cfg.prodSsh, remote]);
  if (r.code !== 0) return { ok: false, error: `ssh case file exited ${r.code}: ${(r.stderr || r.stdout).replace(/\s+/g, " ").slice(-300)}` };
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { return { ok: false, error: "case file from prod is not JSON" }; }
  const v = parseCaseFile(parsed);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.value.session !== session) return { ok: false, error: `case file is for ${v.value.session}, not ${session}` };
  return { ok: true, text: r.stdout, cf: v.value };
}

/** Atomic: copy to <session>.json.tmp, then rename on prod; the bot never sees a half file. */
export async function shipDecision(cfg: Config, file: string, session: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const inbox = `${cfg.prodDir}/data/ai-review/inbox`;
  const steps: [string, string[]][] = [
    ["mkdir", [...cfg.ssh, cfg.prodSsh, `mkdir -p ${q(inbox)}`]],
    ["scp", [...cfg.scp, file, `${cfg.prodSsh}:${inbox}/${session}.json.tmp`]],
    ["mv", [...cfg.ssh, cfg.prodSsh, `mv ${q(`${inbox}/${session}.json.tmp`)} ${q(`${inbox}/${session}.json`)}`]],
  ];
  for (const [name, cmd] of steps) {
    const r = await run(cmd);
    if (r.code !== 0) return { ok: false, error: `${name} exited ${r.code}: ${(r.stderr || r.stdout).replace(/\s+/g, " ").slice(-200)}` };
  }
  return { ok: true };
}

// ── the model process ────────────────────────────────────────────────────
/** OpenCode Go has no `cuotas-ia` pool and its key lives in OpenCode's own auth.json; an isolated data dir cannot see it. */
export function goKey(authFile: string): string {
  try {
    const a = JSON.parse(readFileSync(authFile, "utf8"))?.["opencode-go"];
    return a && a.type === "api" && typeof a.key === "string" ? a.key : "";
  } catch { return ""; }
}

export function opencodeExec(cfg: Config, runDir: string, session: string): Exec {
  const dataDir = join(cfg.stateDir, "opencode-data");
  mkdirSync(dataDir, { recursive: true });
  return async i => {
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("OPENCODE")) env[k] = v;
    // Its OWN data dir: a second server on the shared OpenCode database locks every other session (improvement-loop.sh).
    env.XDG_DATA_HOME = dataDir;
    // opencode takes its project directory from $PWD when set: an inherited PWD (the repo) would load the repo's
    // AGENTS.md and miss the run directory's agent ("Agent not found", seen in the first smoke run).
    env.PWD = runDir;
    delete env.OLDPWD;
    if (i.model.startsWith("opencode-go/")) { const k = goKey(cfg.authFile); if (k) env.OPENCODE_API_KEY = k; }
    const argv = [
      "timeout", "--kill-after=30", String(Math.max(1, Math.floor(i.timeoutSec))),
      ...cfg.opencode, "run", "--standalone", "--agent", "revision-ia", "--model", i.model, "--format", "json", "--auto", "--archived",
      "--title", `revision-ia ${session} ${familyOf(i.model)}`, ...(i.sessionId ? ["--session", i.sessionId] : []), i.prompt,
    ];
    const t0 = Date.now();
    const r = await run(argv, { cwd: runDir, env });
    try { writeFileSync(join(runDir, `${i.tag}.jsonl`), r.stdout); } catch { /* the record is a bonus */ }
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.code === 124 || r.code === 137, seconds: (Date.now() - t0) / 1000 };
  };
}

/** The run directory is the model's whole world: the case file, the agent, and the web-search choice (no credential). */
export function prepareRunDir(cfg: Config, runDir: string, cf: CaseFile): void {
  mkdirSync(join(runDir, ".opencode", "agents"), { recursive: true });
  writeFileSync(join(runDir, "casefile.json"), serializeForModel(cf));
  // A web-search provider chosen in the project config skips the interactive prompt that an isolated data dir
  // would otherwise ask (and a headless run must cancel). TinyFish works without a key.
  writeFileSync(join(runDir, "opencode.jsonc"), JSON.stringify({ $schema: "https://opencode.ai/config.json", websearch: { provider: "tinyfish" } }, null, 2) + "\n");
  // The agent file of THIS checkout, so the run never depends on which version is installed globally.
  copyFileSync(join(cfg.root, "ops", "agents", "revision-ia.md"), join(runDir, ".opencode", "agents", "revision-ia.md"));
}

/** Does the bot act on each strategy's review? The bot's own host says so in the case file; without that, this
 *  machine's view of the switch. */
export const appliesOf = (cfg: Pick<Config, "apply">, cf: Pick<CaseFile, "applies">): Applies => cf.applies ?? cfg.apply;

// ── one review ───────────────────────────────────────────────────────────
interface Outcome { decision: Decision | null; notes: string[]; models: Decision["models"]; runDir: string }

async function reviewCaseFile(cfg: Config, cf: CaseFile, o: { runDir: string; deadlineMs: number | null; primaries: readonly string[]; log: (m: string) => void }): Promise<Outcome> {
  prepareRunDir(cfg, o.runDir, cf);
  const qr = await run([...cfg.quota, "--json"]);
  const quota = qr.code === 0 ? parseQuota(qr.stdout) : null;
  if (quota === null) o.log(`cuotas-ia unusable (exit ${qr.code}); trying the primaries anyway`);
  const res = await review({
    caseFile: cf, primaries: o.primaries, substitutes: SUBSTITUTES, quota,
    exec: opencodeExec(cfg, o.runDir, cf.session), now: cfg.nowMs, deadlineMs: o.deadlineMs, modelTimeoutSec: cfg.modelTimeoutSec, log: o.log,
    decidedAtMs: cfg.nowMs(), stage: SLEEVE_IDS.some(s => appliesOf(cfg, cf)[s]) ? "apply" : "inform",
  });
  writeFileSync(join(o.runDir, "record.json"), JSON.stringify({ models: res.models, runs: res.runs, notes: res.notes, verdicts: res.verdicts }, null, 2) + "\n");
  if (res.decision) writeFileSync(join(o.runDir, "decision.json"), JSON.stringify(res.decision, null, 2) + "\n");
  return { decision: res.decision, notes: res.notes, models: res.models, runDir: o.runDir };
}

export async function main(argv: string[], env: Record<string, string | undefined>, root: string): Promise<number> {
  const cfg = loadConfig(env, root);
  const mode = argv[0] ?? "run";
  const log = (m: string) => console.log(`[${new Date(cfg.nowMs()).toISOString()}] ai-review: ${m}`);
  mkdirSync(cfg.stateDir, { recursive: true });
  const statePath = join(cfg.stateDir, "state.json");

  if (mode === "status") {
    const st = readState(statePath);
    const keys = Object.keys(st.sessions).sort().slice(-10);
    console.log(keys.length ? keys.map(k => `${k} ${st.sessions[k].status} ${st.sessions[k].at}${st.sessions[k].detail ? ` ${st.sessions[k].detail}` : ""}`).join("\n") : "no runs yet");
    return 0;
  }

  if (mode === "dry-run") {
    const flag = (n: string) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : undefined; };
    const path = flag("--casefile");
    if (!path || !existsSync(path)) { console.error("usage: ai-review.ts dry-run --casefile <path> [--models a,b,c]"); return 64; }
    let parsed;
    try { parsed = parseCaseFile(JSON.parse(readFileSync(path, "utf8"))); } catch (e) { console.error(`casefile unreadable: ${(e as Error).message}`); return 65; }
    if (!parsed.ok) { console.error(`casefile invalid: ${parsed.error}`); return 65; }
    const models = flag("--models")?.split(",").map(s => s.trim()).filter(Boolean) ?? [...PRIMARIES];
    const runDir = join(cfg.stateDir, "runs", `dry-${parsed.value.session}-${Math.floor(cfg.nowMs() / 1000)}`);
    mkdirSync(runDir, { recursive: true });
    const out = await reviewCaseFile(cfg, parsed.value, { runDir, deadlineMs: null, primaries: models, log });
    console.log(JSON.stringify({ decision: out.decision, models: out.models, notes: out.notes, runDir }, null, 2));
    if (out.decision) console.log(`\n--- owner message (not sent) ---\n${ownerMessage(out.decision, appliesOf(cfg, parsed.value))}`);
    return out.decision ? 0 : 3;
  }

  if (mode !== "run") { console.error("usage: ai-review.ts run | status | dry-run --casefile <path> [--models a,b,c]"); return 64; }

  if (!cfg.prodSsh || !cfg.prodDir) { console.error("AI_REVIEW_PROD_SSH and AI_REVIEW_PROD_DIR must be set (scripts/ai-review.sh defaults them)"); return 64; }
  const state = readState(statePath);
  const gate = checkSchedule(cfg.nowMs(), state);
  if (!gate.go) { log(`skipped (${gate.reason}) for ${gate.session}`); return 0; }
  const { session, deadlineMs, attempt } = gate;
  if (attempt > 1) log(`attempt ${attempt} of ${MAX_ATTEMPTS} for ${session} (the earlier one: ${state.sessions[session]?.status ?? "?"})`);
  const runDir = join(cfg.stateDir, "runs", session);
  mkdirSync(runDir, { recursive: true });
  const at = () => new Date(cfg.nowMs()).toISOString();
  markSession(statePath, session, { status: "started", at: at(), attempts: attempt });
  const finish = (status: "shipped" | "no_decision" | "failed", detail?: string) => markSession(statePath, session, { status, at: at(), detail, attempts: attempt });
  const ops = (text: string) => sendTelegram(cfg, "ops", text, log);

  const got = await fetchCaseFile(cfg, session);
  if (!got.ok) {
    log(`case file failed: ${got.error}`);
    await ops(opsFailure(session, "el expediente (ssh a prod)", got.error));
    finish("failed", "casefile");
    return 0;
  }
  writeFileSync(join(runDir, "casefile.raw.json"), got.text);

  const out = await reviewCaseFile(cfg, got.cf, { runDir, deadlineMs, primaries: PRIMARIES, log });
  if (!out.decision) {
    log(`no decision: ${out.notes.join("; ")}`);
    await ops(opsNoDecision(session, out.models, out.notes));
    finish("no_decision", out.notes.join("; "));
    return 0;
  }
  // Never ship what the bot's own reader would refuse.
  const reread = parseDecision(JSON.parse(readFileSync(join(runDir, "decision.json"), "utf8")));
  if (!reread.ok) {
    await ops(opsFailure(session, "la validación de la decisión", reread.error));
    finish("failed", "decision invalid");
    return 0;
  }
  const shipped = await shipDecision(cfg, join(runDir, "decision.json"), session);
  if (!shipped.ok) {
    log(`ship failed: ${shipped.error}`);
    await ops(opsFailure(session, "el envío de la decisión a prod", shipped.error));
    finish("failed", "ship");
    return 0;
  }
  log(`decision ${out.decision.id} shipped: ${out.decision.overrides.length} override(s) of ${out.decision.reviewed}`);
  const told = await sendTelegram(cfg, "owner", ownerMessage(out.decision, appliesOf(cfg, got.cf)), log);
  const warnings = got.cf.warnings ?? [];
  const notable = out.notes.length > 0 || warnings.length > 0 || out.models.some(m => !m.ok) || !told;
  if (notable) await ops(opsShipped(out.decision, out.notes.concat(told ? [] : ["el mensaje al dueño no salió"]), warnings));
  finish("shipped", out.decision.id);
  return 0;
}
