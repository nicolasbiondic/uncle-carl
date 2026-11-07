#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Weekly restore drill (audit F-9, 2026-11-07: no backup had ever been
# restored). Cron: Sunday 05:15 host-local (scripts/install-cron.sh), after the
# 04:30 backup.
#   1. copies the NEWEST data/backups/daily-<date>.db (+ its state tarball)
#      into a fresh temp data dir;
#   2. restores it there with the real scripts/restore-db.sh --apply
#      (--data-dir <temp> --force-while-running: the live data/ is never
#      touched, the bot keeps running);
#   3. scripts/restore-drill.ts checks integrity, the book, the backup's age,
#      and opens every sealed broker account with the BACKED-UP master key
#      (data/backups/master-<sha12>.key, written by backup-db.sh);
#   4. deletes the temp dir and reports. Success writes
#      data/cron-markers/restore-drill.ok; a failure pages OPS once per
#      episode (scripts/lib/cron-job.sh).
# Env seams (tests): DRILL_BACKUP_DIR, BUN_BIN, CRON_MARKER_DIR, CRON_ENV_FILE.
# ══════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=lib/cron-job.sh
source "$ROOT_DIR/scripts/lib/cron-job.sh"
cron_job_start restore-drill

if [ -z "${BUN_BIN:-}" ]; then
  BUN_BIN="$(command -v bun || true)"
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN_BIN="$HOME/.local/share/mise/shims/bun"; fi
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN_BIN="$HOME/.bun/bin/bun"; fi
fi
if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo "❌ bun not found — set BUN_BIN" >&2
  exit 1
fi

BACKUP_DIR="${DRILL_BACKUP_DIR:-$ROOT_DIR/data/backups}"
LATEST="$(ls -1 "$BACKUP_DIR" 2>/dev/null | grep -E '^daily-[0-9]{8}\.db$' | sort | tail -1 || true)"
if [ -z "$LATEST" ]; then
  echo "❌ restore-drill: no daily-YYYYMMDD.db in $BACKUP_DIR" >&2
  exit 1
fi
DATE="${LATEST#daily-}"; DATE="${DATE%.db}"
echo "restore-drill @ $(date -u +%FT%TZ): restoring $LATEST"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/uc-restore-drill.XXXXXX")"
drill() {
  mkdir -p "$WORK/data/backups"
  cp -p "$BACKUP_DIR/$LATEST" "$WORK/data/backups/"
  [ -f "$BACKUP_DIR/daily-${DATE}-state.tar.gz" ] && cp -p "$BACKUP_DIR/daily-${DATE}-state.tar.gz" "$WORK/data/backups/"
  BUN="$BUN_BIN" RESTORE_DATA_DIR="$WORK/data" bash "$ROOT_DIR/scripts/restore-db.sh" "$DATE" --apply --force-while-running \
    | grep -E '^(✅|⚠️|❌)' || true
  [ -f "$WORK/data/trading.db" ] || { echo "❌ restore-db.sh did not produce trading.db" >&2; return 1; }
  "$BUN_BIN" run "$ROOT_DIR/scripts/restore-drill.ts" --data-dir "$WORK/data" --keys-dir "$BACKUP_DIR" \
    --max-age-hours "${DRILL_MAX_AGE_HOURS:-26}"
}
rc=0
drill || rc=$?
rm -rf "$WORK"
exit "$rc"
