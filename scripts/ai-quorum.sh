#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Cron wrapper for the línea-D shadow AI quorum (scripts/ai-quorum.ts).
# Usage: ai-quorum.sh <stocks|crypto|fill|status>
#
# Scheduled by install-cron.sh in HOST-LOCAL time (shown for a UTC−5 host
# without DST):
#   16:15 Mon–Fri → 21:15 UTC — stocks, after the US close;
#   19:15 daily   → 00:15 UTC — crypto, after the UTC day roll.
# Each run also executes the lazy fill pass first, so decisions get priced
# as soon as the 04:00 historical refresh has pulled the needed daily bars.
# Shadow-only: no capital, writes data/ai-quorum.db, never trading.db.
# ══════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Resolve bun the same robust way refresh-historical.sh/backup-db.sh do.
if [ -z "${BUN_BIN:-}" ]; then
  BUN_BIN="$(command -v bun || true)"
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN_BIN="$HOME/.local/share/mise/shims/bun"; fi
  if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN_BIN="$HOME/.bun/bin/bun"; fi
fi
if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo "❌ bun not found (tried \$BUN_BIN, PATH, mise shim, ~/.bun/bin) — set BUN_BIN env var to override" >&2
  exit 1
fi

exec "$BUN_BIN" run scripts/ai-quorum.ts "${1:-}"
