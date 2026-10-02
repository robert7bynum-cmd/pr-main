/**
 * The GM's numbers measure problems, not drinks.
 *
 * The dashboard was written in 20260904160000. `reports.kind` arrived in
 * 20260917100000 and no migration since had touched these views, so every
 * figure mixed food orders in with faults. That gets worse rather than
 * better: orders are the highest-volume category and resolve in minutes,
 * while a sprinkler takes hours — so as ordering ramps up the median resolve
 * time collapses and the GM reads "we are getting faster" when maintenance
 * has not changed at all.
 *
 * This suite builds a club where the two are deliberately far apart and
 * holds each figure to the right population (20261002120000).
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const all = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`);
};

const course = (await one<{ id: string }>(`select id from courses where slug='beacon-hill'`))!.id;
const loc = (await one<{ id: string }>(
  `select id from locations where course_id=$1 and hole_number=4 limit 1`, [course]))!.id;
const fnb = (await one<{ id: string }>(
  `select id from departments where course_id=$1 and key='f_and_b'`, [course]))!.id;
const maint = (await one<{ id: string }>(
  `select id from departments where course_id=$1 and key='maintenance'`, [course]))!.id;
const person = (await one<{ id: string }>(
  `select id from profiles where course_id=$1 and active and account_kind='individual' limit 1`, [course]))!.id;

// Clear the seed's reports so the arithmetic below is entirely ours.
await db.query(`delete from report_events where course_id=$1`, [course]);
await db.query(`delete from triage_queue where report_id in (select id from reports where course_id=$1)`, [course]);
await db.query(`delete from notifications where course_id=$1`, [course]);
await db.query(`delete from reports where course_id=$1`, [course]);

// Deliberately far apart: orders in 5 minutes, faults in 200.
const mk = async (kind: string, category: string, dept: string, minutes: number, n: number) => {
  for (let i = 0; i < n; i++) {
    await db.query(
      `insert into reports (course_id, location_id, body, kind, category, department_id, status,
                            created_at, acknowledged_at, resolved_at, resolved_by)
       values ($1,$2,$3,$4,$5,$6,'resolved',
               now() - interval '2 days',
               now() - interval '2 days' + make_interval(mins => 1),
               now() - interval '2 days' + make_interval(mins => $7),
               $8)`,
      [course, loc, `${kind} ${i}`, kind, category, dept, minutes, person]);
  }
};
await mk("order", "f_and_b", fnb, 5, 20);          // the Saturday drinks rush
await mk("issue", "course_maintenance", maint, 200, 4); // the sprinklers

console.log("\n1. the headline medians measure problems, not drinks");
const today = (await one<Record<string, number | null>>(
  `select * from dashboard_today where course_id=$1`, [course]))!;
check("median resolve is the fault time, not dragged down by 20 fast orders",
  Number(today.median_resolve_minutes) === 200, String(today.median_resolve_minutes));
check("and the order median is reported on its own",
  Number(today.median_order_minutes) === 5, String(today.median_order_minutes));
check("orders are still counted, so nothing disappears from view",
  Number(today.orders_today) === 0 && Number(today.orders_open) === 0,
  JSON.stringify({ orders_today: today.orders_today, orders_open: today.orders_open }));

console.log("\n2. a department that does both is not averaged into nonsense");
const depts = await all<{ key: string; median_resolve_minutes: number | null; orders_30d: number; median_order_minutes: number | null }>(
  `select key, median_resolve_minutes, orders_30d, median_order_minutes
     from dashboard_by_department where course_id=$1`, [course]);
const fb = depts.find((d) => d.key === "f_and_b");
check("Food & Beverage reports 20 orders", Number(fb?.orders_30d) === 20, JSON.stringify(fb));
check("with an order median of 5, and no fault median because it had no faults",
  Number(fb?.median_order_minutes) === 5 && fb?.median_resolve_minutes === null, JSON.stringify(fb));
const mt = depts.find((d) => d.key === "maintenance");
check("maintenance reports its real 200, unpolluted", Number(mt?.median_resolve_minutes) === 200, JSON.stringify(mt));

console.log("\n3. a popular drinks spot is not a recurring problem");
const rec = await all<{ category: string; occurrences: number }>(
  `select category, occurrences from dashboard_recurring where course_id=$1`, [course]);
check("twenty orders at hole 4 do not appear as a problem to fix",
  !rec.some((r) => r.category === "f_and_b"), JSON.stringify(rec));
check("four sprinkler faults at hole 4 do", rec.some((r) => r.category === "course_maintenance"), JSON.stringify(rec));

console.log("\n4. a person's handling time is their fault work; deliveries are counted too");
const who = (await one<{ resolved_30d: number; median_handling_minutes: number | null; orders_delivered_30d: number }>(
  `select resolved_30d, median_handling_minutes, orders_delivered_30d
     from dashboard_by_person where profile_id=$1`, [person]))!;
check("every piece of work they closed still counts", Number(who.resolved_30d) === 24, String(who.resolved_30d));
check("handling time is the fault clock, not flattered by deliveries",
  Number(who.median_handling_minutes) === 199, String(who.median_handling_minutes));
check("and the deliveries show as deliveries", Number(who.orders_delivered_30d) === 20, String(who.orders_delivered_30d));

console.log("\n5. the views stay locked down after being recreated");
const locked = await all<{ view: string; inv: boolean; anon: boolean; authed: boolean }>(`
  select c.relname view, (c.reloptions::text like '%security_invoker=on%') inv,
         has_table_privilege('anon', c.oid, 'select') anon,
         has_table_privilege('authenticated', c.oid, 'select') authed
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='v' and c.relname like 'dashboard%'`);
check("all five are security_invoker", locked.length === 5 && locked.every((v) => v.inv),
  JSON.stringify(locked.filter((v) => !v.inv)));
check("none readable by anon", locked.every((v) => !v.anon), JSON.stringify(locked.filter((v) => v.anon)));
check("all readable by a signed-in caller", locked.every((v) => v.authed));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
