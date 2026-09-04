# Changes since the MVP push began (4 Sep 2026)

Running notes toward MVP. Newest first. Bugs I found in my own work are marked
**[bug]** — those are the ones worth reading.

## In progress

### The queue could lose work **[bug x3]**
Asking "is triage actually running?" exposed three defects in the one component
whose entire purpose is that work cannot be silently dropped:

- **Orphaned locks.** `claim_triage_batch` marked items `processing`, and the
  sweeper only looked at `pending`. Anything claimed by a worker that then crashed
  sat there forever — ten items already had. Stale locks older than five minutes
  are now reclaimed, which is safe because routing is idempotent.
- **Infinite loop.** A report already handled came back as `already_triaged` and
  the item was never marked done, so the new reclaim picked it up every five
  minutes forever. Work that is genuinely finished now says so.
- **Seed stranded reports.** Every seeded queue row was marked `done`, including
  for reports left in `new` — permanently unroutable, a card with no department
  that nobody would ever be told about.

Two regression tests: a stale lock is reclaimed, a fresh one is left alone.
Routing suite is 20.

**Answering the original question:** triage is *not* running automatically yet.
The cron job is scheduled and fires every minute, but it is deliberately gated on
`app_settings.worker_url`, which cannot be set until there is a deployed URL.
Escalation runs now because it is pure SQL and needs no app.

### Escalation — it did not exist **[gap]**
Reports never climbed to anyone; the SLA columns were decorative. Now pure SQL,
scheduled inside the database so it keeps working even if the web app is down:
- Level 1 when nothing is acknowledged inside the SLA → supervisors and management
- Level 2 when still unresolved past the resolve SLA → management
- Idempotent per level, so a minutely cron does not re-page anyone
- Quiet hours suppress it entirely, in the club's own timezone
- 8 tests (`npm run test:escalation`)

### Nothing was invoking triage **[gap]**
The worker endpoint existed and nothing called it. Deployed as-is, a filed report
would have sat in `new` forever — the exact silent failure the queue design exists
to prevent. `pg_cron` now runs escalation directly and POSTs the triage sweeper
every minute, gated on there actually being pending work.

**Verified operationally, not just in tests**: watched cron escalate two overdue
reports on the real database with no manual invocation — 6 leadership notified at
level 1, 3 managers at level 2, events written, 4 successful cron runs.

### Duplicate React key on the dashboard **[bug]**
- The team table was keyed by `full_name`, and two people were called Efrain Reyes
  — a seeded staff member and a demo persona. React warned about duplicate keys,
  which can silently duplicate or omit rows. Keyed by `profile_id` instead; two
  people at one club can genuinely share a name.
- Renamed the demo superintendent to Marcus Feldt so the team list does not look
  duplicated to anyone reading it.
- Found by the Next dev overlay while looking at the page, not by any test.

### Silent-success class, scoped and closed **[bug x3]**
The worker counting skipped reports as routed was a shape, not a one-off. Scoped
the codebase for operations that report success for work that did not happen:
- `start_report` updated by id without checking anything matched — a bad id left
  the report untouched and still wrote an event. Now raises.
- `route_report` could notify **nobody** and still record a successful routing.
  Zero recipients means a club with no active staff at all; that now raises, and
  the worker's retry-then-dead-letter path carries it to the watchdog.
- Push delivery skipped a notification whose report was missing, leaving it queued
  forever. Now marked failed so the gap is countable.
Three regression tests added; routing suite is 18.

### No PWA install
- iOS cannot receive web push in a browser tab, and we are shipping native apps
  rather than asking staff to install a website. iPhones are told the app is the
  route; Android and desktop stations get web push today.
- **[bug]** The sign-in page still read "we'll send a link — no password to
  remember" directly above a password field, left over from magic-link auth.

### Web push
- VAPID keys generated; `public/sw.js` renders the alert and opens the report on
  tap, reusing an open tab rather than piling up windows over a shift.
- Enabling alerts ends with a **real test notification**, not a permission prompt.
  An unverified alert path is the same as no alerts and fails silently until the
  day it matters.
