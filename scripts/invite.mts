/**
 * Invite a staff member: creates the pending_profiles row their first
 * magic-link sign-in will claim. Stands in for the admin console until that
 * chunk is built.
 *
 *   npm run invite -- someone@club.com "Full Name" manager
 */
import { Client } from "pg";

const [email, fullName, role = "staff"] = process.argv.slice(2);
if (!email || !fullName) {
  console.error('usage: npm run invite -- email@club.com "Full Name" [staff|supervisor|manager|owner]');
  process.exit(1);
}

const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const course = await c.query<{ id: string; name: string }>(
  `select id, name from courses order by created_at limit 1`);
if (!course.rows.length) { console.error("no course found"); process.exit(1); }

// Managers get every department so they see the whole course; staff are scoped
// by the admin later.
const depts = await c.query<{ id: string }>(
  `select id from departments where course_id = $1`, [course.rows[0].id]);

await c.query(
  `insert into pending_profiles (course_id, email, full_name, role, department_ids)
   values ($1,$2,$3,$4,$5)
   on conflict (course_id, email) do update
     set full_name = excluded.full_name, role = excluded.role,
         department_ids = excluded.department_ids, claimed_at = null`,
  [course.rows[0].id, email, fullName, role, depts.rows.map((d) => d.id)],
);

console.log(`invited ${email} as ${role} at ${course.rows[0].name}`);
console.log(`they can now sign in at /login with that address`);
await c.end();
