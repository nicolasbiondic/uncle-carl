// ═══════════════════════════════════════════════════════════════════════
// The "vivo = validado" lock (W4 parity, 2026-09-25).
//
// For each live MOMENTUM-ENGINE sleeve, compares the CandidateConfig DERIVED
// from the same constants src/index.ts wires (src/config/liveSleeveConfigs.ts)
// against the candidate of its AUTHORITATIVE experiment manifest — the
// artifact whose pure OOS chain justified this exact config:
//
//   momentum_crypto ↔ experiments/momentum-crypto-rw10-turtle-s1-short-pure-v1.json
//   momentum_crypto_usdc ↔ experiments/momentum-crypto-usdc-daily-s5-rw8-sizeonly-bo13-pure-v1.json
//     (RW7: no risk pauses; hourly removes regime/Sharpe/cooldown, USDC keeps them)
//
// RW2 (2026-10-23): momentum_stocks and meanrev_stocks run on the PORTFOLIO
// ENGINE (MODEL_VERSIONS current version `engine: "portfolio"`). Their
// LIVE_SLEEVE_MANIFESTS entry is the RW manifest whose candidate the registry
// definition — and, since 2026-11-07, the code's built-in fallback definition
// (src/portfolios/builtin.ts, locked by src/portfolios/builtinPortfolioEngine.test.ts)
// — is hash-locked to at boot (cutover.ts). The TSM/Connors incumbents of the
// stock sleeves were deleted that day (owner, audit C): there is no incumbent
// derivation and liveSleeveConfig() throws for them (locked below).
//
// EVERY decision-affecting candidate key must be equal, or be listed in
// DECLARED_KEY_EXCEPTIONS below with its reason. The universe is compared
// against manifest data.universe (order-sensitive: cutler-RSI ties and the
// rank sort resolve by iteration order). Wiring literals index.ts does not
// export are locked against its SOURCE TEXT (the AGENTS.md rg-falsifier
// style), so this file fails if either side drifts.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  INCUMBENT_SLEEVE_IDS,
  LIVE_SLEEVE_IDS,
  LIVE_SLEEVE_MANIFESTS,
  MOMENTUM_CRYPTO_REGIME,
  MOMENTUM_CRYPTO_TIME_STOP,
  MOMENTUM_CRYPTO_VOL_TARGET,
  MOMENTUM_SLEEVE_SHARPE_GATE,
  effectiveRiskConfig,
  incumbentManifest,
  liveSleeveConfig,
  sleeveManagedBy,
  type IncumbentSleeveId,
  type LiveSleeveId,
} from "../src/config/liveSleeveConfigs";
import { MODEL_VERSIONS, currentModelVersion, currentModelManifests } from "../src/portfolio/modelVersions";
import { VALIDATED_PRESETS } from "../src/portfolios/validate";
import { validateCandidate, type CandidateConfig, type ExperimentManifest } from "./walk-forward";
import { MOMENTUM_USDC_DAILY_HORIZON, MOMENTUM_USDC_EXPOSURE_CONTROL, dailyHorizonMaxLookback, momentumCryptoPortfolioPlan, momentumUsdcPortfolioPlan } from "../src/index";
import { builtinPortfolio } from "../src/portfolios/builtin";
import { GROSS_CAP_HEADROOM } from "../src/config/grossCap";
import { DEFAULT_TSM_CONFIG } from "../src/strategies/momentum/TimeSeriesMomentum";

const ROOT = join(import.meta.dir, "..");

/** The manifest of what RUNS (LIVE_SLEEVE_MANIFESTS = the current version's). */
function loadManifest(sleeve: LiveSleeveId): ExperimentManifest {
  return JSON.parse(readFileSync(join(ROOT, LIVE_SLEEVE_MANIFESTS[sleeve]), "utf-8"));
}
/** The manifest the INCUMBENT derivation is locked against (equal to the
 *  above while the incumbent runs — both crypto sleeves today). */
function loadIncumbentManifest(sleeve: IncumbentSleeveId): ExperimentManifest {
  return JSON.parse(readFileSync(join(ROOT, incumbentManifest(sleeve)), "utf-8"));
}

