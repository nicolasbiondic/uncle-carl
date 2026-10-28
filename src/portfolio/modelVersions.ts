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

/** Authoritative pure-chain artifact of a version (data/backtests/<sha256>/,
 *  gitignored): runs.jsonl + manifest-resolved.json + summary.json. Its OOS
 *  daily returns ARE the version's expectation (scorecard band, Telegram
 *  "POR DEBAJO" page, cost calibration's break-even curve, tearsheet). */
export interface ModelVersionArtifact {
  /** Repo-root relative directory. */
  dir: string;
  /** Daily-bar MOMENTUM replays (backtest-momentum-wf) label a session by its
   *  END (next midnight), one calendar day late — −1 realigns to trading-date
   *  labels. Meanrev and portfolio-engine replays label by session date: 0.
   *  Only affects date labels, never the return values. */
  shiftDays: number;
}

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
  /** Which engine runs it. Absent = the sleeve's incumbent engine (TSM /
   *  Connors, wired in src/index.ts); "portfolio" = the portfolio engine on a
   *  registry definition (RW2, src/portfolio-engine/live/cutover.ts) — the
   *  incumbent is NOT built, its config describes nothing that runs. */
  engine?: "portfolio";
  /** Experiment manifest (repo-root relative) whose candidate this version
   *  runs — what "vivo = validado" compares against (liveSleeveConfigs,
   *  VALIDATED_PRESETS) and what the cutover script hashes. */
  manifest?: string;
  /** Candidate name inside `manifest` when it holds more than one. */
  candidate?: string;
  /** See ModelVersionArtifact. Absent = no band for this version. */
  artifact?: ModelVersionArtifact;
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
      note: "same kernel, 8 slots x 0.1875 (line E, k150 artifact cb516547…); MODEL_CUTOVER pass 2026-10-12",
      // cb516547… = the k = 1 chain 5f03d68d… with slot × 1.5, gross cap × 1.5 and 6.5% Reg-T interest
      // (+563.2% / 1.12 / DD 31.2%), re-run 2026-10-03 on prod's base with the corrected replay (AUDITS 2026-10-03).
      manifest: "experiments/momentum-stocks-daily-blend3-k150-exposure-v1.json",
      artifact: { dir: "data/backtests/cb516547be365b7080cb56357a391ae73535aa3db3f83295fe9c935b7a7ed031", shiftDays: -1 } },
    { id: "momentum_stocks@pe-vt15", since: "2026-10-23T05:00:00Z", modelStart: "2026-10-26",
      note: "RW2 E1: always-invested vol-managed portfolio engine (volManaged vt15, artifact b2324d4f…); owner cutover 2026-10-22 ('empieza ahora') after 2 observed sessions; first live pass 2026-10-23 adopts the book",
      engine: "portfolio",
      // RW2 §9: Sharpe OOS 1.29, +262%, DD 21.9%, PSR 0.999; R1–R7 met. Portfolio replays label by session date.
      manifest: "experiments/rw2-e1-stocks-volmanaged-v1.json", candidate: "vt15",
      artifact: { dir: "data/backtests/b2324d4f74f15042af8bfba4170df8b41f05e8ec033e324bebe8e284e24e5236", shiftDays: 0 } },
    { id: "momentum_stocks@pe-vt30-g250-sma200-fv5", since: "2026-10-26T13:35:00Z", modelStart: "2026-10-27",
      note: "Quorum Q5 RW5d (RW §16.7-16.8, §16.15-16.16): vt30, gross <= 2.5x, fast vol 5, SPY SMA200 band 1% risk-off core to cash; live account BUY cap 1.9x; cash-defense parity: CAGR 30.1%, Sharpe 1.16, DD 26.2%, account DD 23.8%; first live pass Monday 2026-10-26 09:35 ET",
      engine: "portfolio",
      manifest: "experiments/rw5-e1-lev-vt30-g250-sma200-fastvol5-cash-v1.json", candidate: "e1-lev-vt30-g250-sma200-fastvol5",
      artifact: { dir: "data/backtests/fb410729eaf8cbe6efd32c0193f2e23b0313af4ceae0514aebdff1109a66e74b", shiftDays: 0 } },
    { id: "momentum_stocks@pe-vt30-g250-sma200-fv5-mh5", since: "2026-10-26T13:35:01Z", modelStart: "2026-10-27",
      note: "RW §17.1–17.2, owner 5-day maximum: maxHoldSessions 5, MAX_HOLD close then same-pass rebuy; H passed: CAGR 26.4% vs 30.0%, Sharpe 1.04 vs 1.16, DD 26.6% vs 26.2%, account DD 22.5%; pe-vt30-g250-sma200-fv5 never traded: its first pass is taken by this version (since one second after its predecessor, before the ~13:35:15Z pass); cash defense and account BUY cap 1.9x unchanged",
      engine: "portfolio",
      manifest: "experiments/rw6-e1-lev-vt30-g250-maxhold5-v1.json", candidate: "e1-lev-vt30-g250-maxhold5",
      artifact: { dir: "data/backtests/721d4998f845909c84a0fc35e6dbb44d5fc93cd62de741ff545b1cfd75a8ab03", shiftDays: 0 } },
    { id: "momentum_stocks@pe-vt30-g250-sma200-fv5-mh5-stagger", since: "2026-10-28T13:00:00Z", modelStart: "2026-10-29",
      note: "RW §18.1–18.2 owner stagger: maxHoldSessions 5 plus maxHoldStagger, oldest ceil(lots/5) rotate each session, same-pass rebuy if targeted; H passed: CAGR 25.6% vs 26.4%, Sharpe 1.02 vs 1.04, DD 26.8% vs 26.6%, account DD 22.9%, about 1.5 closes/session; cash defense and account BUY cap 1.9x unchanged",
      engine: "portfolio",
      manifest: "experiments/rw7-e1-lev-vt30-g250-maxhold5-stagger-v1.json", candidate: "e1-lev-vt30-g250-maxhold5-stagger",
      artifact: { dir: "data/backtests/ebebfe244b770736cbf268747c348077f00b6718677778f53bb395f15622a17d", shiftDays: 0 } },
  ],
  meanrev_stocks: [
    { id: "meanrev_stocks@pre-slot10", since: EPOCH, modelStart: null,
      note: "Connors RSI(2)/SMA200 daily, 5 slots x 0.10, before 2026-09-25" },
    { id: "meanrev_stocks@slot10", since: "2026-09-25T00:00:00Z", modelStart: null,
      note: "7 slots x 0.10 (ran 2026-09-25 only)" },
    { id: "meanrev_stocks@slot12", since: "2026-09-28T00:00:00Z", modelStart: "2026-09-28",
      note: "7 slots x 0.12 (artifact 624d50e9…), wired 2026-09-28 before the open",
      // 624d50e9… = 7 × 0.12 pure chain on the adjustment=all research DB (supersedes 03382972…, 7 × 0.10 split-only).
      manifest: "experiments/meanrev-slot12-pure-v1.json",
      artifact: { dir: "data/backtests/624d50e930d47ef55e42f16e6537e0e895dec847fb0b709c26b2ecd94ea37db7", shiftDays: 0 } },
    { id: "meanrev_stocks@pe-vt15", since: "2026-10-23T05:00:00Z", modelStart: "2026-10-26",
      note: "RW2 E2: always-invested vol-managed portfolio engine (volManaged vt15, artifact 0b088ca3…); owner cutover 2026-10-22 ('empieza ahora') after 2 observed sessions; first live pass 2026-10-23",
      engine: "portfolio",
      // RW2 §9: Sharpe OOS 1.11, +150%, DD 21.0%, PSR 0.997; R1–R7 met.
      manifest: "experiments/rw2-e2-meanrev-volmanaged-v1.json", candidate: "vt15",
      artifact: { dir: "data/backtests/0b088ca320e3521d8bff05b10c1ad7eed2816bc2a1b0b927eb3134e2a3dca4c2", shiftDays: 0 } },
    { id: "meanrev_stocks@pe-vt15-mh5", since: "2026-10-26T13:00:00Z", modelStart: "2026-10-27",
      note: "RW §17.1–17.2, owner 5-day maximum: maxHoldSessions 5, MAX_HOLD close then same-pass rebuy; H passed: CAGR 11.4% vs 13.2%, Sharpe 0.94 vs 1.11, DD 18.0% vs 21.0%; same vt15 portfolio kernel, 6.4 trades/session",
      engine: "portfolio",
      manifest: "experiments/rw6-e2-meanrev-maxhold5-v1.json", candidate: "vt15-maxhold5",
      artifact: { dir: "data/backtests/41fdc636f209217bede8220cd4d690000ea4b4e71983dab1f5a6c99a2d5c3ee2", shiftDays: 0 } },
    { id: "meanrev_stocks@pe-vt15-mh5-stagger", since: "2026-10-28T13:00:00Z", modelStart: "2026-10-29",
      note: "RW §18.1–18.2 owner stagger: maxHoldSessions 5 plus maxHoldStagger, oldest ceil(lots/5) rotate each session, same-pass rebuy if targeted; H passed: CAGR 11.3% vs 11.4%, Sharpe 0.93 vs 0.94, DD 18.6% vs 18.0%, about 4.9 closes/session",
      engine: "portfolio",
      manifest: "experiments/rw7-e2-meanrev-maxhold5-stagger-v1.json", candidate: "vt15-maxhold5-stagger",
      artifact: { dir: "data/backtests/2325210c8c7ad56fbbec9d833f2ae9ef641ed85a25d9af357eb693d43dfbb50f", shiftDays: 0 } },
  ],
  momentum_crypto: [
    { id: "momentum_crypto@pre-vt35", since: EPOCH, modelStart: null,
      note: "hourly TSM 4 slots before the vol-target (until 2026-09-23)" },
    { id: "momentum_crypto@vt35", since: "2026-09-23T00:00:00Z", modelStart: "2026-09-27",
      note: "hourly TSM + volTarget vt-35 (artifact 06e1a160…), wired 2026-09-23; first full own-book day 2026-09-27",
      // 06e1a160… supersedes a5101316… (vt-35 control pure chain), re-run 2026-10-03 with the corrected replay
      // (+509.8% / 1.31 / DD 32.6%, same failed gate maxDisplacementShare). Same candidate as
      // momentum-crypto-vt35-pure-v1, on a window that includes the live months.
      manifest: "experiments/momentum-crypto-2026w-control-pure-v1.json",
      artifact: { dir: "data/backtests/06e1a160c3556102aa2fff769f9e4c2a3d27d09a6f3874841286426425faf6e4", shiftDays: 0 } },
    { id: "momentum_crypto@vt35-corroff", since: "2026-10-23T09:00:00Z", modelStart: "2026-10-24",
      note: "RW3 c1: same vt-35 kernel with the correlation-collapse entry brake OFF (regime.correlationCeiling 0.85 → 1.01; the vol-spike check stays ON); artifact efc086b4…; since = the PROJECTED deploy hour (the director sets the real one, see scripts/parity-check.ts); sleeve flat at the cutover, RiskState re-anchored",
      // efc086b4… = momentum-crypto-rw3-vt-35-corroff-pure-v1 (asOf pinned to the control's, so folds and OOS days are
      // identical to the control 39f732bc…): Sharpe 1.331 vs 1.313, DD 34.3%, PSR 0.998, fold PSRs 0.963/0.988/0.687,
      // worst LOO 0.70 × Sharpe, combined-book DD 14.0% — every RW §10.4 (c1) criterion. Hourly crypto replay
      // (timeframe 1h) labels sessions by date ⇒ shiftDays 0 (dailyReturnShiftDays only shifts "1d" momentum replays).
      // The live candidate must equal this manifest's single candidate (liveSleeveConfigs.test.ts).
      manifest: "experiments/momentum-crypto-rw3-vt-35-corroff-pure-v1.json",
      artifact: { dir: "data/backtests/efc086b47776235749e7013458360f8131cb3d3629b0a143f6c994d2bb16f240", shiftDays: 0 } },
    { id: "momentum_crypto@vt35-corroff-mh120", since: "2026-10-26T13:00:00Z", modelStart: "2026-10-27",
      note: "RW §17.1–17.2 criterion H, results §17.3: owner 5-day maximum via timeStop 120h; H passed on common days: CAGR 15.8% vs 55.2%, Sharpe 0.61 vs 1.33, DD 35.3% vs 33.6%, four-sleeve DD 15.9%, 2.1 orders/day; no same-pass re-entry; RiskState key NOT changed/re-anchored",
      manifest: "experiments/momentum-crypto-rw6-maxhold5-pure-v1.json",
      artifact: { dir: "data/backtests/b4abce2e6fbca40228f160418331b300c8ed8f9ba75b38cb6e3e4de901aa0f6b", shiftDays: 0 } },
    { id: "momentum_crypto@vt35-corroff-mh120-nobrakes", since: "2026-10-28T13:00:00Z", modelStart: "2026-10-29",
      note: "RW §18.3–18.5 owner never-stop rule: sizeOnly risk, regime OFF, no Sharpe gate, allowSameTickReentry; vt35 sizing, protective stops and 120h cap stay; N passed: CAGR 13.1% vs 15.8%, Sharpe 0.51 vs 0.61, DD 50.1% vs 35.3%, four-sleeve DD 16.1%, 3.4 orders/day; RiskState key NOT changed/re-anchored",
      manifest: "experiments/momentum-crypto-rw7-nobrakes-pure-v1.json",
      artifact: { dir: "data/backtests/2deab5da842e52f51a5346f6231c694c146820cca15f3efee22a9ec60c4e2598", shiftDays: 0 } },
  ],
  momentum_crypto_usdc: [
    { id: "momentum_crypto_usdc@hourly-13b", since: "2026-07-20T00:00:00Z", modelStart: null,
      note: "hourly TSM, 13 bases, launched 2026-07-20 (refuted control, replaced by the daily kernel)" },
    { id: "momentum_crypto_usdc@daily-d13s5", since: "2026-09-27T00:00:00Z", modelStart: "2026-09-29",
      note: "daily d13-s5 blend 63/126/252 x 0.2 (artifact 752767ae…/413ffb90…); first daily decision 2026-09-27, MODEL_CUTOVER 2026-09-29 00:00 UTC",
      // AUTHORITATIVE but NOT gate-certified (U1 rounds 3-5: 15/17 gates, fails maxDrawdown 52.4%>45 and excess vs
      // BTC −24.4pp); replaced the refuted hourly control per the pre-registered criterion. 413ffb90… supersedes
      // 752767ae… (corrected replay). Daily-bar MOMENTUM replay ⇒ session labelled by its END ⇒ shiftDays −1.
      manifest: "experiments/momentum-crypto-usdc-daily-s5-pure-v1.json",
      artifact: { dir: "data/backtests/413ffb90cd968bfdfe51f1b1eebc87612f262ce9ecb7d2ca82fd59383a704625", shiftDays: -1 } },
    { id: "momentum_crypto_usdc@daily-d13s5-xc-dd", since: "2026-10-24T00:00:00Z", modelStart: "2026-10-24",
      note: "RW4a c2: the same d13-s5 kernel plus the drawdown exposure control on the OPEN book (λ 1 down to 10% dd, then the line to 0 at 40% floored at 0.25 — 0.67 at 20%, floor from 32.5%, RW §13.6 erratum; band 10 pp, min order 100 USD; soft-DD pause stays ON); artifact 8892c1e9…; since = the first DAILY pass after the PROJECTED deploy (00:00:15 UTC 10-24 — the director sets the real one, see scripts/parity-check.ts); RiskState NOT re-anchored (same kernel built the live drawdown the control reads)",
      // 8892c1e9… = momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1 (byte copy of the control's manifest 413ffb90… /
      // asOf 2026-09-26 plus the knob; identical data hash 55da03c9…): Sharpe 1.038 vs 1.028 on 1,410 common days,
      // CAGR 45.1% vs 45.4%, DD 51.9% vs 52.6%, PSR 0.978, fold PSRs 0.93/0.72/0.91, worst LOO 0.74 × Sharpe,
      // combined-book DD 13.8%, 104 resizes (69 cuts, 35 add-backs) — every RW §13.4 (c2) criterion. Daily-bar
      // MOMENTUM replay (timeframe "1d", no meanrev/portfolio key) ⇒ dailyReturnShiftDays infers −1, same as the
      // control. The live candidate must equal this manifest's single candidate (liveSleeveConfigs.test.ts).
      manifest: "experiments/momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1.json",
      artifact: { dir: "data/backtests/8892c1e950818ee724cbd5473ffdb6d207aefc98ae1f054d3bdf08e4eebad607", shiftDays: -1 } },
    { id: "momentum_crypto_usdc@daily-d13s5-xc-dd-mh120", since: "2026-10-26T13:00:00Z", modelStart: "2026-10-27",
      note: "RW §17.1–17.2 criterion H, results §17.3: owner 5-day maximum via timeStop 120h at daily decisions; H passed: CAGR 24.7% vs 45.1%, Sharpe 0.76 vs 1.04, DD 48.1% vs 51.9%, four-sleeve DD 16.0%, 0.8 orders/day; no same-pass re-entry; exposure control unchanged, RiskState key NOT changed/re-anchored",
      manifest: "experiments/momentum-crypto-usdc-daily-s5-rw6-maxhold5-pure-v1.json",
      artifact: { dir: "data/backtests/74efd64b61a839df9844fbe7039c384cd694a0b4ad2d319762b0d71798bfb783", shiftDays: -1 } },
    { id: "momentum_crypto_usdc@daily-d13s5-xc-dd-mh120-sizeonly", since: "2026-10-28T13:00:00Z", modelStart: "2026-10-29",
      note: "RW §18.4–18.5 owner never-stop rule: sizeOnly risk removes pauses only; regime, Sharpe gate, cooldown, exposureControl floor 0.25 and 120h cap stay (full nobrakes failed N); N passed: CAGR 10.3% vs 24.7%, Sharpe 0.44 vs 0.76, DD 57.2% vs 48.1%, four-sleeve DD 16.9%; RiskState key NOT changed/re-anchored",
      manifest: "experiments/momentum-crypto-usdc-daily-s5-rw7-sizeonly-pure-v1.json",
      artifact: { dir: "data/backtests/68181bd662a9462ad79e3802076ad9dd25d6ad3023b363c074255c090c1fa644", shiftDays: -1 } },
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

/** The current version's manifest per sleeve (sleeves whose current version
 *  names none are omitted). liveSleeveConfigs' LIVE_SLEEVE_MANIFESTS and
 *  validate.ts's VALIDATED_PRESETS read it: one source for "what justified
 *  what runs". */
export function currentModelManifests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [sleeve, list] of Object.entries(MODEL_VERSIONS)) {
    const m = list[list.length - 1]?.manifest;
    if (m) out[sleeve] = m;
  }
  return out;
}

/** true when the sleeve's CURRENT version runs on the portfolio engine: its
 *  incumbent engine is not built, so derivations of the incumbent's wiring
 *  (liveSleeveConfigs, parity replays, decision_passes funnels) describe
 *  nothing that trades. */
export function isPortfolioEngineSleeve(sleeveId: string): boolean {
  return currentModelVersion(sleeveId)?.engine === "portfolio";
}
