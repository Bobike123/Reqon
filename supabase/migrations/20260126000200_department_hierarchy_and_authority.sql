-- =============================================================================
--  Backend completion Phase 2, step 3 of 7: subdepartments and one
--  department-authority rule.
--  (docs/backend-completion/PERMISSIONS.md §1, §2.2, §3, §9; findings F-05,
--  F-06, F-21.)
--
--  WHAT WAS MISSING / WRONG.
--   * No subdepartments (notes.md "departments and subdepartments that can be
--     added"; the old R2.2 "flat" rule is superseded, PLAN.md §1).
--   * F-06: a department without a Head could only be acted for by a Developer.
--     All five live departments have no Head.
--   * F-05: President and Vice President could not restore archived tasks.
--   * Five functions each re-derived "Head of the task's department or
--     Developer" with slightly different wording.
--
--  AFTER.
--   * subteams.parent_key (nullable FK to subteams, ON DELETE RESTRICT).
--     Exactly one level: a subdepartment's parent must be a top-level
--     department, a department with subdepartments cannot itself become one,
--     and a row cannot be its own parent (CHECK). Every hierarchy change takes
--     one transaction-scoped advisory lock and re-reads under it, so two
--     concurrent re-parentings cannot build a cycle. A subdepartment cannot be
--     active under an archived parent; a parent cannot be archived while it has
--     active subdepartments.
--   * The ten-department cap counts ACTIVE TOP-LEVEL departments only.
--   * department_authority(key) is the one rule (PERMISSIONS §3.2), evaluated at
--     call time from current rows (so a revoked or reassigned headship, a
--     retirement or an archived department takes effect on the next call):
--       'head'                 active caller is the department's lead_id
--       'parent_head'          ... or the lead of its (active) parent
--       'developer'            active Developer (technical override)
--       'governance_fallback'  active President/VP, only when neither the
--                              department nor its parent has an ACTIVE Head;
--                              for department-less (NULL) work: President/VP
--       NULL                   anything else, including every inactive caller
--     A subdepartment Head has no authority over the parent or its siblings.
--     Membership rows (next migration) and members.role (job title) are never
--     read here: they grant nothing.
--   * is_department_head(key) now means "Head, directly or through the parent".
--   * can_edit_task, can_review_proposal, guard_task_edit (owner reassignment)
--     and archive_task use department_authority(). restore_task additionally
--     allows any active President or Vice President (latest instruction). Row
--     locks (FOR UPDATE, then the check), the manual-only archive reason and
--     the reopen-a-Done-task-on-restore rule are unchanged.
--   * guard_department_archive no longer counts ARCHIVED unfinished tasks
--     (F-21: they could block archiving forever) and refuses to archive a
--     parent with active subdepartments.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Hierarchy + one authority helper; PERMISSIONS §3.
--    Existing data  ADD COLUMN parent_key (NULL for all five departments: they
--                   stay top-level). No department, task, proposal or Head is
--                   changed. The five departments keep their keys, names, order.
--    Authorization  parent_key is written through the existing department_update
--                   policy (can_manage_departments(): President, VP, Developer).
--                   Helpers: SECURITY DEFINER, search_path pinned.
--    Locking        ADD COLUMN nullable: metadata only. Hierarchy trigger:
--                   pg_advisory_xact_lock('reqon_department_hierarchy'). The cap
--                   keeps its own advisory lock. archive/restore keep FOR UPDATE.
--    Rollback       Forward recovery: re-create the 20260115/16/17/24 function
--                   bodies and drop parent_key only if no row uses it.
--    Deploy order   After 20260126000100. The current client never sends
--                   parent_key; the fallback widens what P/VP may do, and the
--                   Phase 2 client shows it.
-- =============================================================================

-- ------------------------------------------------------------- 1. the column
alter table subteams add column if not exists parent_key text null
  references subteams(key) on delete restrict;
alter table subteams drop constraint if exists subteams_parent_not_self;
alter table subteams add constraint subteams_parent_not_self
  check (parent_key is null or parent_key <> key);
create index if not exists subteams_parent on subteams (parent_key) where parent_key is not null;

comment on column subteams.parent_key is
  'NULL = top-level department. Otherwise the key of the ACTIVE top-level '
  'department this subdepartment belongs to (one level only; enforced by '
  'guard_department_hierarchy). Its Head has authority here too.';

-- ------------------------------------------------------- 2. hierarchy guard
create or replace function guard_department_hierarchy() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_parent subteams%rowtype;
begin
  if TG_OP = 'UPDATE'
     and new.parent_key is not distinct from old.parent_key
     and new.archived_at is not distinct from old.archived_at then
    return new;
  end if;

  -- One lock for every hierarchy change; each statement below takes a fresh
  -- snapshot, so it sees any re-parenting that committed while we waited.
  perform pg_advisory_xact_lock(hashtext('reqon_department_hierarchy'));

  if new.parent_key is not null then
    select * into v_parent from subteams where key = new.parent_key;
    if not found then
      raise exception 'Parent department % does not exist.', new.parent_key using errcode = '23503';
    end if;
    if v_parent.parent_key is not null then
      raise exception 'Subdepartments are one level deep: % is itself a subdepartment.', new.parent_key
        using errcode = '23514';
    end if;
    if exists (select 1 from subteams c where c.parent_key = new.key and c.key <> new.key) then
      raise exception 'Department % has subdepartments, so it cannot become a subdepartment itself.', new.key
        using errcode = '23514';
    end if;
    if new.archived_at is null and v_parent.archived_at is not null then
      raise exception 'Department % is archived; restore it before adding or restoring its subdepartments.', new.parent_key
        using errcode = '23514';
    end if;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_department_hierarchy on subteams;
create trigger trg_department_hierarchy before insert or update of parent_key, archived_at on subteams
  for each row execute function guard_department_hierarchy();

-- ----------------------------------------------- 3. cap counts top level only
create or replace function enforce_department_cap() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  other_active int;
begin
  -- Archived rows and subdepartments never add to the count.
  if new.archived_at is not null or new.parent_key is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('reqon_department_cap'));

  select count(*) into other_active from subteams
    where archived_at is null and parent_key is null and key <> new.key;

  if other_active + 1 > 10 then
    raise exception 'At most 10 active departments are allowed (% already active). '
      'Archive one before adding or restoring another.', other_active
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_department_cap on subteams;
create trigger trg_department_cap before insert or update of archived_at, parent_key on subteams
  for each row execute function enforce_department_cap();

