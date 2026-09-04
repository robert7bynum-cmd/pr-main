-- One definition of "what the staff queue shows", used by the app and by the
-- local dev database alike, so both render identical data.

create or replace view staff_queue as
select
  r.id,
  r.course_id,
  r.department_id,
  r.status,
  r.urgency,
  r.category,
  r.body,
  r.ai_summary,
  r.created_at,
  r.acknowledged_at,
  r.claimed_by,
  r.scheduled_for,
  l.name          as location_name,
  l.hole_number,
  d.name          as department_name,
  d.key           as department_key,
  cp.full_name    as claimed_by_name,
  -- Minutes open drives the ordering and the age counter on the card.
  (extract(epoch from (now() - r.created_at)) / 60)::int as minutes_open,
  rr.ack_sla_minutes,
  (r.acknowledged_at is null
     and now() > r.created_at + make_interval(mins => rr.ack_sla_minutes)) as ack_overdue
from reports r
join locations   l  on l.id = r.location_id
left join departments  d  on d.id = r.department_id
left join profiles     cp on cp.id = r.claimed_by
left join routing_rules rr on rr.course_id = r.course_id and rr.category = r.category
where r.status in ('new','triaged','acknowledged','in_progress','scheduled');

comment on view staff_queue is
  'Open reports only. Resolved and closed work belongs in analytics, not the queue.';
