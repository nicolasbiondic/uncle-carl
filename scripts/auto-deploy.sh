#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# scripts/auto-deploy.sh — poll origin/master and deploy new commits to THIS
# host (port from DASHBOARD_PORT), gated by typecheck + tests.
#
# Run by the `uncle-carl-deploy.timer` systemd-user unit every ~2 min (install
# with scripts/install-auto-deploy.sh). There is NO webhook/exposed port — it
# polls, so nothing inbound is opened.
#
# Semantics: when commits land on origin/master from ANYWHERE (your laptop, CI,
# another machine), this host fast-forwards, runs the gate, and only restarts
# the live bot if the gate passes. Safe guards:
#   • skips if the working tree is dirty (never clobbers local/in-progress edits)
#   • fast-forward only (won't auto-resolve a diverged history)
#   • typecheck AND the test suite must pass BEFORE the bot is restarted; a bad
#     push is pulled but NOT deployed (the running bot keeps serving old code)
#   • a gate failure PAGES Telegram (once per SHA) and is RETRIED every poll —
#     data/.deployed-sha tracks what is actually running, so "pulled but never
#     deployed" can no longer sit silently for days (2026-07-30: prod ran
#     Jul-22 code for 8 days because bun moved to mise, the gate died with
#     "bun: command not found", and nothing paged or retried)
#   • the bot reloads state from the DB + reconciles with the broker on restart
#     (designed-safe), so the ~15s restart window only pauses SL/TP checks
#   • after restart, polls local /healthz (bounded ~30-60s, HEALTH_CHECK_*
#     env-overridable) before logging DEPLOYED; if it never confirms ok, the
#     script ROLLS BACK (git reset --hard + deps reinstall + re-restart to
#     the pre-pull SHA) and marks the bad SHA in data/.deploy-rejected-sha
#     so the next ~2min poll SKIPS re-deploying the same unhealthy commit —
#     it only retries once a NEW commit lands on origin/master
# ──────────────────────────────────────────────────────────────────────────
set -uo pipefail
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REJECTED_SHA_FILE="$REPO/data/.deploy-rejected-sha"
DEPLOYED_SHA_FILE="$REPO/data/.deployed-sha"
GATEFAIL_PAGED_FILE="$REPO/data/.deploy-gatefail-paged"
DIRTY_SINCE_FILE="$REPO/data/.deploy-dirty-since"
DIRTY_PAGED_FILE="$REPO/data/.deploy-dirty-paged"
FETCH_FAIL_SINCE_FILE="$REPO/data/.deploy-fetch-fail-since"
FETCH_FAIL_COUNT_FILE="$REPO/data/.deploy-fetch-fail-count"
FETCH_FAIL_PAGED_FILE="$REPO/data/.deploy-fetch-fail-paged"
# A dirty tree for a minute is an operator mid-edit; for an hour it is an
# outage of the deploy pipeline. Env-overridable for tests.
DIRTY_PAGE_AFTER_SEC="${DIRTY_PAGE_AFTER_SEC:-1800}"
# B-ops-alerts.md #9 (2026-09-24: 4× "git@github.com: Permission denied
# (publickey)" — every push since silently never deployed, nothing paged, 0
# exit). Page ops once N consecutive fetches fail OR the last successful
# fetch is this stale, whichever comes first (the timer's ~2min cadence
# makes 5 consecutive failures ≈10min — comfortably before the 30min age
# floor for an intermittent failure that never strings 5 in a row).
# Env-overridable for tests.
FETCH_FAIL_COUNT_THRESHOLD="${FETCH_FAIL_COUNT_THRESHOLD:-5}"
FETCH_FAIL_AGE_THRESHOLD_SEC="${FETCH_FAIL_AGE_THRESHOLD_SEC:-1800}"
# bun may live in ~/.bun/bin (curl installer) OR be mise-managed (shims).
# Prod migrated to mise on 2026-07-20 and only ~/.bun/bin was on PATH here —
# every gate failed "bun: command not found" for 8 days, silently.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
# Command seams, env-overridable for tests only — defaults reproduce today's
# exact behavior, so an operator running this unchanged notices nothing.
GATE_TYPECHECK_CMD="${GATE_TYPECHECK_CMD:-bun run typecheck}"
GATE_TEST_CMD="${GATE_TEST_CMD:-bun test}"
START_CMD="${START_CMD:-./start.sh}"
log() { echo "[$(date -u +%FT%TZ)] auto-deploy: $*"; }

