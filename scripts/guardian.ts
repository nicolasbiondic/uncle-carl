#!/usr/bin/env bun
/** Hourly read-only runtime guardian. Never imports/starts an executor or initializes a DB.
 * --db/--hist select readonly copies; --now ISO reconstructs rows at that instant,
 * skips broker calls, notification and state writes. Journals are mutable: historical
 * G4 cannot reconstruct a journal updated AFTER --now (reported as unavailable).
 * Historical bars have no ingestion timestamp, so G5 proves session coverage in
 * the supplied snapshot, not when those bars originally arrived.
 * 0 healthy; 1 invariant violation; 2 operational failure (takes precedence).
 * Only --notify updates data/guardian-state.json; --no-notify is a dry run.
 */
// No import-time dotenv: bun loads .env when guardian.sh runs it from the repo root,
// and an import must not repopulate a test process's cleared environment.
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { countExecutedOrders, getETDateKey, getETDayStart } from "../src/db/database";
import { MODEL_VERSIONS } from "../src/portfolio/modelVersions";
import { maxHoldExpired } from "../src/portfolio-engine/decide";
import { portfolioDecisionSymbols } from "../src/portfolio-engine/live/PortfolioEngine";
import { STOCKS_RUN_MINUTES_ET } from "../src/portfolio-engine/live/schedule";
import { HistoricalPriceView } from "../src/portfolio-engine/live/priceView";
import type { PersistedOrder } from "../src/portfolio-engine/live/persistence";
import type { PortfolioStrategyConfig } from "../src/portfolio-engine/types";
import { getPreviousTradingDay, isTradingDay } from "../src/utils/marketHours";
import { isTreasurySymbol } from "../src/treasury/treasurySymbols";
import { loadInstanceConfig } from "../src/platform/instance";
import { alpaca, fapi } from "./broker-truth";

const HOUR = 3_600_000;
const STOCKS = ["momentum_stocks", "meanrev_stocks"] as const;
// Explicit owner-rule scope; do not silently stop checking a disabled sleeve.
const LIVE_SLEEVE_IDS = [...STOCKS, "momentum_crypto", "momentum_crypto_usdc"] as const;
type Check = "G1" | "G2" | "G3" | "G4" | "G5" | "G6";
export interface Finding { key: string; check: Check; message: string }
export interface GuardianResult {
  violations: Finding[];
  reports: string[];
  errors: Array<{ check: Check; message: string }>;
  evaluated: Check[];
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

export async function evaluateGuardian(opts: {
  db: Database; hist: Database; now: number; root?: string; historical?: boolean;
  noBroker?: boolean; broker?: () => Promise<BrokerPosition[]>; configs?: StockConfigs;
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
    if (!known.has(old.check) || (!key.startsWith("OP:") && failed.has(old.check))) continue;
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
    for (const v of Object.values(s.active) as any[]) if (!v || !/^G[1-6]$/.test(v.check) || typeof v.message !== "string" || !Number.isFinite(v.since)) throw new Error("invalid guardian episode");
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
  catch (e) { console.error(`GUARDIAN operational failure: ${e instanceof Error ? e.message : e}`); process.exitCode = 2; }
}
