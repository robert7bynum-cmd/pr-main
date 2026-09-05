/** The watchdog must report real problems and stay quiet otherwise. */
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
const health = async () => (await db.query<{ severity: string; issue: string }>(`select * from system_health()`)).rows;

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
const loc = (await one<{ id: string }>(`select id from locations limit 1`))!.id;
const manager = (await one<{ id: string }>(`select id from profiles where role='manager' limit 1`))!.id;
const staff = (await one<{ id: string }>(`select id from profiles where role='staff' limit 1`))!.id;

// Healthy baseline. The seed deliberately leaves reports in 'new' awaiting
// triage, which the watchdog correctly flags — so clear them here rather than
// weakening the check. The watchdog being right about the seed is the point.
await db.query(`select record_heartbeat('sweep')`);
await db.query(`update profiles set on_duty = true where role='staff'`);
await db.query(`update pending_profiles set claimed_at = now()`);
await db.query(`update reports set status='triaged' where status='new'`);

console.log("\n1. a healthy system says nothing");
await act(manager);
check("no issues reported", (await health()).length === 0, JSON.stringify(await health()));

console.log("\n2. reports stuck untriaged are critical");
await db.query(`insert into reports (course_id, location_id, body, status, created_at)
                values ($1,$2,'stuck','new', now() - interval '20 minutes')`, [course, loc]);
let h = await health();
check("flagged", h.some(x => x.issue.includes("not being triaged")), JSON.stringify(h));
check("as critical", h.find(x => x.issue.includes("not being triaged"))?.severity === "critical");

console.log("\n3. a stopped scheduler is critical");
await db.query(`update system_heartbeats set beat_at = now() - interval '30 minutes'`);
h = await health();
check("flagged", h.some(x => x.issue.includes("scheduler has stopped")), JSON.stringify(h.map(x=>x.issue)));

console.log("\n4. nobody on duty is a warning, not a failure");
await db.query(`select record_heartbeat('sweep')`);
await db.query(`update profiles set on_duty = false`);
h = await health();
const duty = h.find(x => x.issue.includes("Nobody is on duty"));
check("flagged", !!duty);
check("as a warning", duty?.severity === "warning", duty?.severity);

console.log("\n5. only management can see it");
await act(staff);
check("staff get nothing", (await health()).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
