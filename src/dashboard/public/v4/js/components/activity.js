// ── activity.js — "Actividad" page: the existing operations history (closed
// trades) + the activity log, as a full page of the portfolio-manager nav.
import { api } from "../api.js";
import { t } from "../store.js";
import { esc } from "../ui.js";
import { etDateTime } from "../fmt.js";
import { renderTrades } from "./trades.js";

export function activityLogHtml(items) {
  if (!items?.length) return `<div class="empty">${t("No recent activity", "Sin actividad reciente")}</div>`;
  return `<div style="font-family:var(--mono);font-size:var(--t-xs)">${items.map((a) =>
    `<div style="padding:3px 0;border-bottom:1px solid var(--border)"><span class="muted">[${esc(etDateTime(a.created_at))}]</span> ${a.account_id ? `<span class="muted">[${esc(a.account_id)}]</span> ` : ""}${esc(a.message)}</div>`
  ).join("")}</div>`;
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
      return `<div class="muted" style="font-size:var(--t-xs)">${esc(snap.dateKey)} · ${esc(snap.assetClass)} — ${t("snapshot stored, no model views", "instantánea guardada, sin vistas de modelos")} (${esc(snap.status)})</div>`;
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
        }).join("")}<td>${q ? `<b>${q.direction > 0 ? "▲ LONG" : "▼ SHORT"}</b> ${Math.round(q.mean_confidence * 100)}%` : "·"}</td></tr>`;
      }).join("")}</tbody></table></div></div>`;
  }).join("");
}

export function aiQuorumHtml(q) {
  if (!q || q.status === "none") {
    return `<div class="empty">${t("Shadow AI-quorum experiment has not produced data yet (cron scripts/ai-quorum.ts).", "El experimento de quórum IA en sombra aún no tiene datos (cron scripts/ai-quorum.ts).")}</div>`;
  }
  const statusChip = q.status === "active"
    ? `<span style="color:var(--green,#3fb950)">● ${t("active", "activo")}</span>`
    : `<span style="color:var(--yellow,#d29922)">● ${t("pending AI keys", "pendiente de claves")}</span>`;
  const verdict = q.verdict
    ? ` · ${t("verdict", "veredicto")}: <b>${esc(q.verdict)}</b>`
    : q.verdictDate
      ? ` · ${t("verdict on", "veredicto el")} ${esc(q.verdictDate)} (${q.sessionsWithViews}/${q.sessionsRequired} ${t("sessions", "sesiones")})`
      : "";
  const spend = q.spendMonthUsd ? ` · ${t("spend this month", "gasto del mes")}: $${q.spendMonthUsd.toFixed(2)}` : "";
  return `
    <div class="muted" style="font-size:var(--t-xs);margin-bottom:6px">${statusChip}${verdict}${spend} · ${t("shadow only — excluded from volume KPIs", "solo sombra — excluido del volumen")}</div>
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
    <div class="act-col"><div class="page-section"><span class="card-note">${t("Closed & open trades", "Operaciones")}</span>${renderTrades(trades || [])}</div></div>
    <div class="act-col">
      <div class="page-section"><span class="card-note">${t("AI quorum (shadow)", "Quórum IA (sombra)")}</span>${aiQuorumHtml(quorum)}</div>
      <div class="page-section"><span class="card-note">${t("Activity log", "Registro de actividad")}</span>${activityLogHtml(items)}</div>
    </div>
  </div>`;
}
