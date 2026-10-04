#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Install Uncle Carl cron entries for the current user. Idempotent: rerun
# safely. Installs four jobs. Times are the HOST'S LOCAL time (cron has no
# timezone of its own): prod runs America/Lima (UTC−5, no DST), so 04:00 /
# 04:30 / 04:45 there are 09:00 / 09:30 / 09:45 UTC = 05:00–05:45 ET — the
# relative order (refresh → backup → parity, all before the 09:35 ET pass)
# is what matters and holds in any timezone.
#
#   1. Daily DB backup (04:30 host-local)
#   2. Daily historical-bar refresh (04:00 host-local, BEFORE the backup so the
#      freshly pulled bars are in the backup as well). historical.db feeds the
#      backtest/walk-forward scripts and the dashboard candle modal — NOT the
#      live trading path. Without this the bot keeps trading fine but every
#      backtest silently runs on aging data.
#   3. Health watchdog every 5 minutes
#   4. Live↔sim parity check (04:45 host-local Tue–Sat — after the 04:00 refresh
#      pulled yesterday's daily bars and the 04:30 backup; Tue–Sat because
#      each run compares the PREVIOUS trading session Mon–Fri). Read-only;
#      pages the OPS chat only on divergence (scripts/parity-check.ts).
# ══════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_SCRIPT="$ROOT_DIR/scripts/backup-db.sh"
REFRESH_SCRIPT="$ROOT_DIR/scripts/refresh-historical.sh"
WATCHDOG_SCRIPT="$ROOT_DIR/scripts/watchdog.sh"
PARITY_SCRIPT="$ROOT_DIR/scripts/parity-check.sh"
LOG_DIR="$ROOT_DIR/logs"

for s in "$BACKUP_SCRIPT" "$REFRESH_SCRIPT" "$WATCHDOG_SCRIPT" "$PARITY_SCRIPT"; do
  if [ ! -x "$s" ]; then
    chmod +x "$s"
  fi
done

# 04:30 host-local (prod: 09:30 UTC = 05:30 ET). Off-peak window between
# Alpaca close and the next session.
BACKUP_LINE="30 4 * * * $BACKUP_SCRIPT >> $LOG_DIR/backup.log 2>&1"
BACKUP_TAG="# uncle-carl-backup"

# 04:00 host-local, half an hour before the backup so the fresh bars are captured.
REFRESH_LINE="0 4 * * * $REFRESH_SCRIPT >> $LOG_DIR/refresh-historical.log 2>&1"
REFRESH_TAG="# uncle-carl-refresh-historical"

WATCHDOG_LINE="*/5 * * * * $WATCHDOG_SCRIPT >> $LOG_DIR/watchdog.log 2>&1"
WATCHDOG_TAG="# uncle-carl-watchdog"

# 04:45 host-local Tue–Sat: after the refresh (04:00) has yesterday's bars and the
# backup (04:30). Tue–Sat covers previous sessions Mon–Fri.
PARITY_LINE="45 4 * * 2-6 $PARITY_SCRIPT >> $LOG_DIR/parity-check.log 2>&1"
PARITY_TAG="# uncle-carl-parity-check"

CURRENT=$(crontab -l 2>/dev/null || echo "")
NEW="$CURRENT"

add_entry() {
  local tag="$1" line="$2"
  if echo "$NEW" | grep -Fq "$tag"; then
    echo "✅ Already installed: $tag"
  else
    NEW=$(printf '%s\n%s\n%s\n' "$NEW" "$tag" "$line" | sed '/^$/d')
    echo "➕ Adding: $line"
  fi
}

add_entry "$BACKUP_TAG"  "$BACKUP_LINE"
add_entry "$REFRESH_TAG" "$REFRESH_LINE"
add_entry "$WATCHDOG_TAG" "$WATCHDOG_LINE"
add_entry "$PARITY_TAG" "$PARITY_LINE"

if [ "$NEW" != "$CURRENT" ]; then
  echo "$NEW" | crontab -
  echo "✅ Cron updated."
else
  echo "Nothing to do — all entries already present."
fi

echo
echo "Active uncle-carl cron lines:"
crontab -l | grep -E "uncle-carl" || true
