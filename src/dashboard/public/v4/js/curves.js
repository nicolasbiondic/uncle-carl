// ── curves.js — each strategy's last 30 days, fetched once per refresh cycle ─
// The Overview board's value, delta and curve per strategy: the server's display
// reader (GET /api/equity/history?account=<id>&days=30&points=120), thinned to
// ~120 points. They move slowly: refetched at most every 25 s (the dashboard's
// own cycle is 30 s); a failed fetch keeps the last good answer.
import { api } from "./api.js";
import { store } from "./store.js";

export const CURVES_TTL_MS = 25_000;
export const CURVE_POINTS = 120;
let inflight = null, inflightKey = "", fetchedKey = "", fetchedAt = 0;

/** Resolves true when the cache changed. `ids` are strategy ids. */
export async function loadStrategyCurves(ids, { force = false } = {}) {
  const list = [...new Set((ids || []).filter(Boolean))].sort();
  const key = list.join(",");
  if (!list.length) return false;
  if (!force && key === fetchedKey && Date.now() - fetchedAt < CURVES_TTL_MS) return false;
  if (inflight && inflightKey === key) return inflight;
  inflightKey = key;
  inflight = (async () => {
    const next = { ...store.state.curves };
    let changed = false;
    await Promise.all(list.map(async (id) => {
      if (!store.state.curvesTried?.[id]) changed = true; // the first answer, even an empty one, ends the skeleton
      const rows = await api.equityHistory({ account: id, days: 30, points: CURVE_POINTS });
      if (Array.isArray(rows) && rows.length) {
        if (JSON.stringify(rows) !== JSON.stringify(next[id])) changed = true;
        next[id] = rows;
      }
    }));
    store.state.curves = next; // not persisted, no subscriber needs to wake for it
    store.state.curvesTried = { ...store.state.curvesTried, ...Object.fromEntries(list.map((id) => [id, true])) };
    fetchedKey = key; fetchedAt = Date.now();
    return changed;
  })().finally(() => { inflight = null; });
  return inflight;
}
