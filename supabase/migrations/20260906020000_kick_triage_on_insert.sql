-- The fast path that was always in the plan and never built.
--
-- Triage has run only on the once-a-minute cron. That is the guarantee, and it
-- is a good one — but as the only path it means a report can sit for up to
-- sixty seconds before anyone is paged, and with one manager at the club the
-- owner beat the sweep every single time: filed, saw it on his phone, tapped
-- it, and the push either never came or came after he had already dealt with
-- it. "Someone is looking at it now" was a promise the system kept a minute
-- late.
--
-- Queueing work for triage now also asks the worker to come and get it. The
-- request goes through pg_net exactly as the cron's does, is queued inside the
-- same transaction as the report, and is sent only after commit — so the
-- worker never sees a report that is not there yet. The cron stays as it is:
-- if this call is lost, the sweep picks the report up within the minute, and
-- the batch claim's SKIP LOCKED means the two can never process one twice.
--
-- Per statement rather than per row, so a bulk insert asks once. Guarded for a
-- database without pg_net or without a configured worker, which is every local
-- test harness and a project that has not been pointed at its worker yet: in
-- those the trigger does nothing, loudly enough for a test to notice if it
-- wanted to (it raises a notice, not an exception).
create or replace function kick_triage()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from app_settings where key = 'triage_function_url';
  select value into v_secret from app_settings where key = 'service_role_key';

  if v_url is null or v_secret is null then
    raise notice 'kick_triage: no worker configured; the cron will sweep';
    return null;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    raise notice 'kick_triage: pg_net not installed; the cron will sweep';
    return null;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_secret),
    body    := '{}'::jsonb
  );
  return null;
end;
$$;

revoke all on function kick_triage() from public, anon, authenticated;

drop trigger if exists triage_queue_kick on triage_queue;
create trigger triage_queue_kick
  after insert on triage_queue
  for each statement
  execute function kick_triage();
