// Strict validation of a model's raw text response (línea D).
// The contract sent in the prompt: a single JSON object mapping EVERY
// requested symbol to {"view":"long"|"short"|"neutral","confidence":0..1}.
// Spanish views (largo/corto) are accepted and normalized. Anything else —
// missing symbol, out-of-range confidence, unknown view, non-object — throws,
// and the caller retries (bounded) or records the model call as failed.

import type { ModelView, ModelViews, View } from "./types";

const VIEW_ALIASES: Record<string, View> = {
  long: "long", largo: "long", buy: "long", bullish: "long",
  short: "short", corto: "short", sell: "short", bearish: "short",
  neutral: "neutral", flat: "neutral", hold: "neutral",
};

/** Pull the first JSON object out of a raw LLM reply (code fences, prose). */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object found in model response");
  }
  return body.slice(start, end + 1);
}

export function validateModelViews(raw: string, symbols: string[]): ModelViews {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (e: any) {
    throw new Error(`model response is not valid JSON: ${e?.message ?? e}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model response is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const out: ModelViews = {};
  for (const symbol of symbols) {
    const entry = obj[symbol];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`missing or invalid entry for symbol ${symbol}`);
    }
    const e = entry as Record<string, unknown>;
    const viewRaw = typeof e.view === "string" ? e.view.toLowerCase().trim() : "";
    const view = VIEW_ALIASES[viewRaw];
    if (!view) throw new Error(`invalid view "${String(e.view)}" for ${symbol}`);
    const confidence = e.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`invalid confidence "${String(confidence)}" for ${symbol} (must be a number in [0,1])`);
    }
    out[symbol] = { view, confidence } satisfies ModelView;
  }
  return out;
}