-- ----------------------------------------------------- 4. archive guard (F-21)
create or replace function guard_department_archive() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  active_tasks int;
  open_proposals int;
  active_children int;
begin
  if new.archived_at is null or old.archived_at is not null then
    return new; -- not an archive transition (restore, or an ordinary edit)
  end if;

  -- Waits for any submit/promote/set-department holding the row FOR SHARE, so
  -- the counts below (fresh snapshots) include what they committed.
  perform 1 from subteams where key = old.key for update;

  select count(*) into active_children from subteams
    where parent_key = old.key and archived_at is null;
  if active_children > 0 then
    raise exception 'Cannot archive department "%": % subdepartment(s) are still active. Archive or move them first.',
      old.key, active_children using errcode = '23514';
  end if;

  -- Archived tasks keep their department as history and do not block (F-21).
  select count(*) into active_tasks from tasks
    where subteam_key = old.key and archived_at is null and state not in ('done', 'cancelled');
  if active_tasks > 0 then
    raise exception 'Cannot archive department "%": % task(s) still reference it. '
      'Move them to another department or finish them first.', old.key, active_tasks
      using errcode = '23514';
  end if;

  select count(*) into open_proposals from task_proposals
    where subteam_key = old.key and archived_at is null and state <> 'decided';
  if open_proposals > 0 then
    raise exception 'Cannot archive department "%": % unresolved proposal(s) still reference it. '
      'Promote, reject or move them first.', old.key, open_proposals
      using errcode = '23514';
  end if;
  return new;
