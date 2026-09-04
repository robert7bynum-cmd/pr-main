# ProResponse — Build Plan

## Context

ProResponse is a real-time operations platform for golf courses. A golfer scans a QR code on a hole,
describes a problem on a mobile web page (no app, no account, no phone call), and the report is
classified by AI and routed to the on-duty staff responsible for that kind of issue. Reports stay
open until resolved and auto-escalate if nobody acts in time. Management gets analytics on response
times, recurring problem areas, and staff performance.

Nothing exists yet — this plan starts from an empty repository.

**Decisions locked in with the user:**

| Decision | Choice |
| --- | --- |
| Staff app | Web first (Next.js + shadcn/ui), native iOS later |
| Backend | Supabase (Postgres, Auth, RLS, Realtime, Edge Functions) |
| First deliverable | Thin end-to-end slice: scan → triage → route → resolve → escalate |
| Tenancy | Multi-tenant from the first commit (`course_id` on every table) |

**The one thing that must work before anything else matters:** a report filed at hole 7 reaches the
right person's phone in under 30 seconds, and somebody is held accountable until it's closed. Every
other feature is downstream of that loop.

## Positioning: high-end clubs

The target is private clubs, resort courses, and luxury daily-fee — not municipal golf. That changes
real decisions in this plan, not just the marketing:

**The buyer's pain is different.** At a club where dues run five figures, a member complaint that
reaches the board is a job risk for the GM. The ROI story isn't labor efficiency, it's member
retention and management defensibility — "here's every issue this month and how fast we handled it"
is exactly the artifact a GM wants walking into a board meeting. That makes Chunk 11's monthly report
a **retention feature, not a vanity feature**, and it justifies pricing well above a utility tool.

**Silence is a service failure.** At a high-end club, a member who reports a broken ball washer and
hears nothing concludes that nobody cares — which is worse than never having a QR code on the tee.
Closing the loop (addition 7) is therefore part of the MVP, not a later nicety: it's the moment the
member actually sees the club respond.

**The reporter page is member-facing brand.** It carries the club's logo, colors, and typography, on
a custom domain, with the vendor's name nearly invisible. A generic-looking form on a club's tee box
reflects on the club. Same for the physical placards — they have to read as club signage, not a
startup sticker, so **placard design is a real deliverable**, not an afterthought printout.

**More departments, and different ones.** Caddie master, valet, locker room, starter, halfway house
— the seed department list is larger than a public course's, and routing rules need to cover them.

**Discretion matters.** Member names attached to complaints, and staff performance data, are both
sensitive in a club setting. Access to per-person metrics should be limited to management roles by
default rather than visible club-wide.

**Multi-venue properties are common.** 36 or 54 holes, more than one clubhouse, a practice facility.
The `locations` model handles this, but the admin console should group locations by venue rather
than assuming one 18-hole loop.

**Expect club-management integrations eventually.** Jonas, ClubEssential, Northstar, ForeTees. Out
of scope for the pilot, but member lookup is the obvious first integration, so keep member
identification a first-class optional field rather than a bolted-on note.

---

## How the system works

**System map — who touches what**

```
   GOLFER            FIELD STAFF          STATION (pro shop/F&B)      ADMIN
   own phone         phone PWA            browser open all day        desktop
   no login          push + SMS           chime + banner              config
      │                   ▲                        ▲                    │
      │ scan QR           │                        │                    │
      ▼                   │                        │                    ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                        Next.js on Vercel                               │
 │  /r/[course]/[token]      /app  queue · ack · resolve      /admin      │
 └────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                             SUPABASE                                   │
 │  Postgres + RLS                                                        │
 │    reports · report_events · routing_rules · triage_queue · locations  │
 │       ├── Realtime ─────────────► live staff queue / station board     │
 │       ├── Storage  ─────────────► photos, SLA documents                │
 │       └── Edge Functions: triage · notify · escalate · monthly-report  │
 │                    ▲                                                   │
 │           pg_cron ─┘  sweeper 30-60s · escalation 60s · heartbeat      │
 └────────────────────────────────────────────────────────────────────────┘
          │                     │                        │
          ▼                     ▼                        ▼
    Claude Haiku          Web Push (VAPID)          Twilio SMS
    classifies only        convenience layer         the reliable path
    never routes                                     + invites
```

**Report lifecycle — one report, end to end**

```
 t=0      Golfer submits ──┬──► reports row      (body stored verbatim)
          ONE transaction  └──► triage_queue row (work item can't go missing)

 t+0.2s   "Got it — the cart barn has been notified"
          Confirmation is instant. Triage NEVER runs inside this request.

 TRIAGE   fast path   ── DB webhook fires the function        (~1s)
          safety net  ── pg_cron sweeper claims anything still pending (≤60s)
          Both idempotent on report_id, so double delivery is harmless.
             │
             ├─ keyword pre-pass ──► obvious cases, no model call, no cost
             └─ Claude Haiku ─────► {category, urgency, summary, confidence}
                                     confidence < 0.6 → needs_review → mgmt

 ROUTE    routing_rules[category] → department        (data, never the model)
             on-duty members? ─ yes ─► notify them
                              └─ no ─► leadership chain, logging WHY it skipped
                                       supervisor → any supervisor → manager
                                       → owner → all leadership (unstaffed)

 NOTIFY   station chime+banner  │  web push  │  SMS fallback when push fails
          Every attempt recorded; retries with backoff; dead-letter + alert.

 ══════ staff_response clock starts on notified, not on submit ══════

          ACK (one tap, no typing) → IN PROGRESS → RESOLVE (+ note)
          Every transition writes a report_events row. That table is the
          only source of truth for timings and accountability.

 SLA      pg_cron each minute, quiet hours excluded from the clock:
          past ack SLA ──► supervisor      past resolve SLA ──► management
          SLA values come from routing_rules, seeded by the uploaded SLA doc.

 AFTER    report_events → SQL views → dashboards + monthly PDF
```

**The three ideas that hold it together:**
1. **The database owns the work, not a webhook.** A report and its queue item commit together, so
   nothing can be silently skipped.
2. **The model classifies; data routes.** Claude picks a category. `routing_rules` — editable by a
   manager — decides who gets paged. Swapping models can never reroute anyone.
3. **Events are the truth.** Status columns are for the UI; `report_events` is what every metric,
   escalation, and performance claim is computed from.

---

## Stack

- **Web** — Next.js 15 (App Router) + TypeScript, Tailwind, **shadcn/ui**, deployed on Vercel
- **Backend** — Supabase: Postgres + RLS, Auth (staff only), Realtime (live queue), Edge Functions
  (triage, escalation, push), Storage (issue photos)
- **AI triage** — `claude-haiku-4-5` for classification (fast, ~$0.001/report), with a deterministic
  keyword pre-pass that short-circuits obvious cases before any model call
- **Push** — Web Push (VAPID) + service worker; **Twilio SMS as the reliability backstop**
- **Scheduling** — `pg_cron` + `pg_net` calling the escalation Edge Function every minute

### Three surfaces, three very different devices

| Surface | Who | Device | Design target |
| --- | --- | --- | --- |
| `/r/…` reporter | Member | Their own phone, mid-round | **A form and nothing else** — no app, no account, location auto-associated from the scan, submitted in under 20 seconds |
| `/app` field staff | Grounds crew, cart barn, marshals | **Their own phone, outdoors, one-handed** | Glanceable, thumb-reachable, near-zero typing, installed to home screen |
| `/app` station mode | Pro shop, F&B, service counter | **Browser left open on a counter PC all day** | Always-on board, audible alert, readable across a room |
| `/admin` console | GM, superintendent, management | **Desktop browser, in the office** | Dense tables, config, charts, keyboard-friendly |

Field staff and station staff share one route and one data model but get different treatment:
station mode is a persistent dashboard with a sound and a visual banner on new assignment, field
mode is a phone PWA driven by push and SMS.

