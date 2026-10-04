# Self-hosting Uncle Carl

One installation = one owner. This guide covers installing, configuring the
instance, logging in (password or GitHub/Google), and exposing the dashboard
through a public URL.

## Install & first start

```bash
git clone <repo-url> uncle-carl && cd uncle-carl
bun install
cp .env.example .env         # platform defaults; add Telegram keys if you use it
bun run setup                # interactive installation assistant
./start.sh
```

`bun run setup` asks for:

- **dashboard port** (default 3789) and optional **public URL**;
- the **owner username + password** (stored only as an argon2id hash);
- optionally, **GitHub and/or Google sign-in** for the owner.

It writes two files into the data directory (`UC_DATA_DIR` env, default
`./data`), both with mode `0600`:

- `instance.json` — the instance configuration (port, public URL, owner,
  OAuth). Safe to re-run setup anytime; it merges, never clobbers.
- `master.key` — the 32-byte key encrypting stored secrets
  (AES-256-GCM, `src/platform/secretBox.ts`). Created once and **never
  overwritten or rotated by setup — back it up**; losing it loses every
  sealed secret.

Precedence everywhere: **env vars > instance.json > defaults**. An
installation with no `instance.json` and none of the new env vars behaves
exactly like the pre-platform bot.

### Non-interactive setup (Docker/CI)

```bash
echo "$OWNER_PASSWORD" | bun run setup -- --yes \
  --port 3789 \
  --public-url https://bot.example.com \
  --owner nico --password-stdin
```

Additional flags: `--host`, `--display-name`,
`--github-client-id/--github-client-secret/--github-allowed-id/--github-allowed-login`,
`--google-client-id/--google-client-secret/--google-allowed-email`.
`bun run setup -- --help` lists everything.

### First-run setup via the web (alternative)

If you start the bot **without ever running setup** (no owner configured
anywhere), the dashboard serves a **first-run setup page** at `/setup`
instead of the login. It requires the **one-time token printed in the
server log** at startup:

```
FIRST-RUN SETUP TOKEN (open /setup in your browser):
    3fc1…
```

That token proves you can read the host's log — someone who merely reaches
an exposed port cannot claim the installation. The page creates the owner
account (same `instance.json`) and the master key, then sends you to the
normal login. The token is single-use and the page disables itself the
moment any user exists. With Docker, read it with
`docker compose logs | grep -A1 "FIRST-RUN SETUP TOKEN"`.

## Dashboard host, port and public URL

- `DASHBOARD_HOST`: bind address. `bun run setup` writes `127.0.0.1` for a
  new installation: only this machine can reach it, and you publish it
  through a reverse proxy or tunnel (below). Use `0.0.0.0` only on a trusted
  LAN. An installation without `instance.json` and without this variable
  keeps listening on every interface, as before. Docker listens on every
  interface inside the container, and `docker-compose.yml` publishes the port
  on the host's loopback only.
- `DASHBOARD_PORT` (default `3789`).
- `PUBLIC_URL`: the https URL users actually type, when the dashboard sits
  behind a reverse proxy or tunnel (Cloudflare Tunnel, Tailscale Funnel,
  nginx + certbot, …). Setting it:
  - adds its origin to the WebSocket origin allowlist (`verifyWsClient`);
  - marks session cookies `Secure` (explicit `DASHBOARD_COOKIE_SECURE=true/false`
    still overrides — e.g. keep `false` while testing over plain-http LAN);
  - becomes the base of the printed dashboard URL and OAuth callbacks.

Behind a proxy also set `TRUST_PROXY=true` (rate-limit/lockout keying by
real client IP) and, if the proxy origin differs, `DASHBOARD_ALLOWED_ORIGINS`
(CSV) — both pre-existing knobs.

Example tunnel (Cloudflare):

```bash
cloudflared tunnel --url http://localhost:3789
# then: PUBLIC_URL=https://<your-tunnel-host> in .env (or setup), restart
```

## Owner login with GitHub / Google

OAuth is **off unless configured**; the login page shows "Continue with
GitHub/Google" only for configured providers. Both flows mint the exact
same session as the password login; the allowlist restricts sign-in to
**your identity**, not "anyone with an account":

- **GitHub** — allowlisted by your **numeric account id** (stable across
  login renames). Find it at `https://api.github.com/users/<your-login>`
  (`"id"` field).
