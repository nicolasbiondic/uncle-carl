// ── viewchip.js — the visible "Only <portfolio> · show all" chip. A portfolio
// filter (picked in the broker modal or the palette) narrows Positions, Trades,
// the Equity curve and Activity to one portfolio while the KPI tiles stay
// whole-account; the chip says so and one click returns to the whole account.
// The filter lives for the session only (store.js does not persist `view`).
import { store, t, sleeveLabel } from "../store.js";
import { esc } from "../ui.js";

/** "" for the whole-account view. */
export function viewChip(state = store.state) {
  const v = state.view;
  if (!v || v === "consolidated") return "";
  const acc = (state.dashboard?.accounts || []).find((a) => a.id === v);
  const label = sleeveLabel(acc || { id: v });
  const title = t("Positions, trades and the curve show only this portfolio; the figures above are the whole account.", "Posiciones, trades y la curva muestran solo este portafolio; las cifras de arriba son de toda la cuenta.");
  return `<button type="button" class="viewchip" data-act="view-all" title="${esc(title)}">${esc(t(`Only ${label} · show all`, `Solo ${label} · ver todo`))}</button>`;
}
