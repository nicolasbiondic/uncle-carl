// ── funnel.js — "Volumen y embudo" (P0 2026-10-09) ──────────────────────────
// Per-portfolio decision funnel from GET /api/funnel?days=1|7|30
// (decision_passes telemetry): decision passes, signals, entries, exits,
// blocks by reason, slot occupancy, and live executed orders/day vs the
// validated design (§2 of docs/reports/V-plan-volumen-rentabilidad.md).
// Since 2026-10-12 it renders as the analytics card's "Volume" tab
// (analytics.js loadTab); as a card under Positions/Trades it took that
// table's height in the viewport-locked layout.

import { api } from "../api.js";
import { store, t, sleeveLabel } from "../store.js";
import { byId, esc } from "../ui.js";
import { num, n } from "../fmt.js";
import { fitTablesIn } from "../fit.js";

let data = null;
let slippage = null; // /api/analytics/slippage — execution quality (moved here from Performance, 2026-10-25)
let days = 7;
let loading = false;

const BLOCK_LABELS = () => ({
  risk_gate: t("risk brake", "freno de riesgo"),
  regime: t("regime", "régimen"),
  market_trend: t("market trend", "tendencia"),
  trading_disabled: t("maintenance", "mantenimiento"),
  gross_cap: t("gross cap", "tope bruto"),
  capacity: t("capacity", "capacidad"),
  no_slot: t("no slot", "sin hueco"),
  no_data: t("no data", "sin datos"),
  open_failed: t("open failed", "apertura fallida"),
  close_failed: t("close failed", "cierre fallido"),
  breakout_long_close_failed: t("close failed", "cierre fallido"),
  breakout_short_close_failed: t("close failed", "cierre fallido"),
  idle_overlay_close_failed: t("close failed", "cierre fallido"),
  // Portfolio-engine skip codes (Q7 V1, 2026-11-07: one decision_passes row per completed live pass).
  risk_engine_halted: t("risk brake", "freno de riesgo"),
  risk_engine_reducing: t("risk brake", "freno de riesgo"),
  max_hold_close_incomplete: t("close incomplete", "cierre incompleto"),
  rejected: t("rejected", "rechazada"),
  session_ended: t("session ended", "sesión terminada"),
});

function accountLabel(id) {
  const acc = (store.state.dashboard?.accounts || []).find((a) => a.id === id);
  return sleeveLabel(acc || { id });
}

/** Blocks by reason in words; the same word counts once ("close failed" from
 *  three engine keys), and an unknown key reads "other" — the engine's key and
 *  its note are never printed. */
export function blocksHtml(blocks) {
  const labels = BLOCK_LABELS();
  const merged = new Map();
  for (const [k, v] of Object.entries(blocks || {})) {
    if (!(n(v) > 0)) continue;
    const word = labels[k] || t("other", "otros");
    merged.set(word, (merged.get(word) || 0) + n(v));
  }
  if (!merged.size) return `<span class="muted">—</span>`;
  return [...merged].sort((a, b) => b[1] - a[1]).map(([w, v]) => `${esc(w)} ${num(v, 0)}`).join(" · ");
}

