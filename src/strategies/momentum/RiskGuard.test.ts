import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EQUITY_SEMANTICS } from "./RiskGuard";
import { fileStatePersistence } from "../../index";
import {
  evaluateRisk, recordRebalanceOutcome, rebaseRiskState, detectPauseTransition,
  INITIAL_RISK_STATE, DEFAULT_RISK_CONFIG, RISK_STATE_VERSION, type RiskState,
} from "./RiskGuard";

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

describe("evaluateRisk", () => {
  test("first call initialises peak and day-start", () => {
    const r = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000);
    expect(r.canOpen).toBe(true);
    expect(r.state.peakEquity).toBe(10_000);
    expect(r.state.dayStartEquity).toBe(10_000);
  });

  test("equity above prior peak updates the peak", () => {
    let s = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    s = evaluateRisk(s, 11_000, 2000).state;
    expect(s.peakEquity).toBe(11_000);
  });

  test("hard drawdown >=20% pauses 7 days and reports human-review reason", () => {
    let s = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const r = evaluateRisk(s, 7_900, 2000); // -21%
    expect(r.canOpen).toBe(false);
    expect(r.breach).toBe("hard_drawdown");
    expect(r.state.pausedUntil).toBeGreaterThan(2000 + 6 * DAY);
  });

  test("soft drawdown 10-20% pauses 24h", () => {
    let s = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const r = evaluateRisk(s, 8_900, 2000); // -11%
    expect(r.breach).toBe("soft_drawdown");
    expect(r.state.pausedUntil).toBe(2000 + 24 * HOUR);
  });

  test("daily loss cap pauses until next UTC midnight", () => {
    // Pick a time mid-day UTC.
    const now = 100 * DAY + 12 * HOUR;
    const s0 = evaluateRisk(INITIAL_RISK_STATE, 10_000, now).state;
    const r = evaluateRisk(s0, 9_650, now + HOUR); // -3.5% same day
    expect(r.breach).toBe("daily_cap");
    expect(r.state.pausedUntil).toBe(101 * DAY);
  });

  test("daily loss cap rolls over: new day re-opens trading even if equity still below threshold", () => {
    const dayOne = 200 * DAY + 10 * HOUR;
    let s = evaluateRisk(INITIAL_RISK_STATE, 10_000, dayOne).state;
    const breached = evaluateRisk(s, 9_650, dayOne + HOUR);
    expect(breached.canOpen).toBe(false);

    // Next day, equity is still down but daily cap doesn't apply (new dayStartEquity).
    const dayTwo = 201 * DAY + 9 * HOUR;
    const next = evaluateRisk(breached.state, 9_650, dayTwo);
    // dayStartEquity reset means dailyLoss=0 → no daily breach. But soft DD still applies.
    expect(next.canOpen).toBe(true); // 9650 vs peak 10000 = 3.5% DD, below 10%
    expect(next.state.dayStartEquity).toBe(9_650);
  });

  test("consecutive losing rebalances trip the streak guard", () => {
    let s: RiskState = { ...INITIAL_RISK_STATE };
    for (let i = 0; i < DEFAULT_RISK_CONFIG.consecutiveLossLimit; i++) {
      s = recordRebalanceOutcome(s, -50); // 5 losses
    }
    const r = evaluateRisk(s, 10_000, 5000);
    expect(r.canOpen).toBe(false);
    expect(r.breach).toBe("loss_streak");
    expect(r.state.consecutiveLosses).toBe(0);
  });

  test("loss-streak pause expires instead of re-arming forever", () => {
    let s: RiskState = { ...INITIAL_RISK_STATE };
    for (let i = 0; i < DEFAULT_RISK_CONFIG.consecutiveLossLimit; i++) {
      s = recordRebalanceOutcome(s, -1);
    }
    const tripped = evaluateRisk(s, 10_000, 5_000);
    expect(tripped.breach).toBe("loss_streak");

    const afterExpiry = evaluateRisk(tripped.state, 10_000, tripped.state.pausedUntil + 1);
    expect(afterExpiry.canOpen).toBe(true);
    expect(afterExpiry.breach).toBeNull();
  });

  test("a winning rebalance resets the streak", () => {
    let s: RiskState = { ...INITIAL_RISK_STATE, consecutiveLosses: 4 };
    s = recordRebalanceOutcome(s, +20);
    expect(s.consecutiveLosses).toBe(0);
  });

  test("during pause window any call returns canOpen=false", () => {
    const future = 9999999;
    const s: RiskState = { ...INITIAL_RISK_STATE, pausedUntil: future, pauseReason: "test pause" };
    const r = evaluateRisk(s, 10_000, future - 1000);
    expect(r.canOpen).toBe(false);
    expect(r.reason).toContain("test pause");
  });

  test("after pause window expires, normal evaluation resumes", () => {
    const past = 1000;
    const s: RiskState = { ...INITIAL_RISK_STATE, pausedUntil: past, pauseReason: "old", peakEquity: 10_000, dayStartEquity: 10_000, dayStartedAt: past - 1000 };
    const r = evaluateRisk(s, 10_000, 2000);
    expect(r.canOpen).toBe(true);
  });

  test("most-severe breach takes precedence (hard > soft > daily > streak)", () => {
    let s = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    s = recordRebalanceOutcome(recordRebalanceOutcome(recordRebalanceOutcome(recordRebalanceOutcome(recordRebalanceOutcome(s, -1), -1), -1), -1), -1);
    // 5 losses + huge drawdown should report hard_drawdown
    const r = evaluateRisk(s, 7_500, 2000); // -25%
    expect(r.breach).toBe("hard_drawdown");
  });
});

