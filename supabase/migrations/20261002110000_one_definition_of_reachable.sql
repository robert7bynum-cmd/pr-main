-- "Can this person actually be reached?" had three answers, and two were wrong.
--
-- The question is asked in three places: the staff roster shows a device
-- count, system_health_for raises an alarm when no manager can receive one,
-- and club_readiness tells a new club whether anybody is listening. All three
-- were written separately, and only the newest knows that device_tokens
-- exists — that table arrived in 20260906150000, after the other two were
-- written, and neither was revisited.
--
-- So the moment the native apps ship, a member of staff reachable only on
-- their phone is reported as unreachable. The watchdog raises "no manager can
-- receive system alerts" when one can, and a manager reading the roster
-- chases somebody who is already covered. The roster's own comment says a
-- phone and a browser is better coverage than one — the intent was written
-- down and never implemented.
--
-- One function now answers it, and the three callers ask that function. This
-- is the repo's rule about one implementation of any rule, applied to a case
-- where the copies had already drifted.
--
-- Also here, because it is a one-line standing item from the audit:
-- assert_actor and assert_can_manage were executable by `authenticated` and
-- have no caller that needs it. They run inside other SECURITY DEFINER
-- functions, which execute as the owner, so revoking changes no behaviour.

-- ------------------------------------------------------- the one definition

create or replace function reachable_devices(p_profile uuid)
returns int
language sql stable security definer set search_path = public as $$
  select (select count(*) from push_subscriptions s where s.profile_id = p_profile)
       + (select count(*) from device_tokens d where d.profile_id = p_profile);
$$;
comment on function reachable_devices(uuid) is
  'How many ways there are to reach this person: browsers plus phones. The one '
  'definition — staff_roster, system_health_for and club_readiness all ask it.';
revoke all on function reachable_devices(uuid) from public, anon;
grant execute on function reachable_devices(uuid) to authenticated, service_role;

-- --------------------------------------------------------- the three callers

-- Unchanged but for the device count, which now includes phones. The comment
-- below was already here and already described this behaviour.
create or replace function staff_roster()
returns table (
  profile_id uuid, full_name text, email text, role staff_role,
  active boolean, on_duty boolean, account_kind account_kind,
  departments text[], resolved_30d int, devices int
)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.email, p.role, p.active, p.on_duty, p.account_kind,
         coalesce(array_agg(d.name order by d.name) filter (where d.name is not null), '{}'),
         (select count(*)::int from reports r
           where r.resolved_by = p.id and r.resolved_at > now() - interval '30 days'),
         -- Devices, not a boolean: someone with a phone and a pro shop browser
         -- is genuinely better covered than someone with one, and a manager
         -- deciding who to chase should be able to see that.
         reachable_devices(p.id)
    from profiles p
    left join staff_departments sd on sd.profile_id = p.id
    left join departments d on d.id = sd.department_id
   where p.course_id = auth_course_id() and auth_is_management()
   group by p.id
   order by p.active desc, p.full_name;
$$;
revoke all on function staff_roster() from public, anon;
grant execute on function staff_roster() to authenticated;

