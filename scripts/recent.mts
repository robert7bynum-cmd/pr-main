import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`select left(r.id::text,8) id, l.name loc, r.status, r.category,
  d.name dept, r.created_at::time(0) at, left(r.body,44) body,
  (select count(*)::int from notifications n where n.report_id=r.id) notified
  from reports r join locations l on l.id=r.location_id
  left join departments d on d.id=r.department_id
  order by r.created_at desc limit 5`);
r.rows.forEach(x=>console.log(`  ${x.at}  ${String(x.loc).padEnd(18)} ${String(x.status).padEnd(9)} ${String(x.dept??'—').padEnd(20)} ${x.body}`));
const q = await c.query(`select count(*)::int n from triage_queue where status='pending'`);
console.log(`\npending triage: ${q.rows[0].n}`);
await c.end();
