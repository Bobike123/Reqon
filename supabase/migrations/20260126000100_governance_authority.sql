-- =============================================================================
--  Backend completion Phase 2, step 2 of 7: governance authority.
--  (docs/backend-completion/PERMISSIONS.md §1, §2.1, §4; findings F-03, F-04,
--  F-13 in docs/backend-completion/phase-01.md.)
--
--  WHAT WAS WRONG (reproduced in phase-01-repro.sql).
--   F-03  set_current_season() and the seasons.admin_write FOR ALL policy used
--         is_admin() (President, VICE PRESIDENT, Developer). The latest rule is
--         "only the President moves the club to a new season" (Developer keeps
--         its technical override). R01: a VP switched and created seasons.
--   F-04  can_manage_roles() was President/Developer only. The latest rule lets
--         the Vice President manage application roles too. R02: VP refused.
--   F-13  can_view_finances() was "holds ANY privileged role". Adding the new
--         Documentation role would have exposed the ledger to its holder.
--   Meetings/template writes used is_admin()/can_delete_records(); the new
--         Documentation role must be able to edit them.
--
--  AFTER.
--   * can_manage_seasons()  President or Developer. Used by set_current_season()
--     and by separate INSERT/UPDATE/DELETE policies on seasons, so the direct
--     PostgREST path is closed as well as the RPC.
--   * can_grant_role(role)  the per-role grant matrix (PERMISSIONS §4):
--       developer                    Developer only
--       president, vicepresident     President or Developer
--       treasurer, documentation     President, Vice President or Developer
--     Claudiu's and Máté's Developer grants can therefore only be changed by a
--     Developer. member_roles INSERT/DELETE policies and apply_role_plan() check
--     it for EVERY row; apply_role_plan() is one transaction, so a plan with one
--     forbidden row changes nothing.
--   * can_manage_roles()  President, Vice President or Developer: "may open role
--     management at all". It is no longer the per-row authority.
--   * guard_member_edit()  a roster-status change still needs is_admin(); for a
--     person who holds roles it now needs can_grant_role() for EACH held role
--     (so a VP cannot retire the President or a Developer). The last-active-
--     President rule is unchanged, and guard_last_president() is untouched.
--   * can_view_finances()  explicit allowlist: President, Vice President,
--     Treasurer, Developer. A Documentation-only holder sees nothing.
--   * can_edit_meetings()  President, Vice President, Developer, Documentation:
--     create/edit meetings and the default agenda. Deleting a meeting stays
--     can_delete_records() (President/Developer).
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Align SQL authority with the latest instructions.
--    Existing data  None touched. No role, member, season or meeting row is
--                   written. The hosted grants (1 President, 1 VP, 1 Treasurer,
--                   2 Developers) keep exactly the power this file describes.
--    Authorization  Every helper: SECURITY DEFINER, search_path pinned, reads
--                   only member_roles/members for auth.uid(), returns false for
--                   anonymous and inactive callers (has_role() requires an
--                   active roster row).
--    Locking        CREATE OR REPLACE FUNCTION and DROP/CREATE POLICY take brief
--                   ACCESS EXCLUSIVE locks on member_roles, seasons, meetings and
--                   meeting_template (all small).
--    Rollback       Forward recovery: re-create the previous bodies
--                   (20260107, 20260104, 20260118, 20260111) and the old
--                   policies (20260105, 20260108). No data to undo.
--    Deploy order   After 20260126000000 (the enum value must be committed).
--                   Deploy with the Phase 2 client, which stops showing season
--                   creation/switching to a Vice President; the old client
--                   would still show those buttons, and the database refuses.
-- =============================================================================

-- --------------------------------------------------------------- 1. helpers
create or replace function can_manage_seasons() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('developer');
$fn$;

comment on function can_manage_seasons() is
  'Create, edit, delete or switch seasons: President or Developer (backend completion Phase 2).';

create or replace function can_grant_role(p_role privileged_role) returns boolean
language sql stable security definer set search_path = public as $fn$
  select case p_role
    when 'developer'     then has_role('developer')
    when 'president'     then has_role('president') or has_role('developer')
    when 'vicepresident' then has_role('president') or has_role('developer')
    else has_role('president') or has_role('vicepresident') or has_role('developer')
  end;
$fn$;

comment on function can_grant_role(privileged_role) is
  'May the caller grant or remove this privileged role? The grant matrix of '
  'docs/backend-completion/PERMISSIONS.md §4. NULL role -> false.';

create or replace function can_manage_roles() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('vicepresident') or has_role('developer');
$fn$;

comment on function can_manage_roles() is
  'May open role management at all (President, Vice President, Developer). '
  'Which roles a caller may grant is can_grant_role(role).';

create or replace function can_view_finances() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('vicepresident')
      or has_role('treasurer') or has_role('developer');
$fn$;

comment on function can_view_finances() is
  'Explicit allowlist: President, Vice President, Treasurer, Developer. Holding '
  'any other role (e.g. documentation) grants no finance visibility.';

create or replace function can_edit_meetings() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('vicepresident')
      or has_role('developer') or has_role('documentation');
$fn$;

comment on function can_edit_meetings() is
  'Create and edit meetings and the default agenda: President, Vice President, '
  'Developer, Documentation. Deleting a meeting is can_delete_records().';

