// ══════════════════════════════════════════════
// certify-usdc-coinm.ts — fixture-driven, no live calls
// ══════════════════════════════════════════════
//
// Exercises the certification script's control flow (product enum
// validation, initially-flat pre-checks, exact cert-owned cleanup via
// try/finally on injected post-submit failures) against fake USDC/COIN-M
// executors. Never touches the network or a real DB.

import { describe, test, expect } from "bun:test";
import {
  validateProductArg, validateArgs, certifyCoinM, certifyUsdc, CERT_PRODUCTS,
} from "./certify-usdc-coinm";

const COINM_FILTERS = { status: "TRADING", marginAsset: "BTC", contractSize: 100, tickSize: 0.1, pricePrecision: 1, lotStepSize: 1, lotMinQty: 1, marketLotStepSize: 1, marketLotMinQty: 1 };
const LIVE_COINM_POSITION = { symbol: "BTCUSD_PERP", positionAmt: 1, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 1, updateTime: 1 };

function fakeCoinM(overrides: Record<string, any> = {}) {
  const calls: Record<string, number> = {};
  const bump = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  return {
    calls,
    preflight: async () => { bump("preflight"); return { ok: true }; },
    init: async (opts?: any) => { bump("init"); return true; },
    getOwnedPosition: async () => { bump("getOwnedPosition"); return null; }, // flat by default
    listOwnedStops: async () => { bump("listOwnedStops"); return []; }, // no pre-existing stops by default
    hasTrackedStop: (_s: string) => { bump("hasTrackedStop"); return false; },
    getFilters: async () => { bump("getFilters"); return COINM_FILTERS; },
    placeMarketOrder: async () => { bump("placeMarketOrder"); return { orderId: 1, clientOrderId: "cm-open-1", status: "FILLED", avgPrice: 50_000, executedQty: 1 }; },
    placeStopMarketClose: async () => { bump("placeStopMarketClose"); return { ok: true, kind: "order", id: "cm-stop-1" }; },
    closePosition: async () => { bump("closePosition"); return { success: true, filledPrice: 49_000, executedQty: 1 }; },
    cancelActiveStop: async () => { bump("cancelActiveStop"); return true; },
    ...overrides,
  } as any;
}

function usdcPosition(qty: number) { return { symbol: "BTCUSDC", positionAmt: qty, entryPrice: 50_000, unrealizedProfit: 0, leverage: 1, updateTime: 1 }; }

function fakeUsdc(overrides: Record<string, any> = {}) {
  const calls: Record<string, number> = {};
  const bump = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  // The open/stop deterministic client ids are generated INSIDE certifyUsdc
  // — the fake broker learns them the same way a real one would: echoed
  // back in the placeOrder/placeStopMarketClose calls, then reflected in
  // the next order/openOrders read. This is what proves ownership-by-
  // client-id (not a before/after diff or placeOrder's own return value).
  let capturedOpenClientId: string | undefined;
  let capturedStopClientId: string | undefined;
  return {
    calls,
    preflight: async () => { bump("preflight"); return { ok: true }; },
    init: async () => { bump("init"); return true; },
    getPositions: async () => { bump("getPositions"); return []; }, // flat by default
    getPrice: async () => { bump("getPrice"); return 50_000; },
    minCertQty: async () => { bump("minCertQty"); return 0.0004; }, // exchange-derived minimum by default
    placeOrder: async (_signal: any, _qty: number, _accountId: string, opts?: { clientOrderId?: string }) => {
      bump("placeOrder");
      capturedOpenClientId = opts?.clientOrderId;
      return { quantity: 0.0004, filledPrice: 50_000, externalId: "usdc-order-1" };
    },
    placeStopMarketClose: async (_sym: string, _side: string, _price: number, _qty?: number, clientOrderId?: string) => {
      bump("placeStopMarketClose");
      capturedStopClientId = clientOrderId;
      return true;
    },
    closePosition: async () => { bump("closePosition"); return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0, filledQty: 0.0004 }; },
    cancelAllOrders: async () => { bump("cancelAllOrders"); },
    // Private signedRequest seam the script calls via `exec as any` for the
    // pending-order preflight, the exact-open-order reread, and the exact-id
    // cleanup. No pending orders/algo orders by default (flat account,
    // nothing to preflight-refuse on); once the open order / stop is
    // placed, the (fake) broker's own order carries our client id.
    signedRequest: async (_m: string, path: string, params?: any) => {
      bump("signedRequest");
      if (path === "/fapi/v1/order" && params?.origClientOrderId === capturedOpenClientId) {
        return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
      }
      if (path === "/fapi/v1/openOrders") return capturedStopClientId ? [{ orderId: 555, clientOrderId: capturedStopClientId }] : [];
      if (path === "/fapi/v1/openAlgoOrders") return [];
      return {};
    },
    ...overrides,
  } as any;
}

