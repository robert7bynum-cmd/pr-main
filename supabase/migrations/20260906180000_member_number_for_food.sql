-- A food and drink request carries the member number from the tee to the till.
--
-- The placard form has asked for a member number since the first migration,
-- and nothing ever read it: not the queue card, not the report page, not the
-- resolve step. So the kitchen got "two hot dogs and a lemonade to the turn,
-- please" with no way to know whose account it went on, and a report could be
-- marked resolved with the number never recorded. The club's request is that
-- for any food request the number is captured end to end — asked for when the
-- report is made, shown to the team that handles it, and required before the
-- request is closed as done.
--
-- Which requests? A column on routing_rules, because that table is where the
-- club — not the software — decides what each category means for them
-- (`requires_photo` already sits there for the same reason). This migration
-- turns it on for `f_and_b` at every club and in create_club; the routing
-- screen lets a manager change it. The rule applies to reports a member made
-- (scanned a placard, or phoned the pro shop); a report a member of staff
-- filed about something they saw — the grill is out of propane — is not a
-- member's order and needs nobody's number.
--
-- Three places enforce it, through one function, member_no_required():
--
--   submit_report / file_report   the keyword matcher runs on the words as
--                                 they arrive; if it says the report is a
--                                 category that needs a number and none was
--                                 given, the submission is refused before the
--                                 scan nonce is touched, so the member adds
--                                 the number and sends the same form again.
--                                 Best effort — the model may classify
--                                 differently later — and so never the only
--                                 gate.
--
--   resolve_report                the hard gate. Gains p_member_no, so the
--                                 person closing it can record the number the
--                                 member gave them over the counter; refuses
--                                 when the rule applies and there is still no
--                                 number on the report. close_no_action is
--                                 untouched: a duplicate or a prank leaves the
--                                 queue without one, and is not counted as
--                                 resolved.
--
--   record_member_no              the number on its own, for the F&B lead who
--                                 rang the member back an hour before anyone
--                                 resolves anything. resolve_report calls it,
--                                 so there is one write path and one 'note'
--                                 event, {member_no_recorded: true}, with the
--                                 actor and never the number itself — the
--                                 retention purge clears the column, and an
--                                 event that kept a copy would defeat it.
--
-- The views carry `reporter_member_no` and `member_no_required` so the card
-- can show the number, or that it is missing, before anyone taps Resolve.
-- purge_expired() now clears the member number with the name, phone and email
-- and names it in the retention note. The four-argument resolve_report and the
-- five-argument file_report are dropped so PostgREST sees one of each.

-- --------------------------------------------------------------- the rule

alter table routing_rules
  add column if not exists requires_member_no boolean not null default false;

update routing_rules set requires_member_no = true where category = 'f_and_b';

-- One question, asked in three places: does this report need a member number?
-- Reads the club's own table, so the answer changes when the club changes the
-- rule. Not SECURITY DEFINER: the views are security_invoker and staff may
-- read routing_rules, so it runs as whoever asks.
create or replace function member_no_required(
  p_course uuid, p_category text, p_source report_source
) returns boolean
language sql stable set search_path = public as $$
  select p_source is distinct from 'staff'
     and exists (
       select 1 from routing_rules rr
        where rr.course_id = p_course
          and rr.category = p_category
          and rr.requires_member_no
     );
$$;
revoke all on function member_no_required(uuid, text, report_source) from public, anon;
grant execute on function member_no_required(uuid, text, report_source) to authenticated, service_role;

-- ------------------------------------------------------------- the intake

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
  if v_member is null and member_no_required(v_qr.course_id, v_kw, 'member_qr') then
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

-- Staff filing gains the member's number for a phoned-in request. The same
-- intake gate applies to phone_relay — the member is on the line, ask them —
-- and never to 'staff', which member_no_required() excludes.
drop function if exists file_report(uuid, text, report_source, text, text);

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
  if v_member is null and member_no_required(v_course, v_kw, p_source) then
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

-- ------------------------------------------------------- recording the number

