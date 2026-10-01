-- =============================================================================
--  Backend completion Phase 3, task side, step 1 of 4: prerequisite links
--  between tasks ("this task waits for that one"). (PERMISSIONS.md §2.2, §7;
--  requirement "links to prerequisite tasks across departments".)
--
--  WHAT WAS MISSING. A task could be `blocked`, but nothing said what it waited
--  for. There was no way to record that a task in one department depends on a
--  task in another.
--
--  AFTER.
--   * task_dependencies(task_id, depends_on_task_id): "task_id waits for
--     depends_on_task_id". Primary key = the pair, so a link exists once.
--   * Rules enforced for every writer by the BEFORE INSERT trigger:
--       - no self-link (also a CHECK);
--       - both tasks in the same season (season_id is derived, never supplied);
--       - neither task archived when the link is made (an archived task's
--         existing links stay readable);
--       - no cycle: the link is refused if the prerequisite already waits,
--         directly or through others, on this task. The check runs under one
--         advisory lock per season, so two concurrent inserts that would together
--         close a circle serialise and the second one is refused.
--     Departments are deliberately not compared: cross-department links are the
--     point.
--   * Rows are immutable (no UPDATE). Nothing writes the table directly:
--     add_task_dependency() / remove_task_dependency() are the only paths and
--     both need can_edit_task(dependent) — whoever may edit the waiting task, at
--     the moment of the call (so a reassigned owner or a replaced Head is
--     re-evaluated). The prerequisite's owner is not asked: the link changes
--     nothing on their task.
--   * Removing the last explanation of a blocked task is refused (see
--     20260128000100): a blocked task must always say why.
--   * Audit: 'dependency_added' / 'dependency_removed' on the WAITING task's
--     activity, naming the prerequisite. Realtime: the table is published.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Prerequisite links with same-season and no-cycle guarantees.
--    Existing data  New empty table; nothing backfilled (no link was ever recorded).
--    Authorization  RLS SELECT for members; no write grants to API roles. The
--                   commands are SECURITY DEFINER with a pinned search_path,
--                   executable by authenticated and service_role only.
--    Locking        CREATE TABLE plus a publication change: brief.
--    Rollback       DROP TABLE task_dependencies CASCADE; drop the four functions;
--                   remove from the publication. No other table is altered.
--    Deploy order   After 20260127000300. The client (Board/Gantt prerequisite
--                   controls) ships after this migration.
-- =============================================================================

create table if not exists task_dependencies (
  task_id            uuid        not null references tasks(id) on delete cascade,
  depends_on_task_id uuid        not null references tasks(id) on delete cascade,
  season_id          uuid        not null references seasons(id) on delete restrict,
  created_by         uuid        references members(id) on delete set null,
  created_at         timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  constraint task_dependencies_no_self check (task_id <> depends_on_task_id)
);
create index if not exists task_dependencies_prerequisite on task_dependencies (depends_on_task_id);
create index if not exists task_dependencies_season on task_dependencies (season_id);

comment on table task_dependencies is
  'task_id waits for depends_on_task_id. Same season, no cycles, any departments. Written only by add_task_dependency()/remove_task_dependency().';

create or replace function enforce_task_dependency() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_dependent tasks%rowtype;
  v_prerequisite tasks%rowtype;
  v_cycle boolean;
begin
  if TG_OP <> 'INSERT' then
    raise exception 'A prerequisite link cannot be edited. Remove it and add the right one.'
      using errcode = '42501';
  end if;

  if new.task_id = new.depends_on_task_id then
    raise exception 'A task cannot wait for itself.' using errcode = '23514';
  end if;

  select * into v_dependent from tasks where id = new.task_id;
  select * into v_prerequisite from tasks where id = new.depends_on_task_id;
  if v_dependent.id is null or v_prerequisite.id is null then
    raise exception 'Both tasks must exist.' using errcode = '23503';
  end if;
  if v_dependent.season_id is distinct from v_prerequisite.season_id then
    raise exception 'A task can only wait for a task of the same season.' using errcode = '23514';
  end if;
  if v_dependent.archived_at is not null or v_prerequisite.archived_at is not null then
    raise exception 'An archived task cannot be given a new prerequisite link. Restore it first.'
      using errcode = '23514';
  end if;
  new.season_id := v_dependent.season_id;
  new.created_at := now();
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;

  -- One lock per season: two links that would together close a circle cannot
  -- both pass the check below.
  perform pg_advisory_xact_lock(hashtextextended('task_dependencies:' || new.season_id::text, 0));
  with recursive walk(id) as (
    select new.depends_on_task_id
    union
    select d.depends_on_task_id from task_dependencies d join walk w on d.task_id = w.id
  )
  select exists (select 1 from walk where id = new.task_id) into v_cycle;
  if v_cycle then
    raise exception '“%” already waits, directly or through other tasks, for “%”. '
      'Linking them the other way round would make a circle.', v_prerequisite.title, v_dependent.title
      using errcode = '23514';
  end if;
  return new;