describe("validateProductArg — enum gate, unknown product is a hard failure", () => {
  test("accepts undefined (run both products)", () => {
    expect(validateProductArg(undefined)).toEqual({ ok: true, value: undefined });
  });
  test("accepts every known product", () => {
    for (const p of CERT_PRODUCTS) expect(validateProductArg(p)).toEqual({ ok: true, value: p });
  });
  test("rejects an unknown product with a reason (caller exits nonzero)", () => {
    const res = validateProductArg("stonks");
    expect(res.ok).toBe(false);
    expect((res as any).reason).toMatch(/unknown --product "stonks"/);
  });
});

describe("certifyCoinM — dry-run and preflight gating", () => {
  test("dry-run stops after preflight, never touches the account", async () => {
    const exec = fakeCoinM();
    expect(await certifyCoinM(exec, false)).toBe(true);
    expect(exec.calls.preflight).toBe(1);
    expect(exec.calls.init).toBeUndefined();
    expect(exec.calls.getOwnedPosition).toBeUndefined();
  });

  test("preflight failure aborts before init or any account read", async () => {
    const exec = fakeCoinM({ preflight: async () => ({ ok: false, reason: "not testnet" }) });
    expect(await certifyCoinM(exec, true)).toBe(false);
    expect(exec.calls.init).toBeUndefined();
  });
});

describe("certifyCoinM — never touches pre-existing state", () => {
  test("refuses when the account is not flat before starting", async () => {
    const exec = fakeCoinM({ getOwnedPosition: async () => LIVE_COINM_POSITION });
    expect(await certifyCoinM(exec, true)).toBe(false);
    expect(exec.calls.placeMarketOrder).toBeUndefined(); // never touched the pre-existing position
  });

  test("refuses when a pre-existing reduceOnly stop is found on the broker (real read, not in-memory tracking)", async () => {
    const exec = fakeCoinM({ listOwnedStops: async () => [{ kind: "order", id: "leftover" }] });
    expect(await certifyCoinM(exec, true)).toBe(false);
    expect(exec.calls.placeMarketOrder).toBeUndefined();
  });

  test("init() is called with skipStartupStopReconcile:true so its own mutating reconcile never runs before the precheck", async () => {
    let initOpts: any;
    let posCall = 0;
    const exec = fakeCoinM({
      init: async (opts: any) => { initOpts = opts; return true; },
      getOwnedPosition: async () => { posCall++; return posCall === 2 ? LIVE_COINM_POSITION : null; },
    });
    expect(await certifyCoinM(exec, true)).toBe(true);
    expect(initOpts).toEqual({ skipStartupStopReconcile: true });
  });
});

describe("certifyCoinM — happy path: exact open -> stop -> verify -> close -> cancel -> verify flat", () => {
  test("full cycle succeeds", async () => {
    let posCall = 0;
    const exec = fakeCoinM({
      getOwnedPosition: async () => { posCall++; return posCall === 2 ? LIVE_COINM_POSITION : null; }, // 1=pre-check flat, 2=verify-open, 3=verify-flat
    });
    expect(await certifyCoinM(exec, true)).toBe(true);
    expect(exec.calls.placeMarketOrder).toBe(1);
    expect(exec.calls.placeStopMarketClose).toBe(1);
    expect(exec.calls.closePosition).toBe(1);
    expect(exec.calls.cancelActiveStop).toBe(1);
    expect(posCall).toBe(3); // pre-check flat, verify-open, verify-flat — exactly the 3 reads the cycle needs
  });
});

describe("certifyCoinM — exact cert-owned qty, never closes a concurrent addition", () => {
  test("refuses to close when the verified-open position exceeds what this run opened (concurrent addition suspected)", async () => {
    let posCall = 0;
    let closeCalls = 0;
    const exec = fakeCoinM({
      // order opens 1 contract, but the broker shows 5 at the verify-open step
      getOwnedPosition: async () => { posCall++; return posCall === 1 ? null : { symbol: "BTCUSD_PERP", positionAmt: 5, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 1, updateTime: 1 }; },
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 49_000, executedQty: 1 }; },
    });
    expect(await certifyCoinM(exec, true)).toBe(false);
    // The finally cleanup closes ONLY the 1 cert-owned contract, never the extra 4.
    expect(closeCalls).toBe(1);
  });

  test("refuses to report success when the close only reduced a partial amount of the cert-owned position", async () => {
    let posCall = 0;
    const exec = fakeCoinM({
      getOwnedPosition: async () => { posCall++; return posCall === 2 ? { symbol: "BTCUSD_PERP", positionAmt: 1, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 1, updateTime: 1 } : null; },
      closePosition: async () => ({ success: true, filledPrice: 49_000, executedQty: 0 }), // reports success but closed nothing of the 1 contract
    });
    expect(await certifyCoinM(exec, true)).toBe(false);
  });

  test("cleanup caps the emergency close at openedContracts even if the broker shows more", async () => {
    let posCall = 0;
    let closeArgs: any[] = [];
    const exec = fakeCoinM({
      placeStopMarketClose: async () => ({ ok: false }), // fail fast right after opening, before verify-open
      getOwnedPosition: async () => { posCall++; return posCall === 1 ? null : { symbol: "BTCUSD_PERP", positionAmt: 5, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 1, updateTime: 1 }; },
      closePosition: async (_s: string, qty: number) => { closeArgs.push(qty); return { success: true, filledPrice: 49_000, executedQty: qty }; },
    });
    expect(await certifyCoinM(exec, true)).toBe(false);
    expect(closeArgs).toEqual([1]); // capped to openedContracts (1), never the broker-reported 5
  });
});