**Station mode quietly solves the hardest problem in this product.** A pro shop browser tab that is
already open can alert reliably with sound and an on-screen banner — no push permission, no iOS
restriction, no dead zone. Departments that sit at a counter should default to station mode and
never depend on mobile push at all. Reserve the fragile channel for the people who genuinely can't
be reached any other way.

Every staff member still carries push on their phone as well, so a superintendent who walks out to
the 9th gets the alert either way.

### Starting point

There is no repo, no Supabase project, no hosting, and no accounts. Chunk 1 builds all of it from
zero. The current session folder is a disposable scratch workspace, so the first action is choosing a
permanent location (e.g. `~/code/proresponse`) and moving there before any code is written.

---

## Data model

Multi-tenant from day one. Every domain table carries `course_id`; RLS policies scope all staff
reads/writes to the caller's course.

```
courses            id, slug, name, timezone, hole_count, is_demo bool, settings jsonb
                   settings: branding (logo, colors, fonts), quiet hours, domain
locations          id, course_id, venue_id?, kind, hole_number?, name, geo point
                   kind: hole | practice | clubhouse | cart_barn | restroom | other
                   -- NOT just holes: restrooms, the range, and the clubhouse generate
                   -- plenty of reports and need placards too
qr_codes           id, course_id, location_id, token (random, unguessable), active, printed_at

profiles           id → auth.users, course_id, full_name, phone, preferred_language, role
                   role: staff | supervisor | manager | owner
                   account_kind: individual | station   -- a shared counter login is not a person
invites            id, course_id, phone, full_name, role, departments[], token,
                   invited_by, expires_at, accepted_at
venues             id, course_id, name        -- 36/54-hole properties, second clubhouse, practice
departments        id, course_id, key, name
                   seed: maintenance | cart_fleet | pro_shop | pace_of_play | f_and_b |
                         caddie | valet | locker_room | starter | management
staff_departments  profile_id, department_id           -- a person can cover several
duty_status        profile_id, on_duty bool, since      -- v1 toggle; shift scheduling later

reports            id, course_id, location_id, qr_code_id,
                   duplicate_of_id?,   -- four groups report the same sprinkler; cluster them
                   body text,          -- the filer's verbatim submission, stored as typed
                   ai_summary text,    -- model's short version; NEVER overwrites body
                   photo_path, reporter_name?, reporter_phone?, submitted_at,
                   tracking_token,        -- random; the member's only way back to their report
                   reporter_language,     -- which language they filed in, for the reply
                   sms_opt_in bool,       -- explicit consent, required before any outbound SMS
                   member_message?,       -- what the MEMBER sees; never the internal note
                   member_notified_at?,
                   source (golfer_qr | staff | phone_relay),   -- staff and pro-shop filing
                   filed_by?,          -- set when staff filed it, null for golfer scans
                   category, urgency (low|normal|high|urgent),
                   ai_confidence, ai_raw jsonb, triage_source (keyword|model|manual),
                   department_id, claimed_by?, claimed_at?,
                   status (new|triaged|acknowledged|in_progress|scheduled|resolved|
                           verified|reopened|closed_no_action),
                   scheduled_for?,     -- legitimate "can't fix today" without a false resolve
                   close_reason?,      -- invalid | duplicate | no_action_needed
                   escalation_level int default 0,
                   created_at, acknowledged_at, resolved_at, resolved_by, resolution_note,
                   resolution_photo_path?,          -- optional, never required
                   reopened_from_id?, reopen_count int default 0,
                   -- reserved for later, only if a club's reopen rate warrants it:
                   resolved_on_site bool?, verified_by?, verified_at?
report_events      report_id, type, actor_id?, payload jsonb, created_at
                   type: created | triaged | routed | notified | acknowledged | scheduled |
                         escalated | unstaffed | reassigned | note | resolved | verified | reopened
triage_queue       report_id, status (pending|processing|done|dead_letter),
                   attempts, locked_at, next_attempt_at, last_error
                   -- written in the SAME transaction as the report; the webhook is
                   -- only a fast path, this table is what guarantees delivery
routing_rules      course_id, category, department_id,
                   ack_sla_minutes, resolve_sla_minutes, escalation_chain jsonb,
                   source_document_id?, source_excerpt?   -- provenance when extracted from an SLA doc
sla_documents      id, course_id, storage_path, filename, mime_type,
                   uploaded_by, uploaded_at,
                   status (uploaded|parsed|in_review|applied|superseded),
                   extracted jsonb,     -- proposed rules + per-rule confidence + quoted clause
                   applied_at, applied_by, version int
notifications      report_id, profile_id, channel (push|sms|station), status, attempt int,
                   sent_at, delivered_at, failed_at, error, next_retry_at
push_subscriptions profile_id, endpoint, p256dh, auth, last_success_at, failure_count
```

`report_events` is the spine of the analytics layer — every timing metric and every accountability
claim is derived from it, never from mutable columns on `reports`.

**RLS shape:**
- Anonymous members cannot `SELECT` or `INSERT` on `reports` directly. Submission goes through a
  `SECURITY DEFINER` RPC (`submit_report`) that validates the QR token, rate-limits, and inserts.
- Members read **only their own report, only by `tracking_token`, and only through a restricted
  view** exposing status, location, their own text, and `member_message` — never the internal
  resolution note, staff names, department routing, or anything about other reports. The token is
  long and random, single-report scoped, and grants no write access.
- Staff read/write rows where `course_id = (auth.jwt() ->> 'course_id')`; managers additionally
  see analytics views.

---

## How we know the work was actually done

`resolved` is a self-reported status. A staff member can tap Resolve without touching anything, and
nothing in a naive design would ever know. This matters more here than in most software: you are
selling accountability to a GM. If the monthly report says 98% resolved within SLA while members
still see the same broken ball washer, the product isn't merely unhelpful — it is **actively lying to
management**, which is worse than not having it.

Worse, the measurement creates the incentive. The moment staff are scored on response time, tapping
Resolve early becomes the cheapest way to look good. Any system that measures speed without
evidencing completion will eventually be gamed, not out of malice but because that's what the
scoreboard rewards.

**The mechanism stays simple: the person it was assigned to marks it done, optionally with a
comment.** That's the whole staff-facing interaction, and it should not become a compliance ritual —
process added to the resolve step is exactly what makes crews stop using the app. Everything below is
either optional for staff or free for them.

**1. Marking done, with a comment.** The assignee taps Resolve and can add a note. That's the
baseline record, and for most issues it's enough. Voice dictation, because they're wearing gloves.

**2. An optional photo.** Offered, never required. A picture of the repaired sprinkler is
self-verifying and takes five seconds, and crews will attach one when it's genuinely useful — but
mandating it on every bunker rake turns the fast path into a chore.

**3. A `scheduled` option** for work that legitimately can't happen today. Without it, SLA pressure
forces a choice between a false Resolve and an undeserved escalation, and most people will pick the
false Resolve.

**4. Recurrence, which costs staff nothing.** If the same category recurs at the same location
shortly after being resolved, that's evidence the fix didn't hold — derived automatically from data
you already have, with no extra tap by anyone. This produces the number that tells a GM whether the
dashboard is trustworthy:

> **Reopen rate** — the share of resolved reports that recur or get reopened. Near zero means the
> resolution data can be believed. At 20% it means the response-time charts are fiction, and that
> single number is worth more to management than any average.

**5. Reopen, from either side.** Staff can reopen, and a member's status page offers "this isn't
fixed." Reopening links to the original, marks that resolution false, and feeds the reopen rate.

**Deliberately not in the MVP:** mandatory resolution photos, GPS matching at resolve, and a
supervisor verification queue. Each buys real assurance and each adds friction or surveillance to a
crew's day — worth proposing to a club only if their reopen rate turns out to be high enough to
justify it. The schema leaves room (`resolution_photo_path`, `resolved_on_site`, `verified_by`) so
adding any of them later isn't a migration.

## Response-time tracking