// ── DECLARED live↔validated differences ──────────────────────────────────
// Candidate keys allowed to differ, each with the reason it is legitimate.
// Anything NOT in this list must be deep-equal between the live derivation
// and the manifest candidate. Do NOT add keys here to silence a mismatch —
// a new mismatch means live drifted from the validated config (or the
// manifest pointer is stale) and must be reported, not declared away.
const DECLARED_KEY_EXCEPTIONS: Record<IncumbentSleeveId, Record<string, string>> = {
  momentum_crypto: {
    name: "identity label only — no execution semantics",
    risk: "compared as the EFFECTIVE RiskGuardConfig below; live additionally sets equitySemantics (selects WHICH broker ledger the equity read uses — the sim broker hands equity to the engine directly, nothing to model)",
    maxGrossExposureMult:
      "live-only runtime BACKSTOP (1.725× = 0.375×4 × GROSS_CAP_HEADROOM since 2026-10-07): the bare 1.5× product bound on 0.24% of validated OOS entry decisions (max marked ratio 1.554, volTarget maxScale reaches 2.25× theoretical — G diagnostic, docs/reports/G-gross-cap.md); at the measured headroom activation is 0. Locked to product × headroom below.",
  },
  momentum_crypto_usdc: {
    name: "identity label only — no execution semantics",
    risk: "compared as the EFFECTIVE RiskGuardConfig below; live adds equitySemantics (see momentum_crypto)",
    maxGrossExposureMult:
      "live-only runtime BACKSTOP (1.15× = 0.20×5 × GROSS_CAP_HEADROOM since 2026-10-07): the bare 1.0× product blocked 8 prod entries the week of 2026-09-26 (4× LTC, 4× AVAX, 4/5 positions filled) and cost the authoritative chain −14.4pp CAGR / −0.174 Sharpe when imposed (27.4% of OOS entry decisions — G diagnostic, docs/reports/G-gross-cap.md); at the measured headroom activation is 0. Locked to product × headroom below.",
  },
};

function compareCandidateKeys(sleeve: IncumbentSleeveId, live: object, manifest: CandidateConfig) {
  const exceptions = DECLARED_KEY_EXCEPTIONS[sleeve];
  const keys = new Set([...Object.keys(live), ...Object.keys(manifest)]);
  for (const key of keys) {
    if (key in exceptions) continue;
    expect({ sleeve, key, value: (live as any)[key] })
      .toEqual({ sleeve, key, value: (manifest as any)[key] });
  }
}

describe("stock sleeves have NO incumbent derivation (owner 2026-11-07): the lock for what runs is the portfolio definition's hash", () => {
  test("liveSleeveConfig throws for both stock sleeves and names where the design lives", () => {
    for (const sleeve of ["momentum_stocks", "meanrev_stocks"] as const) {
      expect(sleeveManagedBy(sleeve)).toBe("portfolio");
      expect(() => liveSleeveConfig(sleeve)).toThrow(/portfolio engine and has no incumbent derivation since 2026-11-07/);
      expect(() => liveSleeveConfig(sleeve)).toThrow(/src\/portfolios\/builtin\.ts/);
    }
    expect([...INCUMBENT_SLEEVE_IDS]).toEqual(["momentum_crypto", "momentum_crypto_usdc"]);
    expect([...LIVE_SLEEVE_IDS].sort()).toEqual(["meanrev_stocks", "momentum_crypto", "momentum_crypto_usdc", "momentum_stocks"]);
  });
});

