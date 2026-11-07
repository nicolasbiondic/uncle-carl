// ═══════════════════════════════════════════════════════════════════════
// Platform portfolios — read API (F3c, 2026-10-04, docs/platform/PLAN.md).
//
// Exported as registerPlatformPortfoliosRoutes(app, deps); server.ts mounts it
// BEHIND the dashboard auth wall like every /api route. Everything here is
// injected (registry rows + scorecard band reader), so the route owns no I/O
// of its own.
// ═══════════════════════════════════════════════════════════════════════
import express from "express";
import type { BandReading } from "../../portfolio/scorecard";
import type { PlatformPortfolioRow, PortfoliosSource } from "../../portfolios/store";
import type { MomentumTsmParams, PortfolioEngineParams, PortfolioParams } from "../../portfolios/types";
import { DEFAULT_MEANREV_CONFIG } from "../../strategies/meanrev/MeanRevEngine";
import { builtinPortfolio } from "../../portfolios/builtin";
import { VALIDATED_PRESETS, portfolioUniverse, validateCreatePortfolio, validatePatchPortfolio } from "../../portfolios/validate";

/** F3d write deps — all injected; absent = the write API answers 501
 *  (read-only deploy). Writes persist to the registry in BOTH sources but
 *  are only EFFECTIVE on the next boot under PORTFOLIOS_SOURCE=db. */
export interface PlatformPortfoliosWriteDeps {
  /** Broker accounts the runtime actually has wired. */
  accounts: () => string[];
  /** Account equity reader (broker truth). null = unreadable → writes fail
   *  closed in the validator. */
  accountEquity: (account: string) => number | null;
  insertPortfolio: (row: PlatformPortfolioRow) => void;
  updatePortfolio: (row: PlatformPortfolioRow) => void;
}

export interface PlatformPortfoliosDeps {
  /** Resolved once at boot (resolvePortfoliosSource) — what the runtime is
   *  actually building engines from. */
  source: PortfoliosSource;
  /** Registry rows (platform_portfolios — the table exists in BOTH sources). */
  listPortfolios: () => PlatformPortfolioRow[];
  /** Scorecard expectation-band readings (index.ts's governorBandReadings,
   *  src/portfolio/scorecard.ts). Injected: the route never opens DBs. */
  bandReadings: () => Record<string, BandReading>;
  write?: PlatformPortfoliosWriteDeps;
}

export interface PlatformPortfolioBandView {
  status: BandReading["status"];
  liveCumReturnPct: number | null;
  p5Pct: number | null;
  reason: string | null;
  rollingBand?: PlatformPortfolioBandView;
}

export interface PlatformPortfolioView {
  id: string;
  /** The sleeve whose book this row describes: the id, or params.sleeve for a
   *  portfolio-engine definition (its band is that sleeve's). */
  sleeve: string;
  /** RW2: id of the LIVE portfolio-engine definition that manages this sleeve
   *  instead of this row's engine (incumbent rows only); null = this row's
   *  engine is the manager (or the row is itself a definition). */
  managedBy: string | null;
  name: string;
  template: string;
  account: string;
  capital: number;
  universeSize: number;
  /** The registry label: "live" trades; "shadow" is an OBSERVER portfolio-
   *  engine definition (computes, sends nothing). Not a runtime mode: the
   *  governor's live/shadow sleeve mode was removed 2026-11-07. */
  mode: string;
  enabled: boolean;
  status: string;
  validation: string;
  /** "builtin" (seeded) or "owner" (created/edited via the write API). */
  rowSource: string;
  /** The runtime's PORTFOLIOS_SOURCE: "code" or "db". */
  origin: PortfoliosSource;
  band: PlatformPortfolioBandView | null;
  /** The raw template params — already loaded with the row (no extra I/O);
   *  the F3d edit UI needs the CURRENT params to prefill its advanced JSON
   *  editor (it can only ever send a full replacement). Behind the auth
   *  wall like the rest of this route. */
  params: PortfolioParams;
}

