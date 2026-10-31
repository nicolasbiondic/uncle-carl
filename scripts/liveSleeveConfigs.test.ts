// ═══════════════════════════════════════════════════════════════════════
// The "vivo = validado" lock (W4 parity, 2026-09-25).
//
// For each live sleeve, compares the CandidateConfig DERIVED from the same
// constants src/index.ts wires (src/config/liveSleeveConfigs.ts) against
// the candidate of its AUTHORITATIVE experiment manifest — the artifact
// whose pure OOS chain justified this exact config:
//
//   momentum_stocks ↔ experiments/momentum-stocks-daily-blend3-pure-v1.json
//   meanrev_stocks  ↔ experiments/meanrev-breadth7-pure-v1.json
//   momentum_crypto ↔ experiments/momentum-crypto-rw8-breakout8-pure-v1.json
//   momentum_crypto_usdc ↔ experiments/momentum-crypto-usdc-daily-s5-rw7-sizeonly-pure-v1.json
//     (RW7: no risk pauses; hourly removes regime/Sharpe/cooldown, USDC keeps them)
//
// RW2 (2026-10-23): momentum_stocks and meanrev_stocks run on the PORTFOLIO
// ENGINE (MODEL_VERSIONS current version `engine: "portfolio"`). Their
// LIVE_SLEEVE_MANIFESTS entry is the RW2 manifest whose candidate the registry
// definition is hash-locked to at boot (cutover.ts); the incumbent derivation
// below is still locked against the INCUMBENT manifest (what a rollback
// returns to), and the "what runs" lock for those sleeves is the manifest +
// candidate + artifact named by the version (see "portfolio-engine sleeves").
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
  LIVE_SLEEVE_IDS,
  LIVE_SLEEVE_MANIFESTS,
  MEANREV_STOCKS_VOL_STOP,
  MOMENTUM_CRYPTO_REGIME,
  MOMENTUM_CRYPTO_TIME_STOP,
  MOMENTUM_CRYPTO_VOL_TARGET,
  MOMENTUM_SLEEVE_SHARPE_GATE,
  MOMENTUM_STOCKS_SLOT_HYSTERESIS,
  effectiveRiskConfig,
  incumbentManifest,
  liveSleeveConfig,
  sleeveManagedBy,
  type LiveSleeveId,
} from "../src/config/liveSleeveConfigs";
import { MODEL_VERSIONS, currentModelVersion, currentModelManifests } from "../src/portfolio/modelVersions";
import { VALIDATED_PRESETS } from "../src/portfolios/validate";
import { validateCandidate, type CandidateConfig, type ExperimentManifest } from "./walk-forward";
import { DEFAULT_MEANREV_CONFIG } from "../src/strategies/meanrev/MeanRevEngine";
import { MOMENTUM_STOCKS_DAILY_HORIZON, MOMENTUM_STOCKS_DAILY_VOL_STOP, MOMENTUM_USDC_EXPOSURE_CONTROL, dailyHorizonMaxLookback, momentumCryptoPortfolioPlan, momentumUsdcPortfolioPlan } from "../src/index";
import { builtinPortfolio } from "../src/portfolios/builtin";
import { GROSS_CAP_HEADROOM } from "../src/config/grossCap";
import { DEFAULT_TSM_CONFIG } from "../src/strategies/momentum/TimeSeriesMomentum";

const ROOT = join(import.meta.dir, "..");

/** The manifest of what RUNS (LIVE_SLEEVE_MANIFESTS = the current version's). */
function loadManifest(sleeve: LiveSleeveId): ExperimentManifest {
  return JSON.parse(readFileSync(join(ROOT, LIVE_SLEEVE_MANIFESTS[sleeve]), "utf-8"));
}
/** The manifest the INCUMBENT derivation is locked against (equal to the
 *  above while the incumbent runs). */
function loadIncumbentManifest(sleeve: LiveSleeveId): ExperimentManifest {
  return JSON.parse(readFileSync(join(ROOT, incumbentManifest(sleeve)), "utf-8"));
}

