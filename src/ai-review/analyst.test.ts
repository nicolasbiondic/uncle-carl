import { describe, expect, test } from "bun:test";
import { askModel, keepSeenSources, type Exec, type ExecInput, type ExecOutput } from "./analyst";
import { parseStream } from "./stream";
import { caseFile, SESSION } from "./testFixtures";

const cf = caseFile();
const ev = (o: unknown) => JSON.stringify(o);
export const streamOf = (answer: string | null, tools: object[] = [], sessionID = "ses_a") =>
  [ev({ type: "step_start", sessionID }), ...tools.map(t => ev({ type: "tool_use", sessionID, part: { type: "tool", tool: (t as any).tool, state: { status: (t as any).status ?? "completed", input: (t as any).input ?? {}, output: (t as any).output ?? "" } } })),
    ...(answer === null ? [] : [ev({ type: "text", sessionID, part: { type: "text", text: answer } })])].join("\n");

const out = (stdout: string, extra: Partial<ExecOutput> = {}): ExecOutput => ({ stdout, stderr: "", code: 0, timedOut: false, seconds: 5, ...extra });
const fixedNow = () => Date.parse("2026-11-16T13:15:00Z");
const opts = (exec: Exec, extra = {}) => ({ exec, now: fixedNow, deadlineMs: null, modelTimeoutSec: 720, ...extra });

const GOOD = JSON.stringify({ session: SESSION, verdicts: { NVDA: { action: "exit", confidence: 0.8, reason: "El director sale.", sources: ["https://reuters.com/a"] } } });
const OPENED = [{ tool: "webfetch", input: { url: "https://reuters.com/a" }, output: "texto" }];

describe("askModel", () => {
  test("a valid answer is ok, records that it searched and the pages it opened", async () => {
    const calls: ExecInput[] = [];
    const r = await askModel("anthropic/claude-sonnet-5-5", cf, opts(async i => { calls.push(i); return out(streamOf(GOOD, [{ tool: "websearch", input: { query: "nvidia" }, output: "[R](https://reuters.com/a)" }, ...OPENED])); }));
    expect(r.record).toEqual({ model: "anthropic/claude-sonnet-5-5", family: "claude", ok: true, error: null, searched: true });
    expect(r.verdict?.verdicts.NVDA.action).toBe("exit");
    expect(r.fetchedUrls).toEqual(["https://reuters.com/a"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("casefile.json");
    expect(calls[0].prompt).toContain(SESSION);
  });
  test("works without a web search: searched=false, still valid (the case file's own links are enough)", async () => {
    const answer = JSON.stringify({ session: SESSION, verdicts: { NVDA: { action: "reduce", confidence: 0.7, reason: "Titular serio.", sources: ["https://example.com/NVDA/1"] } } });
    const r = await askModel("codex/gpt-6.1-sol", cf, opts(async () => out(streamOf(answer))));
    expect(r.record.ok).toBe(true);
    expect(r.record.searched).toBe(false);
  });
  test("an invalid answer gets ONE retry in the same session, telling it what was wrong; then it is valid", async () => {
    const calls: ExecInput[] = [];
    const r = await askModel("anthropic/claude-sonnet-5-5", cf, opts(async i => {
      calls.push(i);
      return calls.length === 1 ? out(streamOf('{"session":"2026-11-17","verdicts":{}}', [], "ses_first")) : out(streamOf(GOOD, OPENED, "ses_first"));
    }));
    expect(calls).toHaveLength(2);
    expect(calls[1].sessionId).toBe("ses_first");
    expect(calls[1].prompt).toContain("rechazada");
    expect(calls[1].prompt).toContain("session must be exactly");
    expect(r.record.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });
  test("still invalid after the retry: ok=false, the verdict never leaves this function, and there is no third try", async () => {
    let n = 0;
    const r = await askModel("codex/gpt-6.1-sol", cf, opts(async () => { n++; return out(streamOf("no soy JSON")); }));
    expect(n).toBe(2);
    expect(r.verdict).toBeNull();
    expect(r.record.ok).toBe(false);
    expect(r.record.error).toContain("invalid answer after one retry");
  });
  test("with no session id to continue, the retry restates the whole task", async () => {
    const prompts: string[] = [];
    await askModel("codex/gpt-6.1-sol", cf, opts(async i => { prompts.push(i.prompt); return out(ev({ type: "text", part: { text: "basura" } })); }));
    expect(prompts[1]).toContain("casefile.json");
    expect(prompts[1]).toContain("rechazada");
  });
  test("a non-keep whose links were never opened (and are not in the case file) is invalid: a made-up source never reaches the decision", async () => {
    const invented = JSON.stringify({ session: SESSION, verdicts: { NVDA: { action: "exit", confidence: 0.9, reason: "Algo grave.", sources: ["https://invented.example/story"] } } });
    const r = await askModel("anthropic/claude-sonnet-5-5", cf, opts(async () => out(streamOf(invented))));
    expect(r.record.ok).toBe(false);
    expect(r.record.error).toContain("none of the source links");
  });
  test("links the model cites but did not open are dropped when another source stands", () => {
    const stream = parseStream(streamOf(null, OPENED));
    const k = keepSeenSources({ session: SESSION, verdicts: { NVDA: { action: "exit", confidence: 0.9, reason: "x", sources: ["https://reuters.com/a", "https://invented.example/b"] } } }, cf, stream);
    expect(k.problem).toBeNull();
    expect(k.verdict.verdicts.NVDA.sources).toEqual(["https://reuters.com/a"]);
  });
  test("a timeout, a provider error and a crash are failures with their reason, and are not retried", async () => {
    let n = 0;
    const t = await askModel("m/a", cf, opts(async () => { n++; return out("", { timedOut: true, code: 124, seconds: 720 }); }));
    expect(t.record.error).toContain("timed out");
    const e = await askModel("opencode-go/kimi-k3.1-pro", cf, opts(async () => { n++; return out(ev({ type: "error", error: { message: "OpenCode Go requires an API key" } }), { code: 1 }); }));
    expect(e.record.error).toContain("requires an API key");
    const c = await askModel("m/b", cf, opts(async () => { n++; return out("", { code: 2, stderr: "boom" }); }));
    expect(c.record.error).toContain("exited 2");
    expect(n).toBe(3);
  });
  test("the deadline stops a model from starting and from retrying", async () => {
    let n = 0;
    const late = await askModel("m/a", cf, opts(async () => { n++; return out(streamOf(GOOD)); }, { deadlineMs: fixedNow() + 10_000 }));
    expect(late.record.error).toContain("deadline");
    expect(n).toBe(0);
    const noRetry = await askModel("m/b", cf, opts(async () => { n++; return out(streamOf("basura")); }, { deadlineMs: fixedNow() + 50_000 }));
    expect(n).toBe(1);
    expect(noRetry.record.error).toContain("no time for the retry");
  });
  test("each call gets at most the model timeout, and never more than the time left to the deadline", async () => {
    const seen: number[] = [];
    await askModel("m/a", cf, opts(async i => { seen.push(i.timeoutSec); return out(streamOf(GOOD, OPENED)); }, { deadlineMs: fixedNow() + 300_000 }));
    expect(seen).toEqual([300]);
    await askModel("m/a", cf, opts(async i => { seen.push(i.timeoutSec); return out(streamOf(GOOD, OPENED)); }));
    expect(seen[1]).toBe(720);
  });
});
