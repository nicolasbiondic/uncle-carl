// ═══ Lightweight API response cache ═══
// Avoids re-querying the DB on rapid dashboard refreshes.

const apiCache = new Map<string, { data: any; ts: number }>();

export function cached(key: string, ttlMs: number, fn: () => any): any {
  const entry = apiCache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  const data = fn();
  apiCache.set(key, { data, ts: Date.now() });
  return data;
}
