/**
 * Informe del laboratorio (texto, español):
 *   bun labs/memecoin/report.ts [--hours 24] [--db ruta]
 * `buildReport` es puro sobre la base: lo usan la CLI, el resumen diario a
 * Telegram y los tests.
 */
import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import { DEFAULT_DB_PATH, getMeta, openLabDb } from "./db";
import { REASON_ORDER } from "./strategy";

const REASON_LABEL: Record<string, string> = {
  enter: "entrada",
  too_young: "demasiado joven",
  too_old: "demasiado viejo",
  inactive: "sin actividad",
  data_gap: "hueco de datos",
  migrated: "migrado",
  curve_atypical: "curva atípica",
  top10_concentrated: "top 10 > límite",
  early_wallets: "wallets del primer bloque > límite",
  dev_sold: "el dev vendió",
  low_volume: "volumen bajo",
  few_holders: "pocos holders",
  near_graduation: "cerca de graduar",
  low_net_buy: "SOL neto comprado < A",
  few_buyers: "compradores únicos < N",
  low_buy_sell_ratio: "ratio compras/ventas < R",
  low_score: "score < umbral",
  max_positions: "K posiciones llenas",
  insufficient_balance: "saldo insuficiente",
  already_traded: "ya operado (sin re-entrada)",
  already_open: "ya abierto",
};