for (const sleeve of INCUMBENT_SLEEVE_IDS) {
  describe(`vivo=validado — ${sleeve} (incumbent derivation ↔ incumbent manifest${sleeveManagedBy(sleeve) === "portfolio" ? "; the sleeve RUNS on the portfolio engine, see below" : ""})`, () => {
    const m = loadIncumbentManifest(sleeve);
    const live = liveSleeveConfig(sleeve);

    test("manifestPath is the incumbent's; managedBy follows the version table", () => {
      expect(live.manifestPath).toBe(incumbentManifest(sleeve));
      expect(live.managedBy).toBe(currentModelVersion(sleeve)?.engine === "portfolio" ? "portfolio" : "incumbent");
      if (live.managedBy === "incumbent") expect(LIVE_SLEEVE_MANIFESTS[sleeve]).toBe(live.manifestPath);
      else expect(LIVE_SLEEVE_MANIFESTS[sleeve]).not.toBe(live.manifestPath);
    });

    test("manifest is a single-candidate pure chain", () => {
      expect(m.candidates.length).toBe(1);
    });

    test("every decision-affecting candidate key matches (or is a declared exception)", () => {
      compareCandidateKeys(sleeve, live.candidate, m.candidates[0]);
    });

    test("live candidate is a valid walk-forward candidate", () => {
      expect(() => validateCandidate(live.candidate as CandidateConfig)).not.toThrow();
    });

    test("universe equals manifest data.universe (exact order)", () => {
      expect(live.universe).toEqual(m.data.universe);
    });

    test("effective RiskGuard config equals the manifest candidate's", () => {
      expect(live.effectiveRisk).toEqual(effectiveRiskConfig(m.candidates[0].risk));
    });

    test("ledger: capital base and fixed-stop fallback match", () => {
      expect(live.initialEquity).toBe(m.ledger.initialEquity);
      expect(live.hardStopFallbackPct).toBeCloseTo(m.ledger.hardStopPct, 10);
    });
  });
}

// ── environmental manifest keys, asserted so silent drift is visible ─────
// These are NOT candidate keys: they describe the data/venue the sim ran
// on. Live reads a different plumbing by construction; the runtime parity
// monitor (scripts/parity-check.ts) exists precisely to check that the
// realized DECISIONS still agree. Locked here so a manifest repoint that
// changes the data contract fails loudly.
describe("declared environmental differences (data plumbing)", () => {
  test("stock manifests: alpaca_wide/1d daily bars; live reads Alpaca REST '1Day' (SIP, adjustment=all)", () => {
    for (const sleeve of ["momentum_stocks", "meanrev_stocks"] as const) {
      const m = loadManifest(sleeve);
      expect({ sleeve, source: m.data.source, timeframe: m.data.timeframe, barMinutes: m.data.barMinutes })
        .toEqual({ sleeve, source: "alpaca_wide", timeframe: "1d", barMinutes: 1440 });
      // Sim fills at the daily open; live fills ≥09:35 ET. Decisions (not
      // P&L) are the parity contract — see scripts/parity-check.ts.
    }
  });
  test("crypto manifest: binance_futures/1h mainnet history; live signals mainnet klines, fills Binance TESTNET", () => {
    const m = loadManifest("momentum_crypto");
    expect({ source: m.data.source, timeframe: m.data.timeframe, funding: m.data.funding })
      .toEqual({ source: "binance_futures", timeframe: "1h", funding: true });
    // Testnet fills/equity are a declared evidence limit (OPEN.md) — no
    // sim knob models them; leverage 2 is broker margin, not a strategy key.
    expect(m.ledger.leverage).toBe(2);
  });
  test("usdc manifest: DAILY bars, USDT-perp PROXY series for the 13 USDC bases (declared: no pre-2023 USDC history, negligible basis); NOT gate-certified — authoritative under the owner rule", () => {
    const m = loadManifest("momentum_crypto_usdc");
    expect({ source: m.data.source, timeframe: m.data.timeframe, barMinutes: m.data.barMinutes, funding: m.data.funding })
      .toEqual({ source: "binance_futures", timeframe: "1d", barMinutes: 1440, funding: true });
    expect(m.ledger.leverage).toBe(2);
    // The live universe is BASE/USDC and live signals read the venue's own
    // CLOSED 1d klines (all 13 USDC contracts carry ≥300 dailies, verified
    // 2026-09-26); the manifest proxies each base with its USDT perp
    // ("BASE/USD") because only the USDT series covers 2021+. The
    // derivation maps one onto the other — locked by the universe test
    // above; the proxy itself is declared here.
    expect(m.data.universe.every(s => s.endsWith("/USD"))).toBe(true);
    expect(m.data.universe.length).toBe(13);
    // Honesty lock: the manifest must keep declaring the measured costs the
    // chain was run at (P2-costs: ~17 bps slippage + 3 bps commission/side).
    expect(m.costs.base).toEqual({ slippageBps: 17, commissionBps: 3 });
  });
});

