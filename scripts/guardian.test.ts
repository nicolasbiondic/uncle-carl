import { describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac } from "node:crypto";
import {
  evaluateGuardian, episodeTransitions, guardianExitCode, guardianMain, stockPassTime, writeState, positionOffTarget,
  type GuardianResult, type EpisodeState, type StockConfigs, type BrokerPosition,
} from "./guardian";

const HOUR = 3_600_000, NOW = Date.parse("2026-11-02T16:00:00Z");
const root = resolve(import.meta.dir, "..");
const emptyState = (): EpisodeState => ({ version: 1, active: {} });
const configs: StockConfigs = {
  momentum_stocks: { kind: "volManaged", universe: ["SPY"], maxHoldSessions: 5,
    regimeOverlay: { signals: [{ kind: "maTrend", symbol: "SPY", period: 200, sampling: "daily", bandPct: 1 }],
      combine: "any", coreScale: 0, hedge: { symbol: "SH", fraction: 0.5 } } } as any,
  meanrev_stocks: { kind: "volManaged", universe: ["ABBV"], maxHoldSessions: 5 } as any,
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "guardian-"));
  // No dependency on research artifacts or the developer checkout's data.
  const artifactEnv = ["MOMENTUM_STOCKS", "MEANREV_STOCKS", "MOMENTUM_CRYPTO", "MOMENTUM_CRYPTO_USDC"].map(id => `SCORECARD_ARTIFACT_${id}`);
  const savedEnv = artifactEnv.map(k => process.env[k]);
  for (const key of artifactEnv) {
    const artifact = join(dir, key);
    mkdirSync(artifact);
    writeFileSync(join(artifact, "runs.jsonl"), "{}\n");
    writeFileSync(join(artifact, "summary.json"), JSON.stringify({ stitchedOos: { maxDrawdown: 0.2 } }));
    process.env[key] = artifact;
  }
  const path = join(dir, "trading.db"), histPath = join(dir, "historical.db");
  const db = new Database(path), hist = new Database(histPath);
  db.exec(`CREATE TABLE trades (id TEXT, account_id TEXT, symbol TEXT, side TEXT, quantity REAL, entry_time INTEGER,
    exit_time INTEGER, strategy TEXT, status TEXT, close_reason TEXT);
    CREATE TABLE portfolio_decisions (id INTEGER PRIMARY KEY, account_id TEXT, strategy_version TEXT, session TEXT,
      status TEXT, mode TEXT, orders_json TEXT, decided_at INTEGER, updated_at INTEGER,
      book_json TEXT DEFAULT '[]', weights_json TEXT DEFAULT '{}');
    CREATE TABLE decision_passes (account_id TEXT, ts INTEGER);
    CREATE TABLE platform_portfolios (id TEXT, template TEXT, enabled INTEGER, mode TEXT, status TEXT, params_json TEXT);
    CREATE TABLE fills (account_id TEXT, trade_id TEXT, order_id TEXT, symbol TEXT, side TEXT, fill_time INTEGER, filled_qty REAL);
    CREATE TABLE activity_log (event_type TEXT, message TEXT, created_at INTEGER);
    CREATE TABLE equity_snapshots (id INTEGER PRIMARY KEY, profile_id TEXT, equity REAL, snapshot_time INTEGER, semantics INTEGER, synthetic INTEGER);`);
  hist.exec(`CREATE TABLE historical_bars (symbol TEXT, source TEXT, timeframe TEXT, timestamp INTEGER,
    open REAL, high REAL, low REAL, close REAL, volume REAL);`);
  function decision(sleeve = "momentum_stocks", session = "2026-11-02", orders: any[] = [], version = "fixture", at = NOW - HOUR) {
    db.query("INSERT INTO portfolio_decisions (account_id,strategy_version,session,status,mode,orders_json,decided_at,updated_at) VALUES (?,?,?,'submitted','live',?,?,?)")
      .run(sleeve, version, session, JSON.stringify(orders), at, at);
  }
  for (const sleeve of ["momentum_crypto", "momentum_crypto_usdc"]) {
    db.query("INSERT INTO decision_passes VALUES (?,?)").run(sleeve, NOW - HOUR);
    db.query("INSERT INTO platform_portfolios VALUES (?,'momentum',1,'live','active',?)")
      .run(sleeve, JSON.stringify({ timeStop: { maxHoldHours: 120 }, breakoutShort: { maxHoldHours: 120 } }));
  }
  for (const [sleeve, strategy] of Object.entries(configs)) {
    decision(sleeve);
    db.query("INSERT INTO platform_portfolios VALUES (?,'portfolio',1,'live','active',?)")
      .run(`pe_${sleeve}`, JSON.stringify({ sleeve, runMode: "live", strategy, rebalanceBand: 0.01 }));
  }
  for (const symbol of ["SPY", "SH", "ABBV"]) hist.query("INSERT INTO historical_bars VALUES (?,'alpaca_wide','1d',?,100,101,99,100,1000)")
    .run(symbol, Date.parse("2026-10-30T04:00:00Z"));
  function trade(overrides: Record<string, any> = {}) {
    const r = { id: "row", account_id: "momentum_crypto_usdc", symbol: "NEAR/USDC", side: "buy", quantity: 2,
      entry_time: NOW - HOUR, exit_time: null, strategy: "MOMENTUM", status: "open", close_reason: null, ...overrides };
    db.query("INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?,?)").run(...Object.values(r));
  }
  const run = (overrides: Partial<Parameters<typeof evaluateGuardian>[0]> = {}) => evaluateGuardian({ db, hist, now: NOW, root, noBroker: true, cronMarkerDir: join(dir, "cron-markers"), cronTz: "Etc/GMT+5", ...overrides });
  return { dir, path, histPath, db, hist, trade, decision, run, close() {
    db.close(); hist.close(); rmSync(dir, { recursive: true, force: true });
    artifactEnv.forEach((k, i) => { if (savedEnv[i] === undefined) delete process.env[k]; else process.env[k] = savedEnv[i]; });
  } };
}
const findings = (r: GuardianResult, check: string) => r.violations.filter(f => f.check === check);

