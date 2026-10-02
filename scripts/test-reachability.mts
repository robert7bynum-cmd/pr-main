/**
 * One definition of "can this person be reached", and the behaviour that
 * depends on it.
 *
 * The question is asked in three places — the staff roster's device count,
 * system_health_for's alarm about having nowhere to send an alarm, and
 * club_readiness. Two of the three counted browser subscriptions only and
 * had never been revisited after device_tokens arrived, so a person with a
 * phone and no browser read as unreachable. That is a false alarm from the
 * watchdog and a manager chasing somebody already covered.
 *
 * This suite holds all three to the same answer, which is what stops them
 * drifting apart again (20261002110000).
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
const errorOf = async (sql: string, p: unknown[] = []) => {
  try { await db.query(sql, p); return null; } catch (e) { return (e as Error).message; }
};
const act = async (uid: string) => { await db.query(`select set_config('test.uid', $1, false)`, [uid]); };

const course = (await one<{ id: string }>(`select id from courses where slug = 'beacon-hill'`))!.id;
const mgr = (await one<{ id: string }>(
  `select id from profiles where course_id = $1 and role in ('manager','owner') and active limit 1`, [course]))!;
const staff = (await one<{ id: string; full_name: string }>(
  `select id, full_name from profiles where course_id = $1 and role = 'staff' and active
    and account_kind = 'individual' limit 1`, [course]))!;

// ------------------------------------------------- 1. the one definition
console.log("\n1. reachable_devices counts both ways of reaching somebody");
await db.query(`delete from push_subscriptions where profile_id = $1`, [staff.id]);
await db.query(`delete from device_tokens where profile_id = $1`, [staff.id]);
check("nobody is reachable with no browser and no phone",
  Number((await one<{ n: number }>(`select reachable_devices($1) n`, [staff.id]))!.n) === 0);

await db.query(
  `insert into push_subscriptions (profile_id, endpoint, p256dh, auth)
   values ($1, 'https://example.test/b1', 'p', 'a')`, [staff.id]);
check("a browser counts", Number((await one<{ n: number }>(`select reachable_devices($1) n`, [staff.id]))!.n) === 1);

await db.query(
  `insert into device_tokens (profile_id, platform, token) values ($1, 'ios', 'tok-reach-1')`, [staff.id]);
check("a phone counts too — this is the half that was missing",
  Number((await one<{ n: number }>(`select reachable_devices($1) n`, [staff.id]))!.n) === 2);

// ------------------------------- 2. all three callers give the same answer
console.log("\n2. the roster, the health check and readiness agree");
await act(mgr.id);
const roster = await all<{ profile_id: string; devices: number }>(`select profile_id, devices from staff_roster()`);
const row = roster.find((r) => r.profile_id === staff.id);
check("the roster counts the phone, not just the browser", row?.devices === 2, JSON.stringify(row));

// Strip the browser, leave the phone. Every caller must still say reachable.
await db.query(`delete from push_subscriptions where profile_id = $1`, [staff.id]);
const phoneOnly = await all<{ profile_id: string; devices: number }>(`select profile_id, devices from staff_roster()`);
check("with a phone and no browser the roster says one device, not zero",
  phoneOnly.find((r) => r.profile_id === staff.id)?.devices === 1);

// Nobody in management reachable at all → the alarm should fire. Give the
// manager a phone only: before this migration that still counted as nobody.
await db.query(`delete from push_subscriptions where profile_id = $1`, [mgr.id]);
await db.query(`delete from device_tokens where profile_id = $1`, [mgr.id]);
const noneReachable = await all<{ issue: string }>(`select issue from system_health_for($1)`, [course]);
check("with no manager reachable, the alarm fires",
  noneReachable.some((h) => h.issue === "No manager can receive system alerts"),
  noneReachable.map((h) => h.issue).join(" | "));

// A phone does NOT silence this one, and that is deliberate (20261002130000).
// Reports are delivered by the worker, which speaks to phones. System alarms
// are delivered by app/api/watchdog, a Next.js route with web push only — it
// cannot borrow the worker's transport, because the worker is one of the
// things it exists to watch. This assertion said the opposite for half a day.
await db.query(`insert into device_tokens (profile_id, platform, token) values ($1,'android','tok-mgr-1')`, [mgr.id]);
const phoneMgr = await all<{ issue: string }>(`select issue from system_health_for($1)`, [course]);
check("a phone does not silence the watchdog alarm — the watchdog cannot send to phones",
  phoneMgr.some((h) => h.issue === "No manager can receive system alerts"),
  phoneMgr.map((h) => h.issue).join(" | "));
check("and watchdog_recipients agrees: a phone-only manager is not in its list",
  (await all<{ profile_id: string }>(`select profile_id from watchdog_recipients($1)`, [course]))
    .every((r) => r.profile_id !== mgr.id));

// A browser does silence it, because that is what the route can send to.
await db.query(
  `insert into push_subscriptions (profile_id, endpoint, p256dh, auth)
   values ($1, 'https://example.test/mgr-browser', 'p', 'a')`, [mgr.id]);
const browserMgr = await all<{ issue: string }>(`select issue from system_health_for($1)`, [course]);
check("a browser silences it",
  !browserMgr.some((h) => h.issue === "No manager can receive system alerts"),
  browserMgr.map((h) => h.issue).join(" | "));

// ------------------------------- 3. on-duty staff nobody can reach
console.log("\n3. somebody on shift who cannot be paged is said out loud");
await db.query(`update profiles set on_duty = false where course_id = $1`, [course]);
await db.query(`update profiles set on_duty = true where id = $1`, [staff.id]);
await db.query(`delete from device_tokens where profile_id = $1`, [staff.id]);
const unreachable = await all<{ issue: string; detail: string }>(`select issue, detail from system_health_for($1)`, [course]);
check("an on-duty person with no browser and no phone is reported",
  unreachable.some((h) => h.issue === "Staff on duty cannot be reached"),
  unreachable.map((h) => h.issue).join(" | "));
await db.query(`insert into device_tokens (profile_id, platform, token) values ($1,'ios','tok-back')`, [staff.id]);
const covered = await all<{ issue: string }>(`select issue from system_health_for($1)`, [course]);
check("and stops being reported once they can be",
  !covered.some((h) => h.issue === "Staff on duty cannot be reached"),
  covered.map((h) => h.issue).join(" | "));

// --------------------------------------------- 4. club_readiness behaviour
console.log("\n4. club_readiness answers from live state, never from a flag");
{
  const fresh = (await one<{ id: string }>(
    `select create_club('readiness-test','Readiness Test','America/Denver','owner@readiness.invalid','Reed Owner', 9) id`))!.id;
  const uid = (await one<{ id: string }>(
    `insert into auth.users (id, email, aud, role, confirmation_token, recovery_token, email_change_token_new, email_change)
     values (gen_random_uuid(),'owner@readiness.invalid','authenticated','authenticated','','','','') returning id`))!.id;
  await act(uid);
  await db.query(`select claim_profile()`);

  const r0 = (await one<Record<string, unknown>>(`select * from club_readiness()`))!;
  check("a brand-new club has a team of one, nobody reachable, no sign address",
    r0.has_team === false && r0.can_be_alerted === false && r0.has_sign_address === false,
    JSON.stringify(r0));
  check("but it already has locations, because create_club built them",
    Number(r0.location_count) === 16, String(r0.location_count));

  // A second person.
  const uid2 = (await one<{ id: string }>(
    `insert into auth.users (id, email, aud, role, confirmation_token, recovery_token, email_change_token_new, email_change)
     values (gen_random_uuid(),'hand@readiness.invalid','authenticated','authenticated','','','','') returning id`))!.id;
  await db.query(
    `insert into profiles (id, course_id, full_name, email, role, account_kind)
     values ($1,$2,'Second Hand','hand@readiness.invalid','staff','individual')`, [uid2, fresh]);
  await act(uid);
  check("a second person makes it a team",
    (await one<{ has_team: boolean }>(`select has_team from club_readiness()`))!.has_team === true);

  // A station is a shared counter login, not a person who can be chased.
  const uid3 = (await one<{ id: string }>(
    `insert into auth.users (id, email, aud, role, confirmation_token, recovery_token, email_change_token_new, email_change)
     values (gen_random_uuid(),'counter@readiness.invalid','authenticated','authenticated','','','','') returning id`))!.id;
  await db.query(
    `insert into profiles (id, course_id, full_name, email, role, account_kind)
     values ($1,$2,'Pro Shop Counter','counter@readiness.invalid','staff','station')`, [uid3, fresh]);
  await act(uid);
  check("a station login is not counted as a member of the team",
    Number((await one<{ staff_count: number }>(`select staff_count from club_readiness()`))!.staff_count) === 2,
    "stations must not pad the headcount");

  await db.query(`insert into device_tokens (profile_id, platform, token) values ($1,'ios','tok-ready')`, [uid2]);
  await act(uid);
  check("one person with a phone is enough to be alertable",
    (await one<{ can_be_alerted: boolean }>(`select can_be_alerted from club_readiness()`))!.can_be_alerted === true);

  await db.query(
    `update courses set settings = jsonb_set(settings,'{public_url}','"https://readiness.example"') where id = $1`, [fresh]);
  await act(uid);
  const done = (await one<Record<string, unknown>>(`select * from club_readiness()`))!;
  check("with an address set, every step is done and the checklist goes away",
    done.has_team === true && done.can_be_alerted === true && done.has_sign_address === true,
    JSON.stringify(done));

  // Blank is not an address.
  await db.query(`update courses set settings = jsonb_set(settings,'{public_url}','"   "') where id = $1`, [fresh]);
  await act(uid);
  check("whitespace is not an address",
    (await one<{ has_sign_address: boolean }>(`select has_sign_address from club_readiness()`))!.has_sign_address === false);

  // Scoped to the caller's own club.
  await act(mgr.id);
  check("a manager at another club sees their own club's readiness, not this one",
    Number((await one<{ location_count: number }>(`select location_count from club_readiness()`))!.location_count) !== 16);
}

// ------------------------------------------------------------ 5. who may ask
console.log("\n5. who may ask");
await db.query(`select set_config('test.uid', '', false)`);
const grants = await all<{ role: string; fn: string }>(`
  select r.rolname role, f.fn from
    (values ('anon'),('authenticated'),('service_role')) r(rolname),
    (values ('reachable_devices(uuid)'),('club_readiness()'),
            ('assert_actor(uuid,uuid)'),('assert_can_manage(staff_role)')) f(fn)
   where has_function_privilege(r.rolname, f.fn, 'execute')`);
const who = (fn: string) => grants.filter((g) => g.fn === fn).map((g) => g.role).sort().join(",");
check("anon may ask none of them", !grants.some((g) => g.role === "anon"),
  grants.filter((g) => g.role === "anon").map((g) => g.fn).join(", "));
check("reachable_devices is for the app and the worker",
  who("reachable_devices(uuid)") === "authenticated,service_role", who("reachable_devices(uuid)"));
check("assert_actor is no longer executable by a signed-in caller — nothing calls it directly",
  who("assert_actor(uuid,uuid)") === "service_role" || who("assert_actor(uuid,uuid)") === "",
  who("assert_actor(uuid,uuid)") || "(none)");
check("nor assert_can_manage",
  who("assert_can_manage(staff_role)") === "service_role" || who("assert_can_manage(staff_role)") === "",
  who("assert_can_manage(staff_role)") || "(none)");
const anon = await errorOf(`select reachable_devices(gen_random_uuid())`);
check("the definition itself still answers for a legitimate caller", anon === null, anon ?? "");

// ------------------------------------- 6. no fifth copy can appear quietly
// The rule in CLAUDE.md — code written before a column existed does not learn
// about it — is only worth having if something enforces it. This is that
// something. It found watchdog_recipients the first time it was run.
console.log("\n6. nothing asks the reachability question on its own again");
{
  const askers = await all<{ proname: string; phones: boolean; one_def: boolean; watchdog_def: boolean }>(`
    select p.proname,
           (pg_get_functiondef(p.oid) like '%device_tokens%')     as phones,
           (pg_get_functiondef(p.oid) like '%reachable_devices%')  as one_def,
           (pg_get_functiondef(p.oid) like '%watchdog_can_reach%') as watchdog_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%push_subscriptions%'
     order by 1`);

  // Three legitimate reasons to name push_subscriptions directly:
  //   reachable_devices  — it IS the definition for reports
  //   watchdog_can_reach — it IS the definition for alarms, web push only
  //   set_staff_active   — a write path; it clears devices on deactivation
  // Anything else asking the question itself is the drift this suite exists
  // to stop. watchdog_recipients is allowed because it asks the predicate.
  const DEFINITIONS = ["reachable_devices", "watchdog_can_reach"];
  const WRITE_PATHS = ["set_staff_active"];
  const strays = askers.filter(
    (f) => !DEFINITIONS.includes(f.proname) && !WRITE_PATHS.includes(f.proname)
           && !f.one_def && !f.watchdog_def);
  check("every function touching push_subscriptions is a definition, a write path, or asks one by name",
    strays.length === 0,
    strays.length
      ? `these ask the question themselves: ${strays.map((f) => f.proname).join(", ")} — ` +
        `use reachable_devices() for reports or watchdog_can_reach() for alarms`
      : "");

  check("there are exactly two definitions, and they are the named ones",
    askers.filter((f) => DEFINITIONS.includes(f.proname)).length === 2,
    askers.map((f) => f.proname).join(", "));

  // And the dashboard's sibling rule, same shape: a view that aggregates
  // reports and forgets `kind` mixes orders in with faults (20261002120000).
  const views = await all<{ relname: string; knows: boolean }>(`
    select c.relname, (pg_get_viewdef(c.oid) like '%kind%') as knows
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'dashboard%'
       and pg_get_viewdef(c.oid) like '%reports%'`);
  const blind = views.filter((v) => !v.knows).map((v) => v.relname);
  check("every dashboard view over reports knows that orders are not problems",
    blind.length === 0, blind.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
