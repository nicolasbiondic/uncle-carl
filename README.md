# 🤖 Uncle Carl Trading Bot

A self-hosted algorithmic trading platform that runs independent **sleeves**
(strategy engines, each with its own wallet and ledger) in parallel across
**Alpaca** (stocks/ETFs) and **Binance Futures** (crypto perpetuals). It
ships with two strategy families out of the box — time-series momentum (TSM)
and Connors-style mean reversion — each validated with a nested, purged
walk-forward protocol before being wired as a live default.

This is **one installation per person**: you run your own copy, against
your own broker accounts, with your own dashboard URL and port. There is no
multi-tenant hosting and no custodial anything — your broker API keys never
leave your machine.

## What it does

- Runs one or more **sleeves** concurrently, each with its own capital,
  universe, and cadence (intraday or daily bars).
- Is managed from the dashboard: connect your broker **accounts** and run
  each strategy as a **portfolio** — a template (momentum or mean
  reversion), its parameters, an account and a fixed capital. The shipped
  sleeves below are the starting portfolios.
- Reconciles against the broker every cycle — **the broker is truth, the
  local database is a cache** that gets corrected, never the other way
  around.
- Primary + broker-native stop-loss protection on every open position.
- A live web dashboard (equity, P&L per sleeve, open/closed trades, activity
  log over WebSocket) and an outbound-only Telegram bot (`/status`,
  `/trades`, `/help`, plus error/circuit-breaker alerts).
- A built-in walk-forward research protocol (nested + purged folds, PSR/DSR
  gates, stress/leave-one-out checks) so a strategy change has to clear the
  same bar the shipped defaults did.

## Sleeves (shipped defaults)

This table is the canonical sleeve/broker/universe/cadence/mode reference —
enforced against the code by `src/config/docs.test.ts`, so it can't silently
drift. The registered **mode** below is the shipped default; the owner of
an installation can override a sleeve's *effective* mode at runtime via
`sleeve_modes`; every shipped sleeve is registered live.

The actual effective mode ("Modo efectivo", shown in the dashboard) always
lives at `GET /healthz/full` → `sleeveModes`, not in this static table.

| Sleeve | Broker | Universe (symbols) | Cadence (min) | Registered mode |
|---|---|---|---|---|
| `momentum_stocks` | Alpaca | 11 | daily | live |
| `meanrev_stocks` | Alpaca | 32 | daily | live |
| `momentum_crypto` | Binance USDT perps | 8 | 60 | live |
| `momentum_crypto_usdc` | Binance USDC perps | 13 | daily | live (opt-in: `MOMENTUM_USDC_ENABLED`) |
| `momentum_btc` | Binance COIN-M | 1 | 60 | live (opt-in: `MOMENTUM_COINM_ENABLED`) |

Start on paper/testnet accounts: every sleeve trades its account once the
bot runs.
`momentum_crypto_usdc` and `momentum_btc` are off by default (`MOMENTUM_*_ENABLED`
gates) until their connection preflight passes.

## Quick start

```bash
git clone <this-repo-url> uncle-carl && cd uncle-carl
bun install
cp .env.example .env   # platform defaults; add your Telegram keys here if you use it
bun run setup          # dashboard port/URL and your owner login (password, optional GitHub/Google)
./start.sh             # systemd when available, otherwise a background process
```

Then open the dashboard, connect your accounts in **Accounts**, review the
portfolios in **Portfolios** (their capital has to fit each account) and run
`./start.sh` again: the bot builds a portfolio's engines only once its
account is connected.

Or with Docker:

```bash
cp .env.example .env
docker compose up -d
docker compose logs | grep -A1 "FIRST-RUN SETUP TOKEN"   # open /setup and paste it
```

The dashboard comes up at `http://localhost:3789` (change the port in setup
or with `DASHBOARD_PORT`). `bun run setup` makes it listen on this machine
only, and Docker publishes it on the host's loopback: to reach it from
elsewhere, put it behind a reverse proxy or tunnel and set `PUBLIC_URL`.
Full setup, environment variables, and systemd/Docker details:
**`docs/platform/self-hosting.md`**.

## Connecting accounts

In the dashboard, **Accounts → add**:

- **Alpaca** (paper or live): API key + secret, or Alpaca OAuth through an
  OAuth app you register with Alpaca yourself (see
  `docs/platform/self-hosting.md`).
- **Binance USDⓈ-M Futures** (demo/testnet): API key + secret. Binance has
  no OAuth for individual apps. Live Binance accounts are refused for now.

Every account is checked read-only against the broker before it's saved,
and its credentials are stored encrypted (AES-256-GCM) with the
installation's master key, `data/master.key`. **Back that file up**: without
it the stored credentials can't be opened and the accounts have to be
connected again. With one verified account per broker the bot uses it; with
several, choose with `RUNTIME_ACCOUNT_ALPACA` / `RUNTIME_ACCOUNT_BINANCE`.
Account changes apply on the next restart.

Live/real-money trading on Alpaca is gated behind an explicit arming
ceremony (`TRADING_MODE=live`, `LIVE_ACCOUNT_ID` and a hand-created marker
file) — it is not the default and is not something a config typo can
trigger by accident.

## Portfolios

**Portfolios** lists every portfolio with its account, capital, universe and
how its live results compare with the band it was validated against. You
can:

- create one from a **validated preset** (a shipped strategy, backed by its
  research artifact) or from a **free template** with your own parameters,
  flagged *not validated*;
- edit its name, capital, parameters and enabled flag, or archive and
  restore it.

The server refuses overlapping universes on one account and a total capital
above the account's equity. Changes apply on the next restart.

## Security

- **Start in paper trading.** `TRADING_MODE=paper` is the default; going
  live is a deliberate, explicit, multi-step action — read
  `docs/platform/self-hosting.md` before you ever flip it.
- Your credentials stay on your machine: broker keys encrypted in the
  local database (or in `.env` if you set `ACCOUNTS_SOURCE=env`), Telegram
  keys in `.env`. Neither `data/` nor `.env` is ever committed (see
  `.gitignore`).
- Report vulnerabilities per `SECURITY.md` — please don't open a public
  issue for anything credential- or execution-safety-related.
- **This is not financial advice.** Trading involves real risk of loss even
  in a well-tested system; past backtest/paper results do not guarantee
  future performance. Use at your own risk, and only with capital you can
  afford to lose.

## License

MIT — see `LICENSE`.

## Contributing

See `CONTRIBUTING.md`.
