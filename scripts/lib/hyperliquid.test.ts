import { describe, expect, test } from "bun:test";
import { HyperliquidClient, collectHistory, openHyperliquid, storeLeaderboard, type Fill, type Leader } from "./hyperliquid";
import { DEFAULT_SELECTION, FORWARD_TEST, addressPaths, descriptiveStats, forwardTestLeaders, openSignals, realizedPath, selectTraders, takeSnapshot, writeSignals } from "./hyperliquidResearch";

describe("forward-test selection (pre-registered §11.2): only what the leaderboard publishes at the snapshot", () => {
  const row = (address: string, value: number, pnl: number, vlm: number) => ({
    ethAddress: address, accountValue: String(value), windowPerformances: [["month", { pnl: String(pnl), roi: "0", vlm: String(vlm) }]] as [string, { pnl: string; roi: string; vlm: string }][],
  });
  test("drops small accounts and market makers, ranks by 30-day PnL, keeps the top 20", () => {
    const rows = [
      row("0xsmall", 100_000, 9e6, 1e6),        // below 250k
      row("0xmaker", 1_000_000, 8e6, 5e7),      // 50× volume: market maker
      row("0xb", 300_000, 2e5, 1e6),
      row("0xa", 2_000_000, 5e5, 1e7),
      row("0xnomonth", 5_000_000, 0, 0),
    ];
    rows[4].windowPerformances = [];
    expect(forwardTestLeaders(rows).map(r => r.ethAddress)).toEqual(["0xa", "0xb"]);
    const many = Array.from({ length: 30 }, (_, i) => row(`0x${String(i).padStart(2, "0")}`, 1e6, i, 1e6));
    expect(forwardTestLeaders(many)).toHaveLength(FORWARD_TEST.top);
    expect(forwardTestLeaders(many)[0].ethAddress).toBe("0x29");
  });
});

const A = `0x${"1".repeat(40)}`, B = `0x${"2".repeat(40)}`, C = `0x${"3".repeat(40)}`;
const DAY = 86400000;
const leader = (address = A): Leader => ({ ethAddress: address, accountValue: "1000", windowPerformances: [["month", { pnl: "100", roi: "0.1", vlm: "5000" }]] });
const fill = (time: number, tid: number, pnl = "10", fee = "1"): Fill => ({ time, tid, closedPnl: pnl, fee, feeToken: "USDC", coin: "BTC", hash: "h", oid: tid, px: "10", sz: "1", side: "B", startPosition: "0" });
const mockFetch = (fn: (url: string, body: Record<string, unknown>) => Response | Promise<Response>) =>
  ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fn(String(input), JSON.parse(String(init?.body ?? "{}"))))) as typeof fetch;

describe("Hyperliquid public client", () => {
  test("uses correct public endpoints, caches original observation, never signs", async () => {
    const db = openHyperliquid(":memory:");
    const requests: Record<string, unknown>[] = [];
    let now = 100;
    const client = new HyperliquidClient(db, mockFetch((url, body) => {
      expect(url).toBe(body.type ? "https://api.hyperliquid.xyz/info" : "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
      requests.push(body); return Response.json(body.type === "meta" ? { universe: [] } : []);
    }), () => now);
    try {
      await client.meta(); now = 200;
      expect((await client.meta()).observedMs).toBe(100);
      await client.leaderboard(); await client.clearinghouseState(A);
      await client.userFills(A); await client.userFillsByTime(A, 0, 100); await client.portfolio(A);
      expect(requests.map(r => r.type ?? "leaderboard")).toEqual(["meta", "leaderboard", "clearinghouseState", "userFills", "userFillsByTime", "portfolio"]);
      expect(requests[4]).toEqual({ type: "userFillsByTime", user: A, startTime: 0, endTime: 100, aggregateByTime: false });
      expect(db.query("SELECT sum(weight) n FROM hl_rate").get()).toEqual({ n: 304 });
    } finally { db.close(); }
  });

  test("429 Retry-After, 5xx backoff, rolling worst-case weight reservation", async () => {
    const db = openHyperliquid(":memory:");
    let now = 100, calls = 0;
    const waits: number[] = [];
    const client = new HyperliquidClient(db, mockFetch(() => {
      calls++;
      return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "3" } }) : calls === 2 ? new Response("", { status: 503 }) : Response.json([]);
    }), () => now, async ms => { waits.push(ms); now += ms; });
    try {
      await client.userFillsByTime(A, 0, 1);
      expect(waits).toEqual([3000, 2000]);
      for (let i = 0; i < 10; i++) await client.userFillsByTime(A, i, i + 1);
      expect(waits.some(w => w > 50000)).toBe(true);
      expect((db.query("SELECT sum(weight) n FROM hl_rate").get() as { n: number }).n).toBeLessThanOrEqual(1000);
    } finally { db.close(); }
  });

  test("does not retry permanent HTTP errors", async () => {
    const db = openHyperliquid(":memory:");
    try { await expect(new HyperliquidClient(db, mockFetch(() => new Response("bad", { status: 400 }))).meta()).rejects.toThrow("HTTP 400"); }
    finally { db.close(); }
  });
});

