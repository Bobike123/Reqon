-- =============================================================================
--  The developer role gets full access — maintenance and security.
--
--  BEFORE (20260105): developer read everything and wrote nothing extra. No
--  administration, no finance writes, no role management.
--
--  AFTER: developer passes every permission check the club has:
--      is_admin()             rulebook, subsystems, roster, seasons, milestones
--      can_manage_roles()     give and take away privileged roles
--      can_manage_finances()  add, edit and delete financial entries
--      can_view_finances()    already true for any privileged role
--
--  WHY: whoever maintains this app has to be able to repair the club's data and
--  undo a bad change without waiting for an officer to be available.
--
--  WHAT IT MEANS, PLAINLY: a developer can grant themselves or anyone else any
--  role — president included — edit the money, and change the rulebook, roster
--  and seasons. It is the most powerful role in the club. Give it only to
--  someone trusted with all of that, and take it back when their work is done:
--  every officer's authority is now also theirs.
--
--  These are the only changes. In particular:
--    * the policies are untouched — every one of them calls a function above,
--      which is exactly why this file can grant access without rewriting RLS;
--    * member_roles still has no UPDATE policy, so a role change is always a
--      delete plus an insert, each checked;
--    * role_assign still requires assigned_by = auth.uid(), so a grant cannot
--      be attributed to someone else;
--    * trg_guard_last_president still refuses to remove the last president,
--      including for a developer;
--    * members still have no DELETE policy: people are retired, never deleted.
--
--  Run AFTER 20260105 and 20260106. Idempotent: safe to run twice.
--  Proven by supabase/tests/roles_rls_test.sql and finance_rls_test.sql.
-- =============================================================================

-- Club administration: the rulebook, subsystems, roster, seasons, milestones.
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from member_roles
                 where member_id = auth.uid()
                   and role in ('president', 'vicepresident', 'developer'));
$fn$;

-- Assigning and removing privileged roles.
create or replace function can_manage_roles() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('developer');
$fn$;

-- Writing financial records.
create or replace function can_manage_finances() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('treasurer') or has_role('developer');
$fn$;

-- can_view_finances() is unchanged: any privileged role may already see the
-- money, and that includes the developer.

comment on table member_roles is
  'Privileged roles. Only the president or a developer may add or remove rows '
  '(RLS). members.role is just a job title and grants nothing.';
