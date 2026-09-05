-- Two ways the accountability record was picking up things that never happened.
--
-- 1. A TEST ALERT LOOKED LIKE A REAL DISPATCH.
--
-- "Send a test" queues a notification and lets the ordinary delivery path
-- handle it, which is right — testing a different path would prove nothing
-- about the one that matters. But it borrowed the most recent real report to
-- hang the row on, so the record for that report claimed the club had told
-- somebody about it, twice, when both were button presses. The report this
-- landed on now reads "notified 7 people" against a routing that named 5.
--
-- The delivery path stays shared. The row is marked instead, so a test can be
-- told apart from the thing it is imitating.
alter table notifications
  add column if not exists is_test boolean not null default false;

comment on column notifications.is_test is
  'A "send a test" alert, delivered through the real path but never counted as
   telling anyone about the report it borrowed.';

create index if not exists notifications_real_idx
  on notifications (report_id) where not is_test;

-- 2. A REPORT COULD BE RESOLVED BEFORE ANYONE WAS TOLD ABOUT IT.
--
-- resolve_report and close_no_action never looked at status, so a report still
-- in 'new' — filed seconds ago, not yet triaged, dispatched to nobody — could be
-- closed outright. The trail then reads created -> resolved with no department
-- and no routing, which is indistinguishable from work that went missing.
--
-- Closing one is legitimate: somebody standing there fixes it before the queue
-- even catches up, and that is the product working unusually well. What is not
-- legitimate is leaving it implied. The event now says so.
create or replace function resolve_report(
  p_report_id      uuid,
  p_actor          uuid,
  p_internal_note  text,
  p_member_message text default null
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid; v_was_routed boolean;
begin
  perform assert_actor(p_report_id, p_actor);

  select department_id is not null into v_was_routed
    from reports where id = p_report_id;

  update reports set
    status          = 'resolved',
    resolved_at     = now(),
    resolved_by     = p_actor,
    resolution_note = p_internal_note,
    member_message  = p_member_message,
    member_notified_at = case when p_member_message is not null then now() end
  where id = p_report_id
  returning course_id into v_course;

  if v_course is null then
    raise exception 'report not found' using errcode = '22023';
  end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'resolved', p_actor,
          jsonb_build_object(
            'has_member_message', p_member_message is not null,
            -- Recorded rather than inferred from a missing routed event, so a
            -- fast fix and a lost report never look the same.
            'closed_before_routing', not coalesce(v_was_routed, false)));

  if p_member_message is not null then
    insert into report_events (report_id, course_id, type, actor_id, payload)
    values (p_report_id, v_course, 'member_notified', p_actor,
            jsonb_build_object('message', p_member_message));
  end if;
end;
$$;

create or replace function close_no_action(
  p_report_id uuid, p_actor uuid, p_reason close_reason
)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid; v_was_routed boolean;
begin
  perform assert_actor(p_report_id, p_actor);

  select department_id is not null into v_was_routed
    from reports where id = p_report_id;

  update reports set status = 'closed_no_action', close_reason = p_reason,
                     resolved_at = now(), resolved_by = p_actor
   where id = p_report_id returning course_id into v_course;
  if v_course is null then raise exception 'report not found' using errcode='22023'; end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'note', p_actor,
          jsonb_build_object('closed_no_action', p_reason,
                             'closed_before_routing', not coalesce(v_was_routed, false)));
end;
$$;

-- Replacing a function resets its privileges to the default, which would hand
-- EXECUTE back to PUBLIC.
do $$
declare sig text;
begin
  for sig in
    select p.oid::regprocedure::text from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('resolve_report','close_no_action')
  loop
    execute format('revoke all on function %s from public, anon', sig);
    execute format('grant execute on function %s to authenticated', sig);
  end loop;
end $$;