-- Identical to 20260905190000 but for the one clause: a manager with a phone
-- and no browser now counts as reachable, so the alarm stops crying wolf.
create or replace function system_health_for(p_course uuid)
returns table (severity text, issue text, detail text)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_course is null then return; end if;

  return query
    select 'critical', 'Reports are not being triaged',
           count(*) || ' report(s) filed more than 5 minutes ago and still untouched'
      from reports r
     where r.course_id = p_course and r.status = 'new'
       and r.created_at < now() - interval '5 minutes'
    having count(*) > 0;

  return query
    select 'critical', 'Reports gave up being processed',
           count(*) || ' report(s) failed repeatedly and stopped retrying'
      from triage_queue q join reports r on r.id = q.report_id
     where r.course_id = p_course and q.status = 'dead_letter'
    having count(*) > 0;

  return query
    select 'warning', 'Alerts are not reaching anyone',
           count(*) || ' notification(s) queued for more than 10 minutes'
      from notifications n
     where n.course_id = p_course and n.status = 'queued'
       and n.created_at < now() - interval '10 minutes'
    having count(*) > 0;

  return query
    select 'warning', 'Nobody is on duty',
           'Reports will go straight to management'
      from profiles p
     where p.course_id = p_course and p.active
    having count(*) filter (where p.on_duty) = 0;

  return query
    select 'warning', 'Invited staff have not signed in',
           count(*) || ' person(s) will not receive alerts yet'
      from pending_profiles pp
     where pp.course_id = p_course and pp.claimed_at is null
       and pp.created_at < now() - interval '3 days'
    having count(*) > 0;

  -- Whether a system alarm has anywhere to go at all.
  return query
    select 'warning', 'No manager can receive system alerts',
           'Turn on notifications for at least one manager, or nobody is told '
           || 'when triage stops'
      from profiles p
     where p.course_id = p_course and p.active and is_management_role(p.role)
    having count(*) filter (where reachable_devices(p.id) > 0) = 0;

  -- On-duty staff nobody can reach. Distinct from the alarm above: that one
  -- is about the system's own warnings having somewhere to go, this one is
  -- about the reports. Someone on shift who cannot be paged is the product's
  -- single promise failing silently, and until now only a hand-written query
  -- would have shown it.
  return query
    select 'warning', 'Staff on duty cannot be reached',
           count(*) || ' on duty with no browser and no phone registered'
      from profiles p
     where p.course_id = p_course and p.active and p.on_duty
       and p.account_kind = 'individual'
       and reachable_devices(p.id) = 0
    having count(*) > 0;

  return query
    select 'critical', 'The scheduler has stopped',
           'Last run ' || to_char(coalesce(h.beat_at, 'epoch'::timestamptz), 'HH24:MI') ||
           ' — triage and escalation are not running'
      from (select 1) x
      left join system_heartbeats h on h.name = 'sweep'
     where h.beat_at is null or h.beat_at < now() - interval '10 minutes';
end;
$$;
-- Revoked from `authenticated`, exactly as 20260905190000 had it. This takes a
-- course id, so a signed-in caller granted it could ask about ANY club's
-- health — a cross-tenant leak. The no-argument system_health() wrapper is the
-- authenticated-facing one and scopes itself to the caller's own club.
-- Recreating the function reset its grants, and test:watchdog caught it.
revoke all on function system_health_for(uuid) from public, anon, authenticated;

-- Same shape as 20261002100000; the reachability clause defers to the one
-- definition rather than carrying a fourth copy.
create or replace function club_readiness()
returns table (
  has_team         boolean,
  can_be_alerted   boolean,
  has_sign_address boolean,
  staff_count      int,
  reachable_count  int,
  location_count   int
)
language sql stable security definer set search_path = public as $$
  with me as (select auth_course_id() as course_id),
  staff as (
    select p.id, reachable_devices(p.id) > 0 as reachable
      from profiles p, me
     where p.course_id = me.course_id and p.active and p.account_kind = 'individual'
  )
  select
    (select count(*) from staff) > 1,
    (select count(*) from staff where reachable) > 0,
    coalesce(nullif(btrim((select c.settings ->> 'public_url' from courses c, me where c.id = me.course_id)), ''), '') <> '',
    (select count(*)::int from staff),
    (select count(*)::int from staff where reachable),
    (select count(*)::int from locations l, me where l.course_id = me.course_id and l.active)
  from me;
$$;
revoke all on function club_readiness() from public, anon;
grant execute on function club_readiness() to authenticated;

-- ------------------------------------------- standing audit item, closed

-- Called only from inside other SECURITY DEFINER functions, which run as the
-- owner. No app code calls either directly (verified by grep across app/,
-- lib/ and components/), so revoking changes no behaviour and removes two
-- functions a signed-in caller could poke at over PostgREST.
revoke execute on function assert_actor(uuid, uuid) from authenticated;
revoke execute on function assert_can_manage(staff_role) from authenticated;
