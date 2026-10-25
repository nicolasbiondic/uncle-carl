// Read-only dashboard projection. No broker calls, migrations, state writes or
// strategy decisions: the running engines supply their actual configuration.
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { getETDateKey, getETDayStart } from "../db/database";
import { currentModelVersion } from "../portfolio/modelVersions";
import type { PortfolioStrategyConfig } from "../portfolio-engine/types";
import { HistoricalPriceView } from "../portfolio-engine/live/priceView";
import { decideRegime, type RegimeMemory } from "../portfolio-engine/contingency";
import { isMarketOpen, isTradingDay, getPreviousTradingDay } from "../utils/marketHours";
import type { RiskState } from "../strategies/momentum/RiskGuard";
import type { PersistedOrder } from "../portfolio-engine/live/persistence";

export interface BotNowRuntime {
  id: string;
  engine: "portfolio" | "momentum" | "meanrev";
  maxGrossX: number | null;
  cadenceMinutes: number;
  statePath?: string;
  risk?: Readonly<RiskState>;
  strategy?: PortfolioStrategyConfig;
  version?: string;
}
export interface BotNowEvent {
  at: number;
  portfolioId: string | null;
  kind: "buy" | "sell" | "close" | "resize" | "rebalance" | "pause" | "resume" | "cutover" | "treasury" | "stop" | "error";
  symbol: string | null;
  qty: number | null;
  usd: number | null;
  pnlUsd: number | null;
  reason: string;
  detail: string | null;
  /** rebalance events only: filled buys/sells of the pass (the UI words them). */
  buys?: number;
  sells?: number;
}
export interface BotNowDecision {
  at: number; entries: number; exits: number; resizes: number; orders: number; rejected: number;
  signalsLong: number | null; universe: number | null; note: string | null;
}
export interface BotNowPortfolio {
  id: string; label: string; broker: "alpaca" | "binance";
  engine: BotNowRuntime["engine"]; version: string;
  state: "invested" | "partly_invested" | "flat" | "paused" | "waiting_first_pass" | "error";
  positions: number; investedUsd: number; equityUsd: number; grossX: number; maxGrossX: number | null;
  cadence: { kind: "hourly" | "daily"; at: string };
  lastDecision: BotNowDecision | null; nextDecisionAt: number | null;
  blocked: { reason: string; detail: string; until: number | null } | null;
  regime: { riskOn: boolean; ref: "SPY"; distancePct: number } | null;
  exposureScale: number | null; drawdownPct: number | null;
}
export interface BotNowDeps {
  db: Database;
  runtime: readonly BotNowRuntime[];
  summaries: readonly { id: string; label: string; broker: string; equity: number; mode?: string }[];
  positions?: readonly { profileId?: string; quantity: number; currentPrice: number; avgEntryPrice: number }[];
  historical?: Database | null;
  now?: number;
  readState?: (path: string) => any;
}
const DAY = 86_400_000;
const json = (s: string | null | undefined, fallback: any = {}): any => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const readState = (path: string): any => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

/** NYSE holidays and DST use the same helpers as the engines. This is the
 * next scheduled boundary, not a promise that a blocked entry will execute. */
export function nextBotDecision(now: number, stocks: boolean, minutes: number): number {
  if (!stocks) {
    const period = minutes * 60_000;
    return (Math.floor((now - 15_000) / period) + 1) * period + 15_000;
  }
  const today = getETDateKey(now);
  for (let i = 0; i < 370; i++) {
    const anchor = Date.parse(`${today}T17:00:00Z`) + i * DAY;
    const key = getETDateKey(anchor);
    const at = getETDayStart(anchor) + (9 * 60 + 35) * 60_000;
    if (at > now && isTradingDay(key)) return at;
  }
  throw new Error("NYSE next session unavailable");
}

export function botBlockReason(detail: string): string {
  if (/soft.drawdown/i.test(detail)) return "soft_drawdown";
  if (/hard.drawdown/i.test(detail)) return "hard_drawdown";
  if (/consecutive|loss.streak/i.test(detail)) return "loss_streak";
  if (/daily.loss|daily.cap/i.test(detail)) return "daily_cap";
  if (/maintenance|trading_disabled|TRADING_ENABLED=false|close-only/i.test(detail)) return "maintenance";
  return detail.split(":")[0].trim().replace(/\W+/g, "_").toLowerCase() || "risk_gate";
}

