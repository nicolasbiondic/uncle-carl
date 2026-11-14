// GET /api/bot/now carries, for each STOCK strategy, what the AI review's active decision says about its stocks
// (read-only: items with the reason and the sources, and whether the bot's switch for that strategy is on).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../test-support/db";
import { registerBotNowRoutes } from "./botNow";
import { buildBotNow, type BotNowRuntime } from "../botNow";
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
    expect(mom.items.find((i: any) => i.symbol === "NVDA")).toEqual({ symbol: "NVDA", action: "exit", reason: "Motivo de NVDA.", sources: ["https://www.cnbc.com/NVDA", "https://reuters.com/x"], applied: true, bet: false });
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

// Stage C: an item also says whether the short is a BET (the stock's inverse fund is bought), so the board can say "decided to bet against".
describe("/api/bot/now: `bet` on a short item", () => {
  const short = (symbol: string, meanConfidence: number, sleeve: SleeveId = "momentum_stocks") => ov(symbol, { action: "short", meanConfidence,
    votes: [{ family: "claude", action: "short", confidence: meanConfidence }, { family: "gpt", action: "short", confidence: meanConfidence }] }, sleeve);
  const build = (betsOn: boolean, applies: (s: SleeveId) => boolean = () => true) => {
    const db = makeTestDb();
    const r = buildBotNow({ db, now: NOW, runtime, summaries, readState: () => null, aiReview: { dir, applies, betsOn: () => betsOn } });
    return (id: string) => r.portfolios.find(x => x.id === id)!.aiReview!.items.map(i => [i.symbol, i.action, i.applied, i.bet]);
  };
  test("with the bets switch on, the two most confident shorts with a fund are bets; the third is not (it is only taken out)", () => {
    put("2026-11-16", [short("NVDA", 0.9), short("AAPL", 0.85), short("MSFT", 0.7)]);
    expect(build(true)("momentum_stocks").sort()).toEqual([["AAPL", "short", true, true], ["MSFT", "short", true, false], ["NVDA", "short", true, true]]);
  });
  test("a short without a fund and an exit are not bets", () => {
    put("2026-11-16", [short("IWM", 0.95), short("NVDA", 0.9), ov("META")]);
    expect(build(true)("momentum_stocks").sort()).toEqual([["IWM", "short", true, false], ["META", "exit", true, false], ["NVDA", "short", true, true]]);
  });
  test("the cap is over both strategies, and a strategy that only informs still says what it WOULD bet (the tense is `applied`)", () => {
    put("2026-11-16", [short("NVDA", 0.7), short("AVGO", 0.9, "meanrev_stocks"), short("NFLX", 0.8, "meanrev_stocks")]);
    const items = build(true, s => s === "momentum_stocks");
    expect(items("momentum_stocks")).toEqual([["NVDA", "short", true, false]]);              // AVGO .9 and NFLX .8 are the two best of the decision
    expect(items("meanrev_stocks").sort()).toEqual([["AVGO", "short", false, true], ["NFLX", "short", false, true]]);   // informing: would bet
  });
  test("with the bets switch off no item is a bet", () => {
    put("2026-11-16", [short("NVDA", 0.9)]);
    expect(build(false)("momentum_stocks")).toEqual([["NVDA", "short", true, false]]);
  });
  test("the real switch is ON (2026-11-14): the short is a bet; the environment's kill switch turns it back into an exit", () => {
    put("2026-11-16", [short("NVDA", 0.9)]);
    const db = makeTestDb();
    const saved = [process.env.AI_REVIEW_APPLY, process.env.AI_REVIEW_BETS];
    delete process.env.AI_REVIEW_APPLY; delete process.env.AI_REVIEW_BETS;
    try {
      const bet = () => buildBotNow({ db, now: NOW, runtime, summaries, readState: () => null, aiReview: { dir } })
        .portfolios.find(x => x.id === "momentum_stocks")!.aiReview!.items.map(i => i.bet);
      expect(bet()).toEqual([true]);
      process.env.AI_REVIEW_BETS = "off";
      expect(bet()).toEqual([false]);
      delete process.env.AI_REVIEW_BETS;
    } finally {
      delete process.env.AI_REVIEW_BETS;
      if (saved[0] !== undefined) process.env.AI_REVIEW_APPLY = saved[0];
      if (saved[1] !== undefined) process.env.AI_REVIEW_BETS = saved[1];
    }
  });
});

describe("buildBotNow reads the inbox without writing anything", () => {
  test("the real switch is on (owner, 2026-11-14): items say the bot acts; a strategy whose switch is off only informs", () => {
    const db = makeTestDb();
    put("2026-11-16", [ov("NVDA")]);
    const before = process.env.AI_REVIEW_APPLY;
    delete process.env.AI_REVIEW_APPLY;
    db.exec("PRAGMA query_only=ON");
    try {
      const real = buildBotNow({ db, now: NOW, runtime, summaries, readState: () => null, aiReview: { dir } });
      expect(real.portfolios.find(x => x.id === "momentum_stocks")!.aiReview!.items.map(i => i.applied)).toEqual([true]);
      const off = buildBotNow({ db, now: NOW, runtime, summaries, readState: () => null, aiReview: { dir, applies: () => false } });
      expect(off.portfolios.find(x => x.id === "momentum_stocks")!.aiReview!.items.map(i => i.applied)).toEqual([false]);
    } finally {
      db.exec("PRAGMA query_only=OFF");
      if (before !== undefined) process.env.AI_REVIEW_APPLY = before;
    }
  });
});