describe("certifyCoinM — try/finally cleanup after a post-submit failure, cert-owned only", () => {
   test("native stop install fails -> finally emergency-closes the cert-owned open position", async () => {
     let posCall = 0;
     let closeCalls = 0;
     const exec = fakeCoinM({
       placeStopMarketClose: async () => ({ ok: false }),
       getOwnedPosition: async () => { posCall++; return posCall === 1 ? null : LIVE_COINM_POSITION; }, // pre-check flat, then live for the cleanup read
       closePosition: async () => { closeCalls++; return { success: true, filledPrice: 49_000, executedQty: 1 }; },
     });
     expect(await certifyCoinM(exec, true)).toBe(false);
     expect(closeCalls).toBe(1); // exactly one cleanup close of the cert-owned position
     expect(exec.calls.cancelActiveStop).toBeUndefined(); // stop was never installed — nothing to cancel
   });

   test("close fails -> finally does NOT cancel the cert-owned stop (stop retained for manual reconcile)", async () => {
     let posCall = 0;
     let closeCalls = 0;
     const exec = fakeCoinM({
       getOwnedPosition: async () => { posCall++; return posCall === 1 ? null : LIVE_COINM_POSITION; }, // pre-check flat, then live from here on
       closePosition: async () => { closeCalls++; return { success: false, filledPrice: 0, executedQty: 0 }; },
     });
     expect(await certifyCoinM(exec, true)).toBe(false);
     expect(closeCalls).toBe(2); // the failed cycle close + the finally's cleanup attempt
     // Stop is retained (NOT canceled) because close failed — manual reconcile required
     expect(exec.calls.cancelActiveStop).toBeUndefined();
   });

    test("happy path never re-cancels or re-closes in the finally block (both flags already cleared)", async () => {
      let posCall = 0;
      const exec = fakeCoinM({
        getOwnedPosition: async () => { posCall++; return posCall === 2 ? LIVE_COINM_POSITION : null; },
      });
      expect(await certifyCoinM(exec, true)).toBe(true);
      expect(exec.calls.closePosition).toBe(1);      // not 2 — finally was a no-op
      expect(exec.calls.cancelActiveStop).toBe(1);    // not 2 — finally was a no-op
    });

    test("close succeeds but final reread throws -> stop NOT canceled, opened retained", async () => {
      let posCall = 0;
      const exec = fakeCoinM({
        getOwnedPosition: async () => {
          posCall++;
          if (posCall === 1) return null; // pre-check flat
          if (posCall === 2) return LIVE_COINM_POSITION; // verify-open
          // posCall === 3: the reread after close throws
          throw new Error("network blip");
        },
      });
      expect(await certifyCoinM(exec, true)).toBe(false);
      // Stop was installed and should NOT be canceled because reread failed
      expect(exec.calls.cancelActiveStop).toBeUndefined();
      // The happy-path close succeeds, but the reread fails so we return false
      // The finally block tries to read again and also fails, so no cleanup close
      expect(exec.calls.closePosition).toBe(1); // only the happy-path close
    });

    test("close succeeds but final reread shows residual -> stop NOT canceled, opened retained", async () => {
      let posCall = 0;
      const exec = fakeCoinM({
        getOwnedPosition: async () => {
          posCall++;
          if (posCall === 1) return null; // pre-check flat
          if (posCall === 2) return LIVE_COINM_POSITION; // verify-open
          // posCall === 3: reread after close shows residual
          return { symbol: "BTCUSD_PERP", positionAmt: 0.5, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 1, updateTime: 1 };
        },
      });
      expect(await certifyCoinM(exec, true)).toBe(false);
      // Stop was installed and should NOT be canceled because position is not flat
      expect(exec.calls.cancelActiveStop).toBeUndefined();
      // The finally block should attempt cleanup close because opened is still true
      expect(exec.calls.closePosition).toBe(2); // happy-path close + finally cleanup close
    });

    test("close succeeds and final reread confirms flat -> stop IS canceled after reread", async () => {
      let posCall = 0;
      const exec = fakeCoinM({
        getOwnedPosition: async () => {
          posCall++;
          if (posCall === 1) return null; // pre-check flat
          if (posCall === 2) return LIVE_COINM_POSITION; // verify-open
          // posCall === 3: reread after close confirms flat
          return null;
        },
      });
      expect(await certifyCoinM(exec, true)).toBe(true);
      // Stop should be canceled AFTER the reread confirms flat
      expect(exec.calls.cancelActiveStop).toBe(1);
      expect(exec.calls.closePosition).toBe(1); // only the happy-path close, no finally cleanup
    });

});

