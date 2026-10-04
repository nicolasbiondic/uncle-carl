#!/usr/bin/env bash
#
# Uncle Carl — the ONE way to read logs.
#
# Why this exists: `logs/` holds five independent streams (bot, watchdog,
# deploy, backup, refresh-historical), each with its own rotated archives.
# Reading them by hand is a trap, and it sprung on 2026-08-14: logrotate's
# legacy names run bot.log.1.gz … bot.log.7.gz with `.1` the NEWEST, while
# shell globs expand NUMERICALLY. So
#     (zcat logs/bot.log.*.gz; cat logs/bot.log) | grep '[Telegram]' | tail
# ends on the OLDEST archive and presents week-old lines as the latest ones.
# That produced a confident, wrong "Telegram has been silent for 6 days"
# (it had delivered every day).
#
# The fix here is to never trust file NAMES for ordering: `ls -tr` sorts by
# mtime, which is correct for the legacy .N.gz names AND the dated ones that
# scripts/logrotate.conf now produces. One entry point, one ordering rule.
#
# Usage:
#   ./scripts/logs.sh                      last 200 lines of the bot log
#   ./scripts/logs.sh -n 50                last 50
#   ./scripts/logs.sh -g ERROR             only matching lines (case-insensitive)
#   ./scripts/logs.sh -s all -g Telegram   every stream, merged, source-tagged
#   ./scripts/logs.sh -s watchdog          one specific stream
#   ./scripts/logs.sh -a                   whole history, not just the tail
#   ./scripts/logs.sh -f                   follow the live bot log
#   ./scripts/logs.sh -l                   list streams and their archives
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"

STREAM="bot"
LINES=200
PATTERN=""
FOLLOW=0
ALL_HISTORY=0
LIST=0

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while getopts ":s:n:g:fahl" opt; do
  case "$opt" in
    s) STREAM="$OPTARG" ;;
    n) LINES="$OPTARG" ;;
    g) PATTERN="$OPTARG" ;;
    f) FOLLOW=1 ;;
    a) ALL_HISTORY=1 ;;
    l) LIST=1 ;;
    h) usage ;;
    \?) echo "unknown flag -$OPTARG (use -h)" >&2; exit 2 ;;
    :)  echo "-$OPTARG needs a value" >&2; exit 2 ;;
  esac
done

if [ ! -d "$LOG_DIR" ]; then
  echo "no logs/ directory at $LOG_DIR" >&2
  exit 1
fi

# Every stream = the distinct <name>.log basenames actually present.
streams() {
  find "$LOG_DIR" -maxdepth 1 -name '*.log' -printf '%f\n' 2>/dev/null \
    | sed 's/\.log$//' | sort
}

# Files of one stream, OLDEST → NEWEST by mtime. Never by name: that is the
# bug this script exists to prevent.
files_for() {
  ls -tr "$LOG_DIR/$1.log" "$LOG_DIR/$1.log."* "$LOG_DIR/$1.log-"* 2>/dev/null
}

# Concatenate a stream in chronological order, transparently un-gzipping.
emit_stream() {
  local f
  while IFS= read -r f; do
    [ -s "$f" ] || continue
    case "$f" in
      *.gz) zcat -- "$f" 2>/dev/null ;;
      *)    cat -- "$f" 2>/dev/null ;;
    esac
  done < <(files_for "$1")
}

if [ "$LIST" -eq 1 ]; then
  printf '%-22s %8s  %s\n' "STREAM" "ARCHIVES" "OLDEST → NEWEST (by mtime)"
  while IFS= read -r s; do
    mapfile -t fs < <(files_for "$s")
    printf '%-22s %8s  %s\n' "$s" "${#fs[@]}" \
      "$(basename "${fs[0]:-—}") … $(basename "${fs[-1]:-—}")"
  done < <(streams)
  echo
  echo "total: $(du -sh "$LOG_DIR" | cut -f1)"
  exit 0
fi

if [ "$FOLLOW" -eq 1 ]; then
  # Follow only makes sense on the live file of a single stream.
  [ "$STREAM" = "all" ] && { echo "-f needs a single stream, not 'all'" >&2; exit 2; }
  if [ -n "$PATTERN" ]; then
    exec tail -f "$LOG_DIR/$STREAM.log" | grep --line-buffered -iE "$PATTERN"
  fi
  exec tail -f "$LOG_DIR/$STREAM.log"
fi

collect() {
  if [ "$STREAM" = "all" ]; then
    # Tag each line with its stream, then sort. Bot lines start with
    # "[YYYY-MM-DD HH:MM:SS]"; cron streams (backup, deploy) may not, so the
    # sort key is the leading bracketed timestamp when present. Untimestamped
    # lines keep their stream grouping instead of being scattered.
    while IFS= read -r s; do
      emit_stream "$s" | sed "s/^/[$s] /"
    done < <(streams) | sort -s -t'[' -k3,3
  else
    emit_stream "$STREAM"
  fi
}

# Stream through a temp file rather than a $(…) variable: a crashed write can
# leave NUL bytes in a log, and command substitution drops them with a
# "ignored null byte in input" warning on stderr. A diagnostic tool that
# prints warnings while diagnosing is a tool people stop trusting. `tr -d`
# strips them once, quietly, for every downstream stage.
OUT_TMP="$(mktemp)"
trap 'rm -f "$OUT_TMP"' EXIT
collect | tr -d '\0' > "$OUT_TMP"

if [ ! -s "$OUT_TMP" ]; then
  echo "no lines for stream '$STREAM' (see: $0 -l)" >&2
  exit 1
fi

if [ -n "$PATTERN" ]; then
  if ! grep -iE "$PATTERN" "$OUT_TMP" > "$OUT_TMP.f"; then
    echo "no lines matching '$PATTERN' in stream '$STREAM'" >&2
    rm -f "$OUT_TMP.f"
    exit 1
  fi
  mv "$OUT_TMP.f" "$OUT_TMP"
fi

if [ "$ALL_HISTORY" -eq 1 ]; then
  cat "$OUT_TMP"
else
  tail -n "$LINES" "$OUT_TMP"
fi
