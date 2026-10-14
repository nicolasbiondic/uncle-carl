// Provider clients for the AI quorum (línea D), behind ONE interface:
// callProvider(spec, prompt, symbols, opts) → validated views + cost/tokens.
//
// Supported kinds: openrouter (one key, models of several families),
// anthropic, openai, google — all plain fetch, no SDKs, DI'd fetch for tests.
// Per call: hard timeout (AbortSignal), bounded retries with backoff, STRICT
// JSON validation (validate.ts). Cost: OpenRouter reports USD per call
// (usage.include); direct APIs report tokens only, so cost is estimated with
// a configurable per-call figure (config.estCostPerCallUsd) when unknown —
// the daily cap consumes whichever is larger, so the cap errs conservative.

import type { ModelCallResult, ProviderSpec } from "./types";
import { validateModelViews } from "./validate";

export interface CallOpts {
  fetchFn?: typeof fetch;
  timeoutMs: number;
  /** Additional attempts after the first (2 → up to 3 attempts). */
  retries: number;
  /** USD charged against the daily cap when the API doesn't report cost. */
  estCostPerCallUsd: number;
  /** Test hook: skip the real inter-retry sleep. */
  sleepFn?: (ms: number) => Promise<void>;
}

interface RawCall { text: string; costUsd: number | null; tokensIn: number; tokensOut: number; }

function headersFor(spec: ProviderSpec): Record<string, string> {
  switch (spec.kind) {
    case "openrouter":
      return { "Content-Type": "application/json", Authorization: `Bearer ${spec.apiKey}` };
    case "anthropic":
      return { "Content-Type": "application/json", "x-api-key": spec.apiKey, "anthropic-version": "2023-06-01" };
    case "openai":
    case "proxy":
      return { "Content-Type": "application/json", Authorization: `Bearer ${spec.apiKey}` };
    case "google":
      return { "Content-Type": "application/json" };
  }
}

export function requestFor(spec: ProviderSpec, prompt: string): { url: string; body: unknown } {
  switch (spec.kind) {
    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/chat/completions",
        body: {
          model: spec.model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          usage: { include: true },
        },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        body: {
          model: spec.model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        },
      };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        body: { model: spec.model, max_tokens: 4000, messages: [{ role: "user", content: prompt }] },
      };
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(spec.model)}:generateContent?key=${encodeURIComponent(spec.apiKey)}`,
        body: {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        },
      };
    case "proxy":
      // Generic OpenAI-compatible server (e.g. a local CLIProxyAPI): model id
      // sent WITHOUT the "family/" prefix (that prefix only selects the
      // family for the quorum's distinct-families rule, config.ts strips it).
      // No response_format — not every backend behind the proxy honors it,
      // which is exactly why some wrap their JSON in ```json fences (validate.ts
      // strips those before strict validation).
      return {
        url: `${spec.baseUrl}/chat/completions`,
        body: { model: spec.model, messages: [{ role: "user", content: prompt }] },
      };
  }
}

/** Parse each API's envelope down to {text, cost, tokens}. Throws on shape surprises. */
export function parseEnvelope(spec: ProviderSpec, json: any): RawCall {
  switch (spec.kind) {
    case "openrouter": {
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("openrouter: no message content");
      return {
        text,
        costUsd: typeof json?.usage?.cost === "number" ? json.usage.cost : null,
        tokensIn: json?.usage?.prompt_tokens ?? 0,
        tokensOut: json?.usage?.completion_tokens ?? 0,
      };
    }
    case "openai":
    case "proxy": {
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error(`${spec.kind}: no message content`);
      return { text, costUsd: null, tokensIn: json?.usage?.prompt_tokens ?? 0, tokensOut: json?.usage?.completion_tokens ?? 0 };
    }
    case "anthropic": {
      const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
      const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("");
      if (!text) throw new Error("anthropic: no text content");
      return { text, costUsd: null, tokensIn: json?.usage?.input_tokens ?? 0, tokensOut: json?.usage?.output_tokens ?? 0 };
    }
    case "google": {
      const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p?.text ?? "").join("");
      if (!text) throw new Error("google: no candidate text");
      return {
        text,
        costUsd: null,
        tokensIn: json?.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: json?.usageMetadata?.candidatesTokenCount ?? 0,
      };
    }
  }
}

/**
 * One provider call with timeout + retries + strict validation.
 * Throws after exhausting retries; the runner records the failure and the
 * quorum simply proceeds with the models that answered (≥2 still required).
 */
export async function callProvider(
  spec: ProviderSpec,
  prompt: string,
  symbols: string[],
  opts: CallOpts,
): Promise<ModelCallResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { url, body } = requestFor(spec, prompt);
  let lastError: unknown;
  const started = Date.now();
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: headersFor(spec),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const raw = parseEnvelope(spec, await res.json());
      const views = validateModelViews(raw.text, symbols);
      return {
        views,
        costUsd: Math.max(raw.costUsd ?? 0, raw.costUsd == null ? opts.estCostPerCallUsd : 0),
        tokensIn: raw.tokensIn,
        tokensOut: raw.tokensOut,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`${spec.id}: all ${opts.retries + 1} attempts failed — last: ${(lastError as any)?.message ?? lastError}`);
}
