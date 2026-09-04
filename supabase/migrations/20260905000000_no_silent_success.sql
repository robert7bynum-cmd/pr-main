-- Closing a class of defect: operations that report success for work that did
-- not happen.
--
-- Found after the triage worker counted ten skipped reports as routed. The same
-- shape existed in two more places, and both are worse than a visible error: an
-- operator trusts the number, and a club believes staff were told when they
-- were not.

-- start_report updated by id without checking anything matched. A bad id left
-- the report untouched and still wrote a note event.
create or replace function start_report(p_report_id uuid, p_actor uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_course uuid;
begin
  update reports set status = 'in_progress', claimed_by = coalesce(claimed_by, p_actor)
   where id = p_report_id returning course_id into v_course;

  if v_course is null then
    raise exception 'report not found' using errcode = '22023';
  end if;

  insert into report_events (report_id, course_id, type, actor_id, payload)
  values (p_report_id, v_course, 'note', p_actor, '{"note":"started work"}'::jsonb);
end;
$$;

-- route_report could notify nobody and still record a successful routing.
-- resolve_recipients falls back to all leadership, so zero recipients means the
-- club has no active staff at all — a configuration failure that must be loud,
-- not a report that quietly reaches no one.
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

  if v_report.status <> 'new' then
    return query select v_report.department_id, 0, 'already_triaged'::text;
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
    status        = 'triaged'
  where id = p_report_id;

  insert into report_events (report_id, course_id, type, payload)
  values (p_report_id, v_report.course_id, 'triaged',
          jsonb_build_object('category', p_category, 'urgency', p_urgency,
                             'confidence', p_confidence, 'source', p_source));

  with r as (select * from resolve_recipients(v_report.course_id, v_dept))
  insert into notifications (report_id, course_id, profile_id, channel, status)
  select p_report_id, v_report.course_id, r.profile_id, 'push', 'queued' from r;

  get diagnostics v_count = row_count;

  select rr.reason into v_reason
    from resolve_recipients(v_report.course_id, v_dept) rr limit 1;

  -- The check that matters: silence is never a valid routing outcome, and a
  -- routing that reached nobody must not look like a success.
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

revoke execute on function start_report(uuid,uuid) from public, anon;
revoke execute on function route_report(uuid,text,report_urgency,text,numeric,triage_source) from public, anon;
