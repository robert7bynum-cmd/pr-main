/**
 * create_club builds a second club that matches docs/taxonomy.md.
 *
 * The seed was the only thing that had ever made a course, and it hard-codes
 * the seven departments and ten routing rules. create_club (20260906170000)
 * restates them, which is a second copy of the taxonomy — so this suite parses
 * the markdown tables in docs/taxonomy.md and holds the function to them. If a
 * department is renamed in the document and not in the function, or the other
 * way round, this fails; the document stays the source of truth.
 *
 * Also: the guards (duplicate slug, bad timezone, no session may call it), and
 * that a report filed at the brand-new club raises 'routed to nobody' — the
 * correct answer for a club with no staff yet, and the one thing that must not
 * be silently recorded as success.
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
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };
const errorOf = async (sql: string, p: unknown[] = []) => {
  try { await db.query(sql, p); return null; } catch (e) { return (e as Error).message; }
};

// ---------------------------------------------------------------- the document
// Two markdown tables. Cells are `code`-quoted keys or plain text; the header
// and the |---| rule are skipped. Anything that stops parsing fails loudly
// rather than passing with zero rows.
const doc = readFileSync("docs/taxonomy.md", "utf8");
const table = (heading: string): string[][] => {
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`docs/taxonomy.md has no heading ${heading}`);
  const lines = doc.slice(start).split("\n").slice(1);
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) { if (rows.length) break; continue; }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim().replace(/^`|`$/g, ""));
    if (cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }
  return rows.slice(1); // header row
};
const docDepts = table("## Departments").map(([key, name]) => ({ key, name }));
const docRules = table("## Categories").map(([category, dept, ack, resolve]) => ({
  category, dept, ack: Number(ack), resolve: Number(resolve),
}));
check("the document lists seven departments", docDepts.length === 7, String(docDepts.length));
check("and ten categories", docRules.length === 10, String(docRules.length));
check("every category routes to a listed department",
  docRules.every((r) => docDepts.some((d) => d.key === r.dept)),
  docRules.filter((r) => !docDepts.some((d) => d.key === r.dept)).map((r) => r.category).join(", "));

// ------------------------------------------------------------ 1. create a club
console.log("\n1. create_club builds a club the taxonomy describes");
const before = Number((await one<{ n: string }>(`select count(*) n from courses`))!.n);
const created = await one<{ id: string }>(
  `select create_club('pine-valley','Pine Valley Golf Club','America/Chicago','GM@PineValley.com','Jane Doe') id`);
check("returns a course id", typeof created?.id === "string" && created.id.length === 36, JSON.stringify(created));
const course = created!.id;
const row = await one<{ slug: string; name: string; timezone: string; settings: Record<string, unknown>; is_demo: boolean }>(
  `select slug, name, timezone, settings, is_demo from courses where id = $1`, [course]);
check("one more course, with the slug, name and timezone given",
  Number((await one<{ n: string }>(`select count(*) n from courses`))!.n) === before + 1
    && row?.slug === "pine-valley" && row?.name === "Pine Valley Golf Club" && row?.timezone === "America/Chicago",
  JSON.stringify(row));
check("settings start empty (defaults come from the code, not the row)",
  JSON.stringify(row?.settings) === "{}", JSON.stringify(row?.settings));
check("a real club, not a demo one", row?.is_demo === false);

const depts = await all<{ key: string; name: string; sort_order: number }>(
  `select key, name, sort_order from departments where course_id = $1 order by sort_order`, [course]);
check("seven departments", depts.length === 7, String(depts.length));
check("with the document's keys and names, in its order",
  JSON.stringify(depts.map((d) => [d.key, d.name])) === JSON.stringify(docDepts.map((d) => [d.key, d.name])),
  JSON.stringify(depts));
check("sort_order 1..7", depts.map((d) => d.sort_order).join(",") === "1,2,3,4,5,6,7",
  depts.map((d) => d.sort_order).join(","));

const rules = await all<{ category: string; dept: string; ack: number; resolve: number; requires_photo: boolean }>(
  `select rr.category, d.key dept, rr.ack_sla_minutes ack, rr.resolve_sla_minutes resolve, rr.requires_photo
     from routing_rules rr join departments d on d.id = rr.department_id
    where rr.course_id = $1 order by rr.category`, [course]);
check("ten routing rules", rules.length === 10, String(rules.length));
for (const want of docRules) {
  const got = rules.find((r) => r.category === want.category);
  check(`  ${want.category} → ${want.dept}, ack ${want.ack}, resolve ${want.resolve}`,
    got !== undefined && got.dept === want.dept && got.ack === want.ack && got.resolve === want.resolve,
    JSON.stringify(got ?? null));
}
check("no rule requires a photo", rules.every((r) => !r.requires_photo));
check("every rule's department is at this club",
  Number((await one<{ n: string }>(
    `select count(*) n from routing_rules rr join departments d on d.id = rr.department_id
      where rr.course_id = $1 and d.course_id <> $1`, [course]))!.n) === 0);

const owner = await one<{ email: string; full_name: string; role: string; department_ids: string[]; claimed_at: string | null }>(
  `select email, full_name, role, department_ids, claimed_at from pending_profiles where course_id = $1`, [course]);
check("one pending owner, email lowercased, unclaimed",
  owner?.role === "owner" && owner?.email === "gm@pinevalley.com" && owner?.full_name === "Jane Doe" && owner?.claimed_at === null,
  JSON.stringify(owner));
check("the owner is scoped to every department", owner?.department_ids.length === 7, String(owner?.department_ids.length));
check("no locations — the club adds its own",
  Number((await one<{ n: string }>(`select count(*) n from locations where course_id = $1`, [course]))!.n) === 0);

const ev = await one<{ type: string; actor_id: string | null; detail: { event?: string } }>(
  `select type::text, actor_id, detail from admin_events where course_id = $1 order by id`, [course]);
check("an admin_events row records the creation, with no actor",
  ev?.type === "settings_changed" && ev?.actor_id === null && ev?.detail?.event === "club_created", JSON.stringify(ev));
check("and it is the only admin event at the new club",
  Number((await one<{ n: string }>(`select count(*) n from admin_events where course_id = $1`, [course]))!.n) === 1);

// ----------------------------------------------------------------- 2. refusals
console.log("\n2. what is refused");
const dup = await errorOf(`select create_club('pine-valley','Pine Valley Again','America/Chicago','x@y.com','Someone Else')`);
check("a duplicate slug", dup?.includes("that club already exists") ?? false, dup ?? "accepted");
const badTz = await errorOf(`select create_club('oak-ridge','Oak Ridge','Mars/Olympus_Mons','x@y.com','Someone')`);
check("a timezone Postgres does not know", badTz?.includes("unknown timezone") ?? false, badTz ?? "accepted");
const badSlug = await errorOf(`select create_club('Oak Ridge','Oak Ridge','America/Chicago','x@y.com','Someone')`);
check("a slug with spaces or capitals", badSlug?.includes("slug") ?? false, badSlug ?? "accepted");
const badEmail = await errorOf(`select create_club('oak-ridge','Oak Ridge','America/Chicago','not-an-email','Someone')`);
check("an owner without an email address", badEmail?.includes("email") ?? false, badEmail ?? "accepted");
check("none of those left a club behind",
  Number((await one<{ n: string }>(`select count(*) n from courses`))!.n) === before + 1);

const callers = await all<{ role: string }>(`
  select r.rolname as role from (values ('anon'),('authenticated'),('service_role')) r(rolname)
   where has_function_privilege(r.rolname, 'create_club(text,text,text,text,text)', 'execute')`);
check("only the service role may call it",
  callers.length === 1 && callers[0].role === "service_role", callers.map((c) => c.role).join(", "));
check("not PUBLIC either",
  (await one<{ ok: boolean }>(`select has_function_privilege('public', 'create_club(text,text,text,text,text)', 'execute') ok`))!.ok === false);

// ------------------------------------------------------ 3. an empty club routes
console.log("\n3. a report at the new club is not silently routed to nobody");
let report = "";
{
  // The club has no locations yet; give it one placard so a member can scan.
  const loc = (await one<{ id: string }>(
    `insert into locations (course_id, kind, hole_number, name) values ($1,'hole',1,'Hole 1') returning id`, [course]))!.id;
  const token = (await one<{ token: string }>(
    `insert into qr_codes (course_id, location_id) values ($1,$2) returning token`, [course, loc]))!.token;
  const nonce = (await one<{ n: string }>(`select issue_scan_nonce($1) n`, [token]))!.n;
  report = (await one<{ id: string }>(
    `select submit_report($1,$2,'Bunker rake missing on 1') id`, [token, nonce]))!.id;
  check("the report is filed at the new club",
    (await one<{ course_id: string }>(`select course_id from reports where id = $1`, [report]))!.course_id === course);

  const routed = await errorOf(
    `select * from route_report($1,'course_maintenance','normal','summary',0.9,'keyword')`, [report]);
  check("route_report raises 'routed to nobody' — correct for a club with no staff",
    routed?.includes("routed to nobody") ?? false, routed ?? "returned success");
  const unstaffed = await one<{ n: string }>(
    `select count(*) n from report_events where report_id = $1 and type = 'unstaffed'`, [report]);
  // The raise rolls the statement back, events included; what must not exist
  // is a 'routed' event claiming somebody was told.
  const routedEv = await one<{ n: string }>(
    `select count(*) n from report_events where report_id = $1 and type = 'routed'`, [report]);
  check("nothing claims the report reached anyone", Number(routedEv?.n) === 0, `${routedEv?.n} routed event(s), ${unstaffed?.n} unstaffed`);

  // And Beacon Hill is untouched by any of this.
  const bh = await one<{ depts: string; rules: string }>(
    `select (select count(*) from departments where course_id = c.id) depts,
            (select count(*) from routing_rules where course_id = c.id) rules
       from courses c where slug = 'beacon-hill'`);
  check("Beacon Hill still has its seven departments and ten rules", Number(bh?.depts) === 7 && Number(bh?.rules) === 10, JSON.stringify(bh));
}

// ---------------------------------------- 4. the owner signs in, and is paged
console.log("\n4. the owner's first sign-in claims the pending profile, and the report reaches them");
{
  const uid = (await one<{ id: string }>(
    `insert into auth.users (id, email, aud, role, confirmation_token, recovery_token, email_change_token_new, email_change)
     values (gen_random_uuid(),'gm@pinevalley.com','authenticated','authenticated','','','','') returning id`))!.id;
  await db.query(`select set_config('test.uid', $1, false)`, [uid]);
  const claimed = await one<{ claimed: boolean; course_slug: string; full_name: string }>(`select * from claim_profile()`);
  check("claim_profile claims it", claimed?.claimed === true && claimed?.course_slug === "pine-valley", JSON.stringify(claimed));
  const prof = await one<{ role: string; course_id: string; depts: number }>(
    `select p.role::text, p.course_id, (select count(*)::int from staff_departments sd where sd.profile_id = p.id) depts
       from profiles p where p.id = $1`, [uid]);
  check("as owner of the new club, in all seven departments",
    prof?.role === "owner" && prof?.course_id === course && prof?.depts === 7, JSON.stringify(prof));
  await db.query(`select set_config('test.uid', '', false)`);

  // The raise above rolled the routing back, so the same report is still
  // untriaged. Now there is one person at the club, and they are told.
  const routed = await one<{ department_id: string; recipients: number; reason: string }>(
    `select * from route_report($1,'course_maintenance','normal','summary',0.9,'keyword')`, [report]);
  check("the same report now routes, to exactly one person", routed?.recipients === 1, JSON.stringify(routed));
  const who = await one<{ profile_id: string }>(`select profile_id from notifications where report_id = $1`, [report]);
  check("and that person is the owner", who?.profile_id === uid, JSON.stringify(who));
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
