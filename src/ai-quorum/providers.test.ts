import { describe, expect, test } from "bun:test";
import { callProvider, parseEnvelope, requestFor } from "./providers";
import type { ProviderSpec } from "./types";

const SYMS = ["SPY", "QQQ"];
const GOOD_VIEWS = { SPY: { view: "long", confidence: 0.8 }, QQQ: { view: "neutral", confidence: 0.3 } };
const OPTS = { timeoutMs: 1_000, retries: 2, estCostPerCallUsd: 0.02, sleepFn: async () => {} };

const spec = (kind: ProviderSpec["kind"], model = "m1"): ProviderSpec =>
  ({
    id: `${kind}:${model}`, family: kind === "openrouter" ? "anthropic" : kind, kind, model, apiKey: "k",
    ...(kind === "proxy" ? { baseUrl: "http://localhost:8317/v1" } : {}),
  });

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function fetchOnce(handler: (url: string, init: RequestInit) => Response | Promise<Response>): { fn: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("requestFor / parseEnvelope per provider", () => {
  test("openrouter: chat-completions shape, cost comes from usage.cost", () => {
    const { url, body } = requestFor(spec("openrouter", "anthropic/claude-x"), "hi");
    expect(url).toContain("openrouter.ai");
    expect((body as any).usage).toEqual({ include: true });
    const parsed = parseEnvelope(spec("openrouter"), {
      choices: [{ message: { content: "{}" } }],
      usage: { cost: 0.0042, prompt_tokens: 100, completion_tokens: 50 },
    });
    expect(parsed.costUsd).toBe(0.0042);
    expect(parsed.tokensIn).toBe(100);
  });

  test("anthropic: messages API, text blocks joined", () => {
    const { url } = requestFor(spec("anthropic"), "hi");
    expect(url).toContain("api.anthropic.com/v1/messages");
    const parsed = parseEnvelope(spec("anthropic"), {
      content: [{ type: "text", text: "{\"a\":" }, { type: "text", text: "1}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(parsed.text).toBe('{"a":1}');
    expect(parsed.costUsd).toBeNull();
  });

  test("openai: chat completions", () => {
    const parsed = parseEnvelope(spec("openai"), {
      choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    expect(parsed.tokensOut).toBe(3);
  });

  test("google: generateContent with key in URL and parts joined", () => {
    const { url } = requestFor(spec("google", "gemini-2.5-flash"), "hi");
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("key=k");
    const parsed = parseEnvelope(spec("google"), {
      candidates: [{ content: { parts: [{ text: "{}" }] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
    });
    expect(parsed.tokensIn).toBe(9);
  });

  test("malformed envelope throws", () => {
    expect(() => parseEnvelope(spec("openai"), { choices: [] })).toThrow();
    expect(() => parseEnvelope(spec("google"), {})).toThrow();
  });

  test("proxy: chat-completions shape at {baseUrl}/chat/completions, model sent without the family prefix", () => {
    const { url, body } = requestFor(spec("proxy", "claude-sonnet-5-5"), "hi");
    expect(url).toBe("http://localhost:8317/v1/chat/completions");
    expect((body as any).model).toBe("claude-sonnet-5-5");
    expect((body as any).messages).toEqual([{ role: "user", content: "hi" }]);
    const parsed = parseEnvelope(spec("proxy"), {
      choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 12, completion_tokens: 6 },
    });
    expect(parsed.tokensIn).toBe(12);
    expect(parsed.costUsd).toBeNull();
  });
});

describe("callProvider", () => {
  test("happy path: validated views + headers for the provider", async () => {
    const { fn, calls } = fetchOnce(() => jsonResponse({
      choices: [{ message: { content: JSON.stringify(GOOD_VIEWS) } }],
      usage: { cost: 0.001, prompt_tokens: 1, completion_tokens: 1 },
    }));
    const r = await callProvider(spec("openrouter"), "prompt", SYMS, { ...OPTS, fetchFn: fn });
    expect(r.views.SPY.view).toBe("long");
    expect(r.costUsd).toBe(0.001);
    expect((calls[0].init.headers as any).Authorization).toBe("Bearer k");
  });

  test("anthropic key header, estimated cost when API reports none", async () => {
    const { fn, calls } = fetchOnce(() => jsonResponse({
      content: [{ type: "text", text: JSON.stringify(GOOD_VIEWS) }], usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const r = await callProvider(spec("anthropic"), "prompt", SYMS, { ...OPTS, fetchFn: fn });
    expect((calls[0].init.headers as any)["x-api-key"]).toBe("k");
    expect(r.costUsd).toBe(0.02); // estCostPerCallUsd — cap errs conservative
  });

  test("retries after HTTP 500, succeeds on second attempt", async () => {
    let n = 0;
    const { fn, calls } = fetchOnce(() => {
      n++;
      if (n === 1) return new Response("boom", { status: 500 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(GOOD_VIEWS) } }], usage: {} });
    });
    const r = await callProvider(spec("openai"), "p", SYMS, { ...OPTS, fetchFn: fn });
    expect(calls.length).toBe(2);
    expect(r.views.QQQ.view).toBe("neutral");
  });

  test("invalid JSON every attempt → throws after retries+1 attempts", async () => {
    const { fn, calls } = fetchOnce(() => jsonResponse({
      choices: [{ message: { content: "not json at all" } }], usage: {},
    }));
    await expect(callProvider(spec("openai"), "p", SYMS, { ...OPTS, fetchFn: fn })).rejects.toThrow(/all 3 attempts/);
    expect(calls.length).toBe(3);
  });

  test("network timeout/abort is retried and finally thrown", async () => {
    const { fn, calls } = fetchOnce(() => { throw new Error("The operation timed out"); });
    await expect(callProvider(spec("google"), "p", SYMS, { ...OPTS, fetchFn: fn })).rejects.toThrow(/timed out/);
    expect(calls.length).toBe(3);
  });

  test("proxy: Bearer header, hits {baseUrl}/chat/completions, estimated cost (proxy reports none)", async () => {
    const { fn, calls } = fetchOnce(() => jsonResponse({
      choices: [{ message: { content: JSON.stringify(GOOD_VIEWS) } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const r = await callProvider(spec("proxy"), "prompt", SYMS, { ...OPTS, fetchFn: fn });
    expect(calls[0].url).toBe("http://localhost:8317/v1/chat/completions");
    expect((calls[0].init.headers as any).Authorization).toBe("Bearer k");
    expect(JSON.parse(calls[0].init.body as string).model).toBe("m1");
    expect(r.views.SPY.view).toBe("long");
    expect(r.costUsd).toBe(0.02); // estCostPerCallUsd — the proxy doesn't report cost
  });

  test("proxy: a model wrapping its JSON in ```json fences still validates", async () => {
    const fenced = "Here you go:\n```json\n" + JSON.stringify(GOOD_VIEWS) + "\n```\n";
    const { fn } = fetchOnce(() => jsonResponse({
      choices: [{ message: { content: fenced } }], usage: {},
    }));
    const r = await callProvider(spec("proxy"), "prompt", SYMS, { ...OPTS, fetchFn: fn });
    expect(r.views.SPY.view).toBe("long");
    expect(r.views.QQQ.view).toBe("neutral");
  });

  test("response missing a symbol is rejected by strict validation → retry", async () => {
    let n = 0;
    const { fn } = fetchOnce(() => {
      n++;
      const views = n === 1 ? { SPY: GOOD_VIEWS.SPY } : GOOD_VIEWS;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(views) } }], usage: {} });
    });
    const r = await callProvider(spec("openai"), "p", SYMS, { ...OPTS, fetchFn: fn });
    expect(n).toBe(2);
    expect(r.views.QQQ).toBeDefined();
  });
});