// ── portfolio-engine sleeves (RW2): one source of truth for "what runs" ──
describe("portfolio-engine sleeves — the version table names manifest, candidate and artifact; every consumer reads it", () => {
  test("LIVE_SLEEVE_MANIFESTS and VALIDATED_PRESETS ARE the current versions' manifests, for every live sleeve", () => {
    const current = currentModelManifests();
    for (const id of LIVE_SLEEVE_IDS) {
      expect(LIVE_SLEEVE_MANIFESTS[id]).toBe(current[id]);
      expect(VALIDATED_PRESETS[id].manifestPath).toBe(current[id]);
    }
  });
  test("RW11 stock wiring levers only momentum_stocks (vt45 + 2x ETFs); meanrev keeps RW7", () => {
    expect(currentModelVersion("momentum_stocks")).toMatchObject({
      id: "momentum_stocks@pe-vt45-g250-sma200-fv5-mh5-stagger-sh50-etf2x", engine: "portfolio", candidate: "e1-vt45-etf",
      manifest: "experiments/rw11-e1-vt45-etf-v1.json",
      artifact: { dir: "data/backtests/71124f620a0a5d0c666e341f9368982d4335286d7a79a5bf65ddb06f9e8c8f77", shiftDays: 0 },
    });
    expect(currentModelVersion("meanrev_stocks")).toMatchObject({
      id: "meanrev_stocks@pe-vt15-mh5-stagger", engine: "portfolio", candidate: "vt15-maxhold5-stagger",
      manifest: "experiments/rw7-e2-meanrev-maxhold5-stagger-v1.json",
      artifact: { dir: "data/backtests/2325210c8c7ad56fbbec9d833f2ae9ef641ed85a25d9af357eb693d43dfbb50f", shiftDays: 0 },
    });
    expect(sleeveManagedBy("momentum_stocks")).toBe("portfolio");
    expect(sleeveManagedBy("meanrev_stocks")).toBe("portfolio");
    expect(sleeveManagedBy("momentum_crypto")).toBe("incumbent");
    expect(sleeveManagedBy("momentum_crypto_usdc")).toBe("incumbent");
  });
  test("momentum_crypto_usdc bo13: only daily Turtle shorts change vs RW7; replay keeps shiftDays −1 and the exposure control", () => {
    const v = currentModelVersion("momentum_crypto_usdc")!;
    expect(v).toMatchObject({
      id: "momentum_crypto_usdc@daily-d13s5-xc-dd-mh120-sizeonly-bo13",
      manifest: "experiments/momentum-crypto-usdc-daily-s5-rw8-sizeonly-bo13-pure-v1.json",
      artifact: { dir: "data/backtests/574309447f608d2786889e9d98f41de15f3aac3262b4ca8784b3d3bcee9cb0c4", shiftDays: -1 },
    });
    expect(v.engine).toBeUndefined();
    expect(LIVE_SLEEVE_MANIFESTS.momentum_crypto_usdc).toBe(v.manifest!);
    expect(incumbentManifest("momentum_crypto_usdc")).toBe(v.manifest!);
    const m = loadManifest("momentum_crypto_usdc");
    expect(m.data.timeframe).toBe("1d");
    expect((m as any).asOf).toBe("2026-09-26T00:00:00Z"); // the control's asOf — same folds, same OOS days
    expect(m.candidates.length).toBe(1);
    const cand: any = m.candidates[0];
    const knob = { drawdown: { startPct: 0.1, endPct: 0.4 }, minScale: 0.25, band: 0.1, minOrderUsd: 100 };
    expect(cand.exposureControl).toEqual(knob);
    expect(cand.exposureControl.volCap).toBeUndefined(); // drawdown axis only (the vol and both axes failed R3)
    expect(cand.risk).toEqual({ peakHalfLifeDays: 30, mode: "sizeOnly" });
    expect(cand.regime).toBeUndefined(); // defaults retained, unlike hourly crypto
    expect(cand.sharpeGate).toEqual(MOMENTUM_SLEEVE_SHARPE_GATE);
    expect(cand.allowSameTickReentry).toBeUndefined();
    expect(liveSleeveConfig("momentum_crypto_usdc").candidate.exposureControl).toEqual(cand.exposureControl);
    expect(MOMENTUM_USDC_EXPOSURE_CONTROL).toEqual(knob);
    expect(cand.timeStop).toEqual({ maxHoldHours: 120 });
    // The previous candidate is byte-identical apart from the short leg and label.
    const list = MODEL_VERSIONS.momentum_crypto_usdc;
    expect(list[list.length - 2].id).toBe("momentum_crypto_usdc@daily-d13s5-xc-dd-mh120-sizeonly");
    expect(list[list.length - 2].manifest).toBe("experiments/momentum-crypto-usdc-daily-s5-rw7-sizeonly-pure-v1.json");
    const controlManifest: any = JSON.parse(readFileSync(join(ROOT, list[list.length - 2].manifest!), "utf-8"));
    const control: any = controlManifest.candidates[0];
    expect(control.breakoutShort).toBeUndefined();
    expect(cand.breakoutShort).toEqual({ symbols: m.data.universe, entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 });
    expect(liveSleeveConfig("momentum_crypto_usdc").candidate.breakoutShort).toEqual(cand.breakoutShort);
    const runtimeBreakout = { ...cand.breakoutShort, symbols: m.data.universe.map(s => s.replace("/USD", "/USDC")) };
    expect(momentumUsdcPortfolioPlan().engineConfig.breakoutShort).toEqual(runtimeBreakout);
    expect((builtinPortfolio("momentum_crypto_usdc").params as any).breakoutShort).toEqual(runtimeBreakout);
    const { breakoutShort: _b, name: _n, ...rest } = cand;
    const { name: _n2, ...controlRest } = control;
    expect(rest).toEqual(controlRest);
    expect(controlManifest.asOf).toBe((m as any).asOf);
    expect(controlManifest.data).toEqual(m.data);
    expect(controlManifest.costs).toEqual(m.costs);
    // Every consumer carries the same knob: the plan's engine config and the builtin registry row.
    expect(momentumUsdcPortfolioPlan().engineConfig.exposureControl).toEqual(knob);
    expect((builtinPortfolio("momentum_crypto_usdc").params as any).exposureControl).toEqual(knob);
  });

  test("momentum_crypto RW10: only Turtle entry/exit channels change 55/20 → 20/10 vs RW8; shiftDays 0", () => {
    const v = currentModelVersion("momentum_crypto")!;
    expect(v).toMatchObject({
      id: "momentum_crypto@vt35-corroff-mh120-nobrakes-bo8s1",
      manifest: "experiments/momentum-crypto-rw10-turtle-s1-short-pure-v1.json",
      artifact: { dir: "data/backtests/4aca18035a259fac4bfbba41696c6ee19d750dab1cb8fd3d084e47193e4c0f33", shiftDays: 0 },
    });
    expect(v.engine).toBeUndefined(); // incumbent engine: its config describes what trades
    expect(LIVE_SLEEVE_MANIFESTS.momentum_crypto).toBe(v.manifest!);
    expect(incumbentManifest("momentum_crypto")).toBe(v.manifest!);
    const m = loadManifest("momentum_crypto");
    expect(m.candidates.length).toBe(1);
    const cand: any = m.candidates[0];
    expect(cand.regime).toBe("off");
    expect(liveSleeveConfig("momentum_crypto").candidate.regime).toEqual(cand.regime);
    expect(MOMENTUM_CRYPTO_REGIME).toEqual({ enabled: false });
    expect(cand.risk).toEqual({ peakHalfLifeDays: 30, mode: "sizeOnly" });
    expect(cand.sharpeGate).toBeUndefined();
    expect(cand.allowSameTickReentry).toBe(true);
    expect(cand.timeStop).toEqual({ maxHoldHours: 120 });
    // The rollback target (the control the artifact was measured against) is the previous version's manifest.
    const list = MODEL_VERSIONS.momentum_crypto;
    expect(list[list.length - 2].id).toBe("momentum_crypto@vt35-corroff-mh120-nobrakes-bo8");
    expect(list[list.length - 2].manifest).toBe("experiments/momentum-crypto-rw8-breakout8-pure-v1.json");
    const controlManifest: any = JSON.parse(readFileSync(join(ROOT, list[list.length - 2].manifest!), "utf-8"));
    const control = controlManifest.candidates[0];
    expect(cand.breakoutShort).toEqual({ symbols: m.data.universe, entryDays: 20, exitDays: 10, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 });
    expect(control.breakoutShort).toEqual({ ...cand.breakoutShort, entryDays: 55, exitDays: 20 });
    // Every other decision-affecting key is still the control's.
    const { breakoutShort, name: _name, ...rest } = cand;
    const { breakoutShort: _controlBreakout, name: _controlName, ...controlRest } = control;
    expect(rest).toEqual(controlRest);
    expect(controlManifest.asOf).toBe((m as any).asOf);
    expect(controlManifest.data).toEqual(m.data);
    expect(controlManifest.costs).toEqual(m.costs);
    expect(momentumCryptoPortfolioPlan().engineConfig.breakoutShort).toEqual(breakoutShort);
    expect((builtinPortfolio("momentum_crypto").params as any).breakoutShort).toEqual(breakoutShort);
    expect(liveSleeveConfig("momentum_crypto").candidate.breakoutShort).toEqual(breakoutShort);
  });
  for (const sleeve of LIVE_SLEEVE_IDS.filter(s => sleeveManagedBy(s) === "portfolio")) {
    test(`${sleeve}: the named manifest holds the named candidate with a volManaged portfolio block on the sleeve's venue, same universe as the incumbent (universes stay disjoint)`, () => {
      const v = currentModelVersion(sleeve)!;
      const m: any = loadManifest(sleeve);
      const cand = m.candidates.find((c: any) => c.name === v.candidate);
      expect(cand).toBeTruthy();
      expect(m.candidates.length).toBe(1);
      expect(cand.portfolio?.strategy?.kind).toBe("volManaged");
      expect(cand.portfolio?.venue?.venue).toBe("alpaca");
      expect(cand.portfolio.strategy.annualization).toBe(252);
      expect(cand.portfolio.strategy.maxHoldSessions).toBe(5);
      expect(cand.portfolio.strategy.maxHoldStagger).toBe(true);
      const previous: any = JSON.parse(readFileSync(join(ROOT, MODEL_VERSIONS[sleeve].at(-2)!.manifest!), "utf-8")).candidates[0];
      if (sleeve === "momentum_stocks") {
        // RW11 vs the RW8 control (§22): ONLY the vol target, the per-asset cap and the four 2x ETF
        // substitutions change; the SPY switch, the SH hedge, the gross cap and the venue rules are the control's.
        const { universe, portfolioVolTarget, perAssetCap, ...rest } = cand.portfolio.strategy;
        const { universe: prevUniverse, portfolioVolTarget: prevVt, perAssetCap: prevCap, ...prevRest } = previous.portfolio.strategy;
        expect({ ...cand.portfolio, strategy: rest }).toEqual({ ...previous.portfolio, strategy: prevRest });
        expect([prevVt, prevCap]).toEqual([0.3, 0.25]);
        expect([portfolioVolTarget, perAssetCap]).toEqual([0.45, 0.375]);
        expect(cand.portfolio.strategy.maxGross).toBe(2.5);
        expect(cand.portfolio.strategy.regimeOverlay.hedge).toEqual({ symbol: "SH", fraction: 0.5 });
        expect(cand.portfolio.strategy.regimeOverlay.signals.map((s: any) => s.symbol)).toEqual(["SPY"]);
        const swap: Record<string, string> = { SPY: "SSO", QQQ: "QLD", SMH: "USD", GLD: "UGL" };
        expect(universe).toEqual(prevUniverse.map((s: string) => swap[s] ?? s));
        expect(universe).not.toContain("SPY"); // SPY is the switch's signal only: data, not a core asset
        for (const s of ["SH", "SPY", "SSO", "QLD", "USD", "UGL"]) expect(m.data.universe).toContain(s);
      } else {
        const { maxHoldStagger: _stagger, ...strategy } = cand.portfolio.strategy;
        expect({ ...cand.portfolio, strategy }).toEqual(previous.portfolio);
        expect(cand.portfolio.strategy.regimeOverlay?.hedge).toBeUndefined();
      }
      expect(cand.portfolio.strategy.regimeOverlay?.defensive).toBeUndefined();
      // The built-in fallback definition IS this candidate (src/portfolios/builtinPortfolioEngine.test.ts
      // locks the byte-equality and the hash); here only the universe/capital identity with the sleeve.
      const builtin = builtinPortfolio(`pe_${sleeve}`).params as any;
      expect([...cand.portfolio.strategy.universe].sort()).toEqual([...builtin.strategy.universe].sort());
      // Same data plumbing as the retired incumbent: the band and the parity proposal compare like with like.
      expect({ source: m.data.source, timeframe: m.data.timeframe, barMinutes: m.data.barMinutes })
        .toEqual({ source: "alpaca_wide", timeframe: "1d", barMinutes: 1440 });
      expect(m.ledger.initialEquity).toBe(builtinPortfolio(`pe_${sleeve}`).capital);
    });
  }
  test("every version that names an artifact also names a manifest, and shiftDays is 0 unless it is a daily MOMENTUM replay (session labelled by its END)", () => {
    for (const [sleeve, list] of Object.entries(MODEL_VERSIONS)) {
      for (const v of list) {
        if (v.artifact) expect({ sleeve, id: v.id, manifest: typeof v.manifest }).toEqual({ sleeve, id: v.id, manifest: "string" });
        if (v.artifact && v.engine === "portfolio") expect(v.artifact.shiftDays).toBe(0);
      }
    }
  });
});

