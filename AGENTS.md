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
sleeve wiring (universe, cadence, broker, live/shadow mode) lives in
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
Express+WS dashboard, outbound-only Telegram, systemd-user unit (with a
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
 ├── MomentumEngine ×N   — TSM sleeves, each owns its wallet
 ├── MeanRevEngine        — Connors RSI(2)+SMA200 daily sleeve
 ├── SwitchingAdapter/ShadowAdapter/SleeveGovernor
 │                        — routes a sleeve's orders to the real broker
 │                          adapter (mode=live) or a zero-capital simulated
 │                          one (mode=shadow); demotes/promotes on evidence
 ├── AccountManager       — stop-loss loop, broker syncs, equity snapshots
 ├── BrokerSync           — DB↔broker reconciler; broker is truth
 ├── ops/heartbeat        — loop-liveness watchdog feeding /healthz
 ├── DailyReporter        — end-of-day Telegram summary
 ├── DashboardServer      — Express+WS on DASHBOARD_PORT
 └── TelegramReporter     — outbound /status /trades /help + alerts
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
| `src/strategies/momentum/MomentumEngine.ts` | TSM engine shared by every momentum sleeve |
| `src/strategies/meanrev/MeanRevEngine.ts` | Connors RSI(2)+SMA200 daily engine |
| `src/governor/SleeveGovernor.ts` / `ShadowAdapter.ts` / `SwitchingAdapter.ts` | live/shadow mode persistence + routing |
| `src/db/database.ts` | SQLite schema/CRUD, ET-aware date helpers |
| `src/ops/heartbeat.ts` | Universal loop-liveness watchdog |
| `start.sh` / `scripts/install-systemd.sh` | Process supervision |

`data/` (SQLite DB, backups, cached historical bars) is gitignored.

## Critical invariants

**Broker = Truth, DB = Cache.** `BrokerSync` reconciles on a timer; it only
auto-closes rows it created itself (id prefix `sync_`). Enforced:
`src/sync/BrokerSync.test.ts`.

**Stop-loss, defense in depth.** A software stop-loss loop is the PRIMARY
protection; a broker-native GTC stop per open stock row is defense in depth
for the time the loop isn't running. Enforced:
`src/strategies/momentum/volStopEntry.test.ts`,
`src/account/alpacaNativeStops.test.ts`.

**Never assume a close succeeded** without checking
`result.success && result.filledPrice > 0`.

**ET-aware time.** All "today" stats use `getETDateKey`/`getETDayStart`/
`getETDayBounds` in `src/db/database.ts` — never `setHours(0,0,0,0)`.
Enforced: `src/db/database-time.test.ts`.

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