- **Google** — allowlisted by your **email**, required to arrive as
  `email_verified: true` in the OIDC id_token (nonce + PKCE S256 enforced).

### Registering the apps

The callback URLs are printed by `bun run setup`; they are:

```
<PUBLIC_URL or http://localhost:PORT>/auth/oauth/github/callback
<PUBLIC_URL or http://localhost:PORT>/auth/oauth/google/callback
```

**GitHub** → Settings → Developer settings → OAuth Apps → *New OAuth App*:
- Homepage URL: your `PUBLIC_URL`;
- Authorization callback URL: the github callback above;
- copy the Client ID and generate a Client Secret into setup.

**Google** → console.cloud.google.com → APIs & Services → Credentials →
*Create credentials → OAuth client ID* (type **Web application**):
- Authorized redirect URI: the google callback above;
- OAuth consent screen: External + your email as test user is enough for a
  single-owner instance;
- copy the Client ID/Secret into setup.

Without a `PUBLIC_URL`, callbacks point at `http://localhost:<port>` and
only work from the machine itself.

## Broker accounts

With `ACCOUNTS_SOURCE=registry` (the `.env.example` default) the bot trades
the accounts you connect in the dashboard, under **Accounts**:

- **Alpaca**, paper or live: API key + secret, or **Alpaca OAuth**. For OAuth
  each installation registers its own app with Alpaca (redirect URI
  `<PUBLIC_URL>/api/platform/accounts/oauth/alpaca/callback`) and gives the
  bot its client id/secret through `ALPACA_OAUTH_CLIENT_ID` /
  `ALPACA_OAUTH_CLIENT_SECRET` or `instance.json` → `brokerOAuth.alpaca`.
  Without Alpaca's approval an app connects only its owner's own accounts,
  which is exactly a self-hosted installation.
- **Binance USDⓈ-M Futures**, demo/testnet: API key + secret (Binance offers
  OAuth only to partners). Enable futures, never withdrawals. Live Binance
  accounts are refused for now.

Each account is verified read-only against the broker before it's saved;
its credentials are sealed with `master.key` and never leave the server.
Which account the bot trades: the only verified account of each broker or,
with several, the one named by `RUNTIME_ACCOUNT_ALPACA` /
`RUNTIME_ACCOUNT_BINANCE` (or `instance.json` → `runtimeAccounts`). A broker
with no account connected simply builds no engines; one with open positions
in the database and no account refuses to start rather than abandon them.
A live Alpaca account links only after the arming ceremony:
`TRADING_MODE=live`, `LIVE_ACCOUNT_ID` equal to the account number, the
hand-made marker file `data/.live-armed` containing that same value, and an
ops Telegram chat (`TELEGRAM_OPS_CHAT_ID`). Changes apply on the next
restart.

With `ACCOUNTS_SOURCE=env` (or the variable unset) the bot signs with the
`ALPACA_*` / `BINANCE_*` keys in `.env` instead, as installations that
predate the platform do; startup then requires them.

## Portfolios

With `PORTFOLIOS_SOURCE=db` (the `.env.example` default) the bot builds its
engines from the portfolios in the database. The first start seeds the
shipped sleeves as portfolios; **Portfolios** in the dashboard lets you
create more from a validated preset or a free template (flagged *not
validated*), edit name, capital, parameters and the enabled flag, and
archive or restore them. The server refuses overlapping universes on one
account and a total capital above the account's broker equity (and refuses
when it has no fresh broker reading). Changes apply on the next restart.
Seeded portfolios you never edit follow the shipped definitions when you
update the code; an edited one is yours and stays as you left it.

## Files & secrets summary

| File | Mode | Contents |
|---|---|---|
| `.env` | — | flags and Telegram keys; broker keys only with `ACCOUNTS_SOURCE=env` (scripts under `scripts/` read them directly) |
| `data/instance.json` | 0600 | port/host/public URL, owner (argon2id hash), OAuth config |
| `data/master.key` | 0600 | secret-store key — **back it up, never commit** |
| `data/trading.db` | — | trades and ledgers, portfolios, broker credentials sealed with `master.key` |

The password is never stored in clear; OAuth client secrets live in
`instance.json` (0600) or env. Login rate-limiting, sessions, CSRF and the
WebSocket auth are the same hardened paths the dashboard already had.
