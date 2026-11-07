#!/usr/bin/env bun
/** Hourly read-only runtime guardian. Never imports/starts an executor or initializes a DB.
 * --db/--hist select readonly copies; --now ISO reconstructs rows at that instant,
 * skips broker calls, notification and state writes. Journals are mutable: historical
 * G4 cannot reconstruct a journal updated AFTER --now (reported as unavailable).
 * Historical bars have no ingestion timestamp, so G5 proves session coverage in
 * the supplied snapshot, not when those bars originally arrived.
 * G7 (audit F-2): every cron job's success marker (data/cron-markers, src/ops/cronJobs.ts)
 * is fresh for its schedule; a stale job pages once per episode. Skipped with --now.
 * G8: current live model artifacts exist and runs.jsonl is readable (no cached result).
 * G9: persistent position/target drift over two completed NYSE sessions.
 * G10: current-version sleeve drawdown worse than its stitched OOS worst drawdown.
 * G11: rolling 20-session return below p1 (freeze exception, not the p5 investigation).
 * 0 healthy; 1 invariant violation; 2 operational failure of a check (takes precedence;
 * paged here as an OP:<check> episode); 3 the guardian itself could not run (DB, state file,
 * Telegram) — paged once per episode by scripts/lib/cron-job.sh via guardian.sh.
 * Only --notify updates data/guardian-state.json; --no-notify is a dry run.
 */
// No import-time dotenv: bun loads .env when guardian.sh runs it from the repo root,
// and an import must not repopulate a test process's cleared environment.
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { countExecutedOrders, getETDateKey, getETDayStart } from "../src/db/database";
import { MODEL_VERSIONS } from "../src/portfolio/modelVersions";
import { sleeveExpectationArtifacts, SCORECARD_ENTITIES, readDailyMarks, computeRollingExpectationBand, freezeExceptionStatus, gridDateKey, V8_START } from "../src/portfolio/scorecard";
import { maxHoldExpired } from "../src/portfolio-engine/decide";
import { portfolioDecisionSymbols } from "../src/portfolio-engine/live/PortfolioEngine";
import { STOCKS_RUN_MINUTES_ET } from "../src/portfolio-engine/live/schedule";
import { HistoricalPriceView } from "../src/portfolio-engine/live/priceView";
import { portfolioClientOrderId } from "../src/portfolio-engine/live/clientOrderId";
import type { PersistedOrder } from "../src/portfolio-engine/live/persistence";
import type { PortfolioStrategyConfig } from "../src/portfolio-engine/types";
import { getPreviousTradingDay, getSessionClose, isTradingDay } from "../src/utils/marketHours";
import { isTreasurySymbol } from "../src/treasury/treasurySymbols";
import { loadInstanceConfig } from "../src/platform/instance";
import { alpaca, fapi } from "./broker-truth";
import { cronJobStatuses, CRON_MARKER_DIR } from "../src/ops/cronJobs";

const HOUR = 3_600_000;
const STOCKS = ["momentum_stocks", "meanrev_stocks"] as const;
// Explicit owner-rule scope; do not silently stop checking a disabled sleeve.
const LIVE_SLEEVE_IDS = [...STOCKS, "momentum_crypto", "momentum_crypto_usdc"] as const;
type Check = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9" | "G10" | "G11";
export interface Finding { key: string; check: Check; message: string }
export interface GuardianResult {
  violations: Finding[];
  reports: string[];
  errors: Array<{ check: Check; message: string }>;
  evaluated: Check[];
  /** A missing observation cannot prove recovery for this key/prefix. */
  unavailableKeys?: string[];
}
interface TradeRow {
  id: string; account_id: string; symbol: string; side: string; quantity: number;
  entry_time: number; exit_time: number | null; strategy: string;
}
interface DecisionRow {
  id: number; account_id: string; strategy_version: string; session: string;
  status: string; orders_json: string; decided_at: number; updated_at: number;
}
export interface BrokerPosition { venue: "alpaca" | "fapi"; symbol: string; quantity: number }
export type StockConfigs = Record<(typeof STOCKS)[number], PortfolioStrategyConfig>;

/** Same 09:35 ET constant as the engine, including the EDT/EST transition. */
export function stockPassTime(session: string): number {
  return getETDayStart(Date.parse(`${session}T17:00:00Z`)) + STOCKS_RUN_MINUTES_ET * 60_000;
}

function latestDecisions(db: Database, now: number): DecisionRow[] {
  return db.query(`SELECT id, account_id, strategy_version, session, status, orders_json, decided_at, updated_at
    FROM portfolio_decisions WHERE mode = 'live' AND decided_at <= ?
      AND status IN ('decided', 'submitted') ORDER BY session DESC, decided_at DESC, id DESC`).all(now) as DecisionRow[];
}