// ── detectPauseTransition (B-ops-alerts.md #1) ──────────────────────────────
// 372 blocked crypto ticks over 16 days paged nobody: evaluateRisk runs every
// tick regardless of state, so distinguishing "just paused" from "still
// paused" is the CALLER's job. These pin the pure function in isolation —
// engine-level wiring is covered in MomentumEngine.test.ts/MeanRevEngine.test.ts.
describe("detectPauseTransition", () => {
  test("a fresh breach is pause_started, carrying the breach kind/reason/pausedUntil", () => {
    const prev = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const r = evaluateRisk(prev, 8_900, 2000); // -11% → soft_drawdown
    const t = detectPauseTransition(prev, r);
    expect(t).toEqual({
      kind: "pause_started",
      reason: r.state.pauseReason,
      pausedUntil: r.state.pausedUntil,
      breach: "soft_drawdown",
    });
  });

  test("a CONTINUATION tick (still paused, breach null) fires nothing", () => {
    const prev = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const started = evaluateRisk(prev, 8_900, 2000);
    const continuation = evaluateRisk(started.state, 8_900, 3000); // still well within the 24h window
    expect(continuation.breach).toBeNull();
    expect(detectPauseTransition(started.state, continuation)).toBeNull();
  });

  test("recovery (breach null, canOpen true, was paused as of the last evaluation) is pause_resolved naming the PRIOR reason", () => {
    const prev = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const started = evaluateRisk(prev, 8_900, 2000);
    const priorReason = started.state.pauseReason;
    const recovered = evaluateRisk(started.state, 10_000, started.state.pausedUntil + 1);
    expect(recovered.canOpen).toBe(true);
    const t = detectPauseTransition(started.state, recovered);
    expect(t).toEqual({ kind: "pause_resolved", priorReason });
  });

  test("a healthy tick that was NEVER paused fires nothing", () => {
    const prev = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const r = evaluateRisk(prev, 10_500, 2000); // equity UP, no breach
    expect(detectPauseTransition(prev, r)).toBeNull();
  });

  test("a tick AFTER a resolved recovery (both prev and this eval are healthy) fires nothing — no repeat pause_resolved", () => {
    const prev = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const started = evaluateRisk(prev, 8_900, 2000);
    const recovered = evaluateRisk(started.state, 10_000, started.state.pausedUntil + 1);
    const laterHealthy = evaluateRisk(recovered.state, 10_100, started.state.pausedUntil + 2000);
    expect(detectPauseTransition(recovered.state, laterHealthy)).toBeNull();
  });

  test("hard-drawdown breach propagates breach:'hard_drawdown' — the caller's cue to ALSO page ops", () => {
    let s = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const r = evaluateRisk(s, 7_500, 2000); // -25%
    const t = detectPauseTransition(s, r);
    expect(t?.kind).toBe("pause_started");
    expect((t as any).breach).toBe("hard_drawdown");
  });

  test("a restart mid-pause (prevState reloaded from disk, breach still null this tick) does not fire a resolution merely because pausedUntil is stale relative to lastEvalAt at load time", () => {
    // Simulates the exact persisted shape after a pause_started tick, as a
    // fresh process would load it from the state file/sync_state.
    const prev = evaluateRisk(INITIAL_RISK_STATE, 10_000, 1000).state;
    const started = evaluateRisk(prev, 8_900, 2000);
    const reloaded: RiskState = { ...started.state }; // "restart": same shape, nothing mutated
    const firstTickAfterRestart = evaluateRisk(reloaded, 8_900, 2500); // still within the pause window
    expect(firstTickAfterRestart.canOpen).toBe(false); // still paused — a continuation, not a resolution
    expect(detectPauseTransition(reloaded, firstTickAfterRestart)).toBeNull();
  });
});

