#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Refresh historical.db daily. historical.db IS in the live money path (audit
# F-10, 2026-11-07; this header used to claim the opposite): the portfolio
# engines that trade momentum_stocks and meanrev_stocks
# (src/portfolio-engine/live/wiring.ts → HistoricalPriceView) decide every
# session from its daily bars of the PREVIOUS session. Stale stock bars ⇒ the
# 09:35 ET pass is skipped (`skipped_stale`) and retried each minute until the
# data lands; nothing else refreshes it. Also consumed by:
#   • scripts/guardian.ts G5 (missing daily bar for the previous session),
#     scripts/parity-check.ts and the AI quorum (line D)
#   • every backtest/walk-forward script and experiment manifest
#   • the dashboard per-symbol candle modal (dashboard/routes/candles.ts)
#
# Cron (host-local time, scripts/install-cron.sh):
#   04:00  full refresh (VIX, crypto, funding, intraday, then stocks LAST)
#   06:00, 08:30  `--retry-stocks`: only the stock dailies, and only when no
#          stock refresh has succeeded since today's 04:00 (otherwise it
#          exits 0 without touching anything). On a UTC−5 host without DST,
#          08:30 = 08:30 EST / 09:30 EDT: both retries land before the 09:35 ET
#          pass year-round.
# Dead-man's switch (scripts/lib/cron-job.sh): the full run reports as
# `refresh-historical`, the stock step (from either run) as `refresh-stocks`;
# a failing run pages OPS once per episode, an overdue marker is paged by the
# guardian (G7) and counted in /healthz `stale_jobs`.
# ══════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=lib/cron-job.sh
source "$ROOT_DIR/scripts/lib/cron-job.sh"

MODE=full
if [ "${1:-}" = "--retry-stocks" ]; then
  MODE=retry
  TODAY_0400="$(date -d 'today 04:00' +%s)"
  if [ "$(cron_marker_epoch refresh-stocks)" -ge "$TODAY_0400" ]; then
    exit 0   # today's stock refresh already succeeded: nothing to retry, no marker, no page
  fi
  echo "refresh-historical: no stock refresh since today's 04:00 — retrying the stock dailies only"
  cron_job_start refresh-stocks
else
  cron_job_start refresh-historical
fi

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

# --stocks-only refreshes the all-adjusted SIP dailies once: legacy wide
# universe + the 18 D1 ETFs + date-current PIT S&P 500 members. Full-series
# atomic upserts also rebase past bars after corporate actions. It is the
# heaviest step and the only one that stops at the first Alpaca 429, so it runs
# LAST, where download-stock-dailies.ts ran: under `set -e` its failure cannot
# skip the VIX, crypto, funding and intraday refreshes above. Lowest CPU and
# best-effort IO priority: rewriting ~520 full series must not starve the live
# bot on the shared prod VM, as the deploy gate's disk load did on 2026-10-21.
refresh_stocks() {
  local lowpri=(nice -n 19)
  if command -v ionice >/dev/null 2>&1; then lowpri+=(ionice -c2 -n7); fi
  "${lowpri[@]}" "$BUN_BIN" run scripts/backfill-historical.ts --stocks-only
  cron_mark refresh-stocks
}

if [ "$MODE" = retry ]; then
  refresh_stocks   # the trap marks refresh-stocks on success
  exit 0
fi

# Pull only incremental gaps after the first source migration.
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
refresh_stocks
