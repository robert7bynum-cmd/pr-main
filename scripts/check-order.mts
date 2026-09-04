import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`select status, urgency, minutes_open, coalesce('Hole '||hole_number, location_name) loc
  from staff_queue
  order by case when status='scheduled' then 1 else 0 end,
           case urgency when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
           minutes_open desc limit 8`);
for (const x of r.rows) console.log(`  ${String(x.status).padEnd(13)} ${String(x.urgency).padEnd(7)} ${String(x.minutes_open).padStart(4)}m  ${x.loc}`);
await c.end();
