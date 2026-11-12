// ── symbol-cell.js — the "Position" cell of the positions and trades tables ──
// The ticker stays (clickable: it opens the candle modal) with its plain name
// beside it in muted small text (symbol-names.js), and a small word tag on a
// short — long is the normal case and says nothing. Shared so both tables read
// the same.
import { t, isEs } from "./store.js";
import { esc } from "./ui.js";
import { symbolName, symbolBase } from "./symbol-names.js";

/** The plain name to print beside `symbol`, or "" when there is none or it
 *  would only repeat the ticker ("XRP/USDC" → "XRP" adds nothing). */
export function symbolLabel(symbol) {
  const name = symbolName(symbol, isEs() ? "es" : "en");
  return name && name !== symbolBase(symbol) ? name : "";
}

/** The word tag of a short row; "" for a long one. */
export function shortTag(isShort) {
  return isShort
    ? `<span class="shorttag" title="${esc(t("Gains if the price falls", "Gana si el precio baja"))}">${t("short", "corto")}</span>`
    : "";
}

/** `title` rides on the ticker (the tooltip: quantity, entry, now, or the close reason). */
export function symbolCell(symbol, { title = "", short = false } = {}) {
  const name = symbolLabel(symbol);
  return `<span class="symrow"><span class="symlink" data-sym="${esc(symbol)}" role="button" tabindex="0"${title ? ` title="${esc(title)}"` : ""}>${esc(symbol)}</span>${name ? `<span class="symname" title="${esc(name)}">${esc(name)}</span>` : ""}${shortTag(short)}</span>`;
}
