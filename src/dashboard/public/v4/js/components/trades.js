import { t, isEs } from "../store.js";
import { moneyCompact, pnlWhole, pctWhole, pnlColor, etDateTime, dur } from "../fmt.js";
import { esc } from "../ui.js";
import { closeReasonWord } from "../close-reasons.js";
import { symbolCell } from "../symbol-cell.js";

// Uses /api/trades (camelCase). Excludes reconcile/sync phantoms so the list
// reflects real strategy activity (same spirit as the fixed stats).
const HIDE = new Set(["BROKER_GONE_404", "MANUAL_CLOSE_UNRECONCILED", "BACKFILLED_SYNC", "SYNC_DETECTED"]);

/** The strategy in a word (the engine's code is never shown); "" when unknown. */
export function strategyWord(code) {
  const c = String(code || "").toUpperCase();
  if (c.startsWith("MEANREV")) return t("Mean reversion", "Reversión");
  if (c.startsWith("MOMENTUM")) return "Momentum";
  return "";
}

/** `trades` null = the feed failed (not the same as "no closed trades"). */
export function renderTrades(trades) {
  if (trades == null) {
    return `<div class="empty"><div class="big">${t("Could not load the trades", "No se pudieron cargar los trades")}</div>
      ${t("It will retry in a moment.", "Se reintentará en unos instantes.")}</div>`;
  }
  // Most recent CLOSE first (the server feed is ordered by latest activity;
  // sorting here too keeps the list right whatever the feed order).
  const rows = (trades || [])
    .filter((x) => x.status === "closed" && !HIDE.has(x.closeReason))
    .sort((a, b) => (b.exitTime || b.entryTime || 0) - (a.exitTime || a.entryTime || 0))
    .slice(0, 60);
  if (!rows.length) {
    return `<div class="empty"><div class="big">${t("No closed trades yet", "Aún sin trades cerrados")}</div>
      ${t("Trades appear here once the bot opens and closes positions.", "Aparecerán cuando el bot abra y cierre posiciones.")}</div>`;
  }
  // No side column (2026-11-12, same as the positions table): a short carries
  // a word tag beside its name. .opt3/.opt4 hide on mid-width desktops so each
  // row stays on one line (app.css, #opsBody — 2026-10-12).
  const isLong = (x) => x.side === "buy" || x.side === "long";
  const body = rows.map((x) => {
    return `<tr>
      <td>${esc(etDateTime(x.exitTime || x.entryTime))}</td>
      <td>${symbolCell(x.symbol, { title: closeReasonWord(x.closeReason, isEs() ? "es" : "en"), short: !isLong(x) })}</td>
      <td class="opt3">${esc(moneyCompact(x.entryPrice))}</td>
      <td class="opt3">${x.exitPrice != null ? esc(moneyCompact(x.exitPrice)) : "—"}</td>
      <td style="color:${pnlColor(x.pnl)}">${pnlWhole(x.pnl)} <span class="muted">${pctWhole(x.pnlPct)}</span></td>
      <td class="muted" title="${esc(t("How long the position was open — a gain built over weeks was already in the P&L before it closed", "Cuánto estuvo abierta — una ganancia acumulada en semanas ya estaba en el P&L antes del cierre"))}">${x.exitTime && x.entryTime ? dur(x.exitTime - x.entryTime) : "—"}</td>
      <td class="muted opt4">${esc(strategyWord(x.strategy))}</td>
    </tr>`;
  }).join("");
  return `<div class="scroll" style="max-height:420px"><table>
    <thead><tr><th>${t("Time (ET)", "Hora (ET)")}</th><th>${t("Position", "Posición")}</th><th class="opt3">${t("Entry", "Entrada")}</th><th class="opt3">${t("Exit", "Salida")}</th><th>P&L</th><th>${t("Held", "Abierta")}</th><th class="opt4">${t("Strategy", "Estrategia")}</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}
