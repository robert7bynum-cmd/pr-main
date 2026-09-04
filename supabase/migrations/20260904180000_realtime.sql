-- Live updates for the staff queue.
--
-- Realtime respects RLS, so a subscriber only receives rows their policies
-- already allow — a club cannot observe another club's reports even though
-- both listen on the same publication.
-- Guarded on the publication existing at all: the local test harness runs these
-- migrations against a plain Postgres with no Supabase extensions, and an
-- unguarded ALTER PUBLICATION here took every local SQL suite down with it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and tablename = 'reports'
    ) then
      alter publication supabase_realtime add table reports;
    end if;
  else
    raise notice 'supabase_realtime publication absent — skipping (not a Supabase database)';
  end if;
end $$;

-- The queue needs the old row on update to know whether a report left the
-- queue (resolved) or merely changed hands.
alter table reports replica identity full;
