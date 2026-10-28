# Portfolio engine: integration notes

The plan and the pre-registration: `docs/reports/RW-reescritura-rentable.md`.
The contract: `types.ts`. The pure core (`index.ts`): `decide`,
`planOrders`, signals, construction, stops, costs. The research simulator:
`scripts/portfolio-replay.ts`; the live runner: `live/`, consumed by
`src/index.ts` through the registry (observer alongside an incumbent, live
instead of it, rollback). No sleeve is configured by the code: the registry
definition is written by `scripts/portfolio-engine-cutover.ts` from a
manifest candidate (runbook below).

## Calling the core

- One decision per session: `decide()` with `view.asOf` = the last completed
  session and `executionSession` = the session the orders execute in. D2
  reconstitutes when `executionSession` is the first session of a month,
  with that session's membership; prices still stop at `asOf`.
- Size orders with `planOrders(target, book, prices, rules)`, where `prices`
  are the reference prices the caller marks the book with.
- After the fills, call `decide()` once more with the actual positions, the
  memory returned by the first call and the same view and
  `executionSession`. Persist that second memory and sync its `stops`; do not
  submit a second rebalance. This sets the stop levels from the real average
  entry.
- Persist `TargetBook.memory` unchanged, per strategy version. Two versions
  never share memory.

## Initial states

- Trend signals start off; the D2 overlay starts off. A first decision inside
  a hysteresis band keeps that state.

## Live venues

- `venues/binance.ts` takes `claimOrderId(id)`: it must record the id
  atomically in persistent storage before returning `true`, and never expire
  it. That is what keeps a retry after a restart from sending a second order.
- Alpaca: fractional market DAY orders; never a full-position DELETE
  (AGENTS.md, "Alpaca close semantics").

## Running it on a sleeve (RW2)

### How it is wired

- A registry definition with `template: "portfolio"` (`PORTFOLIOS_SOURCE=db`)
  runs the engine on an EXISTING sleeve: `params.sleeve` is the sleeve's
  `trades.account_id` (`momentum_stocks`, `meanrev_stocks`, `momentum_crypto`,
  `momentum_crypto_usdc`). The definition has its own id (`pe_<sleeve>`); the
  incumbent's row is never edited.
- `src/index.ts` (step 8b) resolves the definitions (`live/cutover.ts`
  `resolvePortfolioWiring`), constructs the engines (`live/wiring.ts`) BEFORE
  any incumbent, then starts them after the incumbents. Alpaca: `AlpacaVenue`
  over the shared executor; Binance: `BinanceVenueAdapter` over the executor's
  own transport (`BinanceExecutor.venueTransport`) with `claimOrderId` =
  `portfolio_order_claims` (one `INSERT OR IGNORE`, durable, never released).
- Schedule: stocks one pass per ET trading day at >= 09:35 on the previous
  completed session; crypto >= 00:00:15 UTC on the just-closed UTC day
  (`live/schedule.ts`; `engine.start()` ticks every 60 s). Heartbeat
  `portfolio:<sleeve>`, daily, grace x5, registered by `start()`, beaten by
  every idle or successful tick.

### Semantics

| | incumbent | portfolio engine |
|---|---|---|
| no definition | manages | not built |
| `runMode: observer` | manages, untouched | computes and persists decisions on the sleeve's real rows; sends nothing, mutates no row, cancels no stop |
| `runMode: live` (and `mode: live`) | NOT built: no entries, no exits (`portfolioEnabled()` is false for the sleeve) | manages. On its first pass it adopts the open rows (re-tag to `PORTFOLIO`, quantity untouched: no close, no rebuy), cancels the incumbent's resting stops on them, and orders only the delta to the target |
| rollback (observer, removed, or refused at boot) | manages again | not live |

- Rows tagged `PORTFOLIO` are outside the 15 s stop loop and the broker-native
  stop pass (`isPortfolioEngineRow`); BrokerSync never closes them (ids `pf_`,
  not `sync_`; strategy not `BROKER_SYNC`). The only stops they carry are the
  design's own (`syncStops`, D3).
