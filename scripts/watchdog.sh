#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# P0 fix (2026-07-27): cron runs with no D-Bus session, so start.sh's
# has_systemd() (`systemctl --user is-enabled …`) always failed here — verified
# live: `env -i HOME=... PATH=... systemctl --user is-enabled uncle-carl.service`
# → "Failed to connect to bus: No medium found" (exit 1), even though the unit
# IS enabled and running. Every watchdog-triggered restart therefore fell
# through to start.sh's foreground+nohup fallback and spawned an ORPHAN bun
# process outside the unit's cgroup (logs/watchdog.log confirms this twice —
# the most recent one is the zombie this incident is about). Exporting these
# two makes systemctl --user work exactly as it does in an interactive shell.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

# Guard against two overlapping cron ticks (e.g. a slow start.sh restart still
# running when the next cron minute fires) stepping on each other. Non-blocking:
# if another watchdog run already holds the lock, just skip this tick.
LOCK_FILE="$ROOT_DIR/logs/.watchdog.lock"
mkdir -p "$ROOT_DIR/logs"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  exit 0
fi

# Derive the dashboard port from .env (this host uses 3799, default is 3789).
# A hardcoded port would false-fail the health check and restart-loop the bot.
PORT="3789"
if [ -f "$ROOT_DIR/.env" ]; then
  ENV_PORT="$(grep -E '^DASHBOARD_PORT=' "$ROOT_DIR/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi
HEALTH_URL="${WATCHDOG_HEALTH_URL:-http://localhost:${PORT}/healthz}"
LOG_FILE="$ROOT_DIR/logs/watchdog.log"
STAMP="/tmp/uncle-carl-watchdog-paged"

# 2026-09-11 — the 83-restart class, diagnosed: every one of those restarts
# killed a LIVE process. /healthz used to 503 on a merely STALE loop (one
# pass overrunning its grace while waiting on a slow broker), `curl -f`
# turned that into "DOWN", and this script restarted on the FIRST miss —
# then the fresh process, cold cache, first pass against the same slow
# upstream, was "DOWN" again at the next tick. Five restarts in 20 minutes
# on 2026-09-11 (Alpaca 504 storm), each one worse than the outage it was
# reacting to. /healthz now answers liveness (503 only for a DEAD loop) —
# and this side gets three guards of its own, because a watchdog that can
# loop is not a watchdog:
#   1. timeout 15s, not 5s — a busy-but-alive event loop answers in time;
#   2. TWO consecutive DOWN ticks (10 min) before acting, state on disk;
#   3. never restart within RESTART_COOLDOWN_S of the previous watchdog
#      restart — a fresh boot has not had time to warm its caches.
#
# 2026-09-25 — the broker-outage class (OPEN.md item closed): on 09-23
# 07:32–07:55 Alpaca's API stopped answering; the sync loops kept COMPLETING
# failed passes, but only success ever beat the heartbeat, so >5min of
# outage read as a dead loop → /healthz 503 ×2 → this script restarted a
# healthy process at 07:45 into "DEGRADED START — alpaca DOWN" (same class
# again on the 09-25 DNS cuts, paged but not restarted). Fixed at the
# SOURCE: a loop whose pass completes against an unreachable broker calls
# heartbeats.beatFailed() — alive for liveness, failing for reachability —
# so /healthz stays 200 with `status: "degraded"` +
# `broker_unreachable_count`, and this script never sees DOWN for a broker
# outage. No restart logic changes here BY DESIGN: `curl -f` on /healthz is
# still the only probe, and 503 still means "genuinely dead loop, restart
# is correct". Rehearsal: src/dashboard/routes/health.test.ts ("broker
# unreachable ≠ dead") + scripts/supervision.test.ts.
STATE_FILE="$ROOT_DIR/logs/.watchdog.state"
DOWN_TICKS_REQUIRED="${WATCHDOG_DOWN_TICKS:-2}"
RESTART_COOLDOWN_S="${WATCHDOG_RESTART_COOLDOWN_S:-600}"
down_count=0; last_restart=0
[ -f "$STATE_FILE" ] && . "$STATE_FILE" 2>/dev/null || true
save_state() { printf 'down_count=%s\nlast_restart=%s\n' "$1" "$2" > "$STATE_FILE"; }

