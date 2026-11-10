#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Instala + habilita la unidad systemd-user del laboratorio de memecoins
# (patrón de scripts/install-systemd.sh). Idempotente. NO toca uncle-carl.
# ══════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_SRC="$SCRIPT_DIR/memecoin-lab.service"
UNIT_DEST_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$UNIT_DEST_DIR/memecoin-lab.service"

if [ ! -f "$UNIT_SRC" ]; then
  echo "❌ unit source not found at $UNIT_SRC" >&2
  exit 1
fi

mkdir -p "$UNIT_DEST_DIR" "$ROOT_DIR/logs" "$ROOT_DIR/data"

# Resolver bun (PATH, shim de mise o ~/.bun/bin), igual que install-systemd.sh.
BUN="${BUN:-$(command -v bun || true)}"
if [ -z "$BUN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN="$HOME/.local/share/mise/shims/bun"; fi
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  echo "❌ bun not found (tried \$BUN, PATH, mise shim, ~/.bun/bin). Install bun or set BUN=/path/to/bun." >&2
  exit 1
fi
echo "ℹ️  Using bun: $BUN"

sed -e "s#__BUN__#$BUN#g" -e "s#__ROOT__#$ROOT_DIR#g" "$UNIT_SRC" > "$UNIT_DEST"

systemctl --user daemon-reload
systemctl --user enable memecoin-lab.service
systemctl --user restart memecoin-lab.service

sleep 3
echo
echo "── status ────────────────────────────────"
systemctl --user --no-pager status memecoin-lab.service | head -15
echo
echo "── useful commands ────────────────────────"
echo "  systemctl --user status memecoin-lab"
echo "  systemctl --user stop memecoin-lab      # (la unidad del bot no se toca)"
echo "  tail -f $ROOT_DIR/logs/memecoin-lab.log"
echo "  cat $ROOT_DIR/data/memecoin-lab.heartbeat"
echo "  bun labs/memecoin/report.ts --hours 24"
