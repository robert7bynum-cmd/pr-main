import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (l: string, sql: string) => {
  const r = await c.query(sql);
  console.log(`\n${l}`);
  for (const row of r.rows) console.log("  " + Object.values(row).map(v => String(v ?? "—")).join("  |  "));
};
await q("today", `select open_now, filed_today, resolved_today, median_ack_minutes, median_resolve_minutes from dashboard_today`);
await q("by department", `select name, open_now, total_30d, median_resolve_minutes from dashboard_by_department limit 6`);
await q("recurring problems", `select location, category, occurrences from dashboard_recurring limit 6`);
await q("by person", `select full_name, resolved_30d, median_handling_minutes from dashboard_by_person limit 5`);
await q("daily volume (last 7)", `select day, filed from dashboard_daily order by day desc limit 7`);
await c.end();
