-- =============================================================================
--  Gantt linkage: audit task-to-milestone and task-to-section link changes
--  (Phase 8, ADR-0006, requirement R16.1).
--
--  WHAT WAS MISSING.
--   * Milestone window/deadline edits were already audited (log_milestone_change,
--     20260114). A task's link to a milestone or a section was not: log_task_lifecycle()
--     (20260116) records state, owner, priority, dates, completion and archive,
--     so linking, unlinking or relinking a task on the Gantt left no trace.
--
--  AFTER.
--   * One activity row per changed link dimension, written by the same trigger
--     and the same "one row per dimension" pattern as the rest of the task audit:
--       milestone_changed   from/to milestone key (either may be null)
--       section_linked      a task gained a section (detail: section id, milestone)
--       section_unlinked    a task lost its section (detail: section id it left)
--       section_changed     a task moved from one section to another
--     A relink that changes milestone AND section in one UPDATE (the only way the
--     consistency trigger allows it) therefore logs two rows, in one transaction.
--   * detail carries keys and ids only, plus the task title the other task events
--     already carry. No free text is added.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Extend log_task_lifecycle() in place with link events.
--    Existing data  None touched; a function body only. Past link changes were
--                   never recorded and are not reconstructed.
--    Authorization  Unchanged: SECURITY DEFINER, search_path pinned, trigger
--                   fires AFTER UPDATE. No new privilege.
--    Locking        CREATE OR REPLACE FUNCTION; the trigger is untouched.
--    Rollback       Forward recovery: re-create the 20260116 body.
--    Deploy order   After 20260120. Independent of the client (the events are
--                   simply extra activity rows).
-- =============================================================================
create or replace function log_task_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.state is distinct from old.state then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text, 'state_changed',
      jsonb_build_object('title', new.title, 'from', old.state, 'to', new.state));
  end if;
  if new.owner_id is distinct from old.owner_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text, 'owner_changed',
      jsonb_build_object('title', new.title, 'from', old.owner_id, 'to', new.owner_id));
  end if;
  if new.priority is distinct from old.priority then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text, 'priority_changed',
      jsonb_build_object('title', new.title, 'from', old.priority, 'to', new.priority));
  end if;
  if new.due_date is distinct from old.due_date or new.starts_on is distinct from old.starts_on then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text, 'dates_changed',
      jsonb_build_object('title', new.title,
        'starts_on', jsonb_build_object('from', old.starts_on, 'to', new.starts_on),
        'due_date', jsonb_build_object('from', old.due_date, 'to', new.due_date)));
  end if;
  if new.completed_at is distinct from old.completed_at and new.completed_at is not null then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text, 'completed',
      jsonb_build_object('title', new.title, 'completed_at', new.completed_at, 'source', new.completion_source));
  end if;
  if new.archived_at is distinct from old.archived_at then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text,
      case when new.archived_at is not null then 'archived' else 'restored' end,
      jsonb_build_object('title', new.title, 'reason', new.archive_reason));
  end if;

  -- Link changes (Phase 8).
  if new.milestone_key is distinct from old.milestone_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text, 'milestone_changed',
      jsonb_build_object('title', new.title, 'from', old.milestone_key, 'to', new.milestone_key));
  end if;
  if new.section_id is distinct from old.section_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text,
      case when old.section_id is null then 'section_linked'
           when new.section_id is null then 'section_unlinked'
           else 'section_changed' end,
      jsonb_build_object('title', new.title, 'from', old.section_id, 'to', new.section_id,
                         'milestone', new.milestone_key));
  end if;
  return new;
end $fn$;