describe("collection and point in time", () => {
  test("inclusive pagination, same timestamp deduplication, resumable collection", async () => {
    const db = openHyperliquid(":memory:");
    storeLeaderboard(db, [leader()], 1);
    const starts: number[] = [];
    const client = new HyperliquidClient(db, mockFetch((_url, body) => {
      starts.push(Number(body.startTime));
      const page = body.startTime === 0 ? [fill(2, 1), fill(3, 2), fill(3, 3)] : body.startTime === 3 ? [fill(3, 2), fill(3, 3)] : [];
      return Response.json(page);
    }), () => 100);
    try {
      expect(await collectHistory(client, A)).toBe(3);
      expect(starts).toEqual([0, 3, 4]);
      await collectHistory(client, A);
      expect(starts.at(-1)).toBe(99);
      expect(db.query("SELECT count(*) n FROM hl_fills").get()).toEqual({ n: 3 });
      await expect(collectHistory(client, B)).rejects.toThrow("outside stored");
    } finally { db.close(); }
  });

  test("fails explicitly on unpageable full millisecond and persists error", async () => {
    const db = openHyperliquid(":memory:");
    storeLeaderboard(db, [leader()], 1);
    const client = new HyperliquidClient(db, mockFetch(() => Response.json(Array.from({ length: 2000 }, (_, i) => fill(2, i)))), () => 100);
    try {
      await expect(collectHistory(client, A)).rejects.toThrow("Unpageable");
      expect((db.query("SELECT error FROM hl_history").get() as { error: string }).error).toContain("incomplete");
    } finally { db.close(); }
  });

  test("strict selector excludes future fills, future observations, future candidates and future balances", async () => {
    const db = openHyperliquid(":memory:");
    const t = 40 * DAY;
    storeLeaderboard(db, [leader(A), leader(B)], DAY);
    storeLeaderboard(db, [leader(C)], t + 1);
    const put = (address: string, time: number, known: number, pnl: number, token = "USDC") => db.run("INSERT INTO hl_fills VALUES (?,?,?,?,?,?,?,?,?)", [address, `${time}:${known}`, time, known, "BTC", pnl, 1, token, "{}"]);
    put(A, t - 100, t - 10, 100); put(A, t, t - 10, 10000); put(A, t - 90, t, 10000); put(A, t - 80, t - 10, 10000, "HYPE");
    put(B, t - 100, t - 10, -10); put(C, t - 100, t - 10, 10000);
    try {
      const cfg = { ...DEFAULT_SELECTION, minFills: 1 };
      const selected = selectTraders(db, t, cfg);
      expect(selected).toHaveLength(1); expect(selected[0]!.address).toBe(A);
      expect(selected[0]!.pnl).toBe(99); expect(selected[0]!.score).toBe(0.099);
      expect(selectTraders(db, DAY * 2, cfg)).toEqual([]); // no trailing-start balance
      expect(selectTraders(db, t, { ...cfg, retrospective: true })[0]!.pnl).toBe(10098);
    } finally { db.close(); }
  });

  test("realized curve accounts for fees/rebates and clearly labels hypothetical equity", () => {
    expect(realizedPath([{ time_ms: 2, closed_pnl: -20, fee: 1 }, { time_ms: 1, closed_pnl: 10, fee: -1 }], 100)).toEqual([
      { time: 1, realizedPnl: 11, equityProxy: 111 }, { time: 2, realizedPnl: -10, equityProxy: 90 },
    ]);
  });

  test("equity observations remain distinct from fills and respect retrieval time", () => {
    const db = openHyperliquid(":memory:");
    storeLeaderboard(db, [leader()], 1);
    const portfolio = [["perpAllTime", { accountValueHistory: [[2, "1200"], [200, "900"]], pnlHistory: [] }]];
    db.run("INSERT INTO hl_portfolios VALUES (?,?,?)", [A, 100, JSON.stringify(portfolio)]);
    try {
      expect(addressPaths(db, A, 50).portfolioEquity).toEqual([]);
      expect(addressPaths(db, A, 50).observedEquity).toEqual([{ time: 1, accountValue: 1000 }]);
      expect(addressPaths(db, A, 50, true).portfolioEquity).toEqual([{ time: 2, accountValue: 1200, observedMs: 100 }]);
    } finally { db.close(); }
  });

  test("drawdown and activity filters are applied to trailing realized proxy", () => {
    const db = openHyperliquid(":memory:");
    storeLeaderboard(db, [leader()], 1);
    const t = 40 * DAY;
    for (const [i, pnl] of [500, -1000, 900].entries()) db.run("INSERT INTO hl_fills VALUES (?,?,?,?,?,?,?,?,?)", [A, String(i), t - 100 + i, t - 1, "BTC", pnl, 0, "USDC", "{}"]);
    try {
      expect(selectTraders(db, t, { ...DEFAULT_SELECTION, minFills: 1 })).toEqual([]);
      expect(selectTraders(db, t, { ...DEFAULT_SELECTION, minFills: 1, maxDrawdownPct: 80 })).toHaveLength(1);
      expect(selectTraders(db, t, { ...DEFAULT_SELECTION, minFills: 4, maxDrawdownPct: 80 })).toEqual([]);
    } finally { db.close(); }
  });
});