/** Pure: a portfolio's universe size. meanrev_connors keeps its universe in
 *  DEFAULT_MEANREV_CONFIG (single source — index.ts never overrode it). */
export function universeSizeOf(row: Pick<PlatformPortfolioRow, "template" | "params">): number {
  if (row.template === "meanrev_connors") return DEFAULT_MEANREV_CONFIG.universe.length;
  if (row.template === "portfolio") return portfolioUniverse(row.template, row.params).length;
  const p = row.params as MomentumTsmParams;
  return Array.isArray(p.universe) ? p.universe.length : 0;
}

/** Pure, RW2: which registry rows manage which sleeve this boot's registry
 *  describes. A LIVE portfolio definition (template portfolio, enabled, mode
 *  live, params.runMode live — the boot resolver's predicate) replaces the
 *  incumbent row named by params.sleeve: that row is listed as managed by the
 *  definition, and the definition carries the sleeve id its band belongs to. */
export function portfolioManagers(rows: readonly Pick<PlatformPortfolioRow, "id" | "template" | "enabled" | "mode" | "status" | "params">[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.template !== "portfolio" || !r.enabled || r.mode !== "live" || r.status === "archived") continue;
    const p = r.params as PortfolioEngineParams;
    if (p?.runMode === "live" && typeof p.sleeve === "string") out[p.sleeve] = r.id;
  }
  return out;
}

/** Pure: one registry row + the runtime source + its band reading → the
 *  read-API item. Tested in portfolios.route.test.ts without a server. */
export function platformPortfolioView(
  row: PlatformPortfolioRow,
  origin: PortfoliosSource,
  band: BandReading | null,
  managers: Record<string, string> = {},
): PlatformPortfolioView {
  const peSleeve = row.template === "portfolio" ? (row.params as PortfolioEngineParams).sleeve ?? null : null;
  return {
    id: row.id,
    sleeve: peSleeve ?? row.id,
    managedBy: managers[row.id] ?? null,
    name: row.name,
    template: row.template,
    account: row.account,
    capital: row.capital,
    universeSize: universeSizeOf(row),
    mode: row.mode,
    enabled: row.enabled,
    status: row.status,
    validation: row.validation,
    rowSource: row.source,
    origin,
    band: band
      ? { status: (band.modelBand ?? band).status, liveCumReturnPct: (band.modelBand ?? band).liveCumReturnPct,
          p5Pct: (band.modelBand ?? band).p5Pct, reason: (band.modelBand ?? band).reason,
          ...(band.rollingBand ? { rollingBand: { status: band.rollingBand.status, liveCumReturnPct: band.rollingBand.liveCumReturnPct,
            p5Pct: band.rollingBand.p5Pct, reason: band.rollingBand.reason } } : {}) }
      : null,
    params: row.params,
  };
}

export interface PlatformPortfoliosMetaPreset {
  id: string;
  name: string;
  /** Template of the VALIDATED model ("portfolio" for a sleeve on the portfolio engine). */
  template: string;
  account: string;
  /** The built-in definition's template — the one `exampleParams` belong to
   *  (equals `template`: since 2026-11-07 the stock sleeves' built-ins ARE
   *  portfolio-engine definitions; the TSM/Connors incumbents are gone). */
  incumbentTemplate: string;
  /** false when the validated model runs on the portfolio engine: the create
   *  form lists it disabled (scripts/portfolio-engine-cutover.ts creates it). */
  creatable: boolean;
  /** The built-in definition's params — the UI prefills a free-template textarea
   *  with the example sharing that template (never a blank editor). */
  exampleParams: unknown;
}

export interface PlatformPortfoliosMeta {
  /** Whether POST/PATCH are wired on this deploy (deps.write present). */
  writable: boolean;
  presets: PlatformPortfoliosMetaPreset[];
  /** Runtime broker accounts — [] when not writable (the create form has
   *  nothing to populate without write deps). */
  accounts: string[];
}

/** Pure: the four validated presets + the runtime accounts, for the "new
 *  portfolio" form. Tested in portfolios.route.test.ts. */
