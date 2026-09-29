-- =============================================================================
--  Backend completion Phase 2, step 5 of 7: assigning and moving work between
--  departments. (docs/backend-completion/PERMISSIONS.md §2.2, §2.3; findings
--  F-01, F-02.)
--
--  WHAT WAS WRONG.
--   F-01  guard_task_edit() refuses every tasks.subteam_key change outside an
--         internal command, and no command existed. Nobody (not even a
--         Developer) could give a task a department or move it. All 26 hosted
--         tasks have none, so Head authority and department views are inert,
--         and a department with active tasks could never be archived (R04, R11).
--   F-02  A proposal's department could only be changed by a Developer through
--         a generic edit. All 12 hosted proposals have none.
--
--  AFTER.
--   * set_task_department(task, key, reason): the ONLY way to set, change or
--     clear a task's department. A reason (1–500 chars) is required and is
--     recorded in the department_transferred activity row with from/to/actor.
--     Allowed for: Developer, President, Vice President (any active department,
--     or NULL = unassigned); a Head only when they hold Head authority over
--     BOTH the source and the target (their own departments/subdepartments).
--     Owner, links, dates and state are untouched. Archived tasks refuse (restore
--     first). Locks: the task FOR UPDATE, both departments FOR SHARE in key
--     order (so an archive of either serializes against the move).
--   * set_proposal_department(proposal, key, reason): for unresolved proposals
--     (not decided/archived). Allowed for: Developer, President, VP; the author
--     while the proposal is still 'open'; a Head with authority over both source
--     and target. Uses lock_proposal_for_command(). A legacy proposal that thereby
--     becomes complete loses legacy_incomplete through guard_proposal_edit()
--     (unchanged). The old Developer-only generic edit still exists and is
--     unchanged.
--   * The reason reaches the audit trail through a transaction-local setting
--     read by log_task_lifecycle() / log_proposal_decision(); both bodies are
--     otherwise identical to their previous versions (20260123 / 20260117).
--   * Index tasks(subteam_key): department filters, the archive guard, progress.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Close F-01/F-02 with explicit, authorized, audited commands.
--    Existing data  None written. No task or proposal is classified by this
--                   migration: which department each live task belongs to is a
--                   user decision (OD-3). The pack's suggestions are not applied.
--    Authorization  SECURITY DEFINER, search_path pinned, EXECUTE authenticated
--                   only. The protected-column rule of guard_task_edit() is
--                   unchanged for every other path.
--    Locking        FOR UPDATE on the task/proposal, FOR SHARE on departments.
--                   CREATE INDEX (small table; plain, not CONCURRENTLY, because
--                   migrations run in a transaction).
--    Rollback       DROP FUNCTION set_task_department, set_proposal_department;
--                   re-create the previous log bodies; DROP INDEX tasks_subteam.
--    Deploy order   After 20260126000200 (uses department_authority()).
-- =============================================================================

create index if not exists tasks_subteam on tasks (subteam_key) where subteam_key is not null;

-- The reason given to a department command, if any, for the audit row.
create or replace function change_reason_detail() returns jsonb
language sql stable set search_path = public as $fn$
  select case when nullif(current_setting('reqon.change_reason', true), '') is null then '{}'::jsonb
              else jsonb_build_object('reason', current_setting('reqon.change_reason', true)) end;
$fn$;
revoke all on function change_reason_detail() from public, anon, authenticated;

