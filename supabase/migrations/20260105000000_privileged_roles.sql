-- =============================================================================
--  Four privileged roles, enforced by the database.
--
--  BEFORE: a single boolean, members.is_board, read by is_board(). Two flaws:
--   1. It could not say who does what. President, vice-president and
--      treasurer all had identical powers.
--   2. It was self-grantable. The member_self policy let any member UPDATE
--      their own row, and RLS cannot restrict individual columns, so
--          update members set is_board = true where id = auth.uid();
--      made anyone a board member. Demonstrated against Supabase's own
--      Postgres image before this migration was written.
--
--  AFTER: privileges live in their own table, member_roles, which only the
--  president can write. Nothing a member can edit about themselves grants
--  anything.
--
--    developer      reads everything, including finance; administers nothing
--                   (SUPERSEDED by 20260107: the developer has full access)
--    treasurer      the ONLY role that may write financial records
--    president      administers the club; the ONLY role that assigns roles
--    vicepresident  administers the club like the president, minus roles
--
--  A member may hold several roles — the treasurer might also be the club's
--  developer — so roles are rows, not a single column.
--
--  members.role, the free-text job title ("Chassis lead"), is unrelated and
--  unchanged. A title of "President" grants nothing.
--
--  Run AFTER 20260102, 20260103 and 20260104. Idempotent: safe to run twice.
-- =============================================================================

do $$ begin
  create type privileged_role as enum ('developer', 'treasurer', 'president', 'vicepresident');
exception when duplicate_object then null; end $$;

create table if not exists member_roles (
  member_id   uuid not null references members(id) on delete cascade,
  role        privileged_role not null,
  -- Who granted it. Filled in by the database from the caller's session and
  -- checked by the role_assign policy, so it cannot be forged.
  assigned_by uuid default auth.uid() references members(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (member_id, role)
);
-- No extra index: the primary key (member_id, role) serves every lookup the
-- policies make, and the table holds a handful of rows.

comment on table member_roles is
  'Privileged roles. Only the president may add or remove rows (RLS). '
  'members.role is just a job title and grants nothing.';

alter table member_roles enable row level security;
-- PostgREST never issues TRUNCATE, but Supabase grants it by default and
-- TRUNCATE ignores RLS entirely. Nothing needs it here.
revoke truncate on member_roles from anon, authenticated;

-- -----------------------------------------------------------------------------
--  The permission functions. Every policy calls one of these; nothing else
--  decides who may do what. SECURITY DEFINER with a pinned search_path, like
--  is_member(), so they read member_roles without tripping its own RLS.
-- -----------------------------------------------------------------------------
create or replace function has_role(wanted privileged_role) returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from member_roles where member_id = auth.uid() and role = wanted);
$fn$;

-- Club administration: the rulebook, subsystems, roster, seasons, milestones.
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from member_roles
                 where member_id = auth.uid() and role in ('president', 'vicepresident'));
$fn$;

create or replace function can_manage_roles() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president');
$fn$;

create or replace function can_manage_finances() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('treasurer');
$fn$;

-- Any privileged role may SEE the money; see the FINANCE note at the bottom.
create or replace function can_view_finances() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from member_roles where member_id = auth.uid());
$fn$;

-- -----------------------------------------------------------------------------
--  Carry the old board flag over — before it is dropped — so nobody loses
--  access they had. is_board did not record WHICH office, so the job title
--  decides, and anything unrecognised gets the least-privileged office that
--  still keeps their existing admin powers (vice-president: no role
--  management, no finance). Each decision is printed as a NOTICE.
--
--  Note the one intended change: under the new model a treasurer handles money
--  but no longer administers the rulebook, roster or seasons.
-- -----------------------------------------------------------------------------
do $$
declare
  board  record;
  mapped privileged_role;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'members'
                   and column_name = 'is_board') then
    return;  -- already migrated
  end if;

  for board in execute 'select id, full_name, role from members where is_board' loop
    mapped := case
      when board.role ~* '\mvice' or board.role ~* '^\s*vp\s*$' then 'vicepresident'
      when board.role ~* '\mpresident\M'                        then 'president'
      when board.role ~* '\mtreasurer\M'                        then 'treasurer'
      else                                                           'vicepresident'
    end;
    insert into member_roles (member_id, role, assigned_by)
    values (board.id, mapped, null)
    on conflict (member_id, role) do nothing;
    raise notice 'is_board member % (title "%") -> %', board.full_name, board.role, mapped;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
--  Policies
-- -----------------------------------------------------------------------------

