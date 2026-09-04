-- Routing: turning a classified report into a notified person.
--
-- This lives in SQL rather than the worker so the whole decision is one
-- transaction and so it can be tested against a throwaway Postgres without
-- Supabase or any API calls. The worker's only job is classification.

-- Who should hear about a report for this department, and why.
--
-- Silence is never a valid outcome. If nobody in the target department is on
-- duty we climb a leadership chain rather than letting the report sit unseen
-- until escalation notices it — that was the failure mode where a 6:40am cart
-- report reached nobody and looked perfectly healthy in the UI.
create or replace function resolve_recipients(
  p_course_id     uuid,
  p_department_id uuid
)
returns table (profile_id uuid, reason text)
language plpgsql stable security definer set search_path = public as $$
begin
  -- 1. On-duty members of the target department: the normal path.
  return query
    select p.id, 'on_duty_department'
    from profiles p
    join staff_departments sd on sd.profile_id = p.id
    where p.course_id = p_course_id and p.active and p.on_duty
      and sd.department_id = p_department_id;
  if found then return; end if;

  -- 2. That department's own supervisor, even if off duty.
  return query
    select p.id, 'department_supervisor'
    from profiles p
    join staff_departments sd on sd.profile_id = p.id
    where p.course_id = p_course_id and p.active
      and sd.department_id = p_department_id
      and p.role = 'supervisor';
  if found then return; end if;

  -- 3. Any on-duty supervisor, whatever their department.
  return query
    select p.id, 'any_on_duty_supervisor'
    from profiles p
    where p.course_id = p_course_id and p.active and p.on_duty
      and p.role = 'supervisor';
  if found then return; end if;

  -- 4. On-duty management.
  return query
    select p.id, 'on_duty_management'
    from profiles p
    where p.course_id = p_course_id and p.active and p.on_duty
      and p.role in ('manager', 'owner');
  if found then return; end if;

  -- 5. Nobody is on duty at all. Wake everyone in charge and say so.
  return query
    select p.id, 'unstaffed_all_leadership'
    from profiles p
    where p.course_id = p_course_id and p.active
      and p.role in ('supervisor', 'manager', 'owner');
end;
$$;

-- Apply a classification: route it, record it, queue the notifications.
-- Idempotent on report_id — a report already past 'new' is left alone, so the
-- webhook and the sweeper can both deliver the same item harmlessly.
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

  -- Already handled by the other delivery path.
  if v_report.status <> 'new' then
    return query select v_report.department_id, 0, 'already_triaged'::text;
    return;
  end if;

  select * into v_rule
    from routing_rules
   where course_id = v_report.course_id and category = p_category;

  -- An unmapped category is a configuration gap, not a reason to drop the
  -- report: fall back to the needs_review rule so a human still sees it.
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

  -- Queue a notification per recipient. Delivery is a separate concern; this
  -- only records who must be told.
  with r as (select * from resolve_recipients(v_report.course_id, v_dept))
  insert into notifications (report_id, course_id, profile_id, channel, status)
  select p_report_id, v_report.course_id, r.profile_id, 'push', 'queued' from r;

  get diagnostics v_count = row_count;

  select rr.reason into v_reason
    from resolve_recipients(v_report.course_id, v_dept) rr limit 1;

  insert into report_events (report_id, course_id, type, payload)
  values (p_report_id, v_report.course_id, 'routed',
          jsonb_build_object('department_id', v_dept, 'recipients', v_count,
                             'reason', v_reason));

  -- Make an unstaffed department visible rather than implicit.
  if v_reason = 'unstaffed_all_leadership' then
    insert into report_events (report_id, course_id, type, payload)
    values (p_report_id, v_report.course_id, 'unstaffed',
            jsonb_build_object('department_id', v_dept));
  end if;

  update triage_queue set status = 'done' where report_id = p_report_id;

  return query select v_dept, v_count, v_reason;
end;
$$;

-- Claim a batch of pending work. SKIP LOCKED lets the webhook-driven path and
-- the cron sweeper run concurrently without processing the same report twice.
create or replace function claim_triage_batch(p_limit int default 10)
returns table (report_id uuid, body text)
language sql volatile security definer set search_path = public as $$
  with claimed as (
    select q.report_id
      from triage_queue q
     where q.status = 'pending' and q.next_attempt_at <= now()
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

-- Hand a failed item back for retry, or park it once it has failed enough.
create or replace function fail_triage(p_report_id uuid, p_error text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_attempts int;
begin
  select attempts into v_attempts from triage_queue where report_id = p_report_id;
  update triage_queue set
    status          = (case when v_attempts >= 5 then 'dead_letter' else 'pending' end)::queue_status,
    last_error      = p_error,
    locked_at       = null,
    next_attempt_at = now() + (interval '30 seconds' * power(2, least(v_attempts, 5)))
  where report_id = p_report_id;
end;
$$;

revoke all on function resolve_recipients   from public;
revoke all on function route_report         from public;
revoke all on function claim_triage_batch   from public;
revoke all on function fail_triage          from public;