-- -------------------------------------------------------------- task command
create or replace function set_task_department(p_task_id uuid, p_subteam_key text, p_reason text)
returns tasks
language plpgsql security definer set search_path = public as $fn$
declare
  v_task tasks%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_governance boolean;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may move work between departments.' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'Say why the task changes department (1 to 500 characters).' using errcode = '23514';
  end if;

  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task % does not exist', p_task_id using errcode = '23503';
  end if;
  if v_task.archived_at is not null then
    raise exception 'This task is archived. Restore it before moving it.' using errcode = '22023';
  end if;
  if v_task.subteam_key is not distinct from p_subteam_key then
    return v_task;
  end if;

  perform 1 from subteams
   where key in (v_task.subteam_key, p_subteam_key)
   order by key
   for share;
  if p_subteam_key is not null
     and not exists (select 1 from subteams where key = p_subteam_key and archived_at is null) then
    raise exception 'A task can only move to an active department.' using errcode = '23514';
  end if;

  v_governance := is_developer() or has_role('president') or has_role('vicepresident');
  if not v_governance and not (
    v_task.subteam_key is not null and p_subteam_key is not null
    and coalesce(department_authority(v_task.subteam_key) in ('head', 'parent_head'), false)
    and coalesce(department_authority(p_subteam_key) in ('head', 'parent_head'), false)
  ) then
    raise exception 'Only the President, the Vice President or a Developer may assign or move this task. '
      'A Head may move work only between departments they head.' using errcode = '42501';
  end if;

  perform set_config('reqon.change_reason', v_reason, true);
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks set subteam_key = p_subteam_key where id = p_task_id returning * into v_task;
  perform set_config('reqon.task_lifecycle_write', 'off', true);
  perform set_config('reqon.change_reason', '', true);

  return v_task;
end $fn$;

-- ---------------------------------------------------------- proposal command
create or replace function set_proposal_department(p_proposal_id uuid, p_subteam_key text, p_reason text)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_allowed boolean;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may move a proposal between departments.' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'Say why the proposal changes department (1 to 500 characters).' using errcode = '23514';
  end if;
  if p_subteam_key is null then
    raise exception 'A proposal needs a department.' using errcode = '23502';
  end if;

  v := lock_proposal_for_command(p_proposal_id);
  if v.archived_at is not null or v.state = 'decided' then
    raise exception 'Only an unresolved proposal can move to another department.' using errcode = '22023';
  end if;
  if v.subteam_key is not distinct from p_subteam_key then
    return v;
  end if;

  perform 1 from subteams where key = p_subteam_key for share;
  if not exists (select 1 from subteams where key = p_subteam_key and archived_at is null) then
    raise exception 'A proposal can only belong to an active department.' using errcode = '23514';
  end if;

  v_allowed := is_developer() or has_role('president') or has_role('vicepresident')
    or (v.raised_by = auth.uid() and v.state = 'open')
    or (v.subteam_key is not null
        and coalesce(department_authority(v.subteam_key) in ('head', 'parent_head'), false)
        and coalesce(department_authority(p_subteam_key) in ('head', 'parent_head'), false));
  if not v_allowed then
    raise exception 'Only the author (before review), a Head of both departments, the President, '
      'the Vice President or a Developer may move this proposal.' using errcode = '42501';
  end if;

  perform set_config('reqon.change_reason', v_reason, true);
  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals set subteam_key = p_subteam_key where id = p_proposal_id returning * into v;
  perform set_config('reqon.proposal_write', 'off', true);
  perform set_config('reqon.change_reason', '', true);

  return v;
end $fn$;

revoke all on function set_task_department(uuid, text, text) from public, anon;
revoke all on function set_proposal_department(uuid, text, text) from public, anon;
grant execute on function set_task_department(uuid, text, text) to authenticated, service_role;
grant execute on function set_proposal_department(uuid, text, text) to authenticated, service_role;

-- ----------------------------------------- audit: carry the reason (bodies as before)
create or replace function log_task_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := case
    when current_setting('reqon.system_actor', true) = 'archive_scheduler' then null
    else auth.uid()
  end;
  actor_kind text := case
    when current_setting('reqon.system_actor', true) = 'archive_scheduler' then 'system'
    else 'member'
  end;
