# Deploying — production and previews

Every push to GitHub builds. `main` becomes production; every other branch
becomes a **preview deployment** at its own URL, which is how a change gets
looked at on a real phone before it reaches the club.

This is Vercel's default behaviour once the repository is connected. What
follows is the configuration that makes it *safe* here, and the things a
preview deliberately cannot do.

---

## One-time setup

These are dashboard actions on `robert7bynum-cmd/pr-main`; nothing in the repo
can do them.

1. **Connect the repository.** Vercel → Add New → Project → import
   `robert7bynum-cmd/pr-main`. Framework is detected as Next.js; leave the
   build and output settings alone — the build command in `package.json`
   already runs the environment preflight.
2. **Set environment variables** (next section) before the first deploy, or the
   preflight will fail the build and tell you which are missing.
3. **Turn on deployment protection.** Settings → Deployment Protection →
   Vercel Authentication, applied to **preview deployments**. Without it a
   preview URL is a public, unauthenticated door to whatever database that
   preview points at. This matters more than usual here because previews share
   the production Supabase project — see *The shared database* below.
4. **Production branch** is `main`. Settings → Git → Production Branch.

## Environment variables

Vercel scopes each variable to Production, Preview and Development
independently. The build refuses to proceed when a required one is missing, so
a mis-configured deploy fails at build time rather than showing a blank screen
to whoever opens the link.

| Variable | Production | Preview | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | required | required | Inlined into the client bundle at build time |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | required | required | Publishable key. Also inlined |
| `SUPABASE_SERVICE_ROLE_KEY` | required | required | Server only. Never on a `NEXT_PUBLIC_` line |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | required | recommended | Missing means staff cannot subscribe to push |
| `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | required | optional | Read by the Supabase edge function, not the app |
| `ANTHROPIC_API_KEY` | required | optional | Second-pass triage. Lives in `app_settings` for the edge function |
| `TRIAGE_WORKER_SECRET` | required | optional | Guards `/api/triage/run` |
| `SUPABASE_DB_URL` | not needed | not needed | Migrations are run from a laptop, not from a deploy |
| `DEMO_SIGNIN` | **never** | `true` | One-click personas. The build fails if this is `true` in production |

`npm run check:env` runs the same checks locally.

Beyond the missing-variable check, the preflight hard-fails on three things: a
service-role key on any `NEXT_PUBLIC_` variable, the service key and the
publishable key being identical, and `DEMO_SIGNIN=true` in production. It never
prints a value.

## What a preview cannot do

A preview is a full copy of the app, but four things do not follow it:

- **Scheduled work does not run.** Triage and escalation are driven by
  `pg_cron` inside Supabase, calling the one URL stored in
  `app_settings.worker_url`. That is production. A report submitted on a
  preview is triaged by *production's* worker, or not at all — nothing about a
  preview is wired into cron, and nothing will be. To exercise triage on a
  branch, call the endpoint yourself.
- **Push notifications need re-subscribing.** A service worker and its push
  subscription belong to an origin, and every preview is a new origin. Staff
  test accounts will show as unsubscribed on each new branch URL. That is
  correct behaviour, not a bug.
- **Placards must not be printed.** The QR codes encode the origin they were
  rendered from, and a preview origin dies with its branch. `/app/placards`
  refuses politely: on a preview it shows a warning on screen and stamps one
  across the printed sheet.
- **`vercel.app` URLs are not indexed.** Vercel sends `X-Robots-Tag: noindex`
  on preview deployments. Deployment protection is still the thing keeping
  people out; noindex only keeps search engines out.

## The shared database

There is one Supabase project (`proresponse-dev`). Production and every
preview read and write the same rows. A destructive change tested on a branch
is a destructive change to the demo data, and `npm run db:reset-demo` is the
way back.

This is fine while the only data is a seeded demo club, and it is not fine once
a real club is on it. The two ways out, when that day comes:

- **Supabase branching** — a database branch per Git branch, wired to the same
  PR. Requires a paid Supabase plan; migrations in `supabase/migrations` are
  already forward-only and tracked, which is what it needs.
- **A second Supabase project** for previews, with the seed loaded into it and
  the preview-scoped environment variables pointed at it.

Neither is set up. Until one is, treat a preview as capable of changing
production data, because it is.

## Verifying a deployment

`GET /api/health` on any deployment answers which one it is:

```json
{
  "env": "preview",
  "commit": "9300fd3",
  "branch": "fix/queue-ordering",
  "url": "https://pr-main-git-fix-queue-ordering-....vercel.app",
  "database": "ok",
  "supabase": "abcdefgh.supabase.co",
  "demoSignIn": true,
  "push": true,
  "scheduledWork": "no — cron never targets a preview"
}
```

It returns 503 when the database cannot be reached, so a preview that built
green but cannot talk to Supabase says so without anyone having to sign in. It
exposes no secrets and reads no rows.
