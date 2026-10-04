// Corporate-actions feed + daily monitor (2026-08-03). Doc facts under test
// (docs.alpaca.markets, verified 2026-08-03): reverse splits CANCEL working
// GTC orders, forward splits ADJUST them (status `replaced`), and the feed
// itself "may not be available immediately" — so everything here is advisory
// and fail-open: a dead endpoint returns null (UNKNOWN), never [] ("no
// events"), and never throws into the trading path.

import { describe, expect, test } from "bun:test";
import {
  fetchCorporateActions, dailyRunDue, getETHour,
  CorporateActionsMonitor, CA_DAILY_RUN_HOUR_ET,
  type CorporateActionEvent, type FetchFn,
} from "./corporateActions";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}

function fetchQueue(captured: string[], ...responses: Response[]): FetchFn {
  return async (url: string) => {
    captured.push(url);
    const r = responses.shift();
    if (!r) throw new Error("unexpected fetch");
    return r;
  };
}

describe("fetchCorporateActions — normalization", () => {
  test("splits normalize with ratio = new_rate/old_rate; request carries symbols, types, window and adjustment-relevant params", async () => {
    const urls: string[] = [];
    const fetchFn = fetchQueue(urls, jsonResponse({
      corporate_actions: {
        forward_splits: [{ symbol: "AAPL", old_rate: 1, new_rate: 2, ex_date: "2026-08-01", process_date: "2026-08-01" }],
        reverse_splits: [{ symbol: "XYZ", old_rate: 10, new_rate: 1, ex_date: "2026-08-10" }],
      },
    }));

    const events = await fetchCorporateActions(["AAPL", "XYZ"], "2026-07-29", "2026-08-10", fetchFn);

    expect(events).not.toBeNull();
    expect(events!).toHaveLength(2);
    const fwd = events!.find(e => e.type === "forward_split")!;
    expect(fwd).toMatchObject({ symbol: "AAPL", exDate: "2026-08-01", oldRate: 1, newRate: 2, ratio: 2 });
    const rev = events!.find(e => e.type === "reverse_split")!;
    expect(rev.symbol).toBe("XYZ");
    expect(rev.ratio).toBeCloseTo(0.1, 10);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v1/corporate-actions?");
    expect(urls[0]).toContain(`symbols=${encodeURIComponent("AAPL,XYZ")}`);
    expect(urls[0]).toContain("forward_split");
    expect(urls[0]).toContain("reverse_split");
    expect(urls[0]).toContain("start=2026-07-29");
    expect(urls[0]).toContain("end=2026-08-10");
  });

  test("type-dependent symbol fields (name_changes old_symbol) resolve to the HELD symbol; non-split types carry no ratio", async () => {
    const fetchFn = fetchQueue([], jsonResponse({
      corporate_actions: {
        name_changes: [{ old_symbol: "FB", new_symbol: "META", process_date: "2026-08-01" }],
      },
    }));
    const events = await fetchCorporateActions(["FB"], "2026-07-29", "2026-08-10", fetchFn);
    expect(events!).toHaveLength(1);
    expect(events![0]).toMatchObject({ symbol: "FB", type: "name_change", exDate: "2026-08-01" });
    expect(events![0].ratio).toBeUndefined();
  });

  test("F4a: injected auth overrides dataUrl + headers (registry mode); default stays config", async () => {
    const seen: Array<{ url: string; headers: any }> = [];
    const fetchFn: FetchFn = async (url, opts) => {
      seen.push({ url, headers: opts?.headers });
      return jsonResponse({ corporate_actions: {} });
    };
    await fetchCorporateActions(["AAPL"], "2026-07-29", "2026-08-10", fetchFn, {
      dataUrl: "https://data.alpaca.markets",
      headers: { Authorization: "Bearer tok-abc" },
    });
    expect(seen[0].url.startsWith("https://data.alpaca.markets/v1/corporate-actions?")).toBe(true);
    expect(seen[0].headers).toEqual({ Authorization: "Bearer tok-abc" });
    // No auth param → the APCA header pair from config (env mode, as always).
    await fetchCorporateActions(["AAPL"], "2026-07-29", "2026-08-10", fetchFn);
    expect(Object.keys(seen[1].headers)).toEqual(["APCA-API-KEY-ID", "APCA-API-SECRET-KEY"]);
  });

  test("paginates via next_page_token and merges pages", async () => {
    const urls: string[] = [];
    const fetchFn = fetchQueue(urls,
      jsonResponse({ corporate_actions: { forward_splits: [{ symbol: "A", old_rate: 1, new_rate: 2, ex_date: "2026-08-01" }] }, next_page_token: "tok1" }),
      jsonResponse({ corporate_actions: { reverse_splits: [{ symbol: "B", old_rate: 5, new_rate: 1, ex_date: "2026-08-02" }] } }),
    );
    const events = await fetchCorporateActions(["A", "B"], "2026-07-29", "2026-08-10", fetchFn);
    expect(events!).toHaveLength(2);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("page_token=tok1");
  });

  test("FAIL-OPEN: HTTP error and thrown fetch both return null (UNKNOWN), never [] and never a throw", async () => {
    const httpErr = await fetchCorporateActions(["AAPL"], "2026-07-29", "2026-08-10",
      async () => ({ ok: false, status: 500, statusText: "boom" } as Response));
    expect(httpErr).toBeNull();

    const netErr = await fetchCorporateActions(["AAPL"], "2026-07-29", "2026-08-10",
      async () => { throw new Error("ECONNRESET"); });
    expect(netErr).toBeNull();
  });

  test("empty universe short-circuits to [] without touching the network", async () => {
    const events = await fetchCorporateActions([], "2026-07-29", "2026-08-10",
      async () => { throw new Error("must not fetch"); });
    expect(events).toEqual([]);
  });
});