function portfolioCounts(row: any): BotNowDecision {
  const orders = json(row.orders_json, []) as PersistedOrder[];
  const filled = orders.filter(o => (o.result?.filledQty ?? 0) > 0);
  return {
    at: row.decided_at,
    entries: filled.filter(o => o.intent.side === "buy" && o.intent.currentWeight === 0).length,
    exits: filled.filter(o => o.intent.side === "sell" && o.intent.targetWeight === 0).length,
    resizes: filled.filter(o => o.intent.currentWeight > 0 && o.intent.targetWeight > 0).length,
    orders: orders.length,
    rejected: orders.filter(o => o.result && !o.result.ok && o.result.status !== "unknown").length,
    signalsLong: null, universe: null, note: row.note ?? null,
  };
}

function regimeOf(runtime: BotNowRuntime, row: any, historical: Database | null | undefined, now: number): BotNowPortfolio["regime"] {
  const cfg = runtime.strategy;
  if (cfg?.kind !== "volManaged" || !cfg.regimeOverlay) return null;
  const signal = cfg.regimeOverlay.signals.find(s => s.kind === "maTrend" && s.symbol === "SPY" && s.sampling === "daily");
  if (!signal || signal.kind !== "maTrend" || !historical) return null;
  // The prior *version's* memory must never seed the new version's regime.
  const memory = row ? json(row.memory_json)?.portfolioCore?.regime as RegimeMemory | undefined : undefined;
  const today = getETDateKey(now);
  const asOf = row?.as_of ?? getPreviousTradingDay(today);
  const view = new HistoricalPriceView({ db: historical, asOf, symbols: ["SPY"], maxBars: signal.period });
  const bars = view.history("SPY", signal.period);
  if (bars.length < signal.period || view.lastSession("SPY") !== asOf) return null;
  const ma = bars.reduce((sum, b) => sum + b.close, 0) / bars.length;
  const persisted = row ? json(row.diagnostics_json)?.regimeOverlay ?? memory : null;
  const regime = persisted ?? decideRegime(view, cfg.regimeOverlay, undefined, today);
  if (!regime.ready) return null;
  return { riskOn: !regime.riskOff, ref: "SPY", distancePct: (bars.at(-1)!.close / ma - 1) * 100 };
}

/** Exported so the production JSON dump can be replayed against an isolated
 * local DB. Only SELECT statements and file reads occur in this builder. */