- iPhones that have not installed to the home screen are told so plainly instead of
  being offered a button that cannot work there.
- Delivery prunes dead endpoints on 404/410. A queued notification with no
  subscribed device is marked **failed**, never left queued — a stuck queue would
  let a club believe staff were notified when they were not.
- The triage worker now runs classify → route → deliver in one invocation.

**Not verified end to end:** the browser half cannot be exercised in this
environment (notifications are denied in the preview browser). Server-side
delivery, pruning and failure marking are verified; the subscribe → receive path
needs a real device.

### Worker reported success for work it did not do **[bug]**
- `route_report` is idempotent, so a report already handled comes back as
  `already_triaged` with nobody notified. The worker counted those as *routed* —
  it reported "routed: 10" for ten reports it had skipped. Now counted separately
  as `skipped`, which is exactly the kind of number an operator would otherwise
  trust and shouldn't.

### Locked down: staff behind passwords, member surface reduced to one form
- **Staff sign in with a password**, admin-issued. No magic link, no email
  dependency. New accounts get a temporary password and must replace it on first
  sign-in. Failed sign-in is deliberately vague so nobody can enumerate which
  addresses belong to a club's staff.
- **The demo buttons now use the ordinary password path** rather than minting a
  magic-link token, so the demo cannot succeed where the real path would fail.
- **One scan, one report.** Loading the reporter page mints a single-use nonce
  that submission consumes. Copying a placard URL and replaying it gets one
  report, not a flood. Verified: replay refused, missing nonce refused.
- **The member status page is gone**, along with its RPC. ProResponse is an
  operations tool; members file and hear nothing back, so there is no longer any
  anonymous *read* path in the system at all.
- Contact details stay optional and are labelled as being for staff follow-up only.
- Resolve now captures one internal note. The member-facing message picker is gone.

### Audit **[bug]**
- `claim_profile` and `me` answered 200 to anonymous callers. Both returned nothing
  (they key off `auth.uid()`), but Postgres grants EXECUTE to PUBLIC by default, so
  they were reachable. Revoked, along with every staff action function.
- The remaining anonymous surface is exactly two functions: `get_scan_context` and
  `issue_scan_nonce`, plus `submit_report`. Nothing else.

### Audit: three bugs, one of them serious

**[bug — critical] Every dashboard view was world-readable.** A Postgres view runs
with its *owner's* privileges by default, so RLS on the underlying tables was
bypassed for anyone selecting from the view. With the publishable key — which ships
in the client bundle and is therefore public — an anonymous caller could read the
whole staff queue, member wording, staff names, and per-person performance data.
Fixed with `security_invoker = on` on all six views. `npm run test:rls` now checks
every table and view for anonymous access and fails the run on any leak.

**[bug] The realtime migration silently broke the entire local test harness.** It
ran fine against Supabase, but PGlite has no `supabase_realtime` publication, so all
three SQL suites started failing — and I had not re-run them after adding it. Now
guarded on the publication existing.

**[bug] The auth stub was copy-pasted into five files and drifted.** Hardening the
seed's `auth.users` insert broke every local suite because the stub lacked the new
columns. Extracted to `supabase/test-bootstrap.sql` as the single source of truth.

Also: fixed all lint errors, moved the `shadcn` CLI out of runtime dependencies,
confirmed every runtime dependency is actually imported, and confirmed the
service-role key appears only in a `server-only` module. `npm audit`: 0
vulnerabilities.

### Live queue + station alerts
- Realtime subscription refreshes the queue within a second of a report landing;
  a 20-second poll is the guarantee behind it. Same fast-path/guaranteed-path shape
  as triage.
- Connection state is always on screen. A board left open since 6am that has
  silently stopped listening is worse than one that admits it.
- Station mode (`/app?station=1`) adds an audible chime, synthesised in code rather
  than shipped as an audio file. Turning sound on plays it immediately — a station
  muted at the OS level is the likeliest way this fails with nobody noticing.
- The chime is two soft notes, not an alarm. It fires all day in a pro shop; an
  aggressive sound gets muted within a week, which kills the feature silently.

