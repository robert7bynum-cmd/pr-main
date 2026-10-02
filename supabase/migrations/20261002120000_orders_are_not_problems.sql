-- An order delivered in six minutes is not a sprinkler fixed in six minutes.
--
-- Same shape of bug as 20261002110000, found by looking for more of it: the
-- dashboard was written in 20260904160000, `reports.kind` arrived in
-- 20260917100000, and no migration since has touched these views. So every
-- figure a GM reads now mixes food orders in with problems.
--
-- Why it matters, and it gets worse rather than better: orders will be the
-- highest-volume category — drinks on a Saturday — and they resolve in
-- minutes, while a broken sprinkler takes hours. As ordering ramps up the
-- median resolve time collapses and the GM reads "we are getting faster"
-- when maintenance has not changed at all. The number the product is sold on
-- would be quietly lying.
--
-- `dashboard_recurring` is the worst of them. Its own comment says it is the
-- view that earns the renewal, turning a month of complaints into "hole 4
-- irrigation, nine times". With orders in it that becomes "Hole 9, f_and_b,
-- forty times", which is not a problem to fix — it is a thriving drinks
-- business filed as a fault.
--
-- This is the same rule as CLAUDE.md's two response clocks: measuring two
-- different things on one scale is how staff stop trusting the data.
--
-- Every existing column keeps its name, so nothing in lib/dashboard breaks.
-- The three medians now mean issues only. Order figures sit beside them.
--
-- NOTE for whoever adds a third kind: these views name 'issue' and 'order'
-- explicitly rather than saying "not an order". A new kind will therefore
-- appear in neither until someone decides where it belongs, which is the
-- intended behaviour — it forces the question instead of silently folding a
-- booking into the maintenance median.

create or replace view dashboard_today as
select
  r.course_id,
  count(*) filter (where r.status in ('new','triaged','acknowledged','in_progress','scheduled'))::int as open_now,
  count(*) filter (where r.created_at::date = (now() at time zone c.timezone)::date)::int as filed_today,
  count(*) filter (where r.resolved_at::date = (now() at time zone c.timezone)::date)::int as resolved_today,
  -- The member's experience: submitted to somebody picking it up. Problems
  -- only — an order is picked up in a minute and would flatter this.
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.acknowledged_at - r.created_at)) / 60
  ) filter (where r.acknowledged_at is not null and r.kind = 'issue'
              and r.created_at > now() - interval '30 days')::numeric, 0) as median_ack_minutes,
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.resolved_at - r.created_at)) / 60
  ) filter (where r.resolved_at is not null and r.kind = 'issue'
              and r.created_at > now() - interval '30 days')::numeric, 0) as median_resolve_minutes,
  -- Orders, counted and timed on their own terms.
  count(*) filter (where r.kind = 'order'
    and r.status in ('new','triaged','acknowledged','in_progress','scheduled'))::int as orders_open,
  count(*) filter (where r.kind = 'order'
    and r.created_at::date = (now() at time zone c.timezone)::date)::int as orders_today,
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.resolved_at - r.created_at)) / 60
  ) filter (where r.resolved_at is not null and r.kind = 'order'
              and r.created_at > now() - interval '30 days')::numeric, 0) as median_order_minutes
from reports r
join courses c on c.id = r.course_id
group by r.course_id;

alter view dashboard_today set (security_invoker = on);
revoke all on dashboard_today from anon;
grant select on dashboard_today to authenticated;

create or replace view dashboard_by_department as
select
  d.course_id, d.key, d.name,
  count(*) filter (where r.status in ('new','triaged','acknowledged','in_progress','scheduled'))::int as open_now,
  count(*)::int as total_30d,
  -- Problems only. Food & Beverage handles both "the beer is warm" and "two
  -- beers please"; averaging them tells the GM nothing about either.
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.resolved_at - r.created_at)) / 60
  ) filter (where r.resolved_at is not null and r.kind = 'issue')::numeric, 0) as median_resolve_minutes,
  count(*) filter (where r.kind = 'order')::int as orders_30d,
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.resolved_at - r.created_at)) / 60
  ) filter (where r.resolved_at is not null and r.kind = 'order')::numeric, 0) as median_order_minutes
from departments d
join reports r on r.department_id = d.id and r.created_at > now() - interval '30 days'
group by d.course_id, d.key, d.name
order by open_now desc, total_30d desc;

alter view dashboard_by_department set (security_invoker = on);
revoke all on dashboard_by_department from anon;
grant select on dashboard_by_department to authenticated;

-- The recurring-problem list. This is the view that earns the renewal: it turns
-- a month of complaints into "hole 4 irrigation, nine times" — something a
-- superintendent can actually act on. A member ordering a drink at the same
-- hole forty times is not a recurring problem, so orders are out.
create or replace view dashboard_recurring as
select
  r.course_id,
  coalesce('Hole ' || l.hole_number, l.name) as location,
  r.category,
  count(*)::int as occurrences,
  max(r.created_at) as most_recent
from reports r
join locations l on l.id = r.location_id
where r.created_at > now() - interval '30 days' and r.category is not null
  and r.kind = 'issue'
group by r.course_id, location, r.category
having count(*) >= 3
order by occurrences desc;

alter view dashboard_recurring set (security_invoker = on);
revoke all on dashboard_recurring from anon;
grant select on dashboard_recurring to authenticated;

-- Per-person accountability, using the fair clock: notified to acknowledged,
-- not submitted to acknowledged. Charging someone for routing delay they had no
-- part in is how staff stop trusting the numbers. Handling time is problems
-- only, for the same reason; deliveries are counted separately so a runner's
-- work still shows.
create or replace view dashboard_by_person as
select
  p.course_id, p.id as profile_id, p.full_name,
  count(*) filter (where r.resolved_by = p.id)::int as resolved_30d,
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.resolved_at - r.acknowledged_at)) / 60
  ) filter (where r.resolved_by = p.id and r.acknowledged_at is not null and r.kind = 'issue')::numeric, 0)
    as median_handling_minutes,
  count(*) filter (where r.resolved_by = p.id and r.kind = 'order')::int as orders_delivered_30d
from profiles p
left join reports r on r.course_id = p.course_id and r.created_at > now() - interval '30 days'
where p.account_kind = 'individual' and p.active
group by p.course_id, p.id, p.full_name
having count(*) filter (where r.resolved_by = p.id) > 0
order by resolved_30d desc;

alter view dashboard_by_person set (security_invoker = on);
revoke all on dashboard_by_person from anon;
grant select on dashboard_by_person to authenticated;
