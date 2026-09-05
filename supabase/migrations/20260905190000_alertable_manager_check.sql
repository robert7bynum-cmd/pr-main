-- An alarm nobody can hear.
--
-- The external watchdog pages management when the scheduler dies. Production
-- had exactly one registered device and it belonged to a supervisor, so
-- watchdog_recipients returned nobody and the alert went nowhere. The endpoint
-- reported that honestly — recipients 0, HTTP 503 — but a 503 from a cron job
-- is read by nobody, which is the same silence in a different costume.
--
-- The bootstrap problem is real: if the thing that tells you the system is
-- broken cannot reach you, nothing can tell you that either. The only place
-- left is a screen a manager already opens, so this becomes a standing health
-- warning rather than a push notification about push notifications.
--
-- Deliberately not solved by widening the recipients to all staff. Reports
-- already fall back to leadership when nobody is on duty, and that is correct
-- because a report is work someone must do. An infrastructure alarm is not
-- work for a groundskeeper, and teaching staff to swipe away alerts that are
-- not theirs is how the alerts that are theirs get swiped away too.

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

  -- New: whether a system alarm has anywhere to go at all.
  return query
    select 'warning', 'No manager can receive system alerts',
           'Turn on notifications for at least one manager, or nobody is told '
           || 'when triage stops'
      from profiles p
     where p.course_id = p_course and p.active and is_management_role(p.role)
    having count(*) filter (
      where exists (select 1 from push_subscriptions s where s.profile_id = p.id)
    ) = 0;

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