# Best-effort Telegram page. Reads the two vars with grep — deliberately never
# imports the whole env file into this shell (40+ trading vars; a test pins
# that). Missing file/vars = silent no-op (test fixtures have none).
notify() {
  local token chat
  token=$(grep -oP '^TELEGRAM_BOT_TOKEN=\K.+' "$REPO/.env" 2>/dev/null | tail -1)
  # OPS chat only (2026-08-03 user mandate: the user chat is for trading
  # events, never for deploys). No fallback to TELEGRAM_CHAT_ID by design —
  # with TELEGRAM_OPS_CHAT_ID unset these events live in logs/deploy.log,
  # which is where the "DEPLOYED / GATE FAIL" stream belongs.
  chat=$(grep -oP '^TELEGRAM_OPS_CHAT_ID=\K.+' "$REPO/.env" 2>/dev/null | tail -1)
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  curl -fsS -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat}" -d "text=auto-deploy@$(hostname): $1" >/dev/null 2>&1 || true
}

# Page a gate failure once per failing SHA (the retry-every-2min loop below
# would otherwise page forever); cleared when the gate passes again.
page_gate_fail() { # $1 = gate name, $2 = sha/key
  local prev
  prev=$(cat "$GATEFAIL_PAGED_FILE" 2>/dev/null || true)
  if [ "$prev" != "$2" ]; then
    echo "$2" > "$GATEFAIL_PAGED_FILE" 2>/dev/null || true
    notify "🚨 GATE FAIL ($1) on ${2:0:12} — bot keeps running OLD code until this is fixed (retrying every poll). See /tmp/uc-deploy-${1}.log"
  fi
}

# Clamps an env-overridable integer knob into [min,max]; non-numeric/empty
# falls back to default. Guards against garbage/zero/huge overrides — in
# particular HEALTH_CHECK_TIMEOUT=0 would otherwise mean "no timeout" to
# curl's --max-time, i.e. disable the very thing it's supposed to bound.
_clamp_int() {
  local val="$1" min="$2" max="$3" default="$4" n
  if [[ "$val" =~ ^[0-9]+$ ]]; then
    val="${val#"${val%%[!0]*}"}"
    val="${val:-0}"
    if [ "${#val}" -gt "${#max}" ]; then
      n="$max"
    else
      n="$val"
    fi
  else
    n="$default"
  fi
  [ "$n" -lt "$min" ] && n="$min"
  [ "$n" -gt "$max" ] && n="$max"
  echo "$n"
}

# Parses the health body with Bun (already required by this script for
# typecheck/tests — no new dep) and requires a TOP-LEVEL status:"ok". A regex
# grep on the raw body would also match a nested {"foo":{"status":"ok"}};
# JSON.parse + a top-level property check doesn't, and malformed JSON is
# rejected by the catch.
_health_status_ok() {
  bun -e 'try{const j=JSON.parse(process.argv[1]);process.exit(j&&typeof j==="object"&&!Array.isArray(j)&&j.status==="ok"?0:1)}catch{process.exit(1)}' -- "$1" >/dev/null 2>&1
}

# Post-restart health gate: poll the PUBLIC local /healthz until it reports
# {"status":"ok"} over HTTP 200, or give up after a bounded timeout. Every
# knob is env-overridable (for tests / tuning) and clamped via _clamp_int;
# nothing here sources .env — defaults assume the standard local port. Total
# wall-clock is bounded to ATTEMPTS * (INTERVAL + TIMEOUT), ~60s worst case
# with defaults, capped at 30*(15+15)=900s even under a hostile override.
health_check() {
  local url="${HEALTH_URL:-http://127.0.0.1:${DASHBOARD_PORT:-3789}/healthz}"
  local attempts interval req_timeout
  # Default 20 attempts (~60s effective window). It was 10 (~27s when the
  # port refuses instantly), and prod's healthy boot takes ~30s — the
  # 2026-08-02 bdab38e deploy (zero src/ changes) was rolled back purely on
  # this margin, and the ROLLBACK boot itself only confirmed on attempt
  # 10/10. The window must comfortably contain a healthy boot.
  attempts=$(_clamp_int "${HEALTH_CHECK_ATTEMPTS:-20}" 1 30 20)
  interval=$(_clamp_int "${HEALTH_CHECK_INTERVAL:-3}" 0 15 3)
  req_timeout=$(_clamp_int "${HEALTH_CHECK_TIMEOUT:-3}" 1 15 3)
  local i body code
  for ((i = 1; i <= attempts; i++)); do
    body=$(curl -fsS --max-time "$req_timeout" -w '\n%{http_code}' "$url" 2>/dev/null)
    code="${body##*$'\n'}"
    body="${body%$'\n'*}"
    if [ "$code" = "200" ] && _health_status_ok "$body"; then
      log "health check OK (attempt $i/$attempts, $url)"
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then sleep "$interval"; fi
  done
  log "health check FAILED after $attempts attempts against $url (last http_code=${code:-none})"
  return 1
}

# Seam for tests: run only the health-poll logic, no repo/git/restart side
# effects. `bash scripts/auto-deploy.sh --health-check-only` exits 0/1.
if [ "${1:-}" = "--health-check-only" ]; then
  health_check
  exit $?
