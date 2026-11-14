# AGENTS.md — Uncle Carl Trading Bot

This file is preloaded into every agent's context, so it stays short and it
stays true: every claim below is either self-evidently structural (a file
exists, a constant is defined) or names the thing that enforces it (a test,
a query, a command). If you can't name the enforcer, it doesn't belong here.

- **`README.md`** — human quick-start.
- **`docs/platform/self-hosting.md`** — per-install configuration (broker
  keys, dashboard port/URL, Telegram, systemd/Docker), setup wizard
  (`bun run setup`), and the live-trading arming ceremony.
- **`CONTRIBUTING.md`** — how to propose a change.
- **`SECURITY.md`** — how to report a vulnerability and how secrets are
  meant to be stored (never committed).

## What is this?

A portfolio-management bot that runs independent **sleeves** (strategy
engines), each owning its own wallet/ledger, across Alpaca (stocks/ETFs)
and Binance Futures (crypto perpetuals). It ships with two strategy
families — time-series momentum (TSM) and Connors-style mean reversion —
each sleeve walk-forward-validated (nested, purged folds; PSR/DSR gates;
stress/leave-one-out checks) before being wired as a live default. Exact
sleeve wiring (universe, cadence, broker, state) lives in
`src/config/riskProfiles.ts` and is enforced against `README.md`'s sleeve
table by `src/config/docs.test.ts` — read the table there, don't duplicate
it here.

**Every installation is independent.** There is no multi-tenant hosting,
no shared credentials, and no central server — you run your own copy
against your own broker accounts. Per-install configuration (keys, port,
URL, Telegram) is covered by `docs/platform/self-hosting.md`, not this file.

## Tech stack

Bun (not Node, no build step — `.ts` runs directly), TypeScript strict,
SQLite via `bun:sqlite`, custom Alpaca + Binance Futures REST/WS clients,
Express+WS dashboard, Telegram (outbound alerts; commands answered only to the
configured chats), systemd-user unit (with a
setsid+nohup fallback) or Docker.

## Running the bot

One entry point, auto-detects systemd:

```bash
./start.sh [stop|status|logs|panic|resume-trading]
./scripts/install-systemd.sh   # one-time, idempotent: unit + auto-restart
./scripts/install-cron.sh      # one-time, idempotent: historical-bar refresh,
                                # DB backup, sim/live parity check, health watchdog
```

`panic`/`resume-trading` are the broker-side kill switch (suspends/resumes
new orders via `scripts/panic.ts`), not process control. Fallback with no
systemd unit installed: `setsid bun run src/index.ts >> logs/bot.log 2>&1 &`.

`.env` must exist (`cp .env.example .env`, then `bun run setup`). Startup
checks run in `assertRequiredConfig()` (`src/config/index.ts`): with
`ACCOUNTS_SOURCE=env` a missing/placeholder broker key aborts with exit 1;
with `ACCOUNTS_SOURCE=registry` (the `.env.example` default) the broker
credentials come from the dashboard's encrypted account registry
(`src/platform/accounts/runtime.ts`) and the bot boots without any. Merely
importing the config (tests, research scripts) enforces nothing by design.
Enforced: `src/config/requiredKeys.test.ts` +
`src/platform/accounts/runtime.test.ts`.

## Architecture

```
index.ts (entry)
 ├── MomentumEngine ×2   — the crypto TSM sleeves, each owns its wallet
 ├── portfolio engine     — the stock sleeves (vol-managed portfolios,
 │                          src/portfolio-engine/)
 ├── SwitchingAdapter     — pre-trade guards (risk veto, trading kill-switch)
 │                          in front of every momentum sleeve's broker adapter
 ├── SleeveGovernor       — evidence watchdog: recommends a redesign, never
 │                          switches a sleeve off
 ├── AccountManager       — stop-loss loop, broker syncs, equity snapshots
 ├── BrokerSync           — DB↔broker reconciler; broker is truth
 ├── ops/heartbeat        — loop-liveness watchdog feeding /healthz
 ├── DailyReporter        — end-of-day Telegram summary
 ├── DashboardServer      — Express+WS on DASHBOARD_PORT
 └── TelegramReporter     — alerts + /status /trades /help (configured chats only)
```

### Key files

| File | Role |
|---|---|
| `src/index.ts` | Entry point; wires every sleeve |
| `src/config/riskProfiles.ts` | Sleeve universes/profiles — single source |
| `src/config/docs.test.ts` | Fails if README's sleeve table drifts from code |
| `src/account/AccountManager.ts` | Core orchestrator: stop-loss loop, broker syncs, snapshots |
| `src/sync/BrokerSync.ts` | DB↔broker reconciler; broker is truth |
| `src/executor/alpaca-executor.ts` / `binance-executor.ts` | Broker REST/WS clients |
| `src/executor/alpaca-v5-compat.ts` | Alpaca SDK v5 behind the v3-shaped `client` the executor, `scripts/panic.ts` and the test fakes use; SDK retries and rate limiting off, the executor owns both (`alpaca-v5-compat.test.ts`) |
| `src/strategies/momentum/MomentumEngine.ts` | TSM engine shared by the crypto momentum sleeves |
| `src/portfolio-engine/` | Portfolio engine: pure decision core shared by research and live, and the live runner of the stock sleeves (its `README.md`) |
| `src/strategies/meanrev/MeanRevEngine.ts` | Connors RSI(2)+SMA200 daily kernel, used by the research replay |
| `src/governor/SleeveGovernor.ts` / `SwitchingAdapter.ts` | redesign recommendation / pre-trade guards |
| `src/db/database.ts` | SQLite schema/CRUD, ET-aware date helpers |
| `src/ops/heartbeat.ts` | Universal loop-liveness watchdog |
| `start.sh` / `scripts/install-systemd.sh` | Process supervision |

