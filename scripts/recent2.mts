import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`select to_char(r.created_at,'HH24:MI:SS') at, l.name loc, r.status,
  d.name dept, left(r.body,50) body
  from reports r join locations l on l.id=r.location_id
  left join departments d on d.id=r.department_id
  where r.created_at > now() - interval '20 minutes' order by r.created_at desc`);
console.log("reports in the last 20 minutes:");
if (!r.rows.length) console.log("  (none — nothing was accepted)");
r.rows.forEach(x=>console.log(`  ${x.at}  ${String(x.loc).padEnd(10)} ${String(x.status).padEnd(9)} ${String(x.dept??'—').padEnd(20)} ${x.body}`));

const n = await c.query(`select to_char(issued_at,'HH24:MI:SS') issued,
  case when used_at is null then 'UNUSED' else to_char(used_at,'HH24:MI:SS') end used,
  q.token
  from scan_nonces s join qr_codes q on q.id = s.qr_code_id
  where s.issued_at > now() - interval '20 minutes' order by s.issued_at desc limit 8`);
console.log("\nscan nonces issued in the last 20 minutes (a form load mints one):");
n.rows.forEach(x=>console.log(`  issued ${x.issued}  used ${x.used}  ${x.token}`));
await c.end();
