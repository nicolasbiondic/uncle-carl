import { describe, test, expect, beforeEach } from "bun:test";
import { getETDateKey, hasDailyReport, getDB } from "../db/database";
import { DailyReporter } from "./DailyReporter";
import { makeTestDb } from "../test-support/db";

// Audit fix (2026-07-21): checkReportTime used to latch in-memory BEFORE the
// generate call, only firing on an exact 23:59 poll — a missed minute or a
// throwing generateReport dropped the day forever. It's now DB-backed
// (hasDailyReport) and self-healing via a bounded prev-day catch-up.
beforeEach(() => { makeTestDb(); });

function makeReporter(getAccountSummaries: () => any[]) {
  const r = new DailyReporter();
  r.getAccountSummaries = getAccountSummaries;
  return r;
}

describe("DailyReporter self-healing", () => {
  test("catch-up: a missing prior-day report is generated on the next poll", async () => {
    const prev = getETDateKey(Date.now() - 86_400_000);
    const r = makeReporter(() => [{ id: "momentum_stocks", initialEquity: 1000, equity: 1000 }]);
    expect(hasDailyReport(prev)).toBe(false);

    await (r as any).checkReportTime();

    expect(hasDailyReport(prev)).toBe(true);
  });

  test("a throwing generateReport does not block a later retry", async () => {
    const prev = getETDateKey(Date.now() - 86_400_000);
    let calls = 0;
    const r = makeReporter(() => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return [{ id: "momentum_stocks", initialEquity: 1000, equity: 1000 }];
    });

    // First poll: generateReport's internal try/catch swallows the throw from
    // getAccountSummaries, so no row is written — but the DB-backed latch
    // means nothing was falsely marked "done".
    await (r as any).checkReportTime();
    expect(hasDailyReport(prev)).toBe(false);

    // Second poll (retry): succeeds now, proving the earlier failure didn't
    // suppress the retry the way the old in-memory latch would have.
    await (r as any).checkReportTime();
    expect(hasDailyReport(prev)).toBe(true);
  });
});

// Reentrancy guard (2026-07-29): the 60s setInterval poll does NOT await the
// previous checkReportTime, so a slow generation (hung Telegram fetch, big DB
// scan) must not let a second poll re-enter and send the Telegram digest
// twice. Same class as BrokerSync.syncing (src/sync/BrokerSync.test.ts).
//
// generateReport() is overridden directly (rather than relying on the real
// hasDailyReport() DB latch) so this test isolates the `ticking` guard
// itself: with the real generateReport, saveDailyReport() runs synchronously
// before the awaited Telegram call, so the DB latch alone would already mask
// a removed guard on this exact interleaving. Overriding generateReport
// removes that masking side effect and proves the guard — not the DB
// latch — is what stops the second call from re-entering.
// ── telegram_sent only on CONFIRMED delivery (B-ops-alerts.md #8) ──────────
// telegram_sent used to flip to 1 whenever sendTelegramDigest() resolved
// without throwing — TelegramReporter's apiCall swallowed fetch errors
// internally and never checked Telegram's `ok` field, so a rejected/failed
// send looked identical to a real delivery. sendDaily() now returns a
// boolean the reporter actually trusts.
function telegramSentFlag(reportDate: string): number | undefined {
  const row = getDB().prepare(`SELECT telegram_sent FROM daily_reports WHERE report_date = ? LIMIT 1`).get(reportDate) as any;
  return row?.telegram_sent;
}

describe("DailyReporter — telegram_sent reflects CONFIRMED delivery, not just a non-throwing callback", () => {
  test("sendTelegramDigest resolving true flips telegram_sent=1", async () => {
    const prev = getETDateKey(Date.now() - 86_400_000);
    const r = makeReporter(() => [{ id: "momentum_stocks", initialEquity: 1000, equity: 1000 }]);
    r.sendTelegramDigest = async () => true;

    await (r as any).checkReportTime();

    expect(hasDailyReport(prev)).toBe(true);
    expect(telegramSentFlag(prev)).toBe(1);
  });

  test("sendTelegramDigest resolving false (Telegram did NOT confirm) leaves telegram_sent=0 — the report row itself still saves", async () => {
    const prev = getETDateKey(Date.now() - 86_400_000);
    const r = makeReporter(() => [{ id: "momentum_stocks", initialEquity: 1000, equity: 1000 }]);
    r.sendTelegramDigest = async () => false; // e.g. Telegram 4xx/5xx, or the chat is unset

    await (r as any).checkReportTime();

    expect(hasDailyReport(prev)).toBe(true); // the report itself is NOT held hostage to Telegram
    expect(telegramSentFlag(prev)).toBe(0);
  });

  test("sendTelegramDigest THROWING (composing the digest itself failed) also leaves telegram_sent=0, without crashing the pass", async () => {
    const prev = getETDateKey(Date.now() - 86_400_000);
    const r = makeReporter(() => [{ id: "momentum_stocks", initialEquity: 1000, equity: 1000 }]);
    r.sendTelegramDigest = async () => { throw new Error("accountSummaries hook detached"); };

    await (r as any).checkReportTime();

    expect(hasDailyReport(prev)).toBe(true);
    expect(telegramSentFlag(prev)).toBe(0);
  });
});

describe("DailyReporter.checkReportTime — reentrancy guard", () => {
  test("a second checkReportTime call while one is in-flight does not re-run generateReport", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const genCalls: (string | undefined)[] = [];

    const r = new DailyReporter();
    r.getAccountSummaries = () => [];
    (r as any).generateReport = async (date?: string) => {
      genCalls.push(date);
      await gate; // parks the first pass — guard (if present) stays held
    };

    const p1 = (r as any).checkReportTime(); // hasDailyReport(prev) false → calls generateReport(prev), parks on `gate`
    // Flush microtasks so p1 is parked inside the awaited gate before p2 races in.
    await Promise.resolve();
    await Promise.resolve();

    const p2 = (r as any).checkReportTime(); // guard held → must return WITHOUT calling generateReport again
    await p2;

    expect(genCalls.length).toBe(1); // the second poll never re-entered

    release();
    await p1;
    expect(genCalls.length).toBe(1); // still just the one call once p1 completes
  });
});
