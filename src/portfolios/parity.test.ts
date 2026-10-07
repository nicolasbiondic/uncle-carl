// ═══════════════════════════════════════════════════════════════════════
// F3a parity lock (2026-10-04, docs/platform/PLAN.md): the portfolio
// factory fed with builtin.ts must produce EXACTLY what src/index.ts's
// hand-written wiring produced — deep-equal on the REAL objects (engine
// config, adapter options, state path/base/legacyBase/semantics,
// heartbeat, governor registration, shadow spec, scheduler choice).
//
// The reference side is the pure plan functions exported from src/index.ts
// (the verbatim extraction of the old main() wiring, reviewable line by
// line). main() consumes the FACTORY plans, so this suite is what makes
// "sleeves as data" deploy-safe: any drift between builtin.ts/factory.ts
// and the validated wiring is a test failure, not a silent prod change.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { buildPortfolioPlan, cutoverReunderwriteBefore } from "./factory";
import { builtinPortfolio, builtinPortfolios } from "./builtin";
import type { MomentumPortfolioPlan, MomentumTsmParams, PortfolioBuildPlan } from "./types";
import {
  momentumCryptoPortfolioPlan,
  momentumUsdcPortfolioPlan,
  momentumBtcPortfolioPlan,
  momentumStocksPortfolioPlan,
  meanrevStocksPortfolioPlan,
  momentumStocksCutoverFor,
  momentumUsdcCutoverFor,
  MOMENTUM_STOCKS_CUTOVER_EXPIRES_AT,
  MOMENTUM_STOCKS_CUTOVER_SYMBOLS,
  MOMENTUM_USDC_CUTOVER_EXPIRES_AT,
  MOMENTUM_USDC_CUTOVER_SYMBOLS,
} from "../index";
import { RISK_PROFILES, ALL_PROFILE_IDS, MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "../config/riskProfiles";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import { EQUITY_SEMANTICS } from "../strategies/momentum/RiskGuard";

const PURE: Record<string, () => PortfolioBuildPlan> = {
  momentum_crypto: momentumCryptoPortfolioPlan,
  momentum_crypto_usdc: momentumUsdcPortfolioPlan,
  momentum_btc: momentumBtcPortfolioPlan,
  momentum_stocks: momentumStocksPortfolioPlan,
  meanrev_stocks: meanrevStocksPortfolioPlan,
};

for (const id of Object.keys(PURE)) {
  describe(`factory(builtin) ≡ index.ts wiring — ${id}`, () => {
    const pure = PURE[id]() as any;
    const plan = buildPortfolioPlan(builtinPortfolio(id), Date.now()) as any;

    test("engine config is deep-equal (the object the engine actually receives)", () => {
      expect(plan.engineConfig).toEqual(pure.engineConfig);
    });

    test("adapter kind + options are deep-equal", () => {
      expect(plan.adapter).toEqual(pure.adapter);
    });

    test("state persistence: path / base / legacyBase / equity semantics", () => {
      expect(plan.statePersistence).toEqual(pure.statePersistence);
    });

    test("heartbeat: engine heartbeatName + index-side registration", () => {
      expect(plan.engineConfig.heartbeatName).toBe(pure.engineConfig.heartbeatName);
      expect(plan.heartbeat).toEqual(pure.heartbeat);
    });

    test("governor registration (sleeve / default kind / evidence)", () => {
      expect(plan.governorRegistration).toEqual(pure.governorRegistration);
    });

    test("shadow spec, scheduler choice and logger context", () => {
      expect(plan.shadow).toEqual(pure.shadow);
      expect(plan.scheduler).toEqual(pure.scheduler);
      expect(plan.loggerContext).toBe(pure.loggerContext);
    });

    test("whole plan is deep-equal (no undeclared field drifts)", () => {
      expect(plan).toEqual(pure);
    });
  });
}

describe("builtin definitions — registry sanity", () => {
  test("the five built-ins are exactly ALL_PROFILE_IDS", () => {
    expect(builtinPortfolios().map((d) => d.id).sort()).toEqual([...ALL_PROFILE_IDS].sort());
  });

  test("capital equals the sleeve's RISK_PROFILES initialEquity (fixed per-sleeve capital — owner rule)", () => {
    for (const d of builtinPortfolios()) {
      expect({ id: d.id, capital: d.capital }).toEqual({ id: d.id, capital: RISK_PROFILES[d.id as keyof typeof RISK_PROFILES].initialEquity });
    }
  });

  test("universes are the canonical constants (disjointness locks transfer)", () => {
    const params = (id: string) => builtinPortfolio(id).params as MomentumTsmParams;
    expect(params("momentum_stocks").universe).toEqual(MOMENTUM_STOCKS_UNIVERSE);
    expect(params("momentum_crypto").universe).toEqual(MOMENTUM_CRYPTO_UNIVERSE);
    expect(params("momentum_crypto_usdc").universe).toEqual(Object.keys(USDC_SYMBOL_MAP));
  });

  test("meanrev plan risk IS the sleeve ledger — main()'s inline re-assert is a no-op spread", () => {
    const plan = buildPortfolioPlan(builtinPortfolio("meanrev_stocks"), Date.now());
    if (plan.template !== "meanrev_connors") throw new Error("expected meanrev plan");
    expect(plan.engineConfig.risk).toEqual({ equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER });
  });

  test("main() registers the same governor kinds the plans carry (docs.test.ts parses those literals)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8");
    const re = /governor\.register\(\{\s*sleeve:\s*"([a-z_]+)",\s*kind:\s*"(live|shadow)"/g;
    const kinds: Record<string, string> = {};
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) kinds[m[1]] = m[2];
    for (const id of Object.keys(PURE)) {
      expect({ id, kind: kinds[id] }).toEqual({ id, kind: PURE[id]().governorRegistration.kind });
    }
  });
});

