// ══════════════════════════════════════════════
// verify-binance-transport.ts — READ-ONLY legacy-vs-SDK transport comparison
// ══════════════════════════════════════════════
//
// Runs the SAME battery of signed GETs through BOTH USDⓈ-M transports
// (legacy hand-rolled fetch and the official SDK) against the configured
// host/keys and diffs the results:
//   - balances (per-asset wallet balances from /fapi/v2/account),
//   - open positions (/fapi/v2/positionRisk),
//   - open orders, regular AND algo stores,
//   - userTrades for every symbol with an open position (last 48h),
//   - income (last 24h),
//   - exchangeInfo instrument specs for the live universe (USDT + USDC maps).
//
// Exit codes: 0 = identical; 1 = ANY difference (printed per section);
// 2 = error. Time-ranged queries share ONE endTime fixed at startup so both
// transports read the same window.
//
// READ-ONLY BY CONSTRUCTION: every transport is wrapped in readOnlyTransport,
// which throws on any non-GET signed request BEFORE it reaches the inner
// transport — this script can NEVER place, modify or cancel anything, no
// matter what future edits do to the sections below. Locked by
// verify-binance-transport.test.ts.
//
// Usage: set -a; . ./.env; set +a; bun run scripts/verify-binance-transport.ts
// ══════════════════════════════════════════════

import { config } from "../src/config";
import { SYMBOL_MAP, isNonProductionBinanceHost } from "../src/executor/binance-executor";
import { USDC_SYMBOL_MAP } from "../src/executor/binance/quoteAsset";
import { parseInstrumentSpec, type InstrumentSpec } from "../src/executor/binance/instrumentSpec";
import {
  createBinanceUsdmTransport,
  type BinanceUsdmTransport,
  type BinanceTransportKind,
  type UsdmHttpMethod,
} from "../src/executor/binance/usdmTransport";
import { getVenueRateLimiter, type RequestClass } from "../src/executor/rateLimiter";

// ── Read-only guard ─────────────────────────────────────────────────────────

/** Wrap a transport so that ANY mutating verb is refused before it reaches
 *  the inner transport (and therefore before the rate limiter, the SDK, or a
 *  socket). GET-only by construction. */
export function readOnlyTransport(inner: BinanceUsdmTransport): BinanceUsdmTransport {
  return {
    kind: inner.kind,
    signedRequest(method: UsdmHttpMethod, path: string, params?: Record<string, string>, cls?: RequestClass) {
      if (method !== "GET") {
        throw new Error(`read-only transport: refusing ${method} ${path} — this script must never transmit a mutation`);
      }
      return inner.signedRequest(method, path, params, cls);
    },
    publicRequest(path, query, cls) {
      return inner.publicRequest(path, query, cls); // public endpoints are GETs by definition
    },
    serverTime() {
      return inner.serverTime();
    },
  };
}

/** Build the read-only wrapped transport pair for the configured host/keys.
 *  Both share the real venue limiter (one account, one IP weight quota). */
export function buildTransports(): Record<BinanceTransportKind, BinanceUsdmTransport> {
  const ctx = {
    baseUrl: () => config.binanceFutures.restBase,
    apiKey: () => config.binanceFutures.apiKey || config.binance.apiKey,
    secretKey: () => config.binanceFutures.apiSecret || config.binance.apiSecret,
    limiter: () => getVenueRateLimiter("binance_fapi"),
  };
  return {
    legacy: readOnlyTransport(createBinanceUsdmTransport("legacy", ctx)),
    sdk: readOnlyTransport(createBinanceUsdmTransport("sdk", ctx)),
  };
}

// ── Snapshot (stable fields only — mark-price-derived numbers fluctuate
//    between the two reads and would be noise, not evidence) ────────────────

