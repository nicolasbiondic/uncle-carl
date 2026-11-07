#!/usr/bin/env bash
# Hourly read-only owner-rule guardian (:20, every day). Only episode state,
# its cron marker and this cron's log/lock are written. --no-notify overrides
# the cron default. Exit 0 healthy / 1 violation / 2 a check could not be
# evaluated — all three are paged by guardian.ts itself and count as "ran" for
# the dead-man's switch — / 3 the guardian could not run at all (bun missing,
# DB or state unreadable, Telegram down): paged once per episode by
# scripts/lib/cron-job.sh.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=lib/cron-job.sh
source "$ROOT_DIR/scripts/lib/cron-job.sh"
cron_job_start guardian 0 1 2

if [ -z "${BUN_BIN:-}" ]; then
  BUN_BIN="$(command -v bun || true)"
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN_BIN="$HOME/.local/share/mise/shims/bun"; fi
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN_BIN="$HOME/.bun/bin/bun"; fi
fi
if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo 'guardian: bun not found — set BUN_BIN' >&2
  exit 3
fi

# Do not overlap cron/manual wrapper runs or race episode notification state.
# A held lock (75) is an overlapping run, not a failure: no marker, no page.
rc=0
flock -n -E 75 "$ROOT_DIR/data/guardian.lock" "$BUN_BIN" run scripts/guardian.ts --notify "$@" || rc=$?
if [ "$rc" = 75 ]; then
  echo 'guardian: another run holds data/guardian.lock — skipped' >&2
  CRON_JOB_SKIP=1
  exit 0
fi
exit "$rc"
