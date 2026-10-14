import { describe, expect, test } from "bun:test";
import { loadQuorumConfig } from "./config";
import { runCycle } from "./runner";
import { insertDailyBar, memHistoricalDb, memQuorumDb, stockDay } from "./testFixtures";

const NOW = Date.UTC(2026, 9, 8, 21, 15); // stocks decision time, 21:15 UTC

function histWithBars() {
  const hist = memHistoricalDb();
  // 70 daily bars for SPY and QQQ (enough for ret63; longer SMAs stay null).
  for (let i = 0; i < 70; i++) {
    const ts = stockDay(2026, 10, 8) - (69 - i) * 86_400_000;
    insertDailyBar(hist, "SPY", ts, 500 + i, 500 + i);
    insertDailyBar(hist, "QQQ", ts, 400 + i, 400 + i);
  }
  return hist;
}

const PENDING = loadQuorumConfig({});
const ACTIVE = loadQuorumConfig({
  AI_QUORUM_OPENROUTER_API_KEY: "k",
  AI_QUORUM_OPENROUTER_MODELS: "anthropic/model-a,openai/model-b,google/model-c",
  AI_QUORUM_EST_COST_PER_CALL_USD: "0.02",
});

/** OpenRouter-shaped mock: per-model behavior keyed on the request body. */
function mockFetch(byModel: Record<string, (symbols: string[]) => unknown | Error>): typeof fetch {
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const handler = byModel[body.model];
    // The prompt lists one "symbol | ..." row per universe symbol — recover them.
    const symbols = [...body.messages[0].content.matchAll(/^([A-Z/]+) \| /gm)].map((m: any) => m[1]);
    const result = handler(symbols);
    if (result instanceof Error) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(result) } }],
      usage: { cost: 0.003, prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const allViews = (view: "long" | "short" | "neutral", confidence: number) =>
  (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, { view, confidence }]));

describe("runCycle — pending mode (no keys)", () => {
  test("stores the snapshot, calls nobody, and is idempotent per (class, day)", async () => {
    const qdb = memQuorumDb();
    const hist = histWithBars();
    const r1 = await runCycle(PENDING, "stocks", { qdb, hist, now: () => NOW });
    expect(r1.status).toBe("pending_keys");
    expect(r1.snapshotId).not.toBeNull();

    const snap = qdb.query<any, []>("SELECT * FROM snapshots").get();
    expect(snap.status).toBe("pending_keys");
    expect(snap.date_key).toBe("2026-10-08");
    const payload = JSON.parse(snap.payload);
    expect(payload.symbols.map((s: any) => s.symbol)).toEqual(["SPY", "QQQ"]);
    expect(payload.symbols[0].ret63).not.toBeNull();
    expect(qdb.query<any, []>("SELECT COUNT(*) AS n FROM model_calls").get().n).toBe(0);

    // Second run, same UTC day → idempotent skip.
    const r2 = await runCycle(PENDING, "stocks", { qdb, hist, now: () => NOW + 60_000 });
    expect(r2.status).toBe("filled_only");
    expect(qdb.query<any, []>("SELECT COUNT(*) AS n FROM snapshots").get().n).toBe(1);
  });

  test("refuses to snapshot an empty universe (no bars at all)", async () => {
    const qdb = memQuorumDb();
    const hist = memHistoricalDb();
    const r = await runCycle(PENDING, "stocks", { qdb, hist, now: () => NOW });
    expect(r.status).toBe("failed");
    expect(qdb.query<any, []>("SELECT COUNT(*) AS n FROM snapshots").get().n).toBe(0);
  });
});

