#!/usr/bin/env bash
#
# Install log rotation for this checkout. Idempotent — safe to re-run; it
# rewrites the config and leaves at most ONE cron entry.
#
# Mirrors install-systemd.sh / install-cron.sh: the repo owns the template,
# the installer materialises it for this host. Before 2026-08-14 the config
# lived only on prod, hand-written and unversioned.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONF_DIR="$HOME/.config/logrotate"
CONF="$CONF_DIR/trading-bot.conf"
STATUS="$CONF_DIR/status"
TEMPLATE="$ROOT_DIR/scripts/logrotate.conf"

[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 1; }
command -v logrotate >/dev/null 2>&1 || {
  echo "logrotate not installed (apt-get install logrotate)" >&2; exit 1; }

mkdir -p "$CONF_DIR" "$ROOT_DIR/logs"
sed "s|__ROOT__|$ROOT_DIR|g" "$TEMPLATE" > "$CONF"
echo "wrote $CONF"

# Validate before trusting it: --debug parses and dry-runs, changing nothing.
if ! logrotate --debug -s "$STATUS" "$CONF" >/dev/null 2>&1; then
  echo "config REJECTED by logrotate — not installing cron entry:" >&2
  logrotate --debug -s "$STATUS" "$CONF" >&2 || true
  exit 1
fi
echo "config validates (logrotate --debug)"

# Exactly one cron entry, whatever the previous state.
CRON_LINE="0 0 * * * /usr/sbin/logrotate -s $STATUS $CONF"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
crontab -l 2>/dev/null | grep -vF "$CONF" > "$TMP" || true
echo "$CRON_LINE" >> "$TMP"
crontab "$TMP"
echo "cron entry installed (daily 00:00):"
crontab -l | grep -F "$CONF" | sed 's/^/  /'

echo
echo "read logs with: ./scripts/logs.sh -l"
