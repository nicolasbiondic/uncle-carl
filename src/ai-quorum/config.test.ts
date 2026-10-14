import { describe, expect, test } from "bun:test";
import { loadQuorumConfig } from "./config";

describe("loadQuorumConfig", () => {
  test("no keys → pending mode with defaults", () => {
    const c = loadQuorumConfig({});
    expect(c.pending).toBe(true);
    expect(c.providers).toEqual([]);
    expect(c.timeoutMs).toBe(60_000);
    expect(c.retries).toBe(2);
    expect(c.maxDailyUsd).toBe(1.0);
    expect(c.dbPath).toBe("data/ai-quorum.db");
    expect(c.historicalDbPath).toBe("data/historical.db");
  });

  test("OpenRouter key + three models of distinct families", () => {
    const c = loadQuorumConfig({
      AI_QUORUM_OPENROUTER_API_KEY: "sk-or-x",
      AI_QUORUM_OPENROUTER_MODELS: "anthropic/claude-sonnet-4.5, openai/gpt-5-mini ,google/gemini-2.5-flash",
    });
    expect(c.pending).toBe(false);
    expect(c.providers.map((p) => p.family)).toEqual(["anthropic", "openai", "google"]);
    expect(c.providers.every((p) => p.kind === "openrouter")).toBe(true);
    expect(c.providers[0].id).toBe("openrouter:anthropic/claude-sonnet-4.5");
  });

  test("three direct keys work too", () => {
    const c = loadQuorumConfig({
      AI_QUORUM_ANTHROPIC_API_KEY: "a", AI_QUORUM_ANTHROPIC_MODEL: "claude-sonnet-4-5",
      AI_QUORUM_OPENAI_API_KEY: "b", AI_QUORUM_OPENAI_MODEL: "gpt-5-mini",
      AI_QUORUM_GOOGLE_API_KEY: "c", AI_QUORUM_GOOGLE_MODEL: "gemini-2.5-flash",
    });
    expect(c.providers.length).toBe(3);
    expect(new Set(c.providers.map((p) => p.family)).size).toBe(3);
  });

  test("two models only → hard error (the quorum is pre-registered as 3)", () => {
    expect(() => loadQuorumConfig({
      AI_QUORUM_OPENROUTER_API_KEY: "k",
      AI_QUORUM_OPENROUTER_MODELS: "anthropic/claude-sonnet-4.5,openai/gpt-5-mini",
    })).toThrow(/exactly 3/);
  });

  test("three models but two share a family → hard error", () => {
    expect(() => loadQuorumConfig({
      AI_QUORUM_OPENROUTER_API_KEY: "k",
      AI_QUORUM_OPENROUTER_MODELS: "openai/gpt-5,openai/gpt-5-mini,google/gemini-2.5-flash",
    })).toThrow(/distinct families/);
  });

  test("models without the key, or key without the model → hard error", () => {
    expect(() => loadQuorumConfig({ AI_QUORUM_OPENROUTER_MODELS: "a/b,c/d,e/f" })).toThrow(/API_KEY/);
    expect(() => loadQuorumConfig({ AI_QUORUM_OPENAI_API_KEY: "k" })).toThrow(/MODEL/);
  });

  test("generic proxy: base URL + key + three family/model ids", () => {
    const c = loadQuorumConfig({
      AI_QUORUM_PROXY_BASE_URL: "http://localhost:8317/v1/",
      AI_QUORUM_PROXY_API_KEY: "proxy-k",
      AI_QUORUM_PROXY_MODELS: "anthropic/claude-sonnet-5-5, google/gemini-3.1-pro-low ,openai/gpt-oss-120b-medium",
    });
    expect(c.pending).toBe(false);
    expect(c.providers.map((p) => p.family)).toEqual(["anthropic", "google", "openai"]);
    expect(c.providers.every((p) => p.kind === "proxy")).toBe(true);
    // base URL trailing slash normalized; model id sent WITHOUT the family prefix.
    expect(c.providers[0]).toEqual({
      id: "proxy:anthropic/claude-sonnet-5-5",
      family: "anthropic",
      kind: "proxy",
      model: "claude-sonnet-5-5",
      apiKey: "proxy-k",
      baseUrl: "http://localhost:8317/v1",
    });
  });

  test("proxy mixes with a direct key to make up the 3 distinct families", () => {
    const c = loadQuorumConfig({
      AI_QUORUM_PROXY_BASE_URL: "http://host:8317/v1",
      AI_QUORUM_PROXY_API_KEY: "k",
      AI_QUORUM_PROXY_MODELS: "anthropic/claude-sonnet-5-5,google/gemini-3.1-pro-low",
      AI_QUORUM_OPENAI_API_KEY: "ok",
      AI_QUORUM_OPENAI_MODEL: "gpt-5-mini",
    });
    expect(c.providers.length).toBe(3);
    expect(new Set(c.providers.map((p) => p.family)).size).toBe(3);
  });

  test("proxy: models without base URL/key, or base URL/key without models → hard error", () => {
    expect(() => loadQuorumConfig({ AI_QUORUM_PROXY_MODELS: "anthropic/a,google/b,openai/c" })).toThrow(/BASE_URL/);
    expect(() => loadQuorumConfig({
      AI_QUORUM_PROXY_BASE_URL: "http://host:8317/v1", AI_QUORUM_PROXY_API_KEY: "k",
    })).toThrow(/MODELS/);
    expect(() => loadQuorumConfig({ AI_QUORUM_PROXY_BASE_URL: "http://host:8317/v1" })).toThrow(/MODELS/);
  });

  test("proxy: an entry without a '/' is rejected — family must be explicit", () => {
    expect(() => loadQuorumConfig({
      AI_QUORUM_PROXY_BASE_URL: "http://host:8317/v1", AI_QUORUM_PROXY_API_KEY: "k",
      AI_QUORUM_PROXY_MODELS: "anthropic/a,geminipro,openai/c",
    })).toThrow(/family must be explicit/);
  });

  test("invalid numerics are rejected, valid overrides honored", () => {
    expect(() => loadQuorumConfig({ AI_QUORUM_MAX_DAILY_USD: "-5" })).toThrow();
    expect(loadQuorumConfig({ AI_QUORUM_MAX_DAILY_USD: "2.5", AI_QUORUM_TIMEOUT_MS: "30000" }).maxDailyUsd).toBe(2.5);
  });
});
