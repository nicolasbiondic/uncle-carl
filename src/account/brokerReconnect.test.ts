// ══════════════════════════════════════════════════════════════════════════
// Broker REST reconnection (2026-08-16).
//
// Before this existed, `connected = true` was assigned in exactly ONE place
// per executor — its init(), called once from OrderExecutor.init() at
// startup. A broker that failed to connect at boot (2026-08-13: Alpaca REST
// timeouts → the bot ran DEGRADED, blind to 9 positions, no stop-loss loop)
// could only be cured by cron's health watchdog KILLING the process. These
// tests pin the self-healing path: AccountManager.maybeReconnectExecutor
// rides the existing 60s syncs, retries init() under jittered exponential
// backoff (30s → 5min cap), never throws, never creates timers, and — the
// critical safety property — a reconnect that lands on a DIFFERENT Alpaca
// account re-runs the broker-account swap guard (instanceManifest.ts) and
// HALTs exactly like a boot would. Also pins the init() idempotency guards
// the retry relies on (trade_updates wired once; user-data stream never
// stacked).
// ══════════════════════════════════════════════════════════════════════════
import { beforeAll, describe, expect, test } from "bun:test";
import {
  RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_JITTER_FRAC,
} from "./AccountManager";
import { makeTestDb } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";
import { captureBursts } from "../test-support/events";
import { fakeAlpacaExecutor } from "../test-support/alpaca";
import { fakeBinanceExecutor } from "../test-support/binance";
import { setSyncState } from "../db/database";
import {
  fingerprintIdentity, identitySyncKey, IDENTITY_HALT_REASON_PREFIX,
  _resetPublishedManifestForTests,
} from "../ops/instanceManifest";
import { getDefaultRiskEngine, _resetDefaultRiskEngineForTests } from "../risk/RiskEngine";

beforeAll(() => makeTestDb());

const states = (m: any) => m.reconnectStates as Map<string, any>;

describe("maybeReconnectExecutor — recovery", () => {
  test("a disconnected Alpaca executor is re-inited by the 60s sync hook and comes back connected", async () => {
    let connected = false;
    let initCalls = 0;
    let reverified = 0;
    const exec = {
      isConnected: () => connected,
      init: async () => { initCalls++; connected = true; return true; },
      getAccount: async () => null, // sync body then early-returns — not under test here
    };
    const manager = makeAccountManager({ alpaca: exec });
    // The real re-check is exercised in the identity suite below; here we
    // only pin that a successful ALPACA reconnect triggers it.
    (manager as any).reverifyAlpacaIdentityAfterReconnect = async () => { reverified++; };

    await (manager as any).syncAlpacaAccount();

    expect(initCalls).toBe(1);
    expect(exec.isConnected()).toBe(true);
    expect(reverified).toBe(1);
    // recovered → backoff state cleared, nothing left behind
    expect(states(manager).size).toBe(0);
  });

  test("a connected executor is never re-inited, and stale backoff state is cleared", async () => {
    let initCalls = 0;
    const exec = { isConnected: () => true, init: async () => { initCalls++; return true; } };
    const manager = makeAccountManager({});
    states(manager).set("binance", { delayMs: 1, nextAttemptAt: 0, attempts: 3, inFlight: false });

    await (manager as any).maybeReconnectExecutor("binance", exec, 1_000_000);

    expect(initCalls).toBe(0);
    expect(states(manager).size).toBe(0);
  });

  test("a test fake without init() (test-support default) is skipped, never crashed on", async () => {
    const manager = makeAccountManager({});
    await (manager as any).maybeReconnectExecutor("binance", { isConnected: () => false }, 1_000_000);
    await (manager as any).maybeReconnectExecutor("binance_usdc", null, 1_000_000);
    expect(states(manager).size).toBe(0);
  });
});

