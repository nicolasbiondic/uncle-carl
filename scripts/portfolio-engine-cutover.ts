#!/usr/bin/env bun
// ══════════════════════════════════════════════
// portfolio-engine-cutover.ts — put the portfolio engine on an existing sleeve, and take it off (RW2)
// ══════════════════════════════════════════════
//
// Writes the registry definition (platform_portfolios, template "portfolio") of the engine that runs on a
// sleeve, from the manifest candidate's EXACT `portfolio` block, so live = tested. DRY-RUN BY DEFAULT: it
// prints what it would write and every check; --apply writes it. Edits apply on the NEXT boot (restart the
// bot; PORTFOLIOS_SOURCE=db, as in prod). The runbook: src/portfolio-engine/README.md.
//
//   bun scripts/portfolio-engine-cutover.ts --sleeve momentum_stocks --mode observer \
//        --manifest experiments/<manifest>.json --candidate <name> [--apply]
//   … --mode live      (needs the SAME design in observer with ≥ --min-observed observed passes, and the
//                       version appended to src/portfolio/modelVersions.ts and deployed)
//   … --mode rollback  [--remove] [--apply]   (back to observer; --remove deletes the definition)
//
// Options: --db <path> (default data/trading.db) · --version-name <n> (default pe-<candidate>) ·
//          --min-observed <n> (default 3).
// Never touches a broker. The incumbent's registry row is only read (its capital is the sleeve's).

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { MODEL_VERSIONS, type ModelVersion } from "../src/portfolio/modelVersions";
import { designHash, isCryptoDesign, PORTFOLIO_SLEEVES, resolvePortfolioWiring } from "../src/portfolio-engine/live/cutover";
import { insertPlatformPortfolio, loadPlatformPortfolioDefinitions, loadPlatformPortfolioRows, type PlatformPortfolioRow } from "../src/portfolios/store";
import type { PortfolioEngineParams } from "../src/portfolios/types";
import type { PortfolioStrategyConfig, VenueId } from "../src/portfolio-engine/types";
import { isTreasurySymbol } from "../src/treasury/treasurySymbols";
import { USDC_SYMBOL_MAP } from "../src/executor/binance/quoteAsset";
import { SYMBOL_MAP } from "../src/executor/binance-executor";

export type CutoverMode = "observer" | "live" | "rollback";

export interface CutoverArgs {
  sleeve: string;
  mode: CutoverMode;
  manifest?: string;
  candidate?: string;
  apply: boolean;
  dbPath: string;
  remove: boolean;
  minObserved: number;
  versionName?: string;
}

export type CutoverWrite =
  | { action: "insert" | "update"; row: PlatformPortfolioRow }
  | { action: "delete"; id: string }
  | { action: "none" };

export interface CutoverPlan {
  ok: boolean;
  errors: string[];
  lines: string[];
  write: CutoverWrite;
}

export const peDefinitionId = (sleeve: string) => `pe_${sleeve}`;

interface ManifestBlock {
  strategy: PortfolioStrategyConfig;
  venue: { venue: VenueId; fractional: boolean; minOrderNotional: number; rebalanceBand: number; qtyStep?: Record<string, number> };
}

function readCandidate(path: string, name: string): { block: ManifestBlock; errors: string[] } {
  const errors: string[] = [];
  if (!existsSync(path)) return { block: null as never, errors: [`manifest not found: ${path}`] };
  const m = JSON.parse(readFileSync(path, "utf-8"));
  const cand = (m.candidates ?? []).find((c: any) => c.name === name);
  if (!cand) return { block: null as never, errors: [`candidate '${name}' not in ${path} (has: ${(m.candidates ?? []).map((c: any) => c.name).join(", ")})`] };
  if (!cand.portfolio?.strategy || !cand.portfolio?.venue) errors.push(`candidate '${name}' has no portfolio.strategy / portfolio.venue block`);
  return { block: cand.portfolio, errors };
}

