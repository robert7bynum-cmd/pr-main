-- What one person should see.
--
-- Everyone saw every open report at the club. On a busy Saturday a groundskeeper
-- scrolls past pro shop and F&B items to find their own, which is exactly how a
-- queue stops being read — and a queue nobody reads is worse than no queue.
--
-- Three ways a report reaches you, and the last two matter as much as the first:
--   1. it is routed to a department you are in
--   2. you were notified about it — escalation pages leadership outside the
--      department, and without this clause you would be paged about something
--      you cannot see
--   3. you claimed it, so it stays visible if it is later re-routed
--
-- Management see everything: the whole-course view is the job.
create or replace view my_queue as
select q.*
  from staff_queue q
 where exists (
   select 1 from profiles p
    where p.id = auth.uid() and p.active and p.course_id = q.course_id
      and (
        p.role in ('manager', 'owner')
        or exists (select 1 from staff_departments sd
                    where sd.profile_id = p.id and sd.department_id = q.department_id)
        or exists (select 1 from notifications n
                    where n.report_id = q.id and n.profile_id = p.id)
        or q.claimed_by = p.id
      )
 );

alter view my_queue set (security_invoker = on);
revoke all on my_queue from anon;
grant select on my_queue to authenticated;

comment on view my_queue is
  'The signed-in person''s queue. staff_queue remains the course-wide view that management reporting uses.';
