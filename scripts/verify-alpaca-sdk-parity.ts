#!/usr/bin/env bun
// ══════════════════════════════════════════════
// verify-alpaca-sdk-parity.ts — v3 SDK vs v5 compat adapter, live READ-ONLY
// ══════════════════════════════════════════════
//
// Side-by-side proof that the v5 compat adapter (src/executor/
// alpaca-v5-compat.ts) returns what the old v3 SDK returned, on the REAL
// paper account, for every field AlpacaExecutor reads. STRICTLY read-only:
// getAccount, getPositions, getOrders, getOrder, getOrderByClientId,
// getAccountActivities, getSnapshot. It never places, replaces or cancels
// anything, and never prints a credential.
//
// PREREQUISITE (temporary, not a committed dependency): the old SDK under an
// npm alias —
//     bun add -d alpaca-v3@npm:@alpacahq/alpaca-trade-api@3.1.3
// Run, read the verdicts, then REMOVE the alias:
//     bun remove alpaca-v3
// The script exits 2 with that instruction when the alias is absent.
//
// Verdicts per field:
//   EXACT  — byte-identical.
//   DRIFT  — both sides valid for the executor's read but unequal because the
//            market moved between the two calls (prices, equity, live
//            timestamps) — acceptable by design.
//   DELTA  — a KNOWN, reviewed representational difference:
//            (a) wire `null` on optional fields → ABSENT through the adapter
//                (every executor read is truthiness/??-guarded);
//            (b) RFC-3339 nanosecond timestamps → millisecond ISO (the
//                executor only ever does new Date(x).getTime()).
//   FAIL   — anything else. Exit 1 if any FAIL.
//
// Historical run (2026-10-14) committed in
// docs/reports/alpaca-sdk-v5-parity-2026-10-14.md.

import { config } from "../src/config";
import { alpacaPaperLiveMismatch, isKnownAlpacaPaperHost } from "../src/executor/alpaca-executor";
import { createAlpacaV3Compat } from "../src/executor/alpaca-v5-compat";

// ── Safety gates: paper-only, coherent config, no secrets printed ─────────
const mismatch = alpacaPaperLiveMismatch(config.alpaca.paper, config.alpaca.baseUrl);
if (mismatch) { console.error(`✗ SAFETY: ${mismatch}`); process.exit(1); }
if (!config.alpaca.paper || !isKnownAlpacaPaperHost(config.alpaca.baseUrl)) {
  console.error("✗ SAFETY: this parity check runs against the PAPER account only");
  process.exit(1);
}
if (!config.alpaca.keyId || config.alpaca.keyId === "your_alpaca_key") {
  console.error("✗ Alpaca API keys not configured (.env)");
  process.exit(1);
}

let AlpacaV3: any;
try {
  AlpacaV3 = require("alpaca-v3");
} catch {
  console.error("✗ v3 alias not installed. Temporarily: bun add -d alpaca-v3@npm:@alpacahq/alpaca-trade-api@3.1.3 (remove it afterwards)");
  process.exit(2);
}

const v3 = new AlpacaV3({
  keyId: config.alpaca.keyId,
  secretKey: config.alpaca.secretKey,
  paper: config.alpaca.paper,
  baseUrl: config.alpaca.baseUrl,
});
const v5 = createAlpacaV3Compat({
  keyId: config.alpaca.keyId,
  secretKey: config.alpaca.secretKey,
  paper: config.alpaca.paper,
  baseUrl: config.alpaca.baseUrl,
});

// ── Field comparison ──────────────────────────────────────────────────────
type Kind = "exact" | "num" | "ts" | "nullable";
let fails = 0;
const count = { EXACT: 0, DRIFT: 0, DELTA: 0, FAIL: 0 };