export function buildBotNow(deps: BotNowDeps): { asOf: number; portfolios: BotNowPortfolio[]; events: BotNowEvent[] } {
  const { db } = deps;
  const now = deps.now ?? Date.now();
  const since = now - 7 * DAY;
  const activities = db.query("SELECT * FROM activity_log WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC").all(since, now) as any[];
  const orders = db.query(`SELECT o.*, s.reason AS signal_reason FROM orders o LEFT JOIN signals s ON s.id = o.signal_id
    WHERE o.created_at >= ? AND o.created_at <= ? ORDER BY o.created_at DESC`).all(since, now) as any[];
  const peRows = db.query("SELECT * FROM portfolio_decisions WHERE mode = 'live' ORDER BY decided_at DESC, id DESC").all() as any[];
  // The governor owns this table; a fresh installation may not have built
  // it yet. Never initialize/migrate it from a dashboard read.
  const modes = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sleeve_modes'").get()
    ? db.query("SELECT sleeve, mode, reason FROM sleeve_modes").all() as any[] : [];
  const events = buildEvents(db, now, peRows, orders, activities);
  const portfolios = deps.summaries.map((summary): BotNowPortfolio => {
    const runtime = deps.runtime.find(r => r.id === summary.id);
    const current = currentModelVersion(summary.id);
    const engine = runtime?.engine ?? (current?.engine === "portfolio" ? "portfolio" : summary.id.startsWith("meanrev") ? "meanrev" : "momentum");
    const version = current?.id ?? runtime?.version ?? summary.id;
    const stocks = summary.broker === "alpaca";
    const cadenceMinutes = runtime?.cadenceMinutes ?? (stocks || summary.id.endsWith("_usdc") ? 1440 : 60);
    const nextDecisionAt = runtime ? nextBotDecision(now, stocks, cadenceMinutes) : null;
    const rows = db.query("SELECT * FROM trades WHERE account_id = ? AND status = 'open'").all(summary.id) as any[];
    const snap = db.query("SELECT * FROM equity_snapshots WHERE profile_id = ? AND synthetic = 0 ORDER BY snapshot_time DESC LIMIT 1").get(summary.id) as any;
    const equityUsd = finite(summary.equity) ? summary.equity : snap?.equity ?? 0;
    const livePositions = deps.positions?.filter(p => p.profileId === summary.id);
    const positions = livePositions ? livePositions.length : rows.length;
    const investedUsd = livePositions ? livePositions.reduce((sum, p) => sum + Math.abs(p.quantity * (p.currentPrice > 0 ? p.currentPrice : p.avgEntryPrice)), 0)
      : stocks && snap ? Math.max(0, snap.equity - snap.cash) : rows.reduce((sum, r) => sum + Math.abs(r.quantity * r.entry_price), 0);
    const grossX = equityUsd > 0 ? investedUsd / equityUsd : 0;
    const shadow = engine !== "portfolio" && modes.some(m => m.sleeve === summary.id && m.mode === "shadow");
    const persisted = runtime?.statePath ? (deps.readState ?? readState)(runtime.statePath) : null;
    // Portfolio engines do NOT run the incumbent RiskGuard or read its old
    // state files. Those fossil pauses/peaks must not describe the live book.
    const risk = engine === "portfolio" ? null : runtime?.risk ?? persisted?.risk ?? persisted;
    const drawdownPct = finite(risk?.peakEquity) && risk.peakEquity > 0 ? Math.max(0, 1 - equityUsd / risk.peakEquity) * 100 : null;
    const pe = peRows.find(r => r.account_id === summary.id && r.strategy_version === version);
    const pass = engine !== "portfolio" ? db.query("SELECT * FROM decision_passes WHERE account_id = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 1")
      .get(summary.id, current ? Date.parse(current.since) : 0) as any : null;
    const lastDecision: BotNowDecision | null = engine === "portfolio" ? pe ? portfolioCounts(pe) : null : pass ? {
      at: pass.ts, entries: pass.entries, exits: pass.exits,
      resizes: activities.filter(a => a.account_id === summary.id && /^Resized /.test(a.message) && a.created_at >= pass.ts && a.created_at < pass.ts + 30 * 60_000).length,
      orders: pass.entries + pass.exits,
      rejected: orders.filter(o => o.account_id === summary.id && o.created_at >= pass.ts && (o.status === "rejected" || o.state === "REJECTED")).length,
      signalsLong: pass.signals_raw_long ?? pass.signals_long, universe: pass.universe, note: pass.block_note ?? null,
    } : null;
    if (lastDecision && engine !== "portfolio") lastDecision.orders = Math.max(lastDecision.orders + lastDecision.resizes,
      orders.filter(o => o.account_id === summary.id && o.created_at >= lastDecision.at).length);
    if (lastDecision && engine === "portfolio" && runtime?.strategy && "universe" in runtime.strategy) lastDecision.universe = runtime.strategy.universe.length;
    let blocked: BotNowPortfolio["blocked"] = null;
    const paused = risk?.pausedUntil > now;
    if (!runtime || summary.mode === "close-only") blocked = { reason: "maintenance", detail: "Motor no activo; solo conciliación y protección de posiciones", until: null };
    else if (shadow) blocked = { reason: "shadow", detail: "Las nuevas órdenes se simulan; no se envían al broker", until: null };
    else if (paused) blocked = { reason: botBlockReason(risk.pauseReason), detail: risk.pauseReason, until: risk.pausedUntil };
    else if (pe?.status === "failed" || pe?.status === "skipped_stale") blocked = { reason: pe.status, detail: pe.note ?? pe.status, until: null };
    else if (pass?.block_note && Object.values(json(pass.blocks)).some(n => Number(n) > 0)) blocked = { reason: botBlockReason(pass.block_note), detail: pass.block_note, until: null };
    else if (pass && pass.evaluated > 0 && (pass.signals_raw_long ?? pass.signals_long) === 0 && positions === 0) {
      const first = db.query(`SELECT MIN(ts) AS at FROM decision_passes WHERE account_id = ? AND evaluated > 0
        AND ts > COALESCE((SELECT MAX(ts) FROM decision_passes WHERE account_id = ? AND COALESCE(signals_raw_long, signals_long) > 0), 0)`)
        .get(summary.id, summary.id) as any;
      blocked = { reason: "no_signal", detail: `Sin señal larga en ${pass.universe} activos${first?.at ? `; observado desde ${new Date(first.at).toISOString()}` : " en la última decisión"}`, until: null };
    }
    else if (stocks && !isMarketOpen(now)) blocked = { reason: "market_closed", detail: lastDecision ? "NYSE cerrado; el libro sigue abierto" : "NYSE cerrado; la versión actual espera su primera decisión", until: nextDecisionAt };
    const state: BotNowPortfolio["state"] = !runtime || summary.mode === "close-only" || shadow || paused ? "paused"
      : pe?.status === "failed" || pe?.status === "skipped_stale" ? "error"
      : !lastDecision ? "waiting_first_pass" : positions === 0 ? "flat" : grossX < 0.9 ? "partly_invested" : "invested";
    const lastScale = activities.find(a => a.account_id === summary.id && /exposure control: λ ([\d.]+)/.test(a.message));
    const fractions: unknown[] = Object.values(persisted?.exposureFracs ?? {});
    const exposureScale = engine === "momentum" && (fractions.length || lastScale)
      ? lastScale ? Number(lastScale.message.match(/exposure control: λ ([\d.]+)/)[1])
        : fractions.every(v => finite(v) && v === fractions[0]) ? fractions[0] as number : null : null;
    return { id: summary.id, label: summary.label, broker: stocks ? "alpaca" : "binance", engine, version, state,
      positions, investedUsd, equityUsd, grossX, maxGrossX: runtime?.maxGrossX ?? null,
      cadence: { kind: cadenceMinutes >= 1440 || stocks ? "daily" : "hourly", at: stocks ? "09:35 America/New_York" : cadenceMinutes >= 1440 ? "00:00 UTC" : ":00 each hour" },
      lastDecision, nextDecisionAt, blocked, regime: runtime ? regimeOf(runtime, pe, deps.historical, now) : null, exposureScale, drawdownPct };
  });
  return { asOf: now, portfolios, events };
}

