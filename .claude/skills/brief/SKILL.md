---
name: brief
description: Load a session brief from the build plan and start that session's work, or hand it to a subagent. Use when beginning a planned session (N1, B1, B2, Q1 and so on), or when the person names a session id. Assembles the shared agent contract with the specific brief so neither can drift.
---

# Running a session from its brief

Takes a session id — `N1`, `B1`, `B2`, `Q1` — and runs that session properly.

## 1. Assemble the brief

```bash
cat .claude/briefs/_contract.md .claude/briefs/<ID>.md
```

Both halves, always. `_contract.md` holds the rules and the token practice and
exists in exactly one copy; the session file holds the specific work. Never
restate the contract inline — that is how two copies start disagreeing.

If the named brief does not exist, say so and offer to write it from
`~/.claude/plans/proresponse-build-plan.md`, which has the goal, file
ownership, migration slot and exit criteria for every session.

## 2. Check you are in the right place

```bash
git worktree list
git status --short --branch
```

A track session runs in its own worktree — `.claude/worktrees/track-N` and so
on — created by `./scripts/new-track.sh <track>`. Two sessions in one folder
fight over the same branch and build directory.

If you are in the main checkout and the brief names a track, stop and say so.
The main checkout belongs to whoever is integrating.

## 3. Work it

Follow the brief. Hold to its file list — that list is the only thing keeping
a parallel track from colliding with you. Commit as you go.

## 4. Hand work to a subagent only when it pays

Spawn one when a piece is genuinely separable and large enough that a cold
start is worth it. Otherwise do it yourself, because each subagent
rediscovers context you already hold.

When you do spawn one, give it the assembled contract plus a scoped slice of
the brief, name the exact files it owns, and ask for short structured output.
Match the model to the work: a mechanical check does not need the expensive
model, an architecture judgement does. Never give a subagent permission to
push, deploy or touch the database.

## 5. Finish

Run `npm run gate`. The Stop hook will block you if source files are newer
than the last passing gate.

Report in the shape the contract names: built, changed, verified, unplanned.
Then stop. Do not start the next session — the sequence has hard stops in it,
and whoever is integrating decides what runs next.