if curl -fsS -m 15 "$HEALTH_URL" >/dev/null 2>&1; then
  [ "${down_count:-0}" -gt 0 ] && printf '[%s] healthz OK again after %s DOWN tick(s) — no restart needed\n' "$(date -u +%FT%TZ)" "$down_count" >> "$LOG_FILE"
  save_state 0 "${last_restart:-0}"
  exit 0
fi

mkdir -p "$ROOT_DIR/logs"
down_count=$(( ${down_count:-0} + 1 ))
now_s=$(date +%s)
if [ "$down_count" -lt "$DOWN_TICKS_REQUIRED" ]; then
  printf '[%s] healthz DOWN (%s/%s) — waiting for a consecutive miss before restarting\n' "$(date -u +%FT%TZ)" "$down_count" "$DOWN_TICKS_REQUIRED" >> "$LOG_FILE"
  save_state "$down_count" "${last_restart:-0}"
  exit 1
fi
if [ $(( now_s - ${last_restart:-0} )) -lt "$RESTART_COOLDOWN_S" ]; then
  printf '[%s] healthz DOWN (%s/%s) but last watchdog restart was %ss ago (< %ss cooldown) — NOT restarting a fresh boot\n' "$(date -u +%FT%TZ)" "$down_count" "$DOWN_TICKS_REQUIRED" "$(( now_s - ${last_restart:-0} ))" "$RESTART_COOLDOWN_S" >> "$LOG_FILE"
  save_state "$down_count" "${last_restart:-0}"
  exit 1
fi
save_state 0 "$now_s"
printf '[%s] healthz DOWN (%s/%s consecutive) — restarting via start.sh\n' "$(date -u +%FT%TZ)" "$down_count" "$DOWN_TICKS_REQUIRED" >> "$LOG_FILE"

# A unit that tripped the start limit (StartLimitBurst=5 in 60s) sits in
# `failed` and systemd REFUSES to start it again until the counter is
# cleared — `systemctl start` on such a unit fails with "start request
# repeated too quickly". Without this, the crash-loop case is exactly the
# one the watchdog cannot recover, which is the opposite of what a watchdog
# is for. Harmless when the unit is not failed. 2026-08-06.
if systemctl --user is-failed --quiet "uncle-carl.service" 2>/dev/null; then
  printf '[%s] unit in FAILED state (start limit?) — reset-failed before restart\n' "$(date -u +%FT%TZ)" >> "$LOG_FILE"
  systemctl --user reset-failed "uncle-carl.service" >> "$LOG_FILE" 2>&1 || true
fi

"$ROOT_DIR/start.sh" >> "$LOG_FILE" 2>&1

if [ ! -f "$STAMP" ] || [ "$(( $(date +%s) - $(stat -c %Y "$STAMP" 2>/dev/null || echo 0) ))" -ge 3600 ]; then
  if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
  fi
  # OPERATOR audience only (2026-08-03): a watchdog restart is plumbing. It
  # goes to TELEGRAM_OPS_CHAT_ID; with that unset the event stays in
  # logs/watchdog.log and NEVER reaches the end-user chat. Deliberately no
  # fallback to TELEGRAM_CHAT_ID — that fallback was the noise.
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_OPS_CHAT_ID:-}" ]; then
    curl -fsS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_OPS_CHAT_ID}" \
      -d "text=🚨 Uncle Carl watchdog: bot estaba caído, reiniciado vía start.sh en $(hostname) $(date -u +%FT%TZ)" \
      >/dev/null 2>&1 || true
  fi
  touch "$STAMP"
fi

exit 1