describe("recordRebalanceOutcome", () => {
  test("positive PnL resets streak", () => {
    expect(recordRebalanceOutcome({ ...INITIAL_RISK_STATE, consecutiveLosses: 3 }, 1).consecutiveLosses).toBe(0);
  });
  test("zero PnL leaves the streak unchanged", () => {
    expect(recordRebalanceOutcome({ ...INITIAL_RISK_STATE, consecutiveLosses: 3 }, 0).consecutiveLosses).toBe(3);
  });
  test("negative PnL increments streak", () => {
    expect(recordRebalanceOutcome({ ...INITIAL_RISK_STATE, consecutiveLosses: 3 }, -1).consecutiveLosses).toBe(4);
  });
});

describe("rebaseRiskState", () => {
  test("preserves drawdown percentages and real pauses across allocation changes", () => {
    const rebased = rebaseRiskState({
      ...INITIAL_RISK_STATE,
      equityBase: 100_000,
      peakEquity: 96_000,
      dayStartEquity: 100_000,
      pausedUntil: Date.now() + 86_400_000,
      pauseReason: "hard drawdown 48.7%",
    }, 100_000, 50_000);

    expect(rebased.peakEquity).toBe(48_000);
    expect(rebased.dayStartEquity).toBe(50_000);
    expect(rebased.pausedUntil).toBeGreaterThan(0);
    expect(rebased.pauseReason).toBe("hard drawdown 48.7%");
    expect(rebased.equityBase).toBe(50_000);
  });

  test("scales legacy crypto state 10k → 5k when caller supplies previousBase", () => {
    const rebased = rebaseRiskState({
      ...INITIAL_RISK_STATE,
      peakEquity: 10_000,
      dayStartEquity: 10_000,
    }, 10_000, 5_000);

    expect(rebased.peakEquity).toBe(5_000);
    expect(rebased.dayStartEquity).toBe(5_000);
    expect(rebased.equityBase).toBe(5_000);
    expect(rebased.stateVersion).toBe(RISK_STATE_VERSION);
  });

  test("scales legacy stock state 100k → 50k when caller supplies previousBase", () => {
    const rebased = rebaseRiskState({
      ...INITIAL_RISK_STATE,
      peakEquity: 100_000,
      dayStartEquity: 100_000,
    }, 100_000, 50_000);

    expect(rebased.peakEquity).toBe(50_000);
    expect(rebased.dayStartEquity).toBe(50_000);
    expect(rebased.equityBase).toBe(50_000);
  });

  test("legacy rebase is idempotent across repeated loads", () => {
    const legacy = {
      ...INITIAL_RISK_STATE,
      peakEquity: 10_000,
      dayStartEquity: 10_000,
    };
    const first = rebaseRiskState(legacy, 10_000, 5_000);
    expect(first.peakEquity).toBe(5_000);
    expect(first.dayStartEquity).toBe(5_000);
    expect(first.equityBase).toBe(5_000);

    const second = rebaseRiskState(first, 10_000, 5_000);
    expect(second.peakEquity).toBe(5_000);
    expect(second.dayStartEquity).toBe(5_000);
    expect(second.equityBase).toBe(5_000);
  });

  test("preserves genuine pauses while scaling legacy state", () => {
    const rebased = rebaseRiskState({
      ...INITIAL_RISK_STATE,
      peakEquity: 100_000,
      dayStartEquity: 100_000,
      pausedUntil: Date.now() + 86_400_000,
      pauseReason: "hard drawdown 48.7%",
    }, 100_000, 50_000);

    expect(rebased.peakEquity).toBe(50_000);
    expect(rebased.dayStartEquity).toBe(50_000);
    expect(rebased.pausedUntil).toBeGreaterThan(0);
    expect(rebased.pauseReason).toBe("hard drawdown 48.7%");
    expect(rebased.equityBase).toBe(50_000);
  });

  test("does not clear genuine pauses by substring match", () => {
    const rebased = rebaseRiskState({
      ...INITIAL_RISK_STATE,
      equityBase: 100_000,
      peakEquity: 96_000,
      dayStartEquity: 100_000,
      pausedUntil: Date.now() + 86_400_000,
      pauseReason: "hard drawdown 48.7%",
    }, 100_000, 50_000, { clearPauseReason: "drawdown" });

    expect(rebased.pausedUntil).toBeGreaterThan(0);
    expect(rebased.pauseReason).toBe("hard drawdown 48.7%");
  });

  test("clears only an explicitly identified accounting-artifact pause", () => {
    const artifact = "hard drawdown 48.7%";
    const rebased = rebaseRiskState({
      ...INITIAL_RISK_STATE,
      equityBase: 100_000,
      peakEquity: 96_000,
      dayStartEquity: 100_000,
      pausedUntil: Date.now() + 86_400_000,
      pauseReason: artifact,
    }, 100_000, 50_000, { clearPauseReason: artifact });

    expect(rebased.pausedUntil).toBe(0);
    expect(rebased.pauseReason).toBe("");
  });
});