Every timing metric derives from `report_events` timestamps, never from a mutable column, so any
number on a management report can be traced back to the event that produced it.

| Clock | Span | What it measures |
| --- | --- | --- |
| `time_to_notify` | created → notified | System health. Should be seconds; if it isn't, triage is broken |
| `time_to_acknowledge` | created → first acknowledged | What the golfer actually experiences as "someone noticed" |
| `time_to_resolve` | created → resolved | The headline number for a GM |
| `staff_response` | **notified → acknowledged** | What the individual is fairly accountable for |

**Track the last two separately and never conflate them.** The golfer's experience starts at
submission, but a staff member should not be charged for a routing delay or a triage failure they
had no part in. Reporting only `created → acknowledged` makes people look slow for the system's
mistakes, and staff stop trusting the numbers — which is how an accountability tool dies.

Also captured: `acknowledged_by` and `resolved_by` for attribution, and a `reassigned` event so
credit follows the person who actually did the work.

**Quiet hours are excluded from SLA clocks.** A report filed at 8pm and handled at 6:30am is a
10-hour resolve time that means nothing; without this exclusion every overnight report makes the
whole team look negligent and the metrics become noise.

## Operational safeguards (gaps found reviewing this plan)

These are the ways a system like this fails silently in production. Each one belongs in the
milestone noted, not in a "later" pile.

**Nobody on duty → next available leadership (Chunk 4).** A cart report at 6:40am routes to a department
where every member has `on_duty = false`. Rather than sitting unnoticed, routing walks a **leadership
fallback chain** and delivers to the first reachable person:

1. On-duty members of the target department (normal path)
2. That department's supervisor, if on duty
3. Any on-duty supervisor of any department
4. On-duty manager, then owner
5. If nobody at all is on duty — notify **all** leadership regardless of duty status, and mark the
   report `unstaffed`

The chain is stored in `routing_rules.escalation_chain` so a course can reorder it. Each hop writes
a `routed` event naming why it skipped the previous level, so a GM reviewing a slow report can see
"maintenance had nobody clocked in at 6:40am" rather than guessing. **Silence is never a valid
routing outcome** — the report always lands on a real person.

**Duplicate reports — deferred to Chunk 12, prepared for now.** Four groups play hole 12 and all report the
same sprinkler. For the pilot, duplicates are acceptable: staff triage them by eye, and real
duplicate volume is the data needed to tune the clustering window sensibly. The `duplicate_of_id`
column ships in the Chunk 2 schema so adding this later is not a migration.

When built, clustering matches open reports at the same location and category inside a configurable
window, links them to a parent, suppresses re-notification, and shows "reported by 4 groups" on the
staff card as an urgency signal. It also **auto-responds to the later filers** — their status page
(and an SMS if they opted in) says the issue is already reported and being handled, which turns a
duplicate from noise into a service touch. Resolving the parent resolves the cluster and notifies
everyone who reported it.

**Notification delivery is not fire-and-forget (Chunk 8).** Push endpoints expire, phones are off,
Twilio calls fail. Every send records an attempt with a status; failures retry with backoff, and a
push that fails or goes unacknowledged past a threshold **falls back to SMS automatically**. Expired
push subscriptions are pruned on 410 responses.

**Triage must not depend on the DB webhook staying up (Chunk 4).** You're right that this is the biggest
structural risk in the design, and the answer is to stop treating the webhook as the mechanism. It
becomes an *optimization*; correctness comes from a queue the database owns.

1. **Durable queue, not a trigger side effect.** The same transaction that inserts a report inserts a
   `triage_queue` row (`report_id`, `status`, `attempts`, `locked_at`, `next_attempt_at`). If the
   report exists, the work item exists — they cannot diverge, because it is one commit.
2. **Webhook = fast path.** The DB webhook fires the triage function immediately, giving the
   sub-second routing the product promises. If it never fires, nothing is lost.
3. **`pg_cron` sweeper = guaranteed path.** Every 30–60 seconds a job claims any queued item that is
   pending or past `next_attempt_at` using `SELECT … FOR UPDATE SKIP LOCKED`, so the sweeper and the
   webhook can run concurrently without double-processing. A webhook outage degrades routing latency
   from two seconds to under a minute — it does not lose reports.
4. **Idempotent processing.** Triage keys on `report_id` and no-ops if the report is already triaged,
   so double delivery is harmless. This is what makes retrying safe.
5. **Retry with backoff, then dead-letter.** After N failed attempts an item is parked as
   `dead_letter` and an operator is alerted — the report is still routed to leadership by fallback
   rather than being stranded.
6. **Dead-man's switch for the sweeper itself.** The layers above all assume `pg_cron` runs. So the
   sweeper pings an external heartbeat service (healthchecks.io / Better Stack) on every successful
   pass; **if the pings stop, you get paged.** Without this, a failure of the monitoring layer is
   itself invisible, which is exactly the trap the webhook version fell into.
7. **Business-level alarms on top:** any report untriaged past 3 minutes, notification failure rate
   above a threshold, a station tab disconnected too long, or queue depth climbing. Plus Sentry for
   exceptions and structured logs on every Edge Function.

The same queue-plus-sweeper pattern covers notification sending and escalation, so no part of the
critical path is a single fire-and-forget call.

**Station accounts break per-person metrics (Chunk 7).** A shared pro-shop login means "staff performance"
data attributed to a counter, not a person. Station accounts are marked `account_kind = 'station'`,
excluded from individual performance reporting, and require picking a name when claiming a report so
attribution survives. Individual metrics should never quietly include a shared terminal.

**Language (Chunks 3 and 6).** A large share of grounds crews in the US are Spanish-first. The staff
app ships bilingual EN/ES with a per-profile `preferred_language` — including notification bodies, not
just the UI chrome. The golfer reporter is bilingual too. Retrofitting i18n later is far more
expensive than starting with it.

**Timezone discipline (Chunk 2).** Store everything UTC; compute quiet hours, SLA clocks, and "today" in
the course's timezone. Getting this wrong makes every report and escalation subtly wrong for half
the year.

**Photos (Chunk 3).** Compress client-side before upload, cap size, strip EXIF — golfer photos carry GPS
and device metadata that there is no reason to store, and uncompressed phone images will dominate
storage cost.

## Privacy, consent, and retention

Golfer name, phone, free text, and photos are personal data collected from members and guests.

- Contact details are **optional** and clearly labeled as only for follow-up on this report
- **SMS to golfers requires explicit opt-in consent language at the point of collection**, plus STOP
  handling. Texting staff is an employment matter; texting a golfer who never agreed is a TCPA
  problem, and this is worth getting right before the first message goes out, not after.
- Retention policy per course: purge golfer contact details and photos after N days by scheduled job,
  keeping the anonymized report for analytics. Expiring the `tracking_token` on the same schedule
  closes the status page rather than leaving a permanent public URL to a member's complaint.
- Storage buckets are private with signed, expiring URLs; no public photo links
- Supabase PITR enabled on prod before the pilot

## Testing

- **Vitest** for routing logic, SLA math, escalation state machine, and quiet-hours calculation —
  these are pure functions and where the costly bugs will live
- **A triage eval set as a regression suite**, not a one-time check: ~50 real-wording reports with
  expected category and department, run in CI. Prompt or model changes must not silently reroute
  cart complaints to the pro shop.
- **Playwright** end-to-end for the golfer submit path and the staff acknowledge/resolve path
- **pgTAP or SQL tests for RLS** — cross-tenant leakage is the one bug that ends the business, and it
  needs a test that fails loudly rather than a manual check

## MVP additions — what I'd add before the pilot

Six things the plan didn't have that belong in the first release. Each is small; each fixes something
that otherwise makes the pilot look bad or makes the data untrustworthy. All six are folded into the
chunks below.

