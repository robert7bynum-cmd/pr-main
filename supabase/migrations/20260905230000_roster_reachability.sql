-- Who would actually be woken.
--
-- The roster showed roles, departments and duty state — everything about who
-- SHOULD be told — and nothing about who CAN be. A club can have the routing
-- rules right, the right people on duty, and still page nobody, because no
-- device was ever registered. Every screen looks correct while it happens.
--
-- That is not hypothetical here. Production has twelve active staff and one
-- registered device, and it belongs to a supervisor rather than a manager, so
-- the watchdog's own alerts have had nowhere to go since the day it was built.
-- The system knew; nothing showed a person.
--
-- Push consent cannot be granted on someone's behalf — no browser offers an API
-- for it, and that is the correct design. So the only thing a manager can do is
-- notice who has not turned it on and ask them. This is the column that makes
-- that possible.
-- Adding a column to a `returns table` cannot be done with create-or-replace,
-- so the function is dropped and rebuilt. Dropping discards its privileges
-- along with it, which is why the grant below is not optional housekeeping —
-- without it the roster page 403s for every manager.
drop function if exists staff_roster();

create function staff_roster()
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
         (select count(*)::int from push_subscriptions s where s.profile_id = p.id)
    from profiles p
    left join staff_departments sd on sd.profile_id = p.id
    left join departments d on d.id = sd.department_id
   where p.course_id = auth_course_id() and auth_is_management()
   group by p.id
   order by p.active desc, p.full_name;
$$;

revoke all on function staff_roster() from public, anon;
grant execute on function staff_roster() to authenticated;
