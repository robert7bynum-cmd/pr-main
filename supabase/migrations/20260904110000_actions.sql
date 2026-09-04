-- Staff actions on a report. Each is one transaction that moves the report and
-- writes the event in the same breath, so report_events can never disagree with
-- the row it describes — every metric is derived from those events.

-- Acknowledge = claim. Notifying five grounds crew is right; five people
-- driving to the same bunker is not, and "everyone assumed someone else took
-- it" is worse than either.
create or replace function acknowledge_report(p_report_id uuid, p_actor uuid)
returns table (ok boolean, claimed_by_name text)
language plpgsql volatile security definer set search_path = public as $$
declare v_report reports%rowtype; v_name text;
begin
  select * into v_report from reports where id = p_report_id for update;
  if not found then raise exception 'report not found' using errcode = '22023'; end if;

  -- Someone already owns it: report who, rather than silently stealing it.
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
  update reports set status = 'in_progress', claimed_by = coalesce(claimed_by, p_actor)
   where id = p_report_id returning course_id into v_course;
  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'note', p_actor, '{"note":"started work"}'::jsonb);
end;
$$;

-- Resolve. The internal note and the member-facing message are separate
-- arguments and separate columns on purpose: staff write candidly for their own
-- record, and a member must never see it.
create or replace function resolve_report(
  p_report_id      uuid,
  p_actor          uuid,
  p_internal_note  text,
  p_member_message text default null
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid;
begin
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

-- The honest alternative to a false "done" when a part is on order. Without
-- this, SLA pressure makes staff choose between lying and an escalation they
-- do not deserve, and the data quietly rots.
create or replace function schedule_report(
  p_report_id uuid, p_actor uuid, p_date date, p_note text default null
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid;
begin
  update reports set status = 'scheduled', scheduled_for = p_date,
                     claimed_by = coalesce(claimed_by, p_actor)
   where id = p_report_id returning course_id into v_course;
  if v_course is null then raise exception 'report not found' using errcode='22023'; end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'scheduled', p_actor,
          jsonb_build_object('scheduled_for', p_date, 'note', p_note));
end;
$$;

-- Triage will be wrong sometimes. If the cart barn cannot bounce a maintenance
-- issue in one tap they will ignore it, and the timing data becomes garbage.
-- Every re-route is also the best available signal for tuning routing rules.
create or replace function reroute_report(
  p_report_id uuid, p_actor uuid, p_department_id uuid
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_report reports%rowtype;
begin
  select * into v_report from reports where id = p_report_id for update;
  if not found then raise exception 'report not found' using errcode='22023'; end if;

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

-- Joke reports and things that fixed themselves need a close that is NOT
-- counted as a resolution, or every prank inflates the resolve-time average.
create or replace function close_no_action(
  p_report_id uuid, p_actor uuid, p_reason close_reason
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid;
begin
  update reports set status = 'closed_no_action', close_reason = p_reason,
                     resolved_at = now(), resolved_by = p_actor
   where id = p_report_id returning course_id into v_course;
  if v_course is null then raise exception 'report not found' using errcode='22023'; end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'note', p_actor,
          jsonb_build_object('closed_no_action', p_reason));
end;
$$;

revoke all on function acknowledge_report from public;
revoke all on function start_report       from public;
revoke all on function resolve_report     from public;
revoke all on function schedule_report    from public;
revoke all on function reroute_report     from public;
revoke all on function close_no_action    from public;
