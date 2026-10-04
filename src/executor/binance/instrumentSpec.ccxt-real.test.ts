// ══════════════════════════════════════════════
// parseInstrumentSpec fed REAL /fapi/v1/exchangeInfo symbol rows, captured
// live by ccxt/ccxt (MIT) — see ../__fixtures__/ccxt/NOTICE for provenance.
// A pure function, no mocking needed: this is the exact raw filters[] shape
// Binance sends, unedited.
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseInstrumentSpec } from "./instrumentSpec";

const markets = JSON.parse(
  readFileSync(join(import.meta.dir, "../__fixtures__/ccxt/markets/binance.json"), "utf8"),
);
const rawInfo = (ccxtSymbol: string) => markets[ccxtSymbol].info;

describe("parseInstrumentSpec fed real USDⓈ-M exchangeInfo rows", () => {
  test("real BTCUSDT perpetual: MARKET_LOT_SIZE.maxQty (120) is genuinely smaller than LOT_SIZE.maxQty (1000) — confirms we read the market filter, not the limit filter", async () => {
    const info = rawInfo("BTC/USDT:USDT");
    expect(info.symbol).toBe("BTCUSDT");
    const spec = parseInstrumentSpec(info);
    expect(spec).toEqual({
      symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", marginAsset: "USDT",
      tickSize: 0.1, minPrice: 556.8, maxPrice: 4529764,
      stepSize: 0.001, minQty: 0.001, maxQty: 1000,
      marketStepSize: 0.001, marketMinQty: 0.001, marketMaxQty: 120, // NOT 1000
      minNotional: 50,
    });
  });

  test("real SNTUSDT perpetual mid-settlement: status \"SETTLING\" (not \"TRADING\") is correctly rejected", async () => {
    const info = rawInfo("SNT/USDT:USDT");
    expect(info.status).toBe("SETTLING"); // confirms the fixture's real value
    expect(parseInstrumentSpec(info)).toBeNull();
  });

  test("FIXED: a real COIN-M perpetual uses `contractStatus`, not `status` — parseInstrumentSpec now falls back to it", async () => {
    // Real /dapi/v1/exchangeInfo row for BTCUSD_PERP (COIN-M), captured live
    // by ccxt. USDⓈ-M's exchangeInfo names the field `status`; COIN-M's
    // names the SAME semantic field `contractStatus` — a genuine, verified
    // API-schema divergence between Binance's two futures products.
    // parseInstrumentSpec reads `raw.status` unconditionally:
    //   const status = String(raw.status ?? "");
    //   if (status !== "TRADING") return null;
    // For this real, currently-trading COIN-M contract, raw.status is
    // undefined -> status="" -> always null, even though the contract is
    // live and every other filter (PRICE_FILTER, LOT_SIZE, MARKET_LOT_SIZE)
    // is present and well-formed.
    //
    // NOT exploitable today: binance-coinm-executor.ts imports only
    // `floorToStep` from this module, never `parseInstrumentSpec`/
    // `InstrumentCatalog` (verified: `rg -n "instrumentSpec" src/executor/
    // binance-coinm-executor.ts` → one import, `floorToStep` only). This is
    // a landmine for a FUTURE refactor that reaches for this "shared"
    // catalog to de-duplicate CoinM's own precision handling — it looks
    // reusable and silently isn't.
    const info = rawInfo("BTC/USD:BTC");
    expect(info.symbol).toBe("BTCUSD_PERP");
    expect(info.status).toBeUndefined();
    expect(info.contractStatus).toBe("TRADING"); // the field really is here, just renamed

    const spec = parseInstrumentSpec(info);
    expect(spec).not.toBeNull(); // desired: a live COIN-M perpetual should parse
    expect(spec?.tickSize).toBe(0.1);
  });
});
