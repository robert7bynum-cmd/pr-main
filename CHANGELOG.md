# Changes since the MVP push began (4 Sep 2026)

Running notes toward MVP. Newest first. Bugs I found in my own work are marked
**[bug]** — those are the ones worth reading.

## In progress

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