begin
  if new.state is distinct from old.state then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'state_changed',
      jsonb_build_object('title', new.title, 'from', old.state, 'to', new.state));
  end if;
  if new.owner_id is distinct from old.owner_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'owner_changed',
      jsonb_build_object('title', new.title, 'from', old.owner_id, 'to', new.owner_id));
  end if;
  if new.subteam_key is distinct from old.subteam_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'department_transferred',
      jsonb_build_object('title', new.title, 'from', old.subteam_key, 'to', new.subteam_key)
        || change_reason_detail());
  end if;
  if new.priority is distinct from old.priority then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'priority_changed',
      jsonb_build_object('title', new.title, 'from', old.priority, 'to', new.priority));
  end if;
  if new.due_date is distinct from old.due_date then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'deadline_changed',
      jsonb_build_object('title', new.title, 'from', old.due_date, 'to', new.due_date));
  end if;
  if new.starts_on is distinct from old.starts_on then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'starts_on_changed',
      jsonb_build_object('title', new.title, 'from', old.starts_on, 'to', new.starts_on));
  end if;
  if new.completed_at is distinct from old.completed_at then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text,
      case when new.completed_at is null then 'completion_cleared' else 'completed' end,
      jsonb_build_object('title', new.title, 'from', old.completed_at,
        'to', new.completed_at, 'source', new.completion_source));
  end if;
  if new.archived_at is distinct from old.archived_at then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text,
      case when new.archived_at is not null then 'archived' else 'restored' end,
      case when new.archived_at is not null then
        jsonb_build_object('title', new.title, 'reason', new.archive_reason,
          'from', old.archived_at, 'to', new.archived_at, 'actor_kind', actor_kind)
      else
        jsonb_build_object('title', new.title, 'reason', old.archive_reason,
          'from', old.archived_at, 'to', new.archived_at, 'actor_kind', actor_kind)
      end);
  end if;
  if new.milestone_key is distinct from old.milestone_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'milestone_changed',
      jsonb_build_object('title', new.title, 'from', old.milestone_key, 'to', new.milestone_key));
  end if;
  if new.section_id is distinct from old.section_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text,
      case when old.section_id is null then 'section_linked'
           when new.section_id is null then 'section_unlinked'
           else 'section_changed' end,
      jsonb_build_object('title', new.title, 'from', old.section_id, 'to', new.section_id,
        'milestone', new.milestone_key));
  end if;
  return new;
end
$fn$;

create or replace function log_proposal_decision() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.state is distinct from old.state then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'state_changed',
      jsonb_build_object('title', new.title, 'from', old.state, 'to', new.state));
  end if;
  if new.decision is distinct from old.decision then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'decision_updated',
      jsonb_build_object('title', new.title, 'had_value', old.decision is not null,
        'has_value', new.decision is not null));
  end if;
  if new.outcome is distinct from old.outcome then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'outcome_changed',
      jsonb_build_object('title', new.title, 'from', old.outcome, 'to', new.outcome));
  end if;
  if new.archived_at is distinct from old.archived_at then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text,
      case when new.archived_at is not null then 'archived' else 'reopened' end,
      jsonb_build_object('title', new.title,
        'reason', coalesce(new.archive_reason, old.archive_reason),
        'from', old.archived_at, 'to', new.archived_at));
  end if;
  if new.subteam_key is distinct from old.subteam_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'department_changed',
      jsonb_build_object('title', new.title, 'from', old.subteam_key, 'to', new.subteam_key)
        || change_reason_detail());
  end if;
  if new.due_date is distinct from old.due_date then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'deadline_changed',
      jsonb_build_object('title', new.title, 'from', old.due_date, 'to', new.due_date));
  end if;
  if new.priority is distinct from old.priority then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'priority_changed',
      jsonb_build_object('title', new.title, 'from', old.priority, 'to', new.priority));
  end if;
  if new.milestone_key is distinct from old.milestone_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'milestone_changed',
      jsonb_build_object('title', new.title, 'from', old.milestone_key, 'to', new.milestone_key));
  end if;
  if new.owner_id is distinct from old.owner_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'owner_changed',
      jsonb_build_object('title', new.title, 'from', old.owner_id, 'to', new.owner_id));
  end if;
  if old.legacy_incomplete and not new.legacy_incomplete then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'legacy_repaired',
      jsonb_build_object('title', new.title));
  end if;
  return new;
end
$fn$;
