import { describe, test, expect, afterEach } from "bun:test";
import {
  checkStopAgainstMainnet, fetchMainnetMarkPrice, stopConfirmMode,
  DEFAULT_STOP_CONFIRM, MAINNET_FAPI,
} from "./mainnetStopConfirm";

// ── The real incident series (OPEN.md P1, 2026-07-20 07:45) ──────────────
// momentum_crypto LINK long: entry ≈ 7.956 (recorded fill 7.8181 = −1.73%
// from entry; 4% stop at 7.638 = entry×0.96 — both reconstructions agree).
// Testnet fired the stop and filled 7.8181 while MAINNET traded 8.29–8.36.
const LINK = { side: "buy" as const, entryPrice: 7.956, stopLossPct: 4 };

describe("checkStopAgainstMainnet — pure predicate", () => {
  test("the 2026-07-20 LINK ghost stop is REJECTED: mainnet 8.29–8.36 never breached the −4% stop", () => {
    for (const mainnetPrice of [8.29, 8.32, 8.36]) {
      const v = checkStopAgainstMainnet({ ...LINK, mainnetPrice });
      expect(v.kind).toBe("rejected");
      if (v.kind === "rejected") {
        expect(v.mainnetPnlPct).toBeGreaterThan(0); // mainnet was in PROFIT
        expect(v.detail).toContain("not breached");
      }
    }
  });

  test("even the whole-hold mainnet LOW (7.788, −2.11%) does not confirm a −4% stop", () => {
    const v = checkStopAgainstMainnet({ ...LINK, mainnetPrice: 7.788 });
    expect(v.kind).toBe("rejected");
  });

  test("a legitimate stop confirms: mainnet also below the stop price", () => {
    const v = checkStopAgainstMainnet({ ...LINK, mainnetPrice: 7.60 }); // < 7.638 stop
    expect(v.kind).toBe("confirmed");
    if (v.kind === "confirmed") expect(v.mainnetPnlPct).toBeLessThan(-4);
  });

  test("slack band: mainnet within slackPct of the stop confirms (read-skew tolerance), beyond it rejects", () => {
    // stop −4%, slack 0.5pp → threshold −3.5%
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: 100, stopLossPct: 4, mainnetPrice: 96.4 }).kind).toBe("confirmed"); // −3.6%
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: 100, stopLossPct: 4, mainnetPrice: 97.0 }).kind).toBe("rejected");  // −3.0%
  });

  test("short side: adverse move is UP", () => {
    expect(checkStopAgainstMainnet({ side: "sell", entryPrice: 100, stopLossPct: 4, mainnetPrice: 104.5 }).kind).toBe("confirmed");
    expect(checkStopAgainstMainnet({ side: "sell", entryPrice: 100, stopLossPct: 4, mainnetPrice: 100.5 }).kind).toBe("rejected");
  });

  test("slack is clamped: never more than half the stop, never negative", () => {
    // stop 0.6, slack cfg 0.5 → clamped to 0.3 → threshold −0.3
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: 100, stopLossPct: 0.6, mainnetPrice: 99.65 }, { slackPct: 0.5 }).kind).toBe("confirmed"); // −0.35
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: 100, stopLossPct: 0.6, mainnetPrice: 99.75 }, { slackPct: 0.5 }).kind).toBe("rejected");  // −0.25
    // negative slack behaves as 0
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: 100, stopLossPct: 4, mainnetPrice: 96 }, { slackPct: -1 }).kind).toBe("confirmed");
  });

  // Bad inputs are UNAVAILABLE (caller fails open), never "rejected":
  // blocking a protective close on corrupt bookkeeping is the worse failure
  // — the inverse of plausibility.ts's fail-closed reads, by design.
  test("no/invalid mainnet price ⇒ unavailable, not rejected", () => {
    for (const mainnetPrice of [0, -1, NaN, Infinity]) {
      expect(checkStopAgainstMainnet({ ...LINK, mainnetPrice }).kind).toBe("unavailable");
    }
  });

  test("corrupt entry/stop inputs ⇒ unavailable, not rejected", () => {
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: 0, stopLossPct: 4, mainnetPrice: 8.3 }).kind).toBe("unavailable");
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: NaN, stopLossPct: 4, mainnetPrice: 8.3 }).kind).toBe("unavailable");
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: 100, stopLossPct: 0, mainnetPrice: 8.3 }).kind).toBe("unavailable");
    expect(checkStopAgainstMainnet({ side: "buy", entryPrice: 100, stopLossPct: NaN, mainnetPrice: 8.3 }).kind).toBe("unavailable");
  });

  test("default config carries the measured 0.5pp slack", () => {
    expect(DEFAULT_STOP_CONFIRM.slackPct).toBe(0.5);
  });
});

describe("stopConfirmMode — observe is the default (conservative vs current prod behavior)", () => {
  const saved = process.env.BINANCE_STOP_CONFIRM_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.BINANCE_STOP_CONFIRM_MODE;
    else process.env.BINANCE_STOP_CONFIRM_MODE = saved;
  });

  test("unset / garbage ⇒ observe; only the literal 'enforce' enforces", () => {
    expect(stopConfirmMode(undefined)).toBe("observe");
    expect(stopConfirmMode("")).toBe("observe");
    expect(stopConfirmMode("ENFORCE")).toBe("observe"); // exact-match, same as plausibilityMode
    expect(stopConfirmMode("enforce")).toBe("enforce");
  });

  test("reads BINANCE_STOP_CONFIRM_MODE at call time", () => {
    delete process.env.BINANCE_STOP_CONFIRM_MODE;
    expect(stopConfirmMode()).toBe("observe");
    process.env.BINANCE_STOP_CONFIRM_MODE = "enforce";
    expect(stopConfirmMode()).toBe("enforce");
  });
});

describe("fetchMainnetMarkPrice — public premiumIndex, 0 on ANY failure (maps to fail-open)", () => {
  const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  test("hits MAINNET premiumIndex for the native symbol", async () => {
    let url = "";
    const p = await fetchMainnetMarkPrice("LINKUSDT", (async (u: string) => { url = u; return okJson({ symbol: "LINKUSDT", markPrice: "8.32" }); }) as any);
    expect(p).toBe(8.32);
    expect(url).toBe(`${MAINNET_FAPI}/fapi/v1/premiumIndex?symbol=LINKUSDT`);
  });

  test("array payload: picks the row for the requested symbol", async () => {
    const body = [{ symbol: "BTCUSDT", markPrice: "50000" }, { symbol: "LINKUSDT", markPrice: "8.29" }];
    expect(await fetchMainnetMarkPrice("LINKUSDT", (async () => okJson(body)) as any)).toBe(8.29);
  });

  test("HTTP error ⇒ 0", async () => {
    expect(await fetchMainnetMarkPrice("LINKUSDT", (async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as any)).toBe(0);
  });

  test("transport throw (timeout/abort) ⇒ 0", async () => {
    expect(await fetchMainnetMarkPrice("LINKUSDT", (async () => { throw new Error("abort"); }) as any)).toBe(0);
  });

  test("malformed markPrice ⇒ 0", async () => {
    expect(await fetchMainnetMarkPrice("LINKUSDT", (async () => okJson({ symbol: "LINKUSDT", markPrice: "garbage" })) as any)).toBe(0);
    expect(await fetchMainnetMarkPrice("LINKUSDT", (async () => okJson([])) as any)).toBe(0);
  });
});
