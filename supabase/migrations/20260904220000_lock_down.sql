-- Shrinking the public surface to the minimum the product actually needs.
--
-- Before this, three things were reachable without a session: the scan context,
-- report submission, and a member status lookup. ProResponse is an operations
-- tool — members file and hear nothing back — so the status lookup goes, and
-- submission becomes single-use per scan rather than an endpoint anyone can
-- replay from a copied URL.

-- ---------------------------------------------------------------- no loop-back
-- Members no longer read anything at all. Dropping the grant removes the last
-- anonymous read path in the system.
revoke execute on function get_report_status(text) from anon, authenticated;
drop function if exists get_report_status(text);

-- ------------------------------------------------------------- one scan, one report
-- A scan mints a short-lived single-use nonce. Submitting consumes it. Someone
-- who copies the URL off a placard and hammers it gets one report, not a flood,
-- and cannot script against the endpoint without scanning again.
create table scan_nonces (
  id          uuid primary key default gen_random_uuid(),
  qr_code_id  uuid not null references qr_codes(id) on delete cascade,
  nonce       text not null unique default encode(gen_random_bytes(18), 'hex'),
  issued_at   timestamptz not null default now(),
  used_at     timestamptz,
  ip_hash     text
);
create index on scan_nonces (nonce) where used_at is null;
create index on scan_nonces (qr_code_id, issued_at desc);

alter table scan_nonces enable row level security;  -- no policies: service/RPC only

-- Issued when the reporter page loads. Rate limited per placard so a script
-- cannot mint nonces faster than people can physically scan.
create or replace function issue_scan_nonce(p_token text)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_qr    qr_codes%rowtype;
  v_recent int;
  v_nonce  text;
begin
  select * into v_qr from qr_codes where token = p_token and active;
  if not found then
    raise exception 'This code is not active.' using errcode = '22023';
  end if;

  select count(*) into v_recent from scan_nonces
   where qr_code_id = v_qr.id and issued_at > now() - interval '5 minutes';
  if v_recent >= 20 then
    raise exception 'Too many scans from this location just now.' using errcode = '53400';
  end if;

  insert into scan_nonces (qr_code_id) values (v_qr.id) returning nonce into v_nonce;
  return v_nonce;
end;
$$;

-- Submission now requires that nonce, and consumes it.
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
begin
  if p_body is null or length(btrim(p_body)) < 3 then
    raise exception 'Please describe the issue.' using errcode = '22023';
  end if;

  select * into v_qr from qr_codes where token = p_token and active;
  if not found then
    raise exception 'This code is not active.' using errcode = '22023';
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
    nullif(btrim(coalesce(p_email,'')), ''), nullif(btrim(coalesce(p_member_no,'')), ''),
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

alter table reports add column if not exists reporter_email text;

-- The old signature must go, or PostgREST keeps exposing the un-nonced overload.
drop function if exists submit_report(text,text,uuid,text,text,text,text,boolean,text);

revoke all on function submit_report      from public;
revoke all on function issue_scan_nonce   from public;
grant execute on function submit_report(text,text,text,uuid,text,text,text,text,text,text) to anon, authenticated;
grant execute on function issue_scan_nonce(text) to anon, authenticated;