// ── source-text locks on wiring literals index.ts does not export ────────
// Same falsifier style AGENTS.md documents. If the wiring literal changes,
// the module constant must change with it (and vice versa).
describe("index.ts wiring literals ↔ module constants", () => {
  const indexSrc = readFileSync(join(ROOT, "src", "index.ts"), "utf-8");
  const count = (needle: string) => indexSrc.split(needle).length - 1;

  test("RW6 timeStop 120h is wired on BOTH live crypto plans, derived into both replay candidates", () => {
    expect(MOMENTUM_CRYPTO_TIME_STOP).toEqual({ maxHoldHours: 120 });
    expect(count(`timeStop: { maxHoldHours: ${MOMENTUM_CRYPTO_TIME_STOP.maxHoldHours} }`)).toBe(2);
    for (const sleeve of ["momentum_crypto", "momentum_crypto_usdc"] as const) {
      expect(liveSleeveConfig(sleeve).candidate.timeStop).toEqual(MOMENTUM_CRYPTO_TIME_STOP);
      expect((builtinPortfolio(sleeve).params as any).timeStop).toEqual(MOMENTUM_CRYPTO_TIME_STOP);
    }
  });

  test("slotHysteresis: true — exactly once (the usdc daily kernel; refuted on HOURLY crypto; the stocks override left with the Alpaca incumbent 2026-11-07)", () => {
    // momentum_crypto_usdc's daily kernel (part of the validated candidate,
    // artifact 752767ae…). The hourly momentum_crypto sleeve must NOT wire it
    // (refuted 2026-09-10).
    expect(count("slotHysteresis: true")).toBe(1);
    expect(liveSleeveConfig("momentum_crypto_usdc").candidate.slotHysteresis).toBe(true);
    expect(liveSleeveConfig("momentum_crypto").candidate.slotHysteresis).toBeUndefined();
  });

  test("crypto volTarget literal matches MOMENTUM_CRYPTO_VOL_TARGET — exactly once", () => {
    const v = MOMENTUM_CRYPTO_VOL_TARGET;
    const literal = `volTarget: { annualizedPct: ${v.annualizedPct}, lookbackBars: ${v.lookbackBars}, minScale: ${v.minScale}, maxScale: ${v.maxScale} }`;
    expect(count(literal)).toBe(1);
    expect(count("volTarget: {")).toBe(1);
  });

  test("exposureControl wired exactly once in index.ts (the USDC plan, from MOMENTUM_USDC_EXPOSURE_CONTROL); momentum_crypto's three RW4a candidates failed and must NOT carry it", () => {
    expect(count("exposureControl: {")).toBe(1);
    expect(count("exposureControl: { ...MOMENTUM_USDC_EXPOSURE_CONTROL")).toBe(1);
    expect(liveSleeveConfig("momentum_crypto").candidate.exposureControl).toBeUndefined();
  });

  test("RW7 regime disabled literal matches MOMENTUM_CRYPTO_REGIME — hourly crypto only", () => {
    const r = MOMENTUM_CRYPTO_REGIME;
    expect(r).toEqual({ enabled: false });
    expect(count(`regime: { barMinutes: 60, enabled: ${r.enabled} },`)).toBe(1);
    expect(count("allowSameTickReentry: true")).toBe(1);
    expect(count('mode: "sizeOnly"')).toBe(2);
  });

  test("sharpeGate literal matches MOMENTUM_SLEEVE_SHARPE_GATE on the USDC daily kernel only (hourly crypto omits it; the stock plans left with the incumbents)", () => {
    const g = MOMENTUM_SLEEVE_SHARPE_GATE;
    const literal = `sharpeGate: { lookbackDays: ${g.lookbackDays}, minSharpe: ${g.minSharpe} }`;
    expect(count(literal)).toBe(1); // USDC
    expect(count("sharpeGate: {")).toBe(count(literal)); // no sleeve wires a DIFFERENT gate
  });

  test("usdc daily trail/hard stop both spread MOMENTUM_USDC_DAILY_VOL_STOP; no stock engine literal survives in index.ts", () => {
    expect(count("{ ...MOMENTUM_USDC_DAILY_VOL_STOP }")).toBe(2); // tsmTrail + volStop
    expect(count("MOMENTUM_STOCKS_DAILY_VOL_STOP")).toBe(0);
    expect(count("MEANREV_STOCKS")).toBe(0);
    expect(count("AlpacaMomentumAdapter")).toBe(0);
  });
});

