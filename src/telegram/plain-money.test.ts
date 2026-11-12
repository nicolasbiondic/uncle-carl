import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getDB, getETWindowStart, saveEquitySnapshot } from "../db/database";
import { makeTestDb } from "../test-support/db";
import { setBrokerTruthAvailable } from "../portfolio/truth";
import { TelegramReporter, fmtCloseAlert } from "./telegram-reporter";
// @ts-ignore shared presentation vocabulary, no browser dependency.
import { CLOSE_REASON_WORDS, closeReasonWord } from "../dashboard/public/v4/js/close-reasons.js";

afterEach(() => { spyOn(Date, "now").mockRestore(); });

test("every persisted close code has words in both languages; unknown codes never leak", async () => {
  const codes = new Set<string>();
  const constants = new Map<string, string>();
  const whitelistNames: string[] = [];
  for await (const file of new Bun.Glob("src/**/*.ts").scan(".")) {
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bconst\s+(\w+)\s*=\s*["']([A-Z_0-9]+)["']/g)) constants.set(m[1], m[2]);
    for (const list of text.matchAll(/ENGINE_CLOSE_REASONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/g)) {
      for (const value of list[1].split(",").map(s => s.trim()).filter(Boolean)) {
        if (/^["']/.test(value)) codes.add(value.slice(1, -1));
        else whitelistNames.push(value);
      }
    }
    // Engine constants (including every member of ENGINE_CLOSE_REASONS),
    // direct persisted codes and the DB's complete reconcile exclusion list.
    for (const m of text.matchAll(/(?:\w*CLOSE_REASON|BREAKOUT_\w+)\s*=\s*"([A-Z_0-9]+)"|(?:close_reason|closeReason|reasonCode)\s*[:=]\s*["']([A-Z_0-9]+)["']/g)) codes.add(m[1] || m[2]);
    if (file.endsWith("db/database.ts")) {
      const sql = text.match(/close_reason NOT IN \(([^)]+)\)/)?.[1] ?? "";
      for (const m of sql.matchAll(/'([A-Z_0-9]+)'/g)) codes.add(m[1]);
    }
  }
  for (const name of whitelistNames) {
    expect(constants.get(name), `resolve ENGINE_CLOSE_REASONS member ${name}`).toBeDefined();
    codes.add(constants.get(name)!);
  }
  for (const code of ["STOP_LOSS", "TAKE_PROFIT", "MANUAL_CLOSE", "MOMENTUM_REBALANCE", "MEANREV_EXIT"]) codes.add(code);
  expect(codes.size).toBeGreaterThan(25);
  for (const code of codes) {
    expect(CLOSE_REASON_WORDS[code], code).toBeDefined();
    for (const lang of ["es", "en"]) {
      expect(closeReasonWord(code, lang), code).not.toBe(code);
      expect(closeReasonWord(code, lang), code).not.toMatch(/_/);
    }
  }
  expect(closeReasonWord("NEW_SECRET_CODE", "es")).toBe("operación finalizada");
  expect(fmtCloseAlert({ symbol: "X", closeReason: "NEW_SECRET_CODE" })).not.toContain("NEW_SECRET_CODE");
});

export async function renderPlainMoneyFixture() {
  const now = Date.parse("2026-11-11T17:00:00Z");
  spyOn(Date, "now").mockReturnValue(now); makeTestDb();
  setBrokerTruthAvailable("alpaca", true); setBrokerTruthAvailable("binance", true);
  const day = getETWindowStart(1, now), week = getETWindowStart(7, now);
  for (const [id, initial, weekly, yesterday, equity] of [
    ["alpaca_main", 102238, 106934, 105894, 105855], ["binance_main", 10000, 12762, 12562, 12562],
  ] as const) {
    for (const [at, value] of [[Date.parse("2026-07-10T04:00Z"), initial], [week - 60000, weekly], [day - 60000, yesterday], [now, equity]])
      saveEquitySnapshot(id, value, value, 0, at);
  }
  const accounts = [
    { id: "momentum_stocks", equity: 49903, initialEquity: 50000, positions: 11 },
    { id: "meanrev_stocks", equity: 53070, initialEquity: 50000, positions: 24 },
    { id: "momentum_crypto", equity: 5000, initialEquity: 5000, positions: 7 },
    { id: "momentum_crypto_usdc", equity: 7562, initialEquity: 5000, positions: 7 },
  ];
  const moves = [-600, -530, -100, -49];
  accounts.forEach((a, i) => {
    saveEquitySnapshot(a.id, a.equity - moves[i], a.initialEquity, 0, week - 60000);
    saveEquitySnapshot(a.id, a.equity, a.initialEquity, a.positions, now);
  });
  const insert = (id: string, account: string, pnl: number, at: number) => getDB().query(`INSERT INTO trades
    (id, symbol, market, side, strategy, entry_price, exit_price, quantity, pnl, pnl_pct, entry_time, exit_time, status, account_id, profile_id, close_reason)
    VALUES (?, 'TEST', 'stock', 'buy', 'PORTFOLIO', 100, 100, 1, ?, 0, ?, ?, 'closed', ?, ?, 'MAX_HOLD')`)
    .run(id, pnl, at - 86400000, at, account, account);
  for (let i = 0; i < 11; i++) insert(`today${i}`, "momentum_stocks", 25, now - 1000);
  for (let i = 0; i < 80; i++) insert(`previous${i}`, "momentum_stocks", i < 28 ? 10 : -658 / 52, week - 86400000);
  insert("xrp", "momentum_crypto_usdc", 116, now - 1000);
  const xrp = { symbol: "XRP/USDC", side: "sell", pnl: 116, pnlPct: 116 / 1094 * 100,
    entryPrice: 1.094, quantity: 1000, episode_basis: 1094, accountId: "momentum_crypto_usdc",
    entryTime: now - 5 * 86400000, exitTime: now, closeReason: "BREAKOUT_SHORT_TIME_STOP" };
  const positions = accounts.flatMap((a, i) => Array.from({ length: a.positions }, (_, n) => ({
    profileId: a.id, symbol: `OPEN${i}-${n}`, market: "stock", side: "buy", quantity: 1,
    avgEntryPrice: 100, currentPrice: 100, unrealizedPnl: i === 0 ? 658 / 11 : -51 / 38,
  })));
  const reporter = new TelegramReporter(); reporter.openHist = () => null;
  reporter.getAccountSummaries = () => accounts;
  reporter.getConsolidatedState = () => ({ positions }) as any;
  const messages: string[] = [];
  (reporter as any).send = async (text: string) => { messages.push(text); return true; };
  await (reporter as any).cmdStatus("fixture"); await (reporter as any).cmdProfits("fixture");
  return { status: messages[0], profits: messages[1], digest: reporter.composeDailyDigest(), close: fmtCloseAlert(xrp) };
}

test("human-readable example: status, profits, daily digest and XRP close", async () => {
  const x = await renderPlainMoneyFixture();
  if (process.env.PLAIN_MONEY_EXAMPLES) console.log(JSON.stringify(x, null, 2));
  expect(x.status).toContain("Patrimonio $118,417\nHoy −$39 (−0,0 %)");
  for (const surface of [x.status, x.digest]) {
    expect(surface).toContain("Cerradas hoy: 12 operaciones, +$391 en total (desde que se abrieron)");
    expect(surface).toContain("Siguen abiertas: 49 posiciones, +$607 desde que se abrieron");
  }
  expect(x.profits).toContain("Momentum Acciones $49,903 (empezó con $50,000) · 91 operaciones cerradas, 43 % ganadoras · resultado de lo cerrado −$103");
  expect(x.digest).toContain("Hoy −$39 (−0,0 %) · últimos 7 días −$1,279 (−1,1 %)");
  expect(x.digest).toContain("Patrimonio $118,417 · +$6,179 desde el 10 jul");
  expect(x.digest).toContain("Alpaca $105,855 · Binance $12,562");
  expect(x.digest).toContain("Fuera de las estrategias: $2,882 (efectivo inicial de Alpaca y garantía en BTC)");
  expect(x.close).toBe("💰 <b>XRP/USDC</b> cerrada · +$116 (+10,6 % de lo invertido, $1,094) · Momentum Cripto USDC · corto · cierre por tiempo máximo (5 días) · duró 5 días");
  for (const text of Object.values(x)) expect(text).not.toMatch(/fills|MtM|display|vs asignación|cobrado hoy|\$[\d,]+\.\d/);
});

test("scorecard uses one sentence per strategy, 20-session return and no percentiles", () => {
  const reporter = new TelegramReporter();
  const band = (status: string, value: number | null) => ({ status, liveCumReturnPct: value, cumReturnPct: { p1: -10, p5: -5, p50: 0, p95: 10 } });
  (reporter as any).computeScorecardNow = () => ({ entities: [
    { kind: "sleeve", id: "momentum_stocks", rollingBand: band("within", 2) },
    { kind: "sleeve", id: "meanrev_stocks", rollingBand: band("below", -6) },
    { kind: "sleeve", id: "momentum_crypto", rollingBand: band("below", -11) },
    { kind: "sleeve", id: "momentum_crypto_usdc", rollingBand: band("insufficient_data", null) },
    { kind: "broker", id: "alpaca", rollingBand: band("within", 2) },
  ] });
  const lines = (reporter as any).scorecardDigestLines();
  expect(lines).toEqual([
    "Momentum Acciones · dentro de lo esperado · últimas 20 sesiones +2,0 %",
    "Reversión Acciones · peor de lo normal: revisar · últimas 20 sesiones −6,0 %",
    "Momentum Cripto · muy por debajo: alarma · últimas 20 sesiones −11,0 %",
    "Momentum Cripto USDC · aún sin datos suficientes · últimas 20 sesiones —",
  ]);
  expect(lines.join("\n")).not.toMatch(/p1|p5|p50|p95|OOS|Sharpe/);
});

test("legacy portfolio close uses the canonical full-episode percentage, not its final remnant", () => {
  const message = fmtCloseAlert({ symbol: "AAPL", strategy: "PORTFOLIO", status: "closed", pnl: 382.22079589111,
    pnl_pct: 6.343467, episode_basis: null, entry_price: 327.04, quantity: 18.424119326, partial_closed_contracts: 5 });
  expect(message).toContain("+$382 (+5,0 % de lo invertido)");
  expect(message).not.toContain("6,3 %");
});