/** Current checks use the registry's actual config. Historical runs use the
 * last journal's versioned manifest, never replay today's settings backwards. */
function stockConfigs(db: Database, root: string, now: number, historical: boolean): StockConfigs {
  const out = {} as StockConfigs;
  const decisions = historical ? latestDecisions(db, now) : [];
  for (const sleeve of STOCKS) {
    if (historical) {
      const id = decisions.find(d => d.account_id === sleeve)?.strategy_version;
      const version = id ? MODEL_VERSIONS[sleeve].find(v => v.id === id)
        : MODEL_VERSIONS[sleeve].filter(v => Date.parse(v.since) <= now).at(-1);
      if (!version?.manifest || version.engine !== "portfolio") throw new Error(`no portfolio version at --now: ${sleeve}`);
      const manifest = JSON.parse(readFileSync(resolve(root, version.manifest), "utf8"));
      const candidate = manifest.candidates.find((c: any) => c.name === version.candidate);
      if (!candidate?.portfolio?.strategy) throw new Error(`missing candidate: ${version.id}`);
      out[sleeve] = candidate.portfolio.strategy;
    } else {
      const rows = db.query(`SELECT params_json FROM platform_portfolios WHERE template = 'portfolio'
        AND mode = 'live' AND enabled = 1 AND status != 'archived'`).all() as { params_json: string }[];
      const params = rows.map(r => JSON.parse(r.params_json)).filter(p => p.sleeve === sleeve && p.runMode === "live");
      if (params.length !== 1 || !params[0].strategy) throw new Error(`expected one live portfolio config: ${sleeve}`);
      out[sleeve] = params[0].strategy;
    }
  }
  return out;
}

/** Shared raw GET implementation with broker-truth; no SDK, order or DB side effects. */
export async function readBrokerPositions(): Promise<BrokerPosition[]> {
  for (const key of ["ALPACA_API_KEY", "ALPACA_SECRET_KEY", "BINANCE_FUTURES_API_KEY", "BINANCE_FUTURES_SECRET_KEY"])
    if (!process.env[key]) throw new Error(`missing ${key}`);
  const [stocks, crypto] = await Promise.all([alpaca("/v2/positions"), fapi("/fapi/v2/positionRisk")]);
  if (!Array.isArray(stocks) || !Array.isArray(crypto)) throw new Error("invalid broker positions response");
  for (const p of stocks) if (typeof p?.symbol !== "string" || p.qty == null || !Number.isFinite(Number(p.qty)))
    throw new Error("invalid Alpaca position");
  for (const p of crypto) if (typeof p?.symbol !== "string" || p.positionAmt == null || !Number.isFinite(Number(p.positionAmt)))
    throw new Error("invalid FAPI position");
  return [
    ...stocks.map((p: any): BrokerPosition => ({ venue: "alpaca", symbol: p.symbol,
      quantity: (p.side === "short" ? -1 : 1) * Math.abs(Number(p.qty)) })),
    ...crypto.filter((p: any) => /(?:USDT|USDC)$/.test(p.symbol)).map((p: any): BrokerPosition => ({
      venue: "fapi", symbol: p.symbol, quantity: p.positionSide === "SHORT" ? -Math.abs(Number(p.positionAmt))
        : p.positionSide === "LONG" ? Math.abs(Number(p.positionAmt)) : Number(p.positionAmt),
    })),
  ];
}

function brokerSymbol(symbol: string): string {
  return symbol.endsWith("/USD") ? symbol.replace("/USD", "USDT") : symbol.replace("/", "");
}

export function ledgerDifferences(rows: TradeRow[], positions: BrokerPosition[]): Finding[] {
  const ledger = new Map<string, number>(), broker = new Map<string, number>();
  for (const r of rows) {
    const venue = STOCKS.includes(r.account_id as any) ? "alpaca" : "fapi";
    if (!Number.isFinite(r.quantity) || r.quantity < 0) throw new Error(`invalid row quantity: ${r.id}`);
    const key = `${venue}:${brokerSymbol(r.symbol)}`;
    ledger.set(key, (ledger.get(key) ?? 0) + (["sell", "short"].includes(r.side) ? -1 : 1) * r.quantity);
  }
  for (const p of positions) {
    if (typeof p.symbol !== "string" || !Number.isFinite(p.quantity)) throw new Error("invalid broker quantity/symbol");
    const key = `${p.venue}:${p.symbol}`;
    broker.set(key, (broker.get(key) ?? 0) + p.quantity);
  }
  return [...new Set([...ledger.keys(), ...broker.keys()])].sort().flatMap(key => {
    // Treasury is broker-only, never exempt a ledger row that accidentally owns it.
    if (key.startsWith("alpaca:") && isTreasurySymbol(key.slice(7)) && !ledger.has(key)) return [];
    const a = ledger.get(key) ?? 0, b = broker.get(key) ?? 0;
    if (Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b))) return [];
    return [{ key: `G3:${key}`, check: "G3" as const, message: `${key} ledger=${a} broker=${b}` }];
  });
}