export function platformPortfoliosMeta(deps: PlatformPortfoliosDeps): PlatformPortfoliosMeta {
  const presets = Object.entries(VALIDATED_PRESETS).map(([id, meta]) => {
    // The built-in definition of the preset: the sleeve's own row for the crypto momentum engines,
    // the pe_<sleeve> portfolio-engine definition for the stock sleeves (2026-11-07).
    const def = builtinPortfolio(meta.portfolioEngine ? `pe_${id}` : id);
    return {
      id, name: def.name, template: meta.template, account: def.account,
      incumbentTemplate: def.template, creatable: !meta.portfolioEngine, exampleParams: def.params,
    };
  });
  return { writable: !!deps.write, presets, accounts: deps.write ? deps.write.accounts() : [] };
}

export function registerPlatformPortfoliosRoutes(app: express.Application, deps: PlatformPortfoliosDeps): void {
  app.get("/api/platform/portfolios/meta", (_req, res) => {
    try {
      res.json(platformPortfoliosMeta(deps));
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "portfolio meta unavailable" });
    }
  });

  app.get("/api/platform/portfolios", (_req, res) => {
    try {
      // The band is decoration on this view — a scorecard hiccup must not
      // 500 the registry list (same fail-open philosophy as the dashboard's
      // other read-only mirrors).
      let bands: Record<string, BandReading> = {};
      try {
        bands = deps.bandReadings() ?? {};
      } catch {
        bands = {};
      }
      const rows = deps.listPortfolios();
      const managers = portfolioManagers(rows);
      res.json(rows.map((r) => {
        const sleeve = r.template === "portfolio" ? (r.params as PortfolioEngineParams).sleeve ?? r.id : r.id;
        return platformPortfolioView(r, deps.source, bands[sleeve] ?? null, managers);
      }));
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "platform portfolios unavailable" });
    }
  });

  // ── F3d writes (owner actions; effective on the NEXT boot and only under
  // PORTFOLIOS_SOURCE=db — the response says so explicitly). Validation is
  // pure (src/portfolios/validate.ts): template schema + ranges, runtime
  // account, capital > 0 with the account-sum ≤ equity rule, disjoint
  // universes per account, validated presets vs free templates. Archiving
  // is an explicit owner flag — the platform never recommends it. ──
  const writeNote = () =>
    deps.source === "db"
      ? "applies on the next restart (pending_restart)"
      : "stored in the registry; only effective when the runtime starts with PORTFOLIOS_SOURCE=db";

  app.post("/api/platform/portfolios", express.json(), (req, res) => {
    if (!deps.write) return res.status(501).json({ error: "portfolio writes are not wired on this deploy" });
    try {
      const out = validateCreatePortfolio(req.body ?? {}, {
        existing: deps.listPortfolios(),
        accounts: deps.write.accounts(),
        accountEquity: deps.write.accountEquity,
      }, Date.now());
      if (!out.ok) return res.status(400).json({ errors: out.errors });
      deps.write.insertPortfolio(out.row);
      res.status(201).json({ ...platformPortfolioView(out.row, deps.source, null), effective: deps.source === "db", note: writeNote() });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "portfolio create failed" });
    }
  });

  app.patch("/api/platform/portfolios/:id", express.json(), (req, res) => {
    if (!deps.write) return res.status(501).json({ error: "portfolio writes are not wired on this deploy" });
    try {
      const out = validatePatchPortfolio(String(req.params.id), req.body ?? {}, {
        existing: deps.listPortfolios(),
        accounts: deps.write.accounts(),
        accountEquity: deps.write.accountEquity,
      }, Date.now());
      if (!out.ok) {
        const notFound = out.errors.length === 1 && /not found/.test(out.errors[0]);
        return res.status(notFound ? 404 : 400).json({ errors: out.errors });
      }
      deps.write.updatePortfolio(out.row);
      res.json({ ...platformPortfolioView(out.row, deps.source, null), effective: deps.source === "db", note: writeNote() });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "portfolio patch failed" });
    }
  });
}
