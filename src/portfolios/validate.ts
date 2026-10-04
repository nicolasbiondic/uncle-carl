/**
 * Portfolio write validation (F3d, 2026-10-04 — docs/platform/PLAN.md).
 *
 * Pure: every rule takes the draft + an injected context (existing rows,
 * runtime accounts, account equity reader) and returns ok/errors — no I/O.
 * The routes in src/dashboard/routes/portfolios.ts glue this to the DB.
 *
 * Platform invariants enforced here (owner rules as code):
 *  - capital is fixed per portfolio and the SUM of a broker account's
 *    enabled portfolio capitals never exceeds that account's equity;
 *  - universes of enabled portfolios on the SAME account are DISJOINT
 *    (the shared-wallet rule of AGENTS.md, now checked at write time);
 *  - the four validated presets carry their experiment manifest
 *    (VALIDATED_PRESETS mirrors LIVE_SLEEVE_MANIFESTS — locked by test);
 *    a free template, or ANY param override, is marked `unvalidated`;
 *  - edits apply on the NEXT boot (`pending_restart`), never live;
 *  - archiving is an OWNER action exposed as an explicit flag — nothing
 *    in the platform ever recommends or automates it (the governor only
 *    ever emits RECOMMEND_REDESIGN).
 */
import { DEFAULT_MEANREV_CONFIG } from "../strategies/meanrev/MeanRevEngine";
import { EQUITY_SEMANTICS, type EquitySemantics } from "../strategies/momentum/RiskGuard";
import { builtinPortfolio } from "./builtin";
import type { PlatformPortfolioRow } from "./store";
import type {
  MeanRevConnorsParams,
  MomentumTsmParams,
  PortfolioAccountId,
  PortfolioParams,
  PortfolioTemplate,
} from "./types";

/** The four validated presets — each one IS a live sleeve whose manifest /
 *  artifact justifies its exact params (vivo = validado). The mapping is
 *  locked against src/config/liveSleeveConfigs.ts's LIVE_SLEEVE_MANIFESTS
 *  by validate.test.ts (data mirror, not an import: liveSleeveConfigs
 *  imports src/index.ts and this module sits UNDER it in the import graph). */
export const VALIDATED_PRESETS: Record<string, { template: PortfolioTemplate; manifestPath: string }> = {
  momentum_stocks: { template: "momentum_tsm", manifestPath: "experiments/momentum-stocks-daily-blend3-pure-v1.json" },
  meanrev_stocks: { template: "meanrev_connors", manifestPath: "experiments/meanrev-slot12-pure-v1.json" },
  momentum_crypto: { template: "momentum_tsm", manifestPath: "experiments/momentum-crypto-2026w-control-pure-v1.json" },
  momentum_crypto_usdc: { template: "momentum_tsm", manifestPath: "experiments/momentum-crypto-usdc-daily-s5-pure-v1.json" },
};

/** Which equity semantics each broker account's ledger uses — a portfolio
 *  on an account MUST read that account's semantics, or RiskGuard would
 *  judge one wallet's drawdown with another wallet's equity. */
export const ACCOUNT_EQUITY_SEMANTICS: Record<PortfolioAccountId, EquitySemantics> = {
  alpaca_main: EQUITY_SEMANTICS.SLEEVE_LEDGER,
  binance_usdt: EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN,
  binance_usdc: EQUITY_SEMANTICS.BINANCE_USDC_MARGIN,
  binance_coinm: EQUITY_SEMANTICS.BINANCE_COINM_MARGIN,
};

export interface PortfolioWriteContext {
  /** Existing registry rows (archived included — id uniqueness spans them). */
  existing: PlatformPortfolioRow[];
  /** Broker accounts the runtime actually has wired. */
  accounts: string[];
  /** Injected equity reader; null = unreadable → the write FAILS CLOSED
   *  (an edit is never time-critical, unlike a trading close). */
  accountEquity: (account: string) => number | null;
}

export interface CreatePortfolioRequest {
  id?: unknown;
  name?: unknown;
  account?: unknown;
  capital?: unknown;
  /** One of VALIDATED_PRESETS → params derive from the preset (validated);
   *  omit and supply template+params for a free template (unvalidated). */
  preset?: unknown;
  template?: unknown;
  params?: unknown;
  enabled?: unknown;
}

export interface PatchPortfolioRequest {
  name?: unknown;
  capital?: unknown;
  enabled?: unknown;
  params?: unknown;
  /** Owner action. Never recommended nor automated by the platform. */
  archived?: unknown;
}

