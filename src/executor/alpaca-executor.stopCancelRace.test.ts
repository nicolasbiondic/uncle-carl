// ── Cancel-stop → close race (MA 2026-09-25, CAT 2026-09-14) ────────────────
// Alpaca ACCEPTS a stop's DELETE and the order sits `pending_cancel` while its
// shares stay held_for_orders; a close submitted immediately bounces with 403
// "insufficient qty available". closePosition must (a) wait for the canceled
// stop to reach a terminal status before submitting, (b) treat a stop that
// FILLED during the cancel as "position closed by the stop" (existing
// 404/flat reconcile — never an invented fill), and (c) retry a held-qty 403
// close a bounded number of times. At the open the cancel can take 7–23 s
// (MRK 2026-09-30, XLE + GOOGL 2026-10-02): the production settle window
// must outlast that.
import { afterEach, describe, expect, test, mock } from "bun:test";
import { fakeAlpacaExecutor as executor } from "../test-support/alpaca";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** OUR open GTC stop on `symbol`, in the getOrders wire shape. */
function ourStop(symbol: string) {
  return { id: "our-stop-id", client_order_id: "uc8-momentum_stocks-slabc", symbol, side: "sell", type: "stop", qty: "11", stop_price: "384.00", status: "new" };
}

describe("AlpacaExecutor cancel-stop settle (pending_cancel → terminal before the close)", () => {
  test("close waits for the canceled stop to leave pending_cancel, then submits and fills", async () => {
    const exec = executor({ stopCancelSettlePollMs: 1, stopCancelSettleTimeoutMs: 200 }) as any;
    const getOrder = mock()
      .mockResolvedValueOnce({ id: "our-stop-id", status: "pending_cancel" })
      .mockResolvedValueOnce({ id: "our-stop-id", status: "pending_cancel" })
      .mockResolvedValueOnce({ id: "our-stop-id", status: "canceled" });
    const sdkClose = mock(async () => ({ id: "close-1" }));
    exec.client = {
      getOrders: async () => [ourStop("UNH")],
      cancelOrder: mock(async () => ({})),
      getOrder,
      getPosition: async () => ({ qty: "11" }),
      closePosition: sdkClose,
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 11, filledAt: Date.now() });

    const result = await exec.closePosition("UNH", "buy", 11);

    expect(result.success).toBe(true);
    expect(getOrder).toHaveBeenCalledTimes(3); // polled until terminal, not fire-and-forget
    expect(sdkClose).toHaveBeenCalledTimes(1);
  });

  test("stop FILLED while its cancel was pending → position was closed BY THE STOP: flat broker → http_404 reconcile, no close order, no invented fill", async () => {
    const exec = executor({ stopCancelSettlePollMs: 1, stopCancelSettleTimeoutMs: 200 }) as any;
    const sdkClose = mock(async () => ({ id: "never" }));
    exec.client = {
      getOrders: async () => [ourStop("UNH")],
      cancelOrder: mock(async () => ({})),
      getOrder: async () => ({ id: "our-stop-id", status: "filled", filled_qty: "11", filled_avg_price: "384.00" }),
      getPosition: async () => ({ qty: "0" }), // the stop's fill flattened it
      closePosition: sdkClose,
    };

    const result = await exec.closePosition("UNH", "buy", 11);

    expect(result.success).toBe(false);
    expect(result.reason).toBe("http_404"); // existing BROKER_GONE / stop-fired reconcile path
    expect(sdkClose).not.toHaveBeenCalled();
  });

  test("a stop stuck pending_cancel past the settle window fails open — the close is still attempted", async () => {
    const exec = executor({ stopCancelSettlePollMs: 1, stopCancelSettleTimeoutMs: 5 }) as any;
    const sdkClose = mock(async () => ({ id: "close-1" }));
    exec.client = {
      getOrders: async () => [ourStop("UNH")],
      cancelOrder: mock(async () => ({})),
      getOrder: async () => ({ id: "our-stop-id", status: "pending_cancel" }),
      getPosition: async () => ({ qty: "11" }),
      closePosition: sdkClose,
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 11, filledAt: Date.now() });

    const result = await exec.closePosition("UNH", "buy", 11);

    expect(result.success).toBe(true);
    expect(sdkClose).toHaveBeenCalledTimes(1);
  });

  test("production timing: a cancel that completes 23 s after the request (the slowest seen at the open) settles before the close — one submission, no 403", async () => {
    const exec = executor() as any; // production settle values, fake clock only
    let t = 0;
    const sleeps: number[] = [];
    exec.settleNow = () => t;
    exec.settleSleep = async (ms: number) => { sleeps.push(ms); t += ms; };
    let closeSubmittedAt: number | null = null;
    const sdkClose = mock(async () => { closeSubmittedAt = t; return { id: "close-1" }; });
    exec.client = {
      getOrders: async () => [ourStop("GOOGL")],
      cancelOrder: mock(async () => ({})),
      getOrder: async () => ({ id: "our-stop-id", status: t < 23_000 ? "pending_cancel" : "canceled" }),
      getPosition: async () => ({ qty: "19" }),
      closePosition: sdkClose,
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 343.5, filledQty: 19, filledAt: Date.now() });

    const result = await exec.closePosition("GOOGL", "buy", 19);

    expect(result.success).toBe(true);
    expect(sdkClose).toHaveBeenCalledTimes(1);
    expect(closeSubmittedAt!).toBeGreaterThanOrEqual(23_000); // only once the shares were released
    // 500 ms polls for the first 5 s, then 2 s: ~19 reads instead of ~46.
    expect(sleeps.slice(0, 10).every(ms => ms === 500)).toBe(true);
    expect(sleeps.slice(10).every(ms => ms === 2_000)).toBe(true);
    expect(sleeps.length).toBeLessThan(20);
  });

  test("production timing: a cancel that never completes still ends at the 30 s window and the close is attempted (fail open)", async () => {
    const exec = executor({ heldQtyRetryDelayMs: 1 }) as any;
    let t = 0;
    exec.settleNow = () => t;
    exec.settleSleep = async (ms: number) => { t += ms; };
    const sdkClose = mock(async () => ({ id: "close-1" }));
    exec.client = {
      getOrders: async () => [ourStop("GOOGL")],
      cancelOrder: mock(async () => ({})),
      getOrder: async () => ({ id: "our-stop-id", status: "pending_cancel" }),
      getPosition: async () => ({ qty: "19" }),
      closePosition: sdkClose,
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 343.5, filledQty: 19, filledAt: Date.now() });

    const result = await exec.closePosition("GOOGL", "buy", 19);

    expect(result.success).toBe(true);
    expect(t).toBeGreaterThanOrEqual(30_000);
    expect(t).toBeLessThan(33_000);
    expect(sdkClose).toHaveBeenCalledTimes(1);
  });
});