- Rollback: at the next boot, BEFORE the incumbent starts, every open
  `PORTFOLIO` row of a sleeve the incumbent manages is re-tagged to the
  incumbent's strategy (`MOMENTUM` / `MEANREV`; `strategy_version` stays: a row
  belongs to the version that opened it) and the activity log and ops are
  told. Stocks: the 15 s loop and the native-stop pass see them again by
  themselves (row stop absent: the 4 % fallback). Binance: the incumbent arms
  its native stop at open only, so the boot step arms one per handed-back row
  (`placeStopMarketClose`, profile stop %); a failure pages "protect it
  manually". Stops the engine placed itself (`pe-s-`) stay at the venue.

### Fail closed (toward the incumbent, with a page)

A definition runs LIVE only if all of these hold; otherwise the incumbent keeps
the sleeve, ops gets an `ERROR_BURST` ("NOT live: ...") and the activity log a
`circuit` row:

- `params.sleeve` is one of the four sleeves; the definition id is not the
  sleeve id; `account` and `venue` are the sleeve's; `runMode: live` and
  `mode: live` agree; universe symbols are in the sleeve's row symbol space
  (stocks: no slash; USDT `XXX/USD`; USDC `XXX/USDC`, the bars mapped back by
  `dataSymbols`), design kind fits the venue; `factorCore` is refused (no live
  point-in-time membership source exists yet);
- exactly one enabled definition targets the sleeve when one of them is live
  (two live, or live + observer: none runs);
- live = tested: `provenance.designSha256` equals the hash of the stored design
  (a design edited after the script wrote it is refused);
- `strategyVersion` is the LAST entry of `MODEL_VERSIONS[sleeve]`;
- the universe holds no treasury ETF (BOXX/SGOV/BIL) and no symbol of another
  sleeve of the same account (shared wallet: `closePosition` aggregates);
- the venue is reachable by this process (linked account; USDC needs
  `MOMENTUM_USDC_ENABLED=true`);
- the engine can be constructed (venue client, `historical.db`).

Last line of defence: `sleevesWithTwoManagers` after the incumbents are built;
if a live sleeve still has an incumbent the portfolio engine is not started.
A sleeve with `PORTFOLIO` rows and no manager at all (incumbent gated off, venue
unlinked) pages every boot ("orphaned").

### Interplay with the shared Alpaca wallet

- Treasury sweep (`ALPACA_TREASURY_SWEEP`, BOXX): buys find cash the way the
  incumbents do. The engine sizes from the sleeve ledger, never from account
  cash; buys obey account Reg-T buying power and the live-only 1.9× account
  gross-long cap (`ALPACA_ACCOUNT_MAX_GROSS`), including treasury holdings. The
  cap clips buys (account reads fail open); it does not force sells when marks
  move above it. Shared-executor portfolio buys serialize through settlement.
  The 15:50 cover
  sells BOXX when the day's buys drew cash negative. `AlpacaVenue.submit` mirrors
  `regt_buying_power` before every buy (blocked pre-submit with
  `insufficient_buying_power`, reported as a rejected order, paged; unreadable
  fails open; sells never guarded). The sweep runs at >= 10:30 ET, after the
  09:35 pass, and sells only BOXX. A treasury ETF in a live universe is refused.
- BrokerSync: no phantom deletes (see above); the engine reconciles its own rows
  to the broker (broker = truth): a smaller broker quantity shrinks/closes the
  row (`PORTFOLIO_RECONCILED`), a larger one is reported and left alone.
