// ── pnl-breakdown.js — "why is the period P&L X if Y was realized?"
// (2026-09-29, owner: "Esos +4000 no los veo"; 2026-11-06: the tile's own
// subline now shows closes + positions of the SAME window, this modal is the
// bridge from "realized since entry" to those two figures). Modal behind the
// P&L KPIs; same modal pattern as broker-modal.js. Data:
// /api/v2/pnl-breakdown (src/portfolio/pnlBreakdown.ts):
//   realized since entry − counted before the period = closes (tile)
//   open positions' move + holding costs and other   = positions (tile)
//   closes + positions                                = the period P&L
import { t } from "../store.js";
import { pnlWhole, pnlColor, etDate, etDateTime, dur, n } from "../fmt.js";
import { esc, icon } from "../ui.js";
import { trapFocus } from "../focus-trap.js";
import { api } from "../api.js";

let root = null;
let release = null;

const MAX_CLOSES = 8;

function periodName(days) {
  if (days === 0) return t("Gain since start", "Ganancia desde el inicio");
  if (days === 1) return t("Gain today", "Ganancia de hoy");
  return t(`Gain over ${days} days`, `Ganancia de ${days} días`);
}

const amount = (v) => v == null ? "—" : `<span style="color:${pnlColor(v)}">${pnlWhole(v)}</span>`;

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
    : t("The P&L is how much the accounts' value changed in the period. Closing or trimming a position adds no money: it turns an open result into a realized one. What was realized since entry includes earlier days' moves, which were already in those days' P&L; only the move within the period counts here.",
      "El P&L es cuánto cambió el valor de las cuentas en el período. Cerrar o recortar una posición no suma dinero: convierte un resultado abierto en cobrado. Lo cobrado desde la entrada incluye movimientos de días anteriores, que contaron en el P&L de esos días; aquí solo cuenta lo que se movió dentro del período.");

  const trims = n(b.trimsCount);
  const trimsWord = trims === 1 ? t("trim", "recorte") : t("trims", "recortes");
  const legs = trims > 0 ? `${count} ${closesWord} ${t("and", "y")} ${trims} ${trimsWord}` : `${count} ${closesWord}`;
  const rows = [bridgeRow(`${t("Result since entry of", "Resultado desde la entrada de")} ${legs}`, b.realized)];
  if (!allTime && b.earnedBefore == null) {
    rows.push(`<tr><td colspan="2" class="muted">${t("A position reduced in the period has no price at its start, so the part counted before can't be separated.", "A una posición reducida en el período le falta el precio al inicio: no se puede separar lo contado antes.")}</td></tr>`);
  } else if (!allTime) {
    rows.push(bridgeRow(`− ${t("already counted before", "ya contado antes del")} ${startDay}`, -n(b.earnedBefore), "", t("(counted in earlier days' P&L)", "(contado en el P&L de días anteriores)")));
  }
  rows.push(bridgeRow(`= ${t("what closed operations earned in this period", "lo que las operaciones cerradas ganaron en este período")}`, b.closedInWindow, "sum"));
  rows.push(bridgeRow(
    allTime ? `${t("open positions, not yet realized", "posiciones abiertas, sin cobrar")}` : `${t("open positions, price change in the period", "posiciones abiertas, cambio de precio en el período")}`,
    b.openChange, "", `(${n(b.openCount)})`,
  ));
  rows.push(bridgeRow(
    `+ ${t("holding costs and other", "costes de mantener y otros")}`,
    b.holding, "", t("(funding, margin interest, fees, BTC collateral)", "(funding, interés del margen, comisiones, colateral BTC)"),
  ));
  rows.push(bridgeRow(`= ${t("the rest of the account's change", "el resto del cambio de la cuenta")}`, b.positions, "sum"));
  rows.push(bridgeRow(`= ${periodName(days)}`, b.pnl, "total"));
  const approx = !allTime && b.startPrices === "bars"
    ? `<p class="muted pb-note">${t("Start prices from closing bars — approximate.", "Precios de inicio de barras de cierre — aproximado.")}</p>`
    : "";

  const closes = [...(b.closes || [])].sort((x, y) => Math.abs(n(y.realized)) - Math.abs(n(x.realized)));
  const shown = closes.slice(0, MAX_CLOSES);
  const total = count + trims;
  const closesTable = shown.length === 0 ? "" : `
    <div>
      <div class="pb-h">${t("Largest closes and trims in the period", "Cierres y recortes más grandes del período")}</div>
      <div class="scroll"><table class="pb-closes">
        <thead><tr><th>${t("Sym", "Sím")}</th><th class="r">${t("Since entry", "Desde la entrada")}</th>${allTime ? "" : `<th class="r">${t("Counted before", "Contado antes")}</th><th class="r">${t("In the period", "En el período")}</th>`}<th class="r">${t("Held", "Abierta")}</th></tr></thead>
        <tbody>${shown.map((c) => `<tr>
          <td>${esc(c.symbol)}${c.kind === "trim" ? ` <span class="muted">${t("trim", "recorte")}</span>` : ""}</td>
          <td class="r">${amount(c.realized)}</td>
          ${allTime ? "" : `<td class="r">${amount(c.earnedBefore)}</td><td class="r">${amount(c.inWindow)}</td>`}
          <td class="r muted">${c.exitTime && c.entryTime ? dur(c.exitTime - c.entryTime) : "—"}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      ${total > shown.length ? `<div class="muted pb-more">${t("and", "y")} ${total - shown.length} ${t("more", "más")}</div>` : ""}
    </div>`;

  return `<div class="pb-body">
    <div class="pb-top"><b style="color:${pnlColor(b.pnl)}">${periodName(days)} ${b.pnl == null ? "—" : pnlWhole(b.pnl)}</b> <span class="muted">· ${esc(since)}</span></div>
    <p class="pb-intro">${intro}</p>
    <table class="pb-bridge"><tbody>${rows.join("")}</tbody></table>
    ${approx}
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
  // A slow answer for a modal that was closed (or replaced by another window's)
  // must not paint into the new one: each opening owns its own root.
  const mine = root;
  api.pnlBreakdown(d).then((b) => {
    if (root !== mine) return;
    const body = mine.querySelector("#pbBody");
    if (body) body.innerHTML = renderBreakdown(b);
  });
}

function escClose(e) { if (e.key === "Escape") close(); }
export function close() { if (root) { root.remove(); root = null; document.removeEventListener("keydown", escClose); release?.(); release = null; } }
