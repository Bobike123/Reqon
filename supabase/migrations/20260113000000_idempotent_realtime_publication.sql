-- =============================================================================
--  Idempotent realtime publication setup (Phase 5 §5.4)
--
--  WHY: 20260101000000_paddock_control_schema.sql set this up as
--
--    do $blk$ begin
--      alter publication supabase_realtime add table clause_status;
--      ... four more ...
--    exception when others then null; end $blk$;
--
--  That swallows EVERY failure, not just "already a member of the
--  publication" — a typo'd table name, a missing publication, or a genuine
--  permissions problem all fail exactly as silently as a harmless re-run.
--  And because it is one block, the first failure (expected or not) skips
--  every table after it: re-running that migration after clause_status was
--  already added would silently leave tasks, task_proposals, specs and
--  milestone_sections unpublished.
--
--  That migration already ran and is never edited after the fact (see
--  CLAUDE.md). This checks each table's actual publication membership via
--  pg_publication_tables before touching it — no exception handler, nothing
--  to swallow, and one table's outcome cannot affect another's. Anything
--  that goes wrong here (a genuinely missing table, no permission on the
--  publication) raises and fails the migration, as it should.
--
--  `topics` was renamed to `task_proposals` in 20260108000000; Postgres
--  publications track membership by relation OID, so the rename carried the
--  existing membership forward automatically. This lists the table under its
--  current name for anyone reading the publication's intent going forward,
--  and for a from-scratch environment where the rename never happened.
--
--  These five are exactly the tables Phase 5 §5.2 has a real, reviewed client
--  subscription for (src/data/useRealtime*.ts) — clause_status, tasks,
--  task_proposals, specs, milestone_sections. Nothing else is added: a
--  published-but-unsubscribed table is exactly the "decorative
--  infrastructure" §5.2 says to avoid.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Guarantee the five subscribed tables are in
--                   supabase_realtime, failing loudly instead of silently.
--    Existing data  No rows touched.
--    New objects    Publication membership only (no table, index, or
--                   function).
--    Locking        ALTER PUBLICATION ... ADD TABLE briefly locks the table
--                   being added (no rewrite); tables already published are
--                   skipped without touching them.
--    Authorization  Unchanged: Realtime delivers row changes only to
--                   subscribers the table's RLS read policies already allow.
--    Rollback       ALTER PUBLICATION supabase_realtime DROP TABLE <t>: that
--                   table's live updates stop and screens only refresh on
--                   their next fetch. No data effect.
--    Deploy order   After 20260112 and after the five tables exist. Fails the
--                   deploy if the supabase_realtime publication is missing.
--                   supabase/tests/season_and_platform_invariants_test.sql
--                   asserts the resulting membership exactly.
-- =============================================================================
do $$
declare
  live_table text;
begin
  foreach live_table in array array[
    'clause_status', 'tasks', 'task_proposals', 'specs', 'milestone_sections'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = live_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', live_table);
    end if;
  end loop;
end $$;
