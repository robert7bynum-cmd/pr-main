-- A report a person sends to the food and beverage team is theirs to number.
--
-- 20260906180000 keyed the member-number rule on the report's category.
-- Re-routing changes the department and leaves the category alone — that is
-- correct, a re-route is a routing correction and not a re-classification —
-- so an order the classifier could not read ("needs_review", to management)
-- that a manager then sent to Food & Beverage kept its old category, and the
-- rule did not apply. The F&B lead saw no badge, Resolve did not ask, and the
-- order left the queue with no account to charge. Found by walking the
-- feature as the manager, not by any suite.
--
-- member_no_required() now also takes the report's department: the rule
-- applies when the category requires it, OR when the report is not at its
-- category's own home and is at a department that some requiring category
-- routes to. The second clause is deliberately narrow — a pro-shop request
-- sitting at a shared "Clubhouse" department that pro_shop itself routes to
-- is where its rule put it, and is not treated as an order.
--
-- Same function name, one more argument; the three-argument form is dropped
-- so there is one. The views and the report page pass the department.

-- The three-argument form is dropped at the END of this migration: the two
-- views depend on it, and Postgres refuses to drop a function a view uses.
-- New signature first, views repointed, then the old one goes.

create or replace function member_no_required(
  p_course uuid, p_category text, p_source report_source, p_department uuid
) returns boolean
language sql stable set search_path = public as $$
  select p_source is distinct from 'staff'
     and (
       exists (
         select 1 from routing_rules rr
          where rr.course_id = p_course
            and rr.category = p_category
            and rr.requires_member_no
       )
       or (
         p_department is not null
         and not exists (
           select 1 from routing_rules rr
            where rr.course_id = p_course
              and rr.category = p_category
              and rr.department_id = p_department
         )
         and exists (
           select 1 from routing_rules rr
            where rr.course_id = p_course
              and rr.department_id = p_department
              and rr.requires_member_no
         )
       )
     );
$$;
revoke all on function member_no_required(uuid, text, report_source, uuid) from public, anon;
grant execute on function member_no_required(uuid, text, report_source, uuid) to authenticated, service_role;

-- The views are re-created with the new call. Same columns, same order.
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
  (extract(epoch from (now() - r.created_at)) / 60)::int as minutes_open,
  rr.ack_sla_minutes,
  (r.acknowledged_at is null
     and now() > r.created_at + make_interval(mins => rr.ack_sla_minutes)) as ack_overdue,
  r.filed_by,
  fp.full_name    as filed_by_name,
  r.source,
  r.reporter_member_no,
  member_no_required(r.course_id, r.category, r.source, r.department_id) as member_no_required
from reports r
join locations   l  on l.id = r.location_id
left join departments  d  on d.id = r.department_id
left join profiles     cp on cp.id = r.claimed_by
left join profiles     fp on fp.id = r.filed_by
left join routing_rules rr on rr.course_id = r.course_id and rr.category = r.category
where r.status in ('new','triaged','acknowledged','in_progress','scheduled');

alter view staff_queue set (security_invoker = on);
revoke all on staff_queue from anon;
grant select on staff_queue to authenticated;

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
        or q.filed_by = p.id
      )
 );

alter view my_queue set (security_invoker = on);
revoke all on my_queue from anon;
grant select on my_queue to authenticated;

-- Nothing reads the three-argument form now. One function, one answer.
drop function if exists member_no_required(uuid, text, report_source);

-- resolve_report and the two intake functions call member_no_required with
-- the report's department (intake: none yet — a fresh report has no
-- department, so only the category clause can apply there).
create or replace function resolve_report(
  p_report_id      uuid,
  p_actor          uuid,
  p_internal_note  text,
  p_member_message text default null,
  p_member_no      text default null
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_course     uuid;
  v_was_routed boolean;
  v_rep        reports%rowtype;
begin
  perform assert_actor(p_report_id, p_actor);

  if nullif(btrim(coalesce(p_member_no, '')), '') is not null then
    perform record_member_no(p_report_id, p_actor, p_member_no);
  end if;

  select * into v_rep from reports where id = p_report_id;

  if v_rep.reporter_member_no is null
     and member_no_required(v_rep.course_id, v_rep.category, v_rep.source, v_rep.department_id) then
    raise exception 'A member number is needed for this request.' using errcode = '22023';
  end if;

  v_was_routed := v_rep.department_id is not null;

  update reports set
    status          = 'resolved',
    resolved_at     = now(),
    resolved_by     = p_actor,
    resolution_note = p_internal_note,
    member_message  = p_member_message,
    member_notified_at = case when p_member_message is not null then now() end
  where id = p_report_id
  returning course_id into v_course;

  if v_course is null then
    raise exception 'report not found' using errcode = '22023';
  end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'resolved', p_actor,
          jsonb_build_object(
            'has_member_message', p_member_message is not null,
            'closed_before_routing', not coalesce(v_was_routed, false)));

  if p_member_message is not null then
    insert into report_events (report_id, course_id, type, actor_id, payload)
    values (p_report_id, v_course, 'member_notified', p_actor,
            jsonb_build_object('message', p_member_message));
  end if;
