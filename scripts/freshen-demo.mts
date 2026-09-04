/**
 * Re-anchors the demo data to "now".
 *
 * The seed's timestamps are fixed at the moment it was loaded, so a week later
 * every open report reads as days overdue and the club looks negligent — the
 * opposite of what the product is meant to show. Run this before any demo.
 *
 * Two passes:
 *   1. Shift the whole history forward so the newest activity is minutes ago.
 *   2. Pull open reports into the last few hours, because a real club does not
 *      have eleven things open for three days. A couple stay overdue on
 *      purpose: escalation is part of the story.
 */
import { Client } from "pg";

const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query("begin");

// ---- 1. shift everything so the most recent event is ~10 minutes ago
const { rows } = await c.query<{ delta: string }>(
  `select (now() - interval '10 minutes') - max(created_at) as delta from reports`);
const delta = rows[0].delta;

await c.query(`
  update reports set
    created_at         = created_at + $1::interval,
    acknowledged_at    = acknowledged_at + $1::interval,
    resolved_at        = resolved_at + $1::interval,
    claimed_at         = claimed_at + $1::interval,
    member_notified_at = member_notified_at + $1::interval`, [delta]);
await c.query(`update report_events set created_at = created_at + $1::interval`, [delta]);
await c.query(`update notifications set created_at = created_at + $1::interval,
                 sent_at = sent_at + $1::interval`, [delta]);

// ---- 2. bring open work into the working day
// Ordered oldest-first so the queue still has a sensible spread, with the two
// oldest left far enough back to be genuinely overdue.
await c.query(`
  with ranked as (
    select id, row_number() over (order by created_at) rn, count(*) over () total
      from reports
     where status in ('new','triaged','acknowledged','in_progress','scheduled')
  )
  update reports r set
    created_at = now() - make_interval(mins =>
      (case when ranked.rn <= 2 then 200 + (ranked.rn * 40)   -- deliberately overdue
            else (ranked.rn * 22) % 300 + 8 end)::int),
    acknowledged_at = case when r.acknowledged_at is null then null
      else now() - make_interval(mins =>
        (greatest(((ranked.rn * 22) % 300 + 8) - 6, 2))::int) end,
    claimed_at = case when r.claimed_at is null then null
      else now() - make_interval(mins =>
        (greatest(((ranked.rn * 22) % 300 + 8) - 6, 2))::int) end
  from ranked where ranked.id = r.id`);

// Keep the event trail consistent with the rows it describes: a 'created'
// event dated before its report would corrupt every timing metric.
await c.query(`
  update report_events e set created_at = r.created_at
    from reports r
   where e.report_id = r.id and e.type = 'created'
     and r.status in ('new','triaged','acknowledged','in_progress','scheduled')`);
await c.query(`
  update report_events e set created_at = greatest(r.created_at + interval '20 seconds',
                                                   least(e.created_at, now()))
    from reports r
   where e.report_id = r.id and e.type <> 'created'
     and r.status in ('new','triaged','acknowledged','in_progress','scheduled')`);

// ---- 3. keep body text and location plausible together
// The seed picks wording and location independently, so an on-course complaint
// could land at the cart barn. A GM reads these one by one and notices.
await c.query(`
  with holes as (select id, row_number() over (order by hole_number) rn,
                        count(*) over () total
                   from locations where kind = 'hole')
  update reports r set location_id = h.id
    from holes h
   where h.rn = (abs(hashtext(r.id::text)) % h.total) + 1
     and r.location_id in (select id from locations where kind <> 'hole')
     and (r.body ilike '%tee%' or r.body ilike '%fairway%' or r.body ilike '%green%'
          or r.body ilike '%bunker%' or r.body ilike '%rough%' or r.body ilike '%cart path%'
          or r.body ilike '%sprinkler%' or r.body ilike '%branch%' or r.body ilike '%group%'
          or r.body ilike '%foursome%')`);

await c.query("commit");

const audit = await c.query(`
  select
    (select count(*)::int from staff_queue) open,
    (select count(*)::int from staff_queue where ack_overdue) overdue,
    (select count(*)::int from staff_queue where now()-created_at < interval '4 hours') recent,
    (select count(*)::int from reports where resolved_at > now() - interval '1 day') resolved_today,
    (select to_char(max(created_at),'HH24:MI') from reports) newest`);
const a = audit.rows[0];
console.log(`open ${a.open}  ·  in last 4h ${a.recent}  ·  overdue ${a.overdue}  ·  resolved today ${a.resolved_today}  ·  newest ${a.newest}`);
await c.end();
