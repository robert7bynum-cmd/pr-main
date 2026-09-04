import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`
  select urgency, minutes_open, ack_overdue, coalesce('Hole '||hole_number, location_name) loc,
         department_name, left(body, 46) body
    from staff_queue
   order by case urgency when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
            minutes_open desc limit 10`);
console.log("what a staff member sees, top of queue:\n");
for (const x of r.rows) {
  const age = x.minutes_open < 60 ? `${x.minutes_open}m` : `${Math.floor(x.minutes_open/60)}h ${x.minutes_open%60}m`;
  console.log(`  ${String(age).padStart(7)}${x.ack_overdue ? " OVERDUE" : "        "}  ${String(x.loc).padEnd(10)} ${String(x.urgency).padEnd(7)} ${String(x.department_name??"").padEnd(20)} ${x.body}`);
}
await c.end();