describe("forward signals and descriptive stats", () => {
  test("signed performance-weighted notional, all coins including zeros, source-local idempotency", () => {
    const db = openHyperliquid(":memory:"), signals = openSignals(":memory:");
    signals.run("INSERT INTO signal_events VALUES ('sec','BTC/USD',11,1,'{}')");
    const selected = [A, B].map((address, i) => ({ address, score: i + 1, pnl: 10, accountValue: 100, drawdownPct: 0, fills: 10 }));
    for (const [i, address] of [A, B].entries()) db.run("INSERT INTO hl_states VALUES (?,?,?,?)", [10, address, 11, JSON.stringify({ assetPositions: [{ position: { coin: "BTC", szi: i ? "-1" : "1", positionValue: "300" } }] })]);
    try {
      expect(() => writeSignals(db, signals, 10, selected, DEFAULT_SELECTION, 10)).toThrow("not yet observed");
      writeSignals(db, signals, 10, selected, DEFAULT_SELECTION, 12);
      writeSignals(db, signals, 10, selected, DEFAULT_SELECTION, 13);
      expect(signals.query("SELECT count(*) n FROM signal_events").get()).toEqual({ n: 14 });
      expect(signals.query("SELECT weight,known_at_ms FROM signal_events WHERE source='hyperliquid-top' AND symbol='BTC/USD'").get()).toEqual({ weight: -100, known_at_ms: 12 });
      expect(signals.query("SELECT weight FROM signal_events WHERE symbol='ETH/USD'").get()).toEqual({ weight: 0 });
      const stats = descriptiveStats(db);
      expect(stats.topNChanges.comparisons).toBe(0);
    } finally { db.close(); signals.close(); }
  });

  test("one forward snapshot logs raw top positions but no fabricated warmup selection", async () => {
    const db = openHyperliquid(":memory:"), signals = openSignals(":memory:");
    let now = 100;
    const client = new HyperliquidClient(db, mockFetch((_url, body) => {
      now++;
      return Response.json(body.type ? { time: now, marginSummary: { accountValue: "1000" }, assetPositions: [] } : { leaderboardRows: [leader()] });
    }), () => now);
    try {
      const snap = await takeSnapshot(client, signals);
      expect(snap).toEqual({ snapshotMs: 101, knownMs: 102, leaderboard: 1, positions: 1, selected: 0 });
      expect(signals.query("SELECT count(*) n FROM signal_events WHERE weight=0").get()).toEqual({ n: 13 });
      await takeSnapshot(client, signals);
      expect(descriptiveStats(db).topNChanges).toEqual({ comparisons: 1, changed: 0, changes: [{ entered: 0, exited: 0 }] });
    } finally { db.close(); signals.close(); }
  });
});
