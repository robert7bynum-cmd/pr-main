-- Food and drink is something a member can order, not something they report.
--
-- 20260906180000 made the member number required for food, but it did it by
-- treating an order as a complaint that happened to need a number: the member
-- had to type an order into a box headed "What did you notice?", the keyword
-- pass had to guess from their words that it was an order at all, and the
-- kitchen saw a report to investigate. A member wanting two hot dogs was using
-- a fault-reporting form, and the guessing was load-bearing.
--
-- Ordering is now its own path. The member taps "order food and drink" on the
-- placard page, says what they want, and gives their member number — which is
-- not optional here and never was the point of the keyword rules. Because the
-- member declared what this is, nothing has to classify it: submit_order sets
-- the category and routes through route_report immediately, so the kitchen is
-- paged in the same transaction that takes the order rather than a sweep
-- later. "The model classifies; data routes" — an order is data.
--
-- What this migration does NOT do, deliberately: no menu (the club would have
-- to maintain one, and the request was that a member simply ask), no prices
-- and no payment (the order names the member and the club charges it through
-- their own point of sale, so nothing here touches money), and no new queue
-- (an order rides the same reports table, routing rules, escalation, paging
-- and history as everything else; only the words on the screen differ).
--
--   submit_order()          the member's second write. Anonymous, nonce-bound
--                           and flood-limited exactly as submit_report is, and
--                           refuses without a member number.
--   member_no_required()    an order always needs one, whatever the club's
--                           routing rules say. Gains p_kind; the views pass it.
--   resolve_report()        same gate, now also unconditional for an order.
--   update_course_settings()  gains p_ordering_enabled, so a club whose
--                           kitchen is shut can turn the path off. Absent
--                           means on, which is what every existing club gets.
--   staff_queue / my_queue  carry `kind`, so the card can say "Order".

-- ------------------------------------------------------------- the rule

-- New signature first; the two views still hold the four-argument one, and
-- Postgres will not drop a function a view depends on. It goes after the views
-- are re-created below.

create or replace function member_no_required(
  p_course uuid, p_category text, p_source report_source, p_department uuid,
  p_kind text default 'issue'
) returns boolean
language sql stable set search_path = public as $$
  select
    -- An order is a member asking for something to be brought to them and put
    -- on their account. Without the number there is no account to put it on,
    -- so this one does not depend on the club's routing rules at all.
    p_kind = 'order'
    or (
      p_source is distinct from 'staff'
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
      )
    );
$$;
revoke all on function member_no_required(uuid, text, report_source, uuid, text) from public, anon;
grant execute on function member_no_required(uuid, text, report_source, uuid, text) to authenticated, service_role;

-- --------------------------------------------------------- taking an order

create or replace function submit_order(
  p_token     text,
  p_nonce     text,
  p_body      text,
  p_member_no text,
  p_name      text default null,
  p_phone     text default null,
  p_language  text default 'en'
)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_qr       qr_codes%rowtype;
  v_course   courses%rowtype;
  v_report   reports%rowtype;
  v_nonce_id uuid;
  v_recent   int;
  v_member   text := nullif(btrim(coalesce(p_member_no, '')), '');
