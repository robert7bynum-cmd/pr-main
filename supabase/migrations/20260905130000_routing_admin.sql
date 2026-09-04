-- Editing the routing rules.
--
-- These decide who gets paged and how long they have, so they are the table a
-- GM most needs to own — and the one most dangerous to get wrong. Same shape as
-- staff management: a SECURITY DEFINER function holds the guards, and every
-- change is audited, because "who shortened the safety SLA" is exactly the
-- question that gets asked after an incident.

create or replace function update_routing_rules(p_rules jsonb)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  g       record;
  r       jsonb;
  v_count int := 0;
  v_old   routing_rules%rowtype;
begin
  select * into g from assert_can_manage();

  for r in select * from jsonb_array_elements(p_rules) loop
    select * into v_old
      from routing_rules
     where course_id = g.course_id and category = (r->>'category');

    if not found then
      raise exception 'unknown category %', r->>'category' using errcode = '22023';
    end if;

    -- The department must belong to this club; a crafted id would otherwise
    -- route a club's reports at another club's team.
    if not exists (
      select 1 from departments
       where id = (r->>'department_id')::uuid and course_id = g.course_id
    ) then
      raise exception 'unknown department for this club' using errcode = '22023';
    end if;

    -- Bounds rather than free numbers: a zero-minute SLA pages everyone
    -- instantly and forever, and a 30-day one means escalation never happens.
    if (r->>'ack_sla_minutes')::int not between 1 and 1440
       or (r->>'resolve_sla_minutes')::int not between 1 and 10080 then
      raise exception 'SLA out of range' using errcode = '22023';
    end if;
    if (r->>'resolve_sla_minutes')::int < (r->>'ack_sla_minutes')::int then
      raise exception 'resolve time cannot be shorter than acknowledge time'
        using errcode = '22023';
    end if;

    update routing_rules set
      department_id       = (r->>'department_id')::uuid,
      ack_sla_minutes     = (r->>'ack_sla_minutes')::int,
      resolve_sla_minutes = (r->>'resolve_sla_minutes')::int
    where course_id = g.course_id and category = (r->>'category');

    -- Only record what actually changed, so the log stays readable.
    if v_old.department_id       is distinct from (r->>'department_id')::uuid
       or v_old.ack_sla_minutes     is distinct from (r->>'ack_sla_minutes')::int
       or v_old.resolve_sla_minutes is distinct from (r->>'resolve_sla_minutes')::int
    then
      perform log_admin_event(g.course_id, g.actor_id, 'routing_rule_changed', null,
        jsonb_build_object(
          'category', r->>'category',
          'from', jsonb_build_object('department_id', v_old.department_id,
                                     'ack', v_old.ack_sla_minutes,
                                     'resolve', v_old.resolve_sla_minutes),
          'to',   jsonb_build_object('department_id', r->>'department_id',
                                     'ack', (r->>'ack_sla_minutes')::int,
                                     'resolve', (r->>'resolve_sla_minutes')::int)));
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- What the editor renders.
create or replace function routing_rules_for_club()
returns table (
  category text, department_id uuid, department_name text,
  ack_sla_minutes int, resolve_sla_minutes int, reports_30d int
)
language sql stable security definer set search_path = public as $$
  select rr.category, rr.department_id, d.name,
         rr.ack_sla_minutes, rr.resolve_sla_minutes,
         (select count(*)::int from reports r
           where r.course_id = rr.course_id and r.category = rr.category
             and r.created_at > now() - interval '30 days')
    from routing_rules rr
    join departments d on d.id = rr.department_id
   where rr.course_id = auth_course_id() and auth_is_management()
   order by 6 desc, rr.category;
$$;

revoke all on function update_routing_rules(jsonb)  from public, anon;
revoke all on function routing_rules_for_club()     from public, anon;
grant execute on function update_routing_rules(jsonb) to authenticated;
grant execute on function routing_rules_for_club()    to authenticated;