// ── DECLARED live↔validated differences ──────────────────────────────────
// Candidate keys allowed to differ, each with the reason it is legitimate.
// Anything NOT in this list must be deep-equal between the live derivation
// and the manifest candidate. Do NOT add keys here to silence a mismatch —
// a new mismatch means live drifted from the validated config (or the
// manifest pointer is stale) and must be reported, not declared away.
const DECLARED_KEY_EXCEPTIONS: Record<LiveSleeveId, Record<string, string>> = {
  momentum_stocks: {
    name: "identity label only — no execution semantics",
    risk: "compared as the EFFECTIVE RiskGuardConfig below; live additionally sets equitySemantics (selects WHICH broker ledger the equity read uses — the sim broker hands equity to the engine directly, nothing to model)",
    maxGrossExposureMult:
      "live-only runtime BACKSTOP (1.15× = product × GROSS_CAP_HEADROOM since 2026-10-07): the bare 1.0× product DID bind on the validated book marked to market (31% of OOS entry decisions, −1.5pp CAGR — G diagnostic, docs/reports/G-gross-cap.md); at the measured headroom activation is 0 on the validated chain while legacy-sized books (the 2026-09-25 META/AAPL cutover class, ~2× product) still trip it. Locked to product × headroom below.",
  },
  meanrev_stocks: {
    name: "identity label only — no execution semantics",
    // (meanrev candidates carry no risk/maxGross keys in the manifest and
    // the live candidate adds none: the engine-level backstop is 0.966× =
    // 0.84 product × GROSS_CAP_HEADROOM since 2026-10-07 — see the dedicated
    // backstop assertion below and docs/reports/G-gross-cap.md.)
  },
  momentum_crypto: {
    name: "identity label only — no execution semantics",
    risk: "compared as the EFFECTIVE RiskGuardConfig below; live adds equitySemantics (see momentum_stocks)",
    maxGrossExposureMult:
      "live-only runtime BACKSTOP (1.725× = 0.375×4 × GROSS_CAP_HEADROOM since 2026-10-07): the bare 1.5× product bound on 0.24% of validated OOS entry decisions (max marked ratio 1.554, volTarget maxScale reaches 2.25× theoretical — G diagnostic, docs/reports/G-gross-cap.md); at the measured headroom activation is 0. Locked to product × headroom below.",
  },
  momentum_crypto_usdc: {
    name: "identity label only — no execution semantics",
    risk: "compared as the EFFECTIVE RiskGuardConfig below; live adds equitySemantics (see momentum_stocks)",
    maxGrossExposureMult:
      "live-only runtime BACKSTOP (1.15× = 0.20×5 × GROSS_CAP_HEADROOM since 2026-10-07): the bare 1.0× product blocked 8 prod entries the week of 2026-09-26 (4× LTC, 4× AVAX, 4/5 positions filled) and cost the authoritative chain −14.4pp CAGR / −0.174 Sharpe when imposed (27.4% of OOS entry decisions — G diagnostic, docs/reports/G-gross-cap.md); at the measured headroom activation is 0. Locked to product × headroom below.",
  },
};

function compareCandidateKeys(sleeve: LiveSleeveId, live: object, manifest: CandidateConfig) {
  const exceptions = DECLARED_KEY_EXCEPTIONS[sleeve];
  const keys = new Set([...Object.keys(live), ...Object.keys(manifest)]);
  for (const key of keys) {
    if (key in exceptions) continue;
    expect({ sleeve, key, value: (live as any)[key] })
      .toEqual({ sleeve, key, value: (manifest as any)[key] });
  }
}