fi

cd "$REPO" || exit 1

# 0. The whole gate depends on bun; a missing bun must be LOUD, not a silent
# park (this exact failure ate 8 days of deploys — see header).
if ! command -v bun >/dev/null 2>&1; then
  log "CRITICAL: bun not found in PATH — cannot gate or deploy"
  page_gate_fail "bun-missing" "bun-missing-$(date +%F)"
  exit 1
fi

# 1. Never clobber uncommitted work. Refusing is correct — but refusing
# SILENTLY is not: on 2026-08-07 two stray `.env.bak-*` files blocked every
# deploy for ~2h and the only trace was this log line, which nobody polls.
# A dirty tree is normal for a minute and pathological for an hour, so page
# once it has persisted past a threshold (and again at most daily), and
# clear the marker as soon as the tree is clean again.
if [ -n "$(git status --porcelain)" ]; then
  now=$(date +%s)
  first=$(cat "$DIRTY_SINCE_FILE" 2>/dev/null || true)
  case "$first" in ''|*[!0-9]*) first="$now"; echo "$now" > "$DIRTY_SINCE_FILE" 2>/dev/null || true ;; esac
  stuck=$(( now - first ))
  log "working tree dirty — skipping (local changes present; dirty for ${stuck}s)"
  if [ "$stuck" -ge "$DIRTY_PAGE_AFTER_SEC" ]; then
    paged=$(cat "$DIRTY_PAGED_FILE" 2>/dev/null || echo 0)
    case "$paged" in ''|*[!0-9]*) paged=0 ;; esac
    if [ "$(( now - paged ))" -ge 86400 ]; then
      echo "$now" > "$DIRTY_PAGED_FILE" 2>/dev/null || true
      notify "🚨 DEPLOYS BLOCKED for $(( stuck / 60 ))min: working tree dirty on $(hostname). No push can reach this host until it is clean. $(git status --porcelain | head -5 | tr '\n' ' ')"
    fi
  fi
  exit 0
fi
rm -f "$DIRTY_SINCE_FILE" "$DIRTY_PAGED_FILE" 2>/dev/null || true

# 2. Is origin/master ahead?
if ! git fetch --quiet origin master; then
  log "git fetch failed — skip"
  now=$(date +%s)
  first=$(cat "$FETCH_FAIL_SINCE_FILE" 2>/dev/null || true)
  case "$first" in ''|*[!0-9]*) first="$now"; echo "$now" > "$FETCH_FAIL_SINCE_FILE" 2>/dev/null || true ;; esac
  count=$(cat "$FETCH_FAIL_COUNT_FILE" 2>/dev/null || true)
  case "$count" in ''|*[!0-9]*) count=0 ;; esac
  count=$((count + 1))
  echo "$count" > "$FETCH_FAIL_COUNT_FILE" 2>/dev/null || true
  stuck=$(( now - first ))
  if [ "$count" -ge "$FETCH_FAIL_COUNT_THRESHOLD" ] || [ "$stuck" -ge "$FETCH_FAIL_AGE_THRESHOLD_SEC" ]; then
    if [ ! -f "$FETCH_FAIL_PAGED_FILE" ]; then
      touch "$FETCH_FAIL_PAGED_FILE" 2>/dev/null || true
      notify "🚨 git fetch failing on $(hostname): ${count} consecutive failures over $(( stuck / 60 ))min — new pushes will NOT deploy here until this recovers (bot itself keeps running old code fine)."
    fi
  fi
  exit 0
fi
# Fetch succeeded — clear the failure streak, and if it had paged, tell ops
# it recovered (mirrors the dirty-tree page/clear pair above).
if [ -f "$FETCH_FAIL_PAGED_FILE" ]; then
  prevcount=$(cat "$FETCH_FAIL_COUNT_FILE" 2>/dev/null || echo '?')
  rm -f "$FETCH_FAIL_PAGED_FILE" 2>/dev/null || true
  notify "✅ git fetch recovered on $(hostname) after ${prevcount} consecutive failures"
fi
rm -f "$FETCH_FAIL_SINCE_FILE" "$FETCH_FAIL_COUNT_FILE" 2>/dev/null || true
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
if [ "$LOCAL" = "$REMOTE" ]; then
  # HEAD matches origin — but is HEAD what's actually RUNNING? A gate failure
  # pulls then parks, and before .deployed-sha existed a parked SHA sat here
  # ("nothing to do") until the next commit. Now: retry the gate every poll.
  DEPLOYED=$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null || true)
  if [ "$DEPLOYED" = "$LOCAL" ]; then exit 0; fi   # up to date AND deployed
  log "HEAD ${LOCAL:0:7} was pulled but never deployed (last deployed: ${DEPLOYED:-unknown}) — retrying gate"
  # If a health-fail forces a rollback below, the last deployed SHA is the
  # only meaningful target (LOCAL==REMOTE here, resetting to self is a no-op).
  [ -n "$DEPLOYED" ] && LOCAL="$DEPLOYED"
