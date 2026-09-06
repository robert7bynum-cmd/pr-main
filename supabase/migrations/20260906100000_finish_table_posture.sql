-- Finishing the table posture 20260906070000 started, and three smaller holes
-- found on the same pass.
--
-- 1. Five tables a manager could still rewrite by hand.
--
--    20260906070000 closed reports, report_events and routing_rules and then
--    stopped, leaving locations, departments, qr_codes, venues and
--    pending_profiles with their first-day `mgmt_write for all` policy, on the
--    grounds that it was "still their only write path". It was nobody's write
--    path: no code in app/, lib/ or components/ writes any of the five.
--    lib/placards/queries.ts reads qr_codes and locations, lib/staff/queries.ts
--    and app/actions/staff.ts read pending_profiles and departments,
--    app/app/rules/page.tsx and lib/queue/reports.ts read departments and
--    locations. Reads, every one. Meanwhile a manager holding a session could
--    PostgREST an UPDATE onto qr_codes and re-point a placard at another hole,
--    deactivate every code in the club, or rewrite a pending invitation's role
--    to 'owner' before it was claimed — none of it audited, because the audit
--    row is written by functions and these were not function calls. Supabase's
--    advisor flags the same five tables for duplicate permissive SELECT
--    policies (mgmt_write's ALL overlaps staff_read), which is how they were
--    found.
--
--    Both lines close, as before: the policy goes, and the write privileges go
--    with it. staff_read keeps SELECT on four of them. pending_profiles never
--    had a read policy of its own — mgmt_write's ALL was doing that job — so it
--    gets mgmt_read, the same predicate, SELECT only, which is what
--    lib/staff/queries.ts and resetPassword() in app/actions/staff.ts rely on.
--    Self-serve placards and locations will come back as RPCs with audit rows,
--    the way routing rules did in 20260905130000; until then they are seeded.
--
-- 2. invite_staff checked the role being written, not the role being replaced.
--
--    It upserts pending_profiles on (course_id, email) and sets role =
--    excluded.role, but assert_can_manage(p_role) was asked only about the NEW
--    role. So a manager could call invite_staff for the address of a pending
--    OWNER invitation with role 'staff', demote the unclaimed row to staff, and
--    then — since create_staff_invite trusts the pending row's role — mint a
--    sign-in link for it. set_staff_role already asks about
--    greatest(current, new) for exactly this reason; invite_staff now does too.
--
-- 3. submit_report lost its per-placard limit in the nonce rewrite.
--
--    The first submit_report (20260903120300) refused more than five reports
--    from one placard in two minutes. 20260904220000 replaced it with the
--    single-use nonce and dropped that check, reasoning that a nonce per scan
--    was limit enough. Then app/actions/submit-report.ts learned to mint a
--    fresh nonce when the old one was stale, so the only limit left was
--    issue_scan_nonce's twenty per placard per five minutes — twenty reports
--    from one bench in five minutes, each paged to a person. The check is
--    restored, and placed BEFORE the nonce is consumed: a refused submission
--    must not also burn the member's nonce, or the retry path would mint
--    another and the refusal would cost a scan.
--
-- 4. scan_nonces only ever grew.
--
--    149 rows for 13 reports on the live database, with nothing deleting them.
--    purge_scan_nonces() removes rows older than a day (a nonce is dead after
--    two hours) and runs as a third statement in the escalate sweep, which is
--    the job that already exists for "every minute, in the database".
--    Follow-up, not done here: system_alerts has the same shape and no
--    retention either.
--
-- 5. Foreign keys with no index behind them: notifications.profile_id and
--    course_id, report_events.actor_id, reports.claimed_by and resolved_by,
--    staff_departments.department_id, routing_rules.department_id,
--    qr_codes.location_id, staff_invites.course_id and created_by. Each is a
--    join or a cascade the app performs; staff_roster()'s resolved_30d count
--    walks reports.resolved_by per profile.
--
-- Everything here is re-runnable: drop policy if exists, create index if not
-- exists, create or replace, and a to_regclass guard on the revoke loop, as
-- 20260906070000 does.

-- ------------------------------------------------------------ 1. five tables
drop policy if exists mgmt_write on departments;
drop policy if exists mgmt_write on locations;
drop policy if exists mgmt_write on qr_codes;
drop policy if exists mgmt_write on venues;
drop policy if exists mgmt_write on pending_profiles;

-- The read that mgmt_write's ALL was quietly providing. Management only, as
-- before: an unclaimed invitation carries a colleague's email and phone.
drop policy if exists mgmt_read on pending_profiles;
create policy mgmt_read on pending_profiles for select to authenticated
  using (course_id = auth_course_id() and auth_is_management());

do $$
declare t text;
begin
  foreach t in array array[
    'departments', 'locations', 'qr_codes', 'venues', 'pending_profiles'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'revoke insert, update, delete, truncate, trigger, references on public.%I from authenticated', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------ 2. invite_staff
create or replace function invite_staff(
  p_email text, p_full_name text, p_role staff_role,
  p_department_ids uuid[] default '{}', p_phone text default null
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare g record; v_id uuid; v_email text := lower(btrim(p_email)); v_existing staff_role;
begin
  select * into g from assert_can_manage(p_role);

  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'a valid email is required' using errcode = '22023';
  end if;

  -- Whose invitation is this replacing? The upsert below overwrites the role on
  -- an existing pending row, so the guard is asked about both the role already
  -- there and the one being written — as set_staff_role does — and a manager
  -- cannot demote an owner's unclaimed invitation and then mint a link for it.
  -- greatest() ignores a null, so with no existing row this repeats the check
  -- above and changes nothing.
  select pp.role into v_existing
    from pending_profiles pp
   where pp.course_id = g.course_id and pp.email = v_email
   limit 1;

  perform assert_can_manage(greatest(v_existing, p_role));

  -- Somebody with a live account is not invited again. Allowing it would create
  -- an unclaimed pending row carrying whatever role the caller chose, and the
  -- invitation path would then trust that role instead of the real one.
  if exists (
    select 1 from profiles p
     where p.course_id = g.course_id and p.active and lower(p.email) = v_email
  ) then
    raise exception 'that person already has an account' using errcode = '22023';
  end if;

  insert into pending_profiles (course_id, email, full_name, phone, role, department_ids)
  values (g.course_id, v_email, btrim(p_full_name), p_phone, p_role, p_department_ids)
  on conflict (course_id, email) do update
    set full_name = excluded.full_name, role = excluded.role,
        phone = excluded.phone, department_ids = excluded.department_ids,
        claimed_at = null
  returning id into v_id;

  perform log_admin_event(g.course_id, g.actor_id, 'staff_invited', v_id,
    jsonb_build_object('email', v_email, 'role', p_role));
  return v_id;
end;
$$;

-- Restated after the create-or-replace: a replaced function must not drift back
-- to the default of EXECUTE for PUBLIC, which is how this surface leaked before.
revoke all on function invite_staff(text,text,staff_role,uuid[],text) from public, anon, authenticated;
grant execute on function invite_staff(text,text,staff_role,uuid[],text) to authenticated;

-- ------------------------------------------------------------ 3. submit_report
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

-- The member path: anon must keep it. Restated exactly as 20260904220000.
revoke all on function submit_report      from public;
grant execute on function submit_report(text,text,text,uuid,text,text,text,text,text,text) to anon, authenticated;

-- ------------------------------------------------------------ 4. scan_nonces
create or replace function purge_scan_nonces()
returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_n int;
begin
  -- A nonce is refused after two hours whatever its state; a day is generous
  -- and keeps the last few hours around for anyone reading the table by hand.
  delete from scan_nonces where issued_at < now() - interval '1 day';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function purge_scan_nonces() from public, anon, authenticated;
grant execute on function purge_scan_nonces() to service_role;

-- The escalate sweep from 20260905150000, byte for byte, plus the purge.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — skipping (not a Supabase database)';
    return;
  end if;

  perform cron.unschedule('proresponse-escalate')
    where exists (select 1 from cron.job where jobname = 'proresponse-escalate');

  perform cron.schedule('proresponse-escalate', '* * * * *', $job$
    select escalate_reports();
    select record_heartbeat('sweep', jsonb_build_object(
      'untriaged', (select count(*) from reports where status='new'
                     and created_at < now() - interval '5 minutes'),
      'dead_letter', (select count(*) from triage_queue where status='dead_letter')));
    select purge_scan_nonces();
  $job$);
end $$;

-- ------------------------------------------------------------ 5. indexes
create index if not exists notifications_profile_id_idx      on notifications (profile_id);
create index if not exists notifications_course_id_idx       on notifications (course_id);
create index if not exists report_events_actor_id_idx        on report_events (actor_id);
create index if not exists reports_claimed_by_idx            on reports (claimed_by);
create index if not exists reports_resolved_by_idx           on reports (resolved_by);
create index if not exists staff_departments_department_id_idx on staff_departments (department_id);
create index if not exists routing_rules_department_id_idx   on routing_rules (department_id);
create index if not exists qr_codes_location_id_idx          on qr_codes (location_id);
create index if not exists staff_invites_course_id_idx       on staff_invites (course_id);
create index if not exists staff_invites_created_by_idx      on staff_invites (created_by);