function verdict(name: string, kind: Kind, a: unknown, b: unknown): void {
  const isAbsent = (x: unknown) => x === null || x === undefined;
  let v: keyof typeof count;
  let note = "";
  if (isAbsent(a) && isAbsent(b)) {
    v = a === b ? "EXACT" : "DELTA"; // null (v3) vs absent (adapter)
    if (v === "DELTA") note = "wire null → absent";
  } else if (String(a) === String(b)) {
    v = "EXACT";
  } else if (kind === "ts" && isFinite(new Date(String(a)).getTime()) && isFinite(new Date(String(b)).getTime())) {
    const ta = new Date(String(a)).getTime(), tb = new Date(String(b)).getTime();
    if (ta === tb) { v = "DELTA"; note = "ns → ms serialization, same instant"; }
    else { v = "DRIFT"; note = `ts moved ${Math.abs(ta - tb)}ms between calls`; }
  } else if (kind === "num" && isFinite(parseFloat(String(a))) && isFinite(parseFloat(String(b)))) {
    v = "DRIFT"; note = "market moved between the two calls";
  } else {
    v = "FAIL";
  }
  count[v]++;
  if (v === "FAIL") fails++;
  const show = (x: unknown) => isAbsent(x) ? String(x) : JSON.stringify(x);
  const detail = v === "EXACT" ? show(a) : `${show(a)} vs ${show(b)}${note ? ` (${note})` : ""}`;
  console.log(`  ${v.padEnd(5)} ${name} = ${detail}`);
}

function section(title: string): void { console.log(`\n▌ ${title}`); }
const g = (obj: any, path: string) => path.split(".").reduce((o, k) => o?.[k], obj);
function compareFields(a: any, b: any, specs: [string, Kind][]): void {
  for (const [path, kind] of specs) verdict(path, kind, g(a, path), g(b, path));
}

// The exact order fields AlpacaExecutor reads (toOrder, getOrderStateByClientId,
// getOrderById, getOpenStopOrders, pollOrderUntilFilled).
const ORDER_FIELDS: [string, Kind][] = [
  ["id", "exact"], ["client_order_id", "exact"], ["symbol", "exact"],
  ["side", "exact"], ["type", "exact"], ["order_type", "exact"],
  ["status", "exact"], ["qty", "nullable"], ["notional", "nullable"],
  ["filled_qty", "num"], ["filled_avg_price", "nullable"],
  ["filled_at", "ts"], ["created_at", "ts"], ["submitted_at", "ts"],
  ["stop_price", "nullable"], ["limit_price", "nullable"],
  ["time_in_force", "exact"], ["replaced_by", "nullable"], ["replaces", "nullable"],
];