describe("cutover windows — factory resolves the self-expiring one-shots exactly like index.ts", () => {
  test("momentum_stocks: cutoverReunderwriteBefore ≡ momentumStocksCutoverFor at open/expiry/later instants", () => {
    const def = builtinPortfolio("momentum_stocks");
    const cut = (def.params as MomentumTsmParams).cutover!;
    for (const t of [Date.UTC(2026, 9, 7, 13, 35), MOMENTUM_STOCKS_CUTOVER_EXPIRES_AT, Date.UTC(2027, 0, 1)]) {
      expect(cutoverReunderwriteBefore(cut, t)).toBe(momentumStocksCutoverFor(t)!);
      const plan = buildPortfolioPlan(def, t) as MomentumPortfolioPlan;
      expect(plan.engineConfig.reunderwriteBefore).toBe(momentumStocksCutoverFor(t)!);
      expect(plan.engineConfig.reunderwriteSymbols).toEqual(momentumStocksCutoverFor(t) !== undefined ? MOMENTUM_STOCKS_CUTOVER_SYMBOLS : undefined);
    }
  });

  test("momentum_crypto_usdc: same lock against momentumUsdcCutoverFor", () => {
    const def = builtinPortfolio("momentum_crypto_usdc");
    const cut = (def.params as MomentumTsmParams).cutover!;
    for (const t of [Date.UTC(2026, 9, 8, 0, 0, 15), MOMENTUM_USDC_CUTOVER_EXPIRES_AT, Date.UTC(2027, 0, 1)]) {
      expect(cutoverReunderwriteBefore(cut, t)).toBe(momentumUsdcCutoverFor(t)!);
      const plan = buildPortfolioPlan(def, t) as MomentumPortfolioPlan;
      expect(plan.engineConfig.reunderwriteBefore).toBe(momentumUsdcCutoverFor(t)!);
      expect(plan.engineConfig.reunderwriteSymbols).toEqual(momentumUsdcCutoverFor(t) !== undefined ? MOMENTUM_USDC_CUTOVER_SYMBOLS : undefined);
    }
  });
});