-- Writes the number and says so. The event never carries the number: the
-- column is the one copy, and retention clears it.
create or replace function record_member_no(
  p_report_id uuid, p_actor uuid, p_member_no text
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_course uuid;
  v_no     text := nullif(btrim(coalesce(p_member_no, '')), '');
  v_old    text;
begin
  v_course := assert_actor(p_report_id, p_actor);

  if v_no is null then
    raise exception 'A member number is needed for this request.' using errcode = '22023';
  end if;

  select reporter_member_no into v_old from reports where id = p_report_id;
  if v_old is not distinct from v_no then
    return;   -- already recorded; nothing to write and nothing to note
  end if;

  update reports set reporter_member_no = v_no where id = p_report_id;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'note', p_actor,
          jsonb_build_object('member_no_recorded', true,
                             'replaced', v_old is not null));
end;
$$;
revoke all on function record_member_no(uuid, uuid, text) from public, anon;
grant execute on function record_member_no(uuid, uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------ the hard gate

drop function if exists resolve_report(uuid, uuid, text, text);

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

  -- A number handed over at the counter is recorded first, through the one
  -- function that writes it, so the gate below sees it.
  if nullif(btrim(coalesce(p_member_no, '')), '') is not null then
    perform record_member_no(p_report_id, p_actor, p_member_no);
  end if;

  select * into v_rep from reports where id = p_report_id;

  if v_rep.reporter_member_no is null
     and member_no_required(v_rep.course_id, v_rep.category, v_rep.source) then
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
            -- Recorded rather than inferred from a missing routed event, so a
            -- fast fix and a lost report never look the same.
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

-- --------------------------------------------------------------- the views

-- Both re-created rather than altered: my_queue is `select q.*` and a view's
-- star is expanded when it is defined, so it would not see new columns.
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
  r.source,
  -- The member's number, and whether this report must have one before it is
  -- resolved — so the card can show the gap before anyone taps Resolve.
  r.reporter_member_no,
  member_no_required(r.course_id, r.category, r.source) as member_no_required
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
        -- The person who filed it keeps seeing it, whichever department
        -- routing hands it to. "I logged it and it disappeared" is the same
        -- failure as "I scanned it and nothing showed up".
        or q.filed_by = p.id
      )
 );

alter view my_queue set (security_invoker = on);
revoke all on my_queue from anon;
grant select on my_queue to authenticated;

-- --------------------------------------------------------- the rules screen

drop function if exists routing_rules_for_club();

create function routing_rules_for_club()
returns table (
  category text, department_id uuid, department_name text,
  ack_sla_minutes int, resolve_sla_minutes int, reports_30d int,
  requires_member_no boolean
)
language sql stable security definer set search_path = public as $$
  select rr.category, rr.department_id, d.name,
         rr.ack_sla_minutes, rr.resolve_sla_minutes,
         (select count(*)::int from reports r
           where r.course_id = rr.course_id and r.category = rr.category
             and r.created_at > now() - interval '30 days'),
         rr.requires_member_no
    from routing_rules rr
    join departments d on d.id = rr.department_id
   where rr.course_id = auth_course_id() and auth_is_management()
   order by 6 desc, rr.category;
$$;
revoke all on function routing_rules_for_club() from public, anon;
grant execute on function routing_rules_for_club() to authenticated, service_role;

-- requires_member_no is optional in each rule object so a caller built before
-- this migration changes nothing it did not send.
create or replace function update_routing_rules(p_rules jsonb)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  g       record;
  r       jsonb;
  v_count int := 0;
  v_old   routing_rules%rowtype;
  v_req   boolean;