**1. Staff can file reports too (Chunk 6) — the highest-value addition here.**
Right now only golfers can report, which means the system sits idle until a member complains. But
staff spot most problems first, and the radio chatter you're replacing is mostly staff-to-staff. A
one-tap "Report an issue" in the staff app, with the same triage and routing, changes the product:
- Report volume goes up several-fold, so analytics are meaningful in **weeks instead of months**
- The app is useful on a slow day, which is what drives daily habit and adoption
- A superintendent filing "irrigation head broken on 4" is the actual daily workflow at a course

**2. Pro shop can file on behalf of a caller (Chunk 6).**
Golfers will keep phoning and walking up to the counter no matter how many QR codes you print. If
the shop can log that in ten seconds — location, issue, "reported by phone" — every incident lands
in one system. Without it your analytics silently exclude a large share of real problems, and the
monthly report understates the course's actual issue volume.

**3. One-tap re-route when triage is wrong (Chunk 6).**
Classification will be wrong sometimes. If the cart barn receives a maintenance issue and can't
bounce it in one tap, they'll ignore it or handle it badly, and the timing data is garbage. Every
manual re-route writes a `reassigned` event — which doubles as the **best possible signal for tuning
routing rules and the keyword map**, straight from the people who know the course.

**4. Acknowledge claims the report (Chunk 6).**
Notifying five grounds crew is right; five people driving to the same bunker is not, and "everyone
assumed someone else took it" is worse. First acknowledge claims ownership, the card updates live
for everyone else showing who has it, and the claim can be released or reassigned.

**5. A "no action needed" disposition (Chunk 6).**
Joke reports, duplicates, and things that resolved themselves need a way to close that is **not**
counted as a resolution. Without it, every prank inflates resolve-time averages and staff learn to
ignore the queue. Closing this way requires a one-tap reason (invalid / duplicate / no action) and
is excluded from performance metrics but kept for volume and abuse analysis.

**6. Per-report timeline (Chunk 6) + a GM day view (Chunk 9).**
The timeline is just `report_events` rendered — filed, triaged, routed, notified, acknowledged,
escalated, resolved, with names and timestamps. It's nearly free to build and it's what settles
every "nobody told us" conversation. Pair it with a lightweight GM view: open reports right now,
count and median acknowledge time today. Full analytics stays in Chunk 11; **the person who signs the
check needs to see it working on day one**, not after a month of data collection.

**7. Close the loop with the member (Chunk 6).** When staff resolve a report, the member who filed it
finds out. At a private club, a member who reports something and hears nothing concludes the club
ignored them — you've turned a service opportunity into a second complaint. Two delivery paths, both
requiring no account:
- **The confirmation screen becomes a status page** they can return to via a link, keyed on a random
  `tracking_token`. No login, nothing to install, nothing to remember.
- **SMS on resolution** if they left a number and opted in.