describe("G11 — p1 freeze exception, independent of p5", () => {
  test("complete rolling window pages once, missing data retains, equality recovers once; readonly", async () => {
    const f = fixture();
    try {
      const dir = process.env.SCORECARD_ARTIFACT_MOMENTUM_CRYPTO!;
      writeFileSync(join(dir, "manifest-resolved.json"), JSON.stringify({ costs: { base: { slippageBps: 2, commissionBps: 0 } } }));
      writeFileSync(join(dir, "runs.jsonl"), JSON.stringify({ foldPath: "0/test", costTier: "base", result: {
        config: { slippageBps: 2, commissionBps: 0 }, dailyReturns: Array.from({ length: 60 }, (_, i) => ({ date: `2020-${i}`, ret: 0 })) } }));
      for (let i = 0; i <= 20; i++) f.db.query("INSERT INTO equity_snapshots (profile_id,equity,snapshot_time,semantics,synthetic) VALUES ('momentum_crypto',?,?,5,0)")
        .run(100 - i, Date.parse("2026-10-12T21:00:00Z") + i * 24 * HOUR);
      const db = new Database(f.path, { readonly: true });
      try {
        const r = await f.run({ db });
        expect(findings(r, "G11")).toHaveLength(1);
        expect(findings(r, "G11")[0].message).toContain("excepción de la congelación: últimas 20 sesiones bajo el p1");
        const first = episodeTransitions(emptyState(), r, NOW);
        expect(first.events).toHaveLength(1);
        expect(episodeTransitions(first.state, await f.run({ db }), NOW).events).toEqual([]);
        // The scorecard caches good samples, but a removed host artifact still
        // belongs to G8 and cannot change a G11 episode using the old memo.
        rmSync(join(dir, "summary.json"));
        const missing = await f.run({ db });
        expect(findings(missing, "G11")).toEqual([]);
        expect(episodeTransitions(first.state, missing, NOW).events.some(e => e.includes("CLEARED G11"))).toBe(false);
        writeFileSync(join(dir, "summary.json"), JSON.stringify({ stitchedOos: { maxDrawdown: 0.2 } }));
        f.db.exec("DELETE FROM equity_snapshots WHERE id=10");
        expect(episodeTransitions(first.state, await f.run({ db }), NOW).events).toEqual([]);
        f.db.query("INSERT INTO equity_snapshots VALUES (10,'momentum_crypto',100,?,5,0)").run(Date.parse("2026-10-21T21:00:00Z"));
        f.db.exec("UPDATE equity_snapshots SET equity=100");
        const clear = episodeTransitions(first.state, await f.run({ db }), NOW);
        expect(clear.events).toEqual([expect.stringContaining("CLEARED G11:momentum_crypto")]);
        expect(episodeTransitions(clear.state, await f.run({ db }), NOW).events).toEqual([]);
      } finally { db.close(); }
    } finally { f.close(); }
  });
});
function closeOrder(qty = 10, filled = 0, id = "close") {
  return { intent: { symbol: "ABBV", side: "sell", qty, maxHold: "close" }, clientOrderId: id,
    result: { ok: filled === qty, filledQty: filled, status: filled === qty ? "filled" : "canceled" }, applied: true };
}

