#!/usr/bin/env bash
# ══════════════════════════════════════════════
# DB + risk-state restore — companion to backup-db.sh (P2-F).
#
# DRY-RUN by default: prints exactly what it WOULD restore (DB + risk-state
# tarball, if one exists for that date) plus the post-restore checklist, and
# touches NOTHING. Real restore requires --apply.
#
# A DB-only restore is not enough: data/momentum-state-*.json,
# data/meanrev-state-*.json and data/daily-run-* markers are real trading
# state (RiskGuard peak/pause, meanrev's per-day idempotence, swap-guard
# HALTED/ACTIVE) — restoring the DB alone can let meanrev re-enter symbols
# it already opened "today" or resurrect a HALTED swap-guard as ACTIVE.
# backup-db.sh bundles that state into a sibling daily-<date>-state.tar.gz;
# this script restores both together.
#
# Usage:
#   restore-db.sh <backup-date|latest> [--apply] [--data-dir <dir>]
#                 [--force-while-running]
#
#   <backup-date>            YYYYMMDD, matching data/backups/daily-<date>.db
#   latest                   picks the newest daily-*.db backup by mtime
#   --apply                  actually restore (default: dry-run/preview only)
#   --data-dir <dir>         data dir to operate on (default: ./data, or
#                             $RESTORE_DATA_DIR if set) — lets this script be
#                             rehearsed against a scratch directory instead
#                             of production data/
#   --force-while-running    skip the "bot is running" guard (DANGEROUS —
#                             only meant for a rehearsal against --data-dir)
# ══════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="${RESTORE_DATA_DIR:-$ROOT_DIR/data}"
APPLY=0
FORCE_WHILE_RUNNING=0
DATE_ARG=""