describe("certifyUsdc — never touches pre-existing state", () => {
  test("dry-run stops after preflight", async () => {
    const exec = fakeUsdc();
    expect(await certifyUsdc(exec, false)).toBe(true);
    expect(exec.calls.init).toBeUndefined();
  });

  test("refuses when the account is not flat before starting", async () => {
    const exec = fakeUsdc({ getPositions: async () => [usdcPosition(0.001)] });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeOrder).toBeUndefined();
  });

  test("refuses when minCertQty cannot compute a size (no exchangeInfo spec / invalid price)", async () => {
    const exec = fakeUsdc({ minCertQty: async () => null });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeOrder).toBeUndefined();
  });

  // 2026-07-20 reviewer finding: an absolute certification notional ceiling,
  // independent of (and on top of) minCertQty's own exchange-derived floor.
  test("refuses BEFORE placeOrder when the computed notional exceeds the certification ceiling", async () => {
    const exec = fakeUsdc({ minCertQty: async () => 1 }); // 1 BTC @ $50,000 = $50,000 notional, way over the cap
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeOrder).toBeUndefined();
  });

  test("refuses BEFORE placeOrder when the computed notional is nonfinite", async () => {
    const exec = fakeUsdc({ minCertQty: async () => Infinity });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeOrder).toBeUndefined();
  });

  test("refuses BEFORE placeOrder when the computed notional is nonpositive", async () => {
    const exec = fakeUsdc({ minCertQty: async () => 0 });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeOrder).toBeUndefined();
  });
});

