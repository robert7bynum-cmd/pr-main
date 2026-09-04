/**
 * Creates real, confirmed auth users for a few demo personas and links them to
 * Beacon Hill profiles, so the app can be opened without an email round-trip.
 *
 * These are ordinary Supabase users — no passwords, no special-casing in the
 * app. The dev sign-in issues them a normal session.
 */
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const PERSONAS = [
  { email: "gm@beaconhilldemo.com",   name: "Katherine Ellis",   role: "manager",    all: true },
  { email: "supt@beaconhilldemo.com", name: "Efrain Reyes",      role: "supervisor", dept: "maintenance" },
  { email: "shop@beaconhilldemo.com", name: "Danny Whitfield",   role: "staff",      dept: "pro_shop" },
];

const pg = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await pg.connect();

const course = (await pg.query<{ id: string }>(`select id from courses order by created_at limit 1`)).rows[0];

for (const p of PERSONAS) {
  // Reuse the user if they already exist, so this is safe to re-run.
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  let user = list.users.find((u) => u.email === p.email);

  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email: p.email,
      email_confirm: true,
    });
    if (error) { console.error(`  FAIL ${p.email}: ${error.message}`); continue; }
    user = data.user!;
  }

  await pg.query(
    `insert into profiles (id, course_id, full_name, email, role, on_duty, account_kind)
     values ($1,$2,$3,$4,$5,true,'individual')
     on conflict (id) do update set full_name = excluded.full_name, role = excluded.role,
       course_id = excluded.course_id, on_duty = true, active = true`,
    [user.id, course.id, p.name, p.email, p.role],
  );

  await pg.query(`delete from staff_departments where profile_id = $1`, [user.id]);
  await pg.query(
    p.all
      ? `insert into staff_departments (profile_id, department_id)
           select $1, id from departments where course_id = $2`
      : `insert into staff_departments (profile_id, department_id)
           select $1, id from departments where course_id = $2 and key = $3`,
    p.all ? [user.id, course.id] : [user.id, course.id, p.dept],
  );

  console.log(`  ok  ${p.name.padEnd(18)} ${p.role.padEnd(11)} ${p.email}`);
}

await pg.end();
console.log("\nOpen /login and use the demo buttons — no email needed.");
