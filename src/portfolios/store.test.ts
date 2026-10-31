// ═══════════════════════════════════════════════════════════════════════
// F3b locks (2026-10-04, docs/platform/PLAN.md):
//  - PORTFOLIOS_SOURCE parsing: default code, db opt-in, anything else
//    refuses to start (money-path flag is never guessed).
//  - platform_portfolios seeding is idempotent and NEVER overwrites an
//    owner-edited row (INSERT OR IGNORE).
//  - THE parity test of the phase: the factory fed with the SEEDED ROWS is
//    deep-equal to the factory fed with builtin.ts — flipping the flag on
//    an untouched database builds byte-identical engines.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initPlatformPortfolios,
  loadPlatformPortfolioDefinitions,
  loadPlatformPortfolioRows,
  markPendingPortfoliosActive,
  resolvePortfoliosSource,
  updatePlatformPortfolio,
} from "./store";
import { builtinPortfolios } from "./builtin";
import { buildPortfolioPlan } from "./factory";
import { validateMomentumParams } from "./validate";
import { momentumCryptoPortfolioPlan, momentumUsdcPortfolioPlan } from "../index";

describe("resolvePortfoliosSource — default code, unknown refuses to start", () => {
  test("absent/empty/'code' → code (prod default, byte-identical wiring)", () => {
    expect(resolvePortfoliosSource(undefined)).toBe("code");
    expect(resolvePortfoliosSource("")).toBe("code");
    expect(resolvePortfoliosSource("code")).toBe("code");
  });
  test("'db' → db", () => {
    expect(resolvePortfoliosSource("db")).toBe("db");
  });
  test("anything else throws (startup aborts before any engine is built)", () => {
    expect(() => resolvePortfoliosSource("database")).toThrow(/not a valid portfolio source/);
    expect(() => resolvePortfoliosSource("DB")).toThrow();
    expect(() => resolvePortfoliosSource("codigo")).toThrow();
  });
});

describe("platform_portfolios registry", () => {
  test("seed is idempotent and never overwrites an owner-edited row", () => {
    const db = new Database(":memory:");
    initPlatformPortfolios(db, 1_000);
    expect(loadPlatformPortfolioRows(db).length).toBe(5);
    db.run("UPDATE platform_portfolios SET capital = 123, source = 'owner' WHERE id = 'momentum_crypto'");
    initPlatformPortfolios(db, 2_000); // second boot
    const rows = loadPlatformPortfolioRows(db);
    expect(rows.length).toBe(5);
    const crypto = rows.find((r) => r.id === "momentum_crypto")!;
    expect(crypto.capital).toBe(123); // owner edit survived the reseed
    expect(crypto.source).toBe("owner");
  });

  test("seeded rows carry the builtin flags: enabled, mode, status, validation", () => {
    const db = new Database(":memory:");
    initPlatformPortfolios(db);
    const rows = Object.fromEntries(loadPlatformPortfolioRows(db).map((r) => [r.id, r]));
    expect(rows.momentum_btc.enabled).toBe(false); // flag-off sleeve
    expect(rows.momentum_crypto.mode).toBe("live"); // registered default live since 2026-10-04 (was "shadow")
    for (const r of Object.values(rows)) {
      expect(r.status).toBe("active");
      expect(r.validation).toBe("validated");
      expect(r.source).toBe("builtin");
    }
  });

  test("F3b PARITY: factory(seeded rows) deep-equal factory(builtin) for every sleeve", () => {
    const db = new Database(":memory:");
    initPlatformPortfolios(db);
    const T = Date.UTC(2026, 9, 4, 12); // fixed instant: both sides resolve cutovers identically
    const fromDb = Object.fromEntries(loadPlatformPortfolioDefinitions(db).map((d) => [d.id, d]));
    for (const builtin of builtinPortfolios()) {
      const def = fromDb[builtin.id];
      expect(def).toBeDefined();
      expect(def).toEqual(builtin); // JSON round-trip loses nothing
      expect(buildPortfolioPlan(def, T) as any).toEqual(buildPortfolioPlan(builtin, T) as any);
    }
  });

  test("archived rows are excluded from the definitions index.ts builds from", () => {
    const db = new Database(":memory:");
    initPlatformPortfolios(db);
    db.run("UPDATE platform_portfolios SET status = 'archived' WHERE id = 'momentum_btc'");
    const defs = loadPlatformPortfolioDefinitions(db);
    expect(defs.map((d) => d.id)).not.toContain("momentum_btc");
    expect(defs.length).toBe(4);
  });
});

