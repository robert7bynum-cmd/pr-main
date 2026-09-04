import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(`create role anon; create role authenticated; create role service_role;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, instance_id uuid, email text,
    aud text, role text, created_at timestamptz default now(), updated_at timestamptz default now());
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`);
for (const f of readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

const q = async (label: string, sql: string) => {
  const r = await db.query<Record<string, unknown>>(sql);
  console.log(`\n${label}`);
  for (const row of r.rows) console.log("  " + Object.values(row).map(v => String(v ?? "—")).join("  |  "));
};

await q("status mix", `select status, count(*)::int n,
  round(100.0*count(*)/sum(count(*)) over (),1) pct
  from reports group by status order by n desc`);

await q("category mix (top 6)", `select category, count(*)::int n
  from reports group by category order by n desc limit 6`);

await q("TIMESTAMP ORDER VIOLATIONS (want 0)", `select
  count(*) filter (where acknowledged_at < created_at)::int ack_before_created,
  count(*) filter (where resolved_at < acknowledged_at)::int resolved_before_ack,
  count(*) filter (where resolved_at > now())::int resolved_in_future
  from reports`);

await q("resolved rows missing required fields (want 0)", `select
  count(*) filter (where resolved_at is null)::int no_resolved_at,
  count(*) filter (where resolved_by is null)::int no_resolver,
  count(*) filter (where resolution_note is null)::int no_internal_note,
  count(*) filter (where member_message is null)::int no_member_msg
  from reports where status = 'resolved'`);

await q("internal note leaking as member message (want 0)", `select
  count(*)::int identical from reports
  where resolution_note is not null and resolution_note = member_message`);

await q("events vs report columns (want 0 mismatches)", `select
  count(*) filter (where e.n_created <> 1)::int bad_created,
  count(*) filter (where r.status='resolved' and e.n_resolved <> 1)::int bad_resolved
  from reports r join lateral (
    select count(*) filter (where type='created')::int n_created,
           count(*) filter (where type='resolved')::int n_resolved
    from report_events where report_id = r.id) e on true`);

await q("recurring problems (should cluster on 4, 12, 7)", `select l.name, r.category, count(*)::int n
  from reports r join locations l on l.id=r.location_id
  group by 1,2 having count(*) > 8 order by n desc limit 6`);

await q("median minutes to acknowledge / resolve", `select
  round(percentile_cont(0.5) within group (order by extract(epoch from acknowledged_at-created_at)/60)::numeric,1) med_ack,
  round(percentile_cont(0.5) within group (order by extract(epoch from resolved_at-created_at)/60)::numeric,1) med_resolve
  from reports where resolved_at is not null`);

await q("open right now (GM demo needs a few)", `select status, count(*)::int n from reports
  where status in ('new','triaged','acknowledged','in_progress','scheduled') group by 1 order by 2 desc`);

await q("sample member-facing vs internal", `select left(resolution_note,42) internal, left(member_message,46) member
  from reports where status='resolved' limit 3`);

await q("reports per week (should span ~6 weeks)", `select
  to_char(date_trunc('week', created_at),'Mon DD') wk, count(*)::int n
  from reports group by 1 order by min(created_at)`);
await q("distinct days / holes used", `select
  (select count(distinct date_trunc('day',created_at))::int from reports) days,
  (select count(distinct location_id)::int from reports) locations`);
