// ══════════════════════════════════════════════
// REAL exchange payloads, not hand-written mocks.
//
// Every hand-written mock in binance-executor.test.ts encodes the AUTHOR's
// mental model of what Binance sends back — which is always tidy, because a
// human wrote it. This file feeds our own parsing code the exact JSON bodies
// ccxt/ccxt (MIT) recorded from LIVE Binance USDⓈ-M Futures servers in its
// own static test corpus (see __fixtures__/ccxt/NOTICE for provenance/
// license). The goal is not "does it pass" — it's "does real data reveal
// something a clean mock never would". Findings are reported in full at the
// bottom of each describe block; confirmed bugs were originally parked as a
// skipped test with the DESIRED assertion (so the suite stayed green
// without losing the finding) until fixed — see the "FIXED:" test below.
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BinanceExecutor } from "./binance-executor";

const FIXDIR = join(import.meta.dir, "__fixtures__/ccxt");
function loadCcxt(kind: "response" | "markets", exchange: string): any {
  return JSON.parse(readFileSync(join(FIXDIR, kind, `${exchange}.json`), "utf8"));
}

function make(signedRequest: any): any {
  const exec = new BinanceExecutor() as any;
  exec.connected = true;
  exec.signedRequest = signedRequest;
  return exec;
}

// ── computeMarginBalance / getBalance: real /fapi/v2/account (swap) ───────
describe("getBalance fed ccxt's REAL /fapi/v2/account (USDⓈ-M swap) capture", () => {
  test("real production numbers (8-decimal precision) don't spuriously trip the $0.01 mismatch tolerance", async () => {
    const binance = loadCcxt("response", "binance");
    const real = binance.methods.fetchBalance.find((c: any) => c.description === "Linear swap balance").httpResponse;
    // Sanity on the fixture itself — if ccxt's corpus changes shape upstream,
    // fail loudly here instead of silently testing the wrong thing.
    expect(real.totalWalletBalance).toBe("31.02261200");

    const exec = make(async () => real);
    expect(await exec.getBalance()).toEqual({
      marginEquity: 31.022612,
      marginCash: 31.022612,
      wallet: 31.022612,
      unrealizedPnl: 0,
    });
  });
});

// ── getPositions: real /fapi/*/positionRisk-shaped rows ───────────────────
describe("getPositions fed ccxt's REAL positionRisk captures", () => {
  test("FINDING: a real row with NO leverage field at all silently becomes leverage:NaN, unlike qty/price which fail closed", async () => {
    // ccxt's "Fetch linear positions without symbols" capture (real Binance
    // USDⓈ-M testnet, 2024). This exact row has NO `leverage` key — Binance's
    // newer v3 positionRisk schema (cross-margin UI) dropped it along with
    // marginType/isAutoAddMargin. Our code still asks for /fapi/v2/positionRisk
    // specifically, so this exact row may not be what v2 sends today — but
    // the finding stands regardless of version: getPositions() has NO
    // validation on `leverage`/`updateTime` (unlike Alpaca's getPositions,
    // which THROWS on a malformed qty/avg_entry_price). A missing/malformed
    // leverage silently becomes NaN and flows on into the returned Position
    // with no warning, no throw — a landmine for any future caller that does
    // risk/margin math with it.
    const binance = loadCcxt("response", "binance");
    const real = binance.methods.fetchPositions.find((c: any) => c.description === "Fetch linear positions without symbols").httpResponse[0];
    expect(real).not.toHaveProperty("leverage"); // confirms the fixture still has this shape
    expect(real.symbol).toBe("BTCUSDT");

    const exec = make(async () => [real]);
    const [pos] = await exec.getPositions();
    expect(pos.symbol).toBe("BTCUSDT");
    expect(pos.positionAmt).toBeCloseTo(0.009);
    expect(pos.entryPrice).toBeCloseTo(67445.9);
    expect(Number.isNaN(pos.leverage)).toBe(true); // <- the finding, locked in as current behavior
  });

  test("real delisted-market row (positionAmt=0, notional=0) is correctly excluded — ccxt issue #29244 regression fixture", async () => {
    // ccxt's own regression fixture for "account endpoint delisted market
    // with zero leverage and zero notional does not crash" — a REAL Binance
    // response for a symbol that got delisted while a caller still held
    // (an empty) position row for it. Positive control: confirms our
    // `parseFloat(p.positionAmt) !== 0` filter survives this real shape
    // (entryPrice "0.0", notional "0", leverage "0" as a STRING).
    const binance = loadCcxt("response", "binance");
    const real = binance.methods.fetchPositions.find((c: any) => c.description?.includes("delisted market")).httpResponse;
    const row = real.positions[0]; // account-endpoint shape wraps positions[]
    expect(row.symbol).toBe("SNTUSDT");
    expect(row.positionAmt).toBe("0");

    // getPositions() reads /fapi/v2/positionRisk's flat array shape, not the
    // account endpoint's {assets,positions} wrapper — feed the row directly
    // as positionRisk would.
    const exec = make(async () => [row]);
    expect(await exec.getPositions()).toEqual([]);
  });
});

