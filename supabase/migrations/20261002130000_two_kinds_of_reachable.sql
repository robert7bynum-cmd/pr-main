-- Reachable by the product, and reachable by the watchdog, are not the same.
--
-- 20261002110000 gave the codebase one definition of "can this person be
-- reached" and pointed three callers at it. That was right for two of them
-- and wrong for the third, and the grep that found the original drift found
-- this too: watchdog_recipients still joins push_subscriptions alone.
--
-- It is not a fourth stale copy. It is a different question.
--
--   A report is delivered by the triage worker, which speaks web push, APNs
--   and FCM. For that, a phone counts — reachable_devices() is the answer.
--
--   A system alarm is delivered by app/api/watchdog, a Next.js route that
--   speaks web push only. Native delivery lives in the worker, and the whole
--   point of the external watchdog is that it still works when the worker
--   and the scheduler do not. It cannot borrow the worker's transport
--   without depending on the thing it exists to watch.
--
-- So pointing "No manager can receive system alerts" at reachable_devices()
-- this morning made it claim a phone-only manager is covered when the
-- watchdog cannot reach them at all. That alarm is about the watchdog's own
-- reach and must ask the watchdog's question. Corrected here, with the
-- distinction named in both places so the next person does not re-merge them.
--
-- "Staff on duty cannot be reached" is unchanged and still asks
-- reachable_devices(), because that one is about reports.

create or replace function watchdog_can_reach(p_profile uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  -- Web push only, deliberately. app/api/watchdog sends with VAPID and has no
  -- APNs or FCM transport; giving it one would mean a second copy of the
  -- worker's delivery code in the web app, and a watchdog that depends on the
  -- worker is not a watchdog. When the native apps ship, the honest fix is to
  -- teach this route the same transport, not to widen this predicate and
  -- pretend.
  select exists (select 1 from push_subscriptions s where s.profile_id = p_profile);
$$;
comment on function watchdog_can_reach(uuid) is
  'Can the external watchdog deliver an alarm to this person? Web push only — '
  'narrower than reachable_devices() on purpose. See 20261002130000.';
revoke all on function watchdog_can_reach(uuid) from public, anon;
grant execute on function watchdog_can_reach(uuid) to authenticated, service_role;

-- The recipient list the watchdog route actually sends to, now asking the
-- predicate by name so the two cannot drift.
create or replace function watchdog_recipients(p_course uuid)
returns table (profile_id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select p.id, s.endpoint, s.p256dh, s.auth
    from profiles p
    join push_subscriptions s on s.profile_id = p.id
   where p.course_id = p_course and p.active
     and is_management_role(p.role)
     and watchdog_can_reach(p.id);
$$;
revoke all on function watchdog_recipients(uuid) from public, anon, authenticated;
grant execute on function watchdog_recipients(uuid) to service_role;

create or replace function system_health_for(p_course uuid)
returns table (severity text, issue text, detail text)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_course is null then return; end if;

  return query
    select 'critical', 'Reports are not being triaged',
           count(*) || ' report(s) filed more than 5 minutes ago and still untouched'
      from reports r
     where r.course_id = p_course and r.status = 'new'
       and r.created_at < now() - interval '5 minutes'
    having count(*) > 0;

  return query
    select 'critical', 'Reports gave up being processed',
           count(*) || ' report(s) failed repeatedly and stopped retrying'
      from triage_queue q join reports r on r.id = q.report_id
     where r.course_id = p_course and q.status = 'dead_letter'
    having count(*) > 0;

  return query
    select 'warning', 'Alerts are not reaching anyone',
           count(*) || ' notification(s) queued for more than 10 minutes'
      from notifications n
     where n.course_id = p_course and n.status = 'queued'
       and n.created_at < now() - interval '10 minutes'
    having count(*) > 0;

  return query
    select 'warning', 'Nobody is on duty',
           'Reports will go straight to management'
      from profiles p
     where p.course_id = p_course and p.active
    having count(*) filter (where p.on_duty) = 0;

  return query
    select 'warning', 'Invited staff have not signed in',
           count(*) || ' person(s) will not receive alerts yet'
      from pending_profiles pp
     where pp.course_id = p_course and pp.claimed_at is null
       and pp.created_at < now() - interval '3 days'
    having count(*) > 0;

  -- The watchdog's own reach, so it asks the watchdog's question. A manager
  -- with only a phone does NOT silence this: the route cannot send to phones.
  return query
    select 'warning', 'No manager can receive system alerts',
           'Turn on notifications in a browser for at least one manager, or '
           || 'nobody is told when triage stops'
      from profiles p
     where p.course_id = p_course and p.active and is_management_role(p.role)
    having count(*) filter (where watchdog_can_reach(p.id)) = 0;

  -- Reports, not alarms: the worker delivers these and speaks to phones, so
  -- this one asks reachable_devices().
  return query
    select 'warning', 'Staff on duty cannot be reached',
           count(*) || ' on duty with no browser and no phone registered'
      from profiles p
     where p.course_id = p_course and p.active and p.on_duty
       and p.account_kind = 'individual'
       and reachable_devices(p.id) = 0
    having count(*) > 0;

  return query
    select 'critical', 'The scheduler has stopped',
           'Last run ' || to_char(coalesce(h.beat_at, 'epoch'::timestamptz), 'HH24:MI') ||
           ' — triage and escalation are not running'
      from (select 1) x
      left join system_heartbeats h on h.name = 'sweep'
     where h.beat_at is null or h.beat_at < now() - interval '10 minutes';
end;
$$;
revoke all on function system_health_for(uuid) from public, anon, authenticated;

-- --------------------------------------------- and the trend line, same bug

-- Found by the same check, in the same run. dashboard_daily counts every
-- report filed per day for the volume chart, and knows nothing about kind.
-- The day ordering goes live that line leaps, and a GM reads a course falling
-- apart when members are in fact buying drinks. `filed` keeps its name and
-- becomes problems only, which is what a problem-volume trend should show;
-- orders are counted beside it so nothing disappears.
create or replace view dashboard_daily as
select course_id,
       created_at::date as day,
       count(*) filter (where kind = 'issue')::int as filed,
       count(*) filter (where kind = 'order')::int as orders
from reports
where created_at > now() - interval '30 days'
group by 1, 2
order by 2;

alter view dashboard_daily set (security_invoker = on);
revoke all on dashboard_daily from anon;
grant select on dashboard_daily to authenticated;

