-- Reclaim work orphaned by a worker that died mid-run.
--
-- claim_triage_batch marks an item 'processing' and the sweeper only looked for
-- 'pending', so anything claimed by a process that then crashed, timed out or
-- was killed sat in 'processing' forever. Ten items were already stuck this way.
-- The whole point of the queue is that work cannot be silently dropped, and
-- this was the one hole in it.
create or replace function claim_triage_batch(p_limit int default 10)
returns table (report_id uuid, body text)
language sql volatile security definer set search_path = public as $$
  with claimed as (
    select q.report_id
      from triage_queue q
     where (
             (q.status = 'pending' and q.next_attempt_at <= now())
             -- A lock older than five minutes means whoever held it is gone.
             -- Reclaiming is safe because route_report is idempotent.
             or (q.status = 'processing' and q.locked_at < now() - interval '5 minutes')
           )
     order by q.created_at
     for update skip locked
     limit p_limit
  )
  update triage_queue q
     set status = 'processing', locked_at = now(), attempts = q.attempts + 1
    from claimed c
   where q.report_id = c.report_id
  returning q.report_id, (select r.body from reports r where r.id = q.report_id);
$$;

revoke execute on function claim_triage_batch(int) from public, anon;

-- Anything already orphaned goes back in the queue.
update triage_queue
   set status = 'pending', locked_at = null, next_attempt_at = now()
 where status = 'processing' and locked_at < now() - interval '5 minutes';