for (const sleeve of Object.keys(LIVE_SLEEVE_MANIFESTS) as LiveSleeveId[]) {
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
  test("incumbent stock manifests' ledger.leverage: 2 (momentum, Reg-T headroom the 1.0× gross never uses) / 1 (meanrev)", () => {
    expect(loadIncumbentManifest("momentum_stocks").ledger.leverage).toBe(2);
    expect(loadIncumbentManifest("meanrev_stocks").ledger.leverage).toBe(1);
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
  test("RW8 stock wiring adds SH only to momentum_stocks; meanrev keeps RW7", () => {
    expect(currentModelVersion("momentum_stocks")).toMatchObject({
      id: "momentum_stocks@pe-vt30-g250-sma200-fv5-mh5-stagger-sh50", engine: "portfolio", candidate: "e1-lev-vt30-g250-maxhold5-stagger-sh50",
      manifest: "experiments/rw8-e1-lev-vt30-g250-maxhold5-stagger-sh50-v1.json",
      artifact: { dir: "data/backtests/0bb06b9d548647410edacd52f86c9f11ff66307bd11f6e734e379f8a7492d5da", shiftDays: 0 },
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
  test("momentum_crypto_usdc RW7: sizeOnly is the ONLY change vs RW6; daily replay keeps shiftDays −1 and the exposure control", () => {
    const v = currentModelVersion("momentum_crypto_usdc")!;
    expect(v).toMatchObject({
      id: "momentum_crypto_usdc@daily-d13s5-xc-dd-mh120-sizeonly",
      manifest: "experiments/momentum-crypto-usdc-daily-s5-rw7-sizeonly-pure-v1.json",
      artifact: { dir: "data/backtests/68181bd662a9462ad79e3802076ad9dd25d6ad3023b363c074255c090c1fa644", shiftDays: -1 },
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
    // The previous candidate is byte-identical apart from risk.mode and its label.
    const list = MODEL_VERSIONS.momentum_crypto_usdc;
    expect(list[list.length - 2].id).toBe("momentum_crypto_usdc@daily-d13s5-xc-dd-mh120");
    expect(list[list.length - 2].manifest).toBe("experiments/momentum-crypto-usdc-daily-s5-rw6-maxhold5-pure-v1.json");
    const controlManifest: any = JSON.parse(readFileSync(join(ROOT, list[list.length - 2].manifest!), "utf-8"));
    const control: any = controlManifest.candidates[0];
    expect(control.risk).toEqual({ peakHalfLifeDays: 30 });
    const { risk: _r, name: _n, ...rest } = cand;
    const { risk: _r2, name: _n2, ...controlRest } = control;
    expect(rest).toEqual(controlRest);
    expect(controlManifest.asOf).toBe((m as any).asOf);
    expect(controlManifest.data).toEqual(m.data);
    expect(controlManifest.costs).toEqual(m.costs);
    // Every consumer carries the same knob: the plan's engine config and the builtin registry row.
    expect(momentumUsdcPortfolioPlan().engineConfig.exposureControl).toEqual(knob);
    expect((builtinPortfolio("momentum_crypto_usdc").params as any).exposureControl).toEqual(knob);
  });

  test("momentum_crypto RW8: only eight-coin Turtle shorts change vs RW7; shiftDays 0", () => {
    const v = currentModelVersion("momentum_crypto")!;
    expect(v).toMatchObject({
      id: "momentum_crypto@vt35-corroff-mh120-nobrakes-bo8",
      manifest: "experiments/momentum-crypto-rw8-breakout8-pure-v1.json",
      artifact: { dir: "data/backtests/b37681ff8900d69104a000928d28435b6d637c4401dacf4f444528a4b3a39230", shiftDays: 0 },
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
    expect(list[list.length - 2].id).toBe("momentum_crypto@vt35-corroff-mh120-nobrakes");
    expect(list[list.length - 2].manifest).toBe("experiments/momentum-crypto-rw7-nobrakes-pure-v1.json");
    const controlManifest: any = JSON.parse(readFileSync(join(ROOT, list[list.length - 2].manifest!), "utf-8"));
    const control = controlManifest.candidates[0];
    expect(cand.breakoutShort).toEqual({ symbols: m.data.universe, entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 });
    expect(control.breakoutShort).toBeUndefined();
    // Every other decision-affecting key is still the control's.
    const { breakoutShort, ...rest } = cand;
    expect(rest).toEqual(control);
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
        const { hedge, ...regimeOverlay } = cand.portfolio.strategy.regimeOverlay;
        expect(hedge).toEqual({ symbol: "SH", fraction: 0.5 });
        expect(cand.portfolio.strategy.perAssetCap).toBe(0.25);
        expect({ ...cand.portfolio, strategy: { ...cand.portfolio.strategy, regimeOverlay } }).toEqual(previous.portfolio);
        expect(m.data.universe).toContain("SH");
      } else {
        const { maxHoldStagger: _stagger, ...strategy } = cand.portfolio.strategy;
        expect({ ...cand.portfolio, strategy }).toEqual(previous.portfolio);
        expect(cand.portfolio.strategy.regimeOverlay?.hedge).toBeUndefined();
      }
      expect(cand.portfolio.strategy.regimeOverlay?.defensive).toBeUndefined();
      expect([...cand.portfolio.strategy.universe].sort()).toEqual([...liveSleeveConfig(sleeve).universe].sort());
      // Same data plumbing as the incumbent: the band and the parity proposal compare like with like.
      expect({ source: m.data.source, timeframe: m.data.timeframe, barMinutes: m.data.barMinutes })
        .toEqual({ source: "alpaca_wide", timeframe: "1d", barMinutes: 1440 });
      expect(m.ledger.initialEquity).toBe(liveSleeveConfig(sleeve).initialEquity);
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

  test("slotHysteresis: true — exactly twice (stocks + usdc daily kernel; refuted on HOURLY crypto)", () => {
    expect(MOMENTUM_STOCKS_SLOT_HYSTERESIS).toBe(true);
    // stocks (owner override 2026-09-10) + momentum_crypto_usdc's daily
    // kernel (part of the validated candidate, artifact 752767ae…). The
    // hourly momentum_crypto sleeve must NOT wire it (refuted 2026-09-10).
    expect(count("slotHysteresis: true")).toBe(2);
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
    expect(liveSleeveConfig("momentum_stocks").candidate.exposureControl).toBeUndefined();
    expect(liveSleeveConfig("meanrev_stocks").candidate.exposureControl).toBeUndefined();
  });

  test("RW7 regime disabled literal matches MOMENTUM_CRYPTO_REGIME — hourly crypto only", () => {
    const r = MOMENTUM_CRYPTO_REGIME;
    expect(r).toEqual({ enabled: false });
    expect(count(`regime: { barMinutes: 60, enabled: ${r.enabled} },`)).toBe(1);
    expect(count("allowSameTickReentry: true")).toBe(1);
    expect(count('mode: "sizeOnly"')).toBe(2);
  });

  test("meanrev volStop literal matches MEANREV_STOCKS_VOL_STOP — exactly once", () => {
    const s = MEANREV_STOCKS_VOL_STOP;
    const literal = `volStop: { kSigma: ${s.kSigma}, lookbackBars: ${s.lookbackBars}, minPct: ${s.minPct}, maxPct: ${s.maxPct} }`;
    expect(count(literal)).toBe(1);
  });

  test("sharpeGate literal matches MOMENTUM_SLEEVE_SHARPE_GATE on all but hourly crypto", () => {
    const g = MOMENTUM_SLEEVE_SHARPE_GATE;
    const literal = `sharpeGate: { lookbackDays: ${g.lookbackDays}, minSharpe: ${g.minSharpe} }`;
    expect(count(literal)).toBe(3); // stocks + USDC + flag-off COIN-M
    expect(count("sharpeGate: {")).toBe(count(literal)); // no sleeve wires a DIFFERENT gate
  });

  test("stocks daily trail/hard stop both spread MOMENTUM_STOCKS_DAILY_VOL_STOP", () => {
    expect(count("{ ...MOMENTUM_STOCKS_DAILY_VOL_STOP }")).toBe(2); // tsmTrail + volStop
  });
});

// ── structural sanity the derivations rely on ────────────────────────────
describe("derivation invariants", () => {
  test("backstops equal slot×count products × GROSS_CAP_HEADROOM (the bare product DID bind on validated books — G diagnostic, docs/reports/G-gross-cap.md, applied 2026-10-07)", () => {
    const stocks = liveSleeveConfig("momentum_stocks").candidate;
    expect(stocks.maxGrossExposureMult).toBeCloseTo(stocks.notionalPctPerSlot! * stocks.maxLongs! * GROSS_CAP_HEADROOM, 10);
    const crypto = liveSleeveConfig("momentum_crypto").candidate;
    expect(crypto.maxGrossExposureMult).toBeCloseTo(crypto.notionalPctPerSlot! * crypto.maxLongs! * GROSS_CAP_HEADROOM, 10);
    const usdc = liveSleeveConfig("momentum_crypto_usdc").candidate;
    expect(usdc.maxGrossExposureMult).toBeCloseTo(usdc.notionalPctPerSlot! * usdc.maxLongs! * GROSS_CAP_HEADROOM, 10);
    expect(DEFAULT_MEANREV_CONFIG.slotPct * DEFAULT_MEANREV_CONFIG.maxPositions).toBeCloseTo(0.84, 10);
  });

  test("live daily historyBars formula equals the replay's for the wired horizon", () => {
    const h = MOMENTUM_STOCKS_DAILY_HORIZON!;
    const liveBars = Math.max(dailyHorizonMaxLookback(h), h.maLengthDays) + 11; // index.ts stocksHistoryBars
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

  test("stocks daily vol stop constant equals the k8 leg of the INCUMBENT manifest (rollback config)", () => {
    const m = loadIncumbentManifest("momentum_stocks");
    expect({ mode: "volScaled", ...MOMENTUM_STOCKS_DAILY_VOL_STOP }).toEqual(m.candidates[0].hardStop as any);
  });
});