describe("G9 — two completed sessions, absolute AND relative position drift", () => {
  test.each([
    [0.038, 0.03, false], // E2's 32 names: >25% relative alone must NOT page
    [0.04, 0.03, false], [0.041, 0.03, true],
    [0.12, 0.1, false], [0.125, 0.1, false], [0.126, 0.1, true],
    [0.01, 0, false], [0.011, 0, true],
  ])("actual %s vs target %s => %s", (actual, target, expected) => {
    expect(positionOffTarget(actual as number, target as number, 0.01)).toBe(expected);
  });
  function sessions(f: ReturnType<typeof fixture>, actual = 0.041, target = 0.03) {
    for (const session of ["2026-10-29", "2026-10-30"]) {
      f.decision("meanrev_stocks", session, [], "fixture", Date.parse(`${session}T14:00:00Z`));
      f.db.query("UPDATE portfolio_decisions SET book_json=?, weights_json=? WHERE account_id='meanrev_stocks' AND session=?")
        .run(JSON.stringify([{ symbol: "ABBV", qty: actual * 100 }]), JSON.stringify({ ABBV: target }), session);
      f.db.query("INSERT INTO equity_snapshots (profile_id,equity,snapshot_time,semantics,synthetic) VALUES ('meanrev_stocks',10000,?,5,0)")
        .run(Date.parse(`${session}T21:00:00Z`));
      if (session === "2026-10-29") f.hist.query("INSERT INTO historical_bars VALUES ('ABBV','alpaca_wide','1d',?,100,101,99,100,1000)")
        .run(Date.parse(`${session}T04:00:00Z`));
    }
  }
  test("same symbol on two adjacent sessions pages once, a healthy weight recovers once; current incomplete pass ignored, readonly", async () => {
    const f = fixture();
    try {
      sessions(f);
      const db = new Database(f.path, { readonly: true }), hist = new Database(f.histPath, { readonly: true });
      try {
        const r = await f.run({ db, hist });
        expect(findings(r, "G9").map(f => f.key)).toEqual(["G9:meanrev_stocks:ABBV"]);
        expect(r.reports.join("\n")).toContain("band=0.01");
        const first = episodeTransitions(emptyState(), r, NOW);
        expect(first.events).toHaveLength(1);
        expect(episodeTransitions(first.state, await f.run({ db, hist }), NOW + HOUR).events).toEqual([]);
        f.db.exec(`UPDATE portfolio_decisions SET book_json='[{"symbol":"ABBV","qty":3}]' WHERE session='2026-10-30'`);
        const clear = episodeTransitions(first.state, await f.run({ db, hist }), NOW + HOUR);
        expect(clear.events).toEqual([expect.stringContaining("CLEARED G9:meanrev_stocks:ABBV")]);
        expect(episodeTransitions(clear.state, await f.run({ db, hist }), NOW + HOUR).events).toEqual([]);
      } finally { db.close(); hist.close(); }
    } finally { f.close(); }
  });
  test.each(["skipped_stale", "failed", "decided", "missing", "missing price", "missing mark", "future journal"])("%s never bridges a gap or falsely recovers an episode", async kind => {
    const f = fixture();
    try {
      sessions(f);
      const first = episodeTransitions(emptyState(), await f.run(), NOW);
      if (kind === "missing") f.db.exec("DELETE FROM portfolio_decisions WHERE session='2026-10-30'");
      else if (kind === "missing price") f.hist.query("DELETE FROM historical_bars WHERE symbol='ABBV' AND timestamp >= ?").run(Date.parse("2026-10-30T00:00:00Z"));
      else if (kind === "missing mark") f.db.exec("DELETE FROM equity_snapshots");
      else if (kind === "future journal") f.db.query("UPDATE portfolio_decisions SET updated_at=? WHERE session='2026-10-30'").run(NOW + 1);
      else f.db.query("UPDATE portfolio_decisions SET status=? WHERE session='2026-10-30'").run(kind);
      const r = await f.run();
      expect(findings(r, "G9")).toEqual([]);
      expect(episodeTransitions(first.state, r, NOW).events.filter(e => e.includes("G9:"))).toEqual([]);
    } finally { f.close(); }
  });
  test("uses session close prices and applied partial fills, not entry prices, requested quantities or today's mutable rows", async () => {
    const f = fixture();
    try {
      sessions(f, 0, 0.1);
      const orders = [{ intent: { symbol: "ABBV", side: "buy", qty: 10 }, clientOrderId: "partial",
        applied: true, result: { ok: false, filledQty: 3, status: "canceled" } },
        { intent: { symbol: "ABBV", side: "buy", qty: 7 }, applied: false, result: { filledQty: 7 } }];
      f.db.query("UPDATE portfolio_decisions SET orders_json=? WHERE session IN ('2026-10-29','2026-10-30')").run(JSON.stringify(orders));
      expect(findings(await f.run(), "G9")).toHaveLength(1); // 3% actual, not requested 10%
      f.trade({ account_id: "meanrev_stocks", quantity: 999, symbol: "ABBV" }); // later row, irrelevant
      expect(findings(await f.run(), "G9")).toHaveLength(1);
      f.hist.exec("UPDATE historical_bars SET close=333.333333333 WHERE symbol='ABBV'");
      expect(findings(await f.run(), "G9")).toEqual([]); // 10% when marked at session prices
    } finally { f.close(); }
  });
  test("zero targets count and the definition's band is used rather than a hardcoded 1pp", async () => {
    const f = fixture();
    try {
      sessions(f, 0.02, 0);
      expect(findings(await f.run(), "G9")).toHaveLength(1);
      f.db.query("UPDATE platform_portfolios SET params_json=? WHERE id='pe_meanrev_stocks'")
        .run(JSON.stringify({ sleeve: "meanrev_stocks", runMode: "live", strategy: configs.meanrev_stocks, rebalanceBand: 0.03 }));
      expect(findings(await f.run(), "G9")).toEqual([]);
    } finally { f.close(); }
  });
  test("today counts only after the NYSE close, including early closes; no second session from repeated hourly checks", async () => {
    const f = fixture();
    try {
      sessions(f);
      const beforeClose = await f.run({ now: Date.parse("2026-10-30T19:59:59Z") });
      expect(findings(beforeClose, "G9")).toEqual([]); // the 29th alone is not two sessions
      const afterClose = await f.run({ now: Date.parse("2026-10-30T21:01:00Z") });
      expect(findings(afterClose, "G9")).toHaveLength(1);
      // Half-day Friday after Thanksgiving: no synthetic full-day assumption.
      for (const session of ["2026-11-25", "2026-11-27"]) {
        f.decision("meanrev_stocks", session, [], "fixture", Date.parse(`${session}T15:00:00Z`));
        f.db.query("UPDATE portfolio_decisions SET book_json=?,weights_json=? WHERE session=?")
          .run('[{"symbol":"ABBV","qty":4.1}]', '{"ABBV":0.03}', session);
        f.db.query("INSERT INTO equity_snapshots (profile_id,equity,snapshot_time,semantics,synthetic) VALUES ('meanrev_stocks',10000,?,5,0)")
          .run(Date.parse(`${session}T18:00:00Z`));
        f.hist.query("INSERT INTO historical_bars VALUES ('ABBV','alpaca_wide','1d',?,100,101,99,100,1000)")
          .run(Date.parse(`${session}T05:00:00Z`));
      }
      // 25th is a full day: replace its mark with one after 16:00 ET.
      f.db.query("UPDATE equity_snapshots SET snapshot_time=? WHERE snapshot_time=?")
        .run(Date.parse("2026-11-25T21:00:00Z"), Date.parse("2026-11-25T18:00:00Z"));
      expect(findings(await f.run({ now: Date.parse("2026-11-27T17:59:59Z") }), "G9")).toEqual([]);
      expect(findings(await f.run({ now: Date.parse("2026-11-27T18:00:01Z") }), "G9")).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe("G10 — current-version drawdown vs stitched OOS worst, investigation only", () => {
  test("all four sleeves, strict OOS threshold, once per episode and recovery; prior model peaks excluded", async () => {
    const f = fixture();
    // After every current modelStart (momentum_stocks' RW11 version starts 2026-11-10): a sleeve with no mark
    // inside its current version is "no marks … episode retained", not a finding.
    const now = Date.parse("2026-11-13T17:00:00Z"), run = (db = f.db) => f.run({ db, now });
    try {
      for (const sleeve of ["momentum_stocks", "meanrev_stocks", "momentum_crypto", "momentum_crypto_usdc"]) {
        for (const [time, equity] of [["2026-09-01T21:00:00Z", 1000], ["2026-11-09T21:00:00Z", 100], ["2026-11-12T21:00:00Z", 79]] as const)
          f.db.query("INSERT INTO equity_snapshots (profile_id,equity,snapshot_time,semantics,synthetic) VALUES (?,?,?,5,0)").run(sleeve, equity, Date.parse(time));
        // Last pre-model base is 100, not the retired model's high of 1000.
        f.db.query("INSERT INTO equity_snapshots (profile_id,equity,snapshot_time,semantics,synthetic) VALUES (?,100,?,5,0)")
          .run(sleeve, Date.parse("2026-10-01T21:00:00Z"));
      }
      const r = await run();
      expect(findings(r, "G10")).toHaveLength(4);
      expect(findings(r, "G10")[0].message).toContain("caída peor que la peor del backtest");
      expect(r.reports.join("\n")).toContain("current DD=21.00%, OOS worst=20.00%");
      // The fall from the retired model's 1000 peak is reported, never paged.
      expect(r.reports.join("\n")).toContain("sleeve DD from its peak since 2026-07-10=92.10% (reported only)");
      const first = episodeTransitions(emptyState(), r, NOW);
      expect(episodeTransitions(first.state, await run(), NOW).events).toEqual([]);
      // Missing artifacts are G8 only; they cannot recover a G10 episode.
      const dir = process.env.SCORECARD_ARTIFACT_MEANREV_STOCKS!;
      rmSync(join(dir, "summary.json"));
      const missing = await run();
      expect(findings(missing, "G10")).toHaveLength(3);
      expect(findings(missing, "G8")).toHaveLength(1);
      expect(episodeTransitions(first.state, missing, NOW).events.some(e => e.includes("CLEARED G10"))).toBe(false);
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ stitchedOos: { maxDrawdown: 0.2 } }));
      f.db.exec("UPDATE equity_snapshots SET equity=81 WHERE equity=79");
      const db = new Database(f.path, { readonly: true });
      try {
        const clear = episodeTransitions(first.state, await run(db), NOW);
        expect(clear.events.filter(e => e.includes("CLEARED G10:"))).toHaveLength(4);
        expect(episodeTransitions(clear.state, await run(db), NOW).events).toEqual([]);
      } finally { db.close(); }
    } finally { f.close(); }
  });
});

describe("G8 — current model expectation artifacts", () => {
  test.each(["missing directory", "missing runs.jsonl", "runs.jsonl is a directory", "empty runs.jsonl", "unreadable runs.jsonl", "missing summary.json", "invalid summary.json"])("%s pages once, recovers once after copy (no restart)", async kind => {
    const f = fixture();
    try {
      const dir = process.env.SCORECARD_ARTIFACT_MOMENTUM_STOCKS!, runs = join(dir, "runs.jsonl");
      expect(findings(await f.run(), "G8")).toEqual([]);
      if (kind === "missing directory") rmSync(dir, { recursive: true });
      else if (kind === "missing runs.jsonl") rmSync(runs);
      else if (kind === "runs.jsonl is a directory") { rmSync(runs); mkdirSync(runs); }
      else if (kind === "unreadable runs.jsonl") chmodSync(runs, 0o000);
      else if (kind === "missing summary.json") rmSync(join(dir, "summary.json"));
      else if (kind === "invalid summary.json") writeFileSync(join(dir, "summary.json"), '{"stitchedOos":{"maxDrawdown":-1}}');
      else writeFileSync(runs, "");
      const failed = await f.run();
      expect(failed.evaluated).toContain("G8");
      expect(findings(failed, "G8")).toEqual([{ key: "G8:momentum_stocks", check: "G8", message: expect.stringContaining("momentum_stocks@") }]);
      const first = episodeTransitions(emptyState(), failed, NOW);
      expect(first.events).toEqual([expect.stringContaining("PAGE G8:momentum_stocks")]);
      expect(episodeTransitions(first.state, await f.run(), NOW + HOUR).events).toEqual([]);
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
      writeFileSync(runs, "{}\n");
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ stitchedOos: { maxDrawdown: 0.2 } }));
      const clear = episodeTransitions(first.state, await f.run(), NOW + 2 * HOUR);
      expect(clear.events).toEqual([expect.stringContaining("CLEARED G8:momentum_stocks")]);
      expect(episodeTransitions(clear.state, await f.run(), NOW + 3 * HOUR).events).toEqual([]);
    } finally { f.close(); }
  });
  test("all four live sleeves are checked; historical runs do not judge today's host artifacts", async () => {
    const f = fixture();
    try {
      for (const key of ["MOMENTUM_STOCKS", "MEANREV_STOCKS", "MOMENTUM_CRYPTO", "MOMENTUM_CRYPTO_USDC"])
        rmSync(process.env[`SCORECARD_ARTIFACT_${key}`]!, { recursive: true });
      expect(findings(await f.run(), "G8")).toHaveLength(4);
      const historical = await f.run({ historical: true, configs });
      expect(historical.evaluated).not.toContain("G8");
      expect(historical.reports.join("\n")).toContain("G8 skipped");
    } finally { f.close(); }
  });
});

