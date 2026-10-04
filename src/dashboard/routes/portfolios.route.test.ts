// ═══════════════════════════════════════════════════════════════════════
// F3c — GET /api/platform/portfolios (read-only registry view).
// The route is deps-injected and not yet mounted in server.ts (the
// director wires the mount behind the auth wall), so it is tested here on
// a bare express app with REAL registry rows (seeded in-memory table).
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import express from "express";
import { Database } from "bun:sqlite";
import { registerPlatformPortfoliosRoutes, platformPortfolioView, universeSizeOf } from "./portfolios";
import {
  initPlatformPortfolios,
  insertPlatformPortfolio,
  loadPlatformPortfolioRows,
  updatePlatformPortfolio,
  type PlatformPortfolioRow,
} from "../../portfolios/store";
import { MOMENTUM_CRYPTO_UNIVERSE, MOMENTUM_STOCKS_UNIVERSE, RISK_PROFILES } from "../../config/riskProfiles";
import { MEANREV_UNIVERSE } from "../../strategies/meanrev/MeanRevEngine";
import type { BandReading } from "../../portfolio/scorecard";

function seededRows(): PlatformPortfolioRow[] {
  const db = new Database(":memory:");
  initPlatformPortfolios(db);
  return loadPlatformPortfolioRows(db);
}

