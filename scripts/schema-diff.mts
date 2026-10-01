/**
 * Does staging actually match production?
 *
 *   npm run staging:diff
 *
 * A staging environment nobody compares is a staging environment that has
 * quietly drifted, and the whole point of it is to rehearse what production
 * will do. This reads both catalogues and prints only the differences:
 * tables, views, functions with their argument types, RLS policies and enum
 * labels. Nothing is written and no connection string is printed.
 *
 * Expect a clean result after `npm run staging:migrate`. Anything listed as
 * "only in production" was made outside the migrations and is drift.
 */
import pg from "pg";

const PROD = process.env.SUPABASE_DB_URL;
const STAGING = process.env.STAGING_DB_URL;
if (!PROD || !STAGING) {
  console.error("Both SUPABASE_DB_URL and STAGING_DB_URL must be in .env.local.");
  process.exit(1);
}

const QUERIES: Record<string, string> = {
  tables: `select table_name from information_schema.tables
            where table_schema='public' and table_type='BASE TABLE'`,
  views: `select table_name from information_schema.views where table_schema='public'`,
  functions: `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public'`,
  policies: `select tablename || ': ' || policyname from pg_policies where schemaname='public'`,
  enums: `select t.typname || '.' || e.enumlabel
            from pg_enum e join pg_type t on t.oid=e.enumtypid
            join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'`,
  columns: `select table_name || '.' || column_name
              from information_schema.columns where table_schema='public'`,
};

async function catalogue(url: string) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const out: Record<string, Set<string>> = {};
  for (const [name, sql] of Object.entries(QUERIES)) {
    const r = await c.query<Record<string, string>>(sql);
    out[name] = new Set(r.rows.map((row) => String(Object.values(row)[0])));
  }
  await c.end();
  return out;
}

const [prod, staging] = await Promise.all([catalogue(PROD), catalogue(STAGING)]);

let drift = 0;
for (const name of Object.keys(QUERIES)) {
  const onlyProd = [...prod[name]].filter((x) => !staging[name].has(x)).sort();
  const onlyStaging = [...staging[name]].filter((x) => !prod[name].has(x)).sort();
  const same = onlyProd.length === 0 && onlyStaging.length === 0;
  console.log(
    `${name.padEnd(10)} production ${String(prod[name].size).padStart(4)}   ` +
    `staging ${String(staging[name].size).padStart(4)}   ${same ? "match" : "DIFFER"}`,
  );
  for (const x of onlyProd) { console.log(`             only in production: ${x}`); drift++; }
  for (const x of onlyStaging) { console.log(`             only in staging:    ${x}`); drift++; }
}

console.log(drift === 0 ? "\nIdentical." : `\n${drift} difference(s).`);
