-- The RLS helper functions are for policy evaluation, not for callers.
--
-- auth_course_id, auth_role and auth_is_management all key off auth.uid(), so
-- they return nothing to an anonymous caller — but they were still executable
-- by anon. Policies are declared `to authenticated`, so anon never needs them.
revoke execute on function auth_course_id()      from public, anon;
revoke execute on function auth_role()           from public, anon;
revoke execute on function auth_is_management()  from public, anon;

grant execute on function auth_course_id()     to authenticated;
grant execute on function auth_role()          to authenticated;
grant execute on function auth_is_management() to authenticated;
