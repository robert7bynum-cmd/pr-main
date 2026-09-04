-- The two doors a member is allowed through, plus the resolve helper.
-- Both are SECURITY DEFINER and validate their own inputs, because anon has no
-- table privileges whatsoever.

-- ------------------------------------------------ what the scan page loads
-- Resolves a placard token to its club + location, so the form can open already
-- knowing where the member is standing. Returns branding for the page.
create or replace function get_scan_context(p_token text)
returns table (
  course_id   uuid,
  course_name text,
  course_slug text,
  settings    jsonb,
  location_id uuid,
  location_name text,
  hole_number int
)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.slug, c.settings, l.id, l.name, l.hole_number
  from qr_codes q
  join courses   c on c.id = q.course_id
  join locations l on l.id = q.location_id
  where q.token = p_token and q.active
$$;

-- ------------------------------------------------------- member submission
-- One transaction: the report and its queue item commit together, so work can
-- never go missing even if the webhook never fires.
create or replace function submit_report(
  p_token       text,
  p_body        text,
  p_location_id uuid    default null,   -- only if the member corrected the hole
  p_photo_path  text    default null,
  p_name        text    default null,
  p_phone       text    default null,
  p_member_no   text    default null,
  p_sms_opt_in  boolean default false,
  p_language    text    default 'en'
)
returns table (report_id uuid, tracking_token text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_qr       qr_codes%rowtype;
  v_location uuid;
  v_recent   int;
  v_report   reports%rowtype;
begin
  if p_body is null or length(btrim(p_body)) < 3 then
    raise exception 'Please describe the issue.' using errcode = '22023';
  end if;

  select * into v_qr from qr_codes where token = p_token and active;
  if not found then
    raise exception 'This code is not active.' using errcode = '22023';
  end if;

  -- Honour a corrected location, but only within the same club.
  v_location := v_qr.location_id;
  if p_location_id is not null then
    perform 1 from locations
     where id = p_location_id and course_id = v_qr.course_id;
    if found then v_location := p_location_id; end if;
  end if;

  -- Cheap flood control per placard.
  select count(*) into v_recent
    from reports
   where qr_code_id = v_qr.id and created_at > now() - interval '2 minutes';
  if v_recent >= 5 then
    raise exception 'Too many reports from this location just now.'
      using errcode = '53400';
  end if;

  insert into reports (
    course_id, location_id, qr_code_id, body, photo_path,
    reporter_name, reporter_phone, reporter_member_no,
    sms_opt_in, reporter_language, source
  ) values (
    v_qr.course_id, v_location, v_qr.id, btrim(p_body), p_photo_path,
    nullif(btrim(coalesce(p_name,'')), ''), nullif(btrim(coalesce(p_phone,'')), ''),
    nullif(btrim(coalesce(p_member_no,'')), ''),
    coalesce(p_sms_opt_in, false), coalesce(p_language, 'en'), 'member_qr'
  ) returning * into v_report;

  -- Same transaction: report exists => work item exists.
  insert into triage_queue (report_id) values (v_report.id);

  insert into report_events (report_id, course_id, type, payload)
  values (v_report.id, v_report.course_id, 'created',
          jsonb_build_object('source','member_qr','location_id',v_location));

  return query select v_report.id, v_report.tracking_token;
end;
$$;

-- --------------------------------------------------- member status lookup
-- Deliberately narrow: status, their own words, and the message staff chose for
-- them. Never the internal note, staff names, or routing.
create or replace function get_report_status(p_tracking_token text)
returns table (
  status         report_status,
  location_name  text,
  hole_number    int,
  body           text,
  member_message text,
  created_at     timestamptz,
  resolved_at    timestamptz,
  course_name    text,
  settings       jsonb
)
language sql stable security definer set search_path = public as $$
  select r.status, l.name, l.hole_number, r.body, r.member_message,
         r.created_at, r.resolved_at, c.name, c.settings
  from reports r
  join locations l on l.id = r.location_id
  join courses   c on c.id = r.course_id
  where r.tracking_token = p_tracking_token
$$;

revoke all on function submit_report    from public;
revoke all on function get_scan_context from public;
revoke all on function get_report_status from public;
grant execute on function submit_report(text,text,uuid,text,text,text,text,boolean,text) to anon, authenticated;
grant execute on function get_scan_context(text)  to anon, authenticated;
grant execute on function get_report_status(text) to anon, authenticated;
