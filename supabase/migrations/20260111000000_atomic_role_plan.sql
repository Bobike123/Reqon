-- =============================================================================
--  Atomic role-plan application.
--
--  WHAT WAS WRONG. useApplyRoleChanges() (src/data/useSettings.ts) applied a
--  RolePlan (src/roles/rolePlan.ts) one member_roles INSERT/DELETE at a time,
--  stopping at the first refusal. A hand-over of "give Bo president, take it
--  from me" is two writes; if the network dropped between them the club was
--  left with the OLD president stripped and Bo never granted it — nobody able
--  to assign anything, which is precisely the situation the last-president
--  trigger (20260105) exists to prevent, defeated by doing the two halves as
--  two separate HTTP requests.
--
--  AFTER: one SECURITY DEFINER function, apply_role_plan(), applies every
--  change in a plan as one transaction. It re-checks can_manage_roles() itself
--  (SECURITY DEFINER bypasses the role_assign/role_remove RLS policies, so the
--  same authorization those policies would have done is repeated here — see
--  is_admin()/can_manage_roles() throughout this codebase for the same
--  pattern). The existing trg_guard_last_president trigger on member_roles
--  still fires on every DELETE inside the loop, unchanged: if applying the
--  plan would ever leave the club with no president, that DELETE raises, the
--  exception propagates out of the function, and the whole plan — every
--  change already applied earlier in the SAME call — rolls back with it.
--  Nothing new needed to write for that guarantee; it falls out of "a
--  function body is one transaction" (see set_current_season, 20260104, for
--  the same reasoning applied to switching seasons).
--
--  Run AFTER 20260105 (privileged_roles: member_roles, can_manage_roles(),
--  trg_guard_last_president). Idempotent: safe to run twice.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Apply a whole role plan in one transaction, so a hand-over
--                   can never half-apply.
--    Existing data  None touched: this only defines a function.
--    New objects    Function apply_role_plan(jsonb).
--    Locking        No DDL on any table. At runtime: ordinary row locks on the
--                   member_roles rows it inserts/deletes, for one transaction.
--    Authorization  SECURITY DEFINER, search_path pinned to public; re-checks
--                   can_manage_roles() (president only). The existing
--                   trg_guard_last_president still fires on each delete.
--                   EXECUTE revoked from public/anon, granted to authenticated.
--    Rollback       DROP FUNCTION apply_role_plan(jsonb). No data to restore.
--                   The client (useApplyRoleChanges, now in
--                   src/roles/useMemberRoles.ts) calls this RPC, so revert
--                   the client with it.
--    Deploy order   Apply BEFORE deploying the frontend that calls
--                   rpc('apply_role_plan').
-- =============================================================================

create or replace function apply_role_plan(p_changes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_change   jsonb;
  v_member   uuid;
  v_role     privileged_role;
  v_action   text;
begin
  if not can_manage_roles() then
    raise exception 'Only the President may change privileged roles'
      using errcode = '42501';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'p_changes must be a JSON array of {member_id, role, action}'
      using errcode = '22023';
  end if;

  -- jsonb_array_elements() preserves array order, so changes apply in exactly
  -- the order src/roles/rolePlan.ts computed them in: grants before removals,
  -- the caller's own presidency last. That order is what makes a hand-over
  -- ("give Bo president, then give up my own") never pass through a moment
  -- with zero presidents even mid-plan, on top of the atomicity this function
  -- already adds.
  for v_change in select * from jsonb_array_elements(p_changes)
  loop
    if not (v_change ? 'member_id' and v_change ? 'role' and v_change ? 'action') then
      raise exception 'Each change needs member_id, role and action; got %', v_change
        using errcode = '22023';
    end if;

    v_member := (v_change ->> 'member_id')::uuid;
    v_role   := (v_change ->> 'role')::privileged_role;
    v_action := v_change ->> 'action';

    if v_action = 'add' then
      -- assigned_by is the caller, never taken from the plan — matching the
      -- role_assign policy's own check that a president cannot forge it.
      insert into member_roles (member_id, role, assigned_by)
      values (v_member, v_role, auth.uid())
      on conflict (member_id, role) do nothing;
    elsif v_action = 'remove' then
      delete from member_roles where member_id = v_member and role = v_role;
      -- Firing (or not) is exactly trg_guard_last_president's job; a
      -- last-president removal raises from inside that trigger and this
      -- function propagates it unchanged.
    else
      raise exception 'action must be ''add'' or ''remove'', got %', v_action
        using errcode = '22023';
    end if;
  end loop;
end;
$fn$;

comment on function apply_role_plan(jsonb) is
  'Applies a RolePlan (src/roles/rolePlan.ts) as one transaction: every '
  'change lands, or none does. p_changes is a JSON array of '
  '{member_id: uuid, role: privileged_role, action: "add" | "remove"}, in '
  'the exact order they should be applied.';

revoke all on function apply_role_plan(jsonb) from public;
revoke all on function apply_role_plan(jsonb) from anon;
grant execute on function apply_role_plan(jsonb) to authenticated;
