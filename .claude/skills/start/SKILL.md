---
name: start
description: Bootstrap a ProResponse working session. Reads the board, the plan, the repo state and production, then reports where things stand before touching anything. Use at the beginning of every session, resumed or fresh, and whenever you are unsure what the current state is.
---

# Starting a session

Run this before any work. It exists so that a fresh session, a resumed one and
a parallel track all begin from the same picture, and so recovering a stalled
session is "open a new one and run /start" rather than archaeology.

Report findings and stop. Do not begin building until the person says which
session to run.

## 1. Where the code is

```bash
git fetch --quiet origin
git status --short --branch
git log --oneline -5
git worktree list
git branch --no-merged main
```

Flag: uncommitted work, a branch ahead of or behind origin, stray worktrees
(the fingerprint of an agent session that died mid-task).

## 2. Whether the build is honest

```bash
gh run list --branch main --limit 3
curl -s https://pr-main-dun.vercel.app/api/health
```

The deployed commit must match main's head. Code deploys automatically and
migrations are applied by hand, so this is exactly where the two silently
drift apart.

## 3. What production is doing

Use the Supabase tools to check: migrations applied, reports and orders in the
last seven days, anything stuck in triage, notifications stuck queued, open
system alerts, and staff with no browser subscription and no device token.
Unreachable staff are the failure this product cannot afford and no test
catches, because nothing is broken.

Also check for leftovers: probe profiles or throwaway clubs from a live suite
that died before its teardown.

## 4. What the plan says

- `~/.claude/plans/proresponse-build-plan.md` — milestones, sessions, who owns
  which files, which migration slot is claimed.
- `STATUS.md` — what is built, what is deliberately missing, what is waiting on
  Bobby.
- The Notion board, if the connector is available, for live task status.

## 5. Report, then wait

Give a short written picture:

- where the code is and whether anything is unmerged or undeployed
- whether production is healthy, and anything it is quietly failing at
- which session in the plan comes next, and what it owns
- anything found that is not in the plan

Then stop and let the person choose. Do not start a session's work off your own
judgement — parallel tracks depend on only one agent owning a file set at a
time.

## Rules that apply to the work that follows

Read `CLAUDE.md` first; it is a checklist with a failure behind every line.
Beyond that: run `npm run gate` before claiming anything is done, commit early
and often so a dead session loses minutes rather than hours, and never push,
apply a migration, or deploy from a parallel track — those belong to whoever is
integrating.