### The banner that would not appear **[bug, took three attempts]**
- Firing the alert from inside the realtime callback did nothing. The handler
  belonged to a component instance React had already unmounted, so every setState
  was a silent no-op — while `router.refresh()` kept working, because the router is
  stable across instances. The queue looked perfectly healthy.
- Moving the alert to a prop derived from the server still failed: `router.refresh()`
  **remounts** the component, resetting the "last seen" marker to the very report
  that had just arrived.
- Fixed by keeping the last-alerted id in module scope, which survives remounts.
  Verified end to end: filed a report from outside the browser and the banner
  appeared with its text.

### Design system — tokens instead of find-and-replace
- Two layers in `app/globals.css`: primitives (raw values, never referenced by a
  component) and semantic tokens named by their job — `surface`, `ink`,
  `ink-muted`, `line`, `accent`, `urgent`. Components only use semantic ones.
- **Zero hardcoded colours remain** outside the token file and vendored shadcn
  components. Verified by grep, not by eye.
- `lib/branding.ts` turns a course's `settings.branding` row into token overrides,
  applied once at each member page root. Every child just uses tokens and knows
  nothing about which club it is rendering.
- **Proved it**: changed Beacon Hill's branding row to a dark green and the whole
  member surface followed — accent rule, button, everything. Reverted to gold.
- Status colours are reserved and always paired with a text label, because colour
  alone is unreadable in direct sun.
- Charts read `--chart-series-1`; one series, one hue, no categorical palette until
  something genuinely needs one.
- **[bug]** My first attempt wired the brand onto `<main>` by matching a class
  string the token migration had already renamed, so the edit silently did nothing
  and the rebrand test showed no change. Caught by checking the computed CSS
  variable in the browser rather than trusting the screenshot.

### Per-report timeline
- `/app/report/[id]` — the member's words, the internal note, what the member was
  told, and the full event history with names and times. Queue cards link to it.

### Seeded auth users broke Supabase's admin API **[bug]**
- The seed inserts rows straight into `auth.users` and left its token columns NULL.
  Supabase's auth service cannot scan NULL there, so **every** admin user lookup
  failed with "Database error finding users" — which silently broke demo sign-in
  and would have broken real staff invites too.
- Seed now writes those columns explicitly; `scripts/repair-auth-users.mts` fixes an
  existing database.

### Reseeding wiped the demo logins **[bug]**
- The seed drops the course, which cascade-deletes profiles — including the demo
  personas, so sign-in succeeded and then found nothing.
- `npm run db:reset-demo` now runs seed → demo users → freshen in the only order
  that works.

### GM dashboard
- `/app/dashboard`, manager-only. Stat tiles (open now, filed today, median respond,
  median resolve), a 30-day volume chart, department table, recurring-problem list,
  and per-person figures.
- Per-person handling time runs from **pick-up**, not from submission, and the page
  says so — nobody is charged for routing delay they had no part in.
- Recurring problems is the view that earns a renewal: "Hole 12 course maintenance,
  13 times in 30 days" is something a superintendent can act on.

### Demo data realism **[bug x3]**
- **Trend spike.** Shifting history piled the seed's last day plus every open report
  onto today — the chart's final bar was 4x every other day. Resolved work is now
  spread back across the week it plausibly happened in.
- **Freshen was not idempotent.** It closed six reports *every run*, so running it
  twice took the queue from 18 to 12 to 6. Now closes down *to* a target, not *by*
  a count.
- **Overdue drift.** The same script un-acknowledged two more reports on every run,
  so overdue crept up each time. Now tops up to two rather than adding two.
- Verified stable across three consecutive runs.

### Member loop-back (the thing you asked for, now complete)
- **Member status page** at `/s/[trackingToken]` — status, their own words, and the
  reply staff chose. The token is the only credential and reads exactly one row.
- Confirmation screen now links to it, so a member can get back without an account.
- Verified no leakage: checked five resolved reports and the internal resolution
  note appears nowhere in the page source. A bogus token 404s.

### Queue ordering **[bug]**
- Scheduled work was sorting to the top of the staff queue. Something booked for
  Tuesday outranked a cart broken down right now. Scheduled items now sink below
  active work; urgency and age still order within each group.
