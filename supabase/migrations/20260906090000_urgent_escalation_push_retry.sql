-- An urgent report waited out the night, and a lost page was lost for good.
--
-- Two failures, one theme: the system had a way to say "later" and used it as
-- "never".
--
-- 1. escalate_reports skipped every open report inside quiet hours, urgency
--    included. Quiet hours exist so nobody is woken at 4am about a bunker rake;
--    they were also stopping a lightning strike or an injury filed at 20:30
--    from climbing to anyone until 06:00 — nine and a half hours in which the
--    only person who knew was the member who scanned the placard. An urgent
--    report now escalates regardless of the clock. Everything else still waits.
--
-- 2. The edge function marked a push notification `failed` on any error other
--    than a dead endpoint, first try, no retry — even though `notifications`
--    has carried `attempt` and `next_retry_at` since the table was created.
--    One transient 5xx from the push service and the page was gone, recorded
--    as a failure nobody would revisit. The function now backs off and retries
--    (1, 2, 4 minutes, then failed for real). That needs two things here:
--
--    - The cron gate fired whenever any notification was `queued`. A row
--      waiting out its backoff is `queued`, so the gate would have called the
--      worker every minute for nothing. The gate now asks whether a queued row
--      is *due*, which is also the question the worker's own select asks.
--    - An index that answers that question without a scan.
--
-- The rule: a deferral must carry the time it becomes due, and every reader —
-- gate, worker, escalation — must honour that time rather than the state name.

-- Same body as 20260905010000, one clause changed in the loop filter.
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
       -- Quiet hours defer ordinary work. They never defer an urgent report:
       -- an injury does not become less of one because it is dark.
       and (rep.urgency = 'urgent' or not within_quiet_hours(rep.course_id))
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

-- Restated, not assumed: `create or replace` keeps existing grants, but the
-- ACL from 20260905200000 is the statement of who calls this, and it belongs
-- beside the definition. The owner keeps EXECUTE, which is what lets pg_cron
-- run it.
revoke all on function escalate_reports() from public, anon, authenticated;
grant execute on function escalate_reports() to service_role;

-- Supports both the gate below and the worker's own "queued and due" select.
create index if not exists notifications_queued_due_idx
  on notifications (next_retry_at) where status = 'queued';

-- Re-schedule the sweeper as 20260905160000 did, with the notifications clause
-- asking "due", not merely "queued".
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — skipping (not a Supabase database)';
    return;
  end if;

  perform cron.unschedule('proresponse-triage')
    where exists (select 1 from cron.job where jobname = 'proresponse-triage');

  perform cron.schedule('proresponse-triage', '* * * * *', $job$
    select net.http_post(
      url     := (select value from app_settings where key = 'triage_function_url'),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select value from app_settings where key = 'service_role_key')),
      body    := '{}'::jsonb
    )
    where exists (select 1 from app_settings where key = 'triage_function_url')
      and (
        exists (select 1 from triage_queue
                 where status = 'pending' and next_attempt_at <= now())
        -- Escalation queues notifications without touching triage_queue. A
        -- notification waiting out a retry backoff is still 'queued' and is
        -- not a reason to call the worker until its retry is due.
        or exists (select 1 from notifications
                    where status = 'queued'
                      and (next_retry_at is null or next_retry_at <= now()))
      )
  $job$);
end $$;
