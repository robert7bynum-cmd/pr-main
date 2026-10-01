#!/bin/bash
# Blocks a turn from ending while source changes sit unverified.
#
# Cheap by design: it compares timestamps, it never runs the suite itself.
# `npm run gate` stamps .claude/.last-gate on success, so this only has to ask
# whether anything changed after that stamp.
#
# Exit 0  = nothing to say.
# Exit 2  = blocked; stderr goes back to Claude as the reason.
cd "$CLAUDE_PROJECT_DIR" || exit 0

# Only source changes matter. Docs, plans and notes are not gated.
CHANGED=$(git status --porcelain -- '*.ts' '*.tsx' '*.sql' '*.mts' '*.js' 2>/dev/null | head -40)
[ -z "$CHANGED" ] && exit 0

STAMP=.claude/.last-gate
if [ ! -f "$STAMP" ]; then
  echo "Source files are modified and 'npm run gate' has not run in this repo yet. Run it (about 45s: lint, types, 19 offline suites) before finishing, or say explicitly why you are leaving the work unverified." >&2
  exit 2
fi

LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
NEWEST=0
while IFS= read -r line; do
  f="${line:3}"
  [ -f "$f" ] || continue
  m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  [ "$m" -gt "$NEWEST" ] && NEWEST=$m
done <<< "$CHANGED"

if [ "$NEWEST" -gt "$LAST" ]; then
  echo "These files changed after the last successful gate: $(echo "$CHANGED" | awk '{print $2}' | tr '\n' ' '). Run 'npm run gate' (about 45s) before finishing, or state plainly that the work is unverified and why." >&2
  exit 2
fi
exit 0
