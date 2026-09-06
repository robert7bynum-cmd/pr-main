/** Who sees which reports. */
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
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };
const act = async (uid: string) => { await db.query(`select set_config('test.uid',$1,false)`, [uid]); };

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
const loc = (await one<{ id: string }>(`select id from locations where hole_number=5`))!.id;
const maint = (await one<{ id: string }>(`select id from departments where key='maintenance'`))!.id;
const shop  = (await one<{ id: string }>(`select id from departments where key='pro_shop'`))!.id;
const manager = (await one<{ id: string }>(`select id from profiles where role='manager' limit 1`))!.id;

// A groundskeeper in maintenance only.
const crew = (await one<{ id: string }>(
  `select p.id from profiles p join staff_departments sd on sd.profile_id=p.id
    where sd.department_id=$1 and p.role='staff' limit 1`, [maint]))!.id;
await db.query(`delete from staff_departments where profile_id=$1`, [crew]);
await db.query(`insert into staff_departments values ($1,$2)`, [crew, maint]);

const mk = async (dept: string) => (await one<{ id: string }>(
  `insert into reports (course_id, location_id, body, status, department_id, category)
   values ($1,$2,'visibility test','triaged',$3,'course_maintenance') returning id`,
  [course, loc, dept]))!.id;

const mine = await mk(maint);
const theirs = await mk(shop);

console.log("\n1. a groundskeeper sees their own department");
await act(crew);
const q1 = await db.query<{ id: string }>(`select id from my_queue`);
check("sees the maintenance report", q1.rows.some(r => r.id === mine));
check("does not see the pro shop report", !q1.rows.some(r => r.id === theirs));

console.log("\n2. but sees anything they were notified about");
await db.query(`insert into notifications (report_id, course_id, profile_id, channel, status)
                values ($1,$2,$3,'push','queued')`, [theirs, course, crew]);
const q2 = await db.query<{ id: string }>(`select id from my_queue`);
check("a report they were paged about is visible", q2.rows.some(r => r.id === theirs));

console.log("\n3. and anything they claimed, even if re-routed away");
const claimed = await mk(shop);
await db.query(`update reports set claimed_by=$1 where id=$2`, [crew, claimed]);
const q3 = await db.query<{ id: string }>(`select id from my_queue`);
check("their claimed report stays visible", q3.rows.some(r => r.id === claimed));

console.log("\n4. management see the whole course");
await act(manager);
const q4 = await db.query<{ id: string }>(`select id from my_queue`);
check("manager sees the maintenance report", q4.rows.some(r => r.id === mine));
check("manager sees the pro shop report", q4.rows.some(r => r.id === theirs));

console.log("\n5. the course-wide view is unchanged for reporting");
const all = await one<{ n: number }>(`select count(*)::int n from staff_queue`);
const personal = await one<{ n: number }>(`select count(*)::int n from my_queue`);
check("staff_queue still returns the whole club", (all?.n ?? 0) >= (personal?.n ?? 0),
  `${all?.n} vs ${personal?.n}`);

console.log("\n6. nobody sees another club's work");
await act(crew);
const other = (await one<{ id: string }>(
  `insert into courses (slug,name) values ('other','Other') returning id`))!.id;
const otherLoc = (await one<{ id: string }>(
  `insert into locations (course_id,kind,name) values ($1,'hole','H1') returning id`, [other]))!.id;
const otherReport = (await one<{ id: string }>(
  `insert into reports (course_id,location_id,body,status) values ($1,$2,'other club','triaged')
   returning id`, [other, otherLoc]))!.id;
const q6 = await db.query<{ id: string }>(`select id from my_queue`);
check("another club's report is invisible", !q6.rows.some(r => r.id === otherReport));

/**
 * A shared counter login sees what its departments see. The seed's pro shop
 * station is in the pro shop department and nothing else, so it should see
 * the pro shop report and not the maintenance one — the same rule as a
 * person, because the board it feeds is the same queue at a larger size.
 */
console.log("\n7. a shared station sees its own departments");
const station = (await one<{ id: string }>(
  `select id from profiles where account_kind = 'station' and active limit 1`))!;
check("the seed has a station account", Boolean(station?.id));
const stationDepts = await db.query<{ department_id: string }>(
  `select department_id from staff_departments where profile_id = $1`, [station.id]);
check("and it is in the pro shop", stationDepts.rows.some(r => r.department_id === shop));
check("and not in maintenance", !stationDepts.rows.some(r => r.department_id === maint));

await act(station.id);
const q7 = await db.query<{ id: string }>(`select id from my_queue`);
check("the station sees the pro shop report", q7.rows.some(r => r.id === theirs));
check("and not the maintenance report", !q7.rows.some(r => r.id === mine));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