async function withApp<T>(
  deps: Parameters<typeof registerPlatformPortfoliosRoutes>[1],
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  registerPlatformPortfoliosRoutes(app, deps);
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const BELOW: BandReading = {
  status: "below",
  liveCumReturnPct: -3.2,
  p5Pct: -1.1,
  horizonSessions: 60,
  modelStart: "2026-09-28",
  reason: null,
};

describe("universeSizeOf / platformPortfolioView (pure)", () => {
  const rows = Object.fromEntries(seededRows().map((r) => [r.id, r]));

  test("universe sizes mirror the canonical constants per template", () => {
    expect(universeSizeOf(rows.momentum_crypto)).toBe(MOMENTUM_CRYPTO_UNIVERSE.length);
    expect(universeSizeOf(rows.momentum_stocks)).toBe(MOMENTUM_STOCKS_UNIVERSE.length);
    expect(universeSizeOf(rows.meanrev_stocks)).toBe(MEANREV_UNIVERSE.length);
    expect(universeSizeOf(rows.momentum_btc)).toBe(1);
  });

  test("mode is the governor's EFFECTIVE mode; the registered default stays visible as defaultMode", () => {
    // A row whose registered default differs from the governor's effective
    // mode (momentum_crypto registered "shadow" until 2026-10-04 while live).
    const legacy = { ...rows.momentum_crypto, mode: "shadow" as const };
    const v = platformPortfolioView(legacy, "code", null, "live");
    expect(v.mode).toBe("live");
    expect(v.defaultMode).toBe("shadow");
    expect(platformPortfolioView(legacy, "code", null).mode).toBe("shadow"); // no governor → the default
    expect(rows.momentum_crypto.mode).toBe("live"); // registered default since 2026-10-04
  });

  test("view carries id/name/template/account/capital/mode/origin and the band", () => {
    const v = platformPortfolioView(rows.momentum_stocks, "code", BELOW);
    expect(v).toEqual({
      id: "momentum_stocks",
      name: rows.momentum_stocks.name,
      template: "momentum_tsm",
      account: "alpaca_main",
      capital: RISK_PROFILES.momentum_stocks.initialEquity,
      universeSize: MOMENTUM_STOCKS_UNIVERSE.length,
      mode: "live",
      defaultMode: "live",
      enabled: true,
      status: "active",
      validation: "validated",
      rowSource: "builtin",
      origin: "code",
      band: { status: "below", liveCumReturnPct: -3.2, p5Pct: -1.1, reason: null },
      params: rows.momentum_stocks.params,
    });
  });

  test("no band reading → band null (never fabricated)", () => {
    expect(platformPortfolioView(rows.momentum_btc, "db", null).band).toBeNull();
    expect(platformPortfolioView(rows.momentum_btc, "db", null).origin).toBe("db");
  });
});

describe("GET /api/platform/portfolios", () => {
  test("lists the five seeded portfolios with their band readings", async () => {
    const rows = seededRows();
    await withApp(
      { source: "code", listPortfolios: () => rows, bandReadings: () => ({ momentum_stocks: BELOW }) },
      async (base) => {
        const res = await fetch(`${base}/api/platform/portfolios`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any[];
        expect(body.length).toBe(5);
        const byId = Object.fromEntries(body.map((p) => [p.id, p]));
        expect(byId.momentum_stocks.band.status).toBe("below");
        expect(byId.momentum_crypto.band).toBeNull();
        expect(byId.momentum_crypto.mode).toBe("live");
        expect(byId.momentum_btc.enabled).toBe(false);
        for (const p of body) expect(p.origin).toBe("code");
      },
    );
  });

  test("a throwing band reader degrades to band:null — the registry list never 500s on scorecard hiccups", async () => {
    const rows = seededRows();
    await withApp(
      {
        source: "db",
        listPortfolios: () => rows,
        bandReadings: () => {
          throw new Error("historical.db locked");
        },
      },
      async (base) => {
        const res = await fetch(`${base}/api/platform/portfolios`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any[];
        expect(body.length).toBe(5);
        for (const p of body) {
          expect(p.band).toBeNull();
          expect(p.origin).toBe("db");
        }
      },
    );
  });

  test("writes answer 501 when write deps are not injected (read-only deploy)", async () => {
    const rows = seededRows();
    await withApp(
      { source: "code", listPortfolios: () => rows, bandReadings: () => ({}) },
      async (base) => {
        const post = await fetch(`${base}/api/platform/portfolios`, {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        expect(post.status).toBe(501);
        const patch = await fetch(`${base}/api/platform/portfolios/momentum_btc`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body: "{}",
        });
        expect(patch.status).toBe(501);
      },
    );
  });

  test("a throwing registry IS a 500 (the list itself is the contract)", async () => {
    await withApp(
      {
        source: "code",
        listPortfolios: () => {
          throw new Error("table missing");
        },
        bandReadings: () => ({}),
      },
      async (base) => {
        const res = await fetch(`${base}/api/platform/portfolios`);
        expect(res.status).toBe(500);
        expect(((await res.json()) as any).error).toContain("table missing");
      },
    );
  });
});

describe("GET /api/platform/portfolios/meta", () => {
  test("not writable (no write deps): writable:false, accounts:[], presets still listed", async () => {
    const rows = seededRows();
    await withApp(
      { source: "code", listPortfolios: () => rows, bandReadings: () => ({}) },
      async (base) => {
        const res = await fetch(`${base}/api/platform/portfolios/meta`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.writable).toBe(false);
        expect(body.accounts).toEqual([]);
        expect(body.presets.length).toBe(4);
        const byId = Object.fromEntries(body.presets.map((p: any) => [p.id, p]));
        expect(byId.momentum_stocks.template).toBe("momentum_tsm");
        expect(byId.momentum_stocks.account).toBe("alpaca_main");
        expect(byId.meanrev_stocks.template).toBe("meanrev_connors");
        expect(byId.momentum_stocks.exampleParams).toBeTruthy();
      },
    );
  });

  test("writable (write deps present): writable:true, accounts from deps.write.accounts()", async () => {
    const rows = seededRows();
    await withApp(
      {
        source: "db",
        listPortfolios: () => rows,
        bandReadings: () => ({}),
        write: {
          accounts: () => ["alpaca_main", "binance_usdt"],
          accountEquity: () => 10_000,
          insertPortfolio: () => {},
          updatePortfolio: () => {},
        },
      },
      async (base) => {
        const res = await fetch(`${base}/api/platform/portfolios/meta`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.writable).toBe(true);
        expect(body.accounts).toEqual(["alpaca_main", "binance_usdt"]);
      },
    );
  });
});

describe("F3d — POST/PATCH with real registry plumbing (in-memory db)", () => {
  function writeDeps() {
    const db = new Database(":memory:");
    initPlatformPortfolios(db);
    // Make room: archive the crypto sleeve so a v2 can take its universe.
    db.run("UPDATE platform_portfolios SET status = 'archived', enabled = 0 WHERE id = 'momentum_crypto'");
    return {
      db,
      deps: {
        source: "db" as const,
        listPortfolios: () => loadPlatformPortfolioRows(db),
        bandReadings: () => ({}),
        write: {
          accounts: () => ["alpaca_main", "binance_usdt", "binance_usdc", "binance_coinm"],
          accountEquity: (a: string) => ({ alpaca_main: 110_000, binance_usdt: 6_000, binance_usdc: 6_000, binance_coinm: 2_000 } as any)[a] ?? null,
          insertPortfolio: (row: PlatformPortfolioRow) => insertPlatformPortfolio(db, row),
          updatePortfolio: (row: PlatformPortfolioRow) => updatePlatformPortfolio(db, row),
        },
      },
    };
  }

  test("POST creates a pending_restart row from a validated preset and persists it", async () => {
    const { db, deps } = writeDeps();
    await withApp(deps, async (base) => {
      const res = await fetch(`${base}/api/platform/portfolios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "momentum_crypto_v2", name: "Crypto v2", account: "binance_usdt", capital: 5_000, preset: "momentum_crypto" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.status).toBe("pending_restart");
      expect(body.validation).toBe("validated");
      expect(body.effective).toBe(true); // source=db
      const row = loadPlatformPortfolioRows(db).find((r) => r.id === "momentum_crypto_v2")!;
      expect(row.source).toBe("owner");
      expect(row.capital).toBe(5_000);
    });
  });

  test("POST 400 carries the validator's errors (disjoint-universe refusal)", async () => {
    const { deps } = writeDeps();
    await withApp(deps, async (base) => {
      const res = await fetch(`${base}/api/platform/portfolios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "usdc_two", name: "USDC 2", account: "binance_usdc", capital: 500, preset: "momentum_crypto_usdc" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.errors.join(" ")).toContain("universe overlaps enabled portfolio 'momentum_crypto_usdc'");
    });
  });

  test("PATCH marks an edited live portfolio unvalidated + pending_restart; 404 on unknown id", async () => {
    const { db, deps } = writeDeps();
    await withApp(deps, async (base) => {
      const stocks = loadPlatformPortfolioRows(db).find((r) => r.id === "momentum_stocks")!;
      const params = { ...(stocks.params as any), volStop: { kSigma: 6, lookbackBars: 20, minPct: 4, maxPct: 25 } };
      const res = await fetch(`${base}/api/platform/portfolios/momentum_stocks`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.validation).toBe("unvalidated");
      expect(body.status).toBe("pending_restart");
      const row = loadPlatformPortfolioRows(db).find((r) => r.id === "momentum_stocks")!;
      expect(row.validation).toBe("unvalidated");
      expect(row.status).toBe("pending_restart");

      const missing = await fetch(`${base}/api/platform/portfolios/nope`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(missing.status).toBe(404);
    });
  });

  test("PATCH archive is the owner's explicit action and persists", async () => {
    const { db, deps } = writeDeps();
    await withApp(deps, async (base) => {
      const res = await fetch(`${base}/api/platform/portfolios/momentum_btc`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      expect(res.status).toBe(200);
      const row = loadPlatformPortfolioRows(db).find((r) => r.id === "momentum_btc")!;
      expect(row.status).toBe("archived");
      expect(row.enabled).toBe(false);
    });
  });
});