describe("G7 — cron dead-man's switch (audit F-2)", () => {
  const mark = (dir: string, name: string, ms: number) => {
    Bun.spawnSync(["mkdir", "-p", join(dir, "cron-markers")]);
    writeFileSync(join(dir, "cron-markers", name), `${Math.floor(ms / 1000)}\n`);
  };
  test("not initialised (no .since) ⇒ evaluated, nothing stale", async () => {
    const f = fixture();
    try {
      const r = await f.run();
      expect(r.evaluated).toContain("G7"); expect(findings(r, "G7")).toEqual([]);
    } finally { f.close(); }
  });
  test("an overdue job pages G7:<job>; fresh jobs and the guardian's own marker are not judged here", async () => {
    const f = fixture();
    try {
      // NOW = 2026-11-02 11:00 host time (UTC−5, Mon). Tracking since a week ago; only backup and refresh ran today.
      mark(f.dir, ".since", NOW - 7 * 24 * HOUR);
      mark(f.dir, "backup-db.ok", NOW - 6 * HOUR);           // 05:00 today ✓
      mark(f.dir, "refresh-historical.ok", NOW - 6.5 * HOUR); // 04:30 today ✓
      mark(f.dir, "refresh-stocks.ok", NOW - 6.5 * HOUR);
      mark(f.dir, "parity-check.ok", NOW - 50 * HOUR);        // Sat 09:00 ✓ (Mon is not a parity day)
      mark(f.dir, "ai-quorum-stocks.ok", NOW - 66 * HOUR);   // Fri 17:00 ✓
      mark(f.dir, "ai-quorum-crypto.ok", NOW - 40 * HOUR);   // Sat 19:00: Sunday's run is missing ✗
      mark(f.dir, "restore-drill.ok", NOW - 29 * HOUR);      // Sun 06:00 ✓
      const r = await f.run();
      expect(findings(r, "G7").map(v => v.key)).toEqual(["G7:ai-quorum-crypto"]);
      expect(findings(r, "G7")[0].message).toContain("cron ai-quorum-crypto");
      // and it rides the existing once-per-episode machinery
      const first = episodeTransitions(emptyState(), r, NOW);
      expect(first.events).toEqual([expect.stringContaining("GUARDIAN PAGE G7:ai-quorum-crypto")]);
      expect(episodeTransitions(first.state, r, NOW + HOUR).events).toEqual([]);
    } finally { f.close(); }
  });
  test("historical --now runs skip G7 (markers are not historical)", async () => {
    const f = fixture();
    try {
      mark(f.dir, ".since", NOW - 7 * 24 * HOUR);
      const r = await f.run({ historical: true, configs });
      expect(r.evaluated).not.toContain("G7");
      expect(r.reports.join("\n")).toContain("G7 skipped");
    } finally { f.close(); }
  });
});

