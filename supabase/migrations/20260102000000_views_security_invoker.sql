-- =============================================================================
--  Make the convenience views respect Row Level Security.
--
--  A Postgres view runs with the privileges of its OWNER unless it is created
--  with `security_invoker = on`. The views in the base schema were created by
--  `postgres`, which owns the underlying tables, so selecting from a view
--  bypassed RLS entirely: a signed-out `anon` caller read 0 rows from
--  `seasons` but 1 row from `v_current_season`.
--
--  Proven before the fix:
--    set role anon; select count(*) from seasons;           -- 0  (RLS works)
--    set role anon; select count(*) from v_current_season;  -- 1  (RLS bypassed)
--
--  `security_invoker = on` makes each view execute as the CALLER, so the
--  `member_read` policies on the underlying tables apply. This strengthens
--  RLS; it does not change what any view returns for a legitimate member.
--
--  Supabase's own linter flags the original shape as `security_definer_view`.
-- =============================================================================

alter view v_current_season    set (security_invoker = on);
alter view v_subteam_progress  set (security_invoker = on);
alter view v_attention         set (security_invoker = on);
alter view spec_verdicts       set (security_invoker = on);