end $fn$;
revoke all on function enforce_task_dependency() from public, anon, authenticated;

drop trigger if exists trg_enforce_task_dependency on task_dependencies;
create trigger trg_enforce_task_dependency before insert or update on task_dependencies
  for each row execute function enforce_task_dependency();

create or replace function log_task_dependency() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_row task_dependencies := case when TG_OP = 'DELETE' then old else new end;
  v_title text;
  v_prereq_title text;
begin
  select title into v_title from tasks where id = v_row.task_id;
  select title into v_prereq_title from tasks where id = v_row.depends_on_task_id;
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), v_row.season_id, 'task', v_row.task_id::text,
    case when TG_OP = 'DELETE' then 'dependency_removed' else 'dependency_added' end,
    jsonb_build_object('title', v_title, 'depends_on', v_row.depends_on_task_id, 'depends_on_title', v_prereq_title));
  return null;
end $fn$;
revoke all on function log_task_dependency() from public, anon, authenticated;

drop trigger if exists trg_log_task_dependency on task_dependencies;
create trigger trg_log_task_dependency after insert or delete on task_dependencies
  for each row execute function log_task_dependency();

alter table task_dependencies enable row level security;
alter table task_dependencies replica identity full;
drop policy if exists member_read on task_dependencies;
create policy member_read on task_dependencies for select to authenticated using (is_member());
revoke all on task_dependencies from anon, authenticated;
grant select on task_dependencies to authenticated;
grant all on task_dependencies to service_role;

do $pub$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_dependencies') then
    alter publication supabase_realtime add table task_dependencies;
  end if;
end
$pub$;

-- ------------------------------------------------------------------ commands
-- Returns true when the link was added, false when it already existed (a retry).
create or replace function add_task_dependency(p_task_id uuid, p_depends_on_task_id uuid) returns boolean
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member can link tasks.' using errcode = '42501';
  end if;
  if p_task_id is null or p_depends_on_task_id is null then
    raise exception 'Both tasks are required.' using errcode = '22004';
  end if;
  -- Serialise with anything else changing the waiting task.
  perform 1 from tasks where id = p_task_id for share;
  if not found then
    raise exception 'That task does not exist.' using errcode = 'P0002';
  end if;
  if not can_edit_task(p_task_id) then
    raise exception 'You can''t change what this task waits for. Its owner, its department''s Head or a Developer can.'
      using errcode = '42501';
  end if;
  if exists (select 1 from task_dependencies where task_id = p_task_id and depends_on_task_id = p_depends_on_task_id) then
    return false;
  end if;
  insert into task_dependencies (task_id, depends_on_task_id, season_id)
  values (p_task_id, p_depends_on_task_id, (select season_id from tasks where id = p_task_id));
  return true;
end $fn$;

-- Returns true when a link was removed, false when there was none (a retry).
create or replace function remove_task_dependency(p_task_id uuid, p_depends_on_task_id uuid) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v tasks%rowtype;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member can unlink tasks.' using errcode = '42501';
  end if;
  select * into v from tasks where id = p_task_id for update;
  if not found then
    raise exception 'That task does not exist.' using errcode = 'P0002';
  end if;
  if not can_edit_task(p_task_id) then
    raise exception 'You can''t change what this task waits for. Its owner, its department''s Head or a Developer can.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from task_dependencies where task_id = p_task_id and depends_on_task_id = p_depends_on_task_id) then
    return false;
  end if;
  if v.state = 'blocked' and v.blocked_reason is null
     and (select count(*) from task_dependencies where task_id = p_task_id) = 1 then
    raise exception 'This is the only thing the blocked task waits for. Write the blocker reason or move the task out of Blocked first.'
      using errcode = '23514';
  end if;
  delete from task_dependencies where task_id = p_task_id and depends_on_task_id = p_depends_on_task_id;
  return true;
end $fn$;

revoke all on function add_task_dependency(uuid, uuid) from public, anon;
revoke all on function remove_task_dependency(uuid, uuid) from public, anon;
grant execute on function add_task_dependency(uuid, uuid) to authenticated, service_role;
grant execute on function remove_task_dependency(uuid, uuid) to authenticated, service_role;
