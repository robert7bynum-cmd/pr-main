-- A shared login has to be able to say it is one.
--
-- profiles.account_kind has said 'station' since the core schema, and the
-- dashboard has left stations out of per-person metrics since its first day.
-- Nothing else knew. me() returned the same shape for the pro shop counter as
-- for Miguel, so the app could not tell a shared browser from a person and
-- offered it "I've got this" — which claims the report in the station's name
-- and ends attribution for that report right there. A resolution by
-- "Pro Shop Counter" answers "who handled it, and how fast" with nobody.
--
-- The app now asks who is taking it and hands the report to that person, with
-- the station on the record as the actor of the hand-over. That needs one more
-- column out of me(); the rest is the app's problem.
--
-- Adding a column to a `returns table` cannot be done with create-or-replace,
-- so the function is dropped and rebuilt. Dropping discards its privileges
-- along with it (20260905230000 learned this on staff_roster), so the revoke
-- and grant below are the function's whole access posture, not housekeeping:
-- without them the shell 403s for every signed-in member of staff.
drop function if exists me();

create function me()
returns table (
  profile_id uuid, full_name text, role staff_role,
  course_id uuid, course_name text, on_duty boolean,
  account_kind account_kind
)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role, p.course_id, c.name, p.on_duty, p.account_kind
    from profiles p join courses c on c.id = p.course_id
   where p.id = auth.uid() and p.active
$$;

revoke all on function me() from public, anon;
grant execute on function me() to authenticated;