else
  # A prior run already rolled this exact SHA back as unhealthy — skip it
  # every cycle (else the 2min timer churns pull→gate→restart→rollback
  # forever on the same bad commit). Cleared once origin/master moves on.
  if [ -f "$REJECTED_SHA_FILE" ]; then
    rejected=$(cat "$REJECTED_SHA_FILE" 2>/dev/null || true)
    if [ "$rejected" = "$REMOTE" ]; then
      log "origin/master $REMOTE was rolled back earlier as unhealthy — skipping until a new commit lands"
      exit 0
    fi
    rm -f "$REJECTED_SHA_FILE"
  fi

  log "new commits ${LOCAL:0:7}..${REMOTE:0:7} — pulling"
  if ! git merge --ff-only origin/master >/dev/null 2>&1; then
    log "ff-only merge failed (history diverged) — manual intervention needed; NOT deploying"
    exit 1
  fi
fi

# 3. Refresh deps (lockfile-pinned; no-op when unchanged).
bun install --frozen-lockfile >/dev/null 2>&1 || log "bun install reported issues (continuing to gate)"

# 4. GATE — typecheck + tests must pass before touching the live bot.
if ! bash -c "$GATE_TYPECHECK_CMD" >/tmp/uc-deploy-typecheck.log 2>&1; then
  log "GATE FAIL: typecheck — NOT restarting (pulled code is parked; see /tmp/uc-deploy-typecheck.log)"
  page_gate_fail "typecheck" "$REMOTE"
  exit 1
fi
if ! bash -c "$GATE_TEST_CMD" >/tmp/uc-deploy-test.log 2>&1; then
  log "GATE FAIL: tests — NOT restarting (see /tmp/uc-deploy-test.log)"
  page_gate_fail "test" "$REMOTE"
  exit 1
fi
rm -f "$GATEFAIL_PAGED_FILE" 2>/dev/null || true

# 5. Deploy: restart via the canonical entrypoint (systemd-managed).
log "gate passed (typecheck+tests) — restarting uncle-carl"
# Mark this restart as planned so the bot suppresses its Telegram startup banner
# (only unexpected restarts — crash / host reboot — should ping the chat).
touch "$REPO/data/.deploy-restart" 2>/dev/null || true
if bash -c "$START_CMD" >/dev/null 2>&1; then
  log "restart issued — waiting for /healthz to confirm"
  if health_check; then
    log "DEPLOYED ${REMOTE:0:7}"
    echo "$REMOTE" > "$DEPLOYED_SHA_FILE" 2>/dev/null || true
    notify "✅ DEPLOYED ${REMOTE:0:7} and healthy"
  else
    log "GATE FAIL: health check — bot unhealthy after restart on ${REMOTE:0:7}; rolling back to ${LOCAL:0:7}"
    if ! git reset --hard "$LOCAL" >/dev/null 2>&1; then
      log "CRITICAL: rollback git reset failed — manual intervention required"
      echo "🚨 CRITICAL: rollback git reset to ${LOCAL:0:7} FAILED — manual intervention required" >&2
      notify "🚨 CRITICAL: rollback git reset to ${LOCAL:0:7} FAILED — manual intervention required"
      exit 1
    fi
    echo "$REMOTE" > "$REJECTED_SHA_FILE" 2>/dev/null || true
    # Deps must match the reverted code — the failed commit may have changed them.
    bun install --frozen-lockfile >/dev/null 2>&1 || log "rollback bun install reported issues"
    touch "$REPO/data/.deploy-restart" 2>/dev/null || true
    if bash -c "$START_CMD" >/dev/null 2>&1 && health_check; then
      log "rollback OK — reverted to ${LOCAL:0:7} and healthy"
      echo "$LOCAL" > "$DEPLOYED_SHA_FILE" 2>/dev/null || true
      echo "🚨 DEPLOY ROLLED BACK: bot unhealthy on ${REMOTE:0:7}, reverted to ${LOCAL:0:7} (now healthy)" >&2
      notify "🚨 DEPLOY ROLLED BACK: bot unhealthy on ${REMOTE:0:7}, reverted to ${LOCAL:0:7} (now healthy)"
    else
      log "CRITICAL: rollback restart/health FAILED — bot may be down at ${LOCAL:0:7}"
      echo "🚨 CRITICAL: rollback to ${LOCAL:0:7} did NOT come up healthy — manual intervention" >&2
      notify "🚨 CRITICAL: rollback to ${LOCAL:0:7} did NOT come up healthy — manual intervention"
    fi
    exit 1
  fi
else
  log "ERROR: $START_CMD restart failed after deploy"
  exit 1
fi
