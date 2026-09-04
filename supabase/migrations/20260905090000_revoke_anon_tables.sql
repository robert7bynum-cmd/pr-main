-- Members never touch a table.
--
-- Supabase's "automatically expose new tables" setting grants anon full CRUD on
-- everything, and RLS is what actually blocks it. That works — the leak test
-- passes — but it leaves the whole database one mistake away from exposure: a
-- table created without RLS, or a policy written slightly too permissively, is
-- immediately world-accessible because the grant is already there.
--
-- The member surface is three SECURITY DEFINER functions and nothing else, so
-- anon has no legitimate need for a single table privilege. Removing them means
-- exposure requires two independent failures rather than one.
do $$
declare r record;
begin
  for r in
    select c.relname, c.relkind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','v')
  loop
    execute format('revoke all on public.%I from anon', r.relname);
  end loop;
end $$;

-- Staff still reach tables through their own session; those grants are
-- untouched and RLS scopes them to their club.

-- Anything created later inherits the same posture.
alter default privileges in schema public revoke all on tables from anon;
