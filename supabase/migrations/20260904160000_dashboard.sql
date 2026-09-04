-- Management reporting. Every figure derives from report_events timestamps
-- rather than mutable columns on reports, so a number on a GM's screen can
-- always be traced back to the event that produced it.

-- Headline figures for "today".
create or replace view dashboard_today as
select
  r.course_id,
  count(*) filter (where r.status in ('new','triaged','acknowledged','in_progress','scheduled'))::int as open_now,
  count(*) filter (where r.created_at::date = (now() at time zone c.timezone)::date)::int as filed_today,
  count(*) filter (where r.resolved_at::date = (now() at time zone c.timezone)::date)::int as resolved_today,
  -- The member's experience: submitted to somebody picking it up.
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.acknowledged_at - r.created_at)) / 60
  ) filter (where r.acknowledged_at is not null
              and r.created_at > now() - interval '30 days')::numeric, 0) as median_ack_minutes,
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.resolved_at - r.created_at)) / 60
  ) filter (where r.resolved_at is not null
              and r.created_at > now() - interval '30 days')::numeric, 0) as median_resolve_minutes
from reports r
join courses c on c.id = r.course_id
group by r.course_id;

-- Volume per day, for the trend line.
create or replace view dashboard_daily as
select course_id, created_at::date as day, count(*)::int as filed
from reports
where created_at > now() - interval '30 days'
group by 1, 2
order by 2;

-- Where the work actually is.
create or replace view dashboard_by_department as
select
  d.course_id, d.key, d.name,
  count(*) filter (where r.status in ('new','triaged','acknowledged','in_progress','scheduled'))::int as open_now,
  count(*)::int as total_30d,
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.resolved_at - r.created_at)) / 60
  ) filter (where r.resolved_at is not null)::numeric, 0) as median_resolve_minutes
from departments d
join reports r on r.department_id = d.id and r.created_at > now() - interval '30 days'
group by d.course_id, d.key, d.name
order by open_now desc, total_30d desc;

-- The recurring-problem list. This is the view that earns the renewal: it turns
-- a month of complaints into "hole 4 irrigation, nine times" — something a
-- superintendent can actually act on.
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
group by r.course_id, location, r.category
having count(*) >= 3
order by occurrences desc;

-- Per-person accountability, using the fair clock: notified to acknowledged,
-- not submitted to acknowledged. Charging someone for routing delay they had no
-- part in is how staff stop trusting the numbers.
create or replace view dashboard_by_person as
select
  p.course_id, p.id as profile_id, p.full_name,
  count(*) filter (where r.resolved_by = p.id)::int as resolved_30d,
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (r.resolved_at - r.acknowledged_at)) / 60
  ) filter (where r.resolved_by = p.id and r.acknowledged_at is not null)::numeric, 0)
    as median_handling_minutes
from profiles p
left join reports r on r.course_id = p.course_id and r.created_at > now() - interval '30 days'
where p.account_kind = 'individual' and p.active
group by p.course_id, p.id, p.full_name
having count(*) filter (where r.resolved_by = p.id) > 0
order by resolved_30d desc;
