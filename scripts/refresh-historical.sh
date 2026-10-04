#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Refresh historical.db daily. NOTHING in the live money-path reads this DB —
# no MacroRegimeClassifier exists (2026-07-28 audit: the old justification
# here cited a class with zero definitions and a signal_rejection table with
# zero writers). What actually consumes historical.db:
#   • every backtest/walk-forward script (backtest-momentum-wf, walk-forward,
#     backtest-meanrev*, experiment manifests) — stale data = stale evidence
#   • the dashboard per-symbol candle modal (dashboard/routes/candles.ts)
# Skipping it never stops the bot from trading; it silently ages the data
# every future backtest decision is made on. That's why it stays installed.
#
# Designed to run from cron at 04:00 host-local (prod: 09:00 UTC = 05:00 ET,
# before the bot wakes up for the next session). Output goes to
# logs/refresh-historical.log so we have a paper trail.
# ══════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# P1 fix (2026-07-27): resolve bun the same robust way start.sh/backup-db.sh
# do instead of hardcoding one host's path — some hosts only have bun under a
# user-specific ~/.bun/bin, so this script failed every scheduled run there.
if [ -z "${BUN_BIN:-}" ]; then
  BUN_BIN="$(command -v bun || true)"
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN_BIN="$HOME/.local/share/mise/shims/bun"; fi
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN_BIN="$HOME/.bun/bin/bun"; fi
fi
if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo "❌ bun not found (tried \$BUN_BIN, PATH, mise shim, ~/.bun/bin) — set BUN_BIN env var to override" >&2
  exit 1
fi

# Pull only incremental gaps after the first source migration.
"$BUN_BIN" run scripts/backfill-historical.ts --stocks-only
"$BUN_BIN" run scripts/backfill-historical.ts --vix-only
"$BUN_BIN" run scripts/backfill-historical.ts --crypto-only
"$BUN_BIN" run scripts/download-funding-history.ts
# Crypto universe refresh (2026-09-26): the two lines above only ever touched
# momentum_crypto's live 8 (USDT). This refreshes binance_futures 1h+1d and
# funding for EVERY symbol a live crypto sleeve's universe could reference —
# momentum_crypto's 8 UNION momentum_crypto_usdc's 13 bases (as their USDT
# perp proxy) — so a future USDC cutover doesn't inherit stale/absent data
# the way momentum_crypto's own model drift went undetected. Idempotent,
# fails OPEN per symbol (one delisted/rate-limited symbol never blocks the
# rest); `|| true` keeps this step's informational exit code from aborting
# the remaining refresh steps below under `set -e`.
"$BUN_BIN" run scripts/refresh-crypto-universe.ts \
  || echo "⚠️ refresh-crypto-universe reported per-symbol failures — see log above, continuing"
"$BUN_BIN" run scripts/backfill-intraday.ts
# alpaca_wide dailies (~240 series) — the base of every meanrev backtest. Was
# missing here, so the series froze at their last manual run (2026-07-17).
# Atomic fetch-validate-replace; fails closed for MeanRev universe symbols.
"$BUN_BIN" run scripts/download-stock-dailies.ts
