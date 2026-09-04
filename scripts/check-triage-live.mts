import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (l:string,s:string)=>{const r=await c.query(s);console.log(l);r.rows.forEach(x=>console.log("  "+Object.values(x).map(v=>String(v??"—")).join("  |  ")));if(!r.rows.length)console.log("  (none)");};
await q("app_settings (worker_url is what gates the triage cron):", `select key, left(value,40) value from app_settings`);
await q("\ntriage_queue by status:", `select status, count(*)::int n from triage_queue group by 1 order by 2 desc`);
await q("\nreports still sitting in 'new':", `select count(*)::int n, min(created_at)::time(0) oldest from reports where status='new'`);
await q("\ncron jobs and their last run:", `select j.jobname,
    to_char(max(d.start_time),'HH24:MI:SS') last_run,
    count(*) filter (where d.status='succeeded')::int ok
  from cron.job j left join cron.job_run_details d on d.jobid=j.jobid
   and d.start_time > now() - interval '10 minutes'
  group by j.jobname order by j.jobname`);
await c.end();
