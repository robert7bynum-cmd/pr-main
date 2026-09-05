-- Escalation alerts were never delivered.
--
-- The sweeper only ran when triage_queue had pending work, but escalation
-- queues notifications on its own schedule and does not touch that queue. So a
-- report that escalated to management sat with its alerts queued forever, and
-- every screen looked fine. The watchdog caught it within a minute of existing,
-- which is the argument for the watchdog.
--
-- The gate now covers both kinds of work.
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
        -- Escalation queues notifications without touching triage_queue.
        or exists (select 1 from notifications where status = 'queued')
      )
  $job$);
end $$;