/** Retry fills belong to the original close, not to a second mandatory lot. */
export function mandatoryCloseFindings(d: DecisionRow, orders: PersistedOrder[]): Finding[] {
  const out: Finding[] = [];
  const add = (symbol: string, message: string) => out.push({ key: `G4:${d.account_id}:${symbol}`,
    check: "G4", message: `${d.account_id} ${d.session} ${symbol}: ${message}` });
  for (const o of orders.filter(o => o.intent.maxHold === "close" && !o.clientOrderId?.endsWith("-r1"))) {
    const retry = orders.filter(r => o.clientOrderId && r.clientOrderId === `${o.clientOrderId}-r1`);
    const filled = [o, ...retry].reduce((n, r) => n + (r.applied ? r.result?.filledQty ?? 0 : 0), 0);
    if (filled < o.intent.qty * (1 - 1e-6)) add(o.intent.symbol, `MAX_HOLD incomplete ${filled}/${o.intent.qty} (including -r1)`);
  }
  for (const o of orders.filter(o => o.skipped === "max_hold_close_incomplete")) {
    const existing = out.find(f => f.key === `G4:${d.account_id}:${o.intent.symbol}`);
    if (existing) existing.message += "; rebuy skipped max_hold_close_incomplete";
    else add(o.intent.symbol, "rebuy skipped max_hold_close_incomplete");
  }
  return out;
}

/** Absolute AND relative anchors. In particular a 3% E2 target needs >1pp,
 * not merely 25% of 3%, and a zero target still needs >the absolute band. */
export function positionOffTarget(actual: number, target: number, band: number): boolean {
  const delta = Math.abs(actual - target);
  return delta > band + 1e-12 && delta > Math.abs(target) * 0.25 + 1e-12;
}

/** Reconstruct the session's actual sleeve rows from their pre-pass snapshot
 * and applied fills. Reading today's mutable trades.quantity backwards would
 * silently attribute later trims/add-backs to yesterday. No money recomputation:
 * the denominator is the recorded end-of-session sleeve equity. */
function sessionPositionDrift(db: Database, hist: Database, sleeve: string, session: string, now: number, band: number): Map<string, string> | null {
  const passes = db.query(`SELECT * FROM portfolio_decisions WHERE account_id = ? AND session = ?
    AND mode = 'live' AND decided_at <= ? ORDER BY id DESC`).all(sleeve, session, now) as Array<DecisionRow & {
      book_json: string; weights_json: string;
    }>;
  if (passes.length !== 1 || passes[0].status !== "submitted" || passes[0].updated_at > now) return null;
  const d = passes[0], book: Array<{ symbol: string; qty: number }> = JSON.parse(d.book_json);
  const qty = new Map<string, number>();
  for (const p of book) qty.set(p.symbol, (qty.get(p.symbol) ?? 0) + p.qty);
  const orders: PersistedOrder[] = JSON.parse(d.orders_json);
  for (const o of orders) {
    // Stale-close legs preceded this normal pass's row snapshot, so are already
    // in book_json. Their deterministic hashed IDs also cover the -r1 retry.
    const staleId = portfolioClientOrderId(sleeve, session, o.intent.symbol, "stale-close");
    if (o.clientOrderId === staleId || o.clientOrderId === `${staleId}-r1`) continue;
    if (o.applied && (o.result?.filledQty ?? 0) > 0) {
      if (o.filledAt != null && getETDateKey(o.filledAt) !== session) return null;
      qty.set(o.intent.symbol, (qty.get(o.intent.symbol) ?? 0) + (o.intent.side === "buy" ? 1 : -1) * o.result!.filledQty);
    }
  }
  const targets: Record<string, number> = JSON.parse(d.weights_json);
  const start = getETDayStart(Date.parse(`${session}T17:00:00Z`));
  const end = getETDayStart(Date.parse(`${session}T17:00:00Z`) + 86_400_000);
  const mark = db.query(`SELECT equity FROM equity_snapshots WHERE profile_id = ? AND semantics = 5
    AND synthetic = 0 AND equity > 0 AND snapshot_time >= ? AND snapshot_time < ? AND snapshot_time <= ?
    ORDER BY snapshot_time DESC, id DESC LIMIT 1`).get(sleeve, start + getSessionClose(session).closeMinutes * 60_000, end, now) as { equity: number } | null;
  if (!mark) return null;
  const symbols = [...new Set([...qty.keys(), ...Object.keys(targets)])];
  const view = new HistoricalPriceView({ db: hist, asOf: session, symbols, maxBars: 1 });
  const drift = new Map<string, string>();
  for (const symbol of symbols) {
    const q = qty.get(symbol) ?? 0, target = targets[symbol] ?? 0;
    if (!Number.isFinite(q) || q < -1e-6 || !Number.isFinite(target) || target < 0) throw new Error(`${sleeve} ${session}: invalid quantity/target ${symbol}`);
    if (Math.abs(q) > 1e-6 && view.lastSession(symbol) !== session) return null;
    const actual = Math.max(0, q) * (view.lastClose(symbol) ?? 0) / mark.equity;
    if (positionOffTarget(actual, target, band)) drift.set(symbol, `${session} actual=${actual.toFixed(4)} target=${target.toFixed(4)}`);
  }
  return drift;
}

