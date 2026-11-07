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
import type { MomentumPortfolioPlan, MomentumTsmParams } from "./types";
import {
  momentumCryptoPortfolioPlan,
  momentumUsdcPortfolioPlan,
  momentumUsdcCutoverFor,
  MOMENTUM_USDC_CUTOVER_EXPIRES_AT,
  MOMENTUM_USDC_CUTOVER_SYMBOLS,
} from "../index";
import { RISK_PROFILES, MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "../config/riskProfiles";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";

// The hand-wired sleeves: the two Binance momentum engines. The stock sleeves'
// built-ins are portfolio-engine definitions with no index.ts plan function
// (src/portfolios/builtinPortfolioEngine.test.ts locks them to their manifest).
const PURE: Record<string, () => MomentumPortfolioPlan> = {
  momentum_crypto: momentumCryptoPortfolioPlan,
  momentum_crypto_usdc: momentumUsdcPortfolioPlan,
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

    test("governor registration (sleeve / evidence)", () => {
      expect(plan.governorRegistration).toEqual(pure.governorRegistration);
    });

    test("scheduler choice and logger context", () => {
      expect(plan.scheduler).toEqual(pure.scheduler);
      expect(plan.loggerContext).toBe(pure.loggerContext);
    });

    test("whole plan is deep-equal (no undeclared field drifts)", () => {
      expect(plan).toEqual(pure);
    });
  });
}

describe("builtin definitions — registry sanity", () => {
  test("the built-ins are the two crypto momentum sleeves plus the two stock portfolio-engine definitions; the retired ids throw", () => {
    expect(builtinPortfolios().map((d) => d.id).sort()).toEqual(["momentum_crypto", "momentum_crypto_usdc", "pe_meanrev_stocks", "pe_momentum_stocks"]);
    for (const retired of ["momentum_btc", "momentum_stocks", "meanrev_stocks"]) {
      expect(() => builtinPortfolio(retired)).toThrow(/unknown portfolio id/);
    }
  });

  test("capital equals the sleeve's RISK_PROFILES initialEquity (fixed per-sleeve capital — owner rule)", () => {
    for (const d of builtinPortfolios()) {
      const sleeve = d.template === "portfolio" ? (d.params as { sleeve: string }).sleeve : d.id;
      expect({ id: d.id, capital: d.capital }).toEqual({ id: d.id, capital: RISK_PROFILES[sleeve as keyof typeof RISK_PROFILES].initialEquity });
    }
  });

  test("universes are the canonical constants (disjointness locks transfer)", () => {
    const params = (id: string) => builtinPortfolio(id).params as MomentumTsmParams;
    const peUniverse = (id: string) => (builtinPortfolio(id).params as any).strategy.universe as string[];
    expect(peUniverse("pe_momentum_stocks")).toEqual([...MOMENTUM_STOCKS_UNIVERSE]);
    expect(peUniverse("pe_meanrev_stocks")).toEqual([...MEANREV_UNIVERSE]);
    expect(params("momentum_crypto").universe).toEqual(MOMENTUM_CRYPTO_UNIVERSE);
    expect(params("momentum_crypto_usdc").universe).toEqual(Object.keys(USDC_SYMBOL_MAP));
  });

  test("the retired templates cannot build an engine: meanrev_connors, and momentum_tsm on alpaca_main", () => {
    const crypto = builtinPortfolio("momentum_crypto");
    expect(() => buildPortfolioPlan({ ...crypto, template: "meanrev_connors" }, Date.now())).toThrow(/retired/);
    expect(() => buildPortfolioPlan({ ...crypto, account: "alpaca_main" }, Date.now())).toThrow(/no momentum_tsm engine runs on alpaca_main/);
  });

  test("main() registers every planned sleeve with the governor, with no mode (the live/shadow kind was removed 2026-11-07)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8");
    const re = /governor\.register\(\{\s*sleeve:\s*"([a-z_]+)",\s*evidenceVersion:/g;
    const registered = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) registered.add(m[1]);
    for (const id of Object.keys(PURE)) expect({ id, registered: registered.has(id) }).toEqual({ id, registered: true });
    expect(src).not.toMatch(/kind:\s*"(live|shadow)"/);
  });
});

describe("cutover windows — factory resolves the self-expiring one-shots exactly like index.ts", () => {
  test("momentum_crypto_usdc: cutoverReunderwriteBefore ≡ momentumUsdcCutoverFor at open/expiry/later instants", () => {
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
