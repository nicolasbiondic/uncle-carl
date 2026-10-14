// AI_QUORUM_* env parsing (documented in .env.example and
// docs/platform/self-hosting.md). Pure function of an env map for tests.
//
// Key design points:
//   - NO keys configured → mode "pending": the daily snapshot is still built
//     and persisted, but nobody is called (the experiment clock starts at the
//     first decision WITH keys — §12-D).
//   - Keys configured → EXACTLY three models of three DISTINCT families, via
//     OpenRouter (one key, "family/model" ids) and/or direct provider keys.
//     Anything else is a hard config error: better to crash the cron run
//     loudly than to run a quorum that isn't the pre-registered one.

import type { ProviderSpec } from "./types";

export interface QuorumConfig {
  providers: ProviderSpec[];      // [] = pending mode
  pending: boolean;
  timeoutMs: number;
  retries: number;
  maxDailyUsd: number;
  estCostPerCallUsd: number;
  dbPath: string;
  historicalDbPath: string;
}

export const REQUIRED_MODEL_COUNT = 3;

function familyOfOpenRouterModel(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash).toLowerCase() : model.toLowerCase();
}

export function loadQuorumConfig(env: Record<string, string | undefined> = process.env): QuorumConfig {
  const providers: ProviderSpec[] = [];

  const orKey = env.AI_QUORUM_OPENROUTER_API_KEY?.trim();
  const orModels = (env.AI_QUORUM_OPENROUTER_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (orKey && orModels.length > 0) {
    for (const model of orModels) {
      providers.push({
        id: `openrouter:${model}`,
        family: familyOfOpenRouterModel(model),
        kind: "openrouter",
        model,
        apiKey: orKey,
      });
    }
  } else if (orModels.length > 0 && !orKey) {
    throw new Error("AI_QUORUM_OPENROUTER_MODELS is set but AI_QUORUM_OPENROUTER_API_KEY is missing");
  }

  const direct: Array<{ kind: "anthropic" | "openai" | "google"; key?: string; model?: string }> = [
    { kind: "anthropic", key: env.AI_QUORUM_ANTHROPIC_API_KEY?.trim(), model: env.AI_QUORUM_ANTHROPIC_MODEL?.trim() },
    { kind: "openai", key: env.AI_QUORUM_OPENAI_API_KEY?.trim(), model: env.AI_QUORUM_OPENAI_MODEL?.trim() },
    { kind: "google", key: env.AI_QUORUM_GOOGLE_API_KEY?.trim(), model: env.AI_QUORUM_GOOGLE_MODEL?.trim() },
  ];
  for (const d of direct) {
    if (d.key && d.model) {
      providers.push({ id: `${d.kind}:${d.model}`, family: d.kind, kind: d.kind, model: d.model, apiKey: d.key });
    } else if (d.key && !d.model) {
      throw new Error(`AI_QUORUM_${d.kind.toUpperCase()}_API_KEY is set but AI_QUORUM_${d.kind.toUpperCase()}_MODEL is missing`);
    }
  }

  // Generic OpenAI-compatible proxy (e.g. a local CLIProxyAPI): one base URL +
  // one key, several "family/model" ids — family must be explicit (the proxy
  // itself doesn't carry one), model is sent to the server verbatim.
  const proxyBaseUrlRaw = env.AI_QUORUM_PROXY_BASE_URL?.trim();
  const proxyBaseUrl = proxyBaseUrlRaw ? proxyBaseUrlRaw.replace(/\/+$/, "") : undefined;
  const proxyKey = env.AI_QUORUM_PROXY_API_KEY?.trim();
  const proxyModels = (env.AI_QUORUM_PROXY_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (proxyModels.length > 0 && proxyBaseUrl && proxyKey) {
    for (const entry of proxyModels) {
      const slash = entry.indexOf("/");
      if (slash <= 0 || slash === entry.length - 1) {
        throw new Error(`AI_QUORUM_PROXY_MODELS entry "${entry}" must be "family/model" (the family must be explicit)`);
      }
      const family = entry.slice(0, slash).toLowerCase();
      const model = entry.slice(slash + 1);
      providers.push({ id: `proxy:${family}/${model}`, family, kind: "proxy", model, apiKey: proxyKey, baseUrl: proxyBaseUrl });
    }
  } else if (proxyModels.length > 0 && (!proxyBaseUrl || !proxyKey)) {
    throw new Error("AI_QUORUM_PROXY_MODELS is set but AI_QUORUM_PROXY_BASE_URL and/or AI_QUORUM_PROXY_API_KEY is missing");
  } else if (proxyModels.length === 0 && (proxyBaseUrl || proxyKey)) {
    throw new Error("AI_QUORUM_PROXY_BASE_URL/AI_QUORUM_PROXY_API_KEY are set but AI_QUORUM_PROXY_MODELS is missing");
  }

  if (providers.length > 0) {
    if (providers.length !== REQUIRED_MODEL_COUNT) {
      throw new Error(`AI quorum needs exactly ${REQUIRED_MODEL_COUNT} models, got ${providers.length} (${providers.map((p) => p.id).join(", ")})`);
    }
    const families = new Set(providers.map((p) => p.family));
    if (families.size !== REQUIRED_MODEL_COUNT) {
      throw new Error(`the ${REQUIRED_MODEL_COUNT} quorum models must come from distinct families, got: ${providers.map((p) => p.family).join(", ")}`);
    }
  }

  const num = (v: string | undefined, dflt: number): number => {
    if (v == null || v.trim() === "") return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid numeric AI_QUORUM value: "${v}"`);
    return n;
  };

  return {
    providers,
    pending: providers.length === 0,
    timeoutMs: num(env.AI_QUORUM_TIMEOUT_MS, 60_000),
    retries: num(env.AI_QUORUM_RETRIES, 2),
    maxDailyUsd: num(env.AI_QUORUM_MAX_DAILY_USD, 1.0),
    estCostPerCallUsd: num(env.AI_QUORUM_EST_COST_PER_CALL_USD, 0.02),
    dbPath: env.AI_QUORUM_DB_PATH?.trim() || "data/ai-quorum.db",
    historicalDbPath: env.AI_QUORUM_HISTORICAL_DB_PATH?.trim() || "data/historical.db",
  };
}
