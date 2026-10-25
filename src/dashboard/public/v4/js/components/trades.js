import { t } from "../store.js";
import { moneyCompact, moneySignedCompact, pnlWhole, pctSigned, pnlColor, etDateTime, dur } from "../fmt.js";
import { esc } from "../ui.js";

// Uses /api/trades (camelCase). Excludes reconcile/sync phantoms so the list
// reflects real strategy activity (same spirit as the fixed stats).
const HIDE = new Set(["BROKER_GONE_404", "MANUAL_CLOSE_UNRECONCILED", "BACKFILLED_SYNC", "SYNC_DETECTED"]);

export function renderTrades(trades) {
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
  // Side column only when a short exists (every live strategy is long only);
  // .opt3/.opt4 hide on mid-width desktops so each row stays on one line
  // (app.css, #opsBody — 2026-10-12).
  const isLong = (x) => x.side === "buy" || x.side === "long";
  const anyShort = rows.some((x) => !isLong(x));
  const body = rows.map((x) => {
    const isL = isLong(x);
    return `<tr>
      <td>${esc(etDateTime(x.exitTime || x.entryTime))}</td>
      <td><span class="symlink" data-sym="${esc(x.symbol)}" role="button" tabindex="0">${esc(x.symbol)}</span></td>
      ${anyShort ? `<td><span class="badge ${isL ? "l" : "s"}">${isL ? "L" : "S"}</span></td>` : ""}
      <td class="opt3">${moneyCompact(x.entryPrice)}</td>
      <td class="opt3">${x.exitPrice != null ? moneyCompact(x.exitPrice) : "—"}</td>
      <td style="color:${pnlColor(x.pnl)}">${pnlWhole(x.pnl)} <span class="muted">${pctSigned(x.pnlPct)}</span></td>
      <td class="muted" title="${esc(t("How long the position was open — a gain built over weeks was already in the P&L before it closed", "Cuánto estuvo abierta — una ganancia acumulada en semanas ya estaba en el P&L antes del cierre"))}">${x.exitTime && x.entryTime ? dur(x.exitTime - x.entryTime) : "—"}</td>
      <td class="muted opt4">${esc((x.strategy || "").slice(0, 8))}</td>
    </tr>`;
  }).join("");
  return `<div class="scroll" style="max-height:420px"><table>
    <thead><tr><th>${t("Time", "Hora")}</th><th>${t("Sym", "Sím")}</th>${anyShort ? "<th>S</th>" : ""}<th class="opt3">${t("Entry", "Entrada")}</th><th class="opt3">${t("Exit", "Salida")}</th><th>P&L</th><th>${t("Held", "Abierta")}</th><th class="opt4">${t("Strat", "Estr")}</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}
