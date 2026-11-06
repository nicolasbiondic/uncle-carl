#!/usr/bin/env bash
# Hourly read-only owner-rule guardian (:20, every day). Only episode state
# and this cron's log/lock are written. --no-notify overrides the cron default.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -z "${BUN_BIN:-}" ]; then
  BUN_BIN="$(command -v bun || true)"
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN_BIN="$HOME/.local/share/mise/shims/bun"; fi
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN_BIN="$HOME/.bun/bin/bun"; fi
fi
if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo 'guardian: bun not found — set BUN_BIN' >&2
  exit 2
fi

# Do not overlap cron/manual wrapper runs or race episode notification state.
exec flock -n -E 2 "$ROOT_DIR/data/guardian.lock" "$BUN_BIN" run scripts/guardian.ts --notify "$@"