begin
  if p_body is null or length(btrim(p_body)) < 3 then
    raise exception 'Please say what you would like.' using errcode = '22023';
  end if;

  -- The whole reason this path exists. Matched by lib/queue/member-number.ts,
  -- which is the one copy of this sentence the app reads.
  if v_member is null then
    raise exception 'A member number is needed for this request.' using errcode = '22023';
  end if;

  select * into v_qr from qr_codes where token = p_token and active;
  if not found then
    raise exception 'This code is not active.' using errcode = '22023';
  end if;

  select * into v_course from courses where id = v_qr.course_id;

  -- A club whose kitchen is shut turns the path off; absent means on. The
  -- member page hides the option too, so this is the second line, for a form
  -- that was already open when the club closed it.
  if (v_course.settings ->> 'ordering_enabled') = 'false' then
    raise exception 'Food and drink ordering is closed right now.' using errcode = '22023';
  end if;

  -- Flood control, per placard, before the nonce is touched: a refused
  -- submission keeps its nonce, so the member's retry is not also a re-scan.
  -- Orders and reports share one counter — five things from one bench in two
  -- minutes is the same signal whichever form they came from.
  select count(*) into v_recent from reports
   where qr_code_id = v_qr.id and created_at > now() - interval '2 minutes';
  if v_recent >= 5 then
    raise exception 'Too many reports from this location just now.' using errcode = '53400';
  end if;

  update scan_nonces set used_at = now()
   where nonce = p_nonce and qr_code_id = v_qr.id and used_at is null
     and issued_at > now() - interval '2 hours'
  returning id into v_nonce_id;

  if v_nonce_id is null then
    raise exception 'This form has expired. Please scan the code again.'
      using errcode = '22023';
  end if;

  -- Category is set here, not guessed later: the member tapped "order food and
  -- drink". urgency stays 'normal' — a hungry fourball is not an emergency and
  -- must never outrank one — and the SLA the club set for f_and_b is what the
  -- card counts against.
  insert into reports (
    course_id, location_id, qr_code_id, body, kind, category, urgency,
    reporter_name, reporter_phone, reporter_member_no, reporter_language, source
  ) values (
    v_qr.course_id, v_qr.location_id, v_qr.id, btrim(p_body), 'order', 'f_and_b', 'normal',
    nullif(btrim(coalesce(p_name,'')), ''), nullif(btrim(coalesce(p_phone,'')), ''),
    v_member, coalesce(p_language, 'en'), 'member_qr'
  ) returning * into v_report;

  insert into triage_queue (report_id) values (v_report.id);

  insert into report_events (report_id, course_id, type, payload)
  values (v_report.id, v_report.course_id, 'created',
          jsonb_build_object('source', 'member_qr', 'kind', 'order',
                             'location_id', v_qr.location_id));

  -- Routed inside the same transaction as the order. A report can wait a
  -- minute for the sweep; an order that sits unrouted is a member watching an
  -- empty fairway. route_report writes the 'triaged' and 'routed' events,
  -- queues the notifications and marks the queue row done.
  begin
    perform route_report(v_report.id, 'f_and_b', 'normal'::report_urgency, null, null, 'declared'::triage_source);
  exception when sqlstate '53400' then
    -- route_report raises this when the order reached nobody at all. Taking
    -- the order anyway would be the silence this codebase does not allow, so
    -- the whole thing rolls back and the member is told plainly.
    raise exception 'Nobody is available to take orders right now.' using errcode = '53400';
  end;

  return v_report.id;
end;
$$;
revoke all on function submit_order(text,text,text,text,text,text,text) from public;
grant execute on function submit_order(text,text,text,text,text,text,text) to anon, authenticated, service_role;

-- --------------------------------------------------------- resolving an order

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
     and member_no_required(v_rep.course_id, v_rep.category, v_rep.source,
                            v_rep.department_id, v_rep.kind) then
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
            'closed_before_routing', not coalesce(v_was_routed, false),
            -- 'Delivered' and 'resolved' are the same row; the timeline says
            -- which word the person on the card actually saw.
            'kind', v_rep.kind));

  if p_member_message is not null then
    insert into report_events (report_id, course_id, type, actor_id, payload)
    values (p_report_id, v_course, 'member_notified', p_actor,
            jsonb_build_object('message', p_member_message));
  end if;
end;
$$;
revoke all on function resolve_report(uuid, uuid, text, text, text) from public, anon;
grant execute on function resolve_report(uuid, uuid, text, text, text) to authenticated, service_role;

-- --------------------------------------------------------------- the views

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
  member_no_required(r.course_id, r.category, r.source, r.department_id, r.kind) as member_no_required,
  r.kind
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

-- Nothing holds the four-argument form now. One function, one answer.
drop function if exists member_no_required(uuid, text, report_source, uuid);

-- ------------------------------------------------------- the club's switch

drop function if exists update_course_settings(text,text,text,text,text,int);

create or replace function update_course_settings(
  p_name text, p_timezone text, p_public_url text, p_quiet_start text, p_quiet_end text,
  p_retention_days int default null,
  p_ordering_enabled boolean default true
) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  g          record;
  v_course   courses%rowtype;
  v_name     text := btrim(coalesce(p_name, ''));
  v_url      text;
  v_settings jsonb;
  v_before   jsonb;
  v_after    jsonb;
  v_from     jsonb := '{}'::jsonb;
  v_to       jsonb := '{}'::jsonb;
  v_key      text;
  v_changed  int := 0;
  -- SHARED WITH lib/placards/origin.ts — UNPRINTABLE_HOST_PATTERN and
  -- UNPRINTABLE_PREVIEW_PATTERN, verbatim. scripts/test-placard-origin.mts
  -- asserts that 20260906130000 contains both strings exactly as that module
  -- exports them; these are the same strings.
  v_host_pattern    text := '^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$|/)';
  v_preview_pattern text := '-git-[^.]+\.vercel\.app';
