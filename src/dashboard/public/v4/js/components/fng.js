// ── Crypto Fear & Greed Index — visual-only KPI (re-added 2026-07-30; the
// original left with the v6.1 amputation and no trace survived in src/).
// Client-side fetch to alternative.me, same proven pattern as the bottom
// price ticker (main.js): the bot's backend is deliberately NOT involved —
// this number decides nothing, it is a sentiment dial for the human.
// CSP: https://api.alternative.me is allowlisted in connect-src (server.ts).
import { t } from "../store.js";
import { esc } from "../ui.js";

let fng = null; // { value: 0..100, label: "Extreme Fear" | ... }

/** Half-donut arc geometry (viewBox 34×19, r=13): π·r ≈ 40.84 */
export const FNG_ARC_LEN = Math.PI * 13;

/** alternative.me buckets → the widget's classic red→green palette */
export function fngColor(v) {
  if (v <= 25) return "#ea3943"; // Extreme Fear
  if (v <= 45) return "#ff9800"; // Fear
  if (v <= 55) return "#f3d42f"; // Neutral
  if (v <= 75) return "#93d900"; // Greed
  return "#16c784";              // Extreme Greed
}

const ES = {
  "Extreme Fear": "Miedo extremo",
  "Fear": "Miedo",
  "Neutral": "Neutral",
  "Greed": "Codicia",
  "Extreme Greed": "Codicia extrema",
};
export function fngLabel(label) { return t(label, ES[label] || label); }

export async function loadFng(onUpdate) {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    const j = await res.json();
    const d = j?.data?.[0];
    const v = +d?.value;
    if (Number.isFinite(v)) {
      fng = { value: Math.max(0, Math.min(100, v)), label: String(d.value_classification || "") };
      onUpdate?.();
    }
  } catch {} // sentiment is decoration — never let it break the dashboard
}

/** test seam */
export function _setFng(v) { fng = v; }

/** One extra card for the KPI strip; empty string until the first fetch lands
 *  (the strip simply stays as it was — no placeholder flicker). */
export function renderFngKpi() {
  if (!fng) return "";
  const v = fng.value;
  const color = fngColor(v);
  const dash = ((v / 100) * FNG_ARC_LEN).toFixed(2);
  const arc = `M4 17 A13 13 0 0 1 30 17`;
  return `<div class="kpi sm" title="Crypto Fear &amp; Greed Index — alternative.me">
    <span class="kl">${esc(t("Fear & Greed", "Miedo y Codicia"))}</span>
    <span class="kv" style="display:inline-flex;align-items:center;gap:7px">
      <svg width="34" height="19" viewBox="0 0 34 19" aria-hidden="true" style="flex-shrink:0">
        <path d="${arc}" fill="none" stroke="var(--border)" stroke-width="4.5" stroke-linecap="round"/>
        <path d="${arc}" fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round"
              stroke-dasharray="${dash} ${FNG_ARC_LEN.toFixed(2)}"/>
      </svg>
      <span style="color:${color}">${v}</span>
      <span class="kv sub">${esc(fngLabel(fng.label))}</span>
    </span>
  </div>`;
}
