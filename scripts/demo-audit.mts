import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (label: string, sql: string) => {
  const r = await c.query(sql);
  console.log(`\n${label}`);
  for (const row of r.rows) console.log("  " + Object.values(row).map(v => String(v ?? "—")).join("  |  "));
};
await q("open reports by age", `select
  case when now()-created_at < interval '2 hours' then 'under 2h'
       when now()-created_at < interval '1 day' then 'today'
       when now()-created_at < interval '3 days' then '1-3 days'
       else 'older than 3 days' end bucket,
  count(*)::int n
  from staff_queue group by 1 order by 2 desc`);
await q("most recent activity", `select
  to_char(max(created_at),'Mon DD HH24:MI') newest_report,
  to_char(max(resolved_at),'Mon DD HH24:MI') newest_resolve from reports`);
await q("resolved today / this week", `select
  count(*) filter (where resolved_at > now() - interval '1 day')::int today,
  count(*) filter (where resolved_at > now() - interval '7 days')::int this_week,
  count(*)::int all_time from reports where resolved_at is not null`);
await q("overdue open reports", `select count(*)::int n from staff_queue where ack_overdue`);
await c.end();