describe("guardian runtime rules (readonly synthetic fixtures)", () => {
  test("healthy fixture, readonly handles, G6 uses executed-order accounting and restart events (REPORT only)", async () => {
    const f = fixture();
    try {
      f.trade();
      f.db.query("INSERT INTO activity_log VALUES ('system','Account manager started (fixture)',?)").run(NOW - HOUR);
      f.db.query("INSERT INTO activity_log VALUES ('system','Account manager started (old)',?)").run(NOW - 25 * HOUR);
      const db = new Database(f.path, { readonly: true }), hist = new Database(f.histPath, { readonly: true });
      const before = Buffer.from(readFileSync(f.path));
      try {
        const r = await f.run({ db, hist });
        expect(r.errors).toEqual([]); expect(r.violations).toEqual([]); expect(guardianExitCode(r)).toBe(0);
        expect(r.reports.join("\n")).toContain("executed orders today (ET): 1");
        expect(r.reports.join("\n")).toContain("starts last 24h: 1");
        expect(readFileSync(f.path)).toEqual(before);
        expect(() => db.exec("DELETE FROM trades")).toThrow();
      } finally { db.close(); hist.close(); }
    } finally { f.close(); }
  });
  test.each(["momentum_crypto", "momentum_crypto_usdc"])("G1 %s: TSM AND Turtle clock, strict 120h+1h slack; resizes do not refresh entry", async sleeve => {
    const f = fixture();
    try {
      f.trade({ id: "tsm", account_id: sleeve, entry_time: NOW - 121 * HOUR });
      f.trade({ id: "turtle", account_id: sleeve, strategy: "BREAKOUT_SHORT", side: "sell", entry_time: NOW - 121 * HOUR - 1 });
      expect(findings(await f.run(), "G1").map(r => r.key)).toEqual(["G1:turtle"]);
      f.db.exec("UPDATE trades SET quantity = 1 WHERE id = 'turtle'");
      expect(findings(await f.run(), "G1")).toHaveLength(1);
      f.db.query("UPDATE trades SET exit_time = ?, status = 'closed' WHERE id = 'turtle'").run(NOW);
      expect(findings(await f.run(), "G1")).toEqual([]);
      // At a historical instant a row closed later must still be considered open.
      f.db.query("UPDATE trades SET exit_time = ? WHERE id = 'turtle'").run(NOW + HOUR);
      expect(findings(await f.run(), "G1")).toHaveLength(1);
      f.db.query("UPDATE trades SET entry_time = ? WHERE id = 'turtle'").run(NOW + 1);
      expect(findings(await f.run(), "G1")).toEqual([]);
    } finally { f.close(); }
  });
  test.each(["momentum_stocks", "meanrev_stocks"])("G1 %s: fifth NYSE boundary, grace, weekend, holiday and DST", async sleeve => {
    const f = fixture();
    try {
      // 26, 27, 28, 29, 30 = fifth session; entry on 23 is excluded.
      f.trade({ account_id: sleeve, symbol: "SPY", strategy: "PORTFOLIO", entry_time: Date.parse("2026-10-23T14:00:00Z") });
      const due = stockPassTime("2026-10-30") + 30 * 60_000;
      expect(findings(await f.run({ now: due - 1 }), "G1")).toEqual([]);
      expect(findings(await f.run({ now: due }), "G1")).toHaveLength(1);
      expect(findings(await f.run({ now: Date.parse("2026-10-31T12:00:00Z") }), "G1")).toHaveLength(1);
      f.db.query("UPDATE trades SET entry_time = ?").run(Date.parse("2026-10-26T14:00:00Z"));
      const dstDue = stockPassTime("2026-11-02") + 30 * 60_000;
      expect(findings(await f.run({ now: dstDue - 1 }), "G1")).toEqual([]);
      expect(findings(await f.run({ now: dstDue }), "G1")).toHaveLength(1);
      // Thanksgiving is NOT one of the five session boundaries.
      f.db.query("UPDATE trades SET entry_time = ?").run(Date.parse("2026-11-20T15:00:00Z"));
      expect(findings(await f.run({ now: Date.parse("2026-11-27T18:00:00Z") }), "G1")).toEqual([]);
      expect(findings(await f.run({ now: Date.parse("2026-11-30T16:00:00Z") }), "G1")).toHaveLength(1);
    } finally { f.close(); }
  });
  test("G2 stocks: deadline from engine schedule, duplicate across versions, no observers/failed/future rows", async () => {
    const f = fixture();
    try {
      f.decision("momentum_stocks", "2026-10-30"); f.decision("meanrev_stocks", "2026-10-30");
      f.db.exec("DELETE FROM portfolio_decisions WHERE session = '2026-11-02'");
      const due = stockPassTime("2026-11-02") + 55 * 60_000;
      expect(findings(await f.run({ now: due - 1 }), "G2")).toEqual([]);
      expect(findings(await f.run({ now: due }), "G2")).toHaveLength(2);
      f.decision(); f.decision("meanrev_stocks");
      expect(findings(await f.run(), "G2")).toEqual([]);
      f.decision("momentum_stocks", "2026-11-02", [], "second-version");
      expect(findings(await f.run(), "G2")[0].message).toContain("duplicate pass (2");
      f.db.exec("UPDATE portfolio_decisions SET mode = 'observer' WHERE strategy_version = 'second-version'");
      expect(findings(await f.run(), "G2")).toEqual([]);
      f.db.exec("UPDATE portfolio_decisions SET mode='live', status='failed' WHERE strategy_version = 'second-version'");
      expect(findings(await f.run(), "G2")).toEqual([]);
      f.db.query("UPDATE portfolio_decisions SET status='submitted', decided_at=? WHERE strategy_version='second-version'").run(NOW + 1);
      expect(findings(await f.run(), "G2")).toEqual([]);
      expect(stockPassTime("2026-10-30")).toBe(Date.parse("2026-10-30T13:35:00Z"));
      expect(stockPassTime("2026-11-02")).toBe(Date.parse("2026-11-02T14:35:00Z"));
    } finally { f.close(); }
  });
  test.each([["momentum_crypto", 2], ["momentum_crypto_usdc", 26]] as const)("G2 %s: exact rolling %ih threshold, clear and future timestamps", async (sleeve, hours) => {
    const f = fixture();
    try {
      f.db.query("UPDATE decision_passes SET ts=? WHERE account_id=?").run(NOW - hours * HOUR, sleeve);
      expect(findings(await f.run(), "G2")).toEqual([]);
      f.db.query("UPDATE decision_passes SET ts=ts-1 WHERE account_id=?").run(sleeve);
      expect(findings(await f.run(), "G2")[0].key).toBe(`G2:${sleeve}:missed`);
      f.db.query("UPDATE decision_passes SET ts=? WHERE account_id=?").run(NOW + 1, sleeve);
      expect(findings(await f.run(), "G2")).toHaveLength(1);
      f.db.query("UPDATE decision_passes SET ts=? WHERE account_id=?").run(NOW, sleeve);
      expect(findings(await f.run(), "G2")).toEqual([]);
    } finally { f.close(); }
  });
  test("G3 signed per-venue symbol aggregation, treasury-only exclusion, tolerance, missing/extra positions", async () => {
    const f = fixture();
    try {
      f.trade({ id: "a", account_id: "momentum_stocks", symbol: "SPY", quantity: 2 });
      f.trade({ id: "b", account_id: "meanrev_stocks", symbol: "SPY", quantity: 3 });
      f.trade({ id: "c", account_id: "momentum_crypto", symbol: "BTC/USD", side: "sell", quantity: 0.02 });
      f.trade({ id: "d", account_id: "momentum_crypto_usdc", symbol: "BTC/USDC", quantity: 0.01 });
      const positions: BrokerPosition[] = [{ venue: "alpaca", symbol: "SPY", quantity: 5 + 1e-7 },
        { venue: "alpaca", symbol: "BOXX", quantity: 999 }, { venue: "fapi", symbol: "BTCUSDT", quantity: -0.02 },
        { venue: "fapi", symbol: "BTCUSDC", quantity: 0.01 }];
      const run = () => f.run({ noBroker: false, broker: async () => positions });
      expect(findings(await run(), "G3")).toEqual([]);
      positions[0].quantity = 5.01;
      expect(findings(await run(), "G3")[0].key).toBe("G3:alpaca:SPY");
      positions[0].quantity = 5;
      positions.pop();
      expect(findings(await run(), "G3")[0].key).toBe("G3:fapi:BTCUSDC");
      positions.push({ venue: "fapi", symbol: "BTCUSDC", quantity: 0.01 }, { venue: "fapi", symbol: "ETHUSDT", quantity: 1 });
      expect(findings(await run(), "G3")[0].message).toContain("ledger=0 broker=1");
    } finally { f.close(); }
  });
  test("G3 failed GET/malformed response is operational, never fake quantity drift; --no-broker/--now never call GET", async () => {
    const f = fixture();
    try {
      let calls = 0;
      const broker = async () => { calls++; throw new Error("HTTP 503"); };
      const r = await f.run({ noBroker: false, broker });
      expect(findings(r, "G3")).toEqual([]); expect(r.errors).toEqual([{ check: "G3", message: "HTTP 503" }]);
      expect(guardianExitCode(r)).toBe(2); expect(r.evaluated).not.toContain("G3");
      await f.run({ broker });
      await f.run({ historical: true, noBroker: false, broker, configs });
      expect(calls).toBe(1);
      const bad = await f.run({ noBroker: false, broker: async () => [{ venue: "alpaca", symbol: "SPY", quantity: NaN }] });
      expect(findings(bad, "G3")).toEqual([]); expect(guardianExitCode(bad)).toBe(2);
    } finally { f.close(); }
  });
  test("G4 mandatory partial/zero closes and skipped rebuys PAGE; resizes REPORT; -r1 total fill clears", async () => {
    const f = fixture();
    try {
      const orders: any[] = [closeOrder(10, 2), closeOrder(8, 7, "close-r1"),
        { intent: { symbol: "ABBV", qty: 10, maxHold: "rebuy" }, result: null, skipped: "max_hold_close_incomplete" },
        { intent: { symbol: "MSFT", qty: 10, side: "sell" }, result: { ok: false, filledQty: 1, status: "canceled" } }];
      f.db.query("UPDATE portfolio_decisions SET orders_json=? WHERE account_id='meanrev_stocks'").run(JSON.stringify(orders));
      const r = await f.run();
      expect(findings(r, "G4")).toHaveLength(1); expect(findings(r, "G4")[0].message).toContain("9/10");
      expect(findings(r, "G4")[0].message).toContain("rebuy skipped");
      expect(r.reports.join("\n")).toContain("resize MSFT: 1/10 canceled");
      orders[1] = closeOrder(8, 8, "close-r1"); orders.splice(2, 1);
      f.db.query("UPDATE portfolio_decisions SET orders_json=? WHERE account_id='meanrev_stocks'").run(JSON.stringify(orders));
      expect(findings(await f.run(), "G4")).toEqual([]);
      f.db.query("UPDATE portfolio_decisions SET orders_json=? WHERE account_id='meanrev_stocks'").run(JSON.stringify([closeOrder()]));
      expect(findings(await f.run(), "G4")).toHaveLength(1);
      // An older failed mandatory close is superseded by the latest live decision.
      f.decision("meanrev_stocks", "2026-11-02", [], "new", NOW - 100);
      expect(findings(await f.run(), "G4")).toEqual([]);
    } finally { f.close(); }
  });
  test("G4 historical mutable journal updated in the future is unavailable, not a false violation/clear", async () => {
    const f = fixture();
    try {
      f.db.query("UPDATE portfolio_decisions SET orders_json=?, updated_at=? WHERE account_id='meanrev_stocks'").run(JSON.stringify([closeOrder()]), NOW + 1);
      const r = await f.run();
      expect(findings(r, "G4")).toEqual([]); expect(guardianExitCode(r)).toBe(2);
      expect(r.errors[0].message).toContain("updated after --now");
    } finally { f.close(); }
  });
  test("G5 required universe AND regime hedge SH, previous NYSE session, pre-pass UTC gate, recovery", async () => {
    const f = fixture();
    try {
      f.hist.exec("DELETE FROM historical_bars WHERE symbol='SH'");
      expect(findings(await f.run(), "G5")[0].message).toContain("SH: missing daily bar for 2026-10-30");
      const early = await f.run({ now: Date.parse("2026-11-02T12:59:59Z") });
      expect(early.evaluated).not.toContain("G5"); expect(findings(early, "G5")).toEqual([]);
      expect(findings(await f.run({ now: Date.parse("2026-11-02T13:00:00Z") }), "G5")).toHaveLength(1);
      f.hist.exec("INSERT INTO historical_bars SELECT 'SH', source,timeframe,timestamp,open,high,low,close,volume FROM historical_bars WHERE symbol='SPY'");
      expect(findings(await f.run(), "G5")).toEqual([]);
      f.hist.exec("DELETE FROM historical_bars");
      expect(findings(await f.run({ now: Date.parse("2026-11-26T16:00:00Z") }), "G5")).toEqual([]);
    } finally { f.close(); }
  });
  test.each(["G1", "G2", "G3", "G4", "G5"] as const)("%s episodes notify once, clear once, recur; operational/skipped checks never falsely recover", check => {
    const violation: GuardianResult = { violations: [{ key: `${check}:fixture`, check, message: "violation" }], errors: [], reports: [], evaluated: [check] };
    const first = episodeTransitions(emptyState(), violation, NOW);
    expect(first.events).toHaveLength(1); expect(first.events[0]).toContain("PAGE");
    expect(episodeTransitions(first.state, violation, NOW + HOUR).events).toEqual([]);
    const skipped = episodeTransitions(first.state, { ...violation, violations: [], evaluated: [] }, NOW + HOUR);
    expect(skipped.events).toEqual([]); expect(skipped.state).toEqual(first.state);
    const broken = { ...violation, violations: [], evaluated: [], errors: [{ check, message: "unavailable" }] };
    const failed = episodeTransitions(first.state, broken, NOW + HOUR);
    expect(failed.events).toHaveLength(1); expect(failed.events[0]).toContain("ERROR");
    expect(failed.state.active[`${check}:fixture`]).toBeDefined();
    expect(episodeTransitions(failed.state, broken, NOW + 2 * HOUR).events).toEqual([]);
    const healthy = { ...violation, violations: [] };
    const clear = episodeTransitions(failed.state, healthy, NOW + 3 * HOUR);
    expect(clear.events).toHaveLength(2); expect(clear.events.every(e => e.includes("CLEARED"))).toBe(true);
    expect(clear.state.active).toEqual({}); expect(episodeTransitions(clear.state, healthy, NOW).events).toEqual([]);
    expect(episodeTransitions(clear.state, violation, NOW).events).toHaveLength(1);
    expect(guardianExitCode(broken)).toBe(2); expect(guardianExitCode(violation)).toBe(1);
  });
  test("atomic episode state, no-notify and historical mode never write state; invalid CLI fails", async () => {
    const f = fixture();
    const clock = spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const state = join(f.dir, "state.json");
      writeState(state, emptyState()); expect(JSON.parse(readFileSync(state, "utf8"))).toEqual(emptyState());
      writeFileSync(state, "leave untouched");
      expect(await guardianMain(["--db", f.path, "--hist", f.histPath, "--no-broker", "--state", state, "--no-notify"])).toBe(0);
      expect(readFileSync(state, "utf8")).toBe("leave untouched");
      f.db.exec("UPDATE portfolio_decisions SET strategy_version = CASE account_id WHEN 'momentum_stocks' THEN 'momentum_stocks@pe-vt30-g250-sma200-fv5-mh5-stagger-sh50' ELSE 'meanrev_stocks@pe-vt15-mh5-stagger' END");
      // Outside G5's window so the tiny fixture need not carry the real universes.
      expect(await guardianMain(["--db", f.path, "--hist", f.histPath, "--state", state, "--now", "2026-11-02T12:00:00Z", "--notify"])).toBe(1); // previous session's pass missing
      expect(readFileSync(state, "utf8")).toBe("leave untouched");
      expect(existsSync(`${state}.${process.pid}.tmp`)).toBe(false);
      await expect(guardianMain(["--now", "nonsense"])).rejects.toThrow("invalid --now");
      await expect(guardianMain(["--db"])).rejects.toThrow("missing value");
      await expect(guardianMain(["--unknown"])).rejects.toThrow("unknown option");
      const source = readFileSync(join(root, "scripts/guardian.ts"), "utf8");
      expect(source).not.toContain("initDatabase(");
      expect(source).toContain('new Database(dbPath, { readonly: true })');
      expect(source).toContain('new Database(histPath, { readonly: true })');
    } finally { clock.mockRestore(); f.close(); }
  });
  test("--notify sends and persists once per episode/recovery; failed delivery never consumes a page", async () => {
    const f = fixture(), clock = spyOn(Date, "now").mockReturnValue(NOW);
    const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_OPS_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = "fixture"; process.env.TELEGRAM_OPS_CHAT_ID = "fixture-ops";
    const sent: string[] = [];
    let fail = true;
    const send = spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(String(url)).toBe("https://api.telegram.org/botfixture/sendMessage");
      const body = JSON.parse(String(options?.body)); expect(body.chat_id).toBe("fixture-ops");
      if (fail) return new Response("failure", { status: 503 });
      sent.push(body.text); return Response.json({ ok: true });
    });
    try {
      const state = join(f.dir, "episodes.json"), args = ["--db", f.path, "--hist", f.histPath, "--no-broker", "--notify", "--state", state];
      f.trade({ entry_time: NOW - 122 * HOUR });
      await expect(guardianMain(args)).rejects.toThrow("Telegram failed");
      expect(existsSync(state)).toBe(false);
      fail = false;
      expect(await guardianMain(args)).toBe(1);
      expect(await guardianMain(args)).toBe(1);
      expect(sent).toHaveLength(1); expect(sent[0]).toContain("PAGE G1:row");
      f.db.query("UPDATE trades SET status='closed', exit_time=?").run(NOW);
      expect(await guardianMain(args)).toBe(0); expect(await guardianMain(args)).toBe(0);
      expect(sent).toHaveLength(2); expect(sent[1]).toContain("CLEARED G1:row");
      expect(JSON.parse(readFileSync(state, "utf8")).active).toEqual({});
    } finally {
      clock.mockRestore(); send.mockRestore(); f.close();
      if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = token;
      if (chat === undefined) delete process.env.TELEGRAM_OPS_CHAT_ID; else process.env.TELEGRAM_OPS_CHAT_ID = chat;
    }
  });
});