end $fn$;

-- ------------------------------------------------------ 5. authority helpers
create or replace function department_authority(p_key text) returns text
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_dept subteams%rowtype;
  v_parent subteams%rowtype;
  v_gov boolean;
  v_dept_headed boolean;
  v_parent_headed boolean;
begin
  if v_uid is null or not is_active_member() then
    return null;
  end if;
  v_gov := has_role('president') or has_role('vicepresident');

  if p_key is null then
    -- Work not yet assigned to any department.
    if is_developer() then return 'developer'; end if;
    if v_gov then return 'governance_fallback'; end if;
    return null;
  end if;

  select * into v_dept from subteams where key = p_key;
  if not found then
    return case when is_developer() then 'developer' end;
  end if;
  if v_dept.parent_key is not null then
    select * into v_parent from subteams where key = v_dept.parent_key;
  end if;

  if v_dept.archived_at is null then
    if v_dept.lead_id = v_uid then
      return 'head';
    end if;
    if v_parent.key is not null and v_parent.archived_at is null and v_parent.lead_id = v_uid then
      return 'parent_head';
    end if;
  end if;

  if is_developer() then
    return 'developer';
  end if;

  if v_gov and v_dept.archived_at is null then
    v_dept_headed := exists (select 1 from members m where m.id = v_dept.lead_id and m.status = 'active');
    v_parent_headed := v_parent.key is not null and v_parent.archived_at is null
      and exists (select 1 from members m where m.id = v_parent.lead_id and m.status = 'active');
    if not v_dept_headed and not v_parent_headed then
      return 'governance_fallback';
    end if;
  end if;
  return null;
end $fn$;

comment on function department_authority(text) is
  'The one department-scoped authority rule (docs/backend-completion/PERMISSIONS.md §3.2): '
  'head | parent_head | developer | governance_fallback | NULL, for the calling session.';

create or replace function has_department_authority(p_key text) returns boolean
language sql stable security definer set search_path = public as $fn$
  select department_authority(p_key) is not null;
$fn$;

-- "Head of this department", directly or through its parent. Never true for a
-- Developer or a governance fallback on their own.
create or replace function is_department_head(p_key text) returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce(department_authority(p_key) in ('head', 'parent_head'), false);
$fn$;