function tableHtml() {
  if (!data) return `<div class="muted">…</div>`;
  if (!data.accounts?.length) return `<div class="muted">${t("No decision passes recorded yet", "Aún no hay pasadas de decisión registradas")}</div>`;
  const windowDays = n(data.days, days) || days;
  const rows = data.accounts.map((a) => `
    <tr>
      <td>${esc(accountLabel(a.accountId))}</td>
      <td class="fo4">${num(a.passes, 0)}</td>
      <td class="fo3">${num(n(a.signalsLong) + n(a.signalsShort), 0)}</td>
      <td>${num(a.entries, 0)}</td>
      <td>${num(a.exits, 0)}</td>
      <td class="blocks">${blocksHtml(a.blocks)}</td>
      <td class="fo2">${a.slotsUsed == null ? "—" : `${num(a.slotsUsed, 0)}/${num(a.slotsTotal, 0)}`}</td>
      <td>${num(a.liveOrders, 0)}</td>
      <td class="fo1">${a.designOrdersPerDay == null ? "—" : num(a.designOrdersPerDay * windowDays, 0)}</td>
    </tr>`).join("");
  const target = store.state.kpis?.targets?.tradesPerDay ?? null;
  const totals = data.totals || {};
  const totalLine =
    `${t("Total", "Total")}: <b>${num(totals.liveOrdersPerDay, 1)}</b> ${t("orders/day live", "órdenes/día vivo")}` +
    ` · ${t("validated design", "diseño validado")} ≈ <b>${num(totals.designOrdersPerDay, 1)}</b>/${t("day", "día")}` +
    (target ? ` · ${t("goal", "meta")} <b>${num(target, 0)}</b>/${t("day", "día")}` : "");
  return `
    <div class="scroll"><table>
      <thead><tr>
        <th>${t("Portfolio", "Portafolio")}</th>
        <th class="fo4" title="${t("Decision passes in the window", "Pasadas de decisión en la ventana")}">${t("Decisions", "Decisiones")}</th>
        <th class="fo3">${t("Signals", "Señales")}</th>
        <th>${t("Entries", "Entradas")}</th>
        <th>${t("Exits", "Salidas")}</th>
        <th class="blocks">${t("Blocks by reason", "Bloqueos por motivo")}</th>
        <th class="fo2" title="${t("Slots used/total (latest pass)", "Huecos ocupados/total (última pasada)")}">${t("Slots", "Huecos")}</th>
        <th title="${t("Orders executed in the window", "Órdenes ejecutadas en la ventana")}">${t("Orders", "Órdenes")}</th>
        <th class="fo1" title="${t("Orders the validated design expects in the window (complete operations ×2)", "Órdenes que espera el diseño validado en la ventana (operaciones completas ×2)")}">${t("Design", "Diseño")}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="funnel-total">${totalLine}</div>
    ${executionLine(slippage)}`;
}

/** One sentence on execution quality: typical and bad-case slippage, mean
 *  latency, fills measured. Nothing when no fills were measured. Exported
 *  for tests. */
export function executionLine(sl) {
  if (!sl || !n(sl.count)) return "";
  const tip = t("Slippage = fill price vs the price when the order was decided, in basis points (1 bp = 0.01%). p50 is the typical fill, p95 the bad-case one.",
    "Slippage = precio de ejecución frente al precio al decidir la orden, en puntos básicos (1 pb = 0,01%). p50 es la ejecución típica, p95 la mala.");
  return `<div class="funnel-total exec-line" title="${esc(tip)}">${t("Execution quality", "Calidad de ejecución")}: ${t("slippage", "slippage")} <b>${num(sl.p50, 1)} bps</b> ${t("typical", "típico")}, <b>${num(sl.p95, 1)} bps</b> ${t("bad case", "en el peor 5%")}, ${t("latency", "latencia")} <b>${num(sl.meanLatencyMs, 0)} ms</b>, ${num(sl.count, 0)} ${t("fills", "ejecuciones")}</div>`;
}

/** The "Volume" tab body (analytics card): window selector + funnel table. */
export function renderFunnelPanel() {
  const seg = [[1, t("Today", "Hoy")], [7, "7D"], [30, "30D"]]
    .map(([v, l]) => `<button class="${v === days ? "on" : ""}" data-fdays="${v}" aria-pressed="${v === days}">${l}</button>`)
    .join("");
  return `<div id="funnelPanel">
    <div class="funnel-head"><span class="an-h" style="margin:0">${t("Decisions, signals and orders", "Decisiones, señales y órdenes")}</span><span class="seg">${seg}</span></div>
    <div id="funnelBody">${tableHtml()}</div>
  </div>`;
}

/** Columns give way, never a sideways scroll: the table's own fit groups
 *  (fit.js adds fit-1.. while it overflows; app.css maps them to .fo1..). */
function paintFunnel() {
  const body = byId("funnelBody");
  if (!body) return;
  body.innerHTML = tableHtml();
  fitTablesIn(body);
}

export async function loadFunnel() {
  if (loading) return;
  loading = true;
  try {
    const [d, sl] = await Promise.all([api.funnel(days), api.slippage()]);
    if (d) data = d;
    if (sl) slippage = sl;
  } finally {
    loading = false;
  }
  paintFunnel();
}

export function setFunnelDays(v) {
  days = v;
  data = null;
  const panel = byId("funnelPanel");
  if (panel) panel.outerHTML = renderFunnelPanel();
  loadFunnel();
}
