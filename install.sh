#!/usr/bin/env bash
# install.sh — one-shot setup for a fresh clone of Uncle Carl Trading Bot.
#
# Usage:
#   ./install.sh              # interactive: asks before installing Bun
#   ./install.sh --yes        # non-interactive: auto-confirms installing Bun
#
# What it does, in order:
#   1. Checks for Bun on PATH; offers (or, with --yes, just runs) the
#      official install script if it's missing.
#   2. `bun install --frozen-lockfile`
#   3. Runs `bun run setup` if the repo defines that script (interactive
#      instance configuration: broker keys, dashboard port/URL, Telegram).
#   4. Offers to run scripts/install-systemd.sh (auto-restart on boot/crash).
#
# Safe to re-run — every step is idempotent or skips cleanly if already done.
set -euo pipefail

AUTO_YES=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

confirm() {
  # $1 = prompt. Returns 0 (yes) if AUTO_YES or the user answers y/Y.
  if [ "$AUTO_YES" = true ]; then
    return 0
  fi
  read -r -p "$1 [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

echo "== Uncle Carl Trading Bot — install =="

# ── 1. Bun ───────────────────────────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  echo "[1/4] Bun found: $(bun --version)"
else
  echo "[1/4] Bun not found on PATH."
  if confirm "Install Bun now via the official installer (https://bun.sh/install)?"; then
    curl -fsSL https://bun.sh/install | bash
    # The official installer adds ~/.bun/bin to shell rc files, but not to
    # THIS process's PATH — pick it up for the rest of this script.
    export PATH="$HOME/.bun/bin:$PATH"
    if ! command -v bun >/dev/null 2>&1; then
      echo "ERROR: Bun install finished but 'bun' still isn't on PATH." >&2
      echo "Open a new shell (or 'source ~/.bashrc') and re-run this script." >&2
      exit 1
    fi
    echo "      Installed: $(bun --version)"
  else
    echo "ERROR: Bun is required. Install it yourself (https://bun.sh) and re-run." >&2
    exit 1
  fi
fi

# ── 2. Dependencies ──────────────────────────────────────────────────────
echo "[2/4] bun install --frozen-lockfile"
bun install --frozen-lockfile

# ── 3. Instance setup ────────────────────────────────────────────────────
if bun run --silent setup --help >/dev/null 2>&1 || grep -q '"setup"' package.json 2>/dev/null; then
  echo "[3/4] Running 'bun run setup' (broker keys, dashboard port/URL, Telegram)…"
  bun run setup
else
  echo "[3/4] No 'setup' script defined yet — copy .env.example to .env and fill it in by hand:"
  echo "      cp .env.example .env"
fi

# ── 4. systemd (optional) ────────────────────────────────────────────────
if [ -f scripts/install-systemd.sh ]; then
  if confirm "[4/4] Install a systemd --user unit for auto-restart on boot/crash?"; then
    ./scripts/install-systemd.sh
  else
    echo "      Skipped. Run ./scripts/install-systemd.sh later, or use ./start.sh directly."
  fi
else
  echo "[4/4] scripts/install-systemd.sh not found — skipping."
fi

echo
echo "Done. Start the bot with:  ./start.sh"
echo "Or with Docker:            docker compose up -d   (after filling .env)"
