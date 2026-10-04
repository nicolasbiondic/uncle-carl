// ══════════════════════════════════════════════
// verify-binance-transport — the READ-ONLY guarantee, locked by test
// ══════════════════════════════════════════════
//
// The director runs this script against the live sandbox account. It must be
// structurally incapable of transmitting a mutation: readOnlyTransport throws
// on ANY non-GET signed request BEFORE the inner transport (and therefore
// before the limiter, the SDK, or any socket) is touched — and the snapshot
// collector itself only ever issues GETs.

import { describe, test, expect } from "bun:test";
import { readOnlyTransport, collectSnapshot } from "./verify-binance-transport";
import type { BinanceUsdmTransport } from "../src/executor/binance/usdmTransport";

function recordingTransport(): { transport: BinanceUsdmTransport; calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = [];
  const empty = (path: string): any => {
    if (path === "/fapi/v2/account") return { assets: [] };
    if (path === "/fapi/v1/openAlgoOrders") return { orders: [] };
    return [];
  };
  return {
    calls,
    transport: {
      kind: "legacy",
      async signedRequest(method, path) {
        calls.push({ method, path });
        return empty(path);
      },
      async publicRequest(path) {
        calls.push({ method: "GET", path });
        return { ok: true, status: 200, json: async () => ({ symbols: [] }) };
      },
      async serverTime() {
        return { ok: true, status: 200, json: async () => ({ serverTime: Date.now() }) };
      },
    },
  };
}

describe("readOnlyTransport", () => {
  test("refuses POST/PUT/DELETE BEFORE the inner transport sees anything", async () => {
    const { transport, calls } = recordingTransport();
    const ro = readOnlyTransport(transport);
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      // Deliberately a synchronous throw, not a rejected promise: nothing
      // downstream (limiter included) may even be awaited.
      expect(() => ro.signedRequest(method, "/fapi/v1/order", { symbol: "BTCUSDT" })).toThrow(/read-only/);
    }
    expect(calls).toHaveLength(0); // the inner transport was NEVER reached
  });

  test("GETs pass through untouched", async () => {
    const { transport, calls } = recordingTransport();
    const ro = readOnlyTransport(transport);
    await ro.signedRequest("GET", "/fapi/v2/account");
    expect(calls).toEqual([{ method: "GET", path: "/fapi/v2/account" }]);
  });
});

describe("collectSnapshot is GET-only end to end", () => {
  test("a full snapshot over a read-only transport issues GETs exclusively and never throws the guard", async () => {
    const { transport, calls } = recordingTransport();
    const snap = await collectSnapshot(readOnlyTransport(transport), Date.now());
    expect(calls.length).toBeGreaterThan(3); // account, positionRisk, orders, algo, income, exchangeInfo
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(snap.positions).toEqual([]);
    expect(Object.keys(snap.specs).length).toBeGreaterThan(10); // the live universe was asked for
  });
});
