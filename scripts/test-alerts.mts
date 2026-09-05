/**
 * The alert ledger behind the external watchdog.
 *
 * The in-database watchdog only had to answer "what is wrong right now". The
 * external one has to decide what a human still needs to be *told*, which is a
 * harder question: shout once, stay quiet while nothing changes, shout again if
 * it drags on, and notice when it clears. Get the dedupe wrong in the loud
 * direction and every manager mutes the app; get it wrong in the quiet
 * direction and the club finds out from a member. Both failures are silent in
 * testing unless something asserts them.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter(f => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

const one = async <T>(s: string, p: unknown[] = []) => (await db.query<T>(s, p)).rows[0];
const all = async <T>(s: string, p: unknown[] = []) => (await db.query<T>(s, p)).rows;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
type Alert = { severity: string; issue: string; detail: string };
const sweep = (repeat = "30 minutes") =>
  all<Alert>(`select * from record_system_alerts($1, $2::interval)`, [course, repeat]);
const beat = (ago: string) =>
  db.query(`insert into system_heartbeats (name, beat_at) values ('sweep', now() - $1::interval)
            on conflict (name) do update set beat_at = excluded.beat_at`, [ago]);

// The seed leaves reports awaiting triage, which the watchdog correctly flags.
// Clear them so each condition below is the only thing being asserted.
await db.query(`update reports set status='triaged' where status='new'`);
await beat("0 minutes");

console.log("a healthy club says nothing");
check("no alerts when everything is fine", (await sweep()).length === 0);

console.log("\nfirst failure is reported once");
await beat("30 minutes");
const first = await sweep();
check("a stopped scheduler raises an alert", first.some(a => a.issue === "The scheduler has stopped"), JSON.stringify(first));
check("and it is critical", first.find(a => a.issue === "The scheduler has stopped")?.severity === "critical");

const second = await sweep();
check("the very next check stays silent", second.length === 0, JSON.stringify(second));

console.log("\nbut a problem that drags on is raised again");
const third = await sweep("0 seconds");
check("past the repeat window it speaks up", third.some(a => a.issue === "The scheduler has stopped"));

console.log("\nrecovery is recorded, not just forgotten");
await beat("0 minutes");
check("a recovered club is quiet again", (await sweep()).length === 0);
const resolved = await one<{ resolved_at: string | null }>(
  `select resolved_at from system_alerts where course_id=$1 and issue='The scheduler has stopped'`, [course]);
check("the alert is marked resolved", resolved?.resolved_at !== null);

console.log("\na problem that comes back is a new problem");
await beat("30 minutes");
const again = await sweep();
check("it alerts again immediately, without waiting out the old window",
  again.some(a => a.issue === "The scheduler has stopped"), JSON.stringify(again));
const reopened = await one<{ resolved_at: string | null; first_seen: string }>(
  `select resolved_at, first_seen from system_alerts where course_id=$1 and issue='The scheduler has stopped'`, [course]);
check("and is reopened rather than left closed", reopened?.resolved_at === null);
await beat("0 minutes");
await sweep();

console.log("\ntwo problems at once are both tracked");
await beat("30 minutes");
await db.query(`update reports set status='new', created_at = now() - interval '20 minutes'
                 where id in (select id from reports limit 2)`);
const both = await sweep("0 seconds");
check("untriaged reports and a dead scheduler are separate alerts",
  both.some(a => a.issue === "Reports are not being triaged") &&
  both.some(a => a.issue === "The scheduler has stopped"), JSON.stringify(both.map(a => a.issue)));

await db.query(`update reports set status='triaged' where status='new'`);
const onlyOne = await sweep("0 seconds");
check("fixing one leaves the other still open",
  onlyOne.some(a => a.issue === "The scheduler has stopped") &&
  !onlyOne.some(a => a.issue === "Reports are not being triaged"), JSON.stringify(onlyOne.map(a => a.issue)));

console.log("\none set of rules, not two");
await beat("0 minutes");
await db.query(`update reports set status='new', created_at = now() - interval '20 minutes'
                 where id in (select id from reports limit 3)`);
const mgr = (await one<{ id: string }>(`select id from profiles where role in ('manager','owner') limit 1`))!.id;
await db.query(`select set_config('test.uid', $1, false)`, [mgr]);
const viaManager = await all<Alert>(`select * from system_health()`);
const viaService = await all<Alert>(`select * from system_health_for($1)`, [course]);
check("system_health() and system_health_for() agree exactly",
  JSON.stringify(viaManager) === JSON.stringify(viaService),
  `${JSON.stringify(viaManager)} vs ${JSON.stringify(viaService)}`);

console.log("\nthe service-role surface stays closed");
const denied = async (s: string, p: unknown[] = []) => {
  await db.query(`set local role authenticated`).catch(() => {});
  try { await db.query(s, p); return false; } catch { return true; } finally {
    await db.query(`reset role`).catch(() => {});
  }
};
const priv = await all<{ fn: string; who: string }>(`
  select p.proname as fn, r.rolname as who
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral (values ('anon'),('authenticated')) as r(rolname)
   where n.nspname = 'public'
     and p.proname in ('record_system_alerts','watchdog_recipients','system_health_for')
     and has_function_privilege(r.rolname, p.oid, 'execute')`);
check("no anon or signed-in user can call the watchdog internals", priv.length === 0,
  priv.map(p => `${p.who} can call ${p.fn}`).join(", "));

const anonAlerts = await all<{ has: boolean }>(`
  select has_table_privilege('anon','system_alerts','select') as has`);
check("anon cannot read the alert ledger", anonAlerts[0]?.has === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