async function main(): Promise<void> {
  console.log(`Alpaca SDK parity — v3 (alias) vs v5 compat adapter — PAPER account, read-only`);
  console.log(`host=${config.alpaca.baseUrl} data=${config.alpaca.dataUrl} ${new Date().toISOString()}`);

  // 1 ── getAccount
  section("getAccount");
  const [accA, accB] = [await v3.getAccount(), await v5.getAccount()];
  compareFields(accA, accB, [
    ["id", "exact"], ["account_number", "exact"], ["status", "exact"], ["currency", "exact"],
    ["equity", "num"], ["cash", "num"], ["buying_power", "num"], ["regt_buying_power", "num"],
    ["portfolio_value", "num"], ["multiplier", "exact"],
    ["trade_suspended_by_user", "exact"], ["pattern_day_trader", "exact"], ["shorting_enabled", "exact"],
  ]);

  // 2 ── getPositions (match rows by symbol)
  section("getPositions");
  const [posA, posB] = [await v3.getPositions(), await v5.getPositions()];
  console.log(`  rows: v3=${posA.length} adapter=${posB.length} ${posA.length === posB.length ? "(EXACT)" : "(FAIL)"}`);
  if (posA.length !== posB.length) fails++;
  for (const pa of posA) {
    const pb = posB.find((p: any) => p.symbol === pa.symbol);
    if (!pb) { console.log(`  FAIL  position ${pa.symbol} missing on adapter side`); fails++; continue; }
    console.log(`  — ${pa.symbol}`);
    compareFields(pa, pb, [
      ["symbol", "exact"], ["asset_class", "exact"], ["qty", "exact"], ["side", "exact"],
      ["avg_entry_price", "exact"], ["current_price", "num"],
      ["unrealized_pl", "num"], ["unrealized_plpc", "num"],
    ]);
  }

  // 3 ── getOrders(open) — the getOpenStopOrders read
  section('getOrders({ status: "open", limit: 500, nested: false })');
  const [opnA, opnB] = [
    await v3.getOrders({ status: "open", limit: 500, nested: false }),
    await v5.getOrders({ status: "open", limit: 500, nested: false }),
  ];
  console.log(`  rows: v3=${opnA.length} adapter=${opnB.length} ${opnA.length === opnB.length ? "(EXACT)" : "(FAIL)"}`);
  if (opnA.length !== opnB.length) fails++;
  for (const oa of opnA) {
    const ob = opnB.find((o: any) => o.id === oa.id);
    if (!ob) { console.log(`  FAIL  open order ${oa.id} missing on adapter side`); fails++; continue; }
    console.log(`  — ${oa.symbol} ${oa.type} (${String(oa.client_order_id).slice(0, 24)}…)`);
    compareFields(oa, ob, ORDER_FIELDS);
  }

  // 4 ── one existing order by id AND by client_order_id (prefer an open one;
  // else the most recent closed order — still a pure read).
  const sample = opnA[0] ?? (await v3.getOrders({ status: "closed", limit: 1, nested: false }))[0];
  if (sample) {
    section(`getOrder(${sample.id})`);
    compareFields(await v3.getOrder(sample.id), await v5.getOrder(sample.id), ORDER_FIELDS);
    section(`getOrderByClientId(${String(sample.client_order_id).slice(0, 28)}…)`);
    compareFields(
      await v3.getOrderByClientId(sample.client_order_id),
      await v5.getOrderByClientId(sample.client_order_id),
      ORDER_FIELDS);
  } else {
    section("getOrder / getOrderByClientId — SKIPPED (no orders on the account)");
  }

  // 5 ── getAccountActivities (FILL, small page) — resolvePartialFillPrice's read
  section('getAccountActivities({ activityTypes: "FILL", pageSize: 5 })');
  const [actA, actB] = [
    await v3.getAccountActivities({ activityTypes: "FILL", pageSize: 5 }),
    await v5.getAccountActivities({ activityTypes: "FILL", pageSize: 5 }),
  ];
  console.log(`  rows: v3=${actA.length} adapter=${actB.length} ${actA.length === actB.length ? "(EXACT)" : "(FAIL)"}`);
  if (actA.length !== actB.length) fails++;
  for (let i = 0; i < Math.min(actA.length, actB.length); i++) {
    console.log(`  — activity ${String(actA[i].id).slice(0, 28)}…`);
    compareFields(actA[i], actB[i], [
      ["id", "exact"], ["activity_type", "exact"], ["order_id", "exact"],
      ["qty", "exact"], ["price", "exact"], ["side", "exact"], ["symbol", "exact"],
      ["transaction_time", "ts"], ["cum_qty", "exact"], ["leaves_qty", "exact"],
    ]);
  }

  // 6 ── getSnapshot: SPY + one held stock symbol (the executor's price reads)
  const held = posA.find((p: any) => p.asset_class === "us_equity")?.symbol;
  for (const sym of [...new Set(["SPY", held].filter(Boolean))] as string[]) {
    section(`getSnapshot(${sym})`);
    const [snA, snB] = [await v3.getSnapshot(sym), await v5.getSnapshot(sym)];
    compareFields(snA, snB, [
      ["LatestTrade.Price", "num"], ["LatestTrade.Timestamp", "ts"], ["LatestTrade.Size", "num"],
      ["LatestQuote.BidPrice", "num"], ["LatestQuote.AskPrice", "num"], ["LatestQuote.Timestamp", "ts"],
      ["MinuteBar.ClosePrice", "num"], ["MinuteBar.Timestamp", "ts"],
      ["DailyBar.OpenPrice", "num"], ["DailyBar.ClosePrice", "num"], ["DailyBar.Volume", "num"],
      ["PrevDailyBar.ClosePrice", "num"], ["PrevDailyBar.Timestamp", "ts"],
    ]);
  }

  console.log(`\n▌ summary: EXACT=${count.EXACT} DRIFT=${count.DRIFT} DELTA=${count.DELTA} FAIL=${count.FAIL}`);
  if (fails > 0) { console.error("✗ PARITY FAILED"); process.exit(1); }
  console.log("✓ parity holds for every field the executor reads");
}

main().catch((e: any) => {
  console.error(`✗ fatal: ${e?.message ?? e}`);
  process.exit(1);
});
