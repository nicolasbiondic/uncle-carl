// GET /api/bot/now carries, for each STOCK strategy, what the AI review's active decision says about its stocks
// (read-only: items with the reason and the sources, and whether the bot's switch for that strategy is on).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../test-support/db";
import { registerBotNowRoutes } from "./botNow";
import { buildBotNow, type BotNowDeps, type BotNowRuntime } from "../botNow";
import { sealDecision, type Override, type SleeveId } from "../../ai-review/contract";
import { baseDecision } from "../../ai-review/testFixtures";
import { getETDateKey } from "../../db/database";
import { getPreviousTradingDay } from "../../utils/marketHours";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bot-now-ai-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ov = (symbol: string, over: Partial<Override> = {}, sleeve: SleeveId = "momentum_stocks"): Override => ({
  sleeve, symbol, action: "exit", factor: 0, meanConfidence: 0.8,
  votes: [{ family: "claude", action: "exit", confidence: 0.8 }, { family: "gpt", action: "exit", confidence: 0.8 }],
  reason: `Motivo de ${symbol}.`, sources: [`https://www.cnbc.com/${symbol}`, "https://reuters.com/x"], ...over,
});
const put = (session: string, overrides: Override[]) => writeFileSync(join(dir, `${session}.json`), JSON.stringify(sealDecision(baseDecision({ session, decidedAt: `${session}T13:15:00.000Z`, overrides }))));
const NOW = Date.parse("2026-11-16T15:00:00Z"); // Monday 10:00 New York (buildBotNow tests); the route reads the real clock
const TODAY = getETDateKey(Date.now());
const back = (n: number) => { let d = TODAY; for (let i = 0; i < n; i++) d = getPreviousTradingDay(d); return d; };
const LAST = back(1);
const summaries = [
  { id: "momentum_stocks", label: "x", broker: "alpaca", equity: 1000 },
  { id: "meanrev_stocks", label: "y", broker: "alpaca", equity: 1000 },
  { id: "momentum_crypto", label: "z", broker: "binance", equity: 1000 },
];
const runtime: BotNowRuntime[] = summaries.map(s => ({ id: s.id, engine: s.broker === "alpaca" ? "portfolio" : "momentum", maxGrossX: 1, cadenceMinutes: 1440 }));

async function viaRoute(applies: (s: SleeveId) => boolean) {
  makeTestDb();
  const app = express();
  const am = { getAccountSummaries: () => summaries, getConsolidatedState: () => ({ positions: [] }) } as any;
  registerBotNowRoutes(app, am, () => runtime, { dir, applies });
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/bot/now`);
    expect(res.status).toBe(200);
    return await res.json() as any;
  } finally { server.close(); }
}

describe("/api/bot/now: aiReview on the stock strategies", () => {
  test("the route returns session and items (symbol, action, reason, sources, applied) for the strategy's own overrides only", async () => {
    put(LAST, [ov("NVDA"), ov("AAPL", { action: "reduce", factor: 0.5, votes: [{ family: "claude", action: "reduce", confidence: 0.8 }, { family: "gpt", action: "reduce", confidence: 0.8 }] }),
      ov("SH"), ov("ABBV", {}, "meanrev_stocks")]);
    const body = await viaRoute(s => s === "momentum_stocks");
    const by = (id: string) => body.portfolios.find((p: any) => p.id === id);
    const mom = by("momentum_stocks").aiReview;
    expect(mom.session).toBe(LAST);
    expect(mom.items.map((i: any) => [i.symbol, i.action, i.applied]).sort()).toEqual([["AAPL", "reduce", true], ["NVDA", "exit", true]]); // SH is not in the universe
    expect(mom.items.find((i: any) => i.symbol === "NVDA")).toEqual({ symbol: "NVDA", action: "exit", reason: "Motivo de NVDA.", sources: ["https://www.cnbc.com/NVDA", "https://reuters.com/x"], applied: true });
    const rev = by("meanrev_stocks").aiReview;
    expect(rev.items).toEqual([expect.objectContaining({ symbol: "ABBV", applied: false })]); // the other strategy's switch is off: informing
    expect(by("momentum_crypto")).not.toHaveProperty("aiReview");                              // crypto never carries it
  });

  test("no decision, an empty one, an expired one or a corrupt file: null, never an error", async () => {
    expect((await viaRoute(() => true)).portfolios.map((p: any) => p.aiReview).filter((x: unknown) => x !== undefined)).toEqual([null, null]);
    put(LAST, []);
    expect((await viaRoute(() => true)).portfolios[0].aiReview).toBeNull();
    rmSync(join(dir, `${LAST}.json`));
    put(back(8), [ov("NVDA")]); // 7+ sessions old on any weekday or weekend: lapsed
    expect((await viaRoute(() => true)).portfolios[0].aiReview).toBeNull();
    writeFileSync(join(dir, `${LAST}.json`), "{ corrupt");
    expect((await viaRoute(() => true)).portfolios[0].aiReview).toBeNull();
  });
});

describe("buildBotNow reads the inbox without writing anything", () => {
  test("the real default switch is off: items are informing; the answer is the same shape without the aiReview option", () => {
    const db = makeTestDb();
    put("2026-11-16", [ov("NVDA")]);
    const deps: BotNowDeps = { db, now: NOW, runtime, summaries, readState: () => null, aiReview: { dir } };
    db.exec("PRAGMA query_only=ON");
    try {
      const p = buildBotNow(deps).portfolios.find(x => x.id === "momentum_stocks")!;
      expect(p.aiReview!.items.map(i => i.applied)).toEqual([false]);
    } finally { db.exec("PRAGMA query_only=OFF"); }
  });
});
