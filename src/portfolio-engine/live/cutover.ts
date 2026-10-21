// ═══ Portfolio engine — which sleeves it may run on, and who manages each ═══
//
// RW2 (docs/reports/RW-reescritura-rentable.md §4). A registry definition with template "portfolio"
// puts the portfolio engine on an EXISTING sleeve (params.sleeve = the sleeve's trades.account_id;
// the definition has its own id). Two modes, both by configuration:
//   observer — the engine computes and persists its decisions on the sleeve's real rows and sends
//              nothing; the incumbent engine keeps trading untouched.
//   live     — exactly ONE engine manages the sleeve: the incumbent is not built (index.ts), the
//              portfolio engine adopts the open rows (strategy PORTFOLIO: out of the stop machinery).
//
// This module is the pure decision (resolvePortfolioWiring) plus the one DB operation rollback needs
// (handBackPortfolioRows). The contract is FAIL CLOSED toward the incumbent: any doubt about a live
// definition (unknown sleeve, mismatched account/venue/symbols, two definitions for one sleeve, a
// design that no longer matches its tested hash, a version the scorecard does not know, a universe
// that collides with another sleeve of the shared wallet, a venue that is not available) means the
// definition does not run live, the incumbent keeps managing the sleeve, and a problem is returned
// so index.ts can page. Never two engines on one sleeve, never none because of a bad definition.

import { createHash } from "node:crypto";
import { getDB, insertActivity, PORTFOLIO_ENGINE_STRATEGY } from "../../db/database";
import { MODEL_VERSIONS, type ModelVersion } from "../../portfolio/modelVersions";
import { buildPortfolioPlan } from "../../portfolios/factory";
import { portfolioUniverse } from "../../portfolios/validate";
import type { PortfolioAccountId, PortfolioDefinition, PortfolioEngineParams, PortfolioEnginePlan } from "../../portfolios/types";
import { isTreasurySymbol } from "../../treasury/treasurySymbols";
import type { PortfolioStrategyConfig, VenueId } from "../types";

export interface SleeveTarget {
  account: PortfolioAccountId;
  venue: VenueId;
  /** trades.strategy the incumbent engine writes (what rollback hands the rows back to). */
  incumbentStrategy: "MOMENTUM" | "MEANREV";
  /** Symbol space of the sleeve's rows. Strategy symbols must live in it, or an adopted row and
   *  the design's symbol would be two different positions. */
  symbolOk: (symbol: string) => boolean;
}

/** The sleeves the portfolio engine may replace (RW2). COIN-M (momentum_btc) is not one. */
export const PORTFOLIO_SLEEVES: Readonly<Record<string, SleeveTarget>> = {
  momentum_stocks: { account: "alpaca_main", venue: "alpaca", incumbentStrategy: "MOMENTUM", symbolOk: s => !s.includes("/") },
  meanrev_stocks: { account: "alpaca_main", venue: "alpaca", incumbentStrategy: "MEANREV", symbolOk: s => !s.includes("/") },
  momentum_crypto: { account: "binance_usdt", venue: "binance_usdm", incumbentStrategy: "MOMENTUM", symbolOk: s => s.endsWith("/USD") },
  momentum_crypto_usdc: { account: "binance_usdc", venue: "binance_usdc", incumbentStrategy: "MOMENTUM", symbolOk: s => s.endsWith("/USDC") },
};

// ── design hash: live = tested ───────────────────────────────────────────────

