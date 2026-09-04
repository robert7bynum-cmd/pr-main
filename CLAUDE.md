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

**Two implementations of one rule will drift. There is one of everything.**
The auth stub was copy-pasted into five files and broke every suite when the
seed changed. The keyword matcher existed in TypeScript and SQL and disagreed
silently. *If logic must run in two places, one is generated from the other or
a test asserts they agree.*

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