describe("dailyRunDue — pre-open ET schedule", () => {
  // 2026-08-03 is EDT (UTC-4): 11:00Z = 07:00 ET, 13:00Z = 09:00 ET.
  const beforeThreshold = Date.parse("2026-08-03T11:00:00Z");
  const afterThreshold = Date.parse("2026-08-03T13:00:00Z");

  test("threshold hour is pre-open and post-BOD (02:15–02:30 ET position adjustment job)", () => {
    expect(CA_DAILY_RUN_HOUR_ET).toBeGreaterThanOrEqual(3); // after the BOD job
    expect(CA_DAILY_RUN_HOUR_ET).toBeLessThan(9.5);         // before the 09:30 open
  });

  test("not due before the ET threshold hour; due after; never twice for the same ET day", () => {
    expect(getETHour(beforeThreshold)).toBe(7);
    expect(dailyRunDue("", beforeThreshold)).toBe(false);
    expect(dailyRunDue("", afterThreshold)).toBe(true);
    expect(dailyRunDue("2026-08-03", afterThreshold)).toBe(false); // already ran today
    expect(dailyRunDue("2026-08-02", afterThreshold)).toBe(true);  // yesterday's run doesn't count
  });
});

describe("CorporateActionsMonitor.runOnce", () => {
  const NOW = Date.parse("2026-08-03T13:00:00Z"); // 2026-08-03 09:00 ET

  function monitor(events: unknown, held: string[], onEvent: (ev: CorporateActionEvent, phase: "past" | "upcoming") => void | Promise<void>, urls: string[] = []) {
    return new CorporateActionsMonitor({
      getHeldStockSymbols: () => held,
      onEvent,
      nowFn: () => NOW,
      fetchFn: async (url: string) => {
        urls.push(url);
        if (events instanceof Error) throw events;
        return jsonResponse(events);
      },
    });
  }

  test("past vs upcoming split on ex_date vs ET today — past event (ex_date ≤ today) and future event get distinct phases", async () => {
    const seen: Array<{ symbol: string; phase: string }> = [];
    const m = monitor({
      corporate_actions: {
        reverse_splits: [{ symbol: "OLD", old_rate: 10, new_rate: 1, ex_date: "2026-08-01" }],   // already happened
        forward_splits: [{ symbol: "SOON", old_rate: 1, new_rate: 4, ex_date: "2026-08-06" }],   // ahead
      },
    }, ["OLD", "SOON"], (ev, phase) => { seen.push({ symbol: ev.symbol, phase }); });

    await m.runOnce();

    expect(seen).toHaveLength(2);
    expect(seen.sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
      { symbol: "OLD", phase: "past" },
      { symbol: "SOON", phase: "upcoming" },
    ]);
  });

  test("no held symbols → no fetch at all", async () => {
    const urls: string[] = [];
    const m = monitor({}, [], () => { throw new Error("no events expected"); }, urls);
    await m.runOnce();
    expect(urls).toHaveLength(0);
  });

  test("FAIL-OPEN: fetch failure → no callbacks, no throw; one failing handler doesn't starve the next event", async () => {
    const dead = monitor(new Error("endpoint down"), ["AAPL"], () => { throw new Error("must not be called"); });
    await dead.runOnce(); // must not throw

    const seen: string[] = [];
    const flaky = monitor({
      corporate_actions: {
        reverse_splits: [
          { symbol: "A", old_rate: 2, new_rate: 1, ex_date: "2026-08-01" },
          { symbol: "B", old_rate: 2, new_rate: 1, ex_date: "2026-08-01" },
        ],
      },
    }, ["A", "B"], (ev) => {
      seen.push(ev.symbol);
      if (ev.symbol === "A") throw new Error("handler boom");
    });
    await flaky.runOnce(); // must not throw
    expect(seen).toEqual(["A", "B"]);
  });
});
