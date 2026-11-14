// ── capital-gauge.js — how much of its own capital a portfolio has in the
// market, as ONE picture used by the positions group headers and the Bot cards.
// A track from 0 to the larger of the portfolio's limit and 100 %, a fill to
// the current percentage and, whenever the track runs past 100 %, a tick at
// 100 % ("all of its own capital"): 146 % reads at a glance as its capital and
// almost half again, well inside a 250 % limit. The fill is the accent; red
// only past the limit (isOverLimit), never at it: an always-invested book sits
// at its limit by design. Decoration only (aria-hidden): the sentence beside
// it carries the meaning.
import { t } from "./store.js";
import { esc } from "./ui.js";

/** The ONE rule for "past its limit", whole percent as the sentences show it,
 *  so rounding drift at the limit never turns red. Without a known limit the
 *  old rule: red from 100 % of the capital. */
export function isOverLimit(ratio, cap) {
  if (ratio == null || !Number.isFinite(Number(ratio))) return false;
  if (cap == null || !Number.isFinite(Number(cap)) || Number(cap) <= 0) return Number(ratio) >= 1;
  return Math.round(Number(ratio) * 100) > Math.round(Number(cap) * 100);
}

/** What the tick says, for the tooltip next to the gauge. */
export const gaugeTickWord = () => t("The mark is 100 %: all of its own capital.", "La marca es el 100 %: todo su propio capital.");

/** The gauge. `ratio` and `cap` are fractions of the capital (1.46, 2.5);
 *  `over` the caller's colour decision (default: isOverLimit); `endLabel` the
 *  words at the end of the track ("limit 250 %"). "" when the ratio is unknown. */
export function capitalGauge({ ratio, cap = null, over, endLabel = "", className = "" } = {}) {
  const r = Number(ratio);
  if (ratio == null || ratio === "" || !Number.isFinite(r) || r < 0) return "";
  const limit = cap != null && Number(cap) > 0 ? Number(cap) : null;
  const extent = Math.max(limit ?? Math.max(1, r), 1);
  const fill = Math.min(100, (r / extent) * 100);
  const tick = extent > 1 ? 100 / extent : null;
  const color = (over ?? isOverLimit(r, limit)) ? "var(--down)" : "var(--accent)";
  return `<span class="cgauge${className ? ` ${className}` : ""}" aria-hidden="true"><span class="cg-track"><span class="cg-fill" style="width:${+fill.toFixed(1)}%;background:${color}"></span>${tick != null ? `<span class="cg-tick" style="left:${+tick.toFixed(1)}%"></span>` : ""}</span>${endLabel ? `<span class="cg-end">${esc(endLabel)}</span>` : ""}</span>`;
}