describe("boot seed refreshes untouched builtin rows (2026-10-04)", () => {
  test("a builtin row that drifted from builtin.ts is refreshed; an owner-edited row is never touched; equal rows are not rewritten", () => {
    const db = new Database(":memory:");
    initPlatformPortfolios(db, 1_000);
    // prod's row as seeded before 2026-10-04: momentum_crypto registered "shadow".
    db.run(`UPDATE platform_portfolios SET mode = 'shadow' WHERE id = 'momentum_crypto'`);
    // An owner edit on another builtin row.
    const meanrev = loadPlatformPortfolioRows(db).find((r) => r.id === "meanrev_stocks")!;
    updatePlatformPortfolio(db, { ...meanrev, capital: 55_000, source: "owner", updatedAt: 1_500 });

    initPlatformPortfolios(db, 2_000);
    const byId = Object.fromEntries(loadPlatformPortfolioRows(db).map((r) => [r.id, r]));
    expect(byId.momentum_crypto.mode).toBe("live");
    expect(byId.momentum_crypto.updatedAt).toBe(2_000);
    expect(byId.meanrev_stocks.capital).toBe(55_000); // the owner's value survives the boot
    expect(byId.meanrev_stocks.source).toBe("owner");
    expect(byId.momentum_stocks.updatedAt).toBe(1_000); // equal to builtin → untouched
  });
});

describe("historical RW3 seed refreshes to the current hourly builtin at boot", () => {
  test("a source='builtin' row seeded with the pre-RW3 params (no regime, vt35-2026-09-23, v8-crypto-no-hard-sl) is refreshed; the same row flipped to 'owner' is frozen", () => {
    const old = (db: Database) => {
      const r = loadPlatformPortfolioRows(db).find((x) => x.id === "momentum_crypto")!;
      const { regime: _drop, ...rest } = r.params as any;
      const params = { ...rest, modelVersion: "vt35-2026-09-23", governor: { promotionEligible: false, evidenceVersion: "v8-crypto-no-hard-sl" } };
      db.run("UPDATE platform_portfolios SET params_json = ? WHERE id = 'momentum_crypto'", [JSON.stringify(params)]);
    };
    const db = new Database(":memory:");
    initPlatformPortfolios(db, 1_000);
    old(db);
    expect((loadPlatformPortfolioRows(db).find((x) => x.id === "momentum_crypto")!.params as any).regime).toBeUndefined();
    initPlatformPortfolios(db, 2_000);
    const row = loadPlatformPortfolioRows(db).find((x) => x.id === "momentum_crypto")!;
    expect(row.source).toBe("builtin");
    expect((row.params as any).regime).toEqual({ enabled: false });
    expect((row.params as any).modelVersion).toBe("vt35-corroff-2026-10-23");
    expect((row.params as any).governor.evidenceVersion).toBe("v8.5-crypto-corroff");
    expect(row.updatedAt).toBe(2_000);
    // The engine config the db source builds carries the disabled regime.
    const plan: any = buildPortfolioPlan(loadPlatformPortfolioDefinitions(db).find((d) => d.id === "momentum_crypto")!, 0);
    expect(plan.engineConfig.regime).toEqual({ barMinutes: 60, enabled: false });

    const frozen = new Database(":memory:");
    initPlatformPortfolios(frozen, 1_000);
    old(frozen);
    frozen.run("UPDATE platform_portfolios SET source = 'owner' WHERE id = 'momentum_crypto'");
    initPlatformPortfolios(frozen, 2_000);
    expect((loadPlatformPortfolioRows(frozen).find((x) => x.id === "momentum_crypto")!.params as any).regime).toBeUndefined();
  });
});