export type WriteResult = { ok: true; row: PlatformPortfolioRow } | { ok: false; errors: string[] };

const ID_RE = /^[a-z][a-z0-9_]{2,40}$/;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isInt(v: unknown, min: number, max: number): boolean {
  return isFiniteNum(v) && Number.isInteger(v) && v >= min && v <= max;
}
function inRange(v: unknown, min: number, max: number): boolean {
  return isFiniteNum(v) && v >= min && v <= max;
}

function checkTrailStop(label: string, s: any, errors: string[]): void {
  if (!s || typeof s !== "object") { errors.push(`${label}: must be an object`); return; }
  if (!inRange(s.kSigma, 0.1, 20)) errors.push(`${label}.kSigma: expected 0.1..20`);
  if (!isInt(s.lookbackBars, 2, 400)) errors.push(`${label}.lookbackBars: expected integer 2..400`);
  if (!isFiniteNum(s.minPct) || !isFiniteNum(s.maxPct) || !(s.minPct > 0) || !(s.minPct < s.maxPct) || !(s.maxPct <= 50)) {
    errors.push(`${label}: expected 0 < minPct < maxPct <= 50`);
  }
}

/** Universe a portfolio trades: momentum carries it in params; meanrev's
 *  single source is DEFAULT_MEANREV_CONFIG (index.ts never overrode it). */
export function portfolioUniverse(template: PortfolioTemplate, params: PortfolioParams): string[] {
  if (template === "meanrev_connors") return [...DEFAULT_MEANREV_CONFIG.universe];
  const u = (params as MomentumTsmParams).universe;
  return Array.isArray(u) ? u : [];
}

export function validateMomentumParams(
  p: any,
  account: PortfolioAccountId,
  errors: string[],
  opts?: {
    /** PATCH only: the row's CURRENT cutover — an unchanged value passes
     *  through (seeded rows carry expired one-shots); setting or changing
     *  one via the API is still refused (cutovers are wired in code). */
    permittedCutover?: unknown;
  },
): void {
  if (!p || typeof p !== "object") { errors.push("params: must be an object"); return; }
  if (!Array.isArray(p.universe) || p.universe.length < 1 || p.universe.length > 100 ||
    p.universe.some((s: unknown) => typeof s !== "string" || !s.length) ||
    new Set(p.universe).size !== p.universe.length) {
    errors.push("params.universe: expected 1..100 unique non-empty symbols");
  }
  if (p.rebalanceMinutes !== 60 && p.rebalanceMinutes !== 1440) errors.push("params.rebalanceMinutes: expected 60 or 1440");
  if (p.barMinutes !== 60 && p.barMinutes !== 1440) errors.push("params.barMinutes: expected 60 or 1440");
  if (p.horizon != null) {
    const h = p.horizon;
    const lb = h.lookbackDaysList;
    if (lb !== undefined) {
      if (!Array.isArray(lb) || lb.length < 1 || lb.length > 5 || lb.some((d: unknown) => !isInt(d, 2, 400))) {
        errors.push("params.horizon.lookbackDaysList: expected 1..5 integers in 2..400");
      }
    } else if (!isInt(h.lookbackDays, 2, 400)) {
      errors.push("params.horizon.lookbackDays: expected integer 2..400");
    }
    if (!isInt(h.maLengthDays, 2, 400)) errors.push("params.horizon.maLengthDays: expected integer 2..400");
  } else if (!isInt(p.historyBars, 10, 5000)) {
    errors.push("params.historyBars: expected integer 10..5000 when no daily horizon is set");
  }
  if (!isInt(p.maxLongs, 1, 20)) errors.push("params.maxLongs: expected integer 1..20");
  if (!inRange(p.notionalPctPerSlot, 1e-6, 1)) errors.push("params.notionalPctPerSlot: expected (0, 1]");
  if (isFiniteNum(p.maxLongs) && isFiniteNum(p.notionalPctPerSlot) && p.maxLongs * p.notionalPctPerSlot > 2 + 1e-9) {
    errors.push("params: gross exposure maxLongs × notionalPctPerSlot must be ≤ 2.0×");
  }
  if (p.volTarget != null) {
    const v = p.volTarget;
    if (!inRange(v.annualizedPct, 1, 200)) errors.push("params.volTarget.annualizedPct: expected 1..200");
    if (!isInt(v.lookbackBars, 2, 5000)) errors.push("params.volTarget.lookbackBars: expected integer 2..5000");
    if (!inRange(v.minScale, 0.01, 1) || !inRange(v.maxScale, 1, 3)) errors.push("params.volTarget: expected 0.01 ≤ minScale ≤ 1 ≤ maxScale ≤ 3");
  }
  if (p.tsmTrail != null) checkTrailStop("params.tsmTrail", p.tsmTrail, errors);
  if (p.volStop != null) checkTrailStop("params.volStop", p.volStop, errors);
  if (p.sharpeGate != null) {
    if (!isInt(p.sharpeGate.lookbackDays, 1, 365)) errors.push("params.sharpeGate.lookbackDays: expected integer 1..365");
    if (!inRange(p.sharpeGate.minSharpe, -5, 5)) errors.push("params.sharpeGate.minSharpe: expected -5..5");
  }
  if (p.capacityGuard != null) {
    if (!inRange(p.capacityGuard.maxAdvPct, 1e-6, 100)) errors.push("params.capacityGuard.maxAdvPct: expected (0, 100]");
    if (!isInt(p.capacityGuard.lookbackBars, 2, 400)) errors.push("params.capacityGuard.lookbackBars: expected integer 2..400");
    if (p.capacityGuard.mode !== "observe" && p.capacityGuard.mode !== "enforce") errors.push("params.capacityGuard.mode: expected observe|enforce");
  }
  if (p.cutover != null && JSON.stringify(p.cutover) !== JSON.stringify(opts?.permittedCutover ?? null)) {
    errors.push("params.cutover: one-shot cutovers are wired in code only, not via the API");
  }
  if (p.equitySemantics !== ACCOUNT_EQUITY_SEMANTICS[account]) {
    errors.push(`params.equitySemantics: account '${account}' requires '${ACCOUNT_EQUITY_SEMANTICS[account]}'`);
  }
}

