-- A report picked up before triage reached it must still be routed.
--
-- With the demo data cleared, the owner scanned a placard, filed a report,
-- watched it appear on his phone within seconds, and tapped "I've got this" —
-- all before the once-a-minute triage sweep had run. route_report then saw a
-- status other than 'new' and answered already_triaged. So the report was
-- never classified, never given a department, never routed, and nobody was
-- paged. The trail read created -> acknowledged and the card said "Unrouted",
-- and it would have stayed that way forever, because the queue row was marked
-- done.
--
-- "Already handled" was being inferred from status, which conflates two
-- different facts: whether the report has been CLASSIFIED and whether someone
-- has TOUCHED it. A fast acknowledgement is the product working well, not a
-- reason to skip the step that decides which department owns the problem and
-- who else should know.
--
-- The guard now asks the right question — has this been classified — and a
-- report that has been finished (resolved or closed) is left alone with its
-- own reason, since paging people about closed work is noise. Status is never
-- regressed: an acknowledged report stays acknowledged after routing.
create or replace function route_report(
  p_report_id  uuid,
  p_category   text,
  p_urgency    report_urgency,
  p_summary    text,
  p_confidence numeric,
  p_source     triage_source
)
returns table (department_id uuid, recipients int, reason text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_report reports%rowtype;
  v_rule   routing_rules%rowtype;
  v_dept   uuid;
  v_reason text;
  v_count  int := 0;
begin
  select * into v_report from reports where id = p_report_id for update;
  if not found then
    raise exception 'report % not found', p_report_id using errcode = '22023';
  end if;

  -- Classified already: the webhook and the sweeper both delivered it.
  if v_report.triage_source is not null then
    return query select v_report.department_id, 0, 'already_triaged'::text;
    return;
  end if;

  -- Finished before triage caught up. Routing it now would page people about
  -- work that is over; the closing event already records closed_before_routing.
  if v_report.status in ('resolved', 'closed_no_action') then
    update triage_queue set status = 'done' where report_id = p_report_id;
    return query select v_report.department_id, 0, 'already_closed'::text;
    return;
  end if;

  select * into v_rule
    from routing_rules
   where course_id = v_report.course_id and category = p_category;

  if not found then
    select * into v_rule
      from routing_rules
     where course_id = v_report.course_id and category = 'needs_review';
  end if;

  v_dept := v_rule.department_id;

  update reports set
    category      = coalesce(v_rule.category, p_category),
    urgency       = p_urgency,
    ai_summary    = p_summary,
    ai_confidence = p_confidence,
    triage_source = p_source,
    department_id = v_dept,
    -- Never move a report backwards. Someone who already picked it up keeps it.
    status        = case when v_report.status = 'new' then 'triaged' else v_report.status end
  where id = p_report_id;

  insert into report_events (report_id, course_id, type, payload)
  values (p_report_id, v_report.course_id, 'triaged',
          jsonb_build_object('category', p_category, 'urgency', p_urgency,
                             'confidence', p_confidence, 'source', p_source,
                             'claimed_first', v_report.status <> 'new'));

  with r as (select * from resolve_recipients(v_report.course_id, v_dept))
  insert into notifications (report_id, course_id, profile_id, channel, status)
  select p_report_id, v_report.course_id, r.profile_id, 'push', 'queued' from r;

  get diagnostics v_count = row_count;

  select rr.reason into v_reason
    from resolve_recipients(v_report.course_id, v_dept) rr limit 1;

  if v_count = 0 then
    insert into report_events (report_id, course_id, type, payload)
    values (p_report_id, v_report.course_id, 'unstaffed',
            jsonb_build_object('department_id', v_dept, 'error', 'no active staff at this club'));
    raise exception 'report % routed to nobody: this club has no active staff', p_report_id
      using errcode = '53400';
  end if;

  insert into report_events (report_id, course_id, type, payload)
  values (p_report_id, v_report.course_id, 'routed',
          jsonb_build_object('department_id', v_dept, 'recipients', v_count,
                             'reason', v_reason));

  if v_reason = 'unstaffed_all_leadership' then
    insert into report_events (report_id, course_id, type, payload)
    values (p_report_id, v_report.course_id, 'unstaffed',
            jsonb_build_object('department_id', v_dept));
  end if;

  update triage_queue set status = 'done' where report_id = p_report_id;

  return query select v_dept, v_count, v_reason;
end;
$$;

revoke all on function route_report(uuid,text,report_urgency,text,numeric,triage_source) from public, anon, authenticated;
grant execute on function route_report(uuid,text,report_urgency,text,numeric,triage_source) to service_role;