describe("AlpacaExecutor held-qty 403 close retry (bounded retries after settle)", () => {
  test("403 'insufficient qty available' then success → exactly one retry, close succeeds", async () => {
    const exec = executor({ heldQtyRetryDelayMs: 1 }) as any;
    let closeCalls = 0;
    exec.client = {
      getPosition: async () => ({ qty: "11" }),
      closePosition: async () => {
        closeCalls++;
        if (closeCalls === 1) {
          throw Object.assign(new Error("forbidden"), { response: { status: 403, data: { message: "insufficient qty available for order (requested: 11, available: 0)" } } });
        }
        return { id: "close-2" };
      },
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 11, filledAt: Date.now() });

    const result = await exec.closePosition("MA", "buy", 11);

    expect(result.success).toBe(true);
    expect(closeCalls).toBe(2);
  });

  test("held-qty 403 on every attempt → 1 + heldQtyMaxRetries attempts, final reason stays the exact 'http_403' AccountManager matches on", async () => {
    const exec = executor({ heldQtyRetryDelayMs: 1, heldQtyMaxRetries: 3 }) as any;
    let closeCalls = 0;
    exec.client = {
      getPosition: async () => ({ qty: "11" }),
      closePosition: async () => {
        closeCalls++;
        throw Object.assign(new Error("forbidden"), { response: { status: 403, data: { message: "insufficient qty available for order (requested: 11, available: 0)" } } });
      },
    };

    const result = await exec.closePosition("MA", "buy", 11);

    expect(result.success).toBe(false);
    expect(result.reason).toBe("http_403");
    expect(closeCalls).toBe(4); // bounded, never loops
  });

  test("production retry budget: 3 retries 2 s apart", () => {
    const exec = executor() as any;
    expect(exec.heldQtyMaxRetries).toBe(3);
    expect(exec.heldQtyRetryDelayMs).toBe(2_000);
    expect(exec.stopCancelSettleTimeoutMs).toBe(30_000);
  });

  test("a NON-held 403 (PDT/permission) is not retried — one attempt, http_403 preserved", async () => {
    const exec = executor({ heldQtyRetryDelayMs: 1 }) as any;
    let closeCalls = 0;
    exec.client = {
      getPosition: async () => ({ qty: "11" }),
      closePosition: async () => {
        closeCalls++;
        throw Object.assign(new Error("forbidden"), { response: { status: 403, data: { message: "account is not authorized to trade" } } });
      },
    };

    const result = await exec.closePosition("KO", "buy", 11);

    expect(result.success).toBe(false);
    expect(result.reason).toBe("http_403");
    expect(closeCalls).toBe(1);
  });

  test("partial-close REST path: 403 held-qty body → one retry through the same qty-bounded DELETE", async () => {
    const exec = executor({ heldQtyRetryDelayMs: 1 }) as any;
    exec.client = { getPosition: async () => ({ qty: "22" }) }; // broker 22 / ours 11 → REST ?qty= path
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 11, filledAt: Date.now() });
    const urls: string[] = [];
    let fetchCalls = 0;
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      fetchCalls++;
      if (fetchCalls === 1) {
        return { ok: false, status: 403, text: async () => '{"code":40310000,"message":"insufficient qty available for order (requested: 11, available: 0)"}' } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ id: "close-1" }) } as Response;
    }) as unknown as typeof fetch;

    const result = await exec.closePosition("UNH", undefined, 11);

    expect(result.success).toBe(true);
    expect(fetchCalls).toBe(2);
    for (const u of urls) expect(u).toContain("/v2/positions/UNH?qty=11");
  });
});