export function validateMeanrevParams(p: any, account: PortfolioAccountId, errors: string[]): void {
  if (!p || typeof p !== "object") { errors.push("params: must be an object"); return; }
  if (account !== "alpaca_main") errors.push("meanrev_connors only runs on alpaca_main");
  checkTrailStop("params.volStop", p.volStop, errors);
  if (p.capacityGuard != null) {
    if (!inRange(p.capacityGuard.maxAdvPct, 1e-6, 100)) errors.push("params.capacityGuard.maxAdvPct: expected (0, 100]");
    if (!isInt(p.capacityGuard.lookbackBars, 2, 400)) errors.push("params.capacityGuard.lookbackBars: expected integer 2..400");
  }
  if (p.equitySemantics !== ACCOUNT_EQUITY_SEMANTICS.alpaca_main) {
    errors.push(`params.equitySemantics: meanrev requires '${ACCOUNT_EQUITY_SEMANTICS.alpaca_main}' (shared Alpaca wallet, sleeve ledger)`);
  }
  if (typeof p.heartbeatName !== "string" || !p.heartbeatName) errors.push("params.heartbeatName: required");
  if (typeof p.schedulerLabel !== "string" || !p.schedulerLabel) errors.push("params.schedulerLabel: required");
}

function checkIdentityParams(p: any, errors: string[]): void {
  if (typeof p?.heartbeatName !== "string" || !p.heartbeatName) errors.push("params.heartbeatName: required");
  if (typeof p?.loggerContext !== "string" || !p.loggerContext) errors.push("params.loggerContext: required");
  const st = p?.state;
  if (!st || typeof st.path !== "string" || !st.path.startsWith("data/") ||
    !isFiniteNum(st.currentBase) || st.currentBase <= 0 || !isFiniteNum(st.legacyBase) || st.legacyBase <= 0) {
    errors.push("params.state: expected { path starting with data/, currentBase > 0, legacyBase > 0 }");
  }
  const gov = p?.governor;
  if (!gov || typeof gov.evidenceVersion !== "string" || !gov.evidenceVersion) errors.push("params.governor.evidenceVersion: required");
}

/** Cross-portfolio invariants: unique id/state path/heartbeat, disjoint
 *  universes per account (ENABLED portfolios only), capital sum ≤ equity. */
