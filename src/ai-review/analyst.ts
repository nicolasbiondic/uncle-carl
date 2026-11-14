// One model, one case file: run the agent, read its event stream, validate the answer strictly, and on an
// invalid answer ask ONCE more telling it what was wrong; after that the model is `ok: false`.
// `exec` is injected (the real one spawns `opencode run`), so no test needs a model.
// Enforced: src/ai-review/analyst.test.ts.

import { parseModelVerdict, type CaseFile, type ModelRecord, type ModelVerdict } from "./contract";
import { familyOf } from "./models";
import { normalizeUrl, parseStream, type StreamResult } from "./stream";

export interface ExecInput {
  model: string;
  prompt: string;
  /** Continue this OpenCode session (the retry keeps the research already done). */
  sessionId?: string;
  timeoutSec: number;
  /** File name stem for the raw event stream in the run directory. */
  tag: string;
}
export interface ExecOutput { stdout: string; stderr: string; code: number; timedOut: boolean; seconds: number }
export type Exec = (input: ExecInput) => Promise<ExecOutput>;

export interface AskOptions {
  exec: Exec;
  now: () => number;
  /** Absolute instant after which nothing new starts (null = none). */
  deadlineMs: number | null;
  modelTimeoutSec: number;
  log?: (msg: string) => void;
}

export interface AskResult {
  record: ModelRecord;
  verdict: ModelVerdict | null;
  attempts: number;
  seconds: number;
  fetchedUrls: string[];
  costUsd: number;
}

const MIN_RETRY_SEC = 60;

export function firstPrompt(cf: CaseFile): string {
  return `Sesión de bolsa: ${cf.session}. Lee el archivo casefile.json de este directorio y decide, según tus instrucciones, qué acciones del expediente no conviene mantener. Tu último mensaje es SOLO el JSON, con "session":"${cf.session}".`;
}

export function retryPrompt(problem: string, cf: CaseFile): string {
  return `Tu respuesta fue rechazada por el validador: ${problem}. Corrígela y responde de nuevo SOLO el JSON, con "session":"${cf.session}", sin texto alrededor.`;
}

function caseUrls(cf: CaseFile): Set<string> {
  return new Set(cf.sleeves.flatMap(s => s.symbols.flatMap(y => y.news.map(n => normalizeUrl(n.url)))));
}

/**
 * A source must be a link the run opened or saw in a web tool's result, or one the case file itself carries.
 * Links a model invented are dropped; a non-keep verdict left with no source makes the whole answer invalid.
 */
export function keepSeenSources(v: ModelVerdict, cf: CaseFile, stream: StreamResult): { verdict: ModelVerdict; problem: string | null } {
  const allowed = new Set([...caseUrls(cf), ...stream.seenUrls]);
  const verdicts: ModelVerdict["verdicts"] = {};
  for (const [symbol, x] of Object.entries(v.verdicts)) {
    const sources = x.sources.filter(u => allowed.has(normalizeUrl(u)));
    if (x.action !== "keep" && sources.length === 0) {
      return { verdict: v, problem: `${symbol}: none of the source links appears among the pages you opened or in the case file; open the pages with webfetch and cite only those` };
    }
    verdicts[symbol] = { ...x, sources };
  }
  return { verdict: { session: v.session, verdicts }, problem: null };
}

const tail = (s: string, n = 200) => s.replace(/\s+/g, " ").trim().slice(-n);

export async function askModel(model: string, cf: CaseFile, o: AskOptions): Promise<AskResult> {
  const family = familyOf(model);
  const fetched: string[] = [];
  let searched = false;
  let seconds = 0;
  let cost = 0;
  const fail = (error: string, attempts: number): AskResult => ({
    record: { model, family, ok: false, error: error.slice(0, 300), searched }, verdict: null, attempts, seconds, fetchedUrls: fetched, costUsd: cost,
  });

  let prompt = firstPrompt(cf);
  let sessionId: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const left = o.deadlineMs === null ? Infinity : Math.floor((o.deadlineMs - o.now()) / 1000);
    if (left < (attempt === 1 ? 30 : MIN_RETRY_SEC)) return fail(attempt === 1 ? "deadline reached before the model could start" : "deadline reached, no time for the retry", attempt - 1);
    const out = await o.exec({ model, prompt, sessionId, timeoutSec: Math.min(o.modelTimeoutSec, left), tag: `${family}-${attempt}` });
    seconds += out.seconds;
    const s = parseStream(out.stdout);
    searched ||= s.searched;
    fetched.push(...s.fetchedUrls);
    cost += s.costUsd;
    if (out.timedOut) return fail(`timed out after ${Math.round(out.seconds)} s`, attempt);
    if (s.error && !s.answer) return fail(`model error: ${s.error}`, attempt);
    if (out.code !== 0 && !s.answer) return fail(`opencode exited ${out.code}: ${tail(out.stderr) || tail(out.stdout)}`, attempt);

    let problem: string | null;
    let verdict: ModelVerdict | null = null;
    if (!s.answer) problem = "the run produced no text answer";
    else {
      const p = parseModelVerdict(s.answer, cf);
      if (!p.ok) problem = p.error;
      else {
        const k = keepSeenSources(p.value, cf, s);
        problem = k.problem;
        if (!problem) verdict = k.verdict;
      }
    }
    if (verdict) {
      o.log?.(`${model}: valid verdict (${Object.keys(verdict.verdicts).length} symbol(s), attempt ${attempt}, ${Math.round(seconds)} s, searched=${searched})`);
      return { record: { model, family, ok: true, error: null, searched }, verdict, attempts: attempt, seconds, fetchedUrls: fetched, costUsd: cost };
    }
    o.log?.(`${model}: invalid answer on attempt ${attempt}: ${problem}`);
    if (attempt === 2) return fail(`invalid answer after one retry: ${problem}`, 2);
    sessionId = s.sessionId ?? undefined;
    // Without a session to continue, the second run starts cold: it needs the whole task again.
    prompt = sessionId ? retryPrompt(problem!, cf) : `${firstPrompt(cf)} ${retryPrompt(problem!, cf)}`;
  }
  return fail("unreachable", 2);
}
