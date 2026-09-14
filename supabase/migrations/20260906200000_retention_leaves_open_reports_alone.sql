-- Retention does not empty a report that is still somebody's job.
--
-- purge_expired() cleared a member's name, phone, email and (since
-- 20260906180000) member number from every report past the club's retention
-- period, whatever its state. For a closed report that is the whole point: the
-- reason for holding the details was "so the team can ask about this report",
-- and that reason ends when the report does.
--
-- On an OPEN report the reason has not ended, and with the member-number rule
-- in place the consequence is worse than a lost phone number: a food and drink
-- order scheduled for a part that never came, or simply forgotten in the
-- queue, crosses ninety days, loses its number to the purge, and then
-- resolve_report refuses it forever. Nobody can close it and nobody did
-- anything wrong. Found by aging an open order past the period and calling
-- resolve_report, which answered "A member number is needed for this request."
-- on a report whose number the system had itself deleted.
--
-- So the purge now takes only reports that are finished — 'resolved',
-- 'verified' or 'closed_no_action'. An open report keeps its details until it
-- is closed and then ages out normally. A report left open forever keeps them
-- forever, which is the correct trade: that is a stuck report, it is already
-- what system_health() and the escalation sweep exist to surface, and the
-- answer is to close it, not to quietly strip it.

create or replace function purge_expired()
returns table (nonces int, alerts int, contacts int)
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

  -- Contact details. Each club's period is settings.retention_days; 90 when
  -- the club has never set one. The report itself stays — body, category,
  -- location, every event — because the metrics are about the course, not the
  -- member. One 'note' event per report says what went, so a timeline that
  -- shows no phone number is telling the truth about why.
  with due as (
    select r.id, r.course_id,
           array_remove(array[
             case when r.reporter_name      is not null then 'reporter_name'      end,
             case when r.reporter_phone     is not null then 'reporter_phone'     end,
             case when r.reporter_email     is not null then 'reporter_email'     end,
             case when r.reporter_member_no is not null then 'reporter_member_no' end
           ], null) as cleared
      from reports r
      join courses c on c.id = r.course_id
     where r.created_at < now() - make_interval(days =>
             coalesce((c.settings ->> 'retention_days')::int, 90))
       -- Finished, and only finished. An open report still needs the details
       -- it was given, and a food and drink order stripped of its member
       -- number can never be resolved at all.
       and r.status in ('resolved', 'verified', 'closed_no_action')
       and (r.reporter_name is not null
            or r.reporter_phone is not null
            or r.reporter_email is not null
            or r.reporter_member_no is not null)
  ), cleared as (
    update reports r
       set reporter_name = null, reporter_phone = null, reporter_email = null,
           reporter_member_no = null
      from due
     where r.id = due.id
    returning due.id, due.course_id, due.cleared
  )
  insert into report_events (report_id, course_id, type, actor_id, payload)
  select id, course_id, 'note', null,
         jsonb_build_object('retention', true, 'cleared', to_jsonb(cleared))
    from cleared;
  get diagnostics contacts = row_count;

  return next;
end;
$$;
revoke all on function purge_expired() from public, anon, authenticated;
grant execute on function purge_expired() to service_role;