describe("RW8 boot: builtin registry rows refresh from RW6/RW7 and carry every new key through validation and the factory", () => {
  test("db-source crypto engines equal code plans; owner rows stay frozen and RiskState keys do not change", () => {
    const db = new Database(":memory:");
    try {
      initPlatformPortfolios(db, 1_000);
      for (const id of ["momentum_crypto", "momentum_crypto_usdc"]) {
        const row = loadPlatformPortfolioRows(db).find(r => r.id === id)!;
        const { risk: _risk, allowSameTickReentry: _reentry, breakoutShort: _breakout, ...params } = row.params as any;
        if (id === "momentum_crypto") {
          params.regime = { correlationCeiling: 1.01 };
          params.sharpeGate = { lookbackDays: 30, minSharpe: 0 };
        }
        db.run("UPDATE platform_portfolios SET params_json = ? WHERE id = ?", [JSON.stringify(params), id]);
      }
      const oldRows = loadPlatformPortfolioRows(db);
      const frozen = Database.deserialize(db.serialize());
      try {
        frozen.run("UPDATE platform_portfolios SET source = 'owner' WHERE id IN ('momentum_crypto', 'momentum_crypto_usdc')");
        initPlatformPortfolios(frozen, 2_000);
        for (const id of ["momentum_crypto", "momentum_crypto_usdc"]) {
          expect(loadPlatformPortfolioRows(frozen).find(r => r.id === id)!.params).toEqual(oldRows.find(r => r.id === id)!.params);
        }
      } finally { frozen.close(); }
      initPlatformPortfolios(db, 2_000);
      for (const [id, reference] of [["momentum_crypto", momentumCryptoPortfolioPlan], ["momentum_crypto_usdc", momentumUsdcPortfolioPlan]] as const) {
        const row = loadPlatformPortfolioRows(db).find(r => r.id === id)!;
        const params = row.params as any;
        const errors: string[] = [];
        validateMomentumParams(params, row.account, errors, { permittedCutover: params.cutover });
        expect(errors).toEqual([]);
        expect(row.source).toBe("builtin");
        expect(row.updatedAt).toBe(2_000);
        expect(params.modelVersion).toBe((oldRows.find(r => r.id === id)!.params as any).modelVersion);
        const plan = buildPortfolioPlan(loadPlatformPortfolioDefinitions(db).find(d => d.id === id)!, Date.now());
        if (plan.template !== "momentum_tsm") throw new Error("expected momentum plan");
        expect(plan).toEqual(reference());
        expect(plan.engineConfig.risk?.mode).toBe("sizeOnly");
        expect(plan.engineConfig.timeStop).toEqual({ maxHoldHours: 120 });
        if (id === "momentum_crypto") {
          expect(plan.engineConfig.regime).toEqual({ barMinutes: 60, enabled: false });
          expect(plan.engineConfig.sharpeGate).toBeUndefined();
          expect(plan.engineConfig.allowSameTickReentry).toBe(true);
          expect(plan.engineConfig.breakoutShort).toEqual(reference().engineConfig.breakoutShort);
          expect(plan.adapter).toMatchObject({ options: { breakoutShortSymbols: params.universe } });
        } else {
          expect(plan.engineConfig.regime).toEqual({ barMinutes: 1440 });
          expect(plan.engineConfig.sharpeGate).toEqual({ lookbackDays: 30, minSharpe: 0 });
          expect(plan.engineConfig.allowSameTickReentry).toBeUndefined();
          expect(plan.engineConfig.exposureControl?.minScale).toBe(0.25);
        }
      }
      initPlatformPortfolios(db, 3_000);
      expect(loadPlatformPortfolioRows(db).find(r => r.id === "momentum_crypto")!.updatedAt).toBe(2_000);
    } finally { db.close(); }
  });
});

