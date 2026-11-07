// ── activity.js — "Actividad" page: the existing operations history (closed
// trades) + the activity log, as a full page of the portfolio-manager nav.
import { api } from "../api.js";
import { t, store, sleeveLabel } from "../store.js";
import { esc } from "../ui.js";
import { etStamp } from "../fmt.js";
import { renderTrades } from "./trades.js";
import { viewChip } from "./viewchip.js";

/** One activity-log row in plain words. The log's own sentences are the
 *  engine's English, with ids and numbers meant for the operator, so they are
 *  never printed: the line is built from the event type and, when the
 *  sentence names one, the symbol. Pure. */
export function activityText(a) {
  const msg = String(a?.message || "");
  const type = String(a?.event_type || "");
  const resize = /^Resized (\S+) ×[\d.]+: ([−+-])/.exec(msg);
  if (resize) return resize[2] === "+" ? t(`Added to ${resize[1]}`, `Amplió ${resize[1]}`) : t(`Trimmed ${resize[1]}`, `Recortó ${resize[1]}`);
  const gone = /^(\S+) closed externally|^Position (\S+) closed on broker/.exec(msg);
  if (gone) return t(`${gone[1] || gone[2]} closed at the broker`, `${gone[1] || gone[2]} cerrada en el broker`);
  const found = /^Found (\S+) on /.exec(msg);
  if (found) return t(`${found[1]} found at the broker`, `${found[1]} encontrada en el broker`);
  if (/RECOMMEND_REDESIGN/.test(msg)) return t("The model is losing money: a redesign is recommended, trading continues", "El modelo está perdiendo: se recomienda rediseñarlo, sigue operando");
  if (/RECOMMEND_PROMOTE/.test(msg)) return t("A simulated model is ready for review", "Un modelo simulado está listo para revisión");
  // The two commonest rows in prod ("SELL 928.8 XRP/USDC @ $1.18", "NEAR/USDC PnL $-193.85 (-19.3%)")
  // keep what happened and to which symbol; quantities and prices stay out.
  const order = /^(BUY|SELL) [\d.]+ (\S+)/.exec(msg);
  if (type === "order" && order) return order[1] === "BUY" ? t(`Bought ${order[2]}`, `Compró ${order[2]}`) : t(`Sold ${order[2]}`, `Vendió ${order[2]}`);
  const closed = /^(\S+) PnL \$?(-?[\d.,]+)/.exec(msg);
  if (type === "close" && closed) {
    const v = Math.round(Number(closed[2].replace(/,/g, "")));
    const usd = Number.isFinite(v) ? ` ${v < 0 ? "−" : "+"}$${Math.abs(v).toLocaleString("en-US")}` : "";
    return t(`Closed ${closed[1]}${usd}`, `Cerró ${closed[1]}${usd}`);
  }
  switch (type) {
    case "trade": return t("Trade", "Operación");
    case "close": return t("Position closed", "Posición cerrada");
    case "sync": return t("Matched to the broker", "Ajuste con el broker");
    case "treasury": return t("Idle cash moved", "Efectivo ocioso movido");
    case "broker_error": return t("Broker problem", "Problema con el broker");
    case "error": return t("Problem", "Problema");
    case "circuit": return t("Safety notice", "Aviso de seguridad");
    case "system": return t("System notice", "Aviso del sistema");
    default: return t("Notice", "Aviso");
  }
}

export function activityLogHtml(items) {
  if (!items?.length) return `<div class="empty">${t("No recent activity", "Sin actividad reciente")}</div>`;
  const known = new Set((store.state.dashboard?.accounts || []).map((x) => x.id));
  return `<div class="act-log">${items.map((a) => {
    const who = a.account_id && known.has(a.account_id) ? `<span class="muted">${esc(sleeveLabel({ id: a.account_id }))}</span> · ` : "";
    return `<div class="act-row"><span class="muted">${esc(etStamp(a.created_at))}</span> ${who}${esc(activityText(a))}</div>`;
  }).join("")}</div>`;
}

// ── "Quórum IA (sombra)" panel — línea D (docs/reports/LD-quorum-ia.md).
// Shadow experiment, zero capital; its trades NEVER count toward the volume
// KPI, which is why they render on their own panel here and nowhere else.
const V_GLYPH = { long: "▲", short: "▼", neutral: "·" };
const fmtSharpe = (v) => (v == null ? "—" : v.toFixed(2));
const fmtHit = (v) => (v == null ? "—" : Math.round(v * 100) + "%");