-- -------------------------------------------------------- 6. task authority
create or replace function can_edit_task(p_task_id uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select is_active_member() and exists (
    select 1 from tasks t
    where t.id = p_task_id
      and t.archived_at is null
      and (t.owner_id = auth.uid() or has_department_authority(t.subteam_key))
  );
$fn$;

create or replace function can_review_proposal(p_proposal_id uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select is_active_member() and exists (
    select 1 from task_proposals p
    where p.id = p_proposal_id
      and has_department_authority(p.subteam_key)
  );
$fn$;

-- Same body as 20260117 except the owner-reassignment authority, which is now
-- department_authority() of the task's CURRENT department.
create or replace function guard_task_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_internal boolean;
begin
  v_internal := coalesce(current_setting('reqon.task_lifecycle_write', true), '') = 'on';

  if TG_OP = 'INSERT' then
    if new.state = 'done' then
      new.completed_at := now();
      new.completion_source := 'recorded';
    else
      new.completed_at := null;
      new.completion_source := null;
    end if;
    return new;
  end if;

  if new.state = 'done' and old.state is distinct from 'done' then
    new.completed_at := now();
    new.completion_source := 'recorded';
  elsif new.state = 'done' and old.state = 'done' then
    new.completed_at := old.completed_at;
    new.completion_source := old.completion_source;
  else
    new.completed_at := null;
    new.completion_source := null;
  end if;

  if not v_internal and old.archived_at is not null then
    raise exception 'This task is archived. Restore it before editing.' using errcode = '42501';
  end if;

  if not v_internal and (
    new.season_id is distinct from old.season_id
    or new.source_proposal is distinct from old.source_proposal
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.subteam_key is distinct from old.subteam_key
    or new.archived_at is distinct from old.archived_at
    or new.archived_by is distinct from old.archived_by
    or new.archive_reason is distinct from old.archive_reason
    or new.links_required is distinct from old.links_required
  ) then
    raise exception 'That field cannot be changed through an ordinary task edit.' using errcode = '42501';
  end if;

  if old.links_required and new.milestone_key is null then
    raise exception 'A task created from a proposal must keep its milestone.' using errcode = '23514';
  end if;

  if new.owner_id is distinct from old.owner_id then
    if not v_internal and not has_department_authority(old.subteam_key) then
      raise exception 'Only the Head of this task''s department (or, when it has none, the President or '
        'Vice President) or a Developer may reassign its owner.'
        using errcode = '42501';
    end if;
    if new.owner_id is not null and not exists (
      select 1 from members m where m.id = new.owner_id and m.status = 'active'
    ) then
      raise exception 'A task can only be assigned to an active member.' using errcode = '23514';
    end if;
  end if;

  if not v_internal and old.source_proposal is not null and old.due_date is not null and new.due_date is null then
    raise exception 'A promoted task''s deadline cannot be cleared. Archive or reopen it instead.'
      using errcode = '42501';
  end if;

  return new;
end $fn$;

create or replace function archive_task(p_task_id uuid, p_reason text default 'manual') returns tasks
language plpgsql security definer set search_path = public as $fn$
declare v_task tasks%rowtype;
begin
  if p_reason is not null and p_reason <> 'manual' then
    raise exception 'A task archived by a person is always a manual archive; only the scheduler archives automatically.'
      using errcode = '22023';
  end if;

  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task % does not exist', p_task_id using errcode = '23503';
  end if;
  if v_task.archived_at is not null then
    raise exception 'This task is already archived' using errcode = '22023';
  end if;
  if not has_department_authority(v_task.subteam_key) then
    raise exception 'Only the Head of this task''s department (or, when it has none, the President or '
      'Vice President) or a Developer may archive it'
      using errcode = '42501';
  end if;

  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks
  set archived_at = now(), archived_by = auth.uid(), archive_reason = 'manual'
  where id = p_task_id
  returning * into v_task;
  perform set_config('reqon.task_lifecycle_write', 'off', true);

  return v_task;
end $fn$;

create or replace function restore_task(p_task_id uuid) returns tasks
language plpgsql security definer set search_path = public as $fn$
declare v_task tasks%rowtype;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task % does not exist', p_task_id using errcode = '23503';
  end if;
  if v_task.archived_at is null then
    raise exception 'This task is not archived' using errcode = '22023';
  end if;
  if not (
    has_department_authority(v_task.subteam_key)
    or (is_active_member() and (has_role('president') or has_role('vicepresident')))
  ) then
    raise exception 'Only the Head of this task''s department, the President, the Vice President '
      'or a Developer may restore it'
      using errcode = '42501';
  end if;

  perform set_config('reqon.task_lifecycle_write', 'on', true);
  if v_task.state = 'done' then
    -- Restoring a Done task reopens it (ADR-0004), so the sweep cannot re-archive
    -- it at once; guard_task_edit() clears completed_at from this state change.
    update tasks
    set archived_at = null, archived_by = null, archive_reason = null, state = 'todo'
    where id = p_task_id
    returning * into v_task;
  else
    update tasks
    set archived_at = null, archived_by = null, archive_reason = null
    where id = p_task_id
    returning * into v_task;
  end if;
  perform set_config('reqon.task_lifecycle_write', 'off', true);

  return v_task;
end $fn$;

-- ------------------------------------------------------------------ 7. grants
revoke all on function department_authority(text) from public, anon;
revoke all on function has_department_authority(text) from public, anon;
grant execute on function department_authority(text) to authenticated, service_role;
grant execute on function has_department_authority(text) to authenticated, service_role;
revoke all on function guard_department_hierarchy() from public, anon, authenticated;
