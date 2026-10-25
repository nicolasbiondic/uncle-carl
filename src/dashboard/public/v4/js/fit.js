// ── Columns give way, never a sideways scroll (desktop) ─────────────────────
// app.css hides optional columns by viewport width: that is each width's
// baseline. A viewport query cannot see what takes a table's last pixels — a
// vertical scrollbar (8px: the 47 positions of 2026-10-23 stopped fitting and
// the table had 1px to spare), a wider font, longer values. fitTable hides the
// next optional group while the table still overflows its box. The groups are
// classes on the <table> (fit-1, fit-2, …); app.css maps each to the cells it
// hides, least important first. Phones (< 981px) keep the sideways scroll:
// the page scrolls there and the symbol column sticks to the left edge.
export const FIT_STEPS = ["fit-1", "fit-2", "fit-3", "fit-4"];
export const DESKTOP = "(min-width: 981px)";

/** Re-fit one scroll box's table; returns how many groups it hid. */
export function fitTable(box, steps = FIT_STEPS, desktop = matchMedia(DESKTOP).matches) {
  const table = box?.querySelector(":scope > table");
  if (!table) return 0;
  table.classList.remove(...steps);
  if (!desktop) return 0;
  let hidden = 0;
  while (hidden < steps.length && box.scrollWidth > box.clientWidth) table.classList.add(steps[hidden++]);
  return hidden;
}

/** Re-fit every table box under `root` (the analytics card's tab body). */
export function fitTablesIn(root, steps = FIT_STEPS) {
  for (const box of root?.querySelectorAll(".scroll") ?? []) fitTable(box, steps);
}
