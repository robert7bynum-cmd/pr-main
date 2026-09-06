# ProResponse — where we left off

Last updated: 2026-09-04. Target: **demo to Beacon Hill Golf Club, Fri 11 Sep 2026.**

The full plan lives at `~/.claude/plans/i-want-to-create-velvety-valiant.md` (14 chunks,
architecture, risks). This file is just the resume point.

## Restarting

```bash
cd ~/code/proresponse
npm run dev            # http://localhost:3000/r/beacon-hill/bh-h07
```

| Command | What it does | Needs |
| --- | --- | --- |
| `npm run db:validate` | Applies migrations + seed to throwaway Postgres (PGlite) | nothing |
| `npm run db:check` | Asserts the seed data is demo-worthy | nothing |
| `npm run triage:eval` | Keyword regression suite: 75 fixtures against the SQL matcher in PGlite (free) | nothing |
| `npm run triage:coverage` | Per-category coverage + adversarial probes (free) | nothing |
| `npm run test:rls` | **Anonymous-access check on every table and view** | Supabase |
| `npm run test:routing` / `test:actions` | SQL logic suites (36 cases) | nothing |
| `npm run db:apply` | Apply new migrations to Supabase (tracked, so safe to re-run) | Supabase |
| `npm run db:freshen` | **Re-anchor demo data to now — run before any demo** | Supabase |
| `npm run db:audit` | Check how the demo data currently reads | Supabase |
| `npm run invite -- email "Name" role` | Invite a staff member | Supabase |

## Done

- **Schema, RLS, member RPCs** — 4 migrations, verified against real Postgres. RLS on
  every table in the same migration that creates it; members get no table access at
  all, only `submit_report` and `get_report_status`.
- **Beacon Hill demo seed** — 220 reports over 41 days, 24 locations, 9 staff,
  17 live tickets, median 7 min ack / 69 min resolve. Verified, not assumed.
- **Triage, both passes** — 226 keyword rules (free, 0 misroutes across 75 fixtures
  and 12 adversarial probes) plus a Claude Haiku pass for the ~21% that fall through.
  Blended cost ≈ $0.0003 per submitted report.
- **Member reporter page** — `/r/[courseSlug]/[token]`, Beacon Hill branded, scan →
  branded form that already knows the hole → submit → confirmation. Verified in a
  375px viewport end to end.
- **Routing engine** — leadership fallback when a department has nobody on duty,
  idempotent routing, SKIP LOCKED claiming, exponential backoff to dead_letter.
  15 tests (`npm run test:routing`).
- **Staff actions** — claim-on-acknowledge, resolve with separate internal note and
  member-facing message, schedule-for-later, re-route, close-no-action.
  21 tests (`npm run test:actions`).
- **Staff queue UI** — `/app`, urgent-first then oldest-waiting, department filter
  chips with live counts, claim and resolve working end to end.
- **Local dev database** — the app runs the real migrations and the real Beacon Hill
  seed in-process via PGlite, so everything above is demonstrable without Supabase.
  Rebuilds automatically when any migration or the seed changes.
- Next.js 16, shadcn/ui (15 components), Supabase client wrappers.

## Not built yet

In demo-priority order:

1. **Staff auth** — magic link. Actions currently attribute to a seeded supervisor
   in dev and refuse to run in production, so this gates any real deployment.
2. **Per-report timeline** — renders `report_events`, nearly free, settles every
   "nobody told us" conversation
3. **Notification delivery** — web push, and the station-mode chime
4. **GM dashboard** — reads the seeded history that already exists
5. **Vercel deploy** — required for the demo: a phone cannot reach localhost

## Blocked

- **Supabase was down all day.** No project exists, so nothing has run against a real
  database. Schema and seed are verified against PGlite instead. Applying should be
  ~30 minutes once they are up: fill `.env.local`, `npm run db:push`, load the seed.
- **The reporter's submit path is only proven against a local fixture**, not the real
  RPC. First thing to re-verify once Supabase exists.

## Waiting on Bobby

| Item | Blocks | Notes |
| --- | --- | --- |
| Supabase project + 3 keys | everything data-backed | Settings → API; paste into `.env.local` |
| Vercel (sign up via GitHub) | the demo itself | repo is already on GitHub |
| Twilio A2P 10DLC | go-live, not the demo | 1–3 weeks, can be rejected — file early |
| Domain (~$12) | printing any placard | QR codes encode it permanently |
| Beacon Hill logo / hole names / staff | demo polish | seed has plausible stand-ins |

`ANTHROPIC_API_KEY` is already in `.env.local` and working.

## Decisions worth not relitigating

- **The model classifies; data routes.** `routing_rules` decides who gets paged, so
  changing models can never reroute anyone.
- **The database owns the work, not a webhook.** A report and its `triage_queue` row
  commit together; the DB webhook is only a fast path.
- **`report_events` is the source of truth** for every metric — status columns are
  for the UI.
- **The member surface is a form and nothing else.** No app, no account; the QR token
  auto-resolves the location.
- **Internal `resolution_note` and member-facing `member_message` are separate
  fields** and must stay that way.
- **No SMS before the demo** — A2P registration cannot clear in time.