// ── structural sanity the derivations rely on ────────────────────────────
describe("derivation invariants", () => {
  test("backstops equal slot×count products × GROSS_CAP_HEADROOM (the bare product DID bind on validated books — G diagnostic, docs/reports/G-gross-cap.md, applied 2026-10-07)", () => {
    const crypto = liveSleeveConfig("momentum_crypto").candidate;
    expect(crypto.maxGrossExposureMult).toBeCloseTo(crypto.notionalPctPerSlot! * crypto.maxLongs! * GROSS_CAP_HEADROOM, 10);
    const usdc = liveSleeveConfig("momentum_crypto_usdc").candidate;
    expect(usdc.maxGrossExposureMult).toBeCloseTo(usdc.notionalPctPerSlot! * usdc.maxLongs! * GROSS_CAP_HEADROOM, 10);
  });

  test("live daily historyBars formula equals the replay's for the wired horizon (USDC daily kernel)", () => {
    const h = MOMENTUM_USDC_DAILY_HORIZON;
    const liveBars = Math.max(dailyHorizonMaxLookback(h), h.maLengthDays) + 11; // index.ts usdc historyBars
    const horizonDays = Math.max(dailyHorizonMaxLookback(h), h.maLengthDays) + 1;
    const replayBars = Math.ceil((horizonDays * 24 * 60) / 1440) + 10; // runWithConfig
    expect(liveBars).toBe(replayBars);
  });

  test("crypto candidate rides the engine-default horizon (14/30) like the manifest", () => {
    const c = liveSleeveConfig("momentum_crypto").candidate;
    expect(c.lookbackDays).toBeUndefined();
    expect(c.maLengthDays).toBeUndefined();
    expect(DEFAULT_TSM_CONFIG.lookbackDays).toBe(14);
    expect(DEFAULT_TSM_CONFIG.maLengthDays).toBe(30);
  });

  test("usdc candidate is the daily blend3 kernel and carries NO volTarget (vt35/vtcap lost the redesign rounds)", () => {
    const c = liveSleeveConfig("momentum_crypto_usdc").candidate;
    const m = loadManifest("momentum_crypto_usdc");
    expect(c.lookbackDays).toBeUndefined();
    expect(c.lookbackDaysList).toEqual([63, 126, 252]);
    expect(c.maLengthDays).toBe(200);
    expect(c.volTarget).toBeUndefined();
    // Trail + hard stop are the SAME k8 spec, and equal the manifest's.
    expect({ mode: "volScaled", ...c.tsmTrail }).toEqual(c.hardStop as any);
    expect(c.hardStop).toEqual(m.candidates[0].hardStop);
  });
});
