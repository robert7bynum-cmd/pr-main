import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (l:string,s:string)=>{const r=await c.query(s);console.log("\n"+l);if(!r.rows.length){console.log("  (none)");return;}
  console.log("  "+Object.keys(r.rows[0]).join(" | "));r.rows.forEach(x=>console.log("  "+Object.values(x).map(v=>String(v??"—")).join(" | ")));};

const d = await c.query(`select pg_get_viewdef('my_queue'::regclass, true) v`);
console.log("my_queue definition:\n" + d.rows[0].v);

await q("staff and their departments / on-duty:", `
  select p.full_name, p.role, p.is_active, p.on_duty,
         coalesce(string_agg(d.key, ',' order by d.key), '—') depts
  from profiles p
  left join staff_departments sd on sd.profile_id = p.id
  left join departments d on d.id = sd.department_id
  group by p.id, p.full_name, p.role, p.is_active, p.on_duty
  order by p.full_name`);
await c.end();
