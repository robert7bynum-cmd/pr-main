import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`select to_char(day,'Mon DD') d, filed from dashboard_daily order by day desc limit 6`);
console.log("last 6 days filed:", r.rows.map(x=>`${x.d}:${x.filed}`).join("  "));
const o = await c.query(`select count(*)::int open, count(*) filter (where ack_overdue)::int overdue,
  count(*) filter (where now()-created_at < interval '6 hours')::int recent from staff_queue`);
console.log("queue:", JSON.stringify(o.rows[0]));
await c.end();
