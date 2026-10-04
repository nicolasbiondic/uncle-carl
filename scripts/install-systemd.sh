#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Install + enable the systemd-user unit for Uncle Carl.
# Run once. Re-running is idempotent.
# ══════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_SRC="$SCRIPT_DIR/uncle-carl.service"
UNIT_DEST_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$UNIT_DEST_DIR/uncle-carl.service"

if [ ! -f "$UNIT_SRC" ]; then
  echo "❌ unit source not found at $UNIT_SRC" >&2
  exit 1
fi

mkdir -p "$UNIT_DEST_DIR"

# Resolve bun robustly (PATH, mise shim, or ~/.bun/bin). The old unit hardcoded
# a fixed ~/.bun/bin/bun path, which broke with a 203/EXEC when bun moved to mise.
BUN="${BUN:-$(command -v bun || true)}"
if [ -z "$BUN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN="$HOME/.local/share/mise/shims/bun"; fi
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  echo "❌ bun not found (tried \$BUN, PATH, mise shim, ~/.bun/bin). Install bun or set BUN=/path/to/bun." >&2
  exit 1
fi
echo "ℹ️  Using bun: $BUN"

# Render the unit template (__BUN__ / __ROOT__) for THIS machine.
sed -e "s#__BUN__#$BUN#g" -e "s#__ROOT__#$ROOT_DIR#g" "$UNIT_SRC" > "$UNIT_DEST"

systemctl --user daemon-reload

# Enable lingering so the bot keeps running after the user logs out / SSH disconnects.
# This requires sudo; if it fails the bot still works while the user is logged in.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  echo "ℹ️  Enabling user-linger so the bot survives logout (requires sudo)…"
  if sudo loginctl enable-linger "$USER" 2>/dev/null; then
    echo "✅ Linger enabled."
  else
    echo "⚠️  Could not enable linger — the bot will still run while you are logged in."
    echo "   Run manually: sudo loginctl enable-linger $USER"
  fi
fi

# Stop any process started by start.sh before enabling — avoids double-bind on 3789.
echo "ℹ️  Stopping any existing bot process before handoff to systemd…"
for pid in $(pgrep -f 'bun.*src/index' || true); do
  if [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$ROOT_DIR" ]; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
done
sleep 2

systemctl --user enable uncle-carl.service
systemctl --user restart uncle-carl.service

sleep 3
echo
echo "── status ────────────────────────────────"
systemctl --user --no-pager status uncle-carl.service | head -20
echo
echo "── useful commands ────────────────────────"
echo "  systemctl --user status uncle-carl"
echo "  systemctl --user restart uncle-carl"
echo "  systemctl --user stop uncle-carl"
echo "  journalctl --user -u uncle-carl -f"
echo "  tail -f $ROOT_DIR/logs/bot.log"
