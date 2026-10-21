// ══════════════════════════════════════════════
// Model versions — the ONE place that names each live sleeve's model.
//
// Until 2026-10-20 `trades.strategy_version` was `legacy` on every row (the
// column default), so no row said which model opened it and the audit had to
// rebuild versions from `git log` (docs/reports/rw-diagnostico/process.md,
// live.md). Now `insertTrade` stamps every new row of a live sleeve with the
// id of the version its code runs (`currentModelVersionId`), and the
// scorecard attributes a row to the version that OPENED it
// (`rowModelVersion`) — a MODEL_CUTOVER close belongs to the previous
// version, not to the one whose pass happened to close it.
//
// Pure module, no imports: db/database.ts and portfolio/scorecard.ts both
// read it, so it must not depend on either.
//
// WHEN A SLEEVE'S MODEL CHANGES (new signal, sizing, stops…): append a
// version to its list, never edit a past one. `since` is the first instant a
// row can belong to the version (its wiring); `modelStart` is the scorecard
// window anchor — the first FULL session of its own book (see the long
// comment on MODEL_START in scorecard.ts). The LAST entry of each list is
// the version the deployed code writes; versionTable tests lock the shape.
// ══════════════════════════════════════════════

export interface ModelVersion {
  /** What lands in trades.strategy_version. Format `<sleeve>@<name>`. */
  id: string;
  /** ISO UTC — first instant a row can belong to this version. Used only to
   *  attribute rows written before the stamp existed (legacy / ops_sync). */
  since: string;
  /** First full session of this version's own book (scorecard "model"
   *  window anchor, YYYY-MM-DD). null = no scorecard window was ever defined. */
  modelStart: string | null;
  /** One line: what this model is. */
  note: string;
}

const EPOCH = "1970-01-01T00:00:00Z";

/** Oldest → newest per sleeve. Keys = ALL_PROFILE_IDS (enforced by test). */
export const MODEL_VERSIONS: Readonly<Record<string, readonly ModelVersion[]>> = {
  momentum_stocks: [
    { id: "momentum_stocks@pre-blend", since: EPOCH, modelStart: null,
      note: "every model before the daily blend: 5m kernel, daily h126/MA200 (until 2026-09-25)" },
    { id: "momentum_stocks@blend-k100", since: "2026-09-25T20:00:00Z", modelStart: "2026-09-28",
      note: "daily TSM blend 63/126/252 / MA200, 8 slots x 0.125; first pass 2026-09-28 (its MODEL_CUTOVER closed META/AAPL of the previous model)" },
    { id: "momentum_stocks@blend-k150", since: "2026-10-12T00:00:00Z", modelStart: "2026-10-13",
      note: "same kernel, 8 slots x 0.1875 (line E, k150 artifact cb516547…); MODEL_CUTOVER pass 2026-10-12" },
  ],
  meanrev_stocks: [
    { id: "meanrev_stocks@pre-slot10", since: EPOCH, modelStart: null,
      note: "Connors RSI(2)/SMA200 daily, 5 slots x 0.10, before 2026-09-25" },
    { id: "meanrev_stocks@slot10", since: "2026-09-25T00:00:00Z", modelStart: null,
      note: "7 slots x 0.10 (ran 2026-09-25 only)" },
    { id: "meanrev_stocks@slot12", since: "2026-09-28T00:00:00Z", modelStart: "2026-09-28",
      note: "7 slots x 0.12 (artifact 624d50e9…), wired 2026-09-28 before the open" },
  ],
  momentum_crypto: [
    { id: "momentum_crypto@pre-vt35", since: EPOCH, modelStart: null,
      note: "hourly TSM 4 slots before the vol-target (until 2026-09-23)" },
    { id: "momentum_crypto@vt35", since: "2026-09-23T00:00:00Z", modelStart: "2026-09-27",
      note: "hourly TSM + volTarget vt-35 (artifact 06e1a160…), wired 2026-09-23; first full own-book day 2026-09-27" },
  ],
  momentum_crypto_usdc: [
    { id: "momentum_crypto_usdc@hourly-13b", since: "2026-07-20T00:00:00Z", modelStart: null,
      note: "hourly TSM, 13 bases, launched 2026-07-20 (refuted control, replaced by the daily kernel)" },
    { id: "momentum_crypto_usdc@daily-d13s5", since: "2026-09-27T00:00:00Z", modelStart: "2026-09-29",
      note: "daily d13-s5 blend 63/126/252 x 0.2 (artifact 752767ae…/413ffb90…); first daily decision 2026-09-27, MODEL_CUTOVER 2026-09-29 00:00 UTC" },
  ],
  momentum_btc: [
    { id: "momentum_btc@hourly-coinm", since: EPOCH, modelStart: null,
      note: "COIN-M BTC hourly TSM (opt-in, MOMENTUM_COINM_ENABLED)" },
  ],
};

const SINCE_MS = new Map<string, number>();
for (const list of Object.values(MODEL_VERSIONS)) for (const v of list) SINCE_MS.set(v.id, Date.parse(v.since));

/** The version the deployed code runs for this sleeve (null = not a
 *  versioned live sleeve, e.g. shadow books or test accounts). */
export function currentModelVersion(sleeveId: string): ModelVersion | null {
  const list = MODEL_VERSIONS[sleeveId];
  return list && list.length > 0 ? list[list.length - 1] : null;
}

/** What insertTrade writes into trades.strategy_version for this account. */
export function currentModelVersionId(sleeveId: string): string | null {
  return currentModelVersion(sleeveId)?.id ?? null;
}

/** The version a row opened at `entryTimeMs` belongs to: the newest one whose
 *  `since` is not after the entry. Rows opened before the first version's
 *  `since` (never, EPOCH) resolve to the first. null = unversioned sleeve. */
export function modelVersionAt(sleeveId: string, entryTimeMs: number): ModelVersion | null {
  const list = MODEL_VERSIONS[sleeveId];
  if (!list || list.length === 0) return null;
  let found = list[0];
  for (const v of list) if ((SINCE_MS.get(v.id) ?? 0) <= entryTimeMs) found = v;
  return found;
}

/**
 * THE attribution rule: a row belongs to the version that OPENED it.
 *  • stamped with one of the sleeve's version ids → that version, whatever
 *    pass closed it (a MODEL_CUTOVER close keeps its opening version);
 *  • `legacy` / `ops_sync` / any other label (rows written before the stamp
 *    existed, adoption rows) → the version live at its entry time.
 * Never looks at exit_time or close_reason.
 */
export function rowModelVersion(
  sleeveId: string,
  row: { strategy_version?: string | null; entry_time?: number | null },
): string | null {
  const list = MODEL_VERSIONS[sleeveId];
  if (!list || list.length === 0) return null;
  const stamped = row.strategy_version;
  if (stamped && list.some(v => v.id === stamped)) return stamped;
  if (row.entry_time == null) return null;
  return modelVersionAt(sleeveId, row.entry_time)?.id ?? null;
}

/** Scorecard window anchors: the current version's modelStart per sleeve
 *  (sleeves whose current version defines none are omitted). */
export function currentModelStarts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [sleeve, list] of Object.entries(MODEL_VERSIONS)) {
    const ms = list[list.length - 1]?.modelStart;
    if (ms) out[sleeve] = ms;
  }
  return out;
}
