# ProResponse — engineering rules

Standing rules for anyone (human or agent) working in this repo. They are
written against SOC 2's Trust Services Criteria, but each one exists because
something in this codebase actually failed that way. The bug that produced each
rule is named, because a rule without a failure behind it gets argued away.

**What this file is not:** SOC 2 compliance. That is an audit of organizational
controls — access reviews, vendor management, incident response, change
management evidence, monitoring, and a defined audit window. This file covers
the engineering half. The organizational half is listed at the bottom and is
not built.

---

## CC6 — Logical access

**Default deny, then grant narrowly. Grants and RLS are separate lines of
defence and both must hold.**
Supabase grants `anon` full CRUD on every table by default, and RLS was the only
thing stopping it. One table created without RLS would have been world-readable.
Anon now holds zero table privileges. *Any new table starts with RLS enabled in
the same migration that creates it, and no anon grant.*

**Views bypass RLS unless told not to.**
Every dashboard view was readable by an anonymous caller holding the publishable
key — which ships in the client bundle. A Postgres view runs as its owner
unless `security_invoker = on`. *Every new view sets it, and `npm run test:rls`
must list it.*

**A function that can only return nothing should not be callable.**
`claim_profile` and `me` answered 200 to anonymous callers. They returned no
data, but Postgres grants EXECUTE to PUBLIC by default. *Every new function is
revoked from `public, anon` and granted explicitly.*

**The worker's functions belong to the worker, and grants say so.**
That rule got applied to the member-facing surface and stopped there.
`route_report`, `claim_triage_batch`, `escalate_reports` and
`resolve_recipients` stayed executable by `authenticated` — so any staff member
with a session could reroute any report past the classifier, claim the pending
queue and never process it (stalling triage for the whole club while every
screen stayed green), or page leadership at will. None of the four had a single
call site in `app/`, `lib/` or `components/`. *A function whose only caller is
the service role is granted to `service_role` and revoked from everyone else,
and the grant is how a reader knows who the caller was meant to be.*

**Never let an error distinguish "wrong password" from "no such account".**
Failed sign-in returns one message. Signed-out and not-invited are
indistinguishable from outside, so nobody can enumerate a club's staff.

**Actions are attributed to an authenticated principal or they do not happen.**
Staff actions throw rather than falling back to a guessed actor. An
unattributed action corrupts the accountability data the product is sold on.

## CC7 — System operation and monitoring

**Silence is never a valid outcome.**
Routing that reaches nobody raises; it does not record a success. The triage
worker counted ten skipped reports as "routed". A queued notification with no
subscribed device is marked failed, never left queued. *If an operation can
no-op, it reports that distinctly from success.*

**Work is claimed with a lock that can be reclaimed.**
Ten queue items sat in `processing` forever because the sweeper only looked at
`pending` and nothing reclaimed a dead worker's lock. *Any claim sets a
timestamp, and stale claims are reclaimed. Reprocessing must be idempotent.*

**A scheduled job needs a dead-man's switch.**
Escalation and triage run on `pg_cron`. If cron itself stops, nothing currently
notices. **Not built — this is the largest open gap in operations.**

## CC8 — Change management

**Migrations are forward-only, tracked, and each runs in its own transaction.**
`schema_migrations` records what has run. A failure leaves nothing
half-applied.

**Every migration runs against a throwaway Postgres before it runs anywhere
else.** `npm run db:validate`. A migration that assumed Supabase extensions
existed took every local suite down without anyone noticing.

**Verify by running, not by reading.**
A subagent audited 800 lines of seed SQL column by column and declared it sound;
executing it revealed `random()` in uncorrelated subqueries had collapsed all
220 rows to one status, one hole, one date. A confident review is not evidence.
`db:validate` later passed a migration whose very first call failed on an
ambiguous column reference — validating the DDL proved only that it parsed.

**A test that proves a function returned the right value has not proved a
person can see it.**
The queue defaults to your own departments. The Pro Shop account belongs to a
department nothing routes to, so it showed "Nothing for your team right now"
no matter how many placards were scanned. Routing was flawless, the report was
in the database, every one of 117 tests passed, and the product was unusable —
the owner reasonably concluded it was broken. *An end-to-end test signs in as
the person who was actually notified and asserts the report is on their screen.
Asserting on the database is asserting on the wrong thing.*

**A change is not shipped until the deployment reports the commit containing
it.**
A realtime fix sat undeployed for two hours behind a build guard of my own
making, while the demo URL served older code and I described the work as
finished. Then a `*/5` cron in `vercel.json` — rejected outright by the Hobby
plan — silently took down a whole push. *Announcing a fix requires reading the
deployed commit back and seeing the change live, not watching a build go
green.*

**Two implementations of one rule will drift. There is one of everything.**
The auth stub was copy-pasted into five files and broke every suite when the
seed changed. The keyword matcher existed in TypeScript and SQL and disagreed
silently. *If logic must run in two places, one is generated from the other or
a test asserts they agree.*

**Every push runs lint, the type check, and the offline suite in CI, and a red
CI blocks merging.**
`.github/workflows/ci.yml` runs `npm run lint`, `npx tsc --noEmit` and
`npm run verify:offline` (which now includes `db:validate` and `db:check`) on
every push and pull request, with no secrets. Before it existed, `main` carried
a lint error, and `test:grants` passed on every run while proving nothing — the
local bootstrap granted no privileges, so the revokes it asserts had nothing to
revoke. Both shipped because nothing ran them anywhere but a developer's
terminal, and only when someone remembered. *A suite that runs on request runs
when it is convenient, which is never when it would have failed.*

## CC9 / Confidentiality

**Internal notes and member-facing text are separate columns, always.**
Staff write candidly. `resolution_note` never reaches a member.

**Secrets live in `.env.local` or `app_settings` (service-role only), never in
`NEXT_PUBLIC_*`, never committed.**
A secret key was briefly pasted onto the `NEXT_PUBLIC_SUPABASE_ANON_KEY` line —
that would have shipped full database access to every visitor.

**Do not print secrets to a transcript or log.** Check by length and prefix.

## Processing integrity

**Every metric derives from `report_events`, never from a mutable column.**
A number on a GM's screen must be traceable to the event that produced it.

**Two response clocks, never conflated.** `created → resolved` is the member's
experience; `notified → acknowledged` is what a person is accountable for.
Charging someone for routing delay is how staff stop trusting the data.

**The model classifies; data routes.** `routing_rules` decides who is paged, so
changing models cannot reroute anyone.

---

## Not built — the organizational half

None of the following exists yet, and SOC 2 requires all of it:

- Access reviews and offboarding evidence (deactivation works; nothing records it)
- Audit logging of admin actions (staff actions are logged; configuration changes are not)
- Incident response process and on-call
- Vendor/subprocessor register (Supabase, Anthropic, Vercel, Twilio)
- Backup restoration testing (PITR is available and untested)
- Data retention enforcement (policy designed, job not written)
- Alerting on the monitoring gaps named under CC7

Do not describe this system as SOC 2 compliant. It is, at best, being built so
that compliance is achievable later without rework.
