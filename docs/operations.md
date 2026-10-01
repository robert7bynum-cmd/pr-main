# Operations log

Every action taken against production that leaves no commit behind. Code is
already trailed by git; this is for the rest, so the record lives in one place
a person can read instead of scattered across Supabase, Vercel and GitHub.

`CLAUDE.md` names this gap under the organizational half it does not yet have:
"Audit logging of admin actions (staff actions are logged; configuration
changes are not)." This file is the engineering half of closing it.

## What goes in here

- A migration applied to production (`npm run db:apply`)
- An edge function deployed
- Any account setting changed in Vercel or Supabase
- A club created for a real customer
- A live suite run that created or deleted production records
- Anything manual done to production data

## What does not

Code, migrations as files, tests, docs and plans. Git already has those.

## Rules

One line per action, newest last. Date, who, what, and the evidence that it
worked — a commit, a version number, a probe result. Never a secret: record
that a value was set, never the value.

Only whoever is integrating performs these, because tracks are forbidden from
pushing, deploying or touching the database. So there is one author and no
coordination problem.

---

## 2026

**2026-09-05 — Bobby/Claude.** Supabase project `nfyshykwwtiwkluwiuyf` in use as
dev, staging and production simultaneously. Recorded here because it is the
standing risk behind every line below: there is no rehearsal environment.

**2026-09-06 — Claude.** Secrets moved out of the plaintext `app_settings`
table into Supabase Vault behind `service_role_secret()` and `anthropic_key()`.
Values never passed through a script or a transcript.

**2026-09-17 — Claude.** Migrations `20260917100000` and `20260917110000`
applied to production (ordering vocabulary, then food ordering). Edge function
unchanged. Verified: 60 migrations recorded, `submit_order` present, enums
carry `declared` and `cannot_fulfil`.

**2026-09-20 — a member.** First real order placed through a placard at Beacon
Hill: two items, member number attached, routed to Food & Beverage,
acknowledged and delivered. No intervention. Noted because it is the first
evidence the ordering path works unattended.

**2026-09-30 — Bobby.** `CRON_SECRET` set in Vercel Production and redeployed.
Verified by probe: `/api/watchdog` moved from 503 to 401, so the route now
finds a secret and checks callers against it. The value itself was generated
locally and never entered a transcript.

**2026-10-01 — Claude.** Branch protection enabled on `main`: the `verify` check
must pass, branches must be current, force pushes and deletions refused, and
administrators are included. Verified by attempting a direct push to main and
having it rejected. Main now takes changes only through a pull request.

**2026-10-01 — Claude.** Second Supabase project created: `proresponse-staging`
(`sywwnifudqfupyshufuy`, us-east-1, same region as production so behaviour is
comparable). $0/month on the free tier. **Empty — not yet usable.** Three steps
remain and the first needs a person: take the database password from the
Supabase dashboard into `.env.local` as `STAGING_DB_URL`, run the migrations
against it, then point Vercel's Preview environment at it. Until that last
step, every preview deployment still reads and writes production's rows.
Free-tier projects pause after about a week idle.

**2026-10-01 — Claude.** Staging populated. All 60 migrations applied to
`proresponse-staging` via `npm run staging:migrate`. Verified with
`npm run staging:diff`: tables 25/25, views 7/7, policies 19/19, enum labels
73/73, columns 275/275 identical to production. One function differs —
production's `rls_auto_enable()`, a Supabase platform event trigger that is in
no migration; documented in docs/deploying.md as expected. Still to do:
Vercel's Preview environment must be pointed at staging before previews stop
writing production's rows.

**2026-10-01 — Claude.** A staging database password was echoed into a session
transcript by an earlier version of `scripts/staging.sh`, which sourced
`.env.local` rather than parsing it; a line that was not a `KEY=value`
assignment ran as a command and printed part of itself. The password was
reset and the script rewritten as `scripts/staging.mts`, which parses and
executes nothing. No production credential was involved.

**2026-10-01 — Claude.** Migration `20261002100000` applied to **staging** and
exercised there: `create_club` produced 25 locations, 18 holes, 25 live
placards, 7 departments, 10 routing rules with `f_and_b` requiring a member
number, and one pending owner. A member then filed a report by scanning one of
those placards, with no manual setup. A sample club `staging-test` is left in
place on staging deliberately. **Not applied to production** — that is a hard
stop in the plan and Bobby's call.

