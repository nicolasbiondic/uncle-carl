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
//   momentum_crypto ↔ experiments/momentum-crypto-vt35-pure-v1.json
//   momentum_crypto_usdc ↔ experiments/momentum-crypto-usdc-daily-s5-pure-v1.json
//     (AUTHORITATIVE, not gate-certified — owner rule; see liveSleeveConfigs.ts)
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
  LIVE_SLEEVE_MANIFESTS,
  MEANREV_STOCKS_VOL_STOP,
  MOMENTUM_CRYPTO_VOL_TARGET,
  MOMENTUM_SLEEVE_SHARPE_GATE,
  MOMENTUM_STOCKS_SLOT_HYSTERESIS,
  effectiveRiskConfig,
  liveSleeveConfig,
  type LiveSleeveId,
} from "../src/config/liveSleeveConfigs";
import { validateCandidate, type CandidateConfig, type ExperimentManifest } from "./walk-forward";
import { DEFAULT_MEANREV_CONFIG } from "../src/strategies/meanrev/MeanRevEngine";
import { MOMENTUM_STOCKS_DAILY_HORIZON, MOMENTUM_STOCKS_DAILY_VOL_STOP, dailyHorizonMaxLookback } from "../src/index";
import { DEFAULT_TSM_CONFIG } from "../src/strategies/momentum/TimeSeriesMomentum";

const ROOT = join(import.meta.dir, "..");

function loadManifest(sleeve: LiveSleeveId): ExperimentManifest {
  return JSON.parse(readFileSync(join(ROOT, LIVE_SLEEVE_MANIFESTS[sleeve]), "utf-8"));
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
      "live-only runtime BACKSTOP (1.0×): at the validated sizing notionalPctPerSlot×maxLongs the sim can never exceed it by construction; live it exists to catch legacy-sized books (the 2026-09-25 META/AAPL cutover incident class). Its value is locked to the product below.",
  },
  meanrev_stocks: {
    name: "identity label only — no execution semantics",
    // (meanrev candidates carry no risk/maxGross keys in the manifest and
    // the live candidate adds none: the 0.84× backstop is engine-level, see
    // the dedicated backstop assertion below.)
  },
  momentum_crypto: {
    name: "identity label only — no execution semantics",
    risk: "compared as the EFFECTIVE RiskGuardConfig below; live adds equitySemantics (see momentum_stocks)",
    maxGrossExposureMult:
      "live-only runtime BACKSTOP (1.5× = 0.375×4): never binds at validated sizing; catches drift of held notional after entry. Locked to the product below.",
  },
  momentum_crypto_usdc: {
    name: "identity label only — no execution semantics",
    risk: "compared as the EFFECTIVE RiskGuardConfig below; live adds equitySemantics (see momentum_stocks)",
    maxGrossExposureMult:
      "live-only runtime BACKSTOP (1.0× = ⅓×3): never binds at authoritative sizing; catches drift of held notional after entry. Locked to the product below.",
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
  describe(`vivo=validado — ${sleeve}`, () => {
    const m = loadManifest(sleeve);
    const live = liveSleeveConfig(sleeve);

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
  test("stock manifests' ledger.leverage: 2 (momentum, Reg-T headroom the 1.0× gross never uses) / 1 (meanrev)", () => {
    expect(loadManifest("momentum_stocks").ledger.leverage).toBe(2);
    expect(loadManifest("meanrev_stocks").ledger.leverage).toBe(1);
  });
});

// ── source-text locks on wiring literals index.ts does not export ────────
// Same falsifier style AGENTS.md documents. If the wiring literal changes,
// the module constant must change with it (and vice versa).
describe("index.ts wiring literals ↔ module constants", () => {
  const indexSrc = readFileSync(join(ROOT, "src", "index.ts"), "utf-8");
  const count = (needle: string) => indexSrc.split(needle).length - 1;

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

  test("meanrev volStop literal matches MEANREV_STOCKS_VOL_STOP — exactly once", () => {
    const s = MEANREV_STOCKS_VOL_STOP;
    const literal = `volStop: { kSigma: ${s.kSigma}, lookbackBars: ${s.lookbackBars}, minPct: ${s.minPct}, maxPct: ${s.maxPct} }`;
    expect(count(literal)).toBe(1);
  });

  test("sharpeGate literal matches MOMENTUM_SLEEVE_SHARPE_GATE on every momentum sleeve", () => {
    const g = MOMENTUM_SLEEVE_SHARPE_GATE;
    const literal = `sharpeGate: { lookbackDays: ${g.lookbackDays}, minSharpe: ${g.minSharpe} }`;
    expect(count(literal)).toBeGreaterThanOrEqual(2); // stocks + crypto at minimum
    expect(count("sharpeGate: {")).toBe(count(literal)); // no sleeve wires a DIFFERENT gate
  });

  test("stocks daily trail/hard stop both spread MOMENTUM_STOCKS_DAILY_VOL_STOP", () => {
    expect(count("{ ...MOMENTUM_STOCKS_DAILY_VOL_STOP }")).toBe(2); // tsmTrail + volStop
  });
});

// ── structural sanity the derivations rely on ────────────────────────────
describe("derivation invariants", () => {
  test("backstops equal slot×count products (the 'never binds' premise)", () => {
    const stocks = liveSleeveConfig("momentum_stocks").candidate;
    expect(stocks.maxGrossExposureMult).toBeCloseTo(stocks.notionalPctPerSlot! * stocks.maxLongs!, 10);
    const crypto = liveSleeveConfig("momentum_crypto").candidate;
    expect(crypto.maxGrossExposureMult).toBeCloseTo(crypto.notionalPctPerSlot! * crypto.maxLongs!, 10);
    const usdc = liveSleeveConfig("momentum_crypto_usdc").candidate;
    expect(usdc.maxGrossExposureMult).toBeCloseTo(usdc.notionalPctPerSlot! * usdc.maxLongs!, 10);
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

  test("stocks daily vol stop constant equals the k8 leg of the manifest", () => {
    const m = loadManifest("momentum_stocks");
    expect({ mode: "volScaled", ...MOMENTUM_STOCKS_DAILY_VOL_STOP }).toEqual(m.candidates[0].hardStop as any);
  });
});
