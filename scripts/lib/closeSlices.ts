/**
 * 15:45-slice helpers shared by the §12-septies kernels (G0:
 * scripts/meanrev-replay.ts execution="close1545"; G:
 * scripts/stocks-reversal-replay.ts closeReversal) and their drivers.
 *
 * The slice database ($UC_RESEARCH_DATA_DIR/hist-sp500-close.db, written by
 * scripts/download-close-slice.ts) stores RAW prints:
 *   close_slices(symbol, session, slice_start_ms, raw_c1545)
 *   raw_daily_closes(symbol, session, raw_close)
 * The adjusted 15:45 price is computed at replay time against the SAME
 * adjusted dailies the kernel trades on:
 *   p1545_adj = adjClose(session) × raw_c1545 / raw_close
 * (the intra-session raw ratio is split/dividend-free, so the product sits
 * exactly on the dailies' adjustment basis — see the downloader header).
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface CloseSliceRow {
  /** 15-minute bar start (15:30 / 12:30 ET). The 15:45 decision instant is
   *  sliceStartMs + 15 min. */
  sliceStartMs: number;
  /** raw_c1545 / raw_close — multiply by the session's ADJUSTED close to get
   *  the 15:45 price on the dailies' basis. */
  ratio: number;
}

/** symbol → session dateKey → slice row. Only sessions where BOTH the
 *  15-minute raw close and the raw daily close exist (and are positive)
 *  carry a 15:45 price; anything else = no signal that session. */
export function loadCloseSlices(dbPath: string): Map<string, Map<string, CloseSliceRow>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      `SELECT s.symbol symbol, s.session session, s.slice_start_ms ms, s.raw_c1545 c1545, d.raw_close rclose
       FROM close_slices s
       JOIN raw_daily_closes d ON d.symbol = s.symbol AND d.session = s.session
       ORDER BY s.symbol ASC, s.session ASC`,
    ).all() as Array<{ symbol: string; session: string; ms: number; c1545: number; rclose: number }>;
    const out = new Map<string, Map<string, CloseSliceRow>>();
    for (const r of rows) {
      if (!(r.c1545 > 0) || !(r.rclose > 0)) continue;
      let m = out.get(r.symbol);
      if (!m) { m = new Map(); out.set(r.symbol, m); }
      m.set(r.session, { sliceStartMs: r.ms, ratio: r.c1545 / r.rclose });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Deterministic SHA-256 over every (joined) slice row — the slice data's
 *  contribution to a run's data identity. Deliberately covers the WHOLE
 *  database (not window-scoped): the slice DB is pinned for this research
 *  line, and re-downloading it is a data-identity event by design. */
export function hashCloseSlices(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const hash = createHash("sha256");
    const rows = db.prepare(
      `SELECT s.symbol symbol, s.session session, s.slice_start_ms ms, s.raw_c1545 c1545, d.raw_close rclose
       FROM close_slices s
       JOIN raw_daily_closes d ON d.symbol = s.symbol AND d.session = s.session
       ORDER BY s.symbol ASC, s.session ASC`,
    ).all() as Array<{ symbol: string; session: string; ms: number; c1545: number; rclose: number }>;
    hash.update(`closeSlices:${rows.length}\n`);
    for (const r of rows) hash.update(`${r.symbol}|${r.session}|${r.ms}|${r.c1545}|${r.rclose}\n`);
    return hash.digest("hex");
  } finally {
    db.close();
  }
}

const ET_NOON_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
});

/** Epoch ms that getETDateKey maps to `dateKey` with wide margin (17:00 UTC
 *  = noon/13:00 ET in both EST and EDT) — the "engine clock" stamp the
 *  close1545 replay uses for the NEXT-session decision clock. */
export function noonEtMs(dateKey: string): number {
  const ts = Date.parse(`${dateKey}T17:00:00.000Z`);
  const parts: any = Object.fromEntries(ET_NOON_FMT.formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  const got = `${parts.year}-${parts.month}-${parts.day}`;
  if (got !== dateKey) throw new Error(`noonEtMs: ${dateKey} rendered ${got}`);
  return ts;
}

/** Next calendar dateKey (UTC arithmetic on the YYYY-MM-DD label) — the
 *  clock date for the LAST session of a fold, where no next session exists. */
export function nextCalendarKey(dateKey: string): string {
  const ms = Date.parse(`${dateKey}T00:00:00.000Z`) + 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
