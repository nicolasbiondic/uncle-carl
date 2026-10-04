#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Cron wrapper for scripts/parity-check.ts — the daily live↔sim decision
# monitor (see that file's header for what it checks). Scheduled by
# scripts/install-cron.sh at 04:45 host-local Tue–Sat: AFTER the 04:00
# historical refresh (so yesterday's daily bars exist) and the 04:30
# backup. READ-ONLY on both DBs; --notify pages the OPS chat only when a
# divergence exists (the .ts reads TELEGRAM_* from .env via src/config's
# dotenv). Exit codes: 0 parity / 1 divergence / 2 operational failure.
# ══════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Resolve bun the same robust way refresh-historical.sh/backup-db.sh do
# (cron has no interactive PATH; this host's bun may live under ~/.bun).
if [ -z "${BUN_BIN:-}" ]; then
  BUN_BIN="$(command -v bun || true)"
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN_BIN="$HOME/.local/share/mise/shims/bun"; fi
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN_BIN="$HOME/.bun/bin/bun"; fi
fi
if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo "❌ bun not found (tried \$BUN_BIN, PATH, mise shim, ~/.bun/bin) — set BUN_BIN env var to override" >&2
  exit 2
fi

exec "$BUN_BIN" run scripts/parity-check.ts --notify "$@"
