// RW7 candidates are drafts, not live changes or evidence of profitability.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { candidateToReplayConfig, loadManifest, validateCandidate } from "./walk-forward";
import { hashReplayConfig, runWithConfig } from "./backtest-momentum-wf";
import { INITIAL_RISK_STATE } from "../src/strategies/momentum/RiskGuard";

const read = (name: string) => loadManifest(join(import.meta.dir, "../experiments", `${name}.json`));
const names = ["momentum-crypto-rw7-nobrakes-pure-v1", "momentum-crypto-usdc-daily-s5-rw7-nobrakes-pure-v1"];
const controls = ["momentum-crypto-rw6-maxhold5-pure-v1", "momentum-crypto-usdc-daily-s5-rw6-maxhold5-pure-v1"];

describe("RW7 protocol", () => {
  test.each([0, 1])("candidate %i changes ONLY the declared brakes, reserves 464/465 and retains safety/sizing", i => {
    const m = read(names[i]), control = read(controls[i]);
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 464 + i, complete: false });
    const { description: _d, name: _n, trialAccounting: _t, candidates: _c, ...rest } = m;
    const { description: _cd, name: _cn, trialAccounting: _ct, candidates: _cc, ...controlRest } = control;
    expect(rest).toEqual(controlRest);
    const { sharpeGate: _sg, ...before } = control.candidates[0];
    expect(m.candidates).toEqual([{ ...before, risk: { ...before.risk, mode: "sizeOnly" }, regime: "off", allowSameTickReentry: true }]);
    const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
    expect(cfg.risk).toEqual({ peakHalfLifeDays: 30, mode: "sizeOnly" });
    expect(cfg.allowSameTickReentry).toBe(true);
    expect(cfg.regime).toEqual({ enabled: false });
    expect(cfg.sharpeGate).toBeUndefined();
    const old = candidateToReplayConfig(control, control.candidates[0], "base"), legacy = hashReplayConfig(old);
    expect(hashReplayConfig({ ...old, allowSameTickReentry: undefined, risk: { ...old.risk, mode: undefined } })).toBe(legacy);
    expect(hashReplayConfig({ ...old, allowSameTickReentry: true })).not.toBe(legacy);
    expect(hashReplayConfig({ ...old, risk: { ...old.risk, mode: "sizeOnly" } })).not.toBe(legacy);
    expect(hashReplayConfig(candidateToReplayConfig(control, { ...control.candidates[0], allowSameTickReentry: false }, "base"))).toBe(legacy);
    expect(hashReplayConfig(cfg)).not.toBe(legacy);
    // Source-text lock: candidates MUST NOT replace the running configurations.
    expect(readFileSync(join(import.meta.dir, "../src/config/liveSleeveConfigs.ts"), "utf8")).not.toContain(names[i]);
  });

  test("strict validation rejects misspellings, incompatible risk sizing and non-boolean re-entry", () => {
    const base = read(names[0]).candidates[0];
    for (const mode of [false, "off", "sizeonly", null]) expect(() => validateCandidate({ ...base, risk: { mode } })).toThrow("risk.mode");
    for (const value of [1, "true", null]) expect(() => validateCandidate({ ...base, allowSameTickReentry: value })).toThrow("boolean");
    expect(() => validateCandidate({ ...base, risk: { mode: "sizeOnly", ddScale: { startPct: 0.1, endPct: 0.4, minScale: 0.25 } } })).toThrow("cannot combine");
    expect(() => validateCandidate({ ...base, risk: { mode: "sizeOnly", shadowResume: { recoverPct: 0.03 } } })).toThrow("cannot combine");
  });

  test("synthetic replay forwards sizeOnly, preserves inherited DD sizing, and rebuys at 120h without a blank day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw7-synthetic-")), dbPath = join(dir, "bars.db"), day = 86400000;
    const start = Date.parse("2024-01-01T00:00:00Z");
    try {
      const db = new Database(dbPath);
      db.exec("CREATE TABLE historical_bars(symbol TEXT,timeframe TEXT,timestamp INTEGER,open REAL,high REAL,low REAL,close REAL,volume REAL,source TEXT)");
      const insert = db.prepare("INSERT INTO historical_bars VALUES(?,?,?,?,?,?,?,?,?)");
      db.transaction(() => { for (let i = -420; i <= 8; i++) {
        const px = 100 * Math.pow(1.001, i);
        insert.run("BTC/USD", "1d", start + i * day, px, px, px, px, 100000, "binance_futures");
      } })();
      db.close();
      const m = read(names[1]);
      const cfg = { ...candidateToReplayConfig(m, m.candidates[0], "base"), universe: ["BTC/USD"], dbPath, funding: false };
      const seed = { ...INITIAL_RISK_STATE, peakEquity: 6250, highWaterMark: 6250, dayStartEquity: 5000,
        dayStartedAt: start, lastEvalAt: start, pausedUntil: start + 30 * day, pauseReason: "soft drawdown 20% — paused 24h" };
      const result = await runWithConfig(cfg, { label: "synthetic", from: "2024-01-01", to: "2024-01-08" }, seed);
      expect(result).not.toBeNull();
      const trades = result!.closedTrades;
      expect(trades).toHaveLength(2); // TIME_STOP then fold_end, no native/trail stop hit
      expect(trades[0].engineCloseReason).toBe("TIME_STOP");
      // SimBroker labels engine closes now+1ms so realised-PnL windows do not
      // lose boundary fills; the rebuy executes at this decision's now.
      expect(trades[0].exitAt - trades[0].entryAt!).toBe(5 * day + 1);
      expect(trades[1].entryAt! + 1).toBe(trades[0].exitAt);
      expect(trades[0].entryPrice! * trades[0].qty!).toBeCloseTo(5000 * 0.2 * (2 / 3), 5); // DD retained, not reset at unpause
      expect(result!.finalRiskState!.pausedUntil).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