function checkCrossPortfolio(
  row: PlatformPortfolioRow,
  ctx: PortfolioWriteContext,
  errors: string[],
  opts: { isNew: boolean },
): void {
  const others = ctx.existing.filter((r) => r.id !== row.id);
  if (opts.isNew && ctx.existing.some((r) => r.id === row.id)) errors.push(`id '${row.id}' already exists`);

  const p: any = row.params;
  for (const o of others) {
    const op: any = o.params;
    if (op?.state?.path && p?.state?.path && op.state.path === p.state.path) errors.push(`params.state.path collides with portfolio '${o.id}'`);
    if (op?.heartbeatName && p?.heartbeatName && op.heartbeatName === p.heartbeatName) errors.push(`params.heartbeatName collides with portfolio '${o.id}'`);
  }

  // Disjoint universes among ENABLED, non-archived portfolios of the SAME
  // account (AGENTS.md shared-wallet rule, enforced at write time).
  if (row.enabled && row.status !== "archived") {
    const mine = new Set(portfolioUniverse(row.template, row.params));
    for (const o of others) {
      if (o.account !== row.account || !o.enabled || o.status === "archived") continue;
      const overlap = portfolioUniverse(o.template, o.params).filter((s) => mine.has(s));
      if (overlap.length) errors.push(`universe overlaps enabled portfolio '${o.id}' on account '${row.account}': ${overlap.join(", ")}`);
    }
  }

  // Fixed capital, and the account's enabled capitals must fit its equity.
  if (!(row.capital > 0)) errors.push("capital: must be > 0");
  if (row.enabled && row.status !== "archived" && row.capital > 0) {
    const equity = ctx.accountEquity(row.account);
    if (equity === null || !Number.isFinite(equity)) {
      errors.push(`account '${row.account}' equity is unreadable — refusing the write (fail closed; retry when the broker answers)`);
    } else {
      const sum = others
        .filter((o) => o.account === row.account && o.enabled && o.status !== "archived")
        .reduce((acc, o) => acc + o.capital, row.capital);
      if (sum > equity + 1e-6) {
        errors.push(`capital: enabled portfolios on '${row.account}' would hold $${sum.toFixed(2)} > account equity $${equity.toFixed(2)}`);
      }
    }
  }
}

/** Preset params re-identified for a NEW portfolio id: per-portfolio state
 *  file, heartbeat and logger must be unique (two portfolios must never
 *  share a RiskState file or a watchdog name). Strategy params stay
 *  byte-identical to the validated preset. */
export function presetParamsFor(preset: string, id: string, capital: number): PortfolioParams {
  const base = builtinPortfolio(preset).params as any;
  const shared = {
    heartbeatName: `${base.heartbeatName.split(":")[0]}:${id}`,
    loggerContext: `${String(base.loggerContext).split(":")[0]}:${id}`,
    state: {
      path: base.state.path.includes("meanrev") ? `data/meanrev-state-${id}.json` : `data/momentum-state-${id}.json`,
      currentBase: capital,
      legacyBase: capital,
    },
    governor: { evidenceVersion: `owner-${id}-v1` },
  };
  if (VALIDATED_PRESETS[preset]?.template === "meanrev_connors") {
    return { ...base, ...shared, schedulerLabel: id } as MeanRevConnorsParams;
  }
  const { cutover: _droppedCutover, ...rest } = base; // one-shots never copy to new portfolios
  return { ...rest, ...shared } as MomentumTsmParams;
}

