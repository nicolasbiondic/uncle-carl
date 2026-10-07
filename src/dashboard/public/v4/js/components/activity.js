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

/** Mounts the Activity page into `host` (a fresh #pageBody element). */
export async function mountActivity(host, trades) {
  host.innerHTML = `<div class="muted">…</div>`;
  const items = await api.activity(120);
  if (!host.isConnected) return; // page changed while loading
  host.innerHTML = `
    <div class="page-section"><span class="card-note">${t("Closed & open trades", "Operaciones")}</span>${renderTrades(trades || [])}</div>
    <div class="page-section"><span class="card-note">${t("Activity log", "Registro de actividad")}</span>${activityLogHtml(items)}</div>`;
}