/** The strategy symbols in the sleeve's row symbol space, and the mapping back to the bars the replay used. */
function sleeveSymbols(block: ManifestBlock, sleeve: string, errors: string[]): { strategy: PortfolioStrategyConfig; dataSymbols?: Record<string, string> } {
  const target = PORTFOLIO_SLEEVES[sleeve];
  if (block.strategy.kind === "factorCore") { errors.push("factorCore: no live membership source is wired (src/portfolio-engine/live/cutover.ts)"); return { strategy: block.strategy }; }
  const universe = block.strategy.universe;
  if (target.venue === "binance_usdc") {
    const mapped = universe.map(s => s.replace(/\/USD$/, "/USDC"));
    for (const s of mapped) if (!USDC_SYMBOL_MAP[s]) errors.push(`${s} has no USDC perpetual in USDC_SYMBOL_MAP`);
    const dataSymbols = Object.fromEntries(universe.map((s, i) => [mapped[i], s]));
    return { strategy: { ...block.strategy, universe: mapped }, dataSymbols };
  }
  if (target.venue === "binance_usdm") for (const s of universe) if (!SYMBOL_MAP[s]) errors.push(`${s} has no USDT perpetual in SYMBOL_MAP`);
  if (target.venue === "alpaca") for (const s of universe) if (isTreasurySymbol(s)) errors.push(`${s} is the treasury sweep's ETF`);
  for (const s of universe) if (!target.symbolOk(s)) errors.push(`${s} is outside the symbol space of ${sleeve}'s rows`);
  return { strategy: block.strategy };
}

function openRowsSummary(db: Database, sleeve: string): string {
  const rows = db.prepare(`SELECT symbol, strategy, quantity FROM trades WHERE account_id = ? AND status = 'open' ORDER BY symbol`).all(sleeve) as any[];
  return rows.length === 0 ? "none" : rows.map(r => `${r.symbol} ${r.quantity} (${r.strategy})`).join(", ");
}

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