describe("certifyUsdc — happy path and post-submit cleanup", () => {
  test("full cycle succeeds", async () => {
    let posCall = 0;
    const exec = fakeUsdc({
      getPositions: async () => { posCall++; return posCall === 1 ? [] : posCall === 2 ? [usdcPosition(0.0004)] : []; },
    });
    expect(await certifyUsdc(exec, true)).toBe(true);
    expect(exec.calls.placeOrder).toBe(1);
    expect(exec.calls.closePosition).toBe(1);
  });

  test("native stop install fails -> finally emergency-closes the cert-owned open position", async () => {
    let posCall = 0;
    let closeCalls = 0;
    const exec = fakeUsdc({
      placeStopMarketClose: async () => false,
      getPositions: async () => { posCall++; return posCall === 1 ? [] : [usdcPosition(0.0004)]; },
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0 }; },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(closeCalls).toBe(1);
  });

  // 2026-07-20 reviewer finding: closePosition's own /allOpenOrders sweep +
  // algo enumeration must never run for a cert close — only the exact
  // stopClientId, canceled by the script itself after confirmed flat.
  test("both the happy-path close and the finally cleanup close pass skipOrderCleanup:true", async () => {
    let posCall = 0;
    const closeOpts: any[] = [];
    const exec = fakeUsdc({
      getPositions: async () => { posCall++; return posCall === 1 ? [] : posCall === 2 ? [usdcPosition(0.0004)] : []; },
      closePosition: async (_sym: string, _qty: number, _side: string, opts?: any) => {
        closeOpts.push(opts);
        return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0, filledQty: 0.0004 };
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(true);
    expect(closeOpts).toEqual([{ skipOrderCleanup: true }]); // happy-path close only, finally was a no-op

    let posCall2 = 0;
    const closeOpts2: any[] = [];
    const exec2 = fakeUsdc({
      getPositions: async () => { posCall2++; return posCall2 === 1 ? [] : [usdcPosition(0.0004)]; },
      closePosition: async (_sym: string, _qty: number, _side: string, opts?: any) => {
        closeOpts2.push(opts);
        return { success: false, filledPrice: 0, commission: 0, realizedPnl: 0 }; // happy path fails -> finally cleanup close runs
      },
    });
    expect(await certifyUsdc(exec2, true)).toBe(false);
    expect(closeOpts2).toEqual([{ skipOrderCleanup: true }, { skipOrderCleanup: true }]); // happy-path attempt + finally cleanup
  });
});

describe("certifyUsdc — try/finally cleanup after a post-submit failure, cert-owned only", () => {
  test("close succeeds but final reread throws -> stop NOT canceled, opened retained", async () => {
    let posCall = 0;
    let capturedClientId: string | undefined;
    const deletes: any[] = [];
    const exec = fakeUsdc({
      getPositions: async () => {
        posCall++;
        if (posCall === 1) return []; // pre-check flat
        if (posCall === 2) return [usdcPosition(0.0004)]; // verify-open
        // posCall === 3: the reread after close throws
        throw new Error("network blip");
      },
      placeStopMarketClose: async (_s: string, _sd: string, _p: number, _q?: number, clientOrderId?: string) => {
        capturedClientId = clientOrderId;
        return true;
      },
      signedRequest: async (method: string, path: string, params?: any) => {
        if (method === "DELETE") { deletes.push({ path, params }); return {}; }
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
        if (path === "/fapi/v1/openOrders") return capturedClientId ? [{ orderId: 555, clientOrderId: capturedClientId }] : [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    // Stop was installed and should NOT be canceled because reread failed
    expect(deletes).toEqual([]); // no DELETE calls for the stop
  });

  test("close succeeds but final reread shows residual -> stop NOT canceled, opened retained", async () => {
    let posCall = 0;
    let capturedClientId: string | undefined;
    const deletes: any[] = [];
    const exec = fakeUsdc({
      getPositions: async () => {
        posCall++;
        if (posCall === 1) return []; // pre-check flat
        if (posCall === 2) return [usdcPosition(0.0004)]; // verify-open
        // posCall === 3: reread after close shows residual
        return [usdcPosition(0.0002)];
      },
      placeStopMarketClose: async (_s: string, _sd: string, _p: number, _q?: number, clientOrderId?: string) => {
        capturedClientId = clientOrderId;
        return true;
      },
      signedRequest: async (method: string, path: string, params?: any) => {
        if (method === "DELETE") { deletes.push({ path, params }); return {}; }
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
        if (path === "/fapi/v1/openOrders") return capturedClientId ? [{ orderId: 555, clientOrderId: capturedClientId }] : [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    // Stop was installed and should NOT be canceled because position is not flat
    expect(deletes).toEqual([]); // no DELETE calls for the stop
  });

  test("close succeeds and final reread confirms flat -> stop IS canceled after reread", async () => {
    let posCall = 0;
    let capturedClientId: string | undefined;
    const deletes: any[] = [];
    const exec = fakeUsdc({
      getPositions: async () => {
        posCall++;
        if (posCall === 1) return []; // pre-check flat
        if (posCall === 2) return [usdcPosition(0.0004)]; // verify-open
        // posCall === 3: reread after close confirms flat
        return [];
      },
      placeStopMarketClose: async (_s: string, _sd: string, _p: number, _q?: number, clientOrderId?: string) => {
        capturedClientId = clientOrderId;
        return true;
      },
      signedRequest: async (method: string, path: string, params?: any) => {
        if (method === "DELETE") { deletes.push({ path, params }); return {}; }
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
        if (path === "/fapi/v1/openOrders") return capturedClientId ? [{ orderId: 555, clientOrderId: capturedClientId }] : [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(true);
    // Stop should be canceled AFTER the reread confirms flat
    expect(deletes).toEqual([{ path: "/fapi/v1/order", params: { symbol: "BTCUSDC", orderId: "555" } }]);
  });
});

describe("certifyUsdc — pending order preflight + exact-id cleanup (no cancelAllOrders sweep)", () => {
  test("refuses when a pre-existing pending order is found via signedRequest, before ever placing an order", async () => {
    const exec = fakeUsdc({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/fapi/v1/openOrders") return [{ orderId: 999 }];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeOrder).toBeUndefined();
  });

  test("refuses when a pre-existing pending algo order is found via signedRequest, before ever placing an order", async () => {
    const exec = fakeUsdc({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [{ algoId: 888 }];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeOrder).toBeUndefined();
  });

  test("happy path deletes ONLY the cert-owned delta order id created by the stop, never a symbol-wide sweep", async () => {
    let posCall = 0;
    let capturedClientId: string | undefined;
    const deletes: any[] = [];
    const exec = fakeUsdc({
      getPositions: async () => { posCall++; return posCall === 1 ? [] : posCall === 2 ? [usdcPosition(0.0004)] : []; },
      placeStopMarketClose: async (_s: string, _sd: string, _p: number, _q?: number, clientOrderId?: string) => { capturedClientId = clientOrderId; return true; },
      signedRequest: async (method: string, path: string, params?: any) => {
        if (method === "DELETE") { deletes.push({ path, params }); return {}; }
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
        if (path === "/fapi/v1/openOrders") return capturedClientId ? [{ orderId: 555, clientOrderId: capturedClientId }] : [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(true);
    expect(deletes).toEqual([{ path: "/fapi/v1/order", params: { symbol: "BTCUSDC", orderId: "555" } }]);
    expect(exec.calls.cancelAllOrders).toBeUndefined(); // exact delta cleanup only, never a sweep
  });

   test("post-submit failure after the stop is tracked -> finally does NOT delete the stop if close fails (stop retained for manual reconcile)", async () => {
     let posCall = 0;
     let capturedClientId: string | undefined;
     const deletes: any[] = [];
     const exec = fakeUsdc({
       getPositions: async () => { posCall++; return posCall === 1 ? [] : [usdcPosition(0.0004)]; },
       placeStopMarketClose: async (_s: string, _sd: string, _p: number, _q?: number, clientOrderId?: string) => { capturedClientId = clientOrderId; return true; },
       closePosition: async () => ({ success: false, filledPrice: 0, commission: 0, realizedPnl: 0 }), // fails -> finally cleanup path
       signedRequest: async (method: string, path: string, params?: any) => {
         if (method === "DELETE") { deletes.push({ path, params }); return {}; }
         if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
         if (path === "/fapi/v1/openOrders") return capturedClientId ? [{ orderId: 777, clientOrderId: capturedClientId }] : [];
         if (path === "/fapi/v1/openAlgoOrders") return [];
         return {};
       },
     });
     expect(await certifyUsdc(exec, true)).toBe(false);
     // Stop is retained (NOT deleted) because close failed — manual reconcile required
     expect(deletes).toEqual([]);
     expect(exec.calls.cancelAllOrders).toBeUndefined();
   });
});

describe("certifyUsdc — deterministic client id ownership (2026-07-19 reviewer finding)", () => {
  test("concurrent exposure change: refuses to close beyond what this run opened, and finally cleanup closes ONLY the cert-owned delta", async () => {
    let posCall = 0;
    let capturedClientId: string | undefined;
    const closeArgs: number[] = [];
    const exec = fakeUsdc({
      // 1=pre-check flat; 2=verify-open sees 0.0010 even though this run only
      // opened 0.0004 (a concurrent addition to the same symbol); 3=cleanup read.
      getPositions: async () => { posCall++; return posCall === 1 ? [] : [usdcPosition(0.0010)]; },
      placeStopMarketClose: async (_s: string, _sd: string, _p: number, _q?: number, clientOrderId?: string) => { capturedClientId = clientOrderId; return true; },
      closePosition: async (_sym: string, qty: number) => { closeArgs.push(qty); return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0, filledQty: qty }; },
      signedRequest: async (method: string, path: string) => {
        if (method === "DELETE") return {};
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
        if (path === "/fapi/v1/openOrders") return capturedClientId ? [{ orderId: 555, clientOrderId: capturedClientId }] : [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    // The finally cleanup closes ONLY the 0.0004 this run opened, never the
    // concurrently-added 0.0010 — never the whole position.
    expect(closeArgs).toEqual([0.0004]);
  });

  test("pending order snapshot read failure after the stop install blocks the run (never assumes flat/empty)", async () => {
    let posCall = 0;
    let openOrdersCalls = 0;
    let closeCalls = 0;
    const exec = fakeUsdc({
      getPositions: async () => { posCall++; return posCall === 1 ? [] : [usdcPosition(0.0004)]; },
      placeStopMarketClose: async () => true,
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0, filledQty: 0.0004 }; },
      signedRequest: async (method: string, path: string) => {
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
        if (path === "/fapi/v1/openOrders") {
          openOrdersCalls++;
          if (openOrdersCalls === 1) return []; // pre-check: reliable, flat
          throw new Error("network blip"); // post-stop verification read fails
        }
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(closeCalls).toBe(1); // finally emergency-closes the cert-owned position anyway
  });

  test("native stop reports success but no cert-owned order/algo is visible -> refuses before verifying the position, cleanup still cert-scoped", async () => {
    let posCall = 0;
    let openOrdersCalls = 0;
    let closeCalls = 0;
    const exec = fakeUsdc({
      getPositions: async () => { posCall++; return posCall === 1 ? [] : [usdcPosition(0.0004)]; },
      placeStopMarketClose: async () => true, // reports success...
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0, filledQty: 0.0004 }; },
      signedRequest: async (method: string, path: string) => {
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
        if (path === "/fapi/v1/openOrders") {
          openOrdersCalls++;
          // ...but the pending snapshot never carries OUR client id — a
          // stale/foreign order is visible instead (never mistaken for ours).
          return openOrdersCalls === 1 ? [] : [{ orderId: 42, clientOrderId: "some-other-run" }];
        }
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(closeCalls).toBe(1); // emergency-closes the cert-owned position; the foreign order is never touched
  });
});

describe("certifyUsdc — exact open ownership via origClientOrderId (2026-07-20 reviewer finding)", () => {
  test("placeOrder returns null but the exact order confirms FILLED -> stop install + close proceed at the exact qty", async () => {
    let posCall = 0;
    let capturedOpenClientId: string | undefined;
    let capturedStopClientId: string | undefined;
    const closeArgs: number[] = [];
    const exec = fakeUsdc({
      getPositions: async () => { posCall++; return posCall === 1 ? [] : posCall === 2 ? [usdcPosition(0.0004)] : []; },
      placeOrder: async (_s: any, _q: number, _a: string, opts?: any) => { capturedOpenClientId = opts?.clientOrderId; return null; },
      placeStopMarketClose: async (_s: string, _sd: string, _p: number, qty?: number, clientOrderId?: string) => {
        capturedStopClientId = clientOrderId;
        expect(qty).toBe(0.0004); // stop sized off the EXACT order's qty, not placeOrder's (null)
        return true;
      },
      closePosition: async (_sym: string, qty: number) => { closeArgs.push(qty); return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0, filledQty: qty }; },
      signedRequest: async (method: string, path: string, params?: any) => {
        if (method === "GET" && path === "/fapi/v1/order" && params?.origClientOrderId === capturedOpenClientId) {
          return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" };
        }
        if (path === "/fapi/v1/openOrders") return capturedStopClientId ? [{ orderId: 555, clientOrderId: capturedStopClientId }] : [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(true);
    expect(closeArgs).toEqual([0.0004]);
  });

  test("placeOrder reports a bigger aggregate quantity but the exact order's executedQty is smaller -> only the smaller amount is opened/closed", async () => {
    let posCall = 0;
    let capturedOpenClientId: string | undefined;
    let capturedStopClientId: string | undefined;
    const closeArgs: number[] = [];
    const exec = fakeUsdc({
      // Broker position at verify-open matches the TRUE (smaller) exact fill,
      // never the bigger number placeOrder happened to report.
      getPositions: async () => { posCall++; return posCall === 1 ? [] : posCall === 2 ? [usdcPosition(0.0004)] : []; },
      placeOrder: async (_s: any, _q: number, _a: string, opts?: any) => {
        capturedOpenClientId = opts?.clientOrderId;
        return { quantity: 0.0012, filledPrice: 50_000, externalId: "usdc-order-1" }; // aggregate-shaped, bigger than the real fill
      },
      placeStopMarketClose: async (_s: string, _sd: string, _p: number, qty?: number, clientOrderId?: string) => {
        capturedStopClientId = clientOrderId;
        expect(qty).toBe(0.0004); // never the bigger 0.0012 placeOrder reported
        return true;
      },
      closePosition: async (_sym: string, qty: number) => { closeArgs.push(qty); return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0, filledQty: qty }; },
      signedRequest: async (method: string, path: string, params?: any) => {
        if (method === "GET" && path === "/fapi/v1/order" && params?.origClientOrderId === capturedOpenClientId) {
          return { orderId: "usdc-order-1", executedQty: "0.0004", avgPrice: "50000", status: "FILLED" }; // the TRUE exact fill
        }
        if (path === "/fapi/v1/openOrders") return capturedStopClientId ? [{ orderId: 555, clientOrderId: capturedStopClientId }] : [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(true);
    expect(closeArgs).toEqual([0.0004]); // only the exact-order-confirmed amount, never the aggregate 0.0012
  });

  // 2026-07-20 P0: a NEW order with 0 fill is a REAL resting order on the
  // book — failing clean without canceling it would leave a live,
  // unmonitored order that can fill later with no stop attached. It must be
  // exact-canceled by its orderId and confirmed terminal FIRST.
  test("NEW (0 fill) is exact-canceled by orderId and confirmed terminal BEFORE failing clean on a flat broker", async () => {
    const deletes: { path: string; params: any }[] = [];
    const exec = fakeUsdc({
      getPositions: async () => [], // flat throughout
      signedRequest: async (method: string, path: string, params?: any) => {
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "NEW", executedQty: "0", avgPrice: "0" };
        if (method === "DELETE" && path === "/fapi/v1/order") { deletes.push({ path, params }); return { orderId: "usdc-order-1", status: "CANCELED", executedQty: "0", avgPrice: "0" }; }
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(deletes).toEqual([{ path: "/fapi/v1/order", params: { symbol: "BTCUSDC", orderId: "usdc-order-1" } }]); // exact orderId, never a sweep
    expect(exec.calls.placeStopMarketClose).toBeUndefined();
    expect(exec.calls.closePosition).toBeUndefined();
  });

  test("no exact fill confirmed (after exact cancel) but the broker is NOT flat -> fails loud (MANUAL RECONCILE), never touches the ambiguous exposure", async () => {
    let posCall = 0;
    const exec = fakeUsdc({
      // Flat for the pre-check (so the run is allowed to start), then
      // shows unexplained exposure once we go looking for proof of a fill.
      getPositions: async () => { posCall++; return posCall === 1 ? [] : [usdcPosition(0.0004)]; },
      signedRequest: async (method: string, path: string) => {
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "NEW", executedQty: "0", avgPrice: "0" };
        if (method === "DELETE" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "CANCELED", executedQty: "0", avgPrice: "0" };
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeStopMarketClose).toBeUndefined();
    expect(exec.calls.closePosition).toBeUndefined(); // never claims/cancels unproven exposure
  });

  test("PARTIALLY_FILLED is exact-canceled by orderId; the FINAL post-cancel executedQty is used for stop/close, never the initial partial reading", async () => {
    const closeArgs: number[] = [];
    let stopQty: number | undefined;
    let posCall = 0;
    let capturedStopClientId: string | undefined;
    const exec = fakeUsdc({
      // 1=pre-check flat, 2=verify-open (must match the final 0.0006), 3=verify-flat after close
      getPositions: async () => { posCall++; return posCall === 2 ? [usdcPosition(0.0006)] : []; },
      placeStopMarketClose: async (_s: string, _sd: string, _p: number, qty?: number, clientOrderId?: string) => { stopQty = qty; capturedStopClientId = clientOrderId; return true; },
      closePosition: async (_sym: string, qty: number) => { closeArgs.push(qty); return { success: true, filledPrice: 49_000, commission: 0, realizedPnl: 0, filledQty: qty }; },
      signedRequest: async (method: string, path: string) => {
        // Initial read: partially filled at 0.0004. More fills between the
        // read and the cancel -> the cancel response reports the TRUE
        // final 0.0006, which must be what stop/close use.
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "PARTIALLY_FILLED", executedQty: "0.0004", avgPrice: "50000" };
        if (method === "DELETE" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "CANCELED", executedQty: "0.0006", avgPrice: "50000" };
        if (path === "/fapi/v1/openOrders") return capturedStopClientId ? [{ orderId: 555, clientOrderId: capturedStopClientId }] : [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(true);
    expect(stopQty).toBe(0.0006);
    expect(closeArgs).toEqual([0.0006]);
  });

  test("exact cancel of a resting order fails ambiguously (not an unknown-order response) -> fails loud, MANUAL RECONCILE, no stop/close", async () => {
    const exec = fakeUsdc({
      getPositions: async () => [],
      signedRequest: async (method: string, path: string) => {
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "NEW", executedQty: "0", avgPrice: "0" };
        if (method === "DELETE" && path === "/fapi/v1/order") throw new Error("Binance /fapi/v1/order HTTP 503: Service Unavailable");
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeStopMarketClose).toBeUndefined();
    expect(exec.calls.closePosition).toBeUndefined();
  });

  test("exact cancel of a resting order comes back 'unknown order' (already resolved concurrently) -> fails loud, never guesses the fill amount", async () => {
    const exec = fakeUsdc({
      getPositions: async () => [],
      signedRequest: async (method: string, path: string) => {
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "NEW", executedQty: "0", avgPrice: "0" };
        if (method === "DELETE" && path === "/fapi/v1/order") { const e: any = new Error("Binance /fapi/v1/order -2011: Unknown order sent."); e.code = -2011; throw e; }
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeStopMarketClose).toBeUndefined();
    expect(exec.calls.closePosition).toBeUndefined();
  });

  test("cancel response AND the bounded requery both stay non-terminal -> fails loud, MANUAL RECONCILE, no stop/close", async () => {
    const exec = fakeUsdc({
      getPositions: async () => [],
      signedRequest: async (method: string, path: string) => {
        if (method === "GET" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "NEW", executedQty: "0", avgPrice: "0" };
        if (method === "DELETE" && path === "/fapi/v1/order") return { orderId: "usdc-order-1", status: "PENDING_CANCEL", executedQty: "0", avgPrice: "0" }; // never resolves
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeStopMarketClose).toBeUndefined();
    expect(exec.calls.closePosition).toBeUndefined();
  });

  // 2026-07-20 P0: when the initial exact read fails, even unknown-order plus
  // a flat position is not terminal proof; both broker views can lag.
  test("initial exact read fails outright; unknown-order cancel remains ambiguous even while flat", async () => {
    let getAttempts = 0;
    const deletes: any[] = [];
    const exec = fakeUsdc({
      getPositions: async () => [], // flat throughout
      signedRequest: async (method: string, path: string, params?: any) => {
        if (method === "GET" && path === "/fapi/v1/order") { getAttempts++; throw new Error("network timeout"); }
        if (method === "DELETE" && path === "/fapi/v1/order") { deletes.push(params); const e: any = new Error("Binance /fapi/v1/order -2011: Unknown order sent."); e.code = -2011; throw e; }
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(getAttempts).toBe(3); // queryExactOrder's bounded retries all exhausted
    expect(deletes).toEqual([{ symbol: "BTCUSDC", origClientOrderId: expect.any(String) }]); // no orderId known -> exact clientOrderId
    expect(exec.calls.placeStopMarketClose).toBeUndefined();
    expect(exec.calls.closePosition).toBeUndefined();
  });

  test("initial exact read fails outright; exact cancel by origClientOrderId comes back unknown-order, but the broker is NOT flat -> fails loud, MANUAL RECONCILE", async () => {
    let posCall = 0;
    const exec = fakeUsdc({
      getPositions: async () => { posCall++; return posCall === 1 ? [] : [usdcPosition(0.0004)]; },
      signedRequest: async (method: string, path: string) => {
        if (method === "GET" && path === "/fapi/v1/order") throw new Error("network timeout");
        if (method === "DELETE" && path === "/fapi/v1/order") { const e: any = new Error("Binance /fapi/v1/order -2011: Unknown order sent."); e.code = -2011; throw e; }
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeStopMarketClose).toBeUndefined();
    expect(exec.calls.closePosition).toBeUndefined();
  });

  test("initial exact read fails outright; the exact cancel ALSO fails for a non-unknown-order reason -> fails loud, never assumes flat", async () => {
    const exec = fakeUsdc({
      getPositions: async () => [], // even though it's flat, ambiguity must still refuse — never guessed
      signedRequest: async (method: string, path: string) => {
        if (method === "GET" && path === "/fapi/v1/order") throw new Error("network timeout");
        if (method === "DELETE" && path === "/fapi/v1/order") throw new Error("Binance /fapi/v1/order HTTP 503: Service Unavailable");
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [];
        return {};
      },
    });
    expect(await certifyUsdc(exec, true)).toBe(false);
    expect(exec.calls.placeStopMarketClose).toBeUndefined();
    expect(exec.calls.closePosition).toBeUndefined();
  });
});

describe("validateArgs — full argv validation, not just --product", () => {
  test("accepts --execute and --product together", () => {
    expect(validateArgs(["--execute", "--product=usdc"])).toEqual({ ok: true, execute: true, product: "usdc" });
  });
  test("accepts no args (dry-run, both products)", () => {
    expect(validateArgs([])).toEqual({ ok: true, execute: false, product: undefined });
  });
  test("rejects an unknown flag instead of silently ignoring it", () => {
    const res = validateArgs(["--exceute"]); // typo for --execute
    expect(res.ok).toBe(false);
    expect((res as any).reason).toMatch(/unknown argument "--exceute"/);
  });
  test("still rejects an unknown --product value through the same gate", () => {
    const res = validateArgs(["--product=stonks"]);
    expect(res.ok).toBe(false);
  });
});
