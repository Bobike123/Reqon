-- =============================================================================
--  Backend completion Phase 2, step 7 of 7: function EXECUTE surface.
--  (Finding F-18; hosted security advisors 0011 and 0028/0029, 2026-09-29.)
--
--  WHAT WAS WRONG. Most SECURITY DEFINER helpers and every trigger function
--  still had Postgres' default EXECUTE for PUBLIC, so the anon role could call
--  them through /rest/v1/rpc/*. No bypass was found (trigger functions refuse a
--  direct call; helpers answer false for anonymous callers), but the surface is
--  larger than needed. Seven small IMMUTABLE/STABLE helpers had no pinned
--  search_path.
--
--  AFTER.
--   * Every SECURITY DEFINER function in public that PUBLIC or anon could
--     execute:
--       - returning trigger / event_trigger: EXECUTE revoked from PUBLIC, anon
--         and authenticated (triggers still fire: they run as the table owner);
--       - otherwise: EXECUTE granted explicitly to authenticated and
--         service_role, then revoked from PUBLIC and anon. RLS policies and the
--         client's RPCs run as authenticated, so nothing the app does changes.
--     Functions that were already restricted (archive_stale_done_tasks*,
--     lock_proposal_for_command, refresh_spec_current, assert_task_links) are
--     not touched, so no grant is widened.
--   * The seven helpers without a pinned search_path get `search_path = public`.
--   * NOT changed: Auth settings (leaked-password protection stays as it is;
--     changing it needs explicit approval), SECURITY INVOKER functions, views.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Shrink the RPC surface to what the app uses.
--    Existing data  None.
--    Authorization  Narrower only. Idempotent: a re-run finds nothing to change.
--    Locking        GRANT/REVOKE/ALTER FUNCTION: catalog locks only.
--    Rollback       GRANT EXECUTE ... TO PUBLIC on the listed functions.
--    Deploy order   Last of the Phase 2 files (it also covers the functions
--                   they created).
-- =============================================================================

do $harden$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.prorettype
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and exists (
        select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        left join pg_roles r on r.oid = a.grantee
        where a.privilege_type = 'EXECUTE'
          and (a.grantee = 0 or r.rolname = 'anon')
      )
  loop
    if f.prorettype in ('trigger'::regtype, 'event_trigger'::regtype) then
      execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
      execute format('revoke execute on function %s from public, anon', f.sig);
    end if;
  end loop;

  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('stamp_decided', 'set_initials', 'is_finite_number', 'spec_regulatory_verdict',
                        'spec_goal_status', 'spec_zone', 'spec_measurement_json')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public', f.sig);
  end loop;
end
$harden$;
