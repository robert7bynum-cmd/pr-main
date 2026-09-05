-- The other half of the watchdog.
--
-- 20260905150000 built the heartbeat and system_health(), and its own comment
-- named what was still missing: "a heartbeat written on every sweep, so an
-- EXTERNAL service can alert when the writes stop". Nothing external ever
-- watched it. So the database could tell you the scheduler had died, but only
-- if a manager happened to open the dashboard and look — and the whole point of
-- this product is that nobody has to remember to look.
--
-- The external half now runs on Vercel (app/api/watchdog), which is a different
-- machine, a different scheduler and a different vendor from pg_cron. It reads
-- health with the service role and sends push itself rather than queueing work
-- for the sweep, because a monitor that asks the dead process to deliver its own
-- death notice is not a monitor.
--
-- Two things are needed here that the in-database half did not need:
--   1. health readable without a signed-in manager's auth context
--   2. somewhere to remember what has already been alerted on, so a scheduler
--      that stays down does not push every five minutes forever

-- One implementation of the health rules, not two. system_health() below
-- becomes a thin wrapper that resolves the caller's own club and delegates.
-- Copy-pasting these checks for the service-role path is exactly the drift this
-- repo has been bitten by before.
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

  return query
    select 'critical', 'The scheduler has stopped',
           'Last run ' || to_char(coalesce(h.beat_at, 'epoch'::timestamptz), 'HH24:MI') ||
           ' — triage and escalation are not running'
      from (select 1) x
      left join system_heartbeats h on h.name = 'sweep'
     where h.beat_at is null or h.beat_at < now() - interval '10 minutes';
end;
$$;

create or replace function system_health()
returns table (severity text, issue text, detail text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not auth_is_management() then return; end if;
  return query select * from system_health_for(auth_course_id());
end;
$$;

revoke all on function system_health_for(uuid) from public, anon, authenticated;
revoke all on function system_health()        from public, anon;
grant execute on function system_health() to authenticated;

-- What has already been shouted about. Without this, a scheduler that stays
-- down overnight pages every manager every five minutes until morning, and the
-- next real alert is the one everybody has learned to swipe away.
create table if not exists system_alerts (
  course_id     uuid not null references courses(id) on delete cascade,
  issue         text not null,
  severity      text not null,
  detail        text not null,
  first_seen    timestamptz not null default now(),
  last_notified timestamptz,
  resolved_at   timestamptz,
  primary key (course_id, issue)
);
alter table system_alerts enable row level security;
-- Re-runnable: every other statement in this file is create-or-replace or
-- if-not-exists, and a bare CREATE POLICY would be the one thing that made
-- reapplying the migration fail halfway through.
drop policy if exists mgmt_read_alerts on system_alerts;
create policy mgmt_read_alerts on system_alerts for select to authenticated
  using (course_id = auth_course_id() and auth_is_management());
revoke all on system_alerts from anon;

/**
 * Record the current health of a club and return only what a human still needs
 * to be told about — new problems, and standing problems last shouted about
 * more than p_repeat_after ago.
 *
 * Resolution is recorded too, so "it cleared on its own at 3am" is answerable
 * later. Silence is never a valid outcome: an issue that disappears is written
 * down as resolved rather than simply vanishing from the table.
 */
create or replace function record_system_alerts(
  p_course       uuid,
  p_repeat_after interval default interval '30 minutes'
)
returns table (severity text, issue text, detail text)
language plpgsql volatile security definer set search_path = public as $$
-- The OUT parameters above are named for the JSON keys callers read, which
-- makes every bare `severity`/`issue`/`detail` below ambiguous against the
-- identically named columns on system_alerts. Resolve to the column: this
-- function never reads the OUT variables, it only returns query results.
#variable_conflict use_column
begin
  create temp table _now_health on commit drop as
    select * from system_health_for(p_course);

  -- Anything previously open that is no longer reported has recovered.
  update system_alerts a
     set resolved_at = now()
   where a.course_id = p_course and a.resolved_at is null
     and not exists (select 1 from _now_health h where h.issue = a.issue);

  insert into system_alerts as a (course_id, issue, severity, detail)
  select p_course, h.issue, h.severity, h.detail from _now_health h
  on conflict (course_id, issue) do update
     set severity = excluded.severity,
         detail   = excluded.detail,
         -- A problem that cleared and came back is a new problem, not a
         -- continuation of the old one.
         first_seen = case when a.resolved_at is not null then now() else a.first_seen end,
         last_notified = case when a.resolved_at is not null then null else a.last_notified end,
         resolved_at = null;

  return query
    update system_alerts a set last_notified = now()
     where a.course_id = p_course and a.resolved_at is null
       and (a.last_notified is null or a.last_notified < now() - p_repeat_after)
    returning a.severity, a.issue, a.detail;
end;
$$;

revoke all on function record_system_alerts(uuid, interval) from public, anon, authenticated;

-- "Management" is defined in exactly one place. auth_is_management() already
-- encoded it, but only as a question about the signed-in caller, so the
-- service-role path could not ask it and would have had to restate the role
-- list — the same duplication that let the keyword matcher drift out of step
-- with itself. Both now read from this.
create or replace function is_management_role(p_role staff_role)
returns boolean language sql immutable set search_path = public as $$
  select p_role in ('manager', 'owner')
$$;

create or replace function auth_is_management()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_management_role(role) from profiles
                   where id = auth.uid() and active), false)
$$;

grant execute on function is_management_role(staff_role) to authenticated;
revoke all on function is_management_role(staff_role) from public, anon;

-- Who to wake. Management only, and only people who actually have a device
-- registered — a manager with no subscription is not a delivery target, and
-- pretending otherwise is how the notification table filled up with failures.
create or replace function watchdog_recipients(p_course uuid)
returns table (profile_id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select p.id, s.endpoint, s.p256dh, s.auth
    from profiles p
    join push_subscriptions s on s.profile_id = p.id
   where p.course_id = p_course and p.active
     and is_management_role(p.role);
$$;

revoke all on function watchdog_recipients(uuid) from public, anon, authenticated;