/** Pure with respect to the DB: reads, validates, returns what --apply would write. */
export function planCutover(db: Database, args: CutoverArgs, opts: { modelVersions?: Readonly<Record<string, readonly ModelVersion[]>> } = {}): CutoverPlan {
  const errors: string[] = [];
  const lines: string[] = [];
  const fail = (): CutoverPlan => ({ ok: false, errors, lines, write: { action: "none" } });
  const target = PORTFOLIO_SLEEVES[args.sleeve];
  if (!target) { errors.push(`unknown sleeve '${args.sleeve}' (one of ${Object.keys(PORTFOLIO_SLEEVES).join(", ")})`); return fail(); }
  if (!tableExists(db, "platform_portfolios")) { errors.push("platform_portfolios does not exist in this DB (start the bot once with PORTFOLIOS_SOURCE=db, or point --db at the right file)"); return fail(); }

  const rows = loadPlatformPortfolioRows(db);
  const incumbent = rows.find(r => r.id === args.sleeve);
  if (!incumbent) errors.push(`no registry row '${args.sleeve}' (the incumbent definition): start the bot once with PORTFOLIOS_SOURCE=db so it is seeded`);
  else if (incumbent.account !== target.account) errors.push(`incumbent row account ${incumbent.account} ≠ ${target.account}`);
  if (errors.length > 0) return fail();
  const id = peDefinitionId(args.sleeve);
  const existing = rows.find(r => r.id === id);
  const existingParams = existing?.params as PortfolioEngineParams | undefined;
  const portfolioRowsOpen = (db.prepare(`SELECT COUNT(*) AS c FROM trades WHERE account_id = ? AND status = 'open' AND strategy = 'PORTFOLIO'`).get(args.sleeve) as any)?.c ?? 0;
  lines.push(`sleeve ${args.sleeve} → account ${target.account}, venue ${target.venue}, incumbent capital $${incumbent!.capital}`);
  lines.push(`definition id ${id}: ${existing ? `exists (${existingParams?.runMode ?? "?"}, enabled=${existing.enabled}, version ${existingParams?.strategyVersion ?? "?"})` : "does not exist"}`);
  lines.push(`open rows of the sleeve: ${openRowsSummary(db, args.sleeve)}`);

  // ── rollback ──
  if (args.mode === "rollback") {
    if (!existing) { lines.push("nothing to roll back: no portfolio definition exists — the incumbent already manages the sleeve"); return { ok: true, errors, lines, write: { action: "none" } }; }
    if (args.remove) {
      lines.push(`WILL DELETE definition ${id}`);
      lines.push(`at the next boot the incumbent manages ${args.sleeve} again; its ${portfolioRowsOpen} open PORTFOLIO row(s) are re-tagged to ${target.incumbentStrategy} before it starts (its stop machinery covers them)`);
      return { ok: true, errors, lines, write: { action: "delete", id } };
    }
    const next: PlatformPortfolioRow = {
      ...existing, mode: "shadow", status: "pending_restart", updatedAt: Date.now(),
      params: { ...(existing.params as PortfolioEngineParams), runMode: "observer" },
    };
    lines.push(`WILL SET ${id} back to observer (it keeps computing and persisting decisions, sends nothing)`);
    lines.push(`at the next boot the incumbent manages ${args.sleeve} again; its ${portfolioRowsOpen} open PORTFOLIO row(s) are re-tagged to ${target.incumbentStrategy} before it starts`);
    lines.push("append a MODEL_VERSIONS entry for the incumbent's config in the next deploy (docs: README 'Versions')");
    return { ok: true, errors, lines, write: { action: "update", row: next } };
  }

  // ── observer / live: the definition comes from the manifest candidate ──
  if (!args.manifest || !args.candidate) { errors.push("--manifest and --candidate are required for observer/live"); return fail(); }
  const { block, errors: readErrors } = readCandidate(args.manifest, args.candidate);
  errors.push(...readErrors);
  if (errors.length > 0) return fail();
  const v = block.venue;
  if (v.venue !== target.venue) errors.push(`candidate venue ${v.venue} ≠ ${target.venue} (the venue of ${args.sleeve})`);
  if (v.fractional !== (target.venue === "alpaca")) errors.push(`candidate venue.fractional=${v.fractional} does not match ${target.venue}`);
  if (target.venue !== "alpaca" && (v.rebalanceBand !== 0.02 || v.minOrderNotional !== 5)) {
    errors.push(`Binance venue rules are the exchange's with band 0.02 / min notional 5 (BinanceVenueAdapter.rules); the candidate tested band ${v.rebalanceBand} / min ${v.minOrderNotional}: live would not be tested`);
  }
  if (isCryptoDesign(block.strategy) !== (target.venue !== "alpaca")) errors.push(`design ${block.strategy.kind} does not belong on ${target.venue}`);
  const { strategy, dataSymbols } = sleeveSymbols(block, args.sleeve, errors);
  if (errors.length > 0) return fail();

  const versionName = args.versionName ?? `pe-${args.candidate}`;
  const strategyVersion = `${args.sleeve}@${versionName}`;
  const params: PortfolioEngineParams = {
    engine: "portfolio", sleeve: args.sleeve, strategy, venue: v.venue,
    runMode: args.mode === "live" ? "live" : "observer", strategyVersion,
    heartbeatName: `portfolio:${args.sleeve}`, loggerContext: `Portfolio:${args.sleeve}`,
    minOrderNotional: v.minOrderNotional, rebalanceBand: v.rebalanceBand,
    ...(dataSymbols ? { dataSymbols } : {}),
    provenance: { manifest: args.manifest, candidate: args.candidate, designSha256: "" },
  };
  params.provenance!.designSha256 = designHash(params);
  // live = tested: the hash of the stored design must be the hash of the manifest block itself.
  const manifestHash = designHash({ strategy: block.strategy, venue: v.venue, minOrderNotional: v.minOrderNotional, rebalanceBand: v.rebalanceBand });
  if (manifestHash !== params.provenance!.designSha256) { errors.push("internal: stored design hash ≠ manifest block hash"); return fail(); }
  lines.push(`candidate ${args.candidate} of ${args.manifest}: ${block.strategy.kind}, ${strategy.kind === "factorCore" ? "?" : strategy.universe.length} symbols, design sha256 ${manifestHash.slice(0, 16)}…`);
  lines.push(`strategyVersion ${strategyVersion}${dataSymbols ? " (USDC rows: universe mapped XXX/USD → XXX/USDC, dataSymbols maps back to the bars)" : ""}`);

  const nextRow: PlatformPortfolioRow = {
    id, name: `${args.sleeve} on the portfolio engine (${args.candidate})`, template: "portfolio", account: target.account,
    capital: incumbent!.capital, mode: args.mode === "live" ? "live" : "shadow", enabled: true, params,
    status: "pending_restart", validation: "validated", source: "owner",
    createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
  };

  if (args.mode === "live") {
    if (!existing) errors.push("live needs the same design running in observer first: run --mode observer and let it observe");
    else if (existingParams?.provenance?.designSha256 !== params.provenance!.designSha256) errors.push("the existing definition holds a DIFFERENT design than this candidate: observer must run THIS design first");
    if (existing && existingParams?.strategyVersion !== strategyVersion) errors.push(`the observer's strategyVersion '${existingParams?.strategyVersion}' ≠ '${strategyVersion}' (decisions and memory are per version)`);
    const observed = tableExists(db, "portfolio_decisions")
      ? ((db.prepare(`SELECT COUNT(*) AS c FROM portfolio_decisions WHERE account_id = ? AND strategy_version = ? AND status = 'observed'`).get(args.sleeve, strategyVersion) as any)?.c ?? 0)
      : 0;
    lines.push(`observed passes of ${strategyVersion}: ${observed} (required ≥ ${args.minObserved})`);
    if (observed < args.minObserved) errors.push(`only ${observed} observed pass(es) of ${strategyVersion}; need ${args.minObserved} (--min-observed to override)`);
    const list = (opts.modelVersions ?? MODEL_VERSIONS)[args.sleeve] ?? [];
    const last = list.length > 0 ? list[list.length - 1].id : null;
    if (last !== strategyVersion) errors.push(`MODEL_VERSIONS['${args.sleeve}'] ends with '${last}', not '${strategyVersion}': append that version in src/portfolio/modelVersions.ts and deploy BEFORE going live (never edit a past one)`);
  }

  // The same resolver the bot runs at boot, on the registry as it would be after --apply.
  const defs = loadPlatformPortfolioDefinitions(db).filter(d => d.id !== id);
  defs.push({ id, name: nextRow.name, template: "portfolio", account: nextRow.account, capital: nextRow.capital, mode: nextRow.mode, enabled: true, params });
  const venueReady = { alpaca: null, binance_usdm: null, binance_usdc: null } as const;
  const wiring = resolvePortfolioWiring({ defs, venueReady, modelVersions: opts.modelVersions });
  const mine = wiring.problems.filter(p => p.definitionId === id);
  for (const p of mine) errors.push(`boot would ${p.severity === "live_refused" ? "refuse to run it live" : "ignore it"}: ${p.message}`);
  if (errors.length > 0) return fail();

  if (args.mode === "live") {
    lines.push(`WILL SET ${id} to LIVE: at the next boot the incumbent engine of ${args.sleeve} is NOT built (no entries, no exits); the portfolio engine adopts its open rows (re-tag to PORTFOLIO, no close, no rebuy), releases the incumbent's resting stops on them and takes them out of the stop machinery`);
    lines.push("fail-closed: if the engine cannot be built or the definition is refused at boot, the incumbent keeps the sleeve and ops is paged");
  } else {
    lines.push(`WILL ${existing ? "REPLACE" : "CREATE"} ${id} as OBSERVER: computes and persists decisions on the sleeve's real rows, sends nothing; the incumbent keeps trading`);
  }
  return { ok: true, errors, lines, write: { action: existing ? "update" : "insert", row: nextRow } };
}

