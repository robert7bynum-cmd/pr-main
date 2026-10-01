# The agent contract

Prepended to every brief at dispatch. Written once, here, so it cannot drift
between briefs.

## Rules

1. **`CLAUDE.md` is law.** Read it before editing. Every line has a real
   failure behind it. Default deny then grant narrowly; views set
   `security_invoker`; every function revoked from `public, anon` and granted
   explicitly; worker functions are `service_role` only.
2. **Silence is never success.** Anything that can reach nobody raises rather
   than recording a success.
3. **Verify by running.** Paste failing output verbatim. A confident reading is
   not evidence. Anything unverified is reported as unverified, never implied
   as passing.
4. **One implementation of any rule.** If logic must exist twice, generate one
   from the other or add a test asserting they agree. Check the Debt Register
   in the plan before adding a second copy of anything.
5. **Stay inside your file list.** The brief names the files you own. Editing
   anything else creates a conflict with a track running right now. If the work
   genuinely requires a file you do not own, stop and report it.
6. **Your migration slot is the only one you may use.** Never reuse a slot,
   never edit an applied migration. New enum values need their own file: the
   runner wraps each file in a transaction and Postgres refuses to use a label
   in the transaction that created it.
7. **Commit early and often.** Not for history, for recovery. A session that
   dies having committed twice loses minutes. One that dies having committed
   nothing loses everything.
8. **Never push, apply a migration, deploy, or run the live suites.** Those are
   serial and belong to the integrator in the main checkout. Your settings will
   ask before any of them; the answer from a track is no.
9. **Run `npm run gate` before you finish.** Lint, types and 19 offline suites,
   about 47 seconds. A Stop hook blocks you from ending with source changes
   newer than the last passing gate.

## Token practice

- **Do not spawn a subagent for something you can do yourself.** Each one
  starts cold and rediscovers context you already hold.
- **Read what the brief names, not the repository.** The brief lists the files
  that matter. Exploring beyond them is how a session burns its budget before
  it writes anything.
- **Deterministic questions get scripts, not models.** "Which files changed",
  "does this grant exist", "is the view security_invoker" are grep and git.
- **Keep output short and structured.** Whoever reads your result pays for it.
- **Prefer editing to rewriting.** Rewriting a file you only need to change in
  two places costs the whole file twice.

## Finishing

Report back in this shape, briefly:

- **Built** — what exists now that did not before, in plain language.
- **Changed** — what a person using the app would notice.
- **Verified** — what you ran, and the result. Name anything you could not
  verify and why.
- **Unplanned** — anything found that the brief did not anticipate, including
  problems. Report these the same way as successes.