test("broker-truth import stays inert; shared readers are signed GET-only and CLI rendering is unchanged", () => {
  const script = `
    process.env.ALPACA_API_KEY='fixture'; process.env.ALPACA_SECRET_KEY='fixture';
    process.env.BINANCE_FUTURES_API_KEY='fixture'; process.env.BINANCE_FUTURES_SECRET_KEY='fixture';
    const calls=[]; globalThis.fetch=async (url,opts)=>{calls.push({url,method:opts.method,headers:opts.headers});
      return {ok:true,json:async()=>url.includes('/v2/positions')?[{symbol:'SPY',side:'short',qty:'2'}]:
        [{symbol:'BTCUSDT',positionSide:'SHORT',positionAmt:'0.01'},{symbol:'ETHUSDC',positionSide:'BOTH',positionAmt:'-0.2'}]};};
    const {readBrokerPositions}=await import(${JSON.stringify(join(root, "scripts/guardian.ts"))});
    if(calls.length) throw Error('import made GET calls');
    const positions=await readBrokerPositions();console.log(JSON.stringify({calls,positions}));`;
  // cwd without a .env: a checkout's real keys (dev, prod gate) must not replace the fixture ones.
  const p = Bun.spawnSync([process.execPath, "-e", script], { cwd: mkdtempSync(join(tmpdir(), "guardian-noenv-")), timeout: 10_000 });
  expect(p.exitCode).toBe(0);
  const { calls, positions } = JSON.parse(p.stdout.toString().trim());
  expect(calls).toHaveLength(2); expect(calls.every((c: any) => c.method === "GET")).toBe(true);
  const url = new URL(calls[1].url), sig = url.searchParams.get("signature");
  url.searchParams.delete("signature");
  expect(sig).toBe(createHmac("sha256", "fixture").update(url.searchParams.toString()).digest("hex"));
  expect(positions).toEqual([{ venue: "alpaca", symbol: "SPY", quantity: -2 },
    { venue: "fapi", symbol: "BTCUSDT", quantity: -0.01 }, { venue: "fapi", symbol: "ETHUSDC", quantity: -0.2 }]);
  const after = readFileSync(join(root, "scripts/broker-truth.ts"), "utf8");
  expect(after.indexOf("if (import.meta.main)")).toBeLessThan(after.indexOf("console.log("));
  expect(after.split("\n").filter(l => l.includes("console.log("))).toHaveLength(13);
});

