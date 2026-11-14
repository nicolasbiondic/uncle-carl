#!/usr/bin/env bun
// scripts/ai-review-casefile.ts --session YYYY-MM-DD — prints the AI review's case file as JSON on stdout.
// READ-ONLY: trading.db and historical.db are opened { readonly: true }, the only network calls are GETs to
// Alpaca's DATA API with the bot's own keys (ALPACA_API_KEY / ALPACA_SECRET_KEY, read from the environment that
// bun loads from .env; never printed or written). It runs where the bot's data is (prod, through ssh from the dev
// machine's scripts/ai-review.sh). Logic and tests: src/ai-review/casefile.ts.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { buildCaseFile } from "../src/ai-review/casefile";
import { isDateKey, parseCaseFile } from "../src/ai-review/contract";
import { builtinPortfolio, STOCK_SLEEVE_BUILTIN_DEFINITION } from "../src/portfolios/builtin";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const session = arg("--session");
  if (!isDateKey(session)) { console.error("usage: ai-review-casefile.ts --session YYYY-MM-DD"); process.exit(64); }
  const keyId = process.env.ALPACA_API_KEY ?? "";
  const secretKey = process.env.ALPACA_SECRET_KEY ?? "";
  if (!keyId || !secretKey) { console.error("ALPACA_API_KEY / ALPACA_SECRET_KEY missing in the environment"); process.exit(2); }
  const tradingPath = arg("--trading-db") ?? "data/trading.db";
  const histPath = arg("--historical-db") ?? "data/historical.db";
  for (const p of [tradingPath, histPath]) if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(2); }

  const universeOf = (sleeve: "momentum_stocks" | "meanrev_stocks"): string[] => {
    const params = builtinPortfolio(STOCK_SLEEVE_BUILTIN_DEFINITION[sleeve]).params as any;
    const u = params?.strategy?.universe;
    if (!Array.isArray(u) || u.length === 0) throw new Error(`no universe for ${sleeve}`);
    return u as string[];
  };

  const tradingDb = new Database(tradingPath, { readonly: true });
  const historicalDb = new Database(histPath, { readonly: true });
  try {
    const cf = await buildCaseFile({
      session, nowMs: Date.now(), tradingDb, historicalDb,
      universes: { momentum_stocks: universeOf("momentum_stocks"), meanrev_stocks: universeOf("meanrev_stocks") },
      fetchFn: fetch, keyId, secretKey, feed: process.env.ALPACA_DATA_FEED || "iex",
    });
    const check = parseCaseFile(cf);
    if (!check.ok) throw new Error(`built an invalid case file: ${check.error}`);
    process.stdout.write(JSON.stringify(cf) + "\n");
  } finally {
    tradingDb.close();
    historicalDb.close();
  }
}

main().catch(e => { console.error(`ai-review-casefile: ${String((e as Error)?.message ?? e).slice(0, 300)}`); process.exit(1); });
