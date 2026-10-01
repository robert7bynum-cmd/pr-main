#!/bin/bash
# Create an isolated working copy for a parallel build track.
#
# Two Claude sessions in one folder fight over the same working tree, the same
# branch and the same .next build. A git worktree gives each its own directory
# and branch while sharing one object store, so merging stays trivial.
#
#   ./scripts/new-track.sh N   # native track
#   ./scripts/new-track.sh B   # backend/web track
#   ./scripts/new-track.sh Q   # quality track
#
# node_modules is 745MB, so it is symlinked rather than installed again.
# .env.local is symlinked too: one copy of the secrets, never duplicated.
set -euo pipefail

TRACK="${1:-}"
if [ -z "$TRACK" ]; then
  echo "usage: ./scripts/new-track.sh <track-name>   e.g. N, B, Q" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.claude/worktrees/track-$TRACK"
BRANCH="track-$TRACK"

cd "$ROOT"

if [ -d "$DIR" ]; then
  echo "Track $TRACK already exists at $DIR"
else
  git fetch --quiet origin || true
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git worktree add "$DIR" "$BRANCH"
  else
    git worktree add -b "$BRANCH" "$DIR" main
  fi
fi

# Shared, not copied.
[ -e "$DIR/node_modules" ] || ln -s "$ROOT/node_modules" "$DIR/node_modules"
[ -e "$DIR/.env.local" ] || { [ -f "$ROOT/.env.local" ] && ln -s "$ROOT/.env.local" "$DIR/.env.local"; }

echo
echo "Track $TRACK ready."
echo "  folder : $DIR"
echo "  branch : $BRANCH"
echo
echo "Open a Claude session there, then run /start, then /brief <session-id>."
echo "Never push, apply a migration, or deploy from a track — that is the"
echo "integrator's job in the main checkout."