begin
  select * into g from assert_can_manage(null);
  select * into v_course from courses where id = g.course_id;

  if length(v_name) not between 2 and 80 then
    raise exception 'the club name must be between 2 and 80 characters' using errcode = '22023';
  end if;

  if p_timezone is null
     or not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'unknown timezone' using errcode = '22023';
  end if;

  v_url := nullif(regexp_replace(btrim(coalesce(p_public_url, '')), '/+$', ''), '');
  if v_url is not null then
    if v_url !~* '^https://[^/\s]+' then
      raise exception 'the address must start with https://' using errcode = '22023';
    end if;
    if regexp_replace(v_url, '^https?://', '', 'i') ~* v_host_pattern
       or v_url ~* v_preview_pattern then
      raise exception 'that address cannot go on a printed sign' using errcode = '22023';
    end if;
  end if;

  if (p_quiet_start is null) <> (p_quiet_end is null) then
    raise exception 'quiet hours need both a start and an end' using errcode = '22023';
  end if;
  if p_quiet_start is not null
     and (p_quiet_start !~ '^([01]\d|2[0-3]):[0-5]\d$' or p_quiet_end !~ '^([01]\d|2[0-3]):[0-5]\d$') then
    raise exception 'quiet hours must be HH:MM' using errcode = '22023';
  end if;

  if p_retention_days is not null and p_retention_days not between 30 and 3650 then
    raise exception 'contact details can be kept for between 30 and 3650 days' using errcode = '22023';
  end if;

  v_settings := v_course.settings;
  v_settings := case when v_url is null then v_settings - 'public_url'
                     else jsonb_set(v_settings, '{public_url}', to_jsonb(v_url)) end;
  v_settings := case when p_quiet_start is null then v_settings - 'quiet_hours'
                     else jsonb_set(v_settings, '{quiet_hours}',
                            jsonb_build_object('start', p_quiet_start, 'end', p_quiet_end)) end;
  v_settings := case when p_retention_days is null then v_settings - 'retention_days'
                     else jsonb_set(v_settings, '{retention_days}', to_jsonb(p_retention_days)) end;
  -- Stored only when it is off, so "on" is the absence of the key and every
  -- club that existed before this migration has ordering without being touched.
  v_settings := case when coalesce(p_ordering_enabled, true) then v_settings - 'ordering_enabled'
                     else jsonb_set(v_settings, '{ordering_enabled}', to_jsonb(false)) end;

  v_before := jsonb_build_object('name', v_course.name, 'timezone', v_course.timezone,
                                 'public_url', v_course.settings -> 'public_url',
                                 'quiet_hours', v_course.settings -> 'quiet_hours',
                                 'retention_days', v_course.settings -> 'retention_days',
                                 'ordering_enabled', v_course.settings -> 'ordering_enabled');
  v_after  := jsonb_build_object('name', v_name, 'timezone', p_timezone,
                                 'public_url', v_settings -> 'public_url',
                                 'quiet_hours', v_settings -> 'quiet_hours',
                                 'retention_days', v_settings -> 'retention_days',
                                 'ordering_enabled', v_settings -> 'ordering_enabled');

  for v_key in select jsonb_object_keys(v_after) loop
    if v_before -> v_key is distinct from v_after -> v_key then
      v_from := v_from || jsonb_build_object(v_key, v_before -> v_key);
      v_to   := v_to   || jsonb_build_object(v_key, v_after -> v_key);
      v_changed := v_changed + 1;
    end if;
  end loop;

  if v_changed = 0 then
    return 0;
  end if;

  update courses set name = v_name, timezone = p_timezone, settings = v_settings
   where id = g.course_id;

  perform log_admin_event(g.course_id, g.actor_id, 'settings_changed', g.course_id,
    jsonb_build_object('kind', 'club', 'from', v_from, 'to', v_to));
  return v_changed;
end;
$$;
revoke all on function update_course_settings(text,text,text,text,text,int,boolean) from public, anon;
grant execute on function update_course_settings(text,text,text,text,text,int,boolean) to authenticated;