const EXIT_LABEL: Record<string, string> = {
  stop: "stop",
  trailing: "trailing",
  take_profit: "toma de ganancia",
  dev_sold: "el dev vendió",
  flow_reversal: "flujo neto se dio la vuelta",
  time_stop: "time stop",
  migration: "migración (salida forzada)",
  hard_max_hold: "5 días (regla dura)",
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d));
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)} %`);
const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const bars = "▁▂▃▄▅▆▇█";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return values.map((v) => bars[hi === lo ? 3 : Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 7.999))]).join("");
}

export function buildReport(db: Database, opts: { hours: number; now: number; dbPath?: string }): string {
  const since = opts.now - opts.hours * 3_600_000;
  const L: string[] = [];
  const version = getMeta(db, "strategy_version") ?? "?";
  const hash = getMeta(db, "config_hash") ?? "?";
  const startedAt = Number(getMeta(db, "started_at") ?? 0);
  const cash = Number(getMeta(db, "cash_sol") ?? 0);
  const lastEq = db.query<any, []>("SELECT * FROM equity ORDER BY at DESC LIMIT 1").get();
  const solUsd = lastEq?.sol_usd ?? null;
  const openPos = db.query<any, []>("SELECT COUNT(*) AS c FROM positions WHERE closed_at IS NULL").get().c;

  L.push(`LABORATORIO MEMECOINS (paper) — últimas ${opts.hours} h — ${when(opts.now)}`);
  L.push(`estrategia ${version} · config ${hash} · desde ${startedAt ? when(startedAt) : "?"}`);
  L.push("");
  L.push("SALDO");
  L.push(`  caja ${f(cash, 4)} SOL · equity ${f(lastEq?.equity_sol ?? cash, 4)} SOL${solUsd ? ` (≈ ${f((lastEq?.equity_sol ?? cash) * solUsd, 0)} USD a ${f(solUsd, 0)} USD/SOL, informativo)` : ""} · posiciones abiertas ${openPos}`);
  const eq = db.query<any, [number]>("SELECT at, equity_sol FROM equity WHERE at >= ? ORDER BY at").all(since);
  if (eq.length > 1) {
    const step = Math.max(1, Math.floor(eq.length / 40));
    const sampled = eq.filter((_, i) => i % step === 0 || i === eq.length - 1).map((r) => r.equity_sol);
    const first = eq[0].equity_sol;
    const last = eq[eq.length - 1].equity_sol;
    const minE = Math.min(...eq.map((r) => r.equity_sol));
    const maxE = Math.max(...eq.map((r) => r.equity_sol));
    L.push(`  curva ${sparkline(sampled)}  ${f(first, 3)} → ${f(last, 3)} SOL (mín ${f(minE, 3)}, máx ${f(maxE, 3)}, ${pct(first > 0 ? (last / first - 1) * 100 : null)})`);
  } else L.push("  curva: sin datos suficientes en la ventana");

  // ── operaciones ─────────────────────────
  const closed = db.query<any, [number]>("SELECT * FROM positions WHERE closed_at IS NOT NULL AND closed_at >= ? ORDER BY closed_at").all(since);
  L.push("");
  L.push("OPERACIONES CERRADAS");
  if (closed.length === 0) L.push("  ninguna en la ventana");
  else {
    const wins = closed.filter((p) => p.pnl_sol > 0).length;
    const pnl = closed.reduce((a, p) => a + p.pnl_sol, 0);
    const costs = closed.reduce((a, p) => a + p.costs_sol, 0);
    const notional = closed.reduce((a, p) => a + p.cost_sol, 0);
    const worst = closed.reduce((a, p) => (p.pnl_pct < a.pnl_pct ? p : a), closed[0]);
    const best = closed.reduce((a, p) => (p.pnl_pct > a.pnl_pct ? p : a), closed[0]);
    const stops = closed.filter((p) => p.close_reason === "stop" && p.stop_gap_pct !== null);
    const gapAvg = stops.length ? stops.reduce((a, p) => a + p.stop_gap_pct, 0) / stops.length : null;
    const holdAvg = closed.reduce((a, p) => a + (p.closed_at - p.opened_at), 0) / closed.length / 60_000;
    const lat = db.query<any, [number]>("SELECT AVG(latency_ms) AS l FROM orders WHERE status = 'filled' AND filled_at >= ?").get(since).l;
    L.push(`  n ${closed.length} · win rate ${f((wins / closed.length) * 100, 0)} % · P&L total ${f(pnl, 4)} SOL · P&L medio ${f(pnl / closed.length, 4)} SOL (${pct(median(closed.map((p) => p.pnl_pct)))} mediana)`);
    L.push(`  peor ${pct(worst.pnl_pct)} (${worst.mint.slice(0, 8)}, ${EXIT_LABEL[worst.close_reason] ?? worst.close_reason}) · mejor ${pct(best.pnl_pct)} (${best.mint.slice(0, 8)})`);
    L.push(`  gap medio del stop ${gapAvg === null ? "— (sin stops)" : `${f(gapAvg, 2)} pp sobre ${stops.length} stops`} · costes ${f(costs, 4)} SOL (${f((costs / notional) * 100, 2)} % del nocional) · latencia media de fill ${f(lat, 0)} ms · duración media ${f(holdAvg, 1)} min`);
    const byReason = new Map<string, { n: number; pnl: number }>();
    for (const p of closed) {
      const r = byReason.get(p.close_reason) ?? { n: 0, pnl: 0 };
      r.n++;
      r.pnl += p.pnl_sol;
      byReason.set(p.close_reason, r);
    }
    L.push(`  cierres: ${[...byReason.entries()].map(([k, v]) => `${EXIT_LABEL[k] ?? k} ${v.n} (${f(v.pnl, 3)} SOL)`).join(" · ")}`);
    const gapped = closed.filter((p) => p.gapped === 1).length;
    if (gapped) L.push(`  ⚠ ${gapped} operación(es) con hueco de datos durante su vida: sus métricas no son exactas`);
  }

  // ── embudo ──────────────────────────────
  const tokensSeen = db.query<any, [number]>("SELECT COUNT(*) AS c FROM tokens WHERE created_at >= ?").get(since).c;
  const decisions = db.query<any, [number]>("SELECT reason, entered, COUNT(*) AS n FROM decisions WHERE decided_at >= ? GROUP BY reason, entered").all(since);
  const nDec = decisions.reduce((a, d) => a + d.n, 0);
  const nEnt = decisions.filter((d) => d.entered === 1).reduce((a, d) => a + d.n, 0);
  L.push("");
  L.push("EMBUDO");
  L.push(`  tokens vistos ${tokensSeen} · candidatos con decisión ${nDec} · entradas ${nEnt}`);
  const ordered = [...decisions].sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason));
  for (const d of ordered) if (d.entered === 0) L.push(`    descarte «${REASON_LABEL[d.reason] ?? d.reason}»: ${d.n}`);

  // ── aprendizaje: desenlace por motivo ────
  L.push("");
  L.push("APRENDIZAJE — desenlace de cada grupo (retorno del PRECIO desde la decisión; sin costes, que rondan el 5 % ida y vuelta)");
  const rows = db
    .query<any, [number]>("SELECT d.reason, d.entered, o.ret_5m, o.ret_1h, o.ret_24h, o.rugged, o.graduated, o.done FROM decisions d JOIN outcomes o ON o.decision_id = d.id WHERE d.decided_at >= ?")
    .all(since);
  interface G {
    n: number;
    r5: number[];
    r1: number[];
    r24: number[];
    rug: number;
    grad: number;
    done: number;
  }
  const groups = new Map<string, G>();
  for (const r of rows) {
    const key = r.entered === 1 ? "enter" : r.reason;
    const g = groups.get(key) ?? { n: 0, r5: [], r1: [], r24: [], rug: 0, grad: 0, done: 0 };
    g.n++;
    if (r.ret_5m !== null) g.r5.push(r.ret_5m);
    if (r.ret_1h !== null) g.r1.push(r.ret_1h);
    if (r.ret_24h !== null) g.r24.push(r.ret_24h);
    g.rug += r.rugged;
    g.grad += r.graduated;
    g.done += r.done;
    groups.set(key, g);
  }
  const line = (key: string, g: G) =>
    `  ${(REASON_LABEL[key] ?? key).padEnd(36)} n ${String(g.n).padStart(4)} · +5m ${pct(median(g.r5)).padStart(8)} (${g.r5.length}) · +1h ${pct(median(g.r1)).padStart(8)} (${g.r1.length}) · +24h ${pct(median(g.r24)).padStart(8)} (${g.r24.length}) · rug ${g.done ? f((g.rug / g.done) * 100, 0) : "—"} % · graduó ${f((g.grad / g.n) * 100, 0)} %`;
  const entered = groups.get("enter");
  if (entered) L.push(line("enter", entered));
  else L.push("  (sin entradas en la ventana)");
  const discardKeys = [...groups.keys()].filter((k) => k !== "enter").sort((a, b) => groups.get(b)!.n - groups.get(a)!.n);
  for (const k of discardKeys) L.push(line(k, groups.get(k)!));

  // ── ranking de qué cambiar ──────────────
  L.push("");
  L.push("QUÉ CAMBIAR (ranking: motivos de descarte cuyos tokens lo hicieron MEJOR a +1 h que las entradas; mediana, mínimo 10 con desenlace)");
  const ref = entered && entered.r1.length >= 5 ? median(entered.r1) : null;
  const ranked = discardKeys
    .map((k) => ({ k, g: groups.get(k)!, m: median(groups.get(k)!.r1) }))
    .filter((x) => x.m !== null && x.g.r1.length >= 10)
    .map((x) => ({ ...x, delta: ref === null ? x.m! : x.m! - ref }))
    .sort((a, b) => b.delta - a.delta);
  if (ranked.length === 0) L.push("  aún no hay suficientes desenlaces a +1 h para comparar");
  else {
    if (ref === null) L.push("  (sin referencia de entradas: se ordena por el retorno absoluto a +1 h de los descartados)");
    for (const x of ranked.slice(0, 8)) {
      const verdict = x.delta > 5 ? "→ relajar: los descartados por este filtro lo hicieron mejor" : x.delta < -5 ? "→ mantener: el filtro evitó pérdidas" : "→ neutro";
      L.push(`  ${(REASON_LABEL[x.k] ?? x.k).padEnd(36)} +1h ${pct(x.m).padStart(8)} (n ${x.g.r1.length}) ${ref !== null ? `vs entradas ${pct(ref)} ` : ""}${verdict}`);
    }
  }

  // ── salud del feed ───────────────────────
  const gaps = db.query<any, [number]>("SELECT from_at, to_at, reason FROM gaps WHERE from_at >= ? ORDER BY from_at").all(since);
  const gapMs = gaps.reduce((a, g) => a + ((g.to_at ?? opts.now) - g.from_at), 0);
  L.push("");
  L.push("FEED Y RECURSOS");
  L.push(`  huecos ${gaps.length} (${f(gapMs / 60_000, 1)} min en total${gaps.some((g) => g.to_at === null) ? ", uno ABIERTO" : ""})`);
  const hb = getMeta(db, "last_heartbeat");
  if (hb) L.push(`  último heartbeat ${hb}`);
  const path = opts.dbPath ?? DEFAULT_DB_PATH;
  try {
    const bytes = statSync(path).size + (statSync(path + "-wal", { throwIfNoEntry: false })?.size ?? 0);
    const raw = db.query<any, []>("SELECT COUNT(*) AS c, MIN(received_at) AS m FROM raw_trades").get();
    const days = raw.m ? Math.max(1 / 24, (opts.now - raw.m) / 86_400_000) : null;
    L.push(`  base ${f(bytes / 1_048_576, 1)} MB · crudos ${raw.c} filas${days ? ` (≈ ${f(bytes / 1_048_576 / days, 1)} MB/día al ritmo actual)` : ""}`);
  } catch {}
  L.push("");
  L.push("No es dinero real. El paper sobreestima: no modela el impacto de nuestra orden sobre los demás, ni tx fallidas por slippage, ni congestión; ver README.");
  return L.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const hours = Number(args[args.indexOf("--hours") + 1] || 24) || 24;
  const dbIdx = args.indexOf("--db");
  const path = dbIdx >= 0 ? args[dbIdx + 1] : DEFAULT_DB_PATH;
  const db = openLabDb(path);
  console.log(buildReport(db, { hours, now: Date.now(), dbPath: path }));
  db.close();
}