export interface TransportSnapshot {
  balances: Array<{ asset: string; walletBalance: string }>;
  positions: Array<{ symbol: string; positionAmt: string; entryPrice: string; leverage?: string }>;
  openOrders: Array<Record<string, unknown>>;
  openAlgoOrders: Array<Record<string, unknown>>;
  userTrades: Record<string, Array<Record<string, unknown>>>;
  income: Array<Record<string, unknown>>;
  specs: Record<string, InstrumentSpec | null>;
}

const LIVE_UNIVERSE = [...new Set([...Object.values(SYMBOL_MAP), ...Object.values(USDC_SYMBOL_MAP)])].sort();

export async function collectSnapshot(t: BinanceUsdmTransport, endTimeMs: number): Promise<TransportSnapshot> {
  const account = await t.signedRequest("GET", "/fapi/v2/account", {}, "background");
  const balances = (Array.isArray(account?.assets) ? account.assets : [])
    .filter((a: any) => parseFloat(a?.walletBalance) !== 0)
    .map((a: any) => ({ asset: String(a.asset), walletBalance: String(a.walletBalance) }))
    .sort((a: any, b: any) => a.asset.localeCompare(b.asset));

  const positionRisk = await t.signedRequest("GET", "/fapi/v2/positionRisk", {}, "background");
  const positions = (Array.isArray(positionRisk) ? positionRisk : [])
    .filter((p: any) => parseFloat(p?.positionAmt) !== 0)
    .map((p: any) => ({
      symbol: String(p.symbol),
      positionAmt: String(p.positionAmt),
      entryPrice: String(p.entryPrice),
      ...(p.leverage !== undefined ? { leverage: String(p.leverage) } : {}),
    }))
    .sort((a: any, b: any) => a.symbol.localeCompare(b.symbol));

  const normOrder = (o: any) => ({
    symbol: String(o.symbol ?? ""),
    id: String(o.orderId ?? o.algoId ?? ""),
    clientId: String(o.clientOrderId ?? o.clientAlgoId ?? ""),
    type: String(o.type ?? o.orderType ?? ""),
    side: String(o.side ?? ""),
    trigger: String(o.stopPrice ?? o.triggerPrice ?? ""),
    qty: String(o.origQty ?? o.quantity ?? o.totalQty ?? ""),
    reduceOnly: String(o.reduceOnly ?? ""),
    closePosition: String(o.closePosition ?? ""),
  });
  const openRaw = await t.signedRequest("GET", "/fapi/v1/openOrders", {}, "background");
  const openOrders = (Array.isArray(openRaw) ? openRaw : []).map(normOrder).sort((a, b) => a.id.localeCompare(b.id));
  const algoRaw = await t.signedRequest("GET", "/fapi/v1/openAlgoOrders", {}, "background");
  const algoList = Array.isArray(algoRaw) ? algoRaw : (Array.isArray(algoRaw?.orders) ? algoRaw.orders : []);
  const openAlgoOrders = algoList.map(normOrder).sort((a: any, b: any) => a.id.localeCompare(b.id));

  const userTrades: TransportSnapshot["userTrades"] = {};
  const startTrades = endTimeMs - 48 * 60 * 60_000;
  for (const pos of positions) {
    const raw = await t.signedRequest("GET", "/fapi/v1/userTrades", {
      symbol: pos.symbol, startTime: String(startTrades), endTime: String(endTimeMs), limit: "1000",
    }, "background");
    userTrades[pos.symbol] = (Array.isArray(raw) ? raw : [])
      .map((tr: any) => ({
        id: String(tr.id), orderId: String(tr.orderId), side: String(tr.side),
        price: String(tr.price), qty: String(tr.qty),
        realizedPnl: String(tr.realizedPnl), commission: String(tr.commission), time: String(tr.time),
      }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id));
  }

  const incomeRaw = await t.signedRequest("GET", "/fapi/v1/income", {
    startTime: String(endTimeMs - 24 * 60 * 60_000), endTime: String(endTimeMs), limit: "1000",
  }, "background");
  const income = (Array.isArray(incomeRaw) ? incomeRaw : [])
    .map((i: any) => ({
      tranId: String(i.tranId), incomeType: String(i.incomeType), symbol: String(i.symbol ?? ""),
      income: String(i.income), asset: String(i.asset ?? ""), time: String(i.time),
    }))
    .sort((a: any, b: any) => `${a.tranId}|${a.incomeType}`.localeCompare(`${b.tranId}|${b.incomeType}`));

  const exchangeInfoResp = await t.publicRequest("/fapi/v1/exchangeInfo", {}, "background");
  if (!exchangeInfoResp.ok) throw new Error(`exchangeInfo HTTP ${exchangeInfoResp.status}`);
  const exchangeInfo = await exchangeInfoResp.json();
  const bySymbol = new Map<string, any>((Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : []).map((s: any) => [s?.symbol, s]));
  const specs: TransportSnapshot["specs"] = {};
  for (const native of LIVE_UNIVERSE) {
    const raw = bySymbol.get(native);
    specs[native] = raw ? parseInstrumentSpec(raw) : null;
  }

  return { balances, positions, openOrders, openAlgoOrders, userTrades, income, specs };
}