export function applyCutover(db: Database, plan: CutoverPlan): void {
  const w = plan.write;
  if (w.action === "none") return;
  if (w.action === "delete") { db.prepare(`DELETE FROM platform_portfolios WHERE id = ?`).run(w.id); return; }
  if (w.action === "insert") { insertPlatformPortfolio(db, w.row); return; }
  const r = w.row;
  // mode IS written here (the registry's update helper leaves it alone): runMode live needs mode live.
  db.prepare(`
    UPDATE platform_portfolios SET name = ?, capital = ?, mode = ?, enabled = ?, params_json = ?, status = ?, validation = ?, source = ?, updated_at = ?
    WHERE id = ?
  `).run(r.name, r.capital, r.mode, r.enabled ? 1 : 0, JSON.stringify(r.params), r.status, r.validation, r.source, r.updatedAt, r.id);
}

export function parseArgs(argv: string[]): CutoverArgs | string {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const sleeve = get("--sleeve");
  const mode = get("--mode");
  if (!sleeve) return "--sleeve is required";
  if (mode !== "observer" && mode !== "live" && mode !== "rollback") return "--mode must be observer, live or rollback";
  const minObserved = get("--min-observed");
  return {
    sleeve, mode, manifest: get("--manifest"), candidate: get("--candidate"), apply: argv.includes("--apply"),
    dbPath: get("--db") ?? "data/trading.db", remove: argv.includes("--remove"),
    minObserved: minObserved === undefined ? 3 : Number(minObserved), versionName: get("--version-name"),
  };
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (typeof args === "string") { console.error(`${args}\nusage: bun scripts/portfolio-engine-cutover.ts --sleeve <id> --mode observer|live|rollback --manifest <json> --candidate <name> [--apply] [--remove] [--db path] [--version-name n] [--min-observed n]`); return 2; }
  if (!existsSync(args.dbPath)) { console.error(`DB not found: ${args.dbPath}`); return 2; }
  const db = new Database(args.dbPath, args.apply ? undefined : { readonly: true });
  try {
    const plan = planCutover(db, args);
    console.log(`portfolio-engine-cutover ${args.apply ? "APPLY" : "DRY-RUN"} · ${args.mode} · ${args.sleeve}`);
    for (const l of plan.lines) console.log(`  ${l}`);
    for (const e of plan.errors) console.error(`  ✗ ${e}`);
    if (!plan.ok) { console.error("REFUSED: nothing written."); return 1; }
    if (!args.apply) { console.log("DRY-RUN: nothing written. Re-run with --apply to write it (then restart the bot: edits apply on the next boot)."); return 0; }
    applyCutover(db, plan);
    console.log(`written (${plan.write.action}). Restart the bot to apply.`);
    return 0;
  } finally { db.close(); }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