-- ----------------------------------------------------------------- 2. seasons
create or replace function set_current_season(p_season_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if not can_manage_seasons() then
    raise exception 'Only the President or a Developer may change the current season'
      using errcode = '42501';
  end if;
  if not exists (select 1 from seasons where id = p_season_id) then
    raise exception 'Season % does not exist', p_season_id using errcode = '23503';
  end if;
  update seasons set is_current = false where is_current and id <> p_season_id;
  update seasons set is_current = true  where id = p_season_id;
end;
$fn$;

drop policy if exists admin_write on seasons;
drop policy if exists season_insert on seasons;
drop policy if exists season_update on seasons;
drop policy if exists season_delete on seasons;
create policy season_insert on seasons for insert to authenticated
  with check (can_manage_seasons());
create policy season_update on seasons for update to authenticated
  using (can_manage_seasons()) with check (can_manage_seasons());
create policy season_delete on seasons for delete to authenticated
  using (can_manage_seasons());

-- ------------------------------------------------------------------- 3. roles
drop policy if exists role_assign on member_roles;
drop policy if exists role_remove on member_roles;
create policy role_assign on member_roles for insert to authenticated
  with check (can_grant_role(role) and not (assigned_by is distinct from auth.uid()));
create policy role_remove on member_roles for delete to authenticated
  using (can_grant_role(role));

create or replace function apply_role_plan(p_changes jsonb) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_change   jsonb;
  v_member   uuid;
  v_role     privileged_role;
  v_action   text;
begin
  if not can_manage_roles() then
    raise exception 'Only the President, the Vice President or a Developer may change privileged roles'
      using errcode = '42501';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'p_changes must be a JSON array of {member_id, role, action}'
      using errcode = '22023';
  end if;

  -- Applied in array order (grants before removals, the caller's own presidency
  -- last — src/roles/rolePlan.ts). The whole call is one transaction: any
  -- refused row below raises and rolls back every row before it.
  for v_change in select * from jsonb_array_elements(p_changes)
  loop
    if not (v_change ? 'member_id' and v_change ? 'role' and v_change ? 'action') then
      raise exception 'Each change needs member_id, role and action; got %', v_change
        using errcode = '22023';
    end if;

    v_member := (v_change ->> 'member_id')::uuid;
    v_role   := (v_change ->> 'role')::privileged_role;
    v_action := v_change ->> 'action';

    -- This function runs as its owner, so RLS does not apply to the writes
    -- below: the per-role check must be made here, for every row.
    if not can_grant_role(v_role) then
      raise exception 'You may not grant or remove the % role.', v_role
        using errcode = '42501';
    end if;

    if v_action = 'add' then
      insert into member_roles (member_id, role, assigned_by)
      values (v_member, v_role, auth.uid())
      on conflict (member_id, role) do nothing;
    elsif v_action = 'remove' then
      delete from member_roles where member_id = v_member and role = v_role;
    else
      raise exception 'action must be ''add'' or ''remove'', got %', v_action
        using errcode = '22023';
    end if;
  end loop;
end;
$fn$;

-- ---------------------------------------------------- 4. roster status changes
create or replace function guard_member_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_role privileged_role;
begin
  if auth.uid() is null or new.status is not distinct from old.status then
    return new;
  end if;
  if not is_admin() then
    raise exception 'Only the President, Vice President or a Developer may change a member''s roster status.'
      using errcode = '42501';
  end if;
  -- Retiring or reactivating someone who holds roles changes what those roles
  -- can do, so it needs the authority to grant/remove each of them.
  for v_role in select r.role from member_roles r where r.member_id = old.id loop
    if not can_grant_role(v_role) then
      raise exception 'You may not change the roster status of someone who holds the % role.', v_role
        using errcode = '42501';
    end if;
  end loop;
  if old.status = 'active' and new.status <> 'active'
     and exists (select 1 from member_roles where member_id = old.id and role = 'president')
     and not exists (
       select 1 from member_roles r join members m on m.id = r.member_id
       where r.role = 'president' and r.member_id <> old.id and m.status = 'active'
     ) then
    raise exception 'The club must always have an active president. Give the role to someone else first.'
      using errcode = '42501';
  end if;
  return new;
end $fn$;

-- ----------------------------------------------------------------- 5. meetings
drop policy if exists meeting_insert on meetings;
drop policy if exists meeting_update on meetings;
create policy meeting_insert on meetings for insert to authenticated
  with check (can_edit_meetings());
create policy meeting_update on meetings for update to authenticated
  using (can_edit_meetings()) with check (can_edit_meetings());
-- meeting_delete (can_delete_records) and member_read are unchanged.

drop policy if exists template_write on meeting_template;
drop policy if exists template_insert on meeting_template;
drop policy if exists template_update on meeting_template;
drop policy if exists template_delete on meeting_template;
create policy template_insert on meeting_template for insert to authenticated
  with check (can_edit_meetings());
create policy template_update on meeting_template for update to authenticated
  using (can_edit_meetings()) with check (can_edit_meetings());
create policy template_delete on meeting_template for delete to authenticated
  using (can_delete_records());

-- ------------------------------------------------------------------- 6. grants
revoke all on function can_manage_seasons() from public, anon;
revoke all on function can_grant_role(privileged_role) from public, anon;
revoke all on function can_edit_meetings() from public, anon;
grant execute on function can_manage_seasons() to authenticated, service_role;
grant execute on function can_grant_role(privileged_role) to authenticated, service_role;
grant execute on function can_edit_meetings() to authenticated, service_role;
