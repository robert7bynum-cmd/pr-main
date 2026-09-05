-- An action is attributed to the person performing it, enforced by the database.
--
-- CC6 in this repo's rules already says it: "Actions are attributed to an
-- authenticated principal or they do not happen." The six staff actions took
-- the actor as an argument and believed it. They are SECURITY DEFINER, so RLS
-- never constrained them, and `authenticated` holds EXECUTE on all six.
--
-- So any staff member with a session and the network tab open could:
--   * resolve, close or reroute ANY report by id — including another club's
--   * attribute that action to ANY profile id they cared to type
--
-- The only thing standing in the way was currentStaffId() in
-- lib/queue/actions-db.ts passing the right value — an application convention,
-- not a control. The accountability record is the product here: a GM answers
-- "how fast did we respond, and who handled it" from these events. An actor a
-- caller can choose makes that record forgeable, which is worse than not
-- collecting it, because it looks authoritative.
--
-- The guard is deliberately not "is this person allowed to act on reports".
-- It is narrower and harder to get wrong: you are who the session says you
-- are, and the report is at your club. Cross-club failures reuse the exact
-- 'report not found' message a genuinely missing report gives, so nobody can
-- discover that another club's report exists by probing ids.
--
-- Safe by inspection: every call site in app/, lib/ and components/ passes
-- currentStaffId(), which returns auth.getUser().id — the same value auth.uid()
-- returns inside the database. No SQL path calls these; the worker and cron
-- never do. This tightens what is possible without changing what the app does.
create or replace function assert_actor(p_report_id uuid, p_actor uuid)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_caller       uuid := auth.uid();
  v_caller_club  uuid;
  v_report_club  uuid;
begin
  if v_caller is null then
    raise exception 'Staff actions require a signed-in user.' using errcode = '42501';
  end if;

  if p_actor is distinct from v_caller then
    raise exception 'An action must be attributed to the person performing it.'
      using errcode = '42501';
  end if;

  select course_id into v_caller_club
    from profiles where id = v_caller and active;
  if v_caller_club is null then
    -- Deactivated staff keep a valid session until it expires. Offboarding has
    -- to stop actions, not merely stop pages.
    raise exception 'Staff actions require a signed-in user.' using errcode = '42501';
  end if;

  select course_id into v_report_club from reports where id = p_report_id;
  if v_report_club is null or v_report_club <> v_caller_club then
    raise exception 'report not found' using errcode = '22023';
  end if;

  return v_report_club;
end;
$$;

revoke all on function assert_actor(uuid, uuid) from public, anon;
grant execute on function assert_actor(uuid, uuid) to authenticated;

create or replace function acknowledge_report(p_report_id uuid, p_actor uuid)
returns table (ok boolean, claimed_by_name text)
language plpgsql volatile security definer set search_path = public as $$
declare v_report reports%rowtype; v_name text;
begin
  perform assert_actor(p_report_id, p_actor);
  select * into v_report from reports where id = p_report_id for update;
  if not found then raise exception 'report not found' using errcode = '22023'; end if;

  if v_report.claimed_by is not null and v_report.claimed_by <> p_actor then
    select full_name into v_name from profiles where id = v_report.claimed_by;
    return query select false, v_name;
    return;
  end if;

  update reports set
    status          = 'acknowledged',
    claimed_by      = p_actor,
    claimed_at      = coalesce(claimed_at, now()),
    acknowledged_at = coalesce(acknowledged_at, now())
  where id = p_report_id;

  insert into report_events (report_id, course_id, type, actor_id)
  values (p_report_id, v_report.course_id, 'acknowledged', p_actor);

  select full_name into v_name from profiles where id = p_actor;
  return query select true, v_name;
end;
$$;

create or replace function start_report(p_report_id uuid, p_actor uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid;
begin
  perform assert_actor(p_report_id, p_actor);
  update reports set status = 'in_progress', claimed_by = coalesce(claimed_by, p_actor)
   where id = p_report_id returning course_id into v_course;

  if v_course is null then
    raise exception 'report not found' using errcode = '22023';
  end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'note', p_actor, '{"note":"started work"}'::jsonb);
end;
$$;

create or replace function resolve_report(
  p_report_id      uuid,
  p_actor          uuid,
  p_internal_note  text,
  p_member_message text default null
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid;
begin
  perform assert_actor(p_report_id, p_actor);
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
          jsonb_build_object('has_member_message', p_member_message is not null));

  if p_member_message is not null then
    insert into report_events (report_id, course_id, type, actor_id, payload)
    values (p_report_id, v_course, 'member_notified', p_actor,
            jsonb_build_object('message', p_member_message));
  end if;
end;
$$;

create or replace function schedule_report(
  p_report_id uuid, p_actor uuid, p_date date, p_note text default null
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid;
begin
  perform assert_actor(p_report_id, p_actor);
  update reports set status = 'scheduled', scheduled_for = p_date,
                     claimed_by = coalesce(claimed_by, p_actor)
   where id = p_report_id returning course_id into v_course;
  if v_course is null then raise exception 'report not found' using errcode='22023'; end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'scheduled', p_actor,
          jsonb_build_object('scheduled_for', p_date, 'note', p_note));
end;
$$;

create or replace function reroute_report(
  p_report_id uuid, p_actor uuid, p_department_id uuid
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_report reports%rowtype;
begin
  perform assert_actor(p_report_id, p_actor);
  select * into v_report from reports where id = p_report_id for update;
  if not found then raise exception 'report not found' using errcode='22023'; end if;

  -- A department from another club would hand this report to strangers.
  perform 1 from departments
   where id = p_department_id and course_id = v_report.course_id;
  if not found then raise exception 'department not found' using errcode='22023'; end if;

  update reports set department_id = p_department_id, claimed_by = null, claimed_at = null
   where id = p_report_id;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_report.course_id, 'reassigned', p_actor,
          jsonb_build_object('from', v_report.department_id, 'to', p_department_id));

  with r as (select * from resolve_recipients(v_report.course_id, p_department_id))
  insert into notifications (report_id, course_id, profile_id, channel, status)
  select p_report_id, v_report.course_id, r.profile_id, 'push', 'queued' from r;
end;
$$;

create or replace function close_no_action(
  p_report_id uuid, p_actor uuid, p_reason close_reason
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid;
begin
  perform assert_actor(p_report_id, p_actor);
  update reports set status = 'closed_no_action', close_reason = p_reason,
                     resolved_at = now(), resolved_by = p_actor
   where id = p_report_id returning course_id into v_course;
  if v_course is null then raise exception 'report not found' using errcode='22023'; end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'note', p_actor,
          jsonb_build_object('closed_no_action', p_reason));
end;
$$;

-- Restated after every create-or-replace above, because replacing a function
-- resets its privileges to the default and would silently hand EXECUTE back to
-- PUBLIC — which is most of how this surface drifted in the first place.
do $$
declare sig text;
begin
  for sig in
    select p.oid::regprocedure::text from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('acknowledge_report','start_report','resolve_report',
                         'schedule_report','reroute_report','close_no_action')
  loop
    execute format('revoke all on function %s from public, anon', sig);
    execute format('grant execute on function %s to authenticated', sig);
  end loop;
end $$;
