/**
 * Table privileges, asserted directly rather than inferred from behaviour.
 *
 * test:rls proves nothing leaks *today*, by asking the live API as an anonymous
 * caller. It cannot see the layer underneath: Supabase grants every role full
 * CRUD on new tables by default, and for six internal tables the only thing
 * standing in the way was RLS with no policies. One `disable row level
 * security`, or one well-meant permissive policy on app_settings, and every
 * signed-in staff member could read the service role key — unrestricted access
 * to the whole database.
 *
 * Behavioural tests cannot catch that, because the behaviour is correct right
 * up until the moment it isn't. So this asserts the grants themselves.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter(f => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

// Tables that exist for the service role alone. Nothing signed in, and
// certainly nothing anonymous, has any business touching them.
const INTERNAL = [
  "app_settings", "scan_nonces", "triage_queue",
  "triage_misspellings", "triage_safety_idioms",
];

const { rows: grants } = await db.query<{ role: string; tbl: string; priv: string }>(`
  select r.rolname as role, t.tbl, p.priv
    from (values ('anon'),('authenticated')) r(rolname)
    cross join (values ${INTERNAL.map(t => `('${t}')`).join(",")}) t(tbl)
    cross join (values ('select'),('insert'),('update'),('delete')) p(priv)
   where to_regclass('public.' || t.tbl) is not null
     and has_table_privilege(r.rolname, 'public.' || t.tbl, p.priv)`);

console.log("internal tables are unreachable by grant, not just by policy");
check("no anon or authenticated privileges on service-role tables",
  grants.length === 0,
  grants.map(g => `${g.role} can ${g.priv} ${g.tbl}`).join(", "));

// Tables staff may READ but that only functions may write. SELECT is
// legitimately granted on several of these (staff_read policies), so only the
// write privileges are asserted. 20260906070000 revoked them after dropping the
// first-day policies that let any signed-in staff member set their own
// resolved_by or append to the table every metric derives from.
const WRITE_LOCKED = [
  "reports", "report_events", "routing_rules", "admin_events", "notifications",
  "system_alerts", "system_heartbeats", "triage_keywords", "staff_departments", "courses",
];

const { rows: writes } = await db.query<{ role: string; tbl: string; priv: string }>(`
  select r.rolname as role, t.tbl, p.priv
    from (values ('anon'),('authenticated')) r(rolname)
    cross join (values ${WRITE_LOCKED.map(t => `('${t}')`).join(",")}) t(tbl)
    cross join (values ('insert'),('update'),('delete')) p(priv)
   where to_regclass('public.' || t.tbl) is not null
     and has_table_privilege(r.rolname, 'public.' || t.tbl, p.priv)`);
check("no anon or authenticated write privileges on function-only tables",
  writes.length === 0,
  writes.map(g => `${g.role} can ${g.priv} ${g.tbl}`).join(", "));

// The secret-bearing one is worth naming on its own, because it is the row
// that turns a small mistake into a total compromise.
const { rows: settings } = await db.query<{ role: string }>(`
  select r.rolname as role from (values ('anon'),('authenticated')) r(rolname)
   where has_table_privilege(r.rolname, 'public.app_settings', 'select')`);
check("nobody but the service role can read app_settings", settings.length === 0,
  settings.map(s => s.role).join(", "));

console.log("\nRLS is on regardless, so both lines hold");
const { rows: norls } = await db.query<{ relname: string }>(`
  select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relkind = 'r' and not c.relrowsecurity`);
check("every table has row level security enabled", norls.length === 0,
  norls.map(r => r.relname).join(", "));

console.log("\nnew tables inherit the deny, rather than the default grant");
await db.exec(`create table probe_new_table (id uuid primary key default gen_random_uuid());`);
const { rows: fresh } = await db.query<{ role: string; priv: string }>(`
  select r.rolname as role, p.priv
    from (values ('anon'),('authenticated')) r(rolname)
    cross join (values ('select'),('insert'),('update'),('delete')) p(priv)
   where has_table_privilege(r.rolname, 'public.probe_new_table', p.priv)`);
check("a table created today grants nothing to anon or authenticated",
  fresh.length === 0, fresh.map(f => `${f.role} can ${f.priv}`).join(", "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