describe("maybeReconnectExecutor — backoff", () => {
  test("backoff grows exponentially with jitter, caps at 5min, and never retries inside the window", async () => {
    let initCalls = 0;
    const exec = { isConnected: () => false, init: async () => { initCalls++; return false; } };
    const manager = makeAccountManager({});
    const call = (now: number) => (manager as any).maybeReconnectExecutor("binance", exec, now);

    let now = 1_000_000;
    await call(now); // first detection attempts immediately (60s cadence = initial spacing)
    expect(initCalls).toBe(1);

    // Ticks INSIDE the scheduled window must NOT retry (no every-60s hammer).
    await call(now + 1_000);
    await call(now + RECONNECT_BASE_DELAY_MS - 1);
    expect(initCalls).toBe(1);

    // Failed-attempt gap sequence: 30s, 60s, 2min, 4min, then the 5min cap
    // forever — each stretched by ×(1..1+JITTER_FRAC).
    const expectedGaps = [
      RECONNECT_BASE_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2,
      RECONNECT_BASE_DELAY_MS * 4,
      RECONNECT_BASE_DELAY_MS * 8,
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_MAX_DELAY_MS,
    ];
    for (const [i, gap] of expectedGaps.entries()) {
      const st = states(manager).get("binance");
      expect(st.nextAttemptAt).toBeGreaterThanOrEqual(now + gap);
      expect(st.nextAttemptAt).toBeLessThanOrEqual(now + Math.ceil(gap * (1 + RECONNECT_JITTER_FRAC)));
      now = st.nextAttemptAt;
      await call(now);
      expect(initCalls).toBe(i + 2);
    }
    // Still ONE state entry, no unbounded growth, no timers to leak by design.
    expect(states(manager).size).toBe(1);
  });

  test("an init() that throws repeatedly never escapes the loop and counts as a failed attempt", async () => {
    let initCalls = 0;
    const exec = { isConnected: () => false, init: async () => { initCalls++; throw new Error("ECONNRESET"); } };
    const manager = makeAccountManager({});
    const call = (now: number) => (manager as any).maybeReconnectExecutor("alpaca", exec, now);

    let now = 5_000_000;
    await call(now); // must not throw
    expect(initCalls).toBe(1);
    const st = states(manager).get("alpaca");
    expect(st.inFlight).toBe(false);                       // flag released on the throw path
    expect(st.nextAttemptAt).toBeGreaterThan(now);         // backoff advanced — a throw is a failure
    now = st.nextAttemptAt;
    await call(now);
    expect(initCalls).toBe(2);
    expect(states(manager).size).toBe(1);
  });

  test("overlap guard: a second tick during an in-flight init() does not start a second one", async () => {
    let initCalls = 0;
    let release!: (v: boolean) => void;
    const exec = {
      isConnected: () => false,
      init: () => { initCalls++; return new Promise<boolean>(r => { release = r; }); },
    };
    const manager = makeAccountManager({});
    const first = (manager as any).maybeReconnectExecutor("binance", exec, 1_000_000);
    await Promise.resolve(); // let the first call reach init()
    await (manager as any).maybeReconnectExecutor("binance", exec, 2_000_000);
    expect(initCalls).toBe(1);
    release(false);
    await first;
  });
});

describe("reconnect × broker-account swap guard (instanceManifest.ts)", () => {
  test("reconnecting onto a DIFFERENT Alpaca account HALTs exactly like boot — stays connected, new opens blocked", async () => {
    // A previous boot's ledger belongs to ACCT-A…
    setSyncState(identitySyncKey("alpaca"), fingerprintIdentity("acct", "ACCT-A")!);
    _resetDefaultRiskEngineForTests();
    const { bursts, detach } = captureBursts("InstanceManifest");
    let connected = false;
    const exec = {
      isConnected: () => connected,
      init: async () => { connected = true; return true; },
      // …but the reconnect observes ACCT-B.
      getAccount: async () => ({ account_number: "ACCT-B", id: "ACCT-B", equity: "1000", cash: "1000" }),
    };
    const manager = makeAccountManager({ alpaca: exec });
    try {
      await (manager as any).maybeReconnectExecutor("alpaca", exec, Date.now());

      // Startup semantics, verbatim: the executor STAYS connected (closes/
      // stops/reconciliation keep running on the observed account)…
      expect(connected).toBe(true);
      // …while RiskEngine persists HALTED with the identity reason — new
      // opens blocked until a human sets BROKER_ACCOUNT_ROTATION_ACK.
      const st = getDefaultRiskEngine().getState();
      expect(st.tradingState).toBe("HALTED");
      expect(st.reason.startsWith(`${IDENTITY_HALT_REASON_PREFIX}alpaca`)).toBe(true);
      // …and the on-call page fired.
      expect(bursts.length).toBeGreaterThanOrEqual(1);
    } finally {
      detach();
      _resetPublishedManifestForTests();
      _resetDefaultRiskEngineForTests();
    }
  });
});

describe("init() idempotency guards the retry relies on", () => {
  test("AlpacaExecutor: repeated subscribeTradeUpdates wires WS handlers exactly once (no duplicated ORDER_UPDATEs)", () => {
    const counts = { onOrderUpdate: 0, connect: 0 };
    const exec: any = fakeAlpacaExecutor();
    exec.client = {
      trade_ws: {
        onConnect() {}, onDisconnect() {}, onStateChange() {}, onError() {},
        onOrderUpdate() { counts.onOrderUpdate++; },
        subscribe() {},
        connect() { counts.connect++; },
      },
    };
    exec.subscribeTradeUpdates();
    exec.subscribeTradeUpdates(); // reconnect path
    expect(counts.onOrderUpdate).toBe(1); // handlers registered once, ever
    expect(counts.connect).toBe(2);       // but the reconnect still nudges connect (SDK-idempotent)
  });

  test("BinanceExecutor: startUserDataStream tears down the previous WS/keepalive first (no stacked streams, no leaked interval)", async () => {
    const exec: any = fakeBinanceExecutor({ signedRequest: async () => ({}) }); // no listenKey → returns after teardown
    let closed = 0;
    const oldWs: any = { onclose: () => {}, close: () => { closed++; } };
    exec.userWs = oldWs;
    exec.listenKeyKeepAlive = setInterval(() => {}, 1_000_000);

    await exec.startUserDataStream();

    expect(closed).toBe(1);
    expect(oldWs.onclose).toBeNull();     // detached BEFORE close: its async fire can't null a replacement socket
    expect(exec.userWs).toBeNull();
    expect(exec.listenKeyKeepAlive).toBeNull();
    // Idempotent: nothing left to tear down on a second pass.
    await exec.startUserDataStream();
    expect(closed).toBe(1);
  });
});
