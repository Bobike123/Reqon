-- =============================================================================
--  Phase 14 audit hardening: server-controlled archive provenance and actor
--  attribution (findings F14-01 and F14-02, docs/redesign/reviews/phase-14.md).
--
--  WHAT WAS WRONG.
--   F14-01  archive_task(p_task_id, p_reason) copied p_reason = 'auto_done_24h'
--           straight into archive_reason. A Head archiving unfinished work by
--           hand could therefore record it as "archived automatically after 24
--           hours Done" — the one reason only the scheduler may give. The row was
--           also read without a lock, so two concurrent archives (or an archive
--           racing archive_stale_done_tasks()) overwrote each other's stamp.
--           restore_task() had the same unlocked read.
--   F14-02  Phase 4 deferred D-1: clause_status.updated_by,
--           handover_notes.updated_by, meeting_template.updated_by and
--           meetings.created_by are whatever the client sends. Any active member
--           could attribute a compliance change or a handover note to someone else.
--
--  AFTER.
--   * archive_task() records 'manual' and nothing else. Its signature is kept
--     (the client passes 'manual'); any other reason is refused instead of being
--     silently rewritten, so a caller learns the value was not accepted. The
--     scheduler never used this function (it updates under its own lock), so
--     automatic archival is unaffected.
--   * archive_task() and restore_task() lock the task FOR UPDATE and check it
--     under that lock.
--   * stamp_actor_columns(): BEFORE INSERT OR UPDATE on the four tables. When a
--     signed-in session writes (auth.uid() is not null), the actor column is that
--     session's id, whatever was sent. meetings.created_by is fixed after insert.
--     Service-role and migration writes (auth.uid() is null) keep the supplied
--     value, so seeding and maintenance scripts behave exactly as before.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Close F14-01 and F14-02 without changing any client contract.
--    Existing data  None touched. Past attributions and archive reasons are not
--                   rewritten: nothing can tell a forged historical value from a
--                   genuine one, and inventing a replacement would be worse.
--    Authorization  Unchanged. archive_task/restore_task keep SECURITY DEFINER,
--                   search_path pinned, and the same Head-or-Developer rule. The
--                   stamping trigger function is SECURITY INVOKER; it grants
--                   nothing and only narrows what a write can say.
--    Locking        CREATE OR REPLACE FUNCTION (brief catalog locks); CREATE
--                   TRIGGER takes a SHARE ROW EXCLUSIVE lock on each of the four
--                   small tables for the length of the statement.
--    Rollback       Forward recovery: re-create the 20260116 bodies and drop the
--                   four trg_stamp_actor triggers. No data migration to undo.
--    Deploy order   After 20260123. Independent of the client: the current client
--                   already sends 'manual' and its own member id.
-- =============================================================================

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
  if not (
    is_active_member()
    and ((v_task.subteam_key is not null and is_department_head(v_task.subteam_key)) or is_developer())
  ) then
    raise exception 'Only the Head of this task''s department, or a Developer, may archive it'
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
    is_active_member()
    and ((v_task.subteam_key is not null and is_department_head(v_task.subteam_key)) or is_developer())
  ) then
    raise exception 'Only the Head of this task''s department, or a Developer, may restore it'
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

-- Which column names the writer, per table, is passed as the trigger argument.
create or replace function stamp_actor_columns() returns trigger
language plpgsql set search_path = public as $fn$
declare
  v_actor uuid := auth.uid();
  v_column text := tg_argv[0];
begin
  if v_actor is null then
    return new; -- service role, migrations, seed scripts: keep the supplied value
  end if;
  if v_column = 'created_by' then
    if tg_op = 'INSERT' then
      new.created_by := v_actor;
    else
      new.created_by := old.created_by; -- who created a meeting never changes
    end if;
  elsif v_column = 'updated_by' then
    new := jsonb_populate_record(new, jsonb_build_object('updated_by', v_actor));
  end if;
  return new;
end $fn$;

revoke all on function stamp_actor_columns() from public, anon, authenticated;

drop trigger if exists trg_stamp_actor on clause_status;
create trigger trg_stamp_actor before insert or update on clause_status
  for each row execute function stamp_actor_columns('updated_by');

drop trigger if exists trg_stamp_actor on handover_notes;
create trigger trg_stamp_actor before insert or update on handover_notes
  for each row execute function stamp_actor_columns('updated_by');

drop trigger if exists trg_stamp_actor on meeting_template;
create trigger trg_stamp_actor before insert or update on meeting_template
  for each row execute function stamp_actor_columns('updated_by');

drop trigger if exists trg_stamp_actor on meetings;
create trigger trg_stamp_actor before insert or update on meetings
  for each row execute function stamp_actor_columns('created_by');