// ── Diff + report ───────────────────────────────────────────────────────────

export function diffSnapshots(a: TransportSnapshot, b: TransportSnapshot): string[] {
  const diffs: string[] = [];
  const sections: Array<keyof TransportSnapshot> = ["balances", "positions", "openOrders", "openAlgoOrders", "userTrades", "income", "specs"];
  for (const section of sections) {
    const ja = JSON.stringify(a[section], null, 1);
    const jb = JSON.stringify(b[section], null, 1);
    if (ja !== jb) {
      diffs.push(`✗ ${section} differ:\n  legacy: ${ja.replace(/\n/g, " ")}\n  sdk:    ${jb.replace(/\n/g, " ")}`);
    }
  }
  return diffs;
}

async function main(): Promise<void> {
  const base = config.binanceFutures.restBase;
  if (!isNonProductionBinanceHost(base)) {
    // Read-only, but this repo's keys belong to the sandbox — an unknown host
    // is refused on principle (fail closed, same rail as the executor).
    console.error(`✗ REFUSING: ${base} is not a known sandbox (testnet/demo) host.`);
    process.exit(2);
  }
  console.log(`▌ verify-binance-transport — READ-ONLY, host ${base}`);
  const endTimeMs = Date.now();
  const transports = buildTransports();

  // Legacy first, then SDK, same fixed time windows for both.
  const snapLegacy = await collectSnapshot(transports.legacy, endTimeMs);
  const snapSdk = await collectSnapshot(transports.sdk, endTimeMs);

  const sections: Array<[string, (s: TransportSnapshot) => number]> = [
    ["balances", (s) => s.balances.length],
    ["positions", (s) => s.positions.length],
    ["openOrders", (s) => s.openOrders.length],
    ["openAlgoOrders", (s) => s.openAlgoOrders.length],
    ["userTrades(48h)", (s) => Object.values(s.userTrades).reduce((n, v) => n + v.length, 0)],
    ["income(24h)", (s) => s.income.length],
    ["specs(universe)", (s) => Object.values(s.specs).filter(Boolean).length],
  ];
  for (const [name, count] of sections) {
    console.log(`   ${name.padEnd(16)} legacy=${count(snapLegacy)} sdk=${count(snapSdk)}`);
  }

  const diffs = diffSnapshots(snapLegacy, snapSdk);
  if (diffs.length > 0) {
    console.error(`\n✗ TRANSPORTS DISAGREE (${diffs.length} section(s)):`);
    for (const d of diffs) console.error(d);
    process.exit(1);
  }
  console.log("\n✓ legacy and sdk transports agree on every section — safe to flip BINANCE_TRANSPORT=sdk");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`✗ verify-binance-transport failed: ${e?.message ?? e}`);
    process.exit(2);
  });
}
