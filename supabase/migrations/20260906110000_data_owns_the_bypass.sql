-- The model was deciding who gets woken up.
--
-- 1. 20260906090000 let an urgent report escalate through quiet hours. Right
--    idea, wrong key: `urgency` is what the classifier said. Most of the time
--    that is a keyword rule, which is data. When no rule matches it is the
--    model, and the model is asked to guess. So: a member reports a lost glove
--    at 22:00, no keyword fires, the model hallucinates "urgent" at confidence
--    0.4, and an hour later every supervisor, manager and owner at the club is
--    paged about a glove. Nothing on any screen would have said why, and the
--    repo's own rule — the model classifies, data routes — was broken by the
--    one path where being wrong costs the most.
--
--    The bypass now belongs to data. A report escalates inside quiet hours when
--    its *category* is `safety` — category is the key into routing_rules,
--    which the club owns — or when it is `urgent` AND the classifier itself
--    said it was at least 80% sure. Confidence is the model's own admission;
--    a guess below that waits for morning like everything else. Keyword rules
--    carry their own confidence and pass this test when they say urgent, so
--    "call 911 on 12" still climbs at 22:00.
--
--    The body is 20260906090000's, one clause changed in the loop filter.
--
-- 2. Supabase's advisor flagged `self_update` on profiles (auth_rls_initplan):
--    `auth.uid()` in a policy predicate is re-evaluated per row unless wrapped
--    in a subselect, which lets the planner run it once as an InitPlan. Same
--    predicate, evaluated once.
--
-- 3. 20260906100000 wrote down that system_alerts had no retention either, and
--    left it. purge_expired() replaces purge_scan_nonces(): nonces older than a
--    day, and alerts resolved more than thirty days ago (an open alert is never
--    touched — it is still telling somebody something). It returns both counts,
--    because a purge that deletes nothing should say zero, not nothing. The
--    escalate sweep is rescheduled with the new call; the other two statements
--    are byte-for-byte what 20260906100000 scheduled.

-- ------------------------------------------------------- 1. escalate_reports
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
       -- Quiet hours defer ordinary work. They never defer a safety report,
       -- and never one the classifier called urgent with real confidence.
       -- A low-confidence "urgent" is a guess, and a guess waits for morning:
       -- the model classifies, data decides who is paged.
       and (rep.category = 'safety'
            or (rep.urgency = 'urgent' and coalesce(rep.ai_confidence, 0) >= 0.8)
            or not within_quiet_hours(rep.course_id))
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

-- Restated, not assumed, as 20260906090000 does: the ACL is the statement of
-- who calls this. The owner keeps EXECUTE, which is what lets pg_cron run it.
revoke all on function escalate_reports() from public, anon, authenticated;
grant execute on function escalate_reports() to service_role;

-- ------------------------------------------------------------ 2. self_update
drop policy if exists self_update on profiles;
create policy self_update on profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---------------------------------------------------------- 3. purge_expired
create or replace function purge_expired()
returns table (nonces int, alerts int)
language plpgsql volatile security definer set search_path = public as $$
begin
  -- A nonce is refused after two hours whatever its state; a day is generous
  -- and keeps the last few hours around for anyone reading the table by hand.
  delete from scan_nonces where issued_at < now() - interval '1 day';
  get diagnostics nonces = row_count;

  -- An alert is kept for a month after it cleared so "did the scheduler stop
  -- last week?" is still answerable. An unresolved alert is never purged.
  delete from system_alerts where resolved_at < now() - interval '30 days';
  get diagnostics alerts = row_count;

  return next;
end;
$$;

revoke all on function purge_expired() from public, anon, authenticated;
grant execute on function purge_expired() to service_role;

-- The escalate sweep from 20260906100000, byte for byte, with purge_expired()
-- in place of purge_scan_nonces().
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
    select purge_expired();
  $job$);
end $$;

-- Nothing calls it now, and a function nobody calls is a function nobody
-- notices drifting. The job above is the only caller and it was just repointed.
drop function if exists purge_scan_nonces();