end;
$$;
revoke all on function resolve_report(uuid, uuid, text, text, text) from public, anon;
grant execute on function resolve_report(uuid, uuid, text, text, text) to authenticated, service_role;

-- The intake functions, restated from 20260906180000 with the fourth argument.
create or replace function submit_report(
  p_token       text,
  p_nonce       text,
  p_body        text,
  p_location_id uuid    default null,
  p_photo_path  text    default null,
  p_name        text    default null,
  p_phone       text    default null,
  p_email       text    default null,
  p_member_no   text    default null,
  p_language    text    default 'en'
)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_qr       qr_codes%rowtype;
  v_location uuid;
  v_report   reports%rowtype;
  v_nonce_id uuid;
  v_recent   int;
  v_member   text := nullif(btrim(coalesce(p_member_no, '')), '');
  v_kw       text;
begin
  if p_body is null or length(btrim(p_body)) < 3 then
    raise exception 'Please describe the issue.' using errcode = '22023';
  end if;

  select * into v_qr from qr_codes where token = p_token and active;
  if not found then
    raise exception 'This code is not active.' using errcode = '22023';
  end if;

  -- Flood control, per placard, before the nonce is touched: a refused
  -- submission keeps its nonce, so the member's retry is not also a re-scan.
  select count(*) into v_recent from reports
   where qr_code_id = v_qr.id and created_at > now() - interval '2 minutes';
  if v_recent >= 5 then
    raise exception 'Too many reports from this location just now.' using errcode = '53400';
  end if;

  -- A food and drink request needs the member number, and the member is the
  -- only one who can supply it — so ask now, while they are still holding the
  -- form, rather than have the kitchen guess. Also before the nonce: the same
  -- scan sends the same report again with the number added. The text is
  -- matched by app/actions/submit-report.ts and held by scripts/test-nonce.mts.
  select category into v_kw from match_keywords(p_body);
  if v_member is null and member_no_required(v_qr.course_id, v_kw, 'member_qr', null) then
    raise exception 'A member number is needed for this request.' using errcode = '22023';
  end if;

  -- Single use: claim the nonce inside the same transaction as the insert, so
  -- two concurrent submissions cannot both succeed on one scan.
  update scan_nonces set used_at = now()
   where nonce = p_nonce and qr_code_id = v_qr.id and used_at is null
     and issued_at > now() - interval '2 hours'
  returning id into v_nonce_id;

  if v_nonce_id is null then
    raise exception 'This form has expired. Please scan the code again.'
      using errcode = '22023';
  end if;

  v_location := v_qr.location_id;
  if p_location_id is not null then
    perform 1 from locations where id = p_location_id and course_id = v_qr.course_id;
    if found then v_location := p_location_id; end if;
  end if;

  insert into reports (
    course_id, location_id, qr_code_id, body, photo_path,
    reporter_name, reporter_phone, reporter_email, reporter_member_no,
    reporter_language, source
  ) values (
    v_qr.course_id, v_location, v_qr.id, btrim(p_body), p_photo_path,
    nullif(btrim(coalesce(p_name,'')), ''), nullif(btrim(coalesce(p_phone,'')), ''),
    nullif(btrim(coalesce(p_email,'')), ''), v_member,
    coalesce(p_language, 'en'), 'member_qr'
  ) returning * into v_report;

  insert into triage_queue (report_id) values (v_report.id);
  insert into report_events (report_id, course_id, type, payload)
  values (v_report.id, v_report.course_id, 'created',
          jsonb_build_object('source','member_qr','location_id',v_location));

  -- Only the id, and only so the page can show a confirmation. No token is
  -- returned because there is nothing for a member to come back to.
  return v_report.id;
end;
$$;
revoke all on function submit_report(text,text,text,uuid,text,text,text,text,text,text) from public;
grant execute on function submit_report(text,text,text,uuid,text,text,text,text,text,text) to anon, authenticated, service_role;

create or replace function file_report(
  p_location_id        uuid,
  p_body               text,
  p_source             report_source,
  p_reporter_name      text default null,
  p_reporter_phone     text default null,
  p_reporter_member_no text default null
)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_course uuid;
  v_report reports%rowtype;
  v_member text;
  v_kw     text;
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

  -- A name and number belong to the member who phoned, and only then. A
  -- staff member's own name is filed_by, not reporter_name.
  v_member := case when p_source = 'phone_relay'
                   then nullif(btrim(coalesce(p_reporter_member_no, '')), '') end;

  select category into v_kw from match_keywords(p_body);
  if v_member is null and member_no_required(v_course, v_kw, p_source, null) then
    raise exception 'A member number is needed for this request.' using errcode = '22023';
  end if;

  insert into reports (
    course_id, location_id, body, source, filed_by,
    reporter_name, reporter_phone, reporter_member_no
  ) values (
    v_course, p_location_id, btrim(p_body), p_source, v_caller,
    case when p_source = 'phone_relay' then nullif(btrim(coalesce(p_reporter_name, '')), '') end,
    case when p_source = 'phone_relay' then nullif(btrim(coalesce(p_reporter_phone, '')), '') end,
    v_member
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
revoke all on function file_report(uuid, text, report_source, text, text, text) from public, anon;
grant execute on function file_report(uuid, text, report_source, text, text, text) to authenticated, service_role;
