-- =============================================================================
--  Backend completion Phase 3, task side, step 2 of 4: dedicated blocker
--  explanations. (Requirement "dedicated blocker explanations, including
--  external blockers where no prerequisite task exists".)
--
--  WHAT WAS WRONG. The Blocked state carried no explanation. The Board said "No
--  blocker reason is recorded" and told people to write it in the description,
--  which is task content, not a blocker.
--
--  AFTER.
--   * tasks.blocked_reason (text, at most 500 characters, trimmed, never empty)
--     and tasks.blocked_since (server-stamped when the task ENTERS Blocked).
--   * ENTERING Blocked needs an explanation: a written reason (an external
--     blocker: a supplier, a sponsor, a decision) OR at least one prerequisite task
--     (task_dependencies). Leaving Blocked clears both columns. A reason on a task
--     that is not Blocked is refused, so it can never go stale silently.
--   * Tasks that are already Blocked keep their state (nothing is invented for
--     them); they are asked for an explanation only when someone edits it away.
--   * A reason travels through the ordinary task edit, so it is authorised exactly
--     like every other task field (can_edit_task) and audited: 'state_changed'
--     carries the reason, 'blocker_changed' records a rewrite.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Blocker explanations, in the same write as the state.
--    Existing data  Two nullable columns; nothing backfilled. Blocked tasks stay
--                   as they are.
--    Authorization  Unchanged: task_update RLS + guard_task_edit (re-created here
--                   with the extra rules; every earlier rule is kept verbatim).
--    Locking        ADD COLUMN nullable: metadata only; a CHECK on a new column.
--    Rollback       Drop the two columns and the constraint; restore the
--                   20260126000200 guard_task_edit and 20260126000400
--                   log_task_lifecycle.
--    Deploy order   After 20260128000000 (it reads task_dependencies).
-- =============================================================================

alter table tasks add column if not exists blocked_reason text null;
alter table tasks add column if not exists blocked_since timestamptz null;
do $c$ begin
  alter table tasks add constraint tasks_blocked_reason_length
    check (blocked_reason is null or length(blocked_reason) between 1 and 500);
exception when duplicate_object then null; end $c$;
do $c$ begin
  alter table tasks add constraint tasks_blocker_only_when_blocked
    check (state = 'blocked' or (blocked_reason is null and blocked_since is null));
exception when duplicate_object then null; end $c$;
comment on column tasks.blocked_reason is
  'Why the task is Blocked when no prerequisite task explains it (an external blocker). Cleared when the task leaves Blocked.';
comment on column tasks.blocked_since is
  'When the task entered Blocked (server-stamped). NULL for tasks that were already Blocked before this column existed.';

create or replace function guard_task_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_internal boolean;
begin
  v_internal := coalesce(current_setting('reqon.task_lifecycle_write', true), '') = 'on';

  if TG_OP = 'INSERT' then
    -- A task created blocked (an import) gets the stamp; an explanation is not
    -- demanded of history. Only ENTERING blocked later needs one.
    if new.state = 'blocked' then
      new.blocked_since := now();
    else
      new.blocked_reason := null;
      new.blocked_since := null;
    end if;
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


  -- ---------------------------------------------------------- blocker reason
  -- Entering Blocked needs an explanation: a written reason (an EXTERNAL
  -- blocker — a supplier, a decision, an event) or at least one prerequisite
  -- task. A task that was already Blocked before this rule existed may stay so
  -- with neither; it is only asked when someone edits the reason away.
  new.blocked_reason := nullif(btrim(coalesce(new.blocked_reason, '')), '');
  if length(new.blocked_reason) > 500 then
    raise exception 'A blocker reason can be at most 500 characters.' using errcode = '23514';
  end if;
  if new.state = 'blocked' then
    if old.state is distinct from 'blocked' then
      new.blocked_since := now();
      if new.blocked_reason is null and not exists (select 1 from task_dependencies d where d.task_id = new.id) then
        raise exception 'Say why this task is blocked: write the reason, or link the task it is waiting for.'
          using errcode = '23514';
      end if;
    else
      new.blocked_since := old.blocked_since;
      if old.blocked_reason is not null and new.blocked_reason is null
         and not exists (select 1 from task_dependencies d where d.task_id = new.id) then
        raise exception 'A blocked task must say why. Write the reason, link the task it is waiting for, or move it out of Blocked.'
          using errcode = '23514';
      end if;
    end if;
  else
    if old.state <> 'blocked' and new.blocked_reason is not null then
      raise exception 'A blocker reason only applies to a Blocked task.' using errcode = '23514';
    end if;
    -- Leaving Blocked closes the blocker.
    new.blocked_reason := null;
    new.blocked_since := null;
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
      jsonb_build_object('title', new.title, 'from', old.state, 'to', new.state)
        || case when new.state = 'blocked' and new.blocked_reason is not null
                then jsonb_build_object('reason', new.blocked_reason) else '{}'::jsonb end);
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
  if new.blocked_reason is distinct from old.blocked_reason and new.state = 'blocked' and old.state = 'blocked' then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'blocker_changed',
      jsonb_build_object('title', new.title, 'from', old.blocked_reason, 'to', new.blocked_reason));
  end if;
  return new;
end
$fn$;