describe("runCycle — active mode", () => {
  test("3 models answer, quorum computed, views/calls/positions persisted", async () => {
    const qdb = memQuorumDb();
    const hist = histWithBars();
    const fetchFn = mockFetch({
      "anthropic/model-a": allViews("long", 0.8),
      "openai/model-b": allViews("long", 0.7),
      "google/model-c": allViews("short", 0.9),
    });
    const r = await runCycle(ACTIVE, "stocks", { qdb, hist, now: () => NOW, fetchFn });
    expect(r.status).toBe("ok");
    expect(r.modelsAnswered).toBe(3);
    expect(r.positions).toBe(2); // SPY + QQQ long (2 of 3 agree, mean 0.75)

    expect(qdb.query<any, []>("SELECT COUNT(*) AS n FROM model_views").get().n).toBe(6);
    expect(qdb.query<any, []>("SELECT COUNT(*) AS n FROM model_calls WHERE status='ok'").get().n).toBe(3);
    const pos = qdb.query<any, []>("SELECT * FROM quorum_positions ORDER BY symbol").all();
    expect(pos.map((p: any) => [p.symbol, p.direction])).toEqual([["QQQ", 1], ["SPY", 1]]);
    expect(qdb.query<any, []>("SELECT status FROM snapshots").get().status).toBe("ok");
  });

  test("one model fails → quorum still runs on the two that answered", async () => {
    const qdb = memQuorumDb();
    const hist = histWithBars();
    const fetchFn = mockFetch({
      "anthropic/model-a": allViews("short", 0.9),
      "openai/model-b": () => new Error("down"),
      "google/model-c": allViews("short", 0.8),
    });
    const r = await runCycle(ACTIVE, "stocks", { qdb, hist, now: () => NOW, fetchFn, sleepFn: async () => {} });
    expect(r.status).toBe("ok");
    expect(r.modelsAnswered).toBe(2);
    expect(r.positions).toBe(2);
    expect(qdb.query<any, []>("SELECT COUNT(*) AS n FROM model_calls WHERE status='error'").get().n).toBe(1);
  });

  test("two models fail → partial (quorum impossible), no positions", async () => {
    const qdb = memQuorumDb();
    const hist = histWithBars();
    const fetchFn = mockFetch({
      "anthropic/model-a": allViews("long", 0.9),
      "openai/model-b": () => new Error("down"),
      "google/model-c": () => new Error("down"),
    });
    const r = await runCycle(ACTIVE, "stocks", { qdb, hist, now: () => NOW, fetchFn, sleepFn: async () => {} });
    expect(r.status).toBe("partial");
    expect(r.positions).toBe(0);
    expect(qdb.query<any, []>("SELECT COUNT(*) AS n FROM quorum_positions").get().n).toBe(0);
  });

  test("daily cost cap reached → snapshot stored, zero calls", async () => {
    const qdb = memQuorumDb();
    const hist = histWithBars();
    // Pretend earlier runs today already spent the cap.
    qdb.query(
      "INSERT INTO model_calls (snapshot_id, model_id, status, cost_usd, called_at) VALUES (0, 'x', 'ok', ?, ?)",
    ).run(ACTIVE.maxDailyUsd, NOW - 3_600_000);
    let fetches = 0;
    const fetchFn = (async () => { fetches++; return new Response("{}"); }) as unknown as typeof fetch;
    const r = await runCycle(ACTIVE, "stocks", { qdb, hist, now: () => NOW, fetchFn });
    expect(r.status).toBe("cost_capped");
    expect(fetches).toBe(0);
    expect(qdb.query<any, []>("SELECT status FROM snapshots").get().status).toBe("cost_capped");
  });

  test("news failures are tolerated (snapshot ships without headlines)", async () => {
    const qdb = memQuorumDb();
    const hist = histWithBars();
    const r = await runCycle(PENDING, "stocks", {
      qdb, hist, now: () => NOW,
      newsFn: async () => { throw new Error("feeds down"); },
    });
    expect(r.status).toBe("pending_keys");
    expect(JSON.parse(qdb.query<any, []>("SELECT payload FROM snapshots").get().payload).headlines).toEqual([]);
  });
});
