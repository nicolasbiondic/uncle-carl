# scripts/lib/cron-job.sh — dead-man's switch + failure page for cron wrappers.
# Sourced by backup-db.sh, refresh-historical.sh, parity-check.sh, guardian.sh,
# ai-quorum.sh and restore-drill.sh (audit F-2, 2026-11-07: every job wrote
# only its own log, which nobody reads; a misdirected backup and a dead AI
# quorum went unnoticed for over a day).
#
#   cron_job_start <job> [ok exit codes…]   (default ok code: 0)
#
# installs an EXIT trap that, on an ok exit code, writes
# data/cron-markers/<job>.ok (epoch seconds, atomic tmp+mv), which
# src/ops/cronJobs.ts (guardian G7, /healthz stale_jobs) reads; on any other
# exit code it pages the OPS chat ONCE per episode (data/cron-markers/
# <job>.failing), and the first ok exit afterwards sends one recovery notice.
# A page that could not be delivered is NOT recorded: the next run retries it.
# Set CRON_JOB_SKIP=1 before exiting to leave both marker and page untouched
# (a run that had nothing to do, or a lock held by an overlapping run).
#
# Telegram: OPS chat only, read with grep from the .env (never sourced), the
# token travels through stdin (-K -), not argv. Env seams for tests:
# CRON_MARKER_DIR, CRON_ENV_FILE, TELEGRAM_API_BASE.

CRON_ROOT_DIR="${CRON_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CRON_MARKER_DIR="${CRON_MARKER_DIR:-$CRON_ROOT_DIR/data/cron-markers}"
CRON_ENV_FILE="${CRON_ENV_FILE:-$CRON_ROOT_DIR/.env}"
CRON_JOB_NAME=""
CRON_JOB_OK=" 0 "
CRON_JOB_SKIP=0

# cron_write_atomic FILE CONTENT
cron_write_atomic() {
  local tmp="$1.tmp.$$"
  if printf '%s\n' "$2" > "$tmp" 2>/dev/null && mv -f "$tmp" "$1" 2>/dev/null; then return 0; fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

# cron_mark JOB — record a success for JOB now (also used for secondary markers).
cron_mark() {
  mkdir -p "$CRON_MARKER_DIR" 2>/dev/null || return 1
  cron_write_atomic "$CRON_MARKER_DIR/$1.ok" "$(date +%s)"
}

# cron_marker_epoch JOB — epoch seconds of JOB's last success, 0 when none.
cron_marker_epoch() {
  local v
  v=$(head -c 32 "$CRON_MARKER_DIR/$1.ok" 2>/dev/null | tr -dc '0-9')
  echo "${v:-0}"
}

# cron_notify TEXT — 0 delivered, 1 send failed, 2 credentials missing.
cron_notify() {
  local token chat api="${TELEGRAM_API_BASE:-https://api.telegram.org}"
  token=$(grep -oP '^TELEGRAM_BOT_TOKEN=\K.+' "$CRON_ENV_FILE" 2>/dev/null | tail -1 | tr -d "\"' \r")
  chat=$(grep -oP '^TELEGRAM_OPS_CHAT_ID=\K.+' "$CRON_ENV_FILE" 2>/dev/null | tail -1 | tr -d "\"' \r")
  if [ -z "$token" ] || [ -z "$chat" ]; then
    echo "cron-job: ops page DROPPED (TELEGRAM_BOT_TOKEN/TELEGRAM_OPS_CHAT_ID missing): ${1:0:160}" >&2
    return 2
  fi
  if printf 'url = "%s/bot%s/sendMessage"\n' "$api" "$token" \
       | curl -fsS -m 15 -K - -d "chat_id=${chat}" --data-urlencode "text=$1" >/dev/null 2>&1; then
    return 0
  fi
  echo "cron-job: telegram send FAILED (retried on the next run)" >&2
  return 1
}

_cron_job_exit() {
  local rc="$1" failing
  trap - EXIT
  if [ -z "$CRON_JOB_NAME" ] || [ "$CRON_JOB_SKIP" = "1" ]; then exit "$rc"; fi
  failing="$CRON_MARKER_DIR/$CRON_JOB_NAME.failing"
  if [[ "$CRON_JOB_OK" == *" $rc "* ]]; then
    cron_mark "$CRON_JOB_NAME" || echo "cron-job: could not write the $CRON_JOB_NAME marker" >&2
    if [ -f "$failing" ]; then
      if cron_notify "✅ cron ${CRON_JOB_NAME}@$(hostname): vuelve a terminar bien (exit ${rc})."; then
        rm -f "$failing"
      fi
    fi
  elif [ ! -f "$failing" ]; then
    if cron_notify "🚨 cron ${CRON_JOB_NAME}@$(hostname) falló (exit ${rc}). Ver scripts/logs.sh en el host. Aviso una sola vez hasta que vuelva a terminar bien."; then
      mkdir -p "$CRON_MARKER_DIR" 2>/dev/null
      cron_write_atomic "$failing" "$(date +%s) $rc"
    fi
  fi
  exit "$rc"
}

# cron_job_start JOB [OK_CODES…]
cron_job_start() {
  CRON_JOB_NAME="$1"; shift
  CRON_JOB_OK=" ${*:-0} "
  CRON_JOB_SKIP=0
  mkdir -p "$CRON_MARKER_DIR" 2>/dev/null || true
  # Tracking starts at the first wrapper run (or install-cron.sh): see src/ops/cronJobs.ts.
  [ -f "$CRON_MARKER_DIR/.since" ] || cron_write_atomic "$CRON_MARKER_DIR/.since" "$(date +%s)" || true
  trap '_cron_job_exit $?' EXIT
}
