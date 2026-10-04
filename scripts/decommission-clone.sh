#!/usr/bin/env bash
#
# decommission-clone.sh — one-shot retirement of the DEV CLONE as a runtime.
#
# Owner decision 2026-07-29: there is ONE system (prod).
# This script retires a second dev clone that shared prod's broker account:
# flush its 4 Alpaca rows (bounded to OUR DB quantities — the broker account
# is shared), then stop and disable the service and its watchdog for good.
#
# RUNBOOK (the full consolidation, in order — do not reorder):
#   1. This script runs via cron at 08:35 America/Lima (= 09:35 ET, market
#      open, weekdays) and does: remove watchdog cron -> stop unit ->
#      close-stocks-at-open.ts (bounded flush) -> verify 0 open rows ->
#      disable unit -> write data/.decommissioned -> remove own cron line.
#      On ANY failure it restores the unit + watchdog and retries the next
#      market day. Log: logs/decommission.log + Telegram either way.
#   2. AFTER the marker exists, verify prod is clean:
#        ssh into prod -> healthz 200, no WS 406 warnings,
#        BrokerSync quantity drift gone (broker == prod's DB).
#   3. ONLY THEN merge branch `single-system-cleanup` into master and push
#      (push auto-deploys to prod in ~2min). That branch deletes the
#      dual-host mitigation code; deploying it while two traders still run
#      would blind both.
#
# Safety: hostname-guarded — inert anywhere but the designated dev-clone
# host ($DEV_CLONE_HOSTNAME), so this file existing on prod (it ships with
# the repo) can never decommission prod. Unset/default = inert everywhere.
DEV_CLONE_HOSTNAME="${DEV_CLONE_HOSTNAME:-}"

set -uo pipefail

if [ -z "$DEV_CLONE_HOSTNAME" ] || [ "$(hostname)" != "$DEV_CLONE_HOSTNAME" ]; then
  echo "decommission-clone.sh: refusing to run on host '$(hostname)' (set DEV_CLONE_HOSTNAME to the dev clone's hostname to arm this script)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# cron has no D-Bus session; same fix as watchdog.sh (2026-07-27).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
# cron's PATH has no ~/.local/bin — without this, `bun` is not found and the
# 2026-07-30 08:35 run failed (restored cleanly, but flushed nothing).
export PATH="$HOME/.local/bin:$PATH"

MARKER="$ROOT_DIR/data/.decommissioned"
LOG_FILE="$ROOT_DIR/logs/decommission.log"
WATCHDOG_LINE="*/5 * * * * $ROOT_DIR/scripts/watchdog.sh >> $ROOT_DIR/logs/watchdog.log 2>&1"
mkdir -p "$ROOT_DIR/logs"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG_FILE"; }

notify() {
  if [ -f "$ROOT_DIR/.env" ]; then
    set -a; source "$ROOT_DIR/.env"; set +a
  fi
  # OPS chat only (2026-08-03) — decommissioning is an operator task. This
  # script is already inert (hostname-guarded, marker written), kept aligned
  # so no path can page the user chat.
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_OPS_CHAT_ID:-}" ]; then
    curl -fsS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_OPS_CHAT_ID}" \
      -d "text=[$(hostname)] decommission-clone: $1" >/dev/null 2>&1 || true
  fi
}

if [ -f "$MARKER" ]; then
  exit 0
fi

# Single-flight: don't overlap with a still-running previous attempt.
exec 201>"$ROOT_DIR/logs/.decommission.lock"
if ! flock -n 201; then
  exit 0
fi

log "START — retiring this clone (flush bounded to our DB rows, then shutdown)"

# 1. Watchdog off FIRST — otherwise it resurrects the bot mid-flush.
crontab -l 2>/dev/null | grep -vF 'scripts/watchdog.sh' | grep -vF '# uncle-carl-watchdog' | crontab -

# 2. Stop the bot BEFORE flushing: if the 15s stop-loss loop and this flush
#    both sell the same symbol, the two sells can liquidate PROD's share of
#    the aggregate broker position.
systemctl --user stop uncle-carl.service 2>> "$LOG_FILE"
sleep 3

# 3. Bounded flush (exits non-zero if market closed, init fails, or
#    enumeration fails — all of those take the restore path below).
FLUSH_OK=0
if bun run scripts/close-stocks-at-open.ts >> "$LOG_FILE" 2>&1; then
  OPEN_ROWS="$(bun -e "const {Database}=require('bun:sqlite');const db=new Database('data/trading.db',{readonly:true});console.log(db.query(\"SELECT COUNT(*) AS n FROM trades WHERE status='open'\").get().n);" 2>> "$LOG_FILE")"
  log "flush script OK; open rows remaining: ${OPEN_ROWS:-unknown}"
  if [ "${OPEN_ROWS:-1}" = "0" ]; then
    FLUSH_OK=1
  fi
else
  log "flush script FAILED (market closed / init / enumeration) — restoring"
fi

if [ "$FLUSH_OK" = "1" ]; then
  systemctl --user disable uncle-carl.service 2>> "$LOG_FILE"
  touch "$MARKER"
  # Remove our own cron line — this was a one-shot.
  crontab -l 2>/dev/null | grep -vF 'scripts/decommission-clone.sh' | crontab -
  log "DONE — book flat, unit stopped+disabled, watchdog and own cron removed"
  notify "DONE. Clone book flat, service disabled. Next: verify prod (no WS 406, no qty drift), THEN merge single-system-cleanup -> master."
  exit 0
fi

# Restore path: an open position must never go unmanaged.
systemctl --user start uncle-carl.service 2>> "$LOG_FILE"
if ! crontab -l 2>/dev/null | grep -qF 'scripts/watchdog.sh'; then
  ( crontab -l 2>/dev/null; echo "$WATCHDOG_LINE" ) | crontab -
fi
log "RESTORED — bot + watchdog back; will retry next market day"
notify "flush FAILED or rows still open — bot+watchdog restored, retrying next market day. See logs/decommission.log"
exit 1
