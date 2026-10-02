/**
 * Two clubs on one database cannot see each other. Proven live.
 *
 *   npm run test:isolation
 *
 * Cross-club isolation is tested hard offline — test-staff-admin alone carries
 * 29 assertions — and had never once been tested against real Postgres. No
 * live suite had ever created a second club. That gap matters more here than
 * most places: this project already shipped a bug where 117 tests passed and
 * the product was unusable, because asserting on the database is not asserting
 * on what a person can reach.
 *
 * Runs against STAGING and refuses to run anywhere else. It creates and
 * destroys whole clubs — departments, routing rules, two dozen locations and
 * their placards, owners with real auth rows. Doing that inside the database a
 * paying customer lives in is not a risk worth taking for a test.
 *
 * Identity is real. `set local role authenticated` plus a `request.jwt.claims`
 * setting is what Supabase itself does, so `auth.uid()` resolves and every RLS
 * policy evaluates exactly as it does for a signed-in person. What this does
 * NOT cover is PostgREST's own layer above the database; that needs staging's
 * API keys and is noted at the end rather than quietly skipped.
 */
import pg from "pg";

const STAGING_REF = "sywwnifudqfupyshufuy";
const PROD_REF = "nfyshykwwtiwkluwiuyf";
const url = process.env.STAGING_DB_URL?.trim();

