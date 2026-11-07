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
# stocks/crypto runs report to the dead-man's switch as ai-quorum-<mode>
# (scripts/lib/cron-job.sh, audit F-2): a cycle whose result is
# status "failed" (no model answered — 2026-11-06, proxy unreachable for a
# day with no page) exits 3 and pages OPS once per episode.
# ══════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MODE="${1:-}"
if [ "$MODE" = stocks ] || [ "$MODE" = crypto ]; then
  # shellcheck source=lib/cron-job.sh
  source "$ROOT_DIR/scripts/lib/cron-job.sh"
  cron_job_start "ai-quorum-$MODE"
fi

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

if [ "$MODE" != stocks ] && [ "$MODE" != crypto ]; then
  exec "$BUN_BIN" run scripts/ai-quorum.ts "$MODE"   # manual fill/status: no marker
fi

OUT="$(mktemp "${TMPDIR:-/tmp}/uc-aiq.XXXXXX")"
rc=0
"$BUN_BIN" run scripts/ai-quorum.ts "$MODE" 2>&1 | tee "$OUT" || rc=${PIPESTATUS[0]}
if [ "$rc" = 0 ] && grep -q 'done: {"status":"failed"' "$OUT"; then
  echo "[ai-quorum] cycle status=failed — no model answered" >&2
  rc=3
fi
rm -f "$OUT"
exit "$rc"
