#!/usr/bin/env bash
# Vendors the TradingView Lightweight Charts™ standalone ESM build into
# src/dashboard/public/v4/vendor/lightweight-charts/ so the dashboard can
# serve it same-origin (CSP is script-src 'self' — no CDN). Reproducible:
# pulls the pinned version straight from the published npm tarball, no
# hand-editing. Re-run after bumping VERSION; the checksum test
# (vendor-lightweight-charts.test.ts) will fail loudly if the copied file
# ever drifts from what this script produces.
set -euo pipefail

VERSION="5.2.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/src/dashboard/public/v4/vendor/lightweight-charts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching lightweight-charts@${VERSION} from npm registry..."
(cd "$TMP" && npm pack "lightweight-charts@${VERSION}" --silent >/dev/null)
tar xzf "$TMP/lightweight-charts-${VERSION}.tgz" -C "$TMP"

mkdir -p "$DEST"

# Standalone production ESM build: no external deps, exports createChart /
# CandlestickSeries / BaselineSeries / etc. directly — the one we `import()`
# lazily from the browser (see equity.js / candle.js chartLib()).
cp "$TMP/package/dist/lightweight-charts.standalone.production.mjs" "$DEST/lightweight-charts.standalone.production.mjs"
cp "$TMP/package/LICENSE" "$DEST/LICENSE"

# The npm tarball doesn't ship NOTICE (only LICENSE/README/dist/package.json)
# — copied verbatim from the project's GitHub repo at the matching tag:
# https://raw.githubusercontent.com/tradingview/lightweight-charts/v5.2.1/NOTICE
# (the "с" in "(с)" below is Cyrillic in the upstream file itself, kept
# byte-for-byte rather than "corrected").
cat > "$DEST/NOTICE" <<'EOF'
TradingView Lightweight Charts™
Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
EOF

printf '%s\n' "$VERSION" > "$DEST/VERSION"

echo "Vendored lightweight-charts ${VERSION} -> ${DEST}"
sha256sum "$DEST/lightweight-charts.standalone.production.mjs"