function buildEvents(db: Database, now: number, decisions: any[], orders: any[], activities: any[]): BotNowEvent[] {
  const since = now - 7 * DAY;
  const out: BotNowEvent[] = [];
  const base = (at: number, portfolioId: string | null, kind: BotNowEvent["kind"], reason: string): BotNowEvent =>
    ({ at, portfolioId, kind, reason, symbol: null, qty: null, usd: null, pnlUsd: null, detail: null });
  const peIds = new Set<string>();
  for (const d of decisions) {
    const persisted = json(d.orders_json, []) as PersistedOrder[];
    for (const o of persisted) if (o.result?.brokerOrderId) peIds.add(o.result.brokerOrderId);
    if (d.decided_at < since || d.decided_at > now) continue;
    const counts = portfolioCounts(d);
    const filled = persisted.filter(o => (o.result?.filledQty ?? 0) > 0);
    if (filled.length) out.push({ ...base(d.decided_at, d.account_id, "rebalance", "REBALANCE"),
      usd: filled.reduce((s, o) => s + o.result!.filledQty * (o.result!.avgPrice ?? o.intent.notional / o.intent.qty), 0),
      buys: filled.filter(o => o.intent.side === "buy").length, sells: filled.filter(o => o.intent.side === "sell").length, detail: null });
    if (d.status === "failed" || d.status === "skipped_stale" || counts.rejected) out.push({ ...base(d.updated_at, d.account_id, "error", d.status === "submitted" ? "ORDER_REJECTED" : d.status.toUpperCase()), detail: d.note ?? `${counts.rejected} órdenes rechazadas` });
  }
  const closes = db.query("SELECT * FROM trades WHERE status = 'closed' AND exit_time >= ? AND exit_time <= ? ORDER BY exit_time DESC").all(since, now) as any[];
  for (const t of closes) {
    // Portfolio-engine sells are already represented by their one pass event.
    if (t.close_reason === "PORTFOLIO_REBALANCE" && decisions.some(d => d.account_id === t.account_id && json(d.orders_json, []).some((o: PersistedOrder) => o.intent.side === "sell" && o.intent.symbol === t.symbol && (o.result?.filledQty ?? 0) > 0 && Math.abs(d.updated_at - t.exit_time) < 30 * 60_000))) continue;
    const reason = t.close_reason ?? "CLOSE";
    out.push({ ...base(t.exit_time, t.account_id, reason === "MODEL_CUTOVER" ? "cutover" : /STOP/.test(reason) ? "stop" : "close", reason),
      symbol: t.symbol, qty: t.quantity, usd: t.quantity * (t.exit_price ?? 0), pnlUsd: t.pnl ?? null });
  }
  const resizeActivities = activities.filter(a => /^Resized /.test(a.message));
  for (const o of orders) {
    if (peIds.has(o.external_id)) continue;
    const rejected = o.status === "rejected" || o.state === "REJECTED";
    const filled = o.status === "filled" || o.state === "FILLED";
    if (!rejected && !filled) continue;
    if (o.account_id === "treasury") continue; // treasury activity carries sweep vs cover
    const at = o.filled_at ?? o.updated_at ?? o.created_at;
    if (at < since || at > now) continue;
    if (resizeActivities.some(a => a.account_id === o.account_id && a.message.startsWith(`Resized ${o.symbol} `) && Math.abs(a.created_at - at) < 60_000)) continue;
    // Incumbent adapters write entries/add-backs to orders, but closes to
    // trades. A close and a re-entry in the same minute are two real events.
    out.push({ ...base(at, o.account_id, rejected ? "error" : o.side === "buy" ? "buy" : "sell", rejected ? "ORDER_REJECTED" : "ENTRY"),
      symbol: o.symbol, qty: o.cum_qty > 0 ? o.cum_qty : o.quantity,
      usd: filled ? (o.cum_qty > 0 ? o.cum_qty : o.quantity) * (o.filled_price ?? o.avg_px ?? o.price) : null,
      detail: o.signal_reason ?? null });
  }
  for (const a of activities) {
    const msg = String(a.message);
    const resize = msg.match(/^Resized (\S+) ×[\d.]+: ([−+-])([\d.]+) @ \$([\d.]+)/);
    // Signed: a "−" leg is a trim (part of the position sold), "+" an add-back.
    const sign = resize && resize[2] !== "+" ? -1 : 1;
    if (resize) out.push({ ...base(a.created_at, a.account_id, "resize", "EXPOSURE_CONTROL"), symbol: resize[1], qty: sign * Number(resize[3]), usd: sign * Number(resize[3]) * Number(resize[4]), detail: null });
    else if (a.event_type === "treasury") {
      const trade = msg.match(/(BUY|SELL) ([\d.]+) (\S+) @ ~?\$([\d.]+)/);
      out.push({ ...base(a.created_at, null, "treasury", trade?.[1] === "SELL" ? "TREASURY_COVER" : "TREASURY_SWEEP"),
        symbol: trade?.[3] ?? null, qty: trade ? Number(trade[2]) : null, usd: trade ? Number(trade[2]) * Number(trade[4]) : null, detail: msg });
    } else if (/pause_started:|pause_resolved:/.test(msg)) {
      out.push({ ...base(a.created_at, a.account_id, /resolved/.test(msg) ? "resume" : "pause", botBlockReason(msg.replace(/^\w+:\s*/, "")).toUpperCase()), detail: msg });
    } else if (a.event_type === "error" || a.event_type === "broker_error" || a.event_type === "circuit") {
      out.push({ ...base(a.created_at, a.account_id, "error", a.event_type.toUpperCase()), detail: msg });
    }
  }
  return out.filter(e => e.at >= since && e.at <= now && !e.portfolioId?.startsWith("shadow_")).sort((a, b) => b.at - a.at).slice(0, 40);
}
