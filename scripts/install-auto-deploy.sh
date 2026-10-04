#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# scripts/install-auto-deploy.sh — idempotent installer for the poll-based
# auto-deploy (uncle-carl-deploy.service + .timer). Re-running is safe.
#
# After install, every ~2 min this host fast-forwards origin/master, and if
# typecheck + the test suite pass, restarts the bot. See scripts/auto-deploy.sh
# for the safety guards.
#
#   ./scripts/install-auto-deploy.sh            # install + enable + start
#   ./scripts/install-auto-deploy.sh --uninstall
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UNIT_DIR="$HOME/.config/systemd/user"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now uncle-carl-deploy.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/uncle-carl-deploy.timer" "$UNIT_DIR/uncle-carl-deploy.service"
  systemctl --user daemon-reload
  echo "✅ auto-deploy uninstalled."
  exit 0
fi

chmod +x "$REPO/scripts/auto-deploy.sh"
mkdir -p "$UNIT_DIR"
sed "s#__REPO__#$REPO#g" "$REPO/scripts/uncle-carl-deploy.service" > "$UNIT_DIR/uncle-carl-deploy.service"
cp "$REPO/scripts/uncle-carl-deploy.timer" "$UNIT_DIR/uncle-carl-deploy.timer"
systemctl --user daemon-reload
systemctl --user enable --now uncle-carl-deploy.timer

echo "✅ auto-deploy installed + enabled (polls origin/master every ~2 min)."
echo "   Status:  systemctl --user list-timers uncle-carl-deploy.timer"
echo "   Logs:    tail -f $REPO/logs/deploy.log"
echo "   Run now: systemctl --user start uncle-carl-deploy.service"
echo "   Disable: ./scripts/install-auto-deploy.sh --uninstall"