-- The rulebook and the subsystem list: administration (was is_board()).
drop policy if exists board_write on clauses;
drop policy if exists admin_write on clauses;
create policy admin_write on clauses for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists board_write on subteams;
drop policy if exists admin_write on subteams;
create policy admin_write on subteams for all to authenticated
  using (is_admin()) with check (is_admin());

-- Seasons and milestones were writable by ANY member (member_write), which let
-- anyone switch the club's season with two direct UPDATEs and bypass the
-- set_current_season() check. Starting and switching seasons and setting
-- milestone dates and points are administration. Reading is unchanged
-- (member_read), and ticking milestone SECTIONS stays open to every member.
drop policy if exists member_write on seasons;
drop policy if exists admin_write on seasons;
create policy admin_write on seasons for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists member_write on milestones;
drop policy if exists admin_write on milestones;
create policy admin_write on milestones for all to authenticated
  using (is_admin()) with check (is_admin());

-- The roster. Anyone may still edit their own details; administrators may edit
-- anyone's and link new people. No privilege lives in this table any more, so
-- editing your own row can no longer promote you. Still no DELETE policy:
-- people are retired, never deleted.
drop policy if exists member_self on members;
drop policy if exists board_roster on members;
drop policy if exists member_self_update on members;
drop policy if exists admin_roster_insert on members;
create policy member_self_update on members for update to authenticated
  using (id = auth.uid() or is_admin()) with check (id = auth.uid() or is_admin());
create policy admin_roster_insert on members for insert to authenticated
  with check (is_admin());

-- Roles: everyone on the roster may see who holds what; only the president
-- may add or remove a role, and the grant is stamped with the real grantor.
drop policy if exists role_read on member_roles;
drop policy if exists role_assign on member_roles;
drop policy if exists role_remove on member_roles;
create policy role_read on member_roles for select to authenticated
  using (is_member());
create policy role_assign on member_roles for insert to authenticated
  with check (can_manage_roles() and assigned_by is not distinct from auth.uid());
create policy role_remove on member_roles for delete to authenticated
  using (can_manage_roles());
-- Deliberately NO update policy: a role is changed by removing one and adding
-- another, so every change passes through the two checks above.

-- The club must always have a president, or nobody could ever assign a role
-- again. To hand over: give the new person president first, then remove your
-- own.
create or replace function guard_last_president() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if old.role = 'president' and not exists (
    select 1 from member_roles where role = 'president' and member_id <> old.member_id
  ) then
    raise exception 'The club must always have a president. Give the role to someone else first, then remove it here.'
      using errcode = '42501';
  end if;
  return old;
end $fn$;

drop trigger if exists trg_guard_last_president on member_roles;
create trigger trg_guard_last_president before delete on member_roles
  for each row execute function guard_last_president();

-- The season switch: same single transaction, new authority check.
create or replace function set_current_season(p_season_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_admin() then
    raise exception 'Only the president or vice-president may change the current season'
      using errcode = '42501';
  end if;
  if not exists (select 1 from seasons where id = p_season_id) then
    raise exception 'Season % does not exist', p_season_id using errcode = '23503';
  end if;
  update seasons set is_current = false where is_current and id <> p_season_id;
  update seasons set is_current = true  where id = p_season_id;
end;
$fn$;
revoke all on function set_current_season(uuid) from public;
revoke all on function set_current_season(uuid) from anon;
grant execute on function set_current_season(uuid) to authenticated;

-- -----------------------------------------------------------------------------
--  Retire the old flag. Every caller of is_board() now calls is_admin(): the
--  four policies and set_current_season() above. Postgres refuses to drop a
--  function a policy still uses, but function BODIES are not dependency
--  tracked, which is why set_current_season() was rewritten first.
-- -----------------------------------------------------------------------------
drop function if exists is_board();
alter table members drop column if exists is_board;

-- =============================================================================
--  FINANCE
--
--  There are no financial tables yet. When one is added, secure it with
--  exactly this, and do NOT give it the member_read / member_write policies
--  the other tables have, or every member will see and edit the money:
--
--    alter table <t> enable row level security;
--    create policy finance_read   on <t> for select to authenticated
--      using (can_view_finances());
--    create policy finance_insert on <t> for insert to authenticated
--      with check (can_manage_finances());
--    create policy finance_update on <t> for update to authenticated
--      using (can_manage_finances()) with check (can_manage_finances());
--    create policy finance_delete on <t> for delete to authenticated
--      using (can_manage_finances());
--
--  supabase/tests/roles_rls_test.sql proves this template, role by role, on a
--  probe table that it rolls back.
-- =============================================================================
