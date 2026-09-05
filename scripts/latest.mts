import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`select r.status, r.category, r.triage_source, d.name department,
  (select count(*)::int from notifications n where n.report_id=r.id) notified,
  (select string_agg(e.type::text,' -> ' order by e.id) from report_events e where e.report_id=r.id) trail
  from reports r left join departments d on d.id=r.department_id
  where r.body like 'Production check%' order by r.created_at desc limit 1`);
console.log(JSON.stringify(r.rows[0], null, 2));
await c.end();