export async function evaluateGuardian(opts: {
  db: Database; hist: Database; now: number; root?: string; historical?: boolean;
  noBroker?: boolean; broker?: () => Promise<BrokerPosition[]>; configs?: StockConfigs;
  /** Cron marker dir (default <root>/data/cron-markers) and host timezone for G7. */
  cronMarkerDir?: string; cronTz?: string;
}): Promise<GuardianResult> {
  const { db, hist, now } = opts;
  if (!Number.isFinite(now)) throw new Error("invalid --now");
  const result: GuardianResult = { violations: [], reports: [], errors: [], evaluated: [] };
  const run = async (check: Check, fn: () => void | Promise<void>) => {
    try { await fn(); result.evaluated.push(check); }
    catch (e) { result.errors.push({ check, message: String(e instanceof Error ? e.message : e) }); }
  };
  const add = (check: Check, key: string, message: string) => result.violations.push({ check, key: `${check}:${key}`, message });
  const configs = () => opts.configs ?? stockConfigs(db, opts.root ?? resolve(import.meta.dir, ".."), now, opts.historical ?? false);
  const rows = () => db.query(`SELECT id, account_id, symbol, side, quantity, entry_time, exit_time, strategy
    FROM trades WHERE entry_time <= ? AND ((status = 'open' AND exit_time IS NULL) OR exit_time > ?)
    AND account_id IN (${LIVE_SLEEVE_IDS.map(() => "?").join(",")})`).all(now, now, ...LIVE_SLEEVE_IDS) as TradeRow[];
  const today = getETDateKey(now);
  // Before today's pass+grace, yesterday's expired lots still matter (also weekends/holidays).
  const heldSession = isTradingDay(today) && now >= stockPassTime(today) + 30 * 60_000 ? today : getPreviousTradingDay(today);
  await run("G1", () => {
    const cfg = configs();
    for (const r of rows()) {
      if (r.account_id === "momentum_crypto" || r.account_id === "momentum_crypto_usdc") {
        let c: any;
        if (opts.historical) {
          const v = MODEL_VERSIONS[r.account_id].filter(v => Date.parse(v.since) <= now).at(-1);
          if (!v?.manifest) throw new Error(`no historical crypto manifest: ${r.account_id}`);
          const m = JSON.parse(readFileSync(resolve(opts.root ?? resolve(import.meta.dir, ".."), v.manifest), "utf8"));
          c = m.candidates.find((p: any) => !v.candidate || p.name === v.candidate);
        } else {
          const p = db.query("SELECT params_json FROM platform_portfolios WHERE id = ?").get(r.account_id) as { params_json: string } | null;
          if (!p) throw new Error(`missing live crypto params: ${r.account_id}`);
          c = JSON.parse(p.params_json);
        }
        const limit = r.strategy.startsWith("BREAKOUT_") ? c?.breakoutShort?.maxHoldHours : c?.timeStop?.maxHoldHours;
        if (!(limit && limit > 0)) throw new Error(`missing crypto max hold: ${r.account_id}/${r.strategy}`);
        if (now - r.entry_time > (limit + 1) * HOUR)
          add("G1", r.id, `${r.account_id} ${r.symbol} ${r.strategy}: age=${((now - r.entry_time) / HOUR).toFixed(2)}h > ${limit}+1h`);
      } else {
        const c = cfg[r.account_id as keyof StockConfigs];
        const limit = c.kind === "volManaged" ? c.maxHoldSessions : undefined;
        if (!limit) throw new Error(`missing maxHoldSessions: ${r.account_id}`);
        const entrySession = getETDateKey(r.entry_time);
        if (maxHoldExpired(entrySession, heldSession, limit))
          add("G1", r.id, `${r.account_id} ${r.symbol}: entrySession=${entrySession}, still open after session ${heldSession} pass +30m (limit ${limit})`);
      }
    }
  });
  await run("G2", () => {
    const session = isTradingDay(today) && now >= stockPassTime(today) + 55 * 60_000 ? today : getPreviousTradingDay(today);
    const decisions = latestDecisions(db, now);
    for (const sleeve of STOCKS) {
      const count = decisions.filter(d => d.account_id === sleeve && d.session === session).length;
      if (count !== 1) add("G2", `${sleeve}:${count ? "duplicate" : "missed"}`,
        `${sleeve} ${session}: ${count ? "duplicate pass" : "missed pass"} (${count} live decisions)`);
    }
    for (const [sleeve, hours] of [["momentum_crypto", 2], ["momentum_crypto_usdc", 26]] as const) {
      const last = db.query("SELECT MAX(ts) ts FROM decision_passes WHERE account_id = ? AND ts <= ?").get(sleeve, now) as { ts: number | null };
      if (last.ts === null || now - last.ts > hours * HOUR)
        add("G2", `${sleeve}:missed`, `${sleeve}: missed pass, latest=${last.ts === null ? "none" : new Date(last.ts).toISOString()} (> ${hours}h)`);
    }
  });
  if (!opts.noBroker && !opts.historical) await run("G3", async () => {
    const positions = await (opts.broker ?? readBrokerPositions)();
    result.violations.push(...ledgerDifferences(rows(), positions));
  });
  else result.reports.push("G3 skipped (--no-broker/--now)");
  await run("G4", () => {
    const decisions = latestDecisions(db, now);
    for (const sleeve of STOCKS) {
      const d = decisions.find(d => d.account_id === sleeve);
      if (!d) continue; // missing decisions are G2's responsibility
      if (d.updated_at > now) throw new Error(`${sleeve}: journal updated after --now; historical G4 unavailable`);
      const orders: PersistedOrder[] = JSON.parse(d.orders_json);
      result.violations.push(...mandatoryCloseFindings(d, orders));
      for (const o of orders.filter(o => !o.intent.maxHold && (o.skipped || !o.result?.ok || o.result.filledQty < o.intent.qty * (1 - 1e-6))))
        result.reports.push(`G4 ${sleeve} ${d.session} resize ${o.intent.symbol}: ${o.result?.filledQty ?? 0}/${o.intent.qty} ${o.skipped ?? o.result?.status ?? "unfilled"}`);
    }
  });
  if (isTradingDay(today) && now >= Date.parse(`${today}T13:00:00Z`)) await run("G5", () => {
    // Continue checking after the pass: an outage must not auto-clear at 09:35.
    const cfg = configs(), asOf = getPreviousTradingDay(today);
    for (const sleeve of STOCKS) {
      const symbols = portfolioDecisionSymbols(cfg[sleeve], undefined, asOf, {}, today);
      const required = [...new Set([...symbols.all, ...symbols.required])];
      const view = new HistoricalPriceView({ db: hist, asOf, symbols: required, maxBars: 1 });
      for (const symbol of required) if (view.lastSession(symbol) !== asOf)
        add("G5", `${sleeve}:${symbol}`, `${sleeve} ${symbol}: missing daily bar for ${asOf}`);
    }
  });
  else result.reports.push("G5 not due (NYSE sessions from 13:00 UTC); previous episode retained");
  await run("G6", () => {
    const orders = countExecutedOrders(getETDayStart(now), now, undefined, db);
    const restarts = db.query(`SELECT COUNT(*) n FROM activity_log WHERE event_type = 'system'
      AND message LIKE 'Account manager started%' AND created_at > ? AND created_at <= ?`).get(now - 24 * HOUR, now) as { n: number };
    const target = loadInstanceConfig().kpiTargets.tradesPerDay;
    result.reports.push(`G6 executed orders today (ET): ${orders} / KPI_TARGET_TRADES_PER_DAY=${target ?? "unset"}; starts last 24h: ${restarts.n} (Account manager started events)`);
  });
  // G7 — the dead-man's switch. The guardian's own marker is written by its
  // wrapper after this run, and its staleness is what /healthz stale_jobs and
  // the outside uptime-watch catch; judging it here would only page itself.
  if (!opts.historical) await run("G7", () => {
    const dir = opts.cronMarkerDir ?? resolve(opts.root ?? resolve(import.meta.dir, ".."), CRON_MARKER_DIR);
    const statuses = cronJobStatuses({ dir, now, tz: opts.cronTz }).filter(s => s.name !== "guardian");
    for (const s of statuses) if (s.stale)
      add("G7", s.name, `cron ${s.name}: no success since its run due ${new Date(s.dueRunMs!).toISOString()} (last ok ${s.lastOkMs ? new Date(s.lastOkMs).toISOString() : "never"})`);
  });
  else result.reports.push("G7 skipped (--now: markers are not historical)");
  // G8 — research artifacts are gitignored: deploying code is not enough.
  // Read the filesystem on EVERY check, not the scorecard's positive memo.
  if (!opts.historical) await run("G8", () => {
    const artifacts = sleeveExpectationArtifacts();
    for (const sleeve of LIVE_SLEEVE_IDS) {
      const v = MODEL_VERSIONS[sleeve].at(-1)!;
      const ref = artifacts[sleeve];
      try {
        if (!ref) throw new Error("no authoritative artifact configured");
        const dir = resolve(opts.root ?? resolve(import.meta.dir, ".."), ref.dir);
        if (!statSync(dir).isDirectory()) throw new Error("artifact path is not a directory");
        if (!readFileSync(resolve(dir, "runs.jsonl"), "utf8").trim()) throw new Error("runs.jsonl is empty");
        const dd = JSON.parse(readFileSync(resolve(dir, "summary.json"), "utf8")).stitchedOos?.maxDrawdown;
        if (!Number.isFinite(dd) || dd < 0 || dd > 1) throw new Error("summary.json has no valid stitchedOos.maxDrawdown");
      } catch (e) {
        add("G8", sleeve, `${v.id}: expectation artifact missing/unreadable (${ref?.dir ?? "none"}): ${e instanceof Error ? e.message : e}`);
      }
    }
  });
  else result.reports.push("G8 skipped (--now: host artifacts are not historical)");
  await run("G9", () => {
    // Respect early closes and DST. A pass finishing in the morning does not
    // make that session complete; after the close it also needs its close mark.
    const last = isTradingDay(today) && now >= getETDayStart(now) + getSessionClose(today).closeMinutes * 60_000
      ? today : getPreviousTradingDay(today);
    const previous = getPreviousTradingDay(last);
    const definitions = db.query(`SELECT params_json FROM platform_portfolios WHERE template = 'portfolio'
      AND mode = 'live' AND enabled = 1 AND status != 'archived'`).all() as { params_json: string }[];
    for (const sleeve of STOCKS) {
      const params = definitions.map(r => JSON.parse(r.params_json)).filter(p => p.sleeve === sleeve && p.runMode === "live");
      if (params.length !== 1 || !Number.isFinite(params[0].rebalanceBand) || params[0].rebalanceBand < 0)
        throw new Error(`${sleeve}: missing live definition rebalanceBand`);
      const band = params[0].rebalanceBand;
      const a = sessionPositionDrift(db, hist, sleeve, previous, now, band);
      const b = sessionPositionDrift(db, hist, sleeve, last, now, band);
      if (!a || !b) {
        (result.unavailableKeys ??= []).push(`G9:${sleeve}`);
        result.reports.push(`G9 ${sleeve}: ${previous}/${last} incomplete, stale/skipped or missing prices/marks; episode retained`);
        continue;
      }
      const persistent = [...b.keys()].filter(symbol => a.has(symbol));
      for (const symbol of persistent) add("G9", `${sleeve}:${symbol}`,
        `${sleeve} ${symbol}: posición fuera del objetivo dos sesiones consecutivas (${a.get(symbol)}; ${b.get(symbol)}); > banda absoluta ${band} Y >25% del objetivo. Investigar; sin cambiar la operativa.`);
      result.reports.push(`G9 ${sleeve}: ${previous}/${last}, band=${band}, persistent drift=${persistent.join(",") || "none"}`);
    }
  });
  if (!opts.historical) await run("G10", () => {
    const artifacts = sleeveExpectationArtifacts();
    for (const e of SCORECARD_ENTITIES.filter(e => e.kind === "sleeve")) {
      const v = MODEL_VERSIONS[e.id].at(-1)!;
      if (result.errors.some(f => f.check === "G8") || result.violations.some(f => f.key === `G8:${e.id}`)) {
        (result.unavailableKeys ??= []).push(`G10:${e.id}`);
        result.reports.push(`G10 ${e.id}: artifact unavailable (G8); episode retained`);
        continue;
      }
      const ref = artifacts[e.id];
      const worst = JSON.parse(readFileSync(resolve(opts.root ?? resolve(import.meta.dir, ".."), ref.dir, "summary.json"), "utf8")).stitchedOos.maxDrawdown;
      const snapshots = db.query(`SELECT equity, snapshot_time FROM equity_snapshots WHERE profile_id = ?
        AND semantics = 5 AND synthetic = 0 AND equity > 0 AND snapshot_time <= ? ORDER BY snapshot_time, id`).all(e.id, now) as { equity: number; snapshot_time: number }[];
      const start = snapshots.findIndex(s => v.modelStart != null && gridDateKey(s.snapshot_time, e.grid) >= v.modelStart);
      if (start < 0) {
        (result.unavailableKeys ??= []).push(`G10:${e.id}`);
        result.reports.push(`G10 ${e.id}: no marks for current version; episode retained`);
        continue;
      }
      // Include the last pre-model close as the base, just like the model band.
      const window = snapshots.slice(Math.max(0, start - 1));
      const peak = window.reduce((peak, s) => Math.max(peak, s.equity), 0);
      const dd = 1 - window.at(-1)!.equity / peak;
      // Reported, not paged: the sleeve's fall from its peak since V8 spans retired models too, so a
      // version change cannot hide a long slide from whoever reads the report.
      const sinceV8 = snapshots.filter(s => gridDateKey(s.snapshot_time, e.grid) >= V8_START);
      const sleevePeak = sinceV8.reduce((p, s) => Math.max(p, s.equity), 0);
      const sleeveDd = sleevePeak > 0 ? 1 - sinceV8.at(-1)!.equity / sleevePeak : null;
      result.reports.push(`G10 ${v.id}: current DD=${(dd * 100).toFixed(2)}%, OOS worst=${(worst * 100).toFixed(2)}%`
        + (sleeveDd === null ? "" : `; sleeve DD from its peak since ${V8_START}=${(sleeveDd * 100).toFixed(2)}% (reported only)`));
      if (dd > worst) add("G10", e.id, `${v.id}: caída peor que la peor del backtest (vivo ${(dd * 100).toFixed(2)}% > OOS ${(worst * 100).toFixed(2)}%). Investigar solamente; nunca un veto ni un límite por sleeve del presupuesto de cuenta.`);
    }
  });
  else result.reports.push("G10 skipped (--now: host artifacts are not historical)");
  // G11 is distinct from Telegram's p5 investigation episodes. No action on trading.
  if (!opts.historical) await run("G11", () => {
    const artifacts = Object.fromEntries(Object.entries(sleeveExpectationArtifacts()).map(([id, ref]) =>
      [id, { ...ref, dir: resolve(opts.root ?? resolve(import.meta.dir, ".."), ref.dir) }]));
    for (const e of SCORECARD_ENTITIES.filter(e => e.kind === "sleeve")) {
      if (result.errors.some(f => f.check === "G8") || result.violations.some(f => f.key === `G8:${e.id}`)) {
        (result.unavailableKeys ??= []).push(`G11:${e.id}`);
        result.reports.push(`G11 ${e.id}: artifact unavailable (G8); episode retained`);
        continue;
      }
      const band = computeRollingExpectationBand(e, readDailyMarks(db, e.id, e.grid, now), now, artifacts);
      const status = freezeExceptionStatus(band);
      if (status === "below") add("G11", e.id,
        `${e.id}: excepción de la congelación: últimas 20 sesiones bajo el p1 (vivo ${band.liveCumReturnPct!.toFixed(2)}%, p1 ${band.cumReturnPct!.p1.toFixed(2)}%). Investigar; sin cambiar la operativa.`);
      else if (status === "unavailable" || status === "insufficient_data") {
        (result.unavailableKeys ??= []).push(`G11:${e.id}`);
        result.reports.push(`G11 ${e.id}: ${band.reason ?? status}; episode retained`);
      }
    }
  });
  else result.reports.push("G11 skipped (--now: host artifacts are not historical)");
  return result;
}

