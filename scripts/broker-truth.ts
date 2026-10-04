// ══════════════════════════════════════════════
// broker-truth.ts — READ-ONLY reconciliation against the brokers themselves
// ══════════════════════════════════════════════
//
// Prints what Alpaca (paper) and Binance (testnet FAPI) say RIGHT NOW about
// account, positions and unrealized P&L. Raw signed GETs only: no orders, no
// DB writes, no executor side effects — safe to run from ANY checkout that
// has the broker keys, including the decommissioned dev clone (2026-09-15:
// the owner asked for "validación en la vida real" alongside the dashboard,
// which reads the bot's own DB; this reads the source of truth instead).
// Usage: set -a; . ./.env; set +a; bun run scripts/broker-truth.ts
import { createHmac } from "crypto";

const env = (k: string) => process.env[k] ?? "";
const alpacaBase = env("ALPACA_BASE_URL") || "https://paper-api.alpaca.markets";
const AH = { "APCA-API-KEY-ID": env("ALPACA_API_KEY"), "APCA-API-SECRET-KEY": env("ALPACA_SECRET_KEY") };

async function alpaca(path: string) {
  const r = await fetch(`${alpacaBase}${path}`, { headers: AH });
  if (!r.ok) throw new Error(`alpaca ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

const fapiBase = env("BINANCE_FUTURES_REST_BASE") || "https://demo-fapi.binance.com";
async function fapi(path: string) {
  const ts = Date.now();
  const qs = `timestamp=${ts}&recvWindow=10000`;
  const sig = createHmac("sha256", env("BINANCE_FUTURES_SECRET_KEY")).update(qs).digest("hex");
  const r = await fetch(`${fapiBase}${path}?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": env("BINANCE_FUTURES_API_KEY") } });
  if (!r.ok) throw new Error(`fapi ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

console.log(`▌ ALPACA paper (${alpacaBase})`);
const acct = await alpaca("/v2/account");
console.log(`   account ${acct.id.slice(0, 8)}… equity=$${(+acct.equity).toFixed(2)} cash=$${(+acct.cash).toFixed(2)} regt_bp=$${(+acct.regt_buying_power).toFixed(0)} pdt=${acct.pattern_day_trader} daytrades=${acct.daytrade_count} multiplier=${acct.multiplier}`);
const pos = await alpaca("/v2/positions");
let alpUnreal = 0;
console.log(`   ${pos.length} positions (broker truth):`);
for (const p of pos) {
  alpUnreal += +p.unrealized_pl;
  console.log(`     ${p.symbol.padEnd(6)} qty=${String(p.qty).padStart(4)} avg=$${(+p.avg_entry_price).toFixed(2).padStart(8)} now=$${(+p.current_price).toFixed(2).padStart(8)} unreal=${(+p.unrealized_pl >= 0 ? "+" : "")}$${(+p.unrealized_pl).toFixed(2).padStart(9)} (${(+p.unrealized_plpc * 100).toFixed(1)}%)`);
}
console.log(`   Σ unrealized Alpaca = ${alpUnreal >= 0 ? "+" : ""}$${alpUnreal.toFixed(2)}`);

console.log(`\n▌ BINANCE FAPI testnet (${fapiBase})`);
const fa = await fapi("/fapi/v2/account");
console.log(`   totalMarginBalance=$${(+fa.totalMarginBalance).toFixed(2)} totalUnrealizedProfit=${(+fa.totalUnrealizedProfit >= 0 ? "+" : "")}$${(+fa.totalUnrealizedProfit).toFixed(2)} availableBalance=$${(+fa.availableBalance).toFixed(2)}`);
const usdc = (fa.assets ?? []).find((a: any) => a.asset === "USDC");
if (usdc) console.log(`   USDC pool: marginBalance=$${(+usdc.marginBalance).toFixed(2)} unrealized=${(+usdc.unrealizedProfit >= 0 ? "+" : "")}$${(+usdc.unrealizedProfit).toFixed(2)}`);
const pr = await fapi("/fapi/v2/positionRisk");
let binUnreal = 0;
const open = pr.filter((p: any) => Math.abs(+p.positionAmt) > 0);
console.log(`   ${open.length} open positions (broker truth):`);
for (const p of open) {
  binUnreal += +p.unRealizedProfit;
  console.log(`     ${p.symbol.padEnd(10)} amt=${String(p.positionAmt).padStart(10)} entry=$${(+p.entryPrice).toFixed(4).padStart(10)} mark=$${(+p.markPrice).toFixed(4).padStart(10)} unreal=${(+p.unRealizedProfit >= 0 ? "+" : "")}$${(+p.unRealizedProfit).toFixed(2).padStart(8)} lev=${p.leverage}x`);
}
console.log(`   Σ unrealized Binance = ${binUnreal >= 0 ? "+" : ""}$${binUnreal.toFixed(2)}`);

console.log(`\n▌ TOTAL unrealized at the brokers = ${(alpUnreal + binUnreal) >= 0 ? "+" : ""}$${(alpUnreal + binUnreal).toFixed(2)}`);
console.log(`   positions at brokers: ${pos.length + open.length}`);
