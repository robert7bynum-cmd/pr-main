/**
 * Run a database command against staging instead of production.
 *
 *   npm run staging:check     report what staging has, change nothing
 *   npm run staging:migrate   apply every migration to staging
 *
 * The connection string lives in .env.local as STAGING_DB_URL and is read by
 * Node's own --env-file parser, which understands quoting. An earlier version
 * of this sourced the file as shell: a line that was not a KEY=value
 * assignment then ran as a command and echoed part of itself into the error,
 * which is how a staging password once reached a transcript. Nothing here
 * executes the file, and no message ever prints the value.
 *
 * SUPABASE_DB_URL is left alone. It stays pointed at production, so there is
 * no swap-it-back step to forget.
 */
const STAGING_REF = "sywwnifudqfupyshufuy";
const PROD_REF = "nfyshykwwtiwkluwiuyf";

const url = process.env.STAGING_DB_URL?.trim();

if (!url) {
  console.error(`STAGING_DB_URL is not set in .env.local.

The password cannot be looked up. This project was created through the API,
so Supabase generated one and showed it to nobody. Reset it to get one:

  https://supabase.com/dashboard/project/${STAGING_REF}/database/settings

Click "Reset password", copy the new one (it is shown once), then add one
WHOLE line to .env.local — the variable name and the full URL, not just the
password on its own:

  STAGING_DB_URL=postgresql://postgres.${STAGING_REF}:YOURPASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres

Session pooler, port 5432. Not the 6543 transaction pooler, and not the
direct connection, which is IPv6-only without the paid add-on.

Leave SUPABASE_DB_URL alone — it stays pointed at production.`);
  process.exit(1);
}

// Aiming this at production is the one way it could do harm.
if (url.includes(PROD_REF)) {
  console.error("REFUSING: that names the production project. Not printing it.");
  process.exit(1);
}
if (!url.includes(STAGING_REF)) {
  console.error(`REFUSING: that does not name project ${STAGING_REF}. Not printing it.`);
  process.exit(1);
}

process.env.SUPABASE_DB_URL = url;

const mode = process.argv[2];

if (mode === "migrate") {
  console.log(`Applying migrations to staging (${STAGING_REF})…\n`);
  await import("./apply-migrations.mts");
} else if (mode === "check") {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
  } catch (e) {
    // A stack trace from the driver tells a person nothing they can act on.
    // These three are the whole failure space in practice.
    const m = e instanceof Error ? e.message : String(e);
    if (/password authentication failed/i.test(m)) {
      console.error(
        "Staging refused the password.\n\n" +
        "Everything else is right — it reached the host and the username was\n" +
        "accepted. Only the password is wrong. Reset it at\n" +
        `  https://supabase.com/dashboard/project/${STAGING_REF}/database/settings\n` +
        "and replace YOURPASSWORD in the STAGING_DB_URL line of .env.local.",
      );
    } else if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(m)) {
      console.error(
        `Could not reach staging: ${m}\n\n` +
        "Check the host is aws-0-us-east-1.pooler.supabase.com on port 5432.\n" +
        "The direct db.*.supabase.co host is IPv6-only without the paid add-on.",
      );
    } else {
      console.error(`Staging connection failed: ${m}`);
    }
    process.exit(1);
  }
  const t = await c.query<{ n: number }>(
    `select count(*)::int n from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  let applied = 0;
  try {
    applied = (await c.query<{ n: number }>("select count(*)::int n from schema_migrations")).rows[0].n;
  } catch { /* table absent on an empty project */ }
  console.log(`staging: ${t.rows[0].n} tables, ${applied} migrations applied`);
  await c.end();
} else {
  console.error("usage: npm run staging:check | npm run staging:migrate");
  process.exit(1);
}