**The critical design constraint: the internal resolution note and the member-facing message are
different fields.** Staff need to write candidly for their own record — "nothing actually broken,
member was on the wrong hole" — and that text must never reach a member. So resolving asks for the
internal note, then offers a short list of club-approved member-facing messages ("Repaired — thank
you for letting us know", "Our team inspected and no issue was found", "Scheduled for tomorrow
morning") with the option to write one. Nothing goes to a member unless a staff member chose it.

**One thing I'd move later:** SLA document upload (now Chunk 10) is an onboarding accelerator for course #2
and beyond. For a single pilot course you'll configure the rules by hand in an afternoon, and you'll
want to change them repeatedly in the first weeks anyway. Build it once the rules have stabilized and
you know what a real course's SLA document actually looks like — otherwise you're extracting into a
schema you haven't validated yet.

## Before the first line of code

**Blocking — needed to start Chunk 1:**
- A permanent project folder (this session is in a disposable scratch workspace)
- GitHub, Supabase, and Vercel accounts, with keys handed to me

**Start immediately, because they have lead time measured in weeks, not hours:**

1. **Twilio A2P 10DLC registration.** This is the one that bites people. Sending SMS to US numbers
   through Twilio requires brand and campaign registration, which takes days to weeks, can be
   rejected, and cannot be rushed. SMS is both the staff invite channel *and* the reliability backstop
   for urgent alerts, so an unregistered number means **no onboarding and no dependable alerting** —
   discovered, typically, the week of launch. File it in week one, before the code that uses it
   exists. Until it clears, staff onboarding and urgent alerts have no working path. Now that
   members also receive resolution texts, register the campaign to cover **both** use cases —
   internal staff notifications and member service replies — since they're distinct in Twilio's
   terms and the member path carries the consent obligation.
2. **Domain.** Running on a `vercel.app` subdomain through development, per your call. Two caveats:
   a `vercel.app` URL on a tee box at a high-end club undercuts the positioning, so a real domain is
   needed before permanent placards; and **buying a domain now is cheap insurance** — roughly $12
   against reprinting signage. Any QR code printed against a domain you own can be redirected
   forever, while a `vercel.app` code is stranded if the project or name changes. Worth doing before
   even the temporary paper codes go out.
3. **Placard design and print.** Design, proof, print, mount — weeks, and at a high-end club it goes
   through someone with opinions about signage.
4. **Apple and Google developer accounts** if Chunk 14 is on the roadmap; enrollment (especially
   Apple's organization verification) is slow and worth starting well before it's needed.

**Worth settling with the club early**, since they change configuration rather than code: SLA
targets in writing, quiet hours, who sits in the escalation chain, and who their named support
contact is.

## Sprint: demo to the club, Friday 11 Sep 2026 (8 days)

The near-term target is a **demo that closes the deal**, not a live installation. That reorders the
plan considerably, and mostly in a good way — a demo needs the story to be flawless and the edges to
be thin, which is the opposite of a launch.

**Hard external constraint: no SMS.** Twilio A2P 10DLC takes one to three weeks and can be rejected,
so nothing SMS-dependent exists on the 11th. Staff sign in with **email magic links** (Supabase
native, no third party). File the A2P registration this week anyway, so it's cleared by the time the
club actually goes live.

**What changes because it's a demo:**
- **Demo data (Chunk 13) moves to the front, not the end.** An empty queue and blank charts demo
  terribly. This is now day-two work, and it should use *this club's* name, hole names, and staff
  roles, seeded with weeks of believable history.
- **Branding is high-leverage and cheap.** Showing the GM a reporter page carrying their logo,
  colors, and hole names is far more persuasive than any feature. It's a settings object and CSS
  variables — hours of work for the biggest single reaction in the room.
- **A GM dashboard gets pulled forward (a slice of Chunk 11).** With seeded history it's a handful of
  SQL views and a few charts, and it's the retention story that justifies the price. Worth more in
  this meeting than offline sync.
- **Staff onboarding shrinks to almost nothing.** No CSV import, no bulk deactivation, no
  install-verification roster. A few seeded accounts that log in.
- **The watchdog and heartbeat can wait.** Invisible in a demo. The queue-and-sweeper *stays* — it's
  the architecture, not a feature, and retrofitting it later means rewriting triage.

**The demo narrative, which is what must be flawless:**
1. Scan a QR code on a real phone → a club-branded form that already knows it's on hole 7
2. Submit → confirmation in under a second
3. A staff phone in the room buzzes, and the station board chimes, within seconds
4. Staff taps Acknowledge, then Done with a comment
5. The timeline shows every step, with names and times
6. Switch to the GM dashboard: this month's volume, response times, the recurring-problem list

Everything on that path gets polished. Everything off it stays thin.

**Deferred to after the demo:** Spanish/bilingual, full offline sync, station-mode polish
(wake-lock, connection indicator), full admin console, watchdog and heartbeat, SLA document upload,
duplicate clustering, monthly PDF, native apps, and all SMS.

**Build order for the eight days:** Chunks 1 → 2 → 13 (demo data, branded to the club) → 3 → 4 →
5-lite (magic link) → 6 → 7-lite (chime) → 8-lite (a demonstrable escalation) → 9-lite (routing
rules + QR sheet) → 11-lite (GM dashboard).

## Build chunks

The work is cut into chunks that each end at a **working, deployed, demonstrable state**. Rules for
every chunk:

- **It ships.** No chunk ends with the system half-migrated or a feature stubbed behind a flag that
  nobody can exercise. If we stop after any chunk, what exists still runs.
- **It's demoable.** Each names the thing you can actually show someone at the end. That's the
  acceptance test, and it's what keeps a pilot conversation moving while the rest gets built.
- **It's a few days, not a month.** If a chunk grows past that, it gets split.
- **Dependencies are explicit**, so anything parallelizable is visible.

| # | Chunk | Phase | Depends on |
| --- | --- | --- | --- |
| 1 | Infrastructure & repo | MVP | — |
| 2 | Schema, RLS, seed data | MVP | 1 |
| 3 | Member reporter flow | MVP | 2 |
| 4 | Triage & routing engine | MVP | 3 |
| 5 | Staff accounts & onboarding | MVP | 2 |
| 6 | Staff queue & response | MVP | 4, 5 |
| 7 | Station mode | MVP | 6 |
| 8 | Escalation, SLA & watchdog | MVP | 6 |
| 9 | Admin console, QR sheets, GM day view | MVP | 5, 8 |
| — | **▶ Pilot at one course** | — | 1–9 |
| 10 | SLA document upload | Post-launch | 9 |
| 11 | Analytics & monthly reports | Post-launch | real data |
| 12 | Duplicate clustering & auto-response | Post-launch | real volume |
| 13 | Demo club data | Anytime | 2 |
| 14 | Native iOS & Android | Post-launch | 6 |

Chunks 3 and 5 can run in parallel once 2 lands. Everything through 9 is the pilot MVP; nothing
after it is needed to put this in front of a course.

### Chunk 1 — Infrastructure & repo

**Goal:** a deployed empty app with CI, so every later chunk lands on a real pipeline.
**Demo:** a URL that loads, deploying automatically on every push.

**Accounts you have to create yourself.** I can't sign up for services or enter credentials on your
behalf. For each of these you create the account and paste me the key; I do all the wiring:

| Service | Purpose | Needed by |
| --- | --- | --- |
| GitHub | Repo, CI | Chunk 1 |
| Supabase | Database, auth, functions | Chunk 1 |
| Vercel | Hosting, preview deploys | Chunk 1 |
| Anthropic Console | `ANTHROPIC_API_KEY` for triage | Chunk 4 |
| Twilio | SMS invites + alerts (the iOS backstop) | Chunk 5 |
| Sentry | Exception tracking on web + Edge Functions | Chunk 4 |
| healthchecks.io (or Better Stack) | Dead-man's switch on the triage sweeper | Chunk 4 |

Local prerequisite: **Docker Desktop**, so `supabase start` can run the full stack offline and
migrations are testable without touching a hosted database.

**Repo and app skeleton**
1. Create the permanent project folder and move the session into it
2. `npx create-next-app@latest` — TypeScript, Tailwind, App Router, ESLint
3. `git init`, a `.gitignore` that excludes `.env*`, first commit, push to a **private** GitHub repo
4. `npx shadcn@latest init`, then add the components this product actually uses: button, card,
   form, input, textarea, select, badge, dialog, sheet, sonner, table, tabs
5. Prettier, `.nvmrc`, README with local setup steps

**Supabase projects**
6. Create **two** projects — `proresponse-dev` and `proresponse-prod`. Never pilot a live course
   against the database you're running migrations on.
7. `supabase init` + `supabase link`; `supabase start` for the local stack

**Secrets**
8. `.env.local` and a committed `.env.example`: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`,
   `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (generated with `web-push generate-vapid-keys`),
   `TWILIO_*`
9. Edge Function secrets via `supabase secrets set`; Vercel env vars set separately for preview and
   production. The service role key is server-only and never reaches a `NEXT_PUBLIC_` variable.

**CI/CD**
10. Vercel project linked to the repo — preview deploy per PR, production on `main`
11. GitHub Actions: typecheck, lint, Vitest, and a job asserting migrations apply cleanly to a
    fresh database
12. Domain can wait — a `vercel.app` subdomain is fine through the pilot, but the QR codes encode
    whatever domain you print, so **decide the production domain before printing placards**

**Done when:** a push to `main` deploys a live app on Vercel; `supabase start` plus `npm run dev`
gives a working local stack; CI runs green on a pull request.

### Chunk 2 — Schema, RLS, seed data

**Goal:** the full data model exists with tenant isolation proven by tests.
**Depends on:** 1. **Demo:** seed a second course and show a staff token from course A returning
zero rows from course B.

- Ordered migrations for every table in the Data model section, **RLS policies written in the same
  migration as the table** rather than bolted on afterward
- `submit_report` as a `SECURITY DEFINER` RPC — token validation, rate limiting, and the
  report + `triage_queue` insert in one transaction
- Timezone discipline: everything UTC, course-local computed at read time
- **A minimal working seed** — enough to build and test against, nothing more: one course with 18
  holes plus a few facility locations, QR tokens, the department list, a handful of staff across
  roles, and default routing rules. Chunks 3–9 can't be built or exercised without this much.
- `courses.is_demo` flag defined now, so demo data can never contaminate a real club's reporting or
  billing later
- Presentation-grade demo data — realistic names, weeks of resolved history — is **Chunk 13**, built
  when a demo is actually needed rather than now
- `supabase gen types typescript --linked > lib/supabase/types.ts`, wired to a `db:types` script
- **pgTAP/SQL tests for RLS running in CI** — cross-tenant leakage is the one bug that ends the
  business, so it gets a test that fails the build, not a manual check

**Done when:** migrations apply to an empty database, the seed produces a course you can develop
against, and the cross-tenant test fails the build if isolation regresses.

### Chunk 3 — Member reporter flow

**Goal:** a member with no app and no account files a report in under 20 seconds, correctly
attributed to a location. **Depends on:** 2 — runs in parallel with 5.
**Demo:** scan a printed QR with a phone that has never visited the site, file a report, see the row
land already attributed to hole 7.

**The member experience is a form and nothing else.** No app, no download, no account, no login, no
follow-up destination to manage. Scan → type what's wrong → submit → "Got it." That's the whole
product from the member's side, and every decision here protects it.

- Route: `/r/[courseSlug]/[token]` — the token **auto-associates the report with its location** and
  proves the scan is legitimate. The member never selects or types a hole number; the page opens
  already knowing where they are. Locations cover holes plus the range, restrooms, cart barn,
  halfway house, and clubhouse.
- The page shows "Hole 7" as confirmation so they know it registered, with a small, de-emphasized
  correction link for the occasional member who scanned the tee they just left
- **One text field** is the required input. Everything else is optional and configurable per club:
  category chips, photo, callback name/phone, member number. A club that wants a single-field form
  gets a single-field form.
- **Club-branded**: logo, colors, and typography from `courses.settings`, served on the club's own
  subdomain. This page is member-facing brand; it should look like the club, not like a vendor.
- Server action → `submit_report` RPC → instant confirmation screen, which doubles as the status
  page for this report (`/s/[trackingToken]`). Still no account and nothing to install — the link is
  the credential, and returning to it later shows whether the club has handled it.
- If they leave a phone number, an explicit opt-in checkbox with consent language covers texting
  them when it's resolved. Unchecked means no outbound SMS, ever.
- Rate limiting: per-token and per-IP; Cloudflare Turnstile behind a course setting, off by default
- Works on a first-time visitor's phone with no prior state — nothing cached, nothing installed

**Persistence of the filer's submission:** everything the golfer enters is written to the database on
submit — the report text exactly as typed into `reports.body`, plus photo, optional name and phone,
hole, QR code, and timestamp. `body` is written once and never mutated: the AI writes its short
version to `ai_summary` and staff notes go to `report_events`, so the original wording always
survives intact and is what the staff card and every report display quote.

**Critical constraint:** the golfer sees "Got it — the cart barn has been notified" immediately.
Triage happens after the response is sent, never in the request path.

Built here as a reusable form component, because Chunk 6 reuses it verbatim for staff-filed and
pro-shop-relayed reports.

**Done when:** a scan on a phone that has never seen the site opens a branded form already bound to
the right location, submits in one tap, and stores the verbatim text unmodified — with photos
compressed and EXIF-stripped, and rate limiting blocking a flood. No install prompt, no account
prompt, nothing for the member to dismiss.

### Chunk 4 — Triage & routing engine

**Goal:** a filed report reaches the correct person automatically, and cannot be silently dropped.
**Depends on:** 3. **Demo:** file a report, watch it classify and route within seconds — then
disable the webhook and watch it route anyway.

Supabase DB webhook on `reports` insert → `triage` Edge Function, with the `triage_queue` sweeper
as the guarantee (see *Triage must not depend on the DB webhook*):
1. **Keyword pre-pass** — a curated map (`"cart won't start"`, `"bunker rake"`, `"slow group ahead"`,
   `"no towels"`, `"sprinkler"`) resolves the common cases with zero latency and zero cost
2. **Model pass** — anything unmatched or ambiguous goes to `claude-haiku-4-5` with a structured
   tool-call schema returning `{category, urgency, summary, confidence}`. Constrained to the course's
   own category list, never free-form
3. Low confidence (`< 0.6`) → category `needs_review`, routed to management rather than guessed
4. Deterministic routing: `routing_rules[category] → department → on-duty members` — the model
   classifies, it never decides who gets paged
5. **Leadership fallback** when the target department has nobody on duty (see Operational safeguards)
6. Writes `triaged` + `routed` events, fires notifications through the same queue-and-retry pattern
7. The triage eval set lands here as a CI regression suite, not a one-off check

**Done when:** 20 seeded realistic reports classify correctly end-to-end; a nonsense report lands in
`needs_review` instead of waking the mechanic; a report still routes with the webhook disabled; and
an all-off-duty department escalates to leadership with an `unstaffed` event.

### Chunk 5 — Staff accounts & onboarding

**Goal:** an admin can create a staff profile and that person can log in on iOS or Android with a
**verified** notification path. **Depends on:** 2 — runs in parallel with 3 and 4.
**Demo:** add a staff member from the console, watch the SMS arrive on a real phone, complete
sign-in, and receive a test alert.

Staff never sign themselves up — an admin creates the profile and the staff member just logs in. A
GM cannot administer 40 seasonal employees through email/password signup, and much of a grounds crew
has no work email address at all.

*Admin side (in the console):*
- Add a staff member by **name, mobile number, departments, role, and language**
- Bulk add via CSV for preseason hiring, and bulk deactivate at end of season
- Resend invite, see who has actually completed setup and who has a **verified notification path** —
  a roster showing "invited / logged in / alerts confirmed" per person, so gaps are visible before
  they matter
- Deactivation is one toggle and takes effect immediately, revoking the session

*Staff side (identical account on both platforms):*
- SMS invite link → **phone OTP sign-in**. No password to forget, no email, and the same credential
  works on iOS, Android, and later the native apps in Chunk 14 — it's one Supabase Auth identity, so
  nothing is re-provisioned when they switch devices or when the native app ships.
- **Long-lived sessions with silent refresh**, so a shift never hits a login screen
- Platform-aware install step, because the two differ and getting it wrong costs you notifications:
  - **Android/Chrome** — a real install prompt; push works without installing, but install anyway
  - **iOS/Safari** — push only works *after* Add to Home Screen, so the flow walks through the Share
    sheet explicitly with a screenshot, then requests permission from the installed app
- Ends with a **test alert the staff member must tap to confirm.** Setup is not complete until a
  notification has demonstrably arrived on that device — an unverified path is the same as none.
- Re-verification prompt if push later starts failing for that device (subscription expiry is normal
  and otherwise silent)

**Done when:** a new hire goes from "admin types their number" to "tapped a real notification" with
no developer involved, on both an iPhone and an Android device.

### Chunk 6 — Staff queue & response (the make-or-break surface)

**Goal:** the complete loop — a report reaches a phone, someone owns it, and it closes.
**Depends on:** 4, 5. **Demo:** file from one phone, respond on another, show the full timeline.

Staff respond from their own phones while working outdoors, so this is built as a phone app:
mobile-first layout, installable to the home screen, usable one-handed with a glove on.

- `/app` — live queue via Supabase Realtime, urgent first then oldest, scoped to the staff member's
  departments. No dashboard, no chrome: the open reports fill the screen.
- **Acknowledge claims the report** — the card updates live for everyone else showing who has it, so
  five people don't drive to the same bunker; claims can be released or reassigned
- **One-tap re-route** to another department when triage got it wrong, writing a `reassigned` event
- **Close as "no action needed"** with a reason (invalid / duplicate / no action), excluded from
  resolution metrics but kept for volume and abuse analysis
- **Staff can file reports** using the Chunk 3 form, plus a pro-shop "reported by phone" relay mode
- **Per-report timeline** rendering `report_events` — filed, triaged, routed, notified, acknowledged,
  escalated, resolved, with names and timestamps
- Bilingual EN/ES throughout, including notification bodies, driven by `preferred_language`
- Report card: hole number large, time-open counter, category, the filer's verbatim text, photo,
  and **one** primary action button sized for a thumb at the bottom of the screen
- Acknowledge → In progress → Resolve. Acknowledge is a single tap and must never require typing;
  only Resolve asks for a note, and that accepts voice dictation
- **Resolve = the assignee marks it done, with an optional comment.** Optional photo, never required.
  A **Schedule for later** option with a date is the honest alternative to a false Resolve when a
  part is on order. Reopen is available to staff and links back to the resolution it invalidates.
- **Closing the loop on resolve.** After the internal note, the staff member picks a club-approved
  member-facing message (or writes one) and it publishes to the member's status page, plus SMS if
  they opted in. Two guardrails: the internal note is never shown to a member, and quiet hours
  suppress the text until morning — nobody gets a 10pm message about a ball washer. Closing as
  "no action needed" sends a neutral acknowledgement or nothing, per club setting, and never the
  internal reason.
- **Persistent login** — no session expiry mid-shift. Staff will not re-authenticate at hole 14.
- **Offline tolerance** — queue actions locally and sync when signal returns; large parts of a golf
  course have no usable data. An acknowledge tap that silently fails is worse than no app.
- Web Push subscription prompted on first login, after an install-to-home-screen step; service
  worker + VAPID
- Sunlight-legible: high contrast, large type, no thin grey-on-grey

**Done when:** a report filed on one phone is acknowledged and resolved on another, offline actions
sync after airplane mode, and the timeline shows every step with names and times. The reporting
member's status page updates on resolve showing the member-facing message and **not** the internal
note, and an opted-in member receives the SMS — suppressed until morning if resolved during quiet
hours.

### Chunk 7 — Station mode

**Goal:** counter-based departments get reliable alerting without depending on mobile push.
**Depends on:** 6. **Demo:** a pro shop screen that chimes and banners the moment a report lands.

`/app?station=1`, or a per-profile default, for pro shop and F&B counters:
- Full-screen board of that department's open reports, readable from a few feet away
- **Audible chime plus a visual banner** on new assignment, with a per-station volume/mute control
  and a "sound test" button — a silent alert on a counter PC is the most likely way this fails quietly
- Realtime subscription with a heartbeat and a visible "connected / reconnecting" indicator, plus a
  slow poll as a fallback. A tab that has been open since 6am must not go stale without saying so.
- Wake-lock so the screen doesn't sleep; auto-reconnect after network blips
- Claim/assign so two counter staff don't both walk out to the same problem

**iOS caveat, stated plainly:** since staff are on their own phones, notification delivery *is* the
product — and web push on iOS only works after the user adds the site to their home screen, with no
guarantee for time-critical alerts. For the pilot, **SMS is the primary channel for urgent reports
and web push is the convenience layer.** Budget for Twilio from day one and treat the native app in
Chunk 14 as the real fix, not a nice-to-have.

**Done when:** a station tab left open all day still alerts audibly, shows its connection state
honestly, and two counter staff can't both claim the same report.

### Chunk 8 — Escalation, SLA & watchdog

**Goal:** nothing stays open silently, and nothing fails silently.
**Depends on:** 6. **Demo:** leave a report untouched and watch it climb to management on its own.

`pg_cron` runs every minute → `escalate` Edge Function:
- Open reports past `ack_sla_minutes` → level 1: notify department supervisor
- Still open past `resolve_sla_minutes` → level 2: notify management
- Each step writes an `escalated` event and re-notifies; escalation is idempotent per level
- Course-level quiet hours, excluded from SLA clocks as well as from paging

Shipped in the same chunk, because escalation is worthless if the machinery under it is dead:
- Notification retry with backoff, SMS fallback on push failure, dead-letter + alert
- **Dead-man's switch** heartbeat from the sweeper, so a failure of the monitors is itself noticed
- Sentry, structured Edge Function logs, and alarms on untriaged reports and queue depth

**Done when:** a report with a 5-minute SLA climbs the chain unattended; killing `pg_cron` triggers
an external alert rather than silence.

### Chunk 9 — Admin console, QR sheets & GM day view

**Goal:** a course can be configured and run without a developer. **Depends on:** 5, 8.
**Demo:** hand a GM the console and let them add staff, change an SLA, and print the QR sheet.

Built for a manager at a desk, not a phone:
- Staff, departments, locations, routing rules, SLAs, quiet hours — all editable
- **QR placard generator**: print-ready PDF placards for every location, club-branded with logo and
  colors at real placard dimensions and bleed — these go on tee boxes at a club, so they're a design
  deliverable, not a screenshot. Regenerable per location if a sign is defaced or a token leaks.
- Locations grouped by venue, for 36/54-hole properties
- Per-person performance metrics visible to management roles only, not club-wide
- Live all-departments board — the course-wide view staff deliberately don't get
- **GM day view**: open reports right now, today's count, median acknowledge time. Full analytics
  waits for Chunk 11, but the person signing the check needs to see it working on day one.

**Done when:** a non-technical manager completes setup of a new course start to finish, unaided.

---

### ▶ Launch at the first club (a paying customer, not a pilot)

There is a club ready to install and pay. That raises the bar: a paying high-end club with a
member-facing surface has no tolerance for "we'll fix that during the pilot," and the first
impression is made once. Two things follow.

**Timeline: weeks, at full quality.** Compressed schedule, not a reduced product. The way that works
is shipping *complete* chunks in order and letting the club start using the finished ones — staff-only
use needs Chunks 1–6, which can be live quickly, while 7–9 are built behind it. A staged rollout is
not a half-built product; every chunk is finished when it ships.

**What does not get cut under time pressure**, because these are exactly what people drop when
rushed and exactly what produces the visible failures at a paying club:
- RLS tests (Chunk 2) — cross-tenant leakage is unrecoverable reputationally
- The queue-and-sweeper guarantee (Chunk 4) — the alternative is reports silently vanishing
- Verified notification onboarding (Chunk 5) — an unconfirmed alert path is a missed report
- Offline tolerance (Chunk 6) — dead zones on the course are not an edge case
- The watchdog (Chunk 8) — without it, a failure is discovered by an angry member

**Terminology: "placards"** are the physical QR signs — the printed, mounted markers on each tee box
and facility that members scan. They're the entire member-facing entry point, they take weeks of
design/print/install lead time, and they encode the production domain permanently. That's why the
domain decision and the placard design start during Chunk 3, well before the software is finished.

**Roll it out in stages, not all at once.**

| Stage | Duration | Who can file | Why |
| --- | --- | --- | --- |
| 1. Staff-only | 1–2 weeks | Staff app + **temporary printed QR codes**, no permanent placards | Proves routing, notifications, and escalation against real course conditions with nobody watching. Staff learn the tool while mistakes are invisible to members. |
| 2. Soft member launch | 1–2 weeks | Placards on a handful of holes, or a members' email to volunteers | Real member traffic at low volume. Tune categories and SLAs against actual wording. |
| 3. Full launch | — | Every location placarded, announced to membership | Only after staff response is habitual and the routing rules have been corrected by real use. |

**Location attribution does not depend on printed placards.** Two separate things are easy to
conflate here:

- **The location model** — every report carries a `location_id`, and that's what routing, analytics,
  and "hole 12 again" all key off. It works identically no matter how the report was entered.
- **The QR placard** — an *entry point* for members, who have no app and no login. It's the fastest
  way for someone standing on a tee to file without typing anything.

Staff already have the app and a location picker, so a groundskeeper files against hole 7 in two
taps with no scan involved. And the QR path itself can be exercised immediately with **QR codes
printed on paper or laminated cards** zip-tied to tee markers — they encode the same tokens and work
exactly like the finished signs. What takes weeks isn't QR codes; it's *club-grade permanent
signage* that a high-end club will accept on its tee boxes.

So stage 1 tests everything, QR scanning included. Stage 3 just replaces paper with real placards.
Putting permanent signage out on day one means debugging routing rules in front of the exact
audience whose opinion you're being paid to protect — and reprinting if the domain or design changes.

**Club data collection — needed before their go-live, not before the build starts.** Development runs
on the demo club, so nothing is blocked waiting on this. But their real configuration has to be
collected and loaded before stage 1, and it's worth doing as one structured intake session with the
GM and superintendent rather than piecemeal over email:
- Location inventory: holes, tees, practice facility, restrooms, halfway house, clubhouse, cart barn
- Venue grouping if the property has more than 18 holes
- Department list and who leads each
- Staff roster: name, mobile number, departments, role, preferred language
- Current service standards, written or verbal — what "fast" means to them per issue type
- Escalation expectations: who gets called when something sits, and after how long
- Quiet hours, seasonal hours, and typical shift patterns
- Brand assets: logo, colors, fonts, and the domain they want
- Who the named support contact is on their side

**Pre-launch work that has real lead time — start these early, they are not code:**
- **Production domain decided and placards printed.** Physical signage has weeks of lead time
  through design, print, and mounting. This blocks stage 2, so it starts during Chunk 3.
- **Course data collected**: hole and facility inventory, department list, staff roster with mobile
  numbers, the club's existing service standards
- **SLA targets agreed with the GM in writing** — these become `routing_rules`, and agreeing them
  before launch avoids relitigating escalation after the first angry escalation
- **Staff onboarding session**: roster loaded, everyone signed in, everyone's test alert confirmed.
  Budget a real session with the crew rather than sending links and hoping.
- **A named support path.** A paying club needs to know who to call when it breaks, and what happens
  at 6am on a Saturday. Decide this before go-live, not after the first outage.
- Signed agreement covering data ownership and member PII handling

Chunks 10–13 stay after launch deliberately — each is a guess until this club has used the system
for a few weeks, and now that guess can be replaced with their actual data.

---

### Chunk 10 — SLA document upload

A manager uploads the course's existing service standards document (PDF or Word) and it configures
the SLA table, instead of someone hand-entering rules for every category.

1. Upload to Supabase Storage, private bucket, scoped to the course
2. Extract text — Claude reads PDFs natively; `.docx` goes through `mammoth` first
3. Claude returns a **structured proposal** via a tool schema: for each rule, the matched category,
   department, `ack_sla_minutes`, `resolve_sla_minutes`, escalation target, a confidence score, and
   **the exact quoted clause it came from**
4. **Review screen before anything takes effect** — proposed rules shown side by side with current
   rules as a diff, each row displaying the source quote and editable inline. The manager approves
   per rule or accepts all; nothing is written to `routing_rules` until they confirm.
5. On apply: write rules with `source_document_id` and `source_excerpt`, mark the document `applied`,
   supersede the previous version. Uploading a revised document produces a new version and a fresh
   diff rather than overwriting history.

**Never auto-apply an extracted SLA.** These documents are ambiguous, contradictory, and full of
clauses that don't map to a category ("respond promptly during peak hours"). A silently-applied
wrong SLA either pages management all day or suppresses escalation entirely — and nobody would know
why. Anything the model can't map with confidence is surfaced as unmatched for manual handling, not
guessed. The stored quote also means that when a rule is later questioned, the answer is the clause
it came from.

**Done when:** a sample SLA document produces a reviewable diff with every rule traceable to a quote,
and nothing is written until a manager approves.

### Chunk 11 — Analytics & monthly reports

**Goal:** the management story, built on real pilot data rather than assumptions.
**Demo:** a month of actual course data with response times by department and person.

Postgres views over `report_events`:
- Volume by category, by location, by hour, by day-of-week
- Median and p90 time-to-acknowledge and time-to-resolve, by department and by person, using the
  two separate clocks defined above
- Recurring-problem detection: same category + same location, repeated within a window
- SLA breach rate and escalation frequency
- Monthly PDF emailed to management, generated by a scheduled function

### Chunk 12 — Duplicate clustering & auto-response

**Goal:** four reports of one sprinkler become one incident, and the later filers get told it's
handled. Built now because pilot volume is what tells you the right clustering window.

Clusters open reports at the same location and category within a window, links them to a parent,
suppresses re-notification, shows "reported by 4 groups" as an urgency signal, auto-responds to
later filers that it's already being handled, and resolves the cluster with the parent.

### Chunk 13 — Demo club data (independent — pull forward whenever a demo is needed)

**Goal:** a club you can put in front of a GM without apologizing for the data.

Depends on nothing but the schema, so it can slot in at any point — but it has to exist before you
demo to club #2, and **before Chunk 11's analytics can be shown to anyone**, since empty views
demonstrate nothing.

- A convincingly high-end named club rather than `Test Course 1` / `Staff User A`: full location
  inventory, the complete department list, and a roster with real-looking names across maintenance,
  cart fleet, pro shop, caddie, F&B, and management
- **Several weeks of already-resolved historical reports** with realistic timestamps — clustered by
  time of day, weighted toward categories that actually recur, with varied response times including
  a few SLA breaches and escalations. Without history, every analytics view and the monthly report
  render empty, which is the least persuasive possible demo of a retention feature.
- `db:reseed` to reset the demo club to a known state so a demo always starts clean
- Demo staff logins that work on a real phone, so a notification can arrive live in a meeting
- These fixtures also become the triage eval set for Chunk 4's regression suite

### Chunk 14 — Native iOS & Android (Expo)

**Goal:** notification delivery that doesn't depend on web push. **Depends on:** 6.

Reuse the Supabase client and all business logic; the app is a native shell over the same queue, and
the same phone-OTP identity from Chunk 5 — nobody re-registers. APNs/FCM push with a critical-alert
entitlement request so urgent reports break through silent mode: the single capability the web
version cannot match.

---

## Repository layout

```
proresponse/
├── app/
│   ├── r/[courseSlug]/[token]/     # member reporter — no auth, form only
│   ├── s/[trackingToken]/          # member status page — no auth, read-only, one report
│   ├── app/                        # staff queue (auth)
│   ├── admin/                      # course config (manager)
│   └── api/
├── components/ui/                  # shadcn
├── lib/
│   ├── supabase/{client,server,admin}.ts
│   ├── triage/{keywords.ts,classify.ts,route.ts}
│   └── notify/{push.ts,sms.ts}
├── supabase/
│   ├── migrations/
│   ├── functions/{triage,escalate,notify,monthly-report}/
│   └── seed.sql
└── public/sw.js                    # push service worker
```

---

## Verification

**Per chunk** — each is the acceptance test for that chunk, run before moving on:
- **1** — A push to `main` deploys; CI goes green on a PR
- **2** — A staff JWT for course A returns zero rows from course B, as an automated test
- **3** — Submit from a real phone; confirmation renders in <1s; verbatim text, compressed photo with
  EXIF stripped, and the queue row all land in one transaction
- **4** — Run the 20-report fixture set; assert category and department per case, and that an
  ambiguous one lands in `needs_review`. **Then disable the DB webhook and submit a report** — it
  must still route within a sweeper cycle. Then set every maintenance member off-duty and confirm the
  report climbs to leadership with an `unstaffed` event. These two prove the system can't fail quietly.
- **5** — Onboard a real person end to end on an iPhone *and* an Android phone, finishing with a
  tapped test notification. Confirm deactivation kills the session immediately.
- **6** — File from one phone, respond on a second real phone without a refresh; acknowledge and
  resolve one-handed; toggle airplane mode mid-action to confirm the offline queue; re-route a report
  and confirm the `reassigned` event; check legibility outdoors in direct sun, not in a simulator.
  **Then verify the loop-back**: the member's status page shows the member-facing message and never
  the internal note, a guessed or altered tracking token returns nothing, and a resolution during
  quiet hours holds the SMS until morning
- **7** — Leave a station tab open for hours, confirm it still chimes and reports its connection state
  honestly; confirm two people can't both claim one report
- **8** — Seed a report with a 1-minute SLA and watch it escalate unattended; then stop `pg_cron` and
  confirm the external heartbeat alerts you
- **9** — Hand the console to someone non-technical and have them set up a course unaided
- **10** — Upload a sample SLA document; confirm every proposed rule carries its source quote, vague
  clauses land in "unmatched" rather than guessed, and `routing_rules` is untouched until apply. Then
  upload a revision and confirm it diffs instead of overwriting.
- **11** — Compare a view's median resolve time against hand-calculated fixture data

**End-to-end pilot rehearsal before any real course sees it:** print the QR sheet, walk the demo
course data, file five reports of different types from a real phone, and confirm each reached the
right person and closed cleanly with a full audit trail.

---

## Risks worth naming now

1. **iOS push is not dependable for urgent alerts on the web.** Mitigated by SMS-first for urgent
   reports; solved properly in Chunk 14. Don't sell "instant alerts" to a course on the web tier alone.
2. **Garbage and joke reports.** Signed QR tokens, rate limiting, and a `needs_review` bucket keep
   noise out of the staff queue rather than filtering it after the fact.
3. **Routing rules are the product, not the AI.** Classification is cheap and replaceable; the
   category → department → person mapping is what a course actually buys. Keep it in data, editable
   by a manager, never in a model prompt.
4. **Staff adoption is the real failure mode — and the competition is the radio.** Radios are
   instant, free, and already habitual. If ProResponse becomes a second system staff update *after*
   handling something by radio, it degrades into data entry, and data entry gets abandoned by week
   three. The app has to be the fastest way to do the job, not the place you record having done it:
   one-tap acknowledge, no login friction during a shift, no typing until resolve. Watch week 3 of
   the pilot — unprompted use then is the signal that matters, more than any feature list.
5. **Pace of play is the most-requested category and the weakest fit.** It's the top complaint, so
   it will dominate early reports — but by the time a slow-play report routes, the group has moved on
   and the marshal usually already knows. Sold as a pace-of-play fix, this disappoints. Sold on
   maintenance, carts, and facilities — where a report is genuinely actionable and currently gets
   lost — it delivers. At a club the pattern data is the real value here: "holes 4 and 12 back up
   every Saturday morning" is a course-management insight a superintendent can act on, which is a
   better pitch than promising to speed up the group ahead.
6. **Scope creep into analytics.** Chunk 11 is genuinely valuable for renewals, but it's worthless
   without months of real reports. Ship Chunks 1–9, run a pilot, then build reports against real data.
7. **Silent triage failure is the worst-case bug.** Reports stop routing, the UI looks fine, and the
   course finds out from an angry member. The Chunk 8 watchdog is not optional polish.
8. **Cross-tenant data leakage ends the business.** RLS from the first migration, with tests that
   fail the build — never a manual check.
9. **SMS is a real recurring cost and a legal surface.** Budget per-course message volume, cap it,
   and get golfer consent language right before the first outbound text.
