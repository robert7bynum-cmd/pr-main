# ProResponse — where we left off

Last updated: 2026-09-06. Target: **demo to Beacon Hill Golf Club, Fri 11 Sep 2026.**

Production is `https://pr-main-dun.vercel.app` (Vercel project `pr-main`, branch
`main`, Supabase project `proresponse-dev`). `GET /api/health` on any deployment
reports the commit it is serving. Nothing is shipped until that commit contains
it — a green build is a build.

## Restarting

```bash
cd ~/code/proresponse
npm run dev            # http://localhost:3000/r/beacon-hill/bh-h07
```

Without `NEXT_PUBLIC_SUPABASE_URL` in `.env.local`, `dev` boots PGlite with the
real migrations and the Beacon Hill seed. With it, the app talks to the shared
project — and so does every preview deployment (`docs/deploying.md`).

## Verification

| Command | What it does | Needs |
| --- | --- | --- |
| `npm run lint` | ESLint | nothing |
| `npx next typegen && npx tsc --noEmit` | Types; `typegen` first on a fresh checkout | nothing |
| `npm run verify:offline` | Every throwaway-Postgres suite — CI runs this on every push | nothing |
| `npm run verify:live` | Every suite that needs the real project; each creates and removes its own fixtures | `.env.local` |
| `npm run db:validate` | Applies migrations + seed to PGlite | nothing |
| `npm run db:check` | Asserts the seed data is demo-worthy | nothing |
| `npm run triage:eval` / `triage:coverage` | Keyword fixtures and adversarial probes against the SQL `match_keywords` — the one production runs | nothing |
| `npm run test:routing` / `test:actions` / `test:escalation` | SQL logic suites | nothing |
| `npm run test:table-authz` | A signed-in staff member cannot write `reports`, `report_events`, `routing_rules` or another person's push device directly | nothing |
| `npm run test:delivery-gate` | The cron gate fires only when work is actually due, including a retry waiting out its backoff | nothing |
| `npm run test:watchdog` | `system_health()` and the alert ledger | nothing |
| `npm run test:rls` | **Anonymous access to every table and view**, reads and a write | Supabase |
| `npm run test:e2e` | A member files a report; the person who was notified sees it on their screen | Supabase |
| `npm run test:accounts` / `test:account-guards` / `test:authz` | Invitation, password, privilege guards against the live project | Supabase |
| `npm run test:invite-journey` | Being added this loop: invite → redeem → sign in as the invited person, live, cleaning up after itself | Supabase |
| `npm run db:apply` | Apply new migrations to Supabase (tracked in `schema_migrations`, safe to re-run) | Supabase |
| `npm run db:reset-demo` | seed → demo users → freshen, the only order that works | Supabase |
| `npm run db:freshen` | **Re-anchor demo data to now — run before any demo** | Supabase |
| `npm run invite -- email "Name" role` | Invite a staff member | Supabase |
| `npm run check:env` | The environment preflight the build runs | nothing |

Gone on purpose: `triage:model` (the model pass lives inside the edge function;
`triage:eval` covers the matcher in front of it) and `test:matcher` (there is one
matcher now, so there is nothing for the SQL to agree with).

## Live

Everything below exists in the code on `main`. What production is serving at any
moment is whatever `/api/health` says.

- **Member form** — `/r/[courseSlug]/[token]`, scan → form that already knows the
  hole → one-shot submit → confirmation. Scan nonces stop replay.
- **Triage** — the `triage` edge function beside the database, kicked the moment a
  report is queued and swept by `pg_cron`. SQL keyword matcher first, Claude Haiku
  for what falls through. Verified running unattended against the real project.
- **Routing and escalation** — `routing_rules` decides who is paged; leadership
  fallback when nobody is on duty; SLA breaches escalate; urgent reports escalate
  through quiet hours.
- **Staff auth** — password sign-in, email invitations redeemed at `/join`,
  self-service password change, no one-click demo personas.
- **Staff queue** — scoped to you (your departments, what you were notified about,
  what you claimed); realtime with a 20-second poll behind it; station chime;
  claim, assign to a named person, resolve, schedule, re-route, close.
- **Per-report timeline** — `/app/report/[id]`, the whole `report_events` trail.
- **Web push** — service worker, per-device subscriptions, delivery with backoff.
- **GM dashboard** — `/app/dashboard`, every figure derived from `report_events`,
  system health shown only when something is wrong.
- **Staff management and rules editor** — `/app/staff`, `/app/rules`, every change
  through a definer function and recorded in `admin_events`.
- **QR placards** — `/app/placards`, print-ready SVG; refuses to print on a preview.
- **Watchdog** — heartbeat + `system_health()` inside the database; `/api/watchdog`
  outside it on Vercel cron, once a day on the Hobby plan, 503 until `CRON_SECRET`
  is set.
- **Deployment** — Vercel, previews per branch; CI runs lint, types and
  `verify:offline` on every push.

## Not built

The organisational half in `CLAUDE.md` (access reviews, admin audit-log review,
incident response, subprocessor register, restore testing, retention, alerting on
the monitoring gaps), plus:

- **Self-serve placards** — a club cannot add or rename a location and print its
  own code; every placard is seeded.
- **SMS** — Twilio A2P 10DLC registration was never filed; the env vars are
  placeholders and nothing reads them.
- **Member status page** — removed on purpose in `a812a92`. The member gets a
  confirmation and nothing else; do not rebuild it without deciding what the
  tracking token is allowed to reveal.
- **Supabase Vault for `app_settings`** — the Anthropic key and the edge-function
  URL sit in a service-role-only table, not in Vault.
- **A database for previews** — every preview writes production's rows
  (`docs/deploying.md`).
- **Watchdog cadence** — daily is a floor. An external pinger every five minutes,
  or Vercel Pro, is what "dead for ten minutes" needs.

## Waiting on Bobby

| Item | Blocks | Notes |
| --- | --- | --- |
| `CRON_SECRET` in Vercel Production | the external watchdog — the route answers 503 until it exists | `openssl rand -hex 32`; Settings → Environment Variables, exactly this name; redeploy |
| Leaked-password protection in Supabase Auth | staff choosing a password already in a breach corpus | Authentication → Settings → Password |
| Custom domain for placards | printing any placard | QR codes encode the origin permanently; a `vercel.app` placard dies with the project name |
| Twilio A2P 10DLC | go-live, not the demo | 1–3 weeks, can be rejected — file early |
| Beacon Hill logo / hole names / staff | demo polish | seed has plausible stand-ins |

## Decisions worth not relitigating

- **The model classifies; data routes.** `routing_rules` decides who gets paged, so
  changing models can never reroute anyone.
- **The database owns the work, not a webhook.** A report and its `triage_queue` row
  commit together; the insert trigger and the DB webhook are only fast paths.
- **`report_events` is the source of truth** for every metric — status columns are
  for the UI.
- **The member surface is a form and nothing else.** No app, no account, no status
  page; the QR token auto-resolves the location.
- **Internal `resolution_note` and member-facing `member_message` are separate
  fields** and must stay that way.
- **One matcher.** Rules are data in `lib/triage/keywords.ts`; the matcher is
  `match_keywords` and the suites call it, not a copy.
- **Every mutation is a definer function, never a table write.** The UI hiding a
  control is a courtesy; the function refusing it is the protection.
- **No SMS before the demo** — A2P registration cannot clear in time.