describe("boot applies pending edits: pending_restart → active (2026-10-23, RW2 cutover rows stayed pending forever)", () => {
  test("every pending_restart row flips to active with the boot's timestamp; archived and active rows are untouched; idempotent", () => {
    const db = new Database(":memory:");
    initPlatformPortfolios(db);
    db.run("UPDATE platform_portfolios SET status = 'pending_restart', updated_at = 1 WHERE id IN ('momentum_stocks', 'meanrev_stocks')");
    db.run("UPDATE platform_portfolios SET status = 'archived', updated_at = 1 WHERE id = 'momentum_btc'");
    db.run(`INSERT INTO platform_portfolios (id, name, template, account, capital, mode, enabled, params_json, status, validation, source, created_at, updated_at)
            VALUES ('pe_momentum_stocks', 'pe', 'portfolio', 'alpaca_main', 50000, 'live', 1, '{"engine":"portfolio","sleeve":"momentum_stocks","runMode":"live"}', 'pending_restart', 'validated', 'owner', 1, 1)`);
    const before = Object.fromEntries(loadPlatformPortfolioRows(db).map(r => [r.id, r.updatedAt]));

    expect(markPendingPortfoliosActive(db, 777)).toEqual(["meanrev_stocks", "momentum_stocks", "pe_momentum_stocks"]);
    const rows = Object.fromEntries(loadPlatformPortfolioRows(db).map(r => [r.id, r]));
    for (const id of ["meanrev_stocks", "momentum_stocks", "pe_momentum_stocks"]) {
      expect(rows[id].status).toBe("active");
      expect(rows[id].updatedAt).toBe(777);
    }
    expect(rows.momentum_btc.status).toBe("archived");
    expect(rows.momentum_btc.updatedAt).toBe(1);
    expect(rows.momentum_crypto.status).toBe("active");
    expect(rows.momentum_crypto.updatedAt).toBe(before.momentum_crypto);
    // The pe_ row keeps everything that makes it run live: only the label moved.
    expect(rows.pe_momentum_stocks.mode).toBe("live");
    expect(rows.pe_momentum_stocks.enabled).toBe(true);
    expect((rows.pe_momentum_stocks.params as any).runMode).toBe("live");

    expect(markPendingPortfoliosActive(db, 888)).toEqual([]);
    expect(loadPlatformPortfolioRows(db).find(r => r.id === "momentum_stocks")!.updatedAt).toBe(777);
  });
});

describe("RW4a (2026-10-23): prod's untouched momentum_crypto_usdc builtin row picks up the exposure control at boot", () => {
  test("a source='builtin' row seeded with the pre-RW4a params (no exposureControl, v8.3-usdc-daily) is refreshed — same modelVersion (no RiskState re-anchor); the same row flipped to 'owner' is frozen", () => {
    const knob = { drawdown: { startPct: 0.1, endPct: 0.4 }, minScale: 0.25, band: 0.1, minOrderUsd: 100 };
    const old = (db: Database) => {
      const r = loadPlatformPortfolioRows(db).find((x) => x.id === "momentum_crypto_usdc")!;
      const { exposureControl: _drop, ...rest } = r.params as any;
      const params = { ...rest, governor: { evidenceVersion: "v8.3-usdc-daily" } };
      db.run("UPDATE platform_portfolios SET params_json = ? WHERE id = 'momentum_crypto_usdc'", [JSON.stringify(params)]);
    };
    const db = new Database(":memory:");
    initPlatformPortfolios(db, 1_000);
    old(db);
    expect((loadPlatformPortfolioRows(db).find((x) => x.id === "momentum_crypto_usdc")!.params as any).exposureControl).toBeUndefined();
    initPlatformPortfolios(db, 2_000);
    const row = loadPlatformPortfolioRows(db).find((x) => x.id === "momentum_crypto_usdc")!;
    expect(row.source).toBe("builtin");
    expect((row.params as any).exposureControl).toEqual(knob);
    expect((row.params as any).modelVersion).toBe("daily-s5-blend3-2026-09-26"); // NOT bumped: the live drawdown is the control's input
    expect((row.params as any).governor.evidenceVersion).toBe("v8.6-usdc-xc-dd");
    expect(row.updatedAt).toBe(2_000);
    // The engine config the db source builds carries the knob (factory forwards it).
    const plan: any = buildPortfolioPlan(loadPlatformPortfolioDefinitions(db).find((d) => d.id === "momentum_crypto_usdc")!, 0);
    expect(plan.engineConfig.exposureControl).toEqual(knob);
    expect(plan.engineConfig.modelVersion).toBe("daily-s5-blend3-2026-09-26");

    const frozen = new Database(":memory:");
    initPlatformPortfolios(frozen, 1_000);
    old(frozen);
    frozen.run("UPDATE platform_portfolios SET source = 'owner' WHERE id = 'momentum_crypto_usdc'");
    initPlatformPortfolios(frozen, 2_000);
    expect((loadPlatformPortfolioRows(frozen).find((x) => x.id === "momentum_crypto_usdc")!.params as any).exposureControl).toBeUndefined();
  });
});