`data/` (SQLite DB, backups, cached historical bars) is gitignored.

## Critical invariants

**Broker = Truth, DB = Cache.** `BrokerSync` reconciles on a timer; it only
auto-closes rows it created itself (id prefix `sync_`). Enforced:
`src/sync/BrokerSync.test.ts`.

**Stop-loss, by design.** Momentum-engine positions: a software stop-loss
loop is the PRIMARY protection and a broker-native stop per position is
defense in depth for the time the loop isn't running. Portfolio-engine
(stock) positions carry no per-position stop by design: volatility-targeted
sizing, per-asset and gross caps, a trend switch and a maximum hold protect
them. Enforced: `src/strategies/momentum/volStopEntry.test.ts`,
`src/account/alpacaNativeStops.test.ts`,
`src/portfolio-engine/live/stopExemption.test.ts`.

**Never assume a close succeeded** without checking
`result.success && result.filledPrice > 0`.

**ET-aware time.** All "today" stats use `getETDateKey`/`getETDayStart`/
`getETDayBounds` in `src/db/database.ts` — never `setHours(0,0,0,0)`.
Enforced: `src/db/database-time.test.ts`.

**Owner-facing text.** Whatever the owner reads (dashboard, Telegram,
`/status`, `/profits`, digest) is written for a person, not a machine: plain
words, whole dollars, a plain name on every ticker, one reader per money
figure. Load the project skill before touching any of it:
`.opencode/skills/texto-para-personas/SKILL.md`. Enforced:
`src/telegram/plain-money.test.ts`,
`src/dashboard/public/v4/js/symbol-names.test.js`,
`src/dashboard/public/v4/js/fmt.test.js`,
`src/portfolio/moneyConsistency.test.ts`, `bun run dashboard:check` and
`src/config/ownerTextSkill.test.ts`.

**AI review (optional, report-only).** `src/ai-review/` lets a few AI models of
different families read each morning's news for the stocks the sleeves hold and
vote keep/reduce/exit/short. Code applies a fixed quorum (at least 2 families,
mean confidence ≥ 0.6, the mildest agreeing action) and hard limits (a few names
per sleeve, a validity of 5 sessions) and writes a decision file for the bot's
inbox; it changes no order. `scripts/ai-review-casefile.ts` builds the day's
read-only case file (positions, closes, news from the broker's data API); the
runner that launches the models (`src/ai-review/app.ts`, entry
`scripts/ai-review.ts`) is meant for a machine that has an OpenCode agent
setup, and needs `AI_REVIEW_PROD_SSH` and `AI_REVIEW_PROD_DIR` for the host that
runs the bot. Enforced: `src/ai-review/quorum.test.ts`,
`src/ai-review/active.test.ts`, `src/ai-review/contract.test.ts`,
`src/ai-review/casefile.test.ts`.
Optionally the live stock engine can act on that decision (lower a held weight to
half or zero, never raise one, only the sleeve's own symbols, a few names at most)
behind a code switch that ships OFF, with an environment kill switch
(`AI_REVIEW_APPLY=off`); any missing or invalid decision leaves the pass exactly as
it was. `scripts/ai-review-report.ts` reports its effect from the journal.
Enforced: `src/portfolio-engine/live/PortfolioEngine.aiReview.test.ts`,
`src/ai-review/apply.test.ts`, `src/ai-review/effects.test.ts`.

**Shared broker wallet.** Multiple stock sleeves can share one Alpaca
wallet; closing a position liquidates the AGGREGATE broker position while
only the requesting sleeve closes its own DB row. Universes that share a
wallet MUST stay disjoint. Enforced:
`src/config/riskProfiles.disjoint.test.ts`.

**Auth & WebSocket.** `/healthz` is public (minimal liveness);
`/healthz/full` and `/metrics` require a session or `METRICS_TOKEN`. WS
upgrade requires an Origin match AND a valid session cookie. Behind a
reverse proxy, set `DASHBOARD_ALLOWED_ORIGINS` + `TRUST_PROXY=true`.
Enforced: `src/dashboard/server.test.ts`.

**Crash policy.** `uncaughtException`/`unhandledRejection` log + page +
`process.exit(1)`; a process in an unknown state does not keep managing
money. Systemd restarts it (`Restart=always`).

## Common pitfalls

1. Don't assume `closePosition` succeeded — check the result.
2. Don't insert `trades` rows with arbitrary ids when reconciling from the
   broker — use the `sync_<ts>_<rand>` convention or the phantom-delete
   guard won't protect the row.
3. Bun runs `.ts` directly. No build step. `bun run typecheck` is the only
   static check.
4. `.env` is gitignored — never commit it.
5. Use `./start.sh`, not a raw `bun run` — bypassing it skips systemd
   auto-restart, log capture, and can collide on the port.
6. Don't fall back to one exchange's prices for another exchange's trades —
   cross-exchange price fallback has caused false stops historically.

## Verification

```bash
bun run typecheck     # must be clean
bun test              # must be green (tests needing a local research DB self-skip)
./start.sh status
curl -s http://localhost:$DASHBOARD_PORT/healthz
```
