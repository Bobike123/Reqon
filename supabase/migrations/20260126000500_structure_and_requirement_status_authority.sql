-- =============================================================================
--  Backend completion Phase 2, step 6 of 7: milestone-section structure and
--  requirement-status history. (docs/backend-completion/PERMISSIONS.md §2.1;
--  finding F-09; Phase 4 deferral D-2.)
--
--  WHAT WAS WRONG (phase-01-repro.sql R08).
--   * milestone_sections: member_write FOR ALL is_active_member() let any
--     member create, rename, re-own or DELETE sections of any milestone.
--   * clause_status: the same policy let any member DELETE a season's
--     compliance record for a requirement, and no change to a requirement's
--     status, owner or evidence was ever written to the activity trail.
--
--  AFTER.
--   * can_manage_milestone_structure(): President, Vice President, Developer,
--     Documentation (milestone submissions are documentation work).
--   * milestone_sections: INSERT and DELETE need that authority; UPDATE is open
--     to active members only for the is_drafted tick (the Milestones checklist,
--     src/data/useMilestones.ts, reversible and not history); any other column
--     change needs the authority (guard_section_edit). A section still referenced
--     by a task cannot be deleted (tasks.section_id FK) or moved (unchanged).
--   * clause_status: INSERT/UPDATE for active members as before (the Register
--     upserts); no DELETE for any API role. log_requirement_status() writes
--     'status_changed', 'owner_changed' and 'evidence_changed' activity rows
--     (entity 'requirement', entity_id = clause_key, the row's season). Evidence
--     text is not copied into activity (only whether it was set), as for
--     proposal decision notes.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Close F-09 without changing what the current client does.
--    Existing data  None touched. Past status changes were never logged and
--                   cannot be reconstructed; only changes from now on are.
--    Authorization  Policies as above; helper SECURITY DEFINER, search_path
--                   pinned. Trigger functions not executable by API roles.
--    Locking        DROP/CREATE POLICY and CREATE TRIGGER: brief locks on two
--                   small tables.
--    Rollback       Re-create member_write (20260118) on both tables; drop the
--                   two triggers and the helper.
--    Deploy order   After 20260126000100 (the documentation role value).
-- =============================================================================

create or replace function can_manage_milestone_structure() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('vicepresident')
      or has_role('developer') or has_role('documentation');
$fn$;
revoke all on function can_manage_milestone_structure() from public, anon;
grant execute on function can_manage_milestone_structure() to authenticated, service_role;

-- ------------------------------------------------------- milestone sections
drop policy if exists member_write on milestone_sections;
drop policy if exists section_insert on milestone_sections;
drop policy if exists section_update on milestone_sections;
drop policy if exists section_delete on milestone_sections;
create policy section_insert on milestone_sections for insert to authenticated
  with check (can_manage_milestone_structure());
create policy section_update on milestone_sections for update to authenticated
  using (is_active_member()) with check (is_active_member());
create policy section_delete on milestone_sections for delete to authenticated
  using (can_manage_milestone_structure());

create or replace function guard_section_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null or can_manage_milestone_structure() then
    return new;
  end if;
  if (to_jsonb(new) - 'is_drafted' - 'updated_at') is distinct from (to_jsonb(old) - 'is_drafted' - 'updated_at') then
    raise exception 'Only the President, Vice President, Documentation or a Developer may change a section '
      'other than ticking it drafted.' using errcode = '42501';
  end if;
  return new;
end $fn$;
revoke all on function guard_section_edit() from public, anon, authenticated;

drop trigger if exists trg_guard_section_edit on milestone_sections;
create trigger trg_guard_section_edit before update on milestone_sections
  for each row execute function guard_section_edit();

-- ------------------------------------------------------ requirement status
drop policy if exists member_write on clause_status;
drop policy if exists status_insert on clause_status;
drop policy if exists status_update on clause_status;
create policy status_insert on clause_status for insert to authenticated
  with check (is_active_member());
create policy status_update on clause_status for update to authenticated
  using (is_active_member()) with check (is_active_member());
revoke delete, truncate on clause_status from anon, authenticated;

create or replace function log_requirement_status() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_old_state clause_state := case when TG_OP = 'UPDATE' then old.state else 'open' end;
  v_old_owner uuid := case when TG_OP = 'UPDATE' then old.owner_id end;
  v_old_evidence text := case when TG_OP = 'UPDATE' then old.evidence end;
begin
  if new.state is distinct from v_old_state then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'requirement', new.clause_key, 'status_changed',
      jsonb_build_object('from', v_old_state, 'to', new.state));
  end if;
  if new.owner_id is distinct from v_old_owner then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'requirement', new.clause_key, 'owner_changed',
      jsonb_build_object('from', v_old_owner, 'to', new.owner_id));
  end if;
  if new.evidence is distinct from v_old_evidence then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'requirement', new.clause_key, 'evidence_changed',
      jsonb_build_object('had_value', v_old_evidence is not null, 'has_value', new.evidence is not null));
  end if;
  return null;
end $fn$;
revoke all on function log_requirement_status() from public, anon, authenticated;

drop trigger if exists trg_log_requirement_status on clause_status;
create trigger trg_log_requirement_status after insert or update on clause_status
  for each row execute function log_requirement_status();