export function guardianExitCode(r: GuardianResult): 0 | 1 | 2 {
  return r.errors.length ? 2 : r.violations.length ? 1 : 0;
}
export interface EpisodeState { version: 1; active: Record<string, { check: Check; message: string; since: number }> }
export function episodeTransitions(previous: EpisodeState, r: GuardianResult, now: number): { state: EpisodeState; events: string[] } {
  const active = { ...previous.active }, events: string[] = [];
  const findings = [...r.violations, ...r.errors.map(e => ({ key: `OP:${e.check}`, check: e.check, message: `operational failure: ${e.message}` }))];
  const known = new Set([...r.evaluated, ...r.errors.map(e => e.check)]);
  const failed = new Set(r.errors.map(e => e.check));
  const current = new Map(findings.map(f => [f.key, f]));
  for (const [key, old] of Object.entries(active)) {
    // An unreadable/skipped check cannot prove an old violation cleared.
    if (!known.has(old.check) || (!key.startsWith("OP:") && failed.has(old.check)) ||
      r.unavailableKeys?.some(prefix => key === prefix || key.startsWith(`${prefix}:`))) continue;
    if (!current.has(key)) { events.push(`GUARDIAN CLEARED ${key}: ${old.message}`); delete active[key]; }
  }
  for (const f of findings) {
    if (!active[f.key]) { events.push(`GUARDIAN ${f.key.startsWith("OP:") ? "ERROR" : "PAGE"} ${f.key}: ${f.message}`); active[f.key] = { check: f.check, message: f.message, since: now }; }
  }
  return { state: { version: 1, active }, events };
}

