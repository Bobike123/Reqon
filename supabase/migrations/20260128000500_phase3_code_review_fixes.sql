-- =============================================================================
--  Backend completion Phase 3, findings of the final /code-review pass (step 6 of 6,
--  task side). Nothing in an earlier file is edited.
--
--   * guard_section_hierarchy locked only the milestone a section lands in; a move out of
--     milestone M racing a child insert under it (locking M) could leave a child in M with a
--     parent in N. It now locks the source and the destination, in key order.
--   * add_task_dependency checked "already there" and then inserted; two concurrent identical
--     adds could fail with a raw primary-key error. The insert is now ON CONFLICT DO NOTHING and
--     the result says whether a row was added.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Close two concurrency gaps. Existing data  Untouched.
--    Authorization  Unchanged (same pinned search_path, same grants).
--    Locking        CREATE OR REPLACE FUNCTION only.
--    Rollback       Re-apply the definitions from 20260128000300 / 20260128000400 / 20260128000000.
--    Deploy order   After 20260128000400.
-- =============================================================================

create or replace function guard_section_hierarchy() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_parent milestone_sections%rowtype;
begin
  -- One lock per milestone: two re-parentings cannot both pass a check that reads the
  -- other's uncommitted change.
  -- Both the milestone a row is leaving and the one it lands in, in a fixed order (no deadlock).
  perform pg_advisory_xact_lock(hashtextextended('milestone_sections:' || k, 0))
    from (select distinct k from unnest(array[new.milestone_key, case when TG_OP = 'UPDATE' then old.milestone_key end]) k
          where k is not null order by k) keys;
  if new.parent_section_id is not null then
    if TG_OP = 'UPDATE' and new.parent_section_id = new.id then
      raise exception 'A section cannot be its own parent.' using errcode = '23514';
    end if;
    select * into v_parent from milestone_sections where id = new.parent_section_id;
    if not found then
      raise exception 'The parent section does not exist.' using errcode = '23503';
    end if;
    if v_parent.parent_section_id is not null then
      raise exception 'Subsections go one level deep: “%” is already a subsection.', v_parent.name
        using errcode = '23514';
    end if;
    if v_parent.milestone_key is distinct from new.milestone_key then
      raise exception 'A subsection belongs to the same milestone as its parent section.' using errcode = '23514';
    end if;
    if TG_OP = 'UPDATE' and exists (select 1 from milestone_sections c where c.parent_section_id = new.id) then
      raise exception '“%” has subsections of its own, so it cannot become a subsection.', new.name
        using errcode = '23514';
    end if;
  end if;
  if TG_OP = 'UPDATE' and new.milestone_key is distinct from old.milestone_key
     and exists (select 1 from milestone_sections c where c.parent_section_id = new.id) then
    raise exception '“%” has subsections, so it cannot move to another milestone.', new.name
      using errcode = '23514';
  end if;
  return new;
end $fn$;

create or replace function add_task_dependency(p_task_id uuid, p_depends_on_task_id uuid) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_rows bigint;
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
  -- A concurrent identical add (a double click, a retry racing the first call) inserts nothing and
  -- says so, instead of failing on the primary key.
  insert into task_dependencies (task_id, depends_on_task_id, season_id)
  values (p_task_id, p_depends_on_task_id, (select season_id from tasks where id = p_task_id))
  on conflict (task_id, depends_on_task_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $fn$;
