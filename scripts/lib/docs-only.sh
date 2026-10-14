# scripts/lib/docs-only.sh — "this change only touches documentation".
# Sourced by auto-deploy.sh and check-committed.sh; scripts/lib/docsOnly.ts is
# the TypeScript mirror (verify-deploy.ts), kept identical by docsOnly.test.ts.
#
# Documentation = any *.md file or anything under docs/. Nothing the bot runs
# reads those paths (2026-10-11: no runtime read of docs/ or *.md in src/), so
# a docs-only commit leaves the running code byte-identical and needs no
# restart. An EMPTY diff is not docs-only: the conservative answer is deploy.
DOCS_ONLY_RE='(\.md$|^docs/)'

# $1 = from sha, $2 = to sha (run inside the repo). 0 when at least one path
# changed and every changed path is documentation; 1 otherwise, including when
# git cannot diff the range (unknown sha → deploy normally).
docs_only_range() {
  local paths
  paths=$(git diff --name-only "$1" "$2" 2>/dev/null) || return 1
  [ -n "$paths" ] || return 1
  ! printf '%s\n' "$paths" | grep -qvE "$DOCS_ONLY_RE"
}
