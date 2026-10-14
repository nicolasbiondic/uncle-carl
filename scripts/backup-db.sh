#!/usr/bin/env bash
# ══════════════════════════════════════════════
# DB backup — uses sqlite3's atomic .backup command
# (works while the bot has the DB open in WAL mode).
# Keeps the last 14 daily + 8 weekly backups.
# Wire into cron with: scripts/install-cron.sh
# ══════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
BACKUP_DIR="$DATA_DIR/backups"
SRC_DB="$DATA_DIR/trading.db"

if [ ! -f "$SRC_DB" ]; then
  echo "❌ DB not found at $SRC_DB" >&2
  exit 1
fi

# The off-host targets are documented as .env settings (.env.example), but
# cron runs this script without loading .env: read just these two keys from
# it when the environment doesn't already set them (2026-10-14 — setting
# them in .env used to do nothing).
env_from_dotenv() {
  [ -f "$ROOT_DIR/.env" ] || return 0
  # A key absent from .env must yield "" — never trip set -e/pipefail.
  { grep -E "^$1=" "$ROOT_DIR/.env" || true; } | tail -n 1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]\$//"
}
[ -n "${BACKUP_REMOTE:-}" ] || BACKUP_REMOTE="$(env_from_dotenv BACKUP_REMOTE)"
[ -n "${BACKUP_OFFHOST_DIR:-}" ] || BACKUP_OFFHOST_DIR="$(env_from_dotenv BACKUP_OFFHOST_DIR)"

