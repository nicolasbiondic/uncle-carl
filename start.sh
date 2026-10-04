#!/bin/bash
# ══════════════════════════════════════════════
# Uncle Carl Trading Bot — single entry point.
#
# Auto-detects systemd. If the user-level unit is installed, delegates to
# `systemctl --user restart uncle-carl` (gives you auto-restart on crash,
# survives SSH disconnect, starts on reboot). Otherwise falls back to the
# old foreground+nohup mode for debugging.
#
# Usage:
#   ./start.sh                  → start (or restart) the bot
#   ./start.sh stop             → stop the bot
#   ./start.sh status           → show current state
#   ./start.sh logs             → tail bot.log
#   ./start.sh panic            → BROKER-side kill switch: suspend all new
#                                 orders on the Alpaca account (scripts/panic.ts)
#   ./start.sh resume-trading   → lift the broker-side suspension (deliberately
#                                 distinct + longer than "panic"; asks you to
#                                 type "resume" unless --yes)
# ══════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

UNIT="uncle-carl.service"
# Read the real port from .env — a hardcoded default made the fallback mode
# free the WRONG port and print a dashboard URL nobody was listening on.
PORT="$(grep -E '^DASHBOARD_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"'"'"' ' || true)"
PORT="${PORT:-3789}"

# P0 fix (2026-07-27): kills any bot process sharing THIS script's cwd, except
# an optional PID to spare. Shared by `stop`, the foreground fallback, AND
# (new) the systemd branch below — a watchdog run under cron can't always
# detect systemd (see has_systemd()), so it fell through to the foreground
# path and left an orphan bun process OUTSIDE the unit's cgroup. Plain
# `systemctl --user restart` never touches that orphan (it only manages its
# own unit's process), so it silently kept running and racing the systemd
# instance for the same port. $1 spare_pid must be the CURRENT legitimate
# systemd MainPID when called from that branch — never call this unguarded
# from inside systemd's own process tree.
kill_orphans_by_cwd() {
  local spare_pid="${1:-}"
  for pid in $(pgrep -f 'bun.*src/index'); do
    [ -n "$spare_pid" ] && [ "$pid" = "$spare_pid" ] && continue
    if [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$SCRIPT_DIR" ]; then
      kill -9 "$pid" 2>/dev/null
    fi
  done
}

# Resolve bun robustly — it may live in PATH, a mise shim, or ~/.bun/bin.
# (A hardcoded fixed ~/.bun/bin/bun path broke when bun moved to mise.)
# Shared by the foreground fallback AND the panic/resume-trading subcommands.
resolve_bun() {
  if [ -z "${BUN:-}" ]; then
    BUN="$(command -v bun || true)"
    if [ -z "$BUN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN="$HOME/.local/share/mise/shims/bun"; fi
    if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
  fi
  if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
    echo "❌ bun not found (tried \$BUN, PATH, mise shim, ~/.bun/bin) — set BUN env var to override"
    return 1
  fi
  return 0
}

# ── Detect whether the systemd-user unit is installed AND enabled ──────
# Audit fix (2026-05-04): previously checked only `list-unit-files`, which
# returns the file regardless of enabled/disabled state. If a user ran
# `systemctl --user disable uncle-carl`, the next ./start.sh would silently
# re-enable supervision via `restart`. Honour the user's disable intent.
has_systemd() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl --user list-unit-files 2>/dev/null | grep -q "^${UNIT}" \
    && systemctl --user is-enabled --quiet "${UNIT}" 2>/dev/null
}

# ── Subcommand handling ────────────────────────────────────────────────
case "${1:-start}" in
  stop)
    if has_systemd; then
      echo "🛑 Stopping bot (systemd)…"
      systemctl --user stop "$UNIT"
    else
      echo "🛑 Stopping bot…"
      kill_orphans_by_cwd
      fuser -k "$PORT/tcp" 2>/dev/null
    fi
    echo "✅ Stopped."
    exit 0
    ;;
  status)
    if has_systemd; then
      systemctl --user status "$UNIT" --no-pager | head -15
    else
      echo "Mode: foreground (no systemd)"
      pgrep -af 'bun.*src/index' | grep "$SCRIPT_DIR" || echo "Bot is NOT running."
    fi
    exit 0
    ;;
  logs)
    exec tail -f "$SCRIPT_DIR/logs/bot.log"
    ;;
  panic)
    # BROKER-enforced kill switch: sets suspend_trade on the Alpaca account,
    # which every process holding the credentials must respect (zombies and
    # stale clones included). The script shows current state, asks for
    # confirmation (unless --yes) and logs to logs/panic.log.
    shift
    resolve_bun || exit 1
    exec "$BUN" scripts/panic.ts on "$@"
    ;;
  resume-trading)
    # Inverse of panic — intentionally a DIFFERENT, longer subcommand so it
    # can't be fat-fingered; the script requires typing "resume" unless --yes.
    shift
    resolve_bun || exit 1
    exec "$BUN" scripts/panic.ts off "$@"
    ;;
  start|restart|"")
    : # fall through to start logic below
    ;;
  *)
    echo "Usage: $0 [start|stop|status|logs|panic|resume-trading]"
    exit 1
    ;;