usage() {
  echo "Usage: $0 <backup-date|latest> [--apply] [--data-dir <dir>] [--force-while-running]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --force-while-running) FORCE_WHILE_RUNNING=1; shift ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [ -z "$DATE_ARG" ]; then DATE_ARG="$1"; shift
      else echo "❌ Unexpected argument: $1" >&2; usage; exit 1; fi
      ;;
  esac
done

if [ -z "$DATE_ARG" ]; then
  usage
  exit 1
fi

BACKUP_DIR="$DATA_DIR/backups"

# ── Resolve which backup to restore ─────────────────────────────────────
if [ "$DATE_ARG" = "latest" ]; then
  DB_BACKUP="$(ls -1t "$BACKUP_DIR"/daily-*.db 2>/dev/null | head -1 || true)"
  if [ -z "$DB_BACKUP" ]; then
    echo "❌ No daily-*.db backups found in $BACKUP_DIR" >&2
    exit 1
  fi
  DATE_RESOLVED="$(basename "$DB_BACKUP" .db | sed 's/^daily-//')"
else
  DATE_RESOLVED="$DATE_ARG"
  DB_BACKUP="$BACKUP_DIR/daily-${DATE_RESOLVED}.db"
fi

if [ ! -f "$DB_BACKUP" ]; then
  echo "❌ Backup not found: $DB_BACKUP" >&2
  exit 1
fi

STATE_BACKUP="$BACKUP_DIR/daily-${DATE_RESOLVED}-state.tar.gz"
HAS_STATE=0
[ -f "$STATE_BACKUP" ] && HAS_STATE=1

TARGET_DB="$DATA_DIR/trading.db"

# Resolve bun the same robust way backup-db.sh / start.sh do.
if [ -z "${BUN:-}" ]; then
  BUN="$(command -v bun || true)"
  if [ -z "$BUN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN="$HOME/.local/share/mise/shims/bun"; fi
  if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
fi

print_checklist() {
  cat <<EOF
────────────────────────────────────────────────
 POST-RESTORE CHECKLIST
────────────────────────────────────────────────
 1. STOP THE BOT FIRST. This script refuses --apply while
    'systemctl --user is-active uncle-carl' reports active, unless
    --force-while-running is passed. If it's running: ./start.sh stop
 2. After the restore completes, re-verify sleeve mode + risk-engine state
    BEFORE restarting — a restored DB can carry a HALTED swap-guard or a
    stale sleeve_modes row that no longer matches reality:
      sqlite3 "$TARGET_DB" "SELECT sleeve, mode, reason, updated_at FROM sleeve_modes;"
      grep -E '^RISK_ENGINE_STATE=' "$ROOT_DIR/.env" || echo "(RISK_ENGINE_STATE unset — default)"
 3. Run the orphan-exposure reconciler in DRY-RUN (its default — no --apply)
    and read its output before trusting the restored book:
      bun "$ROOT_DIR/scripts/reconcile-orphan-exposure.ts"
 4. Only once 2-3 look sane, restart: $ROOT_DIR/start.sh
────────────────────────────────────────────────
EOF
}

echo "════════════════════════════════════════════"
echo " RESTORE PLAN (date=$DATE_RESOLVED, data dir=$DATA_DIR)"
echo "════════════════════════════════════════════"
echo "  DB backup     : $DB_BACKUP"
echo "                  -> $TARGET_DB"
if [ "$HAS_STATE" = "1" ]; then
  echo "  state tarball : $STATE_BACKUP"
  echo "                  -> $DATA_DIR/ (contents below)"
  tar -tzf "$STATE_BACKUP" 2>/dev/null | sed 's/^/                    - /'
else
  echo "  state tarball : none found for daily-${DATE_RESOLVED} (pre-P2-F backup, or no risk-state existed)"
fi
echo
print_checklist

if [ "$APPLY" != "1" ]; then
  echo
  echo "🔎 DRY-RUN — nothing was touched. Re-run with --apply to actually restore."
  exit 0
fi

# ── Guard: refuse to restore under a live bot unless overridden ─────────
UNIT="uncle-carl"
if [ "$FORCE_WHILE_RUNNING" != "1" ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    echo >&2
    echo "❌ Refusing to restore: 'systemctl --user is-active $UNIT' reports active." >&2
    echo "   Stop it first (./start.sh stop) or pass --force-while-running if this is a" >&2
    echo "   rehearsal against --data-dir (DANGEROUS against real production data)." >&2
    exit 1
  fi
fi

echo
echo "▶️  Applying restore…"

mkdir -p "$DATA_DIR"

# ── 1. Snapshot whatever is currently in place before we overwrite it ───
PRE_TS="$(date -u +%Y%m%dT%H%M%SZ)"
PRE_DIR="$DATA_DIR/pre-restore-${PRE_TS}"
mkdir -p "$PRE_DIR"
for f in "$TARGET_DB" "$TARGET_DB-shm" "$TARGET_DB-wal"; do
  [ -f "$f" ] && cp -p "$f" "$PRE_DIR/" 2>/dev/null || true
done
shopt -s nullglob
CURRENT_STATE_FILES=("$DATA_DIR"/momentum-state-*.json "$DATA_DIR"/meanrev-state-*.json "$DATA_DIR"/daily-run-*)
shopt -u nullglob
for f in "${CURRENT_STATE_FILES[@]}"; do
  cp -p "$f" "$PRE_DIR/" 2>/dev/null || true
done
echo "📦 Pre-restore snapshot of current state → $PRE_DIR"

# ── 2. Stage the backup DB and verify integrity BEFORE it goes live ─────
# Fail-closed: unlike backup-db.sh (which tolerates "integrity=skipped" when
# neither sqlite3 nor bun is available), a restore with an UNVERIFIED backup
# is exactly the failure mode this script exists to prevent — no tool to
# check it means we abort, not proceed blind.
STAGING="$TARGET_DB.restoring"
cp "$DB_BACKUP" "$STAGING"

INTEGRITY=""
if command -v sqlite3 >/dev/null 2>&1; then
  INTEGRITY=$(sqlite3 "$STAGING" "PRAGMA integrity_check;" 2>/dev/null | head -1)
elif [ -n "$BUN" ] && [ -x "$BUN" ]; then
  INTEGRITY=$("$BUN" -e "
const { Database } = require('bun:sqlite');
const d = new Database('$STAGING', { readonly: true });
const r = d.prepare('PRAGMA integrity_check').get();
console.log(Object.values(r)[0]);
" 2>/dev/null)
fi

if [ -z "$INTEGRITY" ] || [ "$INTEGRITY" != "ok" ]; then
  echo "❌ Restore ABORTED: integrity check on the backup failed (result: \"${INTEGRITY:-no result — missing sqlite3/bun, or the backup file is not a readable sqlite DB}\")." >&2
  echo "   Target DB was NOT touched. Staging file removed." >&2
  rm -f "$STAGING"
  exit 2
fi

mv "$STAGING" "$TARGET_DB"
rm -f "$TARGET_DB-shm" "$TARGET_DB-wal" 2>/dev/null || true
chmod 640 "$TARGET_DB" 2>/dev/null || true
echo "✅ DB restored → $TARGET_DB (integrity=ok)"

# ── 3. Restore the risk-state tarball, if this backup has one ───────────
if [ "$HAS_STATE" = "1" ]; then
  tar -xzf "$STATE_BACKUP" -C "$DATA_DIR"
  echo "✅ Risk state restored from $STATE_BACKUP"
else
  echo "⚠️  No state tarball for this backup date — momentum/meanrev state, daily-run markers NOT restored."
fi

echo
echo "✅ Restore complete."
print_checklist