function quorumCurveSvg(curve) {
  if (!curve?.length) return "";
  const w = 280, h = 48, pad = 2;
  const vals = curve.map((p) => p.cum);
  const min = Math.min(...vals, 1), max = Math.max(...vals, 1);
  const span = max - min || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(curve.length - 1, 1);
  const y = (v) => h - pad - ((v - min) * (h - 2 * pad)) / span;
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
    <path d="M${x(0).toFixed(1)},${y(1).toFixed(1)} L${x(curve.length - 1).toFixed(1)},${y(1).toFixed(1)}" stroke="var(--border)" stroke-dasharray="3 3" fill="none"/>
    <path d="${d}" stroke="${last >= 1 ? "var(--green, #3fb950)" : "var(--red, #f85149)"}" fill="none" stroke-width="1.5"/></svg>`;
}

function quorumStatsHtml(stats) {
  if (!stats) return "";
  const rows = [
    [t("Quorum book", "Libro del quórum"), stats.book],
    ...Object.entries(stats.models || {}).map(([id, s]) => [esc(id), s]),
    [t("Benchmark: equal-weight long", "Referencia: largo equiponderado"), stats.benchEwLong],
    [t("Benchmark: 21d momentum sign", "Referencia: signo momentum 21d"), stats.benchMom21],
  ];
  return `<div class="scroll"><table class="table" style="font-size:var(--t-xs)"><thead><tr>
      <th>${t("Series", "Serie")}</th><th>Sharpe</th><th>${t("Hit rate", "Aciertos")}</th><th>${t("Positions", "Posiciones")}</th><th>${t("Days", "Días")}</th>
    </tr></thead><tbody>${rows.map(([label, s]) =>
      `<tr><td>${label}</td><td>${fmtSharpe(s?.sharpe)}</td><td>${fmtHit(s?.hitRate)}</td><td>${s?.nPositions ?? 0}</td><td>${s?.nDays ?? 0}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function quorumTodayHtml(today) {
  if (!today?.length) return `<div class="empty">${t("No views yet", "Sin vistas todavía")}</div>`;
  return today.map((snap) => {
    const models = [...new Set(snap.views.map((v) => v.model_id))];
    if (!models.length) {
      return `<div class="muted" style="font-size:var(--t-xs)">${esc(snap.dateKey)} · ${esc(snap.assetClass)} — ${t("snapshot stored, no model views", "instantánea guardada, sin vistas de modelos")}</div>`;
    }
    const bySymbol = {};
    for (const v of snap.views) (bySymbol[v.symbol] ??= {})[v.model_id] = v;
    const qBySymbol = Object.fromEntries(snap.quorum.map((q) => [q.symbol, q]));
    // .scroll: four model columns are wider than a phone (the page itself
    // scrolled sideways until the 2026-10-12 audit).
    return `<div style="margin-bottom:8px"><div class="muted" style="font-size:var(--t-xs)">${esc(snap.dateKey)} · ${esc(snap.assetClass)}</div>
      <div class="scroll"><table class="table" style="font-size:var(--t-xs)"><thead><tr><th>${t("Symbol", "Símbolo")}</th>${models.map((m) => `<th title="${esc(m)}">${esc(m.split(":").pop().split("/").pop())}</th>`).join("")}<th>${t("Quorum", "Quórum")}</th></tr></thead>
      <tbody>${Object.keys(bySymbol).sort().map((sym) => {
        const q = qBySymbol[sym];
        return `<tr><td>${esc(sym)}</td>${models.map((m) => {
          const v = bySymbol[sym][m];
          return `<td>${v ? `${V_GLYPH[v.view] ?? "?"} ${Math.round(v.confidence * 100)}%` : "—"}</td>`;
        }).join("")}<td>${q ? `<b>${q.direction > 0 ? `▲ ${t("long", "compra")}` : `▼ ${t("short", "venta")}`}</b> ${Math.round(q.mean_confidence * 100)}%` : "·"}</td></tr>`;
      }).join("")}</tbody></table></div></div>`;
  }).join("");
}

export function aiQuorumHtml(q) {
  if (!q || q.status === "none") {
    return `<div class="empty">${t("Shadow AI-quorum experiment has no data yet.", "El experimento de quórum IA en sombra aún no tiene datos.")}</div>`;
  }
  const statusChip = q.status === "active"
    ? `<span style="color:var(--green,#3fb950)">● ${t("active", "activo")}</span>`
    : `<span style="color:var(--yellow,#d29922)">● ${t("waiting for AI access", "a la espera de acceso a la IA")}</span>`;
  const verdict = q.verdict
    ? ` · ${t("verdict", "veredicto")}: <b>${q.verdict === "VALIDADO" ? t("validated", "validado") : q.verdict === "REFUTADO" ? t("refuted", "refutado") : ""}</b>`
    : q.verdictDate
      ? ` · ${t("verdict on", "veredicto el")} ${esc(q.verdictDate)} (${q.sessionsWithViews}/${q.sessionsRequired} ${t("sessions", "sesiones")})`
      : "";
  const spend = q.spendMonthUsd ? ` · ${t("spend this month", "gasto del mes")}: $${q.spendMonthUsd.toFixed(2)}` : "";
  return `
    <div class="muted" style="font-size:var(--t-xs);margin-bottom:6px">${statusChip}${verdict}${spend} · ${t("simulation only — not counted in the order goal", "solo simulación — no cuenta en la meta de órdenes")}</div>
    ${quorumCurveSvg(q.curve)}
    <div style="margin-top:8px">${quorumTodayHtml(q.today)}</div>
    ${quorumStatsHtml(q.stats)}`;
}

/** Mounts the Activity page into `host` (a fresh #pageBody element). */
export async function mountActivity(host, trades) {
  host.innerHTML = `<div class="muted">…</div>`;
  const [items, quorum] = await Promise.all([api.activity(120), api.aiQuorum()]);
  if (!host.isConnected) return; // page changed while loading
  // Two columns on wide screens (2026-10-12 audit): one full-width column
  // spread the trades table's eight columns across ~1650px.
  host.innerHTML = `<div class="act-grid">
    <div class="act-col"><div class="page-section"><span class="card-note">${t("Closed trades", "Operaciones cerradas")}</span>${viewChip()}${renderTrades(trades)}</div></div>
    <div class="act-col">
      <div class="page-section"><span class="card-note">${t("AI quorum (shadow)", "Quórum IA (sombra)")}</span>${aiQuorumHtml(quorum)}</div>
      <div class="page-section"><span class="card-note">${t("Activity log", "Registro de actividad")}</span>${activityLogHtml(items)}</div>
    </div>
  </div>`;
}