- Versions and scorecard (`src/portfolio/modelVersions.ts`): a sleeve going live
  on the portfolio engine APPENDS a version there (`<sleeve>@pe-<candidate>`,
  with `engine: "portfolio"`, `manifest`, `candidate` and `artifact`), never
  edits a past one; it must be the last entry before the engine may run live
  (boot check above and the script's). That entry is the ONE source every
  peripheral consumer reads: the scorecard band (its OOS daily returns),
  Telegram's POR DEBAJO page, cost calibration's break-even curve, the
  tearsheet, `LIVE_SLEEVE_MANIFESTS`, `VALIDATED_PRESETS` (template
  `portfolio`, not creatable from the dashboard) and the governor's evidence
  version — so nothing judges the engine against the incumbent's artifact.
  The scorecard attributes a row to the version that opened it, so adopted
  rows keep the incumbent's version and the new rows carry the engine's.
  Rolling back appends nothing by itself: add an entry for the incumbent's
  config in the next deploy (until then new incumbent rows are stamped with
  the engine's version; their `since` bounds it).
- Peripheral consumers of the INCUMBENT's config: `scripts/parity-check.ts`
  skips a sleeve whose live manager is the engine (reads `platform_portfolios`;
  explicit SKIPPED line, no page) — decision parity for the engine is an open
  item (OPEN.md); `liveSleeveConfig(sleeve).managedBy` says "portfolio" and its
  derivation is the rollback config; the dashboard registry lists the
  incumbent row as "gestionado por el motor de cartera (pe_x)" and the `pe_*`
  row with the sleeve's band; the governor registers the sleeve itself under
  the engine's version (`index.ts`). Cost calibration and the decision funnel
  get no observations from the engine (no `fills`/`decision_passes` rows —
  OPEN.md).

### Runbook (per sleeve; `scripts/portfolio-engine-cutover.ts`, dry-run by default)

This is the incumbent → portfolio runbook. For a portfolio → portfolio change,
an observer CANNOT run beside the current live definition: the resolver refuses
both. Appending a new last model version also refuses the old live definition on
the next boot. Coordinate definition + code in one release; RW5d's explicit
zero-observation exception and portfolio rollback: `docs/reports/rw5-contingencia/cableado-rw5d.md`.

1. Observer: `bun scripts/portfolio-engine-cutover.ts --sleeve <id> --mode observer --manifest experiments/<m>.json --candidate <name>`
   (read the plan) then the same with `--apply`, then restart the bot. The
   incumbent trades on; `portfolio_decisions` fills (one `observed` row per
   session; orders carry `skipped: observer`). Watch the heartbeat
   `portfolio:<sleeve>` and the ops pages.
2. Cutover prerequisites: >= 3 observed passes of the same design (the script
   checks `--min-observed`); append `{ id: "<sleeve>@pe-<candidate>", ... }` to
   `MODEL_VERSIONS[sleeve]` and deploy; no other definition on the sleeve.
3. Live: `--mode live` (same manifest and candidate; dry-run, read, `--apply`),
   restart the bot AT A QUIET TIME (stocks: before 09:35 ET, crypto: not within
   a minute of 00:00 UTC). The boot log says `LIVE on the portfolio engine`
   and `applied pending edits: pe_<sleeve>` (the row's `status` goes
   `pending_restart` → `active` on the boot that reads it); the first pass
   adopts and trades the delta. Verify: `activity_log` rows
   "adopted"/"released", rows `strategy = 'PORTFOLIO'`, no pages, `/healthz/full`
   heartbeat fresh, the incumbent's engine absent from the boot log, the next
   04:45 parity cron printing `SKIPPED — live manager is the portfolio engine`
   for the sleeve.
4. Rollback: `--mode rollback` (back to observer, keeps evidence) or
   `--mode rollback --remove` (deletes the definition), `--apply`, restart. The
   boot re-tags the `PORTFOLIO` rows and arms Binance stops before the
   incumbent starts. The incumbent then manages those positions by ITS rules
   (it may close what its universe/signal does not hold; the engine's
   positions outside the incumbent universe are its decision, not the
   engine's). `PORTFOLIOS_SOURCE=code` is also a full rollback: definitions are
   not read, the rows are handed back.

## RW5 optional volManaged contingencies

Both keys are absent by default: no new memory/diagnostics and byte-identical
decisions, config hashes and candidate hashes for existing manifests. They
currently require stocks (`annualization: 252`). With either knob, manifest
validation permits `maxGross <= 2.5`; without them the existing limit is 2.
This is research capacity, not a statement that Reg-T will fill 2.5x.

### regimeOverlay

```json
{
  "signals": [{ "kind": "maTrend", "symbol": "SPY", "sampling": "monthEnd", "period": 10, "bandPct": 0 }],
  "combine": "any",
  "confirmationDecisions": 1,
  "coreScale": 0,
  "defensive": { "assets": ["IEF", "GLD", "BIL"], "momentumLookback": 63, "volLookback": 63, "cashProxy": "BIL" },
  "hedge": { "symbol": "SH", "fraction": 0.1 }
}
```

- `maTrend`: risk-off below SMA minus `bandPct` percent, risk-on above SMA
  plus the band; equality/in-band retains that signal's state. `daily`
  periods are sessions. `monthEnd` uses the last close of each completed
  calendar month (including the latest in the average), not today's partial
  month. The execution calendar tells the core when `asOf` completed a month;
  without `executionSession`, `asOf`'s month is excluded. Missing months do
  not compress the horizon.
- `absMomentum`: `{kind, symbol, cashProxy, lookback}` compares trailing
  adjusted-close returns on identical session dates. The data provider must
  supply total-return-adjusted closes (stock downloaders use `adjustment=all`);
  the kernel neither invents nor separately adds dividends.
- `canary`: `{kind, assets, horizons, coefficients, negativeCount?}`. A score
  is the sum of coefficient times trailing session return. Keller 13612W is
  `[21,63,126,252]` with `[12,4,2,1]` (21-session month approximation). Risk-off
  when at least `negativeCount` assets score below zero; default 1.
- `combine` is `any`, `all`, or an integer vote threshold. All signals start
  risk-off, as does the aggregate state. A different aggregate request needs
  `confirmationDecisions` consecutive decisions, default 1. Missing/stale
  signal history retains the state and resets confirmation. Same-session
  post-fill calls/retries do not age confirmations or PIT tenure. Memory is
  JSON under `portfolioCore.regime` / `.pit` and crosses research folds.
- On risk-off, core weights are multiplied by `coreScale` in [0,1]. If
  `defensive` is present, freed weight goes inverse-vol to its assets with
  strictly positive trailing momentum and sufficient risk history; if none
  qualifies, all freed weight goes to `cashProxy`. Without `defensive`, it
  remains uninvested cash. Overlapping core/defensive weights add. Optional
  `hedge` is a long inverse-ETF position, `fraction` times the pre-overlay
  core gross, added on top of the defensive allocation. It cannot duplicate
  a fixed core/defensive symbol. Caps can leave some allocation as cash.
- Order: eligible core → inverse-vol normalization → core target-vol scale
  (including existing drawdown/fast-vol knobs) → regime actions → whole-book
  vol ceiling → per-asset clipping → proportional gross cap → whole-book vol
  ceiling again. The final recheck matters when clipping an inverse hedge
  increases risk. **Never relever after the overlay**: that would undo a
  scale-only contingency. Whole-book risk uses slow covariance or the larger
  slow/fast estimate; allocated symbols require fresh aligned covariance
  history, otherwise the decision throws. Constant cash stays allocated,
  not zeroed or infinitely leveraged.
- Every reference/action symbol must be in `data.universe`; replay and live
  load signal-only symbols too. Live does not adopt signal-only positions.
  Shared-wallet/treasury conflict checks include all possible action assets.
  Thus the BIL example is NOT eligible for current production cutover.
- Replay adds `portfolioDiagnostics.regimeOverlay`: `riskOffDays`,
  `switches`, `timeInState`, `weightsByState` (mean final target weights,
  zero included on sessions where absent, not executed weights). Days/time
  are execution-session counts, not calendar days. Cold-start state is
  risk-off, so its first confirmed risk-on transition counts as a switch.

### pitUniverse

```json
{ "topN": 6, "liquidityLookback": 63, "minHoldingRebalances": 21, "exclude": [] }
```

`strategy.universe` becomes the fixed list (the five E1 ETFs in the example).
At each daily decision, add `topN` members effective at execution open,
ranked by mean trailing `close * volume`; prices/volume stop at `asOf`.
Fixed names and optional exclusions do not compete for stock slots. Ties
break lexically. Inception/vol/covariance history and a fresh last bar are
required. Invalid/zero dollar volume is ineligible. A selected name stays
for at least M decisions including selection day, unless membership or data
eligibility is lost; this is selection tenure, not a guarantee of fills.
Unexpired picks occupy slots before fresh top-ranked names. Remaining
construction is unchanged, and both knobs compose.

Research requires `data.membership.index = "sp500"`, loading membership and
all overlapping members' bars from the same `hist-sp500.db` snapshot as
factorCore; the existing data hash covers both. The pure/live runner accepts
an injected `MembershipView`. Production wiring still refuses PIT: no live
membership provider or dynamic shared-wallet collision plan exists yet.

Examples: `experiments/rw5-e1-stocks-regime-ma10-v1.json` and
`rw5-e1-stocks-pit-top6-v1.json`, drafts only. Trial reservations 435→436→437
do not consume trials until the director pre-registers and runs. RW5 names
use existing E1/E2/E3 reporting criteria; new approval thresholds are not
defined by this implementation.
R6 keeps signal data while excluding traded contributors from the core,
PIT selection and defensive set. If it removes the mandatory cash proxy or
hedge, it refuses rather than silently retaining that contributor; a
replacement hypothesis must be pre-registered first. Sensitivity replays
must never mutate the registered candidate block.

## RW6 optional lot renewal (drafts only)

`volManaged.maxHoldSessions` is absent by default (no changed decisions,
memory, telemetry or config/candidate hashes). Positive integer, stocks only
(`annualization: 252`). The book supplies each position's `entrySession`, the
NYSE date of its OPEN row's `entry_time`; increases, partial sales, weighted
average-price changes and adoption do not reset it. Duplicate legacy rows use
the oldest entry. Missing entry dates fail closed rather than inventing age.

At execution-session age >= N (entry session excluded, execution included,
NYSE weekends/holidays excluded), `decide` marks the lot and `planOrders`
emits a full sell before any buys, then a fresh buy to the SAME economic
target if still positive. Mandatory sells bypass the delta band/minimum;
new buys obey venue minimums/rounding and live entry guards. This is N NYSE
sessions, NOT N calendar days; closures happen at the daily pass, not intraday.
Live fills can change exposure through slippage, caps or rejections: a full
round trip is not guaranteed by a plan. A rejected/partial sell never allows
a rebuy into the old row. The old lot stays expired for the next pass; held-
quantity sell retries preserve their existing same-session retry policy.

Close label `MAX_HOLD` goes straight through the portfolio row writer (no
adapter close-reason whitelist exists on this path). The new row gets the
current version and a new entry time. Distinct durable client ids for the two
legs preserve existing ids when the knob is absent. Replay uses the same
decide/plan path, charges slippage/commission on BOTH legs, includes them in
`orders` and `ordersPerSession`, and adds opt-in `maxHoldStats` with executed
`closes`, `rebuys`, `orders` (fold-end liquidation excluded).

RW7 adds `maxHoldStagger: true` (boolean, requires `maxHoldSessions`, off by
default). Each pass selects every expired lot, then adds the oldest held lots
until at least `ceil(heldLots / maxHoldSessions)` are selected (minimum one
for a nonempty book). Entry-session ties break by symbol. Expired lots count
toward that quota and are never limited by it. Early renewals use the same
`MAX_HOLD` close/rebuy, costs, incomplete-close guard and `maxHoldStats` as
expired lots. `ordersPerSession` includes both kinds. No live activation is
implied; the RW7 E1/E2 drafts reserve priors 462/463, dry-run only.

The existing inverse-ETF `hedge` composes with renewal, including when
`coreScale: 0` and `defensive` is absent: its requested weight is h times
PRE-overlay core gross, then existing risk/asset/gross caps apply. It is a
long inverse ETF, not a native short sale. The SH50 draft retains E1's 25%
asset cap, so its final SH weight need not equal 50% of core gross. SH is in
that draft's data universe (history starts 2016-06-27, before its 2017-06-01
window and ample for cov21/fast5). The 420-calendar-day warmup starts earlier
than SH's inception; SH is only required when allocated, not for the core's
252-bar inception guard. Drafts reserve trials 456, 457, 458; only dry-runs
are permitted here. The goal of 30 EXECUTED orders/session includes rebalances;
these drafts measure orders, not claim that goal is met. No live definition
or model version is changed.

## copySignal (research only)

A generic copy-trading kind (`CopySignalConfig` in `types.ts`, kernel `copySignal.ts`): events of a
`source` (SEC Form 4 open-market purchases = `"sec-form4-buy"`) known within `lookbackDays` calendar
days, grouped by symbol; a symbol qualifies with `minDistinctInsiders` distinct `meta.actors` and
`minDollar` of total `weight`; ranked (actors desc, dollars desc, symbol) into `topN` slots; each pick
held `holdDays` calendar days or `holdSessions` sessions (exactly one) from its selection through
`memory.copySignal`, long-only, slot size `maxGross/topN`, `equal` or `inverseVol` inside it, `perNameCap`.
Optional event filters (absent = off): `roles`, `insiderClass` (`all | opportunistic | routine`, from
`meta.insiderClass`; `routine` is the placebo), `exclude10b5_1` (`meta.plan10b5_1`), `maxReportLagDays`
(`meta.lagDays`; an unknown lag is dropped) and `minDollarPerInsider` (an actor counts only with its own
dollars on the symbol). Every copySignal candidate must `exclude` the live stock universes and the treasury
ETFs (`scripts/lib/liveStockExcludes.ts`; `validatePortfolioManifest` enforces it).

- Point in time: `DecideInput.signals` is a `SignalView` (`asOf`, `cutoffMs`, `events(source, lookbackDays)`);
  the research implementation (`scripts/lib/signalData.ts`) clips at the end of `asOf`'s day, and the
  kernel drops any event with `knownAtMs > cutoffMs` anyway. Events an earlier pick already used (`spent`)
  never count twice; a fresh qualifying cluster on a held name renews its clock.
- `membership`, when given, gates NEW picks to the members at the execution session (copySignal
  manifests require `data.membership`: its domain is the point-in-time index).
- Data: `$UC_RESEARCH_DATA_DIR/signals.db`, table `signal_events(source, symbol, known_at_ms, weight,
  meta_json)`, shared with other producers. SEC: `bun scripts/sec-insider-fetch.ts` then
  `bun scripts/sec-insider-build.ts` (see `docs/reports/copy-insider.md`).
- Manifest: `data.signals = { dbPath }` (required for copySignal, forbidden elsewhere; the path is
  runtime-only, the rows enter the data hash), candidates carry `portfolio.strategy.kind = "copySignal"`.
  Criteria: design D4 (`scripts/portfolio-criteria.ts`), benchmarks SPY and the equal-weight members.
- Live refuses it (`cutover.ts`, `PortfolioEngine.ts`, `wiring.ts`): no live signal source exists yet.

### Not done here

No definition is written by the code (that is each cutover's script run).
`factorCore` cannot run until a live point-in-time membership source exists.
The engine writes no `fills` and no `decision_passes` rows, and no decision
parity exists for it (both in OPEN.md with falsifiers).