test("cron installs guardian hourly at :20 exactly once; wrapper resolves bun and propagates status/overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guardian-cron-"));
  try {
    const cron = join(dir, "crontab"), store = join(dir, "installed"), bun = join(dir, "bun-fake"), args = join(dir, "args");
    writeFileSync(cron, `#!/bin/bash\nif [ "$1" = '-l' ]; then cat '${store}' 2>/dev/null; else cat > '${store}'; fi\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    for (let i = 0; i < 2; i++) {
      const p = Bun.spawnSync(["bash", "scripts/install-cron.sh"], { cwd: root, env: { ...env, CRON_MARKER_DIR: join(dir, "markers") } });
      expect(p.exitCode).toBe(0);
    }
    const lines = readFileSync(store, "utf8").split("\n");
    expect(lines.filter(l => l === "# uncle-carl-guardian")).toHaveLength(1);
    expect(lines.filter(l => l.includes("/scripts/guardian.sh"))).toEqual([`20 * * * * ${root}/scripts/guardian.sh >> ${root}/logs/guardian.log 2>&1`]);
    // Use a fixture repo, not the real data/ directory or crontab.
    const scriptDir = join(dir, "scripts");
    Bun.spawnSync(["mkdir", "-p", join(scriptDir, "lib"), join(dir, "data")]);
    writeFileSync(join(scriptDir, "guardian.sh"), readFileSync(join(root, "scripts/guardian.sh")), { mode: 0o755 });
    writeFileSync(join(scriptDir, "lib", "cron-job.sh"), readFileSync(join(root, "scripts/lib/cron-job.sh")));
    writeFileSync(bun, `#!/bin/bash\nprintf '%s\\n' "$@" > '${args}'\nexit 1\n`, { mode: 0o755 });
    const p = Bun.spawnSync(["bash", join(scriptDir, "guardian.sh"), "--no-notify", "--no-broker"], { env: { ...env, BUN_BIN: bun } });
    expect(p.exitCode).toBe(1);
    expect(readFileSync(args, "utf8").trim().split("\n")).toEqual(["run", "scripts/guardian.ts", "--notify", "--no-notify", "--no-broker"]);
    // a violation (1) is a run that happened: the dead-man's marker is written
    expect(existsSync(join(dir, "data", "cron-markers", "guardian.ok"))).toBe(true);
    expect(readFileSync(join(dir, "markers", ".since"), "utf8")).toMatch(/^\d+\n$/);
    expect(Bun.spawnSync(["bash", join(scriptDir, "guardian.sh")], { env: { ...env, BUN_BIN: join(dir, "missing") } }).exitCode).toBe(3);
    // a held lock is an overlapping run: exit 0, no marker refresh, no page
    rmSync(join(dir, "data", "cron-markers", "guardian.ok"));
    const holder = Bun.spawn(["flock", join(dir, "data", "guardian.lock"), "sleep", "5"]);
    try {
      await Bun.sleep(300);
      const locked = Bun.spawnSync(["bash", join(scriptDir, "guardian.sh")], { env: { ...env, BUN_BIN: bun } });
      expect(locked.exitCode).toBe(0);
      expect(locked.stderr.toString()).toContain("skipped");
      expect(existsSync(join(dir, "data", "cron-markers", "guardian.ok"))).toBe(false);
    } finally { holder.kill(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
