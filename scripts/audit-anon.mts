import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q=async(l:string,s:string)=>{const r=await c.query(s);console.log(l);r.rows.forEach(x=>console.log("  "+Object.values(x).map(v=>String(v??"—")).join("  ")));if(!r.rows.length)console.log("  (none)")};

await q("FUNCTIONS anon can execute:", `
  select p.proname
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute')
   order by 1`);

await q("\nTABLES/VIEWS anon has any privilege on:", `
  select c.relname, string_agg(pr.priv,',') privs
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    cross join lateral (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) pr(priv)
   where n.nspname='public' and c.relkind in ('r','v')
     and has_table_privilege('anon', c.oid, pr.priv)
   group by 1 order by 1`);

await q("\nTABLES with RLS DISABLED (would be readable if granted):", `
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and not c.relrowsecurity order by 1`);

await q("\nVIEWS not running as the caller (would bypass RLS):", `
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='v'
     and coalesce((select option_value from pg_options_to_table(c.reloptions)
                    where option_name='security_invoker'),'off') not in ('on','true')
   order by 1`);
await c.end();