begin
  select * into g from assert_can_manage();

  for r in select * from jsonb_array_elements(p_rules) loop
    select * into v_old
      from routing_rules
     where course_id = g.course_id and category = (r->>'category');

    if not found then
      raise exception 'unknown category %', r->>'category' using errcode = '22023';
    end if;

    -- The department must belong to this club; a crafted id would otherwise
    -- route a club's reports at another club's team.
    if not exists (
      select 1 from departments
       where id = (r->>'department_id')::uuid and course_id = g.course_id
    ) then
      raise exception 'unknown department for this club' using errcode = '22023';
    end if;

    -- Bounds rather than free numbers: a zero-minute SLA pages everyone
    -- instantly and forever, and a 30-day one means escalation never happens.
    if (r->>'ack_sla_minutes')::int not between 1 and 1440
       or (r->>'resolve_sla_minutes')::int not between 1 and 10080 then
      raise exception 'SLA out of range' using errcode = '22023';
    end if;
    if (r->>'resolve_sla_minutes')::int < (r->>'ack_sla_minutes')::int then
      raise exception 'resolve time cannot be shorter than acknowledge time'
        using errcode = '22023';
    end if;

    v_req := coalesce((r->>'requires_member_no')::boolean, v_old.requires_member_no);

    update routing_rules set
      department_id       = (r->>'department_id')::uuid,
      ack_sla_minutes     = (r->>'ack_sla_minutes')::int,
      resolve_sla_minutes = (r->>'resolve_sla_minutes')::int,
      requires_member_no  = v_req
    where course_id = g.course_id and category = (r->>'category');

    -- Only record what actually changed, so the log stays readable.
    if v_old.department_id       is distinct from (r->>'department_id')::uuid
       or v_old.ack_sla_minutes     is distinct from (r->>'ack_sla_minutes')::int
       or v_old.resolve_sla_minutes is distinct from (r->>'resolve_sla_minutes')::int
       or v_old.requires_member_no  is distinct from v_req
    then
      perform log_admin_event(g.course_id, g.actor_id, 'routing_rule_changed', null,
        jsonb_build_object(
          'category', r->>'category',
          'from', jsonb_build_object('department_id', v_old.department_id,
                                     'ack', v_old.ack_sla_minutes,
                                     'resolve', v_old.resolve_sla_minutes,
                                     'requires_member_no', v_old.requires_member_no),
          'to',   jsonb_build_object('department_id', r->>'department_id',
                                     'ack', (r->>'ack_sla_minutes')::int,
                                     'resolve', (r->>'resolve_sla_minutes')::int,
                                     'requires_member_no', v_req)));
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;
revoke all on function update_routing_rules(jsonb) from public, anon;
grant execute on function update_routing_rules(jsonb) to authenticated, service_role;

-- ------------------------------------------------------------ a new club

