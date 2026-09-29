-- =============================================================================
--  Backend completion Phase 2, step 4 of 7: department membership.
--  (docs/backend-completion/PERMISSIONS.md §2.1, §3.4; the old R4.1 "no
--  membership table" is superseded by REMAINING_FEATURE_WORK, PLAN.md §1.)
--
--  WHAT WAS MISSING. Who works in which department could not be recorded. A
--  person may work in several departments; staffing changes between seasons.
--
--  AFTER.
--   * department_members(season_id, subteam_key, member_id): one row per person
--     per department per season (composite PK = no duplicate membership).
--     Many-to-many by construction.
--   * Organisational only. No authority helper reads this table: membership
--     never lets anyone edit a task, review a proposal, archive, restore or
--     manage anything (asserted in department_members_test.sql). Ownership is
--     not restricted to members either (R4.2 holds; OD-13).
--   * Written ONLY through add_department_member()/remove_department_member():
--     there are no INSERT/UPDATE/DELETE policies, and API roles have no table
--     write grants. Authority: President, Vice President, Developer, or the
--     Head of that department (directly or as its parent's Head). A governance
--     fallback does not extend this (P/VP already have it; Developer too).
--   * Adding needs an ACTIVE member, an ACTIVE department and an existing
--     season. The department row is locked FOR SHARE, so an add and an archive
--     of the same department serialize (guard_department_archive locks it FOR
--     UPDATE). Retiring a member later does not delete their rows: history.
--   * Removing deletes the row; the activity trail keeps member_added /
--     member_removed with who and when. Re-adding is allowed.
--   * FKs are ON DELETE RESTRICT: no season, department or member deletion can
--     silently erase membership history.
--   * Realtime publication + REPLICA IDENTITY FULL (DELETE payloads keep the
--     season, as for task_requirements).
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Season-scoped many-to-many membership.
--    Existing data  New, empty table. The SMC pack's proposed staffing is NOT
--                   seeded: it is a recommendation, not an approved assignment
--                   (OD-2).
--    Authorization  RLS: SELECT for is_member(). No write policies. Commands are
--                   SECURITY DEFINER with pinned search_path; EXECUTE for
--                   authenticated only.
--    Locking        CREATE TABLE; commands lock the department row FOR SHARE.
--    Rollback       DROP TABLE department_members (loses recorded memberships)
--                   and the two functions; remove it from the publication.
--    Deploy order   After 20260126000200 (uses department_authority()).
-- =============================================================================

create table if not exists department_members (
  season_id   uuid        not null references seasons(id)   on delete restrict,
  subteam_key text        not null references subteams(key) on delete restrict,
  member_id   uuid        not null references members(id)   on delete restrict,
  added_by    uuid        null     references members(id)   on delete set null,
  added_at    timestamptz not null default now(),
  constraint department_members_pkey primary key (season_id, subteam_key, member_id)
);

create index if not exists department_members_member on department_members (member_id, season_id);
create index if not exists department_members_department on department_members (subteam_key, season_id);
create index if not exists department_members_added_by on department_members (added_by);

comment on table department_members is
  'Who works in which department, per season. Organisational only: grants no '
  'authority (authority is department_authority()). Written only through '
  'add_department_member()/remove_department_member().';

alter table department_members enable row level security;
alter table department_members replica identity full;

drop policy if exists member_read on department_members;
create policy member_read on department_members for select to authenticated using (is_member());

revoke all on department_members from anon, authenticated;
grant select on department_members to authenticated;
grant all on department_members to service_role;

-- ----------------------------------------------------------------- commands
create or replace function can_manage_department_members(p_key text) returns boolean
language sql stable security definer set search_path = public as $fn$
  select can_manage_departments()
      or coalesce(department_authority(p_key) in ('head', 'parent_head'), false);
$fn$;

create or replace function add_department_member(p_season_id uuid, p_subteam_key text, p_member_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_rows int;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may change department membership.' using errcode = '42501';
  end if;
  perform 1 from subteams where key = p_subteam_key for share;
  if not found then
    raise exception 'Department % does not exist.', p_subteam_key using errcode = '23503';
  end if;
  if not can_manage_department_members(p_subteam_key) then
    raise exception 'Only the President, the Vice President, a Developer or this department''s Head '
      'may change its members.' using errcode = '42501';
  end if;
  if exists (select 1 from subteams where key = p_subteam_key and archived_at is not null) then
    raise exception 'Department % is archived.', p_subteam_key using errcode = '23514';
  end if;
  if not exists (select 1 from seasons where id = p_season_id) then
    raise exception 'That season does not exist.' using errcode = '23503';
  end if;
  if not exists (select 1 from members where id = p_member_id and status = 'active') then
    raise exception 'Only an active member can join a department.' using errcode = '23514';
  end if;

  insert into department_members (season_id, subteam_key, member_id, added_by)
  values (p_season_id, p_subteam_key, p_member_id, auth.uid())
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), p_season_id, 'department', p_subteam_key, 'member_added',
      jsonb_build_object('member_id', p_member_id));
  end if;
  return v_rows > 0;
end $fn$;

create or replace function remove_department_member(p_season_id uuid, p_subteam_key text, p_member_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_rows int;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may change department membership.' using errcode = '42501';
  end if;
  perform 1 from subteams where key = p_subteam_key for share;
  if not found then
    raise exception 'Department % does not exist.', p_subteam_key using errcode = '23503';
  end if;
  if not can_manage_department_members(p_subteam_key) then
    raise exception 'Only the President, the Vice President, a Developer or this department''s Head '
      'may change its members.' using errcode = '42501';
  end if;

  delete from department_members
   where season_id = p_season_id and subteam_key = p_subteam_key and member_id = p_member_id;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), p_season_id, 'department', p_subteam_key, 'member_removed',
      jsonb_build_object('member_id', p_member_id));
  end if;
  return v_rows > 0;
end $fn$;

revoke all on function can_manage_department_members(text) from public, anon;
revoke all on function add_department_member(uuid, text, uuid) from public, anon;
revoke all on function remove_department_member(uuid, text, uuid) from public, anon;
grant execute on function can_manage_department_members(text) to authenticated, service_role;
grant execute on function add_department_member(uuid, text, uuid) to authenticated, service_role;
grant execute on function remove_department_member(uuid, text, uuid) to authenticated, service_role;

-- -------------------------------------------------------- realtime publication
do $pub$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'department_members'
     ) then
    alter publication supabase_realtime add table department_members;
  end if;
end
$pub$;