if (!url) {
  console.error("STAGING_DB_URL is not set in .env.local. See npm run staging:check.");
  process.exit(1);
}
if (url.includes(PROD_REF)) {
  console.error("REFUSING: that names the production project. This suite creates and deletes whole clubs.");
  process.exit(1);
}
if (!url.includes(STAGING_REF)) {
  console.error(`REFUSING: that does not name project ${STAGING_REF}.`);
  process.exit(1);
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`);
};
const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const rows = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;

/**
 * Run a statement as a signed-in person, exactly as PostgREST would.
 *
 * `commit` matters more than it looks. The first version of this rolled back
 * unconditionally, including the claim_profile call that creates the owner's
 * profile — so every run tested a user with no profile at all, and every
 * "cannot see the other club" assertion passed for the wrong reason. A user
 * who does not exist can see nothing. Only the positive control at the end of
 * each block caught it, which is the entire argument for having one.
 */
async function as<T>(
  uid: string, sql: string, p: unknown[] = [], commit = false,
): Promise<{ rows: T[]; error: string | null }> {
  await db.query("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await db.query("set local role authenticated");
    const r = await db.query<T>(sql, p);
    await db.query(commit ? "commit" : "rollback");
    return { rows: r.rows, error: null };
  } catch (e) {
    await db.query("rollback");
    return { rows: [], error: (e as Error).message };
  }
}

const stamp = Date.now().toString(36);
const made: { clubs: string[]; users: string[] } = { clubs: [], users: [] };

async function makeClub(slug: string, name: string, email: string) {
  const c = (await one<{ id: string }>(
    `select create_club($1,$2,'America/New_York',$3,'Iso Owner', 9) id`, [slug, name, email]))!.id;
  made.clubs.push(c);
  const uid = (await one<{ id: string }>(
    `insert into auth.users (id, instance_id, email, aud, role, confirmation_token,
                             recovery_token, email_change_token_new, email_change)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', $1,
             'authenticated','authenticated','','','','') returning id`, [email]))!.id;
  made.users.push(uid);
  // The owner's first sign-in turns the pending row into a profile.
  const claimed = await as<{ claimed: boolean }>(uid, `select * from claim_profile()`, [], true);
  if (!claimed.rows[0]?.claimed) throw new Error(`owner did not claim ${slug}: ${claimed.error}`);
  const report = (await one<{ id: string }>(
    `insert into reports (course_id, location_id, body, status, category, department_id)
     values ($1, (select id from locations where course_id=$1 and hole_number=3 limit 1),
             $2, 'triaged', 'course_maintenance',
             (select id from departments where course_id=$1 and key='maintenance'))
     returning id`, [c, `sprinkler at ${slug}`]))!.id;
  return { course: c, uid, report };
}

try {
  console.log(`\nbuilding two clubs on staging (${STAGING_REF})`);
  const A = await makeClub(`iso-a-${stamp}`, "Isolation Club A", `iso-a-${stamp}@proresponse.test`);
  const B = await makeClub(`iso-b-${stamp}`, "Isolation Club B", `iso-b-${stamp}@proresponse.test`);
  check("two clubs exist, each with its own owner and an open report",
    A.course !== B.course && A.uid !== B.uid);

  // Guard against the whole suite passing vacuously. If the owners have no
  // profile, auth.uid() resolves to somebody who is nobody, every "cannot
  // see" assertion below is trivially true, and the suite proves nothing.
  for (const [who, p] of [["A", A], ["B", B]] as const) {
    const prof = await one<{ role: string; course_id: string }>(
      `select role::text, course_id from profiles where id = $1`, [p.uid]);
    check(`owner ${who} actually has a profile, so the assertions below mean something`,
      prof?.role === "owner" && prof?.course_id === p.course, JSON.stringify(prof));
  }

  // One direction then the other. Isolation that holds one way is not isolation.
  for (const [me, them, label] of [[A, B, "A → B"], [B, A, "B → A"]] as const) {
    console.log(`\n${label}: the owner of one club reaches nothing of the other`);

    const seen = await as<{ id: string }>(me.uid, `select id from reports where id = $1`, [them.report]);
    check(`${label} cannot read their report`, seen.rows.length === 0,
      `saw ${seen.rows.length} row(s)`);

    const q = await as<{ id: string }>(me.uid, `select id from staff_queue where id = $1`, [them.report]);
    check(`${label} it is not in the course-wide queue either`, q.rows.length === 0);

    const locs = await as<{ n: string }>(me.uid,
      `select count(*) n from locations where course_id = $1`, [them.course]);
    check(`${label} cannot see their locations`, Number(locs.rows[0]?.n) === 0, locs.rows[0]?.n);

    const staff = await as<{ n: string }>(me.uid,
      `select count(*) n from profiles where course_id = $1`, [them.course]);
    check(`${label} cannot see their staff`, Number(staff.rows[0]?.n) === 0, staff.rows[0]?.n);

    const roster = await as<{ profile_id: string }>(me.uid, `select profile_id from staff_roster()`);
    check(`${label} the roster lists only their own club`,
      roster.rows.every((r) => r.profile_id !== them.uid), `${roster.rows.length} row(s)`);

    const res = await as(me.uid, `select resolve_report($1, $2, 'not mine to close')`, [them.report, me.uid]);
    check(`${label} cannot resolve their report`, res.error !== null, "it succeeded");

    const dept = (await one<{ id: string }>(
      `select id from departments where course_id=$1 and key='pro_shop'`, [them.course]))!.id;
    const re = await as(me.uid, `select reroute_report($1,$2,$3)`, [them.report, me.uid, dept]);
    check(`${label} cannot reroute it into their departments`, re.error !== null, "it succeeded");

    const mint = (await one<{ id: string }>(
      `select id from locations where course_id=$1 and hole_number=5 limit 1`, [them.course]))!.id;
    const placard = await as(me.uid, `select mint_placard($1)`, [mint]);
    check(`${label} cannot mint a placard for their course`, placard.error !== null, "it succeeded");

    const invite = await as(me.uid, `select create_staff_invite($1)`,
      [`iso-${them.course.slice(0, 8)}@proresponse.test`]);
    check(`${label} cannot mint a sign-in link for somebody at their club`, invite.error !== null, "it succeeded");

    const health = await as<{ issue: string }>(me.uid, `select issue from system_health_for($1)`, [them.course]);
    check(`${label} cannot ask about their club's health`, health.error !== null, "it succeeded");

    // And the positive control: isolation that also blocks your own club is
    // not isolation, it is a broken product.
    const own = await as<{ id: string }>(me.uid, `select id from reports where id = $1`, [me.report]);
    check(`${label} but can still see their OWN report`, own.rows.length === 1, own.error ?? "0 rows");
  }

  console.log("\nsettings changes land on the caller's own club only");
  const beforeB = (await one<{ name: string }>(`select name from courses where id=$1`, [B.course]))!.name;
  await as(A.uid, `select update_course_settings('Renamed By A','America/Denver',null,null,null)`);
  const afterB = (await one<{ name: string }>(`select name from courses where id=$1`, [B.course]))!.name;
  const afterA = (await one<{ name: string }>(`select name from courses where id=$1`, [A.course]))!.name;
  check("A renaming its own club does not touch B", beforeB === afterB, `${beforeB} -> ${afterB}`);
  check("and A's own club is unchanged too, because the call was rolled back", afterA === "Isolation Club A", afterA);
} finally {
  console.log("\nteardown");
  for (const c of made.clubs) {
    await db.query(`delete from report_events where course_id=$1`, [c]);
    await db.query(`delete from notifications where course_id=$1`, [c]);
    await db.query(`delete from triage_queue where report_id in (select id from reports where course_id=$1)`, [c]);
    await db.query(`delete from reports where course_id=$1`, [c]);
    await db.query(`delete from admin_events where course_id=$1`, [c]);
    await db.query(`delete from staff_departments where profile_id in (select id from profiles where course_id=$1)`, [c]);
    await db.query(`delete from staff_invites where course_id=$1`, [c]);
    await db.query(`delete from pending_profiles where course_id=$1`, [c]);
    await db.query(`delete from profiles where course_id=$1`, [c]);
    await db.query(`delete from courses where id=$1`, [c]);
  }
  for (const u of made.users) await db.query(`delete from auth.users where id=$1`, [u]);

  // A leftover counts as a failed test. The owner asked for that explicitly
  // after a probe account once sat in production under a cleanup line that
  // read correctly.
  const leftClubs = Number((await one<{ n: string }>(
    `select count(*) n from courses where slug like 'iso-%'`))!.n);
  const leftUsers = Number((await one<{ n: string }>(
    `select count(*) n from auth.users where email like 'iso-%@proresponse.test'`))!.n);
  check("every club this suite created is gone", leftClubs === 0, `${leftClubs} left`);
  check("every auth user it created is gone", leftUsers === 0, `${leftUsers} left`);
  await db.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(
  "\nNot covered: PostgREST's own layer above the database. These assertions\n" +
  "exercise real Postgres with real policies and a real auth.uid(), which is\n" +
  "where isolation is actually enforced, but a full-stack run would need\n" +
  "staging's API keys. Worth adding when those exist.",
);
process.exit(fail ? 1 : 0);
