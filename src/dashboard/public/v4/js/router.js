// ── router.js — hash-route helpers (pure; main.js wires hashchange) ──────
export const PAGE_IDS = ["resumen", "portafolios", "cuentas", "actividad", "ajustes"];

/** "#/cuentas" → "cuentas"; unknown/absent → null. */
export function pageFromHash(hash) {
  const m = /^#\/([a-z]+)/.exec(hash || "");
  return m && PAGE_IDS.includes(m[1]) ? m[1] : null;
}