export function validateCreatePortfolio(req: CreatePortfolioRequest, ctx: PortfolioWriteContext, nowMs: number): WriteResult {
  const errors: string[] = [];
  const id = typeof req.id === "string" ? req.id : "";
  if (!ID_RE.test(id)) errors.push("id: expected /^[a-z][a-z0-9_]{2,40}$/");
  const name = typeof req.name === "string" && req.name.trim().length ? req.name.trim() : "";
  if (!name) errors.push("name: required");
  const account = typeof req.account === "string" ? (req.account as PortfolioAccountId) : ("" as PortfolioAccountId);
  if (!ctx.accounts.includes(account)) errors.push(`account: '${String(req.account)}' is not a runtime broker account (have: ${ctx.accounts.join(", ")})`);
  const capital = isFiniteNum(req.capital) ? req.capital : NaN;
  if (!(capital > 0)) errors.push("capital: must be a number > 0");
  const enabled = req.enabled === undefined ? true : req.enabled === true;

  let template: PortfolioTemplate | null = null;
  let params: PortfolioParams | null = null;
  let validation: "validated" | "unvalidated" = "unvalidated";

  if (req.preset !== undefined) {
    const preset = String(req.preset);
    const meta = VALIDATED_PRESETS[preset];
    if (!meta) {
      errors.push(`preset: '${preset}' is not a validated preset (have: ${Object.keys(VALIDATED_PRESETS).join(", ")})`);
    } else if (errors.length === 0) {
      template = meta.template;
      params = presetParamsFor(preset, id, capital);
      validation = "validated";
      if (req.params !== undefined && req.params !== null) {
        // Any owner override leaves the validated artifact behind.
        params = { ...(params as any), ...(req.params as any) };
        validation = "unvalidated";
      }
    }
  } else {
    // Free template — honest by construction: NOT validated.
    template = req.template === "momentum_tsm" || req.template === "meanrev_connors" ? req.template : null;
    if (!template) errors.push("template: expected momentum_tsm|meanrev_connors (or use a validated preset)");
    params = (req.params && typeof req.params === "object" ? req.params : null) as PortfolioParams | null;
    if (!params) errors.push("params: required for a free template");
    validation = "unvalidated";
  }

  if (errors.length || !template || !params) return { ok: false, errors: errors.length ? errors : ["invalid request"] };

  if (template === "momentum_tsm") validateMomentumParams(params, account, errors);
  else validateMeanrevParams(params, account, errors);
  checkIdentityParams(params, errors);
  if (errors.length) return { ok: false, errors };

  const row: PlatformPortfolioRow = {
    id,
    name,
    template,
    account,
    capital,
    mode: "live", // owner rule: strategies trade; runtime mode overrides live in sleeve_modes
    enabled,
    params,
    status: "pending_restart", // applies on the NEXT boot, never live
    validation,
    source: "owner",
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  checkCrossPortfolio(row, ctx, errors, { isNew: true });
  return errors.length ? { ok: false, errors } : { ok: true, row };
}

export function validatePatchPortfolio(id: string, req: PatchPortfolioRequest, ctx: PortfolioWriteContext, nowMs: number): WriteResult {
  const errors: string[] = [];
  const existing = ctx.existing.find((r) => r.id === id);
  if (!existing) return { ok: false, errors: [`portfolio '${id}' not found`] };

  const row: PlatformPortfolioRow = { ...existing, params: existing.params, updatedAt: nowMs };
  let needsRestart = false;
  let renamed = false;

  if (req.name !== undefined) {
    if (typeof req.name !== "string" || !req.name.trim().length) errors.push("name: must be a non-empty string");
    else if (req.name.trim() !== existing.name) { row.name = req.name.trim(); renamed = true; }
  }
  if (req.capital !== undefined) {
    if (!isFiniteNum(req.capital) || !(req.capital > 0)) errors.push("capital: must be a number > 0");
    else if (req.capital !== existing.capital) { row.capital = req.capital; needsRestart = true; }
  }
  if (req.enabled !== undefined) {
    const en = req.enabled === true;
    if (en !== existing.enabled) { row.enabled = en; needsRestart = true; }
  }
  if (req.archived !== undefined) {
    // OWNER action (explicit flag). The platform never recommends it.
    if (req.archived === true && existing.status !== "archived") { row.status = "archived"; row.enabled = false; needsRestart = true; }
    if (req.archived === false && existing.status === "archived") { row.status = "pending_restart"; needsRestart = true; }
  }
  if (req.params !== undefined) {
    const params = (req.params && typeof req.params === "object" ? req.params : null) as PortfolioParams | null;
    if (!params) {
      errors.push("params: must be an object (full replacement)");
    } else {
      if (row.template === "momentum_tsm") {
        validateMomentumParams(params, row.account, errors, { permittedCutover: (existing.params as any)?.cutover });
      } else {
        validateMeanrevParams(params, row.account, errors);
      }
      checkIdentityParams(params, errors);
      if (!errors.length && JSON.stringify(params) !== JSON.stringify(existing.params)) {
        row.params = params;
        needsRestart = true;
        // Editing a live portfolio's params leaves its validated artifact
        // behind — the UI shows the ⚠ unvalidated state (F3c renderer).
        row.validation = "unvalidated";
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  if (needsRestart && row.status !== "archived") row.status = "pending_restart";
  // Any real edit makes the row the owner's: the boot seed refreshes only
  // untouched 'builtin' rows from builtin.ts and never overwrites this one.
  if (needsRestart || renamed) row.source = "owner";
  checkCrossPortfolio(row, ctx, errors, { isNew: false });
  return errors.length ? { ok: false, errors } : { ok: true, row };
}