function readState(path: string): EpisodeState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    if (s.version !== 1 || !s.active || typeof s.active !== "object" || Array.isArray(s.active)) throw new Error("invalid guardian state");
    for (const v of Object.values(s.active) as any[]) if (!v || !/^G(?:[1-9]|10|11)$/.test(v.check) || typeof v.message !== "string" || !Number.isFinite(v.since)) throw new Error("invalid guardian episode");
    return s;
  } catch (e: any) { if (e.code === "ENOENT") return { version: 1, active: {} }; throw e; }
}
export function writeState(path: string, state: EpisodeState): void {
  const temp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temp, JSON.stringify(state) + "\n", { mode: 0o600 }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch (e: any) { if (e.code !== "ENOENT") throw e; } }
}
async function notifyOps(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_OPS_CHAT_ID;
  if (!token || !chat) throw new Error("--notify needs TELEGRAM_BOT_TOKEN + TELEGRAM_OPS_CHAT_ID (no user-chat fallback)");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000) }), signal: AbortSignal.timeout(15_000) });
  if (!r.ok || !(await r.json() as any).ok) throw new Error(`guardian Telegram failed HTTP ${r.status}`);
}

export async function guardianMain(args = process.argv.slice(2)): Promise<number> {
  let dbPath = "data/trading.db", histPath = "data/historical.db", statePath = "data/guardian-state.json";
  let now = Date.now(), historical = false, noBroker = false, notify = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--db", "--hist", "--state", "--now"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      if (arg === "--db") dbPath = value;
      if (arg === "--hist") histPath = value;
      if (arg === "--state") statePath = value;
      if (arg === "--now") { now = Date.parse(value); historical = true; if (!Number.isFinite(now)) throw new Error("invalid --now"); }
    } else if (arg === "--notify") notify = true;
    else if (arg === "--no-notify") notify = false;
    else if (arg === "--no-broker") noBroker = true;
    else throw new Error(`unknown option ${arg}`);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const hist = new Database(histPath, { readonly: true });
    try {
      const r = await evaluateGuardian({ db, hist, now, historical, noBroker });
      console.log(`GUARDIAN ${new Date(now).toISOString()}${historical ? " (historical; no notify/state)" : ""}`);
      for (const f of r.violations) console.log(`PAGE ${f.key}: ${f.message}`);
      for (const e of r.errors) console.error(`ERROR ${e.check}: ${e.message}`);
      for (const line of r.reports) console.log(`REPORT ${line}`);
      console.log(`GUARDIAN ${r.errors.length ? "ERROR" : r.violations.length ? "VIOLATION" : "OK"}: ${r.violations.length} violations, ${r.errors.length} operational failures`);
      if (notify && !historical) {
        const previous = readState(statePath);
        const transitions = episodeTransitions(previous, r, now);
        // Persist after EACH acknowledged notification; a later send failure must
        // not consume unsent events or re-page already acknowledged transitions.
        for (const event of transitions.events) {
          await notifyOps(event);
          const key = event.split(": ")[0].split(" ").at(-1)!;
          if (transitions.state.active[key]) previous.active[key] = transitions.state.active[key];
          else delete previous.active[key];
          writeState(statePath, previous);
        }
      }
      return guardianExitCode(r);
    } finally { hist.close(); }
  } finally { db.close(); }
}
if (import.meta.main) {
  try { process.exitCode = await guardianMain(); }
  catch (e) { console.error(`GUARDIAN operational failure: ${e instanceof Error ? e.message : e}`); process.exitCode = 3; }
}