-- Identical to 20260906170000 but for the one column: a club made today
-- starts with the food rule on, like every club that existed before.
create or replace function create_club(
  p_slug text, p_name text, p_timezone text, p_owner_email text, p_owner_name text
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_slug   text := btrim(coalesce(p_slug, ''));
  v_name   text := btrim(coalesce(p_name, ''));
  v_email  text := lower(btrim(coalesce(p_owner_email, '')));
  v_owner  text := btrim(coalesce(p_owner_name, ''));
  v_course uuid;
  v_depts  uuid[];
begin
  -- The slug is in every placard URL, so it has to be something a member's
  -- phone can be handed without escaping and a person can read off a sign.
  if v_slug !~ '^[a-z0-9-]{3,40}$' then
    raise exception 'the slug must be 3 to 40 lowercase letters, digits or hyphens' using errcode = '22023';
  end if;
  if exists (select 1 from courses where slug = v_slug) then
    raise exception 'that club already exists' using errcode = '23505';
  end if;
  if length(v_name) not between 2 and 80 then
    raise exception 'the club name must be between 2 and 80 characters' using errcode = '22023';
  end if;
  if p_timezone is null
     or not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'unknown timezone' using errcode = '22023';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'the owner needs an email address' using errcode = '22023';
  end if;
  if length(v_owner) not between 2 and 80 then
    raise exception 'the owner''s name must be between 2 and 80 characters' using errcode = '22023';
  end if;

  insert into courses (slug, name, timezone, settings)
  values (v_slug, v_name, p_timezone, '{}'::jsonb)
  returning id into v_course;

  -- docs/taxonomy.md, Departments table, in the order it lists them.
  insert into departments (course_id, key, name, sort_order) values
    (v_course, 'maintenance',  'Course Maintenance', 1),
    (v_course, 'cart_fleet',   'Cart Fleet',         2),
    (v_course, 'pro_shop',     'Pro Shop',           3),
    (v_course, 'pace_of_play', 'Player Assistance',  4),
    (v_course, 'f_and_b',      'Food & Beverage',    5),
    (v_course, 'caddie',       'Caddie & Valet',     6),
    (v_course, 'management',   'Management',         7);

  -- docs/taxonomy.md, Categories table: category, department key, ack,
  -- resolve, and whether a member number is needed to resolve.
  insert into routing_rules (course_id, category, department_id, ack_sla_minutes, resolve_sla_minutes, requires_member_no)
  select v_course, t.category, d.id, t.ack, t.resolve, t.member_no
    from (values
      ('pace_of_play',        'pace_of_play', 10, 30,  false),
      ('course_maintenance',  'maintenance',  15, 240, false),
      ('cart_issue',          'cart_fleet',   10, 45,  false),
      ('pro_shop',            'pro_shop',     15, 60,  false),
      ('f_and_b',             'f_and_b',      10, 30,  true),
      ('restroom_facilities', 'maintenance',  20, 120, false),
      ('practice_facility',   'pro_shop',     30, 240, false),
      ('safety',              'management',    5, 30,  false),
      ('caddie_valet',        'caddie',       10, 30,  false),
      ('needs_review',        'management',   15, 120, false)
    ) as t(category, dept_key, ack, resolve, member_no)
    join departments d on d.course_id = v_course and d.key = t.dept_key;

  -- The owner sees the whole course, the way invite.mts scopes a manager.
  -- claim_profile turns this row into a profile on their first sign-in.
  select array_agg(id order by sort_order) into v_depts from departments where course_id = v_course;
  insert into pending_profiles (course_id, email, full_name, role, department_ids)
  values (v_course, v_email, v_owner, 'owner', v_depts);

  -- No actor: this ran from the command line, before the club had anyone.
  perform log_admin_event(v_course, null, 'settings_changed', v_course,
    jsonb_build_object('event', 'club_created', 'slug', v_slug, 'owner_email', v_email));

  return v_course;
end;
$$;
revoke all on function create_club(text,text,text,text,text) from public, anon, authenticated;
grant execute on function create_club(text,text,text,text,text) to service_role;

-- --------------------------------------------------------------- retention

-- The member number is a contact detail like the other three: it identifies a
-- person, and once the order is on the account it has no further use.
create or replace function purge_expired()
returns table (nonces int, alerts int, contacts int)
language plpgsql volatile security definer set search_path = public as $$
begin
  -- A nonce is refused after two hours whatever its state; a day is generous
  -- and keeps the last few hours around for anyone reading the table by hand.
  delete from scan_nonces where issued_at < now() - interval '1 day';
  get diagnostics nonces = row_count;

  -- An alert is kept for a month after it cleared so "did the scheduler stop
  -- last week?" is still answerable. An unresolved alert is never purged.
  delete from system_alerts where resolved_at < now() - interval '30 days';
  get diagnostics alerts = row_count;

  -- Contact details. Each club's period is settings.retention_days; 90 when
  -- the club has never set one. The report itself stays — body, category,
  -- location, every event — because the metrics are about the course, not the
  -- member. One 'note' event per report says what went, so a timeline that
  -- shows no phone number is telling the truth about why.
  with due as (
    select r.id, r.course_id,
           array_remove(array[
             case when r.reporter_name      is not null then 'reporter_name'      end,
             case when r.reporter_phone     is not null then 'reporter_phone'     end,
             case when r.reporter_email     is not null then 'reporter_email'     end,
             case when r.reporter_member_no is not null then 'reporter_member_no' end
           ], null) as cleared
      from reports r
      join courses c on c.id = r.course_id
     where r.created_at < now() - make_interval(days =>
             coalesce((c.settings ->> 'retention_days')::int, 90))
       and (r.reporter_name is not null
            or r.reporter_phone is not null
            or r.reporter_email is not null
            or r.reporter_member_no is not null)
  ), cleared as (
    update reports r
       set reporter_name = null, reporter_phone = null, reporter_email = null,
           reporter_member_no = null
      from due
     where r.id = due.id
    returning due.id, due.course_id, due.cleared
  )
  insert into report_events (report_id, course_id, type, actor_id, payload)
  select id, course_id, 'note', null,
         jsonb_build_object('retention', true, 'cleared', to_jsonb(cleared))
    from cleared;
  get diagnostics contacts = row_count;

  return next;
end;
$$;
revoke all on function purge_expired() from public, anon, authenticated;
grant execute on function purge_expired() to service_role;