# P1 fix (2026-07-27): resolve bun the same robust way start.sh does instead
# of hardcoding one host's path (e.g. /home/<user>/.bun/bin/bun) — some hosts
# have no sqlite3 CLI AND bun only lives under a user-specific .bun/bin, so
# backups had been silently failing every day (logs/backup.log: "Neither
# sqlite3 nor a bun binary is available"). command -v / PATH finds it on any
# host where bun is on PATH.
if [ -z "${BUN:-}" ]; then
  BUN="$(command -v bun || true)"
  if [ -z "$BUN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN="$HOME/.local/share/mise/shims/bun"; fi
  if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
fi

mkdir -p "$BACKUP_DIR"

TS=$(date -u +%Y%m%dT%H%M%SZ)
DAY=$(date -u +%Y%m%d)
DOW=$(date -u +%u)        # 1=Mon..7=Sun
DAILY_FILE="$BACKUP_DIR/daily-${DAY}.db"
WEEKLY_FILE="$BACKUP_DIR/weekly-$(date -u +%Y-W%V).db"
STATE_FILE="$BACKUP_DIR/daily-${DAY}-state.tar.gz"
STATE_WEEKLY_FILE="$BACKUP_DIR/weekly-$(date -u +%Y-W%V)-state.tar.gz"

# ── 1. Consistent backup (safe with WAL + concurrent writers)
# snapshot_sqlite SRC OUT — WAL-safe copy of a live SQLite DB into OUT.
snapshot_sqlite() {
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$1" ".backup '$2.tmp'"
  elif [ -n "$BUN" ] && [ -x "$BUN" ]; then
    # bun:sqlite serialize() reads a consistent snapshot including live WAL pages.
    # `bun run -` reads a script from stdin; bare `bun` without a subcommand
    # prints the help page and exits 1, which caused the mv to fail (P1 fix).
    SRC_DB="$1" OUT_DB="$2.tmp" "$BUN" run - <<'BUN'
import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";

const src = process.env.SRC_DB;
const out = process.env.OUT_DB;
if (!src || !out) throw new Error("SRC_DB and OUT_DB are required");

const db = new Database(src, { readonly: true });
const snapshot = db.serialize();
db.close();
writeFileSync(out, snapshot);
BUN
  else
    echo "❌ Neither sqlite3 nor a resolvable bun binary is available for a WAL-safe backup" >&2
    exit 1
  fi
  mv "$2.tmp" "$2"
}
snapshot_sqlite "$SRC_DB" "$DAILY_FILE"

# ── 1a. AI-quorum DB (line D): its forward-only record cannot be rebuilt —
# decisions were stored before their outcomes existed. Same daily/weekly
# cadence under its own "aiq-" names, so the main DB's retention globs
# (daily-*.db, weekly-*.db) never count or delete these files.
AIQ_DB="$DATA_DIR/ai-quorum.db"
AIQ_DAILY="$BACKUP_DIR/aiq-daily-${DAY}.db"
AIQ_WEEKLY="$BACKUP_DIR/aiq-weekly-$(date -u +%Y-W%V).db"
if [ -f "$AIQ_DB" ]; then
  snapshot_sqlite "$AIQ_DB" "$AIQ_DAILY"
  chmod 640 "$AIQ_DAILY" 2>/dev/null || true
fi

# ── 1b. Risk-state tarball (P2-F): the DB alone isn't the full picture —
# data/momentum-state-*.json, data/meanrev-state-*.json and the
# data/daily-run-* markers are real production state (RiskGuard peak/pause,
# meanrev's per-day idempotence, swap-guard HALTED/ACTIVE). A DB-only restore
# leaves them stale: meanrev can re-enter symbols already opened "today", and
# a HALTED swap-guard can resurrect as ACTIVE. Defensive: globs matching
# nothing (fresh install, opt-in sleeves disabled) just skip the tarball
# instead of failing the whole backup.
shopt -s nullglob
STATE_FILES=("$DATA_DIR"/momentum-state-*.json "$DATA_DIR"/meanrev-state-*.json "$DATA_DIR"/daily-run-*)
shopt -u nullglob
if [ "${#STATE_FILES[@]}" -gt 0 ]; then
  tar -czf "$STATE_FILE.tmp" -C "$DATA_DIR" "${STATE_FILES[@]##*/}"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
  chmod 640 "$STATE_FILE" 2>/dev/null || true
fi

# ── 2. On Sundays (DOW=7), promote to weekly
if [ "$DOW" = "7" ] || [ ! -f "$WEEKLY_FILE" ]; then
  cp "$DAILY_FILE" "$WEEKLY_FILE"
  [ -f "$STATE_FILE" ] && cp "$STATE_FILE" "$STATE_WEEKLY_FILE"
fi
if [ -f "$AIQ_DAILY" ] && { [ "$DOW" = "7" ] || [ ! -f "$AIQ_WEEKLY" ]; }; then
  cp "$AIQ_DAILY" "$AIQ_WEEKLY"
  chmod 640 "$AIQ_WEEKLY" 2>/dev/null || true
fi

# ── 3. Retention: keep last 14 daily + 8 weekly (state tarballs follow the
# same retention as their DB counterparts)
find "$BACKUP_DIR" -maxdepth 1 -name 'daily-*.db' -type f -mtime +14 -delete 2>/dev/null || true
find "$BACKUP_DIR" -maxdepth 1 -name 'daily-*-state.tar.gz' -type f -mtime +14 -delete 2>/dev/null || true
ls -1t "$BACKUP_DIR"/weekly-*.db 2>/dev/null | tail -n +9 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/weekly-*-state.tar.gz 2>/dev/null | tail -n +9 | xargs -r rm -f
find "$BACKUP_DIR" -maxdepth 1 -name 'aiq-daily-*.db' -type f -mtime +14 -delete 2>/dev/null || true
ls -1t "$BACKUP_DIR"/aiq-weekly-*.db 2>/dev/null | tail -n +9 | xargs -r rm -f

# Ad-hoc one-shot-script backups (pre-legacy-cleanup-*, historical-pre-*,
# pre-aggclose-reconcile-*, + their -shm/-wal sidecars) had no retention at
# all and accumulated forever (220MiB found and manually purged). 30-day
# retention, same mechanism as daily/weekly above. Parens are load-bearing:
# without them `-o` splits into two unrelated clauses and the -type/-mtime
# guard only binds to the second name, not the first.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'pre-*' -o -name 'historical-pre-*' \) -mtime +30 -delete 2>/dev/null || true

# ── 4. Quick integrity check (PRAGMA integrity_check)
# Prefer sqlite3 CLI; fall back to bun:sqlite if not installed.
SIZE_MB=$(du -m "$DAILY_FILE" | awk '{print $1}')
INTEGRITY=""

if command -v sqlite3 >/dev/null 2>&1; then
  INTEGRITY=$(sqlite3 "$DAILY_FILE" "PRAGMA integrity_check;" 2>/dev/null | head -1)
elif [ -n "$BUN" ] && [ -x "$BUN" ]; then
  INTEGRITY=$("$BUN" -e "
const { Database } = require('bun:sqlite');
const d = new Database('$DAILY_FILE', { readonly: true });
const r = d.prepare('PRAGMA integrity_check').get();
console.log(Object.values(r)[0]);
" 2>/dev/null)
fi

if [ -n "$INTEGRITY" ] && [ "$INTEGRITY" != "ok" ]; then
  echo "❌ Backup integrity check failed: $INTEGRITY" >&2
  exit 2
fi

# Audit fix wave 5 (2026-05-04): tighten backup file perms to 640 so they
# don't inherit the umask default of 644 (world-readable trade history).
chmod 640 "$DAILY_FILE" "$WEEKLY_FILE" 2>/dev/null || true
chmod 640 "$STATE_FILE" "$STATE_WEEKLY_FILE" 2>/dev/null || true

# v3.0 audit fix (2026-05-04): the bun:sqlite integrity-check fallback opens
# the backup in WAL mode, leaving -shm + -wal sidecars behind with default
# perms (644). Clean them up — the integrity check is done, sidecars aren't
# needed for cold-storage backups.
rm -f "$DAILY_FILE-shm" "$DAILY_FILE-wal" "$WEEKLY_FILE-shm" "$WEEKLY_FILE-wal" 2>/dev/null || true

# ── 5. Optional OFF-HOST copy (F5): a backup on the same host dies with the host.
# Runs only AFTER the integrity check passed (we never ship a corrupt file), and
# an off-host failure WARNS but does NOT fail the (already-verified) local backup.
#   BACKUP_OFFHOST_DIR — a local path that is really elsewhere (NFS/SMB mount,
#                        rclone mount, external/secondary disk).
#   BACKUP_REMOTE      — an rsync/scp target, e.g. user@host:/srv/uncle-carl-backups
#                        (or an ~/.ssh/config Host alias, e.g. uc-backup:).
# ship FILE MODE — copy FILE to every configured off-host target with MODE.
ship() {
  local file="$1" mode="$2" base
  base="$(basename "$file")"
  if [ -n "${BACKUP_OFFHOST_DIR:-}" ]; then
    if mkdir -p "$BACKUP_OFFHOST_DIR" 2>/dev/null && cp "$file" "$BACKUP_OFFHOST_DIR/$base.tmp" 2>/dev/null        && chmod "$mode" "$BACKUP_OFFHOST_DIR/$base.tmp" 2>/dev/null        && mv "$BACKUP_OFFHOST_DIR/$base.tmp" "$BACKUP_OFFHOST_DIR/$base" 2>/dev/null; then
      echo "📦 Off-host copy → $BACKUP_OFFHOST_DIR/$base"
    else
      echo "⚠️  Off-host copy of $base to BACKUP_OFFHOST_DIR=$BACKUP_OFFHOST_DIR FAILED (local backup still OK)" >&2
    fi
  fi
  if [ -n "${BACKUP_REMOTE:-}" ]; then
    if command -v rsync >/dev/null 2>&1        && rsync -az --chmod="F$mode" -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$file" "$BACKUP_REMOTE/" 2>/dev/null; then
      echo "📦 Off-host rsync → $BACKUP_REMOTE ($base)"
    elif command -v scp >/dev/null 2>&1        && scp -Bq -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$file" "$BACKUP_REMOTE/" 2>/dev/null; then
      echo "📦 Off-host scp → $BACKUP_REMOTE ($base)"
    else
      echo "⚠️  Off-host transfer of $base to BACKUP_REMOTE=$BACKUP_REMOTE FAILED (local backup still OK)" >&2
    fi
  fi
}
ship "$DAILY_FILE" 640
# Same off-host treatment for the state tarball and the AI-quorum DB, if
# produced above.
[ -f "$STATE_FILE" ] && ship "$STATE_FILE" 640
[ -f "$AIQ_DAILY" ] && ship "$AIQ_DAILY" 640
# The master key decrypts the broker credentials stored in the DB; its only
# other copy lives on this same host. Shipped off-host as-is (mode 600, one
# file, overwritten daily): useless without the DB, and the DB without it
# loses the encrypted broker accounts.
if [ -f "$DATA_DIR/master.key" ] && { [ -n "${BACKUP_REMOTE:-}" ] || [ -n "${BACKUP_OFFHOST_DIR:-}" ]; }; then
  ship "$DATA_DIR/master.key" 600
fi

STATE_MSG="no risk-state files found"
[ -f "$STATE_FILE" ] && STATE_MSG="state → $STATE_FILE"
[ -f "$AIQ_DAILY" ] && STATE_MSG="$STATE_MSG, ai-quorum → $AIQ_DAILY"

if [ -z "$INTEGRITY" ]; then
  echo "⚠️  DB backed up at ${TS} → $DAILY_FILE (${SIZE_MB} MB, integrity=skipped, $STATE_MSG)"
else
  echo "✅ DB backed up at ${TS} → $DAILY_FILE (${SIZE_MB} MB, integrity=ok, $STATE_MSG)"
fi
