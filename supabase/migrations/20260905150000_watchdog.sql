-- The watchdog.
--
-- Everything in this system is scheduled inside the database, which is what
-- makes it independent of the web app — and also means that if pg_cron stops,
-- nothing notices. Reports would pile up untriaged, escalation would never fire,
-- and every screen would look perfectly healthy. That is the worst failure this
-- product can have: the club finds out from an angry member.
--
-- Two layers, because a monitor that depends on the thing it monitors is not a
-- monitor:
--   1. system_health records what the database can see about itself
--   2. a heartbeat written on every sweep, so an EXTERNAL service can alert when
--      the writes stop — the only way to catch cron itself dying

create table if not exists system_heartbeats (
  name       text primary key,
  beat_at    timestamptz not null default now(),
  detail     jsonb not null default '{}'::jsonb
);
alter table system_heartbeats enable row level security;

create policy mgmt_read on system_heartbeats for select to authenticated
  using (auth_is_management());
revoke all on system_heartbeats from anon;

create or replace function record_heartbeat(p_name text, p_detail jsonb default '{}'::jsonb)
returns void language sql volatile security definer set search_path = public as $$
  insert into system_heartbeats (name, beat_at, detail)
  values (p_name, now(), p_detail)
  on conflict (name) do update set beat_at = now(), detail = excluded.detail;
$$;

/**
 * What is wrong right now, in plain terms.
 *
 * Each row is a condition a human should act on, not a metric to interpret.
 * Empty means healthy.
 */
create or replace function system_health()
returns table (severity text, issue text, detail text)
language plpgsql stable security definer set search_path = public as $$
declare v_course uuid := auth_course_id();
begin
  if v_course is null or not auth_is_management() then return; end if;

  -- Reports accepted but never classified. The single most important check:
  -- the member was told their report was received.
  return query
    select 'critical', 'Reports are not being triaged',
           count(*) || ' report(s) filed more than 5 minutes ago and still untouched'
      from reports r
     where r.course_id = v_course and r.status = 'new'
       and r.created_at < now() - interval '5 minutes'
    having count(*) > 0;

  -- Work the queue gave up on after repeated failure.
  return query
    select 'critical', 'Reports gave up being processed',
           count(*) || ' report(s) failed repeatedly and stopped retrying'
      from triage_queue q join reports r on r.id = q.report_id
     where r.course_id = v_course and q.status = 'dead_letter'
    having count(*) > 0;

  -- Alerts queued but never delivered.
  return query
    select 'warning', 'Alerts are not reaching anyone',
           count(*) || ' notification(s) queued for more than 10 minutes'
      from notifications n
     where n.course_id = v_course and n.status = 'queued'
       and n.created_at < now() - interval '10 minutes'
    having count(*) > 0;

  -- Nobody clocked on. Reports still route to leadership, but the club should
  -- know it is running without a duty roster.
  return query
    select 'warning', 'Nobody is on duty',
           'Reports will go straight to management'
      from profiles p
     where p.course_id = v_course and p.active
    having count(*) filter (where p.on_duty) = 0;

  -- Staff invited who have never signed in receive nothing.
  return query
    select 'warning', 'Invited staff have not signed in',
           count(*) || ' person(s) will not receive alerts yet'
      from pending_profiles pp
     where pp.course_id = v_course and pp.claimed_at is null
       and pp.created_at < now() - interval '3 days'
    having count(*) > 0;

  -- The scheduler itself. If this is stale, everything above is unreliable too.
  return query
    select 'critical', 'The scheduler has stopped',
           'Last run ' || to_char(coalesce(h.beat_at, 'epoch'::timestamptz), 'HH24:MI') ||
           ' — triage and escalation are not running'
      from (select 1) x
      left join system_heartbeats h on h.name = 'sweep'
     where h.beat_at is null or h.beat_at < now() - interval '10 minutes';
end;
$$;

revoke all on function system_health()   from public, anon;
revoke all on function record_heartbeat(text, jsonb) from public, anon, authenticated;
grant execute on function system_health() to authenticated;

-- Beat on every escalation sweep. Escalation is pure SQL and runs regardless of
-- the web app, which makes it the right thing to hang the heartbeat on.
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
  $job$);
end $$;
