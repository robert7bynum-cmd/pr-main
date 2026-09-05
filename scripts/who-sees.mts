import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const people = await c.query<{ id: string; full_name: string; role: string }>(
  `select id, full_name, role from profiles where email like '%beaconhilldemo%' order by role`);
const target = await c.query<{ id: string }>(
  `select id from reports where body like 'Water sprinkler%' order by created_at desc limit 1`);
const rid = target.rows[0]?.id;
console.log(`report: ${String(rid).slice(0,8)}\n`);
for (const p of people.rows) {
  await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [p.id]);
  await c.query(`select set_config('request.jwt.claims', json_build_object('sub',$1::text)::text, false)`, [p.id]);
  const n = await c.query(`select count(*)::int n from my_queue`);
  const sees = await c.query(`select count(*)::int n from my_queue where id=$1`, [rid]);
  console.log(`  ${p.full_name.padEnd(18)} ${p.role.padEnd(11)} queue=${n.rows[0].n}  sees this report=${sees.rows[0].n === 1}`);
}
await c.end();
