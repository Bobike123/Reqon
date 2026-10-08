-- =============================================================================
--  Member onboarding from Settings: can_add_members().
--
--  WHAT CHANGES. The President and Vice President (and a Developer, who passes
--  every check) may now add a new person — login AND roster row — from
--  Settings -> Roster, instead of creating the login in the Supabase dashboard
--  and pasting its UUID. The login itself is created by the `create-member`
--  Edge Function (supabase/functions/create-member), the only place the
--  service-role key lives; it is never shipped to the browser.
--
--  This file gives that permission a name of its own, so it is decided in one
--  place: the Edge Function asks can_add_members() AS THE CALLER before it
--  creates a login, and then inserts the roster row AS THE CALLER, where
--  admin_roster_insert asks can_add_members() again. A forged or expired token,
--  a Treasurer, a retired President — all are refused by the database even if
--  the function's own check were bypassed.
--
--  Same membership as is_admin() today, kept separate on purpose (like
--  can_manage_departments()) so onboarding authority does not silently follow
--  future, unrelated changes to is_admin().
--
--  What it does NOT grant: privileged roles. A new person always starts with
--  none; roles are still handed out only through apply_role_plan() and
--  can_grant_role().
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Name the "may add people to the roster" permission.
--    Existing data  None.
--    Authorization  Unchanged in effect: is_admin() and can_add_members() hold
--                   for exactly the same people (active P / VP / Developer).
--    Locking        CREATE FUNCTION, DROP/CREATE POLICY on members: brief.
--    Rollback       Recreate admin_roster_insert with check (is_admin()) and
--                   drop function can_add_members().
-- =============================================================================

create or replace function can_add_members() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('vicepresident') or has_role('developer');
$fn$;

comment on function can_add_members() is
  'May create a login and add a new person to the roster: an active President, Vice President or Developer.';

-- 20260126000600's EXECUTE policy: authenticated and service_role only.
revoke execute on function can_add_members() from public, anon;
grant execute on function can_add_members() to authenticated, service_role;

drop policy if exists admin_roster_insert on members;
create policy admin_roster_insert on members for insert to authenticated
  with check (can_add_members());