describe("peak decay (P0 permanent-lockout regression, 2026-07-10)", () => {
  // Before the fix, peakEquity was an all-time ratchet: equity flat 10.5%
  // below peak re-armed the 24h soft-dd pause FOREVER (the 2024 walk-forward
  // died on Jan 17 and missed a +100% year). With peakHalfLifeDays=30 the
  // peak decays toward current equity and the guard re-arms in weeks.
  const DAY = 86_400_000;

  test("soft-dd lockout self-heals via peak decay when equity stays flat", () => {
    let s: RiskState = { ...INITIAL_RISK_STATE };
    let t = 1_000_000;
    s = evaluateRisk(s, 10_000, t).state; // establish peak 10k
    // drop to 8950 (-10.5%) → soft pause
    t += DAY;
    let r = evaluateRisk(s, 8_950, t);
    expect(r.breach).toBe("soft_drawdown");
    s = r.state;
    // equity stays flat at 8950 for 40 days of daily evaluations
    let reopened = false;
    for (let i = 0; i < 40; i++) {
      t += DAY;
      r = evaluateRisk(s, 8_950, t);
      s = r.state;
      if (r.canOpen) { reopened = true; break; }
    }
    expect(reopened).toBe(true); // was: locked out forever
  });

  test("legacy ratchet (peakHalfLifeDays=0) still locks out — documents the old behaviour", () => {
    const cfg = { ...DEFAULT_RISK_CONFIG, peakHalfLifeDays: 0 };
    let s: RiskState = { ...INITIAL_RISK_STATE };
    let t = 1_000_000;
    s = evaluateRisk(s, 10_000, t, cfg).state;
    t += DAY;
    s = evaluateRisk(s, 8_950, t, cfg).state;
    for (let i = 0; i < 40; i++) {
      t += DAY;
      const r = evaluateRisk(s, 8_950, t, cfg);
      s = r.state;
      expect(r.canOpen).toBe(false);
    }
  });

  test("a genuine crash still trips hard-dd promptly (decay is slow vs a crash)", () => {
    let s: RiskState = { ...INITIAL_RISK_STATE };
    let t = 1_000_000;
    s = evaluateRisk(s, 10_000, t).state;
    t += 60 * 60_000; // one hour later, -25%
    const r = evaluateRisk(s, 7_500, t);
    expect(r.breach).toBe("hard_drawdown");
  });
});

