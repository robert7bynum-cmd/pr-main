/**
 * Every placard must resolve. A code that 404s is a sign that has to be
 * physically replaced, so this is worth checking before anything is printed.
 */
import { Client } from "pg";

const origin = "http://localhost:3000";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query<{ token: string; slug: string; name: string; active: boolean }>(
  `select q.token, c.slug, l.name, q.active
     from qr_codes q join courses c on c.id = q.course_id
     join locations l on l.id = q.location_id order by q.token`);
await c.end();

let ok = 0; const bad: string[] = [];
for (const r of rows) {
  const url = `${origin}/r/${r.slug}/${r.token}`;
  const res = await fetch(url, { redirect: "manual" });
  if (res.status === 200) ok++;
  else bad.push(`  ${res.status}  ${r.token}  (${r.name})`);
}
console.log(`${ok}/${rows.length} placards resolve`);
if (bad.length) { console.log("failures:"); bad.forEach(b => console.log(b)); }
process.exit(bad.length ? 1 : 0);
