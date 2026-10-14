import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAiQuorumSummary } from "./aiQuorum";
import { openQuorumDb, insertModelViews, insertQuorumPositions, insertSnapshot } from "../../ai-quorum/db";
import type { Snapshot } from "../../ai-quorum/types";

const dirs: string[] = [];
// stale @types/node lacks rmSync (repo-wide dodge — see instanceFile.test.ts)
afterEach(() => { for (const d of dirs.splice(0)) require("fs").rmSync(d, { recursive: true, force: true }); });

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-quorum-test-"));
  dirs.push(dir);
  return join(dir, "ai-quorum.db");
}

const snap = (dateKey: string, decidedAt: number): Snapshot => ({
  assetClass: "stocks", dateKey, decidedAt,
  symbols: [{ symbol: "SPY", ret1: 0, ret5: 0, ret21: 0.05, ret63: 0, vol20: 0.01, rsi14: 50, distMA50: 0, distMA200: 0, funding: null, lastClose: 500, lastBarTs: decidedAt - 1 }],
  headlines: [],
});

describe("buildAiQuorumSummary", () => {
  test("missing db file → status none", () => {
    const out: any = buildAiQuorumSummary("/nonexistent/path/ai-quorum.db", Date.now());
    expect(out.status).toBe("none");
  });

  test("snapshots without views → pending_keys", () => {
    const path = tmpDbPath();
    const db = openQuorumDb(path);
    insertSnapshot(db, snap("2026-10-08", Date.UTC(2026, 9, 8, 21, 15)), "pending_keys");
    db.close();
    const out: any = buildAiQuorumSummary(path, Date.UTC(2026, 9, 9));
    expect(out.status).toBe("pending_keys");
    expect(out.snapshots).toBe(1);
    expect(out.verdict).toBeNull();
    expect(out.today[0].status).toBe("pending_keys");
    expect(out.today[0].views).toEqual([]);
  });

  test("active: today's views + quorum, stats and month spend", () => {
    const path = tmpDbPath();
    const db = openQuorumDb(path);
    const now = Date.UTC(2026, 9, 8, 22, 0);
    const id = insertSnapshot(db, snap("2026-10-08", Date.UTC(2026, 9, 8, 21, 15)), "ok");
    insertModelViews(db, id, "openrouter:anthropic/claude", { SPY: { view: "long", confidence: 0.8 } });
    insertModelViews(db, id, "openrouter:openai/gpt", { SPY: { view: "long", confidence: 0.7 } });
    insertQuorumPositions(db, id, [{ symbol: "SPY", direction: 1, meanConfidence: 0.75 }]);
    db.query("INSERT INTO fills (snapshot_id, symbol, entry_ts, entry_px, exit_ts, exit_px) VALUES (?, 'SPY', 1, 500, 2, 505)").run(id);
    db.query("INSERT INTO model_calls (snapshot_id, model_id, status, cost_usd, called_at) VALUES (?, 'm', 'ok', 0.25, ?)").run(id, now);
    db.close();

    const out: any = buildAiQuorumSummary(path, now);
    expect(out.status).toBe("active");
    expect(out.sessionsWithViews).toBe(1);
    expect(out.firstViewsDate).toBe("2026-10-08");
    expect(out.verdictDate).toBe("2026-12-03");
    expect(out.today[0].quorum).toEqual([{ symbol: "SPY", direction: 1, mean_confidence: 0.75 }]);
    expect(out.today[0].views.length).toBe(2);
    expect(out.curve.length).toBe(1);
    expect(out.stats.book.nPositions).toBe(1);
    expect(out.stats.benchEwLong.nPositions).toBe(1);
    expect(out.spendMonthUsd).toBeCloseTo(0.25, 10);
  });
});
