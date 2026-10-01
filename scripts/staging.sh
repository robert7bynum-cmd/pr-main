#!/bin/bash
# Run a database command against staging instead of production.
#
# The staging connection string lives in .env.local as STAGING_DB_URL and is
# never printed, never passed on a command line, and never shown to anyone
# reading a transcript. This script sources it, checks it really is staging,
# and hands it to the migration runner as SUPABASE_DB_URL for one command.
#
#   ./scripts/staging.sh migrate   apply every migration to staging
#   ./scripts/staging.sh check     report what is applied, without changing it
#
# Why the guard below: pointing this at production by mistake is the one way
# it could do harm, so it refuses unless the URL names the staging project and
# does not name the production one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAGING_REF="sywwnifudqfupyshufuy"
PROD_REF="nfyshykwwtiwkluwiuyf"

if [ ! -f .env.local ]; then
  echo "No .env.local here." >&2; exit 1
fi

# Sourced, not echoed. set -a exports what the file defines.
set -a; . ./.env.local; set +a

if [ -z "${STAGING_DB_URL:-}" ]; then
  cat >&2 <<'MSG'
STAGING_DB_URL is not set in .env.local.

The password cannot be looked up. This project was created through the API,
so Supabase generated one and showed it to nobody. Reset it to get one:

  https://supabase.com/dashboard/project/sywwnifudqfupyshufuy/database/settings

Click "Reset password", copy the new one (it is shown once), then add one line
to .env.local — Session pooler, port 5432, NOT the 6543 transaction pooler:

  STAGING_DB_URL=postgresql://postgres.sywwnifudqfupyshufuy:YOURPASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres

Use the session pooler rather than the direct connection: direct is IPv6-only
unless you buy the IPv4 add-on, which fails from most laptops.

Leave SUPABASE_DB_URL alone — it stays pointed at production.
MSG
  exit 1
fi

case "$STAGING_DB_URL" in
  *"$PROD_REF"*)
    echo "REFUSING: STAGING_DB_URL names the production project ($PROD_REF)." >&2
    exit 1 ;;
esac
case "$STAGING_DB_URL" in
  *"$STAGING_REF"*) : ;;
  *)
    echo "REFUSING: STAGING_DB_URL does not name the staging project ($STAGING_REF)." >&2
    exit 1 ;;
esac

case "${1:-}" in
  migrate)
    echo "Applying migrations to staging ($STAGING_REF)…"
    SUPABASE_DB_URL="$STAGING_DB_URL" npx tsx scripts/apply-migrations.mts
    ;;
  check)
    echo "Staging ($STAGING_REF) currently has:"
    SUPABASE_DB_URL="$STAGING_DB_URL" npx tsx -e '
      import pg from "pg";
      const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
      await c.connect();
      const t = await c.query("select count(*)::int n from information_schema.tables where table_schema=$1 and table_type=$2", ["public","BASE TABLE"]);
      let m = { rows: [{ n: 0 }] };
      try { m = await c.query("select count(*)::int n from schema_migrations"); } catch {}
      console.log(`  ${t.rows[0].n} tables, ${m.rows[0].n} migrations applied`);
      await c.end();
    '
    ;;
  *)
    echo "usage: ./scripts/staging.sh [migrate|check]" >&2; exit 1 ;;
esac