/** Binance designs: cryptoTrend, and volManaged annualized on 365 days (RW2 E3). The rest trade on Alpaca. */
export function isCryptoDesign(s: PortfolioStrategyConfig): boolean {
  return s.kind === "cryptoTrend" || (s.kind === "volManaged" && s.annualization === 365);
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** What the manifest candidate tested: its strategy block (universe in the DATA symbols the replay
 *  used) and the venue rules. dataSymbols is an environment mapping (the USDC rows are XXX/USDC, the
 *  bars XXX/USD), so it is undone before hashing: the hash is the manifest's, whatever the sleeve. */
export function designHash(p: Pick<PortfolioEngineParams, "strategy" | "venue" | "minOrderNotional" | "rebalanceBand" | "dataSymbols">): string {
  const map = p.dataSymbols ?? {};
  const strategy: any = p.strategy.kind === "factorCore" ? p.strategy : { ...p.strategy, universe: p.strategy.universe.map(s => map[s] ?? s) };
  return createHash("sha256").update(stableStringify({
    strategy, venue: p.venue, minOrderNotional: p.minOrderNotional, rebalanceBand: p.rebalanceBand,
  })).digest("hex");
}

// ── resolution ───────────────────────────────────────────────────────────────

export interface WiringProblem {
  definitionId: string;
  sleeve: string | null;
  severity: "live_refused" | "ignored";
  message: string;
}

export interface PortfolioWiring {
  /** Run alongside the incumbent, sending nothing. */
  observers: PortfolioEnginePlan[];
  /** Replace the incumbent (the incumbent of plan.params.sleeve must not run). */
  live: PortfolioEnginePlan[];
  problems: WiringProblem[];
}

export interface ResolveInput {
  /** Every non-archived registry definition (incumbents included: universes/heartbeats collide-check). */
  defs: readonly PortfolioDefinition[];
  /** Per venue: null = the process can reach it; otherwise why it cannot. */
  venueReady: Readonly<Record<VenueId, string | null>>;
  /** Test seam; default the real MODEL_VERSIONS. */
  modelVersions?: Readonly<Record<string, readonly ModelVersion[]>>;
  now?: number;
}

const isPe = (d: PortfolioDefinition) => d.template === "portfolio";

export function resolvePortfolioWiring(input: ResolveInput): PortfolioWiring {
  const problems: WiringProblem[] = [];
  const out: PortfolioWiring = { observers: [], live: [], problems };
  const versions = input.modelVersions ?? MODEL_VERSIONS;
  const now = input.now ?? Date.now();
  const enabledPe = input.defs.filter(d => isPe(d) && d.enabled);
  const refuse = (d: PortfolioDefinition, sleeve: string | null, severity: WiringProblem["severity"], message: string) =>
    problems.push({ definitionId: d.id, sleeve, severity, message });

  // 1. Structural checks per definition (a failure ignores it for BOTH modes).
  const valid = new Map<string, { def: PortfolioDefinition; params: PortfolioEngineParams; sleeve: string; target: SleeveTarget }[]>();
  for (const def of enabledPe) {
    const p = def.params as PortfolioEngineParams;
    const errors: string[] = [];
    const sleeve = typeof p?.sleeve === "string" ? p.sleeve : null;
    const target = sleeve ? PORTFOLIO_SLEEVES[sleeve] : undefined;
    if (!sleeve || !target) errors.push(`params.sleeve '${sleeve ?? ""}' is not one of ${Object.keys(PORTFOLIO_SLEEVES).join(", ")}`);
    else {
      if (def.id === sleeve) errors.push("the definition id must not be the sleeve id (that row belongs to the incumbent)");
      if (def.account !== target.account) errors.push(`account ${def.account} ≠ ${target.account} (the account of ${sleeve})`);
      if (p.venue !== target.venue) errors.push(`venue ${p.venue} ≠ ${target.venue} (the venue of ${sleeve})`);
    }
    if (p?.engine !== "portfolio") errors.push('params.engine must be "portfolio"');
    if (p?.runMode !== "observer" && p?.runMode !== "live") errors.push(`params.runMode '${p?.runMode}' is neither observer nor live`);
    if (p?.runMode === "live" && def.mode !== "live") errors.push(`runMode live but definition mode '${def.mode}' (both must say live)`);
    if (!p?.strategyVersion || !p?.heartbeatName) errors.push("strategyVersion and heartbeatName are required");
    if (!(def.capital > 0)) errors.push("capital must be > 0");
    if (p?.strategy?.kind === "factorCore") errors.push("factorCore needs a point-in-time membership source that no live wiring provides yet");
    else if (p?.strategy) {
      if (isCryptoDesign(p.strategy) !== (p.venue !== "alpaca")) errors.push(`design ${p.strategy.kind} does not belong on venue ${p.venue}`);
      if (target) {
        const bad = p.strategy.universe.filter(s => !target.symbolOk(s));
        if (bad.length > 0) errors.push(`universe symbols outside the symbol space of ${sleeve}'s rows: ${bad.join(", ")} (an adopted row and the design would be two positions)`);
      }
    }
    if (errors.length > 0 || !sleeve || !target) { refuse(def, sleeve, "ignored", errors.join("; ")); continue; }
    const list = valid.get(sleeve) ?? [];
    list.push({ def, params: p, sleeve, target });
    valid.set(sleeve, list);
  }

  // 2. Per sleeve: one live OR any number of distinct observers; never a live next to anything else.
  const allHeartbeats = new Map<string, string>();
  for (const d of input.defs) {
    const hb = (d.params as { heartbeatName?: string })?.heartbeatName;
    if (hb && !isPe(d)) allHeartbeats.set(hb, d.id);
  }
  for (const [sleeve, entries] of [...valid.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const lives = entries.filter(e => e.params.runMode === "live");
    if (lives.length > 0 && entries.length > 1) {
      for (const e of entries) refuse(e.def, sleeve, e.params.runMode === "live" ? "live_refused" : "ignored",
        `${entries.length} enabled portfolio definitions target ${sleeve} (${entries.map(x => x.def.id).join(", ")}) and one is live: ambiguous, none runs; the incumbent manages the sleeve`);
      continue;
    }
    const seenVersion = new Set<string>();
    const seenHeartbeat = new Set<string>();
    for (const e of entries.sort((a, b) => (a.def.id < b.def.id ? -1 : 1))) {
      const hbOwner = allHeartbeats.get(e.params.heartbeatName);
      if (hbOwner) { refuse(e.def, sleeve, e.params.runMode === "live" ? "live_refused" : "ignored", `heartbeat '${e.params.heartbeatName}' collides with '${hbOwner}'`); continue; }
      if (seenVersion.has(e.params.strategyVersion) || seenHeartbeat.has(e.params.heartbeatName)) {
        refuse(e.def, sleeve, "ignored", `strategyVersion/heartbeatName already used by another observer of ${sleeve}`);
        continue;
      }
      seenVersion.add(e.params.strategyVersion); seenHeartbeat.add(e.params.heartbeatName);
      let plan: PortfolioEnginePlan;
      try {
        const built = buildPortfolioPlan(e.def, now);
        if (built.template !== "portfolio") throw new Error("not a portfolio plan");
        plan = built;
      } catch (err: any) { refuse(e.def, sleeve, "ignored", String(err?.message ?? err)); continue; }

      const venueReason = input.venueReady[e.params.venue];
      if (e.params.runMode === "observer") {
        if (venueReason) { refuse(e.def, sleeve, "ignored", `observer not started: ${venueReason}`); continue; }
        out.observers.push(plan);
        continue;
      }
      const live = liveRefusals(e, input.defs, venueReason, versions);
      if (live.length > 0) { refuse(e.def, sleeve, "live_refused", live.join("; ")); continue; }
      out.live.push(plan);
    }
  }
  return out;
}

/** Everything that must hold before a definition may REPLACE the incumbent. */
function liveRefusals(
  e: { def: PortfolioDefinition; params: PortfolioEngineParams; sleeve: string },
  defs: readonly PortfolioDefinition[],
  venueReason: string | null,
  versions: Readonly<Record<string, readonly ModelVersion[]>>,
): string[] {
  const errors: string[] = [];
  const p = e.params;
  if (venueReason) errors.push(`venue not available: ${venueReason}`);
  // live = tested: the design must still be the one the cutover script wrote.
  if (!p.provenance?.designSha256) errors.push("no provenance (live definitions are written by scripts/portfolio-engine-cutover.ts from a manifest candidate)");
  else if (p.provenance.designSha256 !== designHash(p)) errors.push("the design no longer matches its provenance hash (edited after the cutover script wrote it): live must be the tested design");
  // The scorecard must know the version these rows will carry.
  const list = versions[e.sleeve] ?? [];
  const last = list.length > 0 ? list[list.length - 1].id : null;
  if (last !== p.strategyVersion) {
    errors.push(`strategyVersion '${p.strategyVersion}' is not the LAST entry of MODEL_VERSIONS['${e.sleeve}'] (${last ?? "none"}): append the version in src/portfolio/modelVersions.ts and deploy before going live`);
  }
  if (p.venue === "alpaca" && p.strategy.kind !== "factorCore") {
    const mine = p.strategy.universe;
    const treasury = mine.filter(isTreasurySymbol);
    if (treasury.length > 0) errors.push(`universe holds the treasury sweep's ETF (${treasury.join(", ")})`);
  }
  // Shared wallet: another sleeve of the SAME account (neither this sleeve's incumbent nor another
  // observer) must not trade a symbol this one trades — closePosition aggregates per symbol.
  const mine = new Set(portfolioUniverse("portfolio", p));
  for (const o of defs) {
    if (o.id === e.def.id || o.account !== e.def.account || !o.enabled) continue;
    if (o.id === e.sleeve) continue; // its own incumbent: replaced, not a neighbour
    if (isPe(o)) {
      const op = o.params as PortfolioEngineParams;
      if (op.sleeve === e.sleeve || op.runMode !== "live") continue;
    }
    const overlap = portfolioUniverse(o.template, o.params).filter(s => mine.has(s));
    if (overlap.length > 0) errors.push(`universe overlaps '${o.id}' on account ${o.account}: ${overlap.join(", ")}`);
  }
  return errors;
}

// ── rollback: the rows go back to the incumbent ──────────────────────────────

export interface HandedBackRow { id: string; symbol: string; quantity: number; entryPrice: number; market: string }

/** Rows of the sleeve tagged PORTFOLIO whose manager is the incumbent again: re-tag them to the
 *  incumbent's strategy so the 15s stop loop, the broker-native stop pass and the incumbent's own
 *  close lookups (strategy IN (own, SYNC_RECOVERY)) see them. strategy_version stays: a row belongs
 *  to the version that OPENED it. Idempotent. */
export function handBackPortfolioRows(sleeve: string): HandedBackRow[] {
  const target = PORTFOLIO_SLEEVES[sleeve];
  if (!target) throw new Error(`handBackPortfolioRows: '${sleeve}' is not a portfolio-engine sleeve`);
  const db = getDB();
  return db.transaction((): HandedBackRow[] => {
    const rows = db.prepare(
      `SELECT id, symbol, quantity, entry_price, market FROM trades WHERE account_id = ? AND status = 'open' AND strategy = ?`,
    ).all(sleeve, PORTFOLIO_ENGINE_STRATEGY) as any[];
    const upd = db.prepare(`UPDATE trades SET strategy = ? WHERE id = ? AND status = 'open' AND strategy = ?`);
    const out: HandedBackRow[] = [];
    for (const r of rows) {
      upd.run(target.incumbentStrategy, r.id, PORTFOLIO_ENGINE_STRATEGY);
      out.push({ id: r.id, symbol: r.symbol, quantity: r.quantity, entryPrice: r.entry_price, market: r.market });
      insertActivity(sleeve, "system",
        `portfolio engine no longer manages ${sleeve}: ${r.symbol} (${r.quantity} @ $${Number(r.entry_price).toFixed(4)}) handed back to the incumbent as ${target.incumbentStrategy} (stops re-armed by its machinery)`);
    }
    return out;
  })();
}

export function countOpenPortfolioRows(sleeve: string): number {
  const r = getDB().prepare(`SELECT COUNT(*) AS c FROM trades WHERE account_id = ? AND status = 'open' AND strategy = ?`)
    .get(sleeve, PORTFOLIO_ENGINE_STRATEGY) as any;
  return Number(r?.c) || 0;
}

/** Who manages each sleeve this boot, for the hand-back / orphan step. */
export type SleeveManager = "portfolio_live" | "incumbent" | "none";

export interface RestoreDeps {
  /** After the re-tag: venue-side protection the incumbent's machinery does not re-arm on its own
   *  (Binance: its native stop is armed at open only). true = protected. */
  armStop?: (sleeve: string, row: HandedBackRow) => Promise<boolean>;
  alert: (context: string, message: string) => void;
}

export interface RestoreReport {
  handedBack: Record<string, HandedBackRow[]>;
  /** PORTFOLIO rows with no engine to manage them (sleeve → count): paged, never silent. */
  orphaned: Record<string, number>;
  unprotected: string[];
}

/** Boot step, BEFORE any incumbent engine starts:
 *   - sleeve managed by the incumbent  → its PORTFOLIO rows are handed back (+ stops re-armed);
 *   - sleeve managed by the portfolio engine → nothing (it adopts what is not its own);
 *   - sleeve with no manager (incumbent gated off, venue unlinked…) but PORTFOLIO rows → alert. */
export async function restoreIncumbentRows(managers: Readonly<Record<string, SleeveManager>>, deps: RestoreDeps): Promise<RestoreReport> {
  const report: RestoreReport = { handedBack: {}, orphaned: {}, unprotected: [] };
  for (const sleeve of Object.keys(PORTFOLIO_SLEEVES)) {
    const manager = managers[sleeve] ?? "none";
    if (manager === "portfolio_live") continue;
    if (manager === "none") {
      const n = countOpenPortfolioRows(sleeve);
      if (n > 0) {
        report.orphaned[sleeve] = n;
        deps.alert("PortfolioCutover", `${sleeve}: ${n} open PORTFOLIO row(s) but no engine manages the sleeve (incumbent not running, portfolio engine not live) — they carry no stop; re-enable the incumbent or the portfolio engine`);
      }
      continue;
    }
    const rows = handBackPortfolioRows(sleeve);
    if (rows.length === 0) continue;
    report.handedBack[sleeve] = rows;
    deps.alert("PortfolioCutover", `${sleeve}: portfolio engine is not live — ${rows.length} PORTFOLIO row(s) handed back to the incumbent (${rows.map(r => r.symbol).join(", ")})`);
    if (!deps.armStop) continue;
    for (const row of rows) {
      let ok = false;
      try { ok = await deps.armStop(sleeve, row); } catch { ok = false; }
      if (!ok) {
        report.unprotected.push(`${sleeve}:${row.symbol}`);
        deps.alert("PortfolioCutover", `${sleeve} ${row.symbol}: handed back to the incumbent but its native stop could NOT be armed — protect it manually`);
      }
    }
  }
  return report;
}

/** Last line of defence against two engines on one sleeve: a sleeve whose portfolio engine is live
 *  while its incumbent was built anyway. Construction makes it impossible (the incumbent is gated off
 *  by the cutover set); this proves it at runtime, and the portfolio engine is the one that yields. */
export function sleevesWithTwoManagers(liveSleeves: Iterable<string>, incumbentBuilt: (sleeve: string) => boolean): string[] {
  return [...liveSleeves].filter(incumbentBuilt);
}
