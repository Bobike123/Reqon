-- =============================================================================
--  Phase 4 hardening: findings from the independent database/security review
--  (docs/redesign/reviews/phase-04.md). Each change is pinned by a check in
--  supabase/tests/phase4_adversarial_test.sql.
--
--    F-1  A member could set their OWN roster status: an alumnus reactivated
--         themselves and regained every write. members.status now changes only
--         through an active administrator (guard_member_edit).
--    F-2  has_role() ignored the roster: an alumnus who kept the President, Vice
--         President or Developer role kept its power (is_admin,
--         can_manage_departments, meetings, finance, roles). A privileged role
--         now counts only while its holder is an active member.
--    F-3  Any governance role could DELETE a season through the API, cascading
--         into its tasks, proposals, milestones, specs, meetings, notes and
--         audit trail. A season that holds any of those can no longer be
--         deleted (guard_season_delete). An empty season still can.
--    F-4  anon and authenticated held TRUNCATE (and TRIGGER, REFERENCES) on every
--         public table; RLS does not govern TRUNCATE. Revoked, and revoked for
--         tables created later.
--    F-5  An administrator could move a milestone that tasks or proposals use into
--         another season, breaking the season boundary. Refused while referenced.
--    F-6  clause_status, handover_notes, milestone_sections and specs let any
--         roster member, alumni included, write (is_member()). Writes now need
--         is_active_member(); reads are unchanged.
--    F-7  Department archive metadata came from the client: an administrator could
--         backdate archived_at and blame another member in archived_by. The
--         database now stamps both for any user session and keeps them fixed
--         while the department stays archived.
--    F-8  Introduced by F-2's own consequence, closed here: retiring a role holder
--         now strips their power, so it is restricted to the President or a
--         Developer, and the last active President cannot be retired.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        See above.
--    Existing data  Unchanged. No row is rewritten.
--    Authorization  Tightens only. has_role() keeps its signature and search_path.
--                   Nothing new is executable by anon.
--    Locking        CREATE OR REPLACE and metadata-only DDL; brief ACCESS
--                   EXCLUSIVE locks for CREATE TRIGGER / policy replacement.
--    Rollback       Forward recovery only. Reverting F-2 would restore the hole.
--                   A retired sole President/Developer can only be reinstated by
--                   a maintainer using the service role (see the review).
--    Deploy order   After 20260117, with the Phase 4 client (usePermissions,
--                   useSetSectionDrafted and useSaveMeasurement now report a
--                   zero-row write instead of silently succeeding).
-- =============================================================================

-- ------------------------------------------------------------------ F-2
create or replace function has_role(wanted privileged_role) returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1
    from member_roles r
    join members m on m.id = r.member_id
    where r.member_id = auth.uid() and r.role = wanted and m.status = 'active'
  );
$fn$;

-- is_admin(), can_view_finances() and guard_last_president() read member_roles
-- directly instead of through has_role(), so they need the same rule.
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('vicepresident') or has_role('developer');
$fn$;

create or replace function can_view_finances() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from member_roles r join members m on m.id = r.member_id
    where r.member_id = auth.uid() and m.status = 'active'
  );
$fn$;

-- "The club must always have a president" means an ACTIVE one: a retired
-- President holds no power any more (has_role), so counting them would let the
-- last active President's role be removed.
create or replace function guard_last_president() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if old.role = 'president' and not exists (
    select 1 from member_roles r join members m on m.id = r.member_id
    where r.role = 'president' and r.member_id <> old.member_id and m.status = 'active'
  ) then
    raise exception 'The club must always have a president. Give the role to someone else first, then remove it here.'
      using errcode = '42501';
  end if;
  return old;
end $fn$;

-- ------------------------------------------------------------------ F-1
-- Only sessions that carry a user (auth.uid() is not null) are judged; the
-- service role and the migration owner keep maintenance access. Because a
-- retired member now loses their roles (F-2), retiring someone who holds one is a
-- role decision: it needs can_manage_roles() (President or Developer), so a Vice
-- President cannot neutralise the President by retiring them, and the club can
-- never be left without an active President (F-8).
create or replace function guard_member_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null or new.status is not distinct from old.status then
    return new;
  end if;
  if not is_admin() then
    raise exception 'Only the President, Vice President or a Developer may change a member''s roster status.'
      using errcode = '42501';
  end if;
  if exists (select 1 from member_roles where member_id = old.id) and not can_manage_roles() then
    raise exception 'Only the President or a Developer may change the roster status of someone who holds a role.'
      using errcode = '42501';
  end if;
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

drop trigger if exists trg_guard_member_edit on members;
create trigger trg_guard_member_edit before update on members
  for each row execute function guard_member_edit();

-- ------------------------------------------------------------------ F-3
create or replace function guard_season_delete() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_holds text;
begin
  select string_agg(t, ', ') into v_holds from (
    select 'tasks' t where exists (select 1 from tasks where season_id = old.id)
    union all select 'proposals' where exists (select 1 from task_proposals where season_id = old.id)
    union all select 'milestones' where exists (select 1 from milestones where season_id = old.id)
    union all select 'specifications' where exists (select 1 from specs where season_id = old.id)
    union all select 'meetings' where exists (select 1 from meetings where season_id = old.id)
    union all select 'requirement status' where exists (select 1 from clause_status where season_id = old.id)
    union all select 'handover notes' where exists (select 1 from handover_notes where season_id = old.id)
    union all select 'activity history' where exists (select 1 from activity where season_id = old.id)
    union all select 'financial entries' where exists (select 1 from finance_entries where season_id = old.id)
  ) x;
  if v_holds is not null then
    raise exception 'Season "%" cannot be deleted: it still holds %. Nothing removes work or its history; archive or export it instead.',
      old.label, v_holds using errcode = '23503';
  end if;
  return old;
end $fn$;

drop trigger if exists trg_guard_season_delete on seasons;
create trigger trg_guard_season_delete before delete on seasons
  for each row execute function guard_season_delete();

-- ------------------------------------------------------------------ F-4
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

-- ------------------------------------------------------------------ F-5
create or replace function guard_milestone_season() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.season_id is distinct from old.season_id and (
    exists (select 1 from tasks where milestone_key = old.key)
    or exists (select 1 from task_proposals where milestone_key = old.key)
  ) then
    raise exception 'Milestone % is used by tasks or proposals, so it cannot move to another season.', old.key
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guard_milestone_season on milestones;
create trigger trg_guard_milestone_season before update of season_id on milestones
  for each row execute function guard_milestone_season();

-- ------------------------------------------------------------------ F-6
do $$
declare t text;
begin
  foreach t in array array['clause_status', 'handover_notes', 'milestone_sections', 'specs'] loop
    execute format('drop policy if exists member_write on %I', t);
    execute format(
      'create policy member_write on %I for all to authenticated using (is_active_member()) with check (is_active_member())', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ F-7
-- For a signed-in user session the server owns archived_at and archived_by. The
-- service role and the migration owner (auth.uid() is null) keep maintenance
-- access, and reconciliation_apply()/the client already send now()/the caller.
create or replace function stamp_department_archive() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.archived_at is not null and old.archived_at is null then
    new.archived_at := now();
    new.archived_by := auth.uid();
  elsif new.archived_at is not null and old.archived_at is not null then
    new.archived_at := old.archived_at;
    new.archived_by := old.archived_by;
  elsif new.archived_at is null then
    new.archived_by := null;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_stamp_department_archive on subteams;
create trigger trg_stamp_department_archive before update of archived_at, archived_by on subteams
  for each row execute function stamp_department_archive();
