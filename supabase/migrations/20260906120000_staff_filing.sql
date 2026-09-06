-- Only members could file.
--
-- submit_report (20260904220000) has been the sole writer of reports, and it
-- needs a placard token and a scan nonce — a phone at a tee box. reports.source
-- has carried 'staff' and 'phone_relay' since 20260903120100, and
-- reports.filed_by has sat next to it, and nothing has ever written either.
-- So the pro shop takes a phoned-in complaint on a notepad, the superintendent
-- who spots a broken sprinkler on the morning drive radios it, and neither
-- reaches the queue, the clocks, or the record the club is sold on. Staff spot
-- most problems first; the product only counted the ones a member typed.
--
-- file_report is the staff path. Same shape as the member path from the row
-- down — a reports row, a triage_queue row in the same transaction, a created
-- event — so triage, route_report, escalation and push are untouched and treat
-- the two identically. What differs is who: the caller is auth.uid(), must be
-- an active profile, and is written to filed_by and to the event's actor_id,
-- because a report a person filed is an action that person took. The location
-- must be at the caller's club, and one message covers both "another club's"
-- and "does not exist", so ids cannot be probed through this any more than
-- through assert_actor.
--
-- The queue learns two things. staff_queue now carries filed_by, the filer's
-- name and the source, so the card can say "Filed by Miguel · by phone" instead
-- of implying a member wrote it. And my_queue gains a fourth reason to see a
-- report: you filed it. Without that, a pro shop member who logs a maintenance
-- complaint watches it vanish from their own screen the moment routing moves
-- it to Course Maintenance — which is exactly the "I filed it and nothing
-- happened" that this repo's queue rule exists to prevent.
--
-- locations.active is added here so a retired location can stop being offered
-- for filing without deleting the reports that reference it. Added with IF NOT
-- EXISTS: another change on the same day adds the identical column.

alter table locations add column if not exists active boolean not null default true;

-- ------------------------------------------------------------ file_report
create or replace function file_report(
  p_location_id    uuid,
  p_body           text,
  p_source         report_source,
  p_reporter_name  text default null,
  p_reporter_phone text default null
)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_course uuid;
  v_report reports%rowtype;
begin
  -- The same refusal assert_actor gives, worded the same, so a signed-out
  -- caller and an offboarded one learn nothing they did not already know.
  if v_caller is null then
    raise exception 'Staff actions require a signed-in user.' using errcode = '42501';
  end if;

  select course_id into v_course from profiles where id = v_caller and active;
  if v_course is null then
    raise exception 'Staff actions require a signed-in user.' using errcode = '42501';
  end if;

  -- member_qr is the placard path and carries a scan nonce; it cannot be
  -- claimed from here.
  if p_source is null or p_source not in ('staff', 'phone_relay') then
    raise exception 'A staff-filed report is staff or phone_relay.' using errcode = '22023';
  end if;

  if p_body is null or length(btrim(p_body)) < 3 then
    raise exception 'Please describe the issue.' using errcode = '22023';
  end if;

  -- One message whether the location is at another club, retired, or invented.
  perform 1 from locations
   where id = p_location_id and course_id = v_course and active;
  if not found then
    raise exception 'that location is not at your club' using errcode = '22023';
  end if;

  insert into reports (
    course_id, location_id, body, source, filed_by,
    reporter_name, reporter_phone
  ) values (
    v_course, p_location_id, btrim(p_body), p_source, v_caller,
    -- A name and number belong to the member who phoned, and only then. A
    -- staff member's own name is filed_by, not reporter_name.
    case when p_source = 'phone_relay' then nullif(btrim(coalesce(p_reporter_name, '')), '') end,
    case when p_source = 'phone_relay' then nullif(btrim(coalesce(p_reporter_phone, '')), '') end
  ) returning * into v_report;

  -- Same transaction as the row, exactly as submit_report does: the queue row
  -- is what guarantees triage, and the kick trigger asks the worker to come.
  insert into triage_queue (report_id) values (v_report.id);

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (v_report.id, v_course, 'created', v_caller,
          jsonb_build_object('source', p_source,
                             'location_id', p_location_id,
                             'filed_by', v_caller));

  return v_report.id;
end;
$$;

revoke all on function file_report(uuid, text, report_source, text, text) from public, anon;
grant execute on function file_report(uuid, text, report_source, text, text) to authenticated;

-- ------------------------------------------------------------ staff_queue
-- 20260904100000's definition with three columns appended: who filed it, their
-- name, and the source. CREATE OR REPLACE keeps every existing column in place
-- so my_queue and the app's select * keep working; the reloptions are restated
-- below because replacing a view resets them.
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
     and now() > r.created_at + make_interval(mins => rr.ack_sla_minutes)) as ack_overdue,
  r.filed_by,
  fp.full_name    as filed_by_name,
  r.source
from reports r
join locations   l  on l.id = r.location_id
left join departments  d  on d.id = r.department_id
left join profiles     cp on cp.id = r.claimed_by
left join profiles     fp on fp.id = r.filed_by
left join routing_rules rr on rr.course_id = r.course_id and rr.category = r.category
where r.status in ('new','triaged','acknowledged','in_progress','scheduled');

comment on view staff_queue is
  'Open reports only. Resolved and closed work belongs in analytics, not the queue.';

-- Views bypass RLS unless told not to (20260904200000). Restated because a
-- replaced view comes back without it.
alter view staff_queue set (security_invoker = on);
revoke all on staff_queue from anon;
grant select on staff_queue to authenticated;

-- ------------------------------------------------------------ my_queue
-- 20260905140000's definition plus the fourth reason: you filed it.
create or replace view my_queue as
select q.*
  from staff_queue q
 where exists (
   select 1 from profiles p
    where p.id = auth.uid() and p.active and p.course_id = q.course_id
      and (
        p.role in ('manager', 'owner')
        or exists (select 1 from staff_departments sd
                    where sd.profile_id = p.id and sd.department_id = q.department_id)
        or exists (select 1 from notifications n
                    where n.report_id = q.id and n.profile_id = p.id)
        or q.claimed_by = p.id
        -- The person who filed it keeps seeing it, whichever department
        -- routing hands it to. "I logged it and it disappeared" is the same
        -- failure as "I scanned it and nothing showed up".
        or q.filed_by = p.id
      )
 );

alter view my_queue set (security_invoker = on);
revoke all on my_queue from anon;
grant select on my_queue to authenticated;

comment on view my_queue is
  'The signed-in person''s queue. staff_queue remains the course-wide view that management reporting uses.';
