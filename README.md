# ProResponse

A member on a golf course scans the QR placard on the hole, types one sentence
about what is wrong, and the right team is paged. Staff work a queue scoped to
their own departments, acknowledge, and resolve with two notes — one the member
sees and one they never do. Anything that waits too long escalates to
leadership. The GM gets a dashboard whose every number derives from the event
trail. There is no member app and no member account: the member surface is one
form.

## How it fits together

- **Next.js 16 on Vercel.** The staff app (`/app`, `/app/dashboard`,
  `/app/staff`, `/app/rules`, `/app/placards`, `/app/report/[id]`), staff auth
  (`/login`, `/join`, `/account`), and the member form
  (`/r/[courseSlug]/[token]`). Server actions call RPCs; nothing writes a table
  directly.
- **Supabase Postgres.** RLS on every table, `security_invoker` on every view,
  and `anon` holds no table privileges at all. Every mutation is a
  `SECURITY DEFINER` function that checks the caller and writes a
  `report_events` row; every metric is derived from those events.
- **pg_cron + pg_net.** Scheduling lives inside the database: the triage gate,
  escalation, and a heartbeat on every sweep. `system_health()` reads what the
  database can see about itself and the dashboard shows it only when something
  is wrong.
- **One edge function, `triage`** (`supabase/functions/triage`). The SQL
  keyword matcher `match_keywords` runs first; Claude Haiku is called only for
  what falls through. The model classifies; `routing_rules` decides who is
  paged. The same invocation delivers web push, with backoff and retry.
- **Web push.** `public/sw.js` and per-device subscriptions. The external half
  of the watchdog, `/api/watchdog` on Vercel cron, reads health with the
  service role and pushes to management directly rather than queueing work for
  the scheduler it is watching.

## Running locally

```bash
npm install
npm run dev     # http://localhost:3000/r/beacon-hill/bh-h07
```

With `NEXT_PUBLIC_SUPABASE_URL` unset, `npm run dev` boots a real Postgres
in-process (PGlite) and applies the actual migrations and the Beacon Hill demo
seed — see `lib/dev-db.ts`. Editing a migration or the seed rebuilds it. To run
against a real project, copy `.env.example` to `.env.local` and fill in the
Supabase variables.

## Verifying

Two tiers. The offline tier needs nothing and is what CI runs on every push;
the live tier needs `.env.local` pointed at a real Supabase project, and every
live suite creates its own fixtures and removes them.

| Command | What it does | Needs |
| --- | --- | --- |
| `npm run lint` | ESLint | nothing |
| `npx next typegen && npx tsc --noEmit` | Types. `typegen` first on a fresh checkout | nothing |
| `npm run verify:offline` | Every offline suite, in order: `db:validate`, `db:check`, `triage:eval`, `triage:coverage`, `test:conformance`, `test:routing`, `test:actions`, `test:grants`, `test:alerts`, `test:watchdog`, `test:nonce`, `test:queue`, `test:staff`, `test:escalation`, `test:escalation-sim`, `test:placard-origin`, `test:badges`, `test:delivery-gate`, `test:table-authz` | nothing |
| `npm run verify:live` | `test:rls` (anonymous access to every table and view), `test:placards`, `test:accounts`, `test:authz`, `test:reconciliation`, `test:e2e` (member files, the notified person sees it), `test:realtime`, `test:account-guards` | `.env.local` |
| `npm run verify` | Both tiers | `.env.local` |
| `npm run db:validate` | Applies every migration and the seed to a throwaway Postgres | nothing |
| `npm run db:apply` | Applies new migrations to Supabase; tracked in `schema_migrations`, forward-only, one transaction each | `SUPABASE_DB_URL` |
| `npm run check:env` | The same environment preflight the build runs | nothing |

A green suite is not a deployment. `GET /api/health` on any deployment reports
the commit it is serving; read that before saying a change is live.

## Deploying

Vercel builds every push; `main` is production, every other branch a preview.
What each environment needs, what a preview deliberately cannot do, and why
previews currently share production's database are in
[docs/deploying.md](docs/deploying.md).

## Rules

[CLAUDE.md](CLAUDE.md) is the engineering rulebook. Each rule names the bug that
produced it. Read it before changing anything; it is a checklist, not advice.
[STATUS.md](STATUS.md) is the resume point — what is live, what is not, and what
is waiting on a human. [CHANGELOG.md](CHANGELOG.md) is the running record, bugs
marked.