esac

# ══════════════════════════════════════════════
# Start path
# ══════════════════════════════════════════════
mkdir -p logs

if has_systemd; then
  echo "🚀 Starting Uncle Carl via systemd…"
  # Kill any orphan bot process (e.g. left behind by a cron watchdog run that
  # couldn't see systemd — see kill_orphans_by_cwd's comment above) BEFORE
  # restarting, sparing the unit's own current MainPID so this never kills
  # the legitimate systemd-managed process.
  CURRENT_MAIN_PID="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  kill_orphans_by_cwd "$CURRENT_MAIN_PID"
  systemctl --user restart "$UNIT"
  sleep 3
  if systemctl --user is-active --quiet "$UNIT"; then
    PID=$(systemctl --user show -p MainPID --value "$UNIT")
    echo "✅ Bot running (PID $PID, managed by systemd)"
    echo "📊 Dashboard: http://localhost:$PORT"
    echo "📝 Logs:      ./start.sh logs   (or: journalctl --user -u uncle-carl -f)"
    echo "🔁 Auto-restart on crash: yes"
    exit 0
  else
    echo "❌ systemd reports the unit is not active. Falling back to foreground mode."
    systemctl --user --no-pager status "$UNIT" | head -10
    # Fall through so the user still gets a working bot.
  fi
fi

# ── Fallback: foreground + nohup (no systemd available) ────────────────
resolve_bun || exit 1

echo "🔄 Stopping existing instances of THIS bot…"
kill_orphans_by_cwd
sleep 2

fuser -k "$PORT/tcp" 2>/dev/null
sleep 2
if fuser "$PORT/tcp" &>/dev/null; then
  fuser -k -9 "$PORT/tcp" 2>/dev/null
  sleep 2
fi
if fuser "$PORT/tcp" &>/dev/null; then
  echo "❌ Port $PORT still in use! Aborting."
  lsof -i ":$PORT"
  exit 1
fi

echo "🚀 Starting Uncle Carl (foreground mode, no systemd)…"
setsid "$BUN" run src/index.ts >> logs/bot.log 2>&1 < /dev/null &
BOT_PID=$!
disown 2>/dev/null
sleep 5

if kill -0 "$BOT_PID" 2>/dev/null; then
  echo "✅ Bot started (PID $BOT_PID)"
  echo "📊 Dashboard: http://localhost:$PORT"
  echo "📝 Logs: ./start.sh logs"
  echo "⚠️  No auto-restart in this mode. Run scripts/install-systemd.sh to enable it."
else
  echo "❌ Bot failed to start. Check logs/bot.log"
  tail -5 logs/bot.log
  exit 1
fi
