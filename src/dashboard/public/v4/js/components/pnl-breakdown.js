// ── pnl-breakdown.js — "why is the period P&L X if Y was realized?"
// (2026-09-29, owner: "Esos +4000 no los veo"). Modal behind the P&L KPIs'
// "breakdown" link; same modal pattern as broker-modal.js. Data:
// /api/v2/pnl-breakdown (src/portfolio/pnlBreakdown.ts) — the bridge
//   realized − earned before the window + open positions' move + other = P&L
import { t } from "../store.js";
import { moneySigned, pnlColor, etDate, etDateTime, dur, n } from "../fmt.js";
import { esc, icon } from "../ui.js";
import { trapFocus } from "../focus-trap.js";
import { api } from "../api.js";

let root = null;
let release = null;

const MAX_CLOSES = 8;

function periodName(days) {
  if (days === 0) return t("All-time P&L", "P&L total");
  if (days === 1) return t("Today's P&L", "P&L de hoy");
  return t(`${days}D P&L`, `P&L ${days}D`);
}

const amount = (v) => v == null ? "—" : `<span style="color:${pnlColor(v)}">${moneySigned(v)}</span>`;

function bridgeRow(label, v, cls = "", note = "") {
  return `<tr class="${cls}"><td>${label}${note ? ` <span class="muted">${note}</span>` : ""}</td><td class="r">${amount(v)}</td></tr>`;
}

/** Pure render of the breakdown payload (exported for tests). */
export function renderBreakdown(b) {
  if (!b) return `<div class="empty">${t("Breakdown unavailable right now.", "El desglose no está disponible ahora.")}</div>`;
  const days = n(b.periodDays);
  const allTime = days === 0;
  const count = n(b.count);
  const closesWord = count === 1 ? t("close", "cierre") : t("closes", "cierres");
  const since = allTime ? t("since the start", "desde el inicio") : `${t("since", "desde")} ${etDateTime(b.windowStart)} ET`;
  const startDay = allTime ? "" : etDate(b.windowStart);

  const intro = allTime
    ? t("The all-time P&L is how much the accounts' value changed since the start: what closed trades realized plus what the open positions are worth now.",
      "El P&L total es cuánto cambió el valor de las cuentas desde el inicio: lo cobrado en cierres más lo que valen ahora las posiciones abiertas.")
    : t("The P&L is how much the accounts' value changed in the period. Closing a position adds no money: it turns an open gain into a realized one. A gain built up before the period appears in full as realized, but only its move within the period counts in the P&L.",
      "El P&L es cuánto cambió el valor de las cuentas en el período. Cerrar una posición no suma dinero: convierte una ganancia abierta en cobrada. Una ganancia acumulada antes del período aparece entera en «cobrado», pero en el P&L solo cuenta lo que se movió dentro del período.");

  const rows = [bridgeRow(`${t("Realized in", "Cobrado en")} ${count} ${closesWord}`, b.realized)];
  if (!allTime && b.earnedBefore == null) {
    rows.push(`<tr><td colspan="2" class="muted">${t("A position closed in the period has no price at its start, so the part earned before can't be separated.", "A una posición cerrada en el período le falta el precio al inicio: no se puede separar lo ganado antes.")}</td></tr>`);
  } else if (!allTime && Math.abs(n(b.earnedBefore)) >= 0.005) {
    rows.push(bridgeRow(`− ${t("earned before", "ganado antes del")} ${startDay}`, -b.earnedBefore, "", t("(already in the P&L before the period)", "(ya estaba en el P&L antes del período)")));
    rows.push(bridgeRow(`= ${t("result of the closes within the period", "resultado de los cierres dentro del período")}`, b.closedInWindow, "sum"));
  }
  rows.push(bridgeRow(
    allTime ? `+ ${t("open positions, not yet realized", "posiciones abiertas, sin cobrar")}` : `+ ${t("open positions, change in the period", "posiciones abiertas, cambio en el período")}`,
    b.openChange, "", `(${n(b.openCount)})`,
  ));
  rows.push(bridgeRow(
    `+ ${allTime ? t("funding, fees, treasury and history before v8", "funding, comisiones, tesorería e historial anterior a v8") : t("funding, fees, treasury and other", "funding, comisiones, tesorería y otros")}`,
    b.other,
  ));
  rows.push(bridgeRow(`= ${periodName(days)}`, b.pnl, "total"));

  const closes = [...(b.closes || [])].sort((x, y) => Math.abs(n(y.realized)) - Math.abs(n(x.realized)));
  const shown = closes.slice(0, MAX_CLOSES);
  const closesTable = shown.length === 0 ? "" : `
    <div>
      <div class="pb-h">${t("Largest closes in the period", "Cierres más grandes del período")}</div>
      <div class="scroll"><table class="pb-closes">
        <thead><tr><th>${t("Sym", "Sím")}</th><th class="r">${t("Realized", "Cobrado")}</th>${allTime ? "" : `<th class="r">${t("Earned before", "Ganado antes")}</th><th class="r">${t("In the period", "En el período")}</th>`}<th class="r">${t("Held", "Abierta")}</th></tr></thead>
        <tbody>${shown.map((c) => `<tr>
          <td>${esc(c.symbol)}</td>
          <td class="r">${amount(c.realized)}</td>
          ${allTime ? "" : `<td class="r">${amount(c.earnedBefore)}</td><td class="r">${amount(c.inWindow)}</td>`}
          <td class="r muted">${c.exitTime && c.entryTime ? dur(c.exitTime - c.entryTime) : "—"}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      ${count > shown.length ? `<div class="muted pb-more">${t("and", "y")} ${count - shown.length} ${t("more", "más")}</div>` : ""}
    </div>`;

  return `<div class="pb-body">
    <div class="pb-top"><b style="color:${pnlColor(b.pnl)}">${periodName(days)} ${b.pnl == null ? "—" : moneySigned(b.pnl)}</b> <span class="muted">· ${esc(since)}</span></div>
    <p class="pb-intro">${intro}</p>
    <table class="pb-bridge"><tbody>${rows.join("")}</tbody></table>
    ${closesTable}
  </div>`;
}

export function openPnlBreakdown(days) {
  close();
  const d = Number.isFinite(days) ? days : 7;
  root = document.createElement("div");
  root.className = "cm-backdrop";
  root.innerHTML = `<div class="cm pb-modal" role="dialog" aria-modal="true" aria-label="${esc(periodName(d))}">
    <div class="cm-head">
      <b>${esc(t("How the P&L adds up", "Cómo se compone el P&L"))}</b>
      <span style="flex:1"></span>
      <button class="icn" data-pbclose aria-label="${t("Close", "Cerrar")}">${icon("x")}</button>
    </div>
    <div id="pbBody"><div class="empty">${t("Loading…", "Cargando…")}</div></div>
  </div>`;
  document.body.appendChild(root);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  root.addEventListener("click", (e) => { if (e.target.closest("[data-pbclose]")) close(); });
  document.addEventListener("keydown", escClose);
  release = trapFocus(root);
  api.pnlBreakdown(d).then((b) => {
    const body = root?.querySelector("#pbBody");
    if (body) body.innerHTML = renderBreakdown(b);
  });
}

function escClose(e) { if (e.key === "Escape") close(); }
export function close() { if (root) { root.remove(); root = null; document.removeEventListener("keydown", escClose); release?.(); release = null; } }
