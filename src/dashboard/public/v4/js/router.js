// ── router.js — hash-route helpers (pure; main.js wires hashchange) ──────
export const PAGE_IDS = ["resumen", "portafolios", "actividad", "ajustes"];

/** Retired pages that live on inside another one. Broker accounts moved into
 *  Ajustes (owner, 2026-10-11); #/cuentas keeps working for old links,
 *  bookmarks and the OAuth round trip. */
export const PAGE_ALIASES = { cuentas: "ajustes" };

/** "#/ajustes" → "ajustes"; "#/cuentas" → "ajustes"; unknown/absent → null. */
export function pageFromHash(hash) {
  const m = /^#\/([a-z]+)/.exec(hash || "");
  if (!m) return null;
  if (PAGE_IDS.includes(m[1])) return m[1];
  return Object.prototype.hasOwnProperty.call(PAGE_ALIASES, m[1]) ? PAGE_ALIASES[m[1]] : null;
}

/** True when the hash names a retired page (main.js rewrites it and focuses
 *  the section that replaced it). */
export function isAliasHash(hash) {
  const m = /^#\/([a-z]+)/.exec(hash || "");
  return !!m && Object.prototype.hasOwnProperty.call(PAGE_ALIASES, m[1]);
}

/** A page remembered in localStorage may predate a merge ("cuentas"). */
export function normalizePage(page) {
  if (PAGE_IDS.includes(page)) return page;
  return Object.prototype.hasOwnProperty.call(PAGE_ALIASES, page) ? PAGE_ALIASES[page] : "resumen";
}
