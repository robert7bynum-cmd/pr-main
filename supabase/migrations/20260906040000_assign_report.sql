-- Handing a report to a named person.
--
-- The system could route work to a department and a person could claim it, but
-- there was no way to say "this is yours". A supervisor balancing a Saturday
-- had to walk over and ask.
--
-- Deliberately not a new column. `reports.claimed_by` already means "whose work
-- this is" — it is what my_queue reads, what the card shows, and what
-- acknowledge_report protects. Assignment is that same fact, set by somebody
-- else. A separate assigned_to would immediately raise the question of which
-- one wins, and every read would have to answer it.
--
-- THE ACKNOWLEDGEMENT CLOCK RESETS. This is the one real decision here.
-- notified -> acknowledged is what a person is accountable for, so if a report
-- acknowledged by Miguel is handed to Efrain and keeps Miguel's timestamp, then
-- Efrain's response time is invisible and Miguel's is charged twice. The report
-- goes back to 'triaged', the new owner taps "I've got this", and their own
-- clock starts. Escalation resumes for them too, which is the point: the ten
-- minutes after a handover is exactly when work gets dropped.
create or replace function assign_report(
  p_report_id uuid,
  p_actor     uuid,
  p_assignee  uuid
)
returns table (ok boolean, assignee_name text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_course   uuid;
  v_report   reports%rowtype;
  v_assignee profiles%rowtype;
begin
  -- Same guard every staff action uses: you are who the session says, the
  -- report is at your club, and you are still active.
  v_course := assert_actor(p_report_id, p_actor);

  select * into v_report from reports where id = p_report_id for update;

  select * into v_assignee from profiles
   where id = p_assignee and course_id = v_course and active;
  if not found then
    -- Same message whether they are at another club, deactivated, or invented,
    -- so profile ids cannot be probed through this.
    raise exception 'that person is not on your team' using errcode = '22023';
  end if;

  -- Handing someone finished work is a mistake, not a workflow.
  if v_report.status in ('resolved', 'closed_no_action') then
    raise exception 'that report is already closed' using errcode = '22023';
  end if;

  if v_report.claimed_by = p_assignee then
    return query select false, v_assignee.full_name;
    return;
  end if;

  update reports set
    claimed_by      = p_assignee,
    claimed_at      = now(),
    -- Their clock, not the last person's. See the note above.
    acknowledged_at = null,
    status          = case when status = 'acknowledged' then 'triaged' else status end
  where id = p_report_id;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'reassigned', p_actor,
          jsonb_build_object('kind', 'person',
                             'to', p_assignee,
                             'to_name', v_assignee.full_name,
                             'from', v_report.claimed_by));

  -- Telling them is the point. Queued here; the same delivery path that carries
  -- a routed report carries this, and the trigger on notifications wakes the
  -- worker so it arrives in seconds rather than on the next sweep.
  insert into notifications (report_id, course_id, profile_id, channel, status)
  values (p_report_id, v_course, p_assignee, 'push', 'queued');

  return query select true, v_assignee.full_name;
end;
$$;

revoke all on function assign_report(uuid, uuid, uuid) from public, anon;
grant execute on function assign_report(uuid, uuid, uuid) to authenticated;

-- A queued notification is work for the worker, exactly like a queued report.
-- Without this an assignment waits up to a minute for the cron, which is the
-- gap that made a routed report feel slow before the same trigger fixed it.
drop trigger if exists notifications_kick on notifications;
create trigger notifications_kick
  after insert on notifications
  for each statement
  execute function kick_triage();
