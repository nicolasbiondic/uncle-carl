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
  resolvePortfoliosSource,
  updatePlatformPortfolio,
} from "./store";
import { builtinPortfolios } from "./builtin";
import { buildPortfolioPlan } from "./factory";

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
