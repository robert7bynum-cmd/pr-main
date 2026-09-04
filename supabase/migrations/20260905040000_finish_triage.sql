-- Closing the last loop in the queue.
--
-- route_report marks the queue item done only on the success path. A report
-- already handled by the other delivery path came back as 'already_triaged'
-- and the item was left 'processing' — which the new stale-lock reclaim then
-- picked up every five minutes, forever. Work that is genuinely finished needs
-- a way to say so.
create or replace function complete_triage(p_report_id uuid)
returns void language sql volatile security definer set search_path = public as $$
  update triage_queue set status = 'done', locked_at = null where report_id = p_report_id;
$$;

revoke execute on function complete_triage(uuid) from public, anon;

-- A report can only leave the queue by being routed or by already being
-- handled. Anything sitting in 'new' with a finished queue item was dropped —
-- put it back so it is picked up on the next sweep.
update triage_queue q
   set status = 'pending', locked_at = null, next_attempt_at = now(), attempts = 0
  from reports r
 where r.id = q.report_id and r.status = 'new' and q.status = 'done';
