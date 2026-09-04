import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const j = await c.query(`select jobname, active from cron.job order by jobname`);
j.rows.forEach(x=>console.log(`  cron: ${x.jobname} active=${x.active}`));
const q = await c.query(`select
  (select count(*)::int from reports) reports,
  (select count(*)::int from staff_queue) open,
  (select count(*)::int from triage_queue where status='pending') pending,
  (select count(*)::int from triage_queue where status='dead_letter') dead,
  (select count(*)::int from notifications where status='queued') queued_notifs,
  (select count(*)::int from profiles where active) staff,
  (select count(*)::int from triage_keywords) rules`);
console.log("  data:", JSON.stringify(q.rows[0]));
await c.end();
