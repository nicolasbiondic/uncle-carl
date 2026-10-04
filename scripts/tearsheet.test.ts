/**
 * Tearsheet generation from a SYNTHETIC artifact directory — no real
 * data/backtests artifacts, no historical DB (the benchmark degrades to a
 * note), no network. Locks the offline contract: file name tearsheet.html
 * at the artifact root, inline SVG only, gates/folds/MC content present.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTearsheetData, dailyEquitySeries, generateTearsheet, renderTearsheetHtml } from "./tearsheet";
import { mulberry32 } from "./lib/sequenceRisk";

const dir = mkdtempSync(join(tmpdir(), "uc-tearsheet-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function syntheticArtifact(): void {
  const rand = mulberry32(77);
  const day = 86_400_000;
  const t0 = Date.parse("2024-01-01T00:00:00Z");
  const makeFold = (foldIdx: number, days: number, startOffsetDays: number) => {
    const fromMs = t0 + startOffsetDays * day;
    const toMs = fromMs + days * day;
    const equityHistory: Array<{ t: number; eq: number }> = [];
    const dailyReturns: Array<{ date: string; ret: number }> = [];
    const closedTrades: Array<{ symbol: string; side: string; pnl: number; exitAt: number; entryAt: number }> = [];
    let eq = 10_000;
    for (let i = 0; i < days; i++) {
      const t = fromMs + i * day;
      const ret = (rand() - 0.47) * 0.02;
      eq *= 1 + ret;
      equityHistory.push({ t, eq });
      if (i > 0) dailyReturns.push({ date: new Date(t).toISOString().slice(0, 10), ret });
      if (i % 7 === 3) {
        closedTrades.push({ symbol: i % 14 === 3 ? "BTC/USD" : "ETH/USD", side: "buy", pnl: (rand() - 0.45) * 200, exitAt: t, entryAt: t - 2 * day });
      }
    }
    return {
      foldPath: `${foldIdx}/test`,
      costTier: "base",
      status: "complete",
      candidateName: "synth",
      result: {
        sleeve: "crypto",
        window: { label: `${foldIdx}/test`, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        fromMs, toMs,
        config: { slippageBps: 5, commissionBps: 4, rthOnly: false, initialEquity: 10_000, sleeve: "crypto", source: "binance_futures" },
        finalEquity: eq, totalReturn: eq / 10_000 - 1, maxDrawdown: 0.1, sharpe: 1.0,
        winRate: 0.5, trades: closedTrades.length, tradesPerDay: 0.1, expectancy: 5,
        fees: 10, funding: 1, liquidations: 0, marginRejects: 0, ruined: false, bench: 0.05,
        dailyReturns, sessionReturns: [], tradesBySymbol: {}, equityHistory, closedTrades, hash: "h",
      },
    };
  };
  const folds = [makeFold(0, 120, 0), makeFold(1, 120, 120)];
  // A stress row and a swept break-even row that MUST be filtered out.
  const stress = { ...folds[0], costTier: "stress", result: { ...folds[0].result, config: { ...folds[0].result.config, slippageBps: 10, commissionBps: 8 } } };
  const sweep = { ...folds[0], result: { ...folds[0].result, config: { ...folds[0].result.config, slippageBps: 20 } } };
  writeFileSync(join(dir, "runs.jsonl"), [folds[0], folds[1], stress, sweep].map(x => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, "manifest-resolved.json"), JSON.stringify({
    name: "synthetic-tearsheet-v1",
    sleeve: "crypto",
    data: { dbPath: join(dir, "missing.db"), source: "binance_futures", timeframe: "1h", universe: ["BTC/USD", "ETH/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60 },
    window: { from: "2024-01-01", to: "2024-09-01", outerFoldCount: 2, innerFoldCount: 2, purgeYears: 0, warmupDays: 30 },
    costs: { base: { slippageBps: 5, commissionBps: 4 }, stress: { slippageBps: 10, commissionBps: 8 } },
    ledger: { initialEquity: 10_000, leverage: 2, hardStopPct: 0.04 },
  }));
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    manifestHash: "f".repeat(64), configHash: "a".repeat(64), dataHash: "b".repeat(64), codeHash: "c".repeat(64),
    asOfMs: t0, resolvedTo: "2024-09-01T00:00:00.000Z",
    selectedCandidate: { hash: "d".repeat(64), name: "synth", reason: "only candidate" },
    outerSelection: [
      { foldPath: "0/test", candidateName: "synth", candidateHash: "d".repeat(64) },
      { foldPath: "1/test", candidateName: "synth", candidateHash: "d".repeat(64) },
    ],
    stitchedOos: { totalReturn: 0.2, sharpe: 1.1, maxDrawdown: 0.12, winRate: 0.5, trades: 34, expectancy: 4, fees: 20, funding: 2, liquidations: 0, marginRejects: 0, ruined: false, benchReturn: 0.15, benchSharpe: 0.9 },
    foldPsr: [{ foldPath: "0/test", psr: 0.91 }, { foldPath: "1/test", psr: 0.72 }],
    outerPsr: 0.93, observations: 238,
    acceptance: {
      minSharpe: { gate: "minSharpe", value: 1.1, threshold: 0, pass: true },
      maxDrawdown: { gate: "maxDrawdown", value: 0.12, threshold: 0.45, pass: true },
      minOuterPsr: { gate: "minOuterPsr", value: 0.93, threshold: 0.95, pass: false },
    },
    approved: false, approvalReason: "gate(s) failed: minOuterPsr",
  }));
}

syntheticArtifact();

describe("tearsheet from a synthetic artifact", () => {
  test("dailyEquitySeries buckets by day keeping the last point", () => {
    const day = 86_400_000;
    const t0 = Date.parse("2024-01-01T00:00:00Z");
    const s = dailyEquitySeries([
      { t: t0, eq: 100 }, { t: t0 + 60_000, eq: 105 }, { t: t0 + day, eq: 90 },
    ], false);
    expect(s).toEqual([{ date: "2024-01-01", eq: 105 }, { date: "2024-01-02", eq: 90 }]);
  });

  test("buildTearsheetData filters to the outer base chain and degrades the benchmark to a note", () => {
    const d = buildTearsheetData(dir);
    expect(d.outerResults.map(r => r.window.label)).toEqual(["0/test", "1/test"]);
    expect(d.daily.length).toBeGreaterThan(200);
    expect(d.daily[0].eq).toBe(1); // normalized
    expect(d.bench).toBeNull();
    expect(d.benchNote).toContain("benchmark unavailable");
    expect(d.sequenceRisk.bootstrap).toBeDefined();
    expect(d.sequenceRisk.tradeReshuffle).toBeDefined();
    expect(d.ppy).toBe(365);
  });

  test("generateTearsheet writes tearsheet.html at the artifact root (dashboard contract) with all sections, offline", () => {
    const { outPath, html } = generateTearsheet(dir);
    expect(outPath).toBe(join(dir, "tearsheet.html"));
    expect(existsSync(outPath)).toBe(true);
    const onDisk = readFileSync(outPath, "utf-8");
    expect(onDisk).toBe(html);
    // Header + purity + hashes.
    expect(html).toContain("synthetic-tearsheet-v1");
    expect(html).toContain("f".repeat(64));
    expect(html).toContain("PURE — every outer fold ran synth");
    expect(html).toContain("gate(s) failed: minOuterPsr");
    // Sections.
    expect(html).toContain("Underwater");
    expect(html).toContain("Monthly returns");
    expect(html).toContain("Rolling 6-month Sharpe");
    expect(html).toContain("Sequence-risk Monte Carlo");
    expect(html).toContain("block bootstrap");
    // Gates table carries the stored verdicts.
    expect(html).toContain("minOuterPsr");
    expect(html).toContain("✗ FAIL");
    // Fold table lists both folds and their PSR.
    expect(html).toContain("0/test");
    expect(html).toContain("1/test");
    // Offline: no external resource loads — the ONLY http occurrence is the
    // SVG xmlns namespace identifier (not a network fetch).
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    const urls = html.match(/https?:\/\/[^"'< ]+/g) ?? [];
    expect([...new Set(urls)]).toEqual(["http://www.w3.org/2000/svg"]);
  });

  test("a MIXED chain is labeled as such", () => {
    const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf-8"));
    s.outerSelection[1] = { foldPath: "1/test", candidateName: "other", candidateHash: "e".repeat(64) };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(s));
    const html = renderTearsheetHtml(buildTearsheetData(dir));
    expect(html).toContain("MIXED — 0/test=synth, 1/test=other");
  });
});
