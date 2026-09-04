-- Escalation: nothing stays open silently.
--
-- Pure SQL and scheduled inside the database, so it does not depend on the web
-- app being reachable. If Vercel is down, escalation still runs.

-- Course-local quiet hours. A report filed at 8pm and handled at 6:30am is not
-- a ten-hour failure, and nobody should be paged at 4am about a bunker rake.
create or replace function within_quiet_hours(p_course_id uuid, p_at timestamptz default now())
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_tz    text;
  v_start text;
  v_end   text;
  v_local time;
begin
  select timezone, settings->'quiet_hours'->>'start', settings->'quiet_hours'->>'end'
    into v_tz, v_start, v_end
    from courses where id = p_course_id;

  if v_start is null or v_end is null then return false; end if;

  v_local := (p_at at time zone coalesce(v_tz, 'UTC'))::time;

  -- Quiet hours normally wrap midnight (20:00 -> 06:00).
  if v_start::time > v_end::time then
    return v_local >= v_start::time or v_local < v_end::time;
  end if;
  return v_local >= v_start::time and v_local < v_end::time;
end;
$$;

-- One pass. Idempotent per level, so running it twice a minute changes nothing.
create or replace function escalate_reports()
returns table (report_id uuid, level int, notified int)
language plpgsql volatile security definer set search_path = public as $$
declare
  r          record;
  v_count    int;
  v_targets  uuid[];
begin
  for r in
    select rep.id, rep.course_id, rep.department_id, rep.escalation_level,
           rep.created_at, rep.acknowledged_at, rr.ack_sla_minutes, rr.resolve_sla_minutes
      from reports rep
      left join routing_rules rr
        on rr.course_id = rep.course_id and rr.category = rep.category
     where rep.status in ('new','triaged','acknowledged','in_progress')
       and not within_quiet_hours(rep.course_id)
  loop
    -- Level 1: nobody has picked it up inside the acknowledge SLA.
    if r.escalation_level < 1
       and r.acknowledged_at is null
       and now() > r.created_at + make_interval(mins => coalesce(r.ack_sla_minutes, 15))
    then
      select array_agg(p.id) into v_targets
        from profiles p
       where p.course_id = r.course_id and p.active and p.role in ('supervisor','manager','owner');

      insert into notifications (report_id, course_id, profile_id, channel, status)
      select r.id, r.course_id, unnest(coalesce(v_targets, '{}')), 'push', 'queued';
      get diagnostics v_count = row_count;

      update reports set escalation_level = 1 where id = r.id;
      insert into report_events (report_id, course_id, type, payload)
      values (r.id, r.course_id, 'escalated',
              jsonb_build_object('level', 1, 'reason', 'no acknowledgement within SLA',
                                 'notified', v_count));

      report_id := r.id; level := 1; notified := v_count; return next;

    -- Level 2: still not resolved well past the resolve SLA.
    elsif r.escalation_level < 2
       and now() > r.created_at + make_interval(mins => coalesce(r.resolve_sla_minutes, 120))
    then
      select array_agg(p.id) into v_targets
        from profiles p
       where p.course_id = r.course_id and p.active and p.role in ('manager','owner');

      insert into notifications (report_id, course_id, profile_id, channel, status)
      select r.id, r.course_id, unnest(coalesce(v_targets, '{}')), 'push', 'queued';
      get diagnostics v_count = row_count;

      update reports set escalation_level = 2 where id = r.id;
      insert into report_events (report_id, course_id, type, payload)
      values (r.id, r.course_id, 'escalated',
              jsonb_build_object('level', 2, 'reason', 'not resolved within SLA',
                                 'notified', v_count));

      report_id := r.id; level := 2; notified := v_count; return next;
    end if;
  end loop;
end;
$$;

revoke execute on function escalate_reports()  from public, anon;
revoke execute on function within_quiet_hours(uuid, timestamptz) from public, anon;
