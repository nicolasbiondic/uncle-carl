# Security Policy

## Reporting a vulnerability

If you find a security issue (credential handling, auth/session bypass,
order-execution safety, injection, etc.), **please do not open a public
GitHub issue.** Instead:

1. Open a [GitHub Security Advisory](../../security/advisories/new) for
   this repository ("Report a vulnerability" under the Security tab), or
2. If that's unavailable, email the maintainer listed in the repository's
   GitHub profile with a clear description, reproduction steps, and the
   potential impact.

Please include:
- The affected version/commit.
- Whether the issue requires real broker credentials to reproduce, or can
  be shown against paper/testnet.
- A minimal reproduction if at all possible.

We aim to acknowledge reports within a few days. Coordinated disclosure is
appreciated — please give us a reasonable window to ship a fix before any
public write-up.

## How secrets are stored

This project is self-hosted: **you run your own instance against your own
broker accounts**, and nobody but you ever has your credentials.

- All credentials (broker API keys, Telegram bot token, dashboard admin
  password hash, metrics token) live only in your local `.env` file.
- `.env` (and any `.env.*` variant except `.env.example`) is `.gitignore`d
  and must never be committed. `.env.example` ships with placeholder values
  only (`PKxxxxxxxxxxxxxxxxxxxxx`, `your_telegram_bot_token`, …) — never
  real keys.
- The dashboard never stores plaintext passwords: `DASHBOARD_ADMIN_PASSWORD_HASH`
  is a `Bun.password.hash` output, generated once by you and placed in
  `.env` — see `docs/platform/self-hosting.md`.
- Nothing in this codebase talks to any server other than the broker APIs
  you configure (Alpaca, Binance) and, optionally, Telegram's API for
  outbound notifications. There is no telemetry, no phone-home, and no
  third-party credential storage.
- Going from paper to live trading requires an explicit, multi-step arming
  ceremony (`TRADING_MODE=live` plus a hand-created marker file) — it is
  not reachable by a default configuration or a typo.

If you believe a secret of yours was exposed (e.g. accidentally committed),
rotate it at the broker/Telegram side immediately — rotating the value
invalidates anything that may have leaked, regardless of where it leaked.