describe("persisted equity semantic migration", () => {
  test("crypto era-3→era-4 (USDT-only → total-margin) re-anchors once, persists the new meaning, and preserves pause state", () => {
    const dir = mkdtempSync(join(tmpdir(), "risk-state-"));
    const path = join(dir, "crypto.json");
    const old = {
      ...INITIAL_RISK_STATE,
      peakEquity: 20_000,
      dayStartEquity: 19_000,
      consecutiveLosses: 3,
      pausedUntil: 999_999_999,
      pauseReason: "real pause",
      // era-3 label: old USDT-collateral-only equity, now superseded by
      // BINANCE_TOTAL_MARGIN (2026-07-18) — must be recognized as stale.
      equitySemantics: EQUITY_SEMANTICS.BINANCE_USDT_MARGIN,
    };
    writeFileSync(path, JSON.stringify(old));
    const persistence = fileStatePersistence(path, 5_000, 10_000, EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN);
    const loaded = persistence.load()!.risk;
    expect(loaded.pendingSemanticReanchor).toBe(true);
    const migrated = evaluateRisk(loaded, 10_300, 10_000, { ...DEFAULT_RISK_CONFIG, peakHalfLifeDays: 0 });
    expect(migrated.state.peakEquity).toBe(10_300);
    expect(migrated.state.dayStartEquity).toBe(10_300);
    expect(migrated.state.pendingSemanticReanchor).toBe(false);
    expect(migrated.state.pausedUntil).toBe(old.pausedUntil);
    expect(migrated.state.pauseReason).toBe(old.pauseReason);
    expect(migrated.state.consecutiveLosses).toBe(3);
    persistence.save({ v: 1, risk: migrated.state });
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted.risk.equitySemantics).toBe(EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN);
    expect(persisted.risk.pendingSemanticReanchor).toBe(false);
    const again = fileStatePersistence(path, 5_000, 10_000, EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN).load()!.risk;
    expect(again.pendingSemanticReanchor).toBe(false); // already on the target semantics: no re-reanchor
    const second = evaluateRisk(again, 10_200, 11_000, { ...DEFAULT_RISK_CONFIG, peakHalfLifeDays: 0 });
    expect(second.state.peakEquity).toBe(10_300);
    expect(second.state.consecutiveLosses).toBe(3);
    unlinkSync(path);
    rmdirSync(dir);
  });

  test("stock legacy state is labeled and proportionally rebased without clearing pause", () => {
    const dir = mkdtempSync(join(tmpdir(), "risk-state-"));
    const path = join(dir, "stocks.json");
    writeFileSync(path, JSON.stringify({
      ...INITIAL_RISK_STATE,
      peakEquity: 100_000,
      dayStartEquity: 90_000,
      pausedUntil: 999_999_999,
      pauseReason: "real pause",
    }));
    const state = fileStatePersistence(path, 50_000, 100_000, EQUITY_SEMANTICS.SLEEVE_LEDGER).load()!.risk;
    expect(state.equitySemantics).toBe(EQUITY_SEMANTICS.SLEEVE_LEDGER);
    expect(state.pendingSemanticReanchor).toBe(false);
    expect(state.peakEquity).toBe(50_000);
    expect(state.dayStartEquity).toBe(45_000);
    expect(state.pausedUntil).toBe(999_999_999);
    unlinkSync(path);
    rmdirSync(dir);
  });
});

