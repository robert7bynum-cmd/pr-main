-- An empty club must look empty, whichever department the report is for.
--
-- resolve_recipients climbs five rungs and stops at the first that answers.
-- Rung 2 — the department's own supervisor, even off duty — deliberately
-- ignores on_duty. That is right when the club is staffed and only that
-- department is not: the supervisor is the accountable person.
--
-- But rung 2 short-circuits everything below it, so any department that HAS a
-- supervisor could never reach rung 5. The result was a routing decision that
-- depended on an accident of the roster:
--
--   6:40am, nobody at all on the clock.
--   A cart report      -> rung 5: four leaders woken, 'unstaffed' event written.
--   A bunker report    -> rung 2: ONE off-duty phone, and no event at all.
--
-- Same empty club, same instant, two different answers — and in the second the
-- GM is never told the course was unstaffed, because the 'unstaffed' event is
-- only written for rung 5. Five of ten categories behaved that way. A single
-- sleeping phone was the entire response capability, and nothing said so.
--
-- CC7 in this repo's rules names the failure that created rung 5: "a 6:40am
-- cart report reached nobody and looked perfectly healthy in the UI." This is
-- that same failure, still live for half the categories.
--
-- The fix is to ask the question rung 5 was always meant to answer, before the
-- ladder rather than at the bottom of it: is anyone at this club on duty? If
-- nobody is, that is the situation rung 5 exists for, whatever the report is
-- about. If somebody is, the ladder proceeds exactly as before — this changes
-- nothing about a staffed club.
create or replace function resolve_recipients(
  p_course_id     uuid,
  p_department_id uuid
)
returns table (profile_id uuid, reason text)
language plpgsql stable security definer set search_path = public as $$
begin
  -- 0. Nobody at all is on the clock. Asked first, because otherwise a
  --    department that happens to have a supervisor answers rung 2 and hides
  --    the fact that the course is unstaffed.
  if not exists (
    select 1 from profiles p
     where p.course_id = p_course_id and p.active and p.on_duty
  ) then
    return query
      select p.id, 'unstaffed_all_leadership'
      from profiles p
      where p.course_id = p_course_id and p.active
        and p.role in ('supervisor', 'manager', 'owner');
    return;
  end if;

  -- 1. On-duty members of the target department: the normal path.
  return query
    select p.id, 'on_duty_department'
    from profiles p
    join staff_departments sd on sd.profile_id = p.id
    where p.course_id = p_course_id and p.active and p.on_duty
      and sd.department_id = p_department_id;
  if found then return; end if;

  -- 2. That department's own supervisor, even if off duty. Someone else at the
  --    club is working, so this is a real handoff to the accountable person
  --    rather than the last phone awake.
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

  -- 5. Reached only when the club has someone on duty but no supervisor or
  --    manager among them. Still the "tell everyone in charge" answer.
  return query
    select p.id, 'unstaffed_all_leadership'
    from profiles p
    where p.course_id = p_course_id and p.active
      and p.role in ('supervisor', 'manager', 'owner');
end;
$$;

revoke all on function resolve_recipients(uuid, uuid) from public, anon, authenticated;
grant execute on function resolve_recipients(uuid, uuid) to service_role;
