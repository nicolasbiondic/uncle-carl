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
  cash; the only gate is the account's Reg-T buying power, and the 15:50 cover
  sells BOXX when the day's buys drew cash negative. `AlpacaVenue.submit` mirrors
  `regt_buying_power` before every buy (blocked pre-submit with
  `insufficient_buying_power`, reported as a rejected order, paged; unreadable
  fails open; sells never guarded). The sweep runs at >= 10:30 ET, after the
  09:35 pass, and sells only BOXX. A treasury ETF in a live universe is refused.
- BrokerSync: no phantom deletes (see above); the engine reconciles its own rows
  to the broker (broker = truth): a smaller broker quantity shrinks/closes the
  row (`PORTFOLIO_RECONCILED`), a larger one is reported and left alone.
- Versions and scorecard (`src/portfolio/modelVersions.ts`): a sleeve going live
  on the portfolio engine APPENDS a version there (`<sleeve>@pe-<candidate>`),
  never edits a past one; it must be the last entry before the engine may run
  live (boot check above and the script's). The scorecard attributes a row to
  the version that opened it, so adopted rows keep the incumbent's version and
  the new rows carry the engine's. Rolling back appends nothing by itself: add
  an entry for the incumbent's config in the next deploy (until then new
  incumbent rows are stamped with the engine's version; their `since` bounds it).

### Runbook (per sleeve; `scripts/portfolio-engine-cutover.ts`, dry-run by default)

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
   a minute of 00:00 UTC). The boot log says `LIVE on the portfolio engine`;
   the first pass adopts and trades the delta. Verify: `activity_log` rows
   "adopted"/"released", rows `strategy = 'PORTFOLIO'`, no pages, `/healthz/full`
   heartbeat fresh, the incumbent's engine absent from the boot log.
4. Rollback: `--mode rollback` (back to observer, keeps evidence) or
   `--mode rollback --remove` (deletes the definition), `--apply`, restart. The
   boot re-tags the `PORTFOLIO` rows and arms Binance stops before the
   incumbent starts. The incumbent then manages those positions by ITS rules
   (it may close what its universe/signal does not hold; the engine's
   positions outside the incumbent universe are its decision, not the
   engine's). `PORTFOLIOS_SOURCE=code` is also a full rollback: definitions are
   not read, the rows are handed back.

### Not done here

No definition is written by the code, and no `MODEL_VERSIONS` entry exists
(that is part of each cutover). `factorCore` cannot run until a live
point-in-time membership source exists.