describe("fileStatePersistence envelope — trailMarks round-trip + legacy flat compat", () => {
  test("legacy flat file (EXACT prod momentum-state-*.json shape today) loads as { risk: <flat>, trailMarks: {} }", () => {
    const dir = mkdtempSync(join(tmpdir(), "risk-state-"));
    const path = join(dir, "crypto.json");
    // Byte-for-byte the field set prod's four files contain (2026-08).
    const prodFlat = {
      stateVersion: 3,
      peakEquity: 4643.9204178310865,
      dayStartEquity: 4537.29616682,
      dayStartedAt: 1785370012089,
      consecutiveLosses: 0,
      pausedUntil: 0,
      pauseReason: "",
      lastEvalAt: 1785422402072,
      equitySemantics: EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN,
      equityBase: 5000,
      pendingSemanticReanchor: false,
    };
    writeFileSync(path, JSON.stringify(prodFlat));
    const loaded = fileStatePersistence(path, 5_000, 10_000, EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN).load()!;
    expect(loaded.trailMarks).toEqual({}); // legacy = no watermarks, never a crash
    expect(loaded.risk.peakEquity).toBe(prodFlat.peakEquity);
    expect(loaded.risk.dayStartEquity).toBe(prodFlat.dayStartEquity);
    expect(loaded.risk.consecutiveLosses).toBe(0);
    expect(loaded.risk.pausedUntil).toBe(0);
    expect(loaded.risk.lastEvalAt).toBe(prodFlat.lastEvalAt);
    expect(loaded.risk.equityBase).toBe(5000);
    expect(loaded.risk.pendingSemanticReanchor).toBe(false);
    unlinkSync(path);
    rmdirSync(dir);
  });

  test("v1 envelope round-trips risk AND trailMarks; file nests risk under `risk`", () => {
    const dir = mkdtempSync(join(tmpdir(), "risk-state-"));
    const path = join(dir, "stocks.json");
    const persistence = fileStatePersistence(path, 50_000, 50_000, EQUITY_SEMANTICS.SLEEVE_LEDGER);
    const risk: RiskState = {
      ...INITIAL_RISK_STATE,
      peakEquity: 51_200.5,
      dayStartEquity: 50_406.6,
      dayStartedAt: 1785418551568,
      lastEvalAt: 1785422431071,
      equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER,
      equityBase: 50_000,
    };
    const marks = {
      "NVDA|buy": { mark: 132.44, lastTs: 1785422400000 },
      "SMH|sell": { mark: 240.1, lastTs: 1785422100000 },
    };
    persistence.save({ v: 1, risk, trailMarks: marks });

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.v).toBe(1);
    expect(onDisk.risk.peakEquity).toBe(51_200.5);
    expect(onDisk.trailMarks).toEqual(marks);

    const reloaded = persistence.load()!;
    expect(reloaded.trailMarks).toEqual(marks);
    expect(reloaded.risk.peakEquity).toBe(51_200.5);
    expect(reloaded.risk.dayStartEquity).toBe(50_406.6);
    unlinkSync(path);
    rmdirSync(dir);
  });

  test("legacy load → save → reload lands on the envelope with marks preserved (deploy-over-old-state path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "risk-state-"));
    const path = join(dir, "migrate.json");
    writeFileSync(path, JSON.stringify({
      ...INITIAL_RISK_STATE, peakEquity: 5_100, dayStartEquity: 5_000, dayStartedAt: 1, lastEvalAt: 2,
      equitySemantics: EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN, equityBase: 5_000, pendingSemanticReanchor: false,
    }));
    const persistence = fileStatePersistence(path, 5_000, 5_000, EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN);
    const first = persistence.load()!;
    expect(first.trailMarks).toEqual({});
    // Engine ran a tick, raised a watermark, persisted:
    persistence.save({ ...first, trailMarks: { "BTC/USD|buy": { mark: 61_000, lastTs: 3 } } });
    const second = persistence.load()!;
    expect(second.trailMarks).toEqual({ "BTC/USD|buy": { mark: 61_000, lastTs: 3 } });
    expect(second.risk.peakEquity).toBe(5_100);
    unlinkSync(path);
    rmdirSync(dir);
  });
});