// ── getOpenProtectiveOrders: real Algo Order API response shape ───────────
describe("getOpenProtectiveOrders fed ccxt's REAL Algo Order API response shape", () => {
  test("FIXED: a real conditional order reports orderType \"STOP\", not \"STOP_MARKET\" — the filter now accepts both and canonicalizes to STOP_MARKET", async () => {
    // ccxt's real captured response for "createOrder conditional linear
    // swap" (POST /fapi/v1/algoOrder, algoType=CONDITIONAL) — this is the
    // EXACT fallback path placeStopMarketClose takes on Binance's -4120
    // rejection (see binance-executor.ts: "use the Algo Order API"). Real
    // Binance reported this order back with `"orderType": "STOP"`, not
    // "STOP_MARKET" — even though the request specified type STOP_MARKET
    // in our own algoParams. getOpenProtectiveOrders' filter demands an
    // EXACT match against the literal string "STOP_MARKET":
    //   String(o.orderType ?? o.type ?? o.actualOrderType ?? "").toUpperCase() === "STOP_MARKET"
    // If Binance's Algo Order readback for OUR market-type stop ever uses
    // "STOP" the way it did for this real conditional-limit order, a live
    // protective stop would be INVISIBLE to getOpenProtectiveOrders — the
    // reconciliation/health-check surface would report "no stop protection"
    // for a position that actually has one on the books.
    // reduceOnly is flipped to true here (the real sample is an ENTRY order,
    // reduceOnly:false) to isolate the orderType-naming question — our own
    // stops always request reduceOnly:"true", so that variable is fixed at
    // the value our own protective orders always carry.
    const binance = loadCcxt("response", "binance");
    const real = binance.methods.createOrder.find((c: any) => c.description === "createOrder conditional linear swap").httpResponse;
    expect(real.orderType).toBe("STOP"); // the real, observed value — not "STOP_MARKET"

    const realProtectiveStop = { ...real, reduceOnly: true, side: "SELL" };
    const exec = make(async (_m: string, path: string) => {
      if (path === "/fapi/v1/openOrders") return [];
      if (path === "/fapi/v1/openAlgoOrders") return [realProtectiveStop];
      throw new Error(`unexpected ${path}`);
    });

    // Desired: a reduceOnly conditional stop on our own symbol should be
    // visible regardless of Binance's exact orderType string for it.
    // Actual current behavior: [] (dropped) — see finding above. Skipped so
    // the suite stays green without asserting the bug as spec.
    const orders = await exec.getOpenProtectiveOrders("BTC/USD");
    expect(orders).toEqual([{
      symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET",
      quantity: 0.002, triggerPrice: 100000, reduceOnly: true,
    }]);
  });
});
