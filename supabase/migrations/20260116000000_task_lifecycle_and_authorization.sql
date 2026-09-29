-- =============================================================================
--  Task priority, lifecycle, dates and scoped authorization (Phase 2).
--
--  WHAT WAS WRONG.
--   * `urgent` was a workflow STATE, not a priority — a task could never be
--     both "urgent" and "blocked" at once, and Board/Gantt/attention all
--     special-cased it as a seventh lane in a six-lane model.
--   * Nothing recorded when a task was actually completed. `done` rows from
--     before this migration have no reliable timestamp.
--   * Any signed-in roster member — including alumni before is_active_member()
--     existed, and including a Treasurer with no stake in the work — could
--     edit or delete ANY task (member_write FOR ALL, 20260101/20260108).
--   * A task could be typed directly onto the Board (task_insert required only
--     is_admin(), and the Gantt's "Add to Board" used exactly that path) —
--     "board work only exists because someone proposed it" was a rule the UI
--     followed voluntarily, never one the database enforced.
--   * There was no archive: a task was on the Board forever, or physically
--     deleted (task_delete), which erases its history with no undo.
--
--  AFTER.
--   * `task_priority` (normal|urgent) is a real column. Priority and state are
--     orthogonal: a task can be Blocked AND Urgent.
--   * `completed_at`/`completion_source` are server-set only (a BEFORE trigger
--     recomputes them from the state transition on every write, silently
--     discarding whatever a client sent). Legacy `done` rows are backfilled
--     from the newest matching activity row, or flagged 'migration_observed'
--     when no such row exists — never presented as an exact time.
--   * `can_edit_task()` replaces the blanket member_write policy: the active
--     owner, the active Head of the task's department, or a Developer.
--     `guard_task_edit()` (a BEFORE INSERT OR UPDATE trigger) then blocks
--     forging season_id/source_proposal/created_by/created_at/subteam_key/
--     archived_*/completion fields through that same UPDATE, and separately
--     authorizes an owner_id change (Head/Developer only, never the owner
--     re-assigning themselves) and refuses clearing a promoted task's
--     due_date.
--   * `task_insert` is dropped entirely: the only path onto the Board is
--     `promote_proposal()` (SECURITY DEFINER, unchanged from 20260110 —
--     Phase 3 re-scopes who may CALL it). `task_delete` is dropped entirely:
--     nothing in the product deletes a task; Developer maintenance happens
--     outside RLS (a service-role connection), not through this policy.
--   * `archived_at`/`archived_by`/`archive_reason` plus `archive_task()` /
--     `restore_task()` (Head-of-department or Developer only) replace
--     deletion as the way work leaves the Board. Restoring a Done task
--     reopens it to `todo` and clears `completed_at`, exactly as leaving
--     `done` normally does — it is not a special case, the same trigger
--     handles both. `archive_stale_done_tasks(p_now)` exists for the
--     Phase 11 scheduler; nothing may call it through PostgREST yet (no
--     browser timer, ever — see the grants at the end).
--   * `starts_on` is added with `starts_on <= due_date`; milestones gain the
--     matching `opens_on <= due_on`. `attention(p_season, p_today)` replaces
--     `v_attention`'s implicit `current_date`, so the client and the server
--     agree on "today" (ADR-0007, bug D2).
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Priority/state split, completion + archive lifecycle,
--                   scoped task authorization, explicit "today" for attention.
--    Existing data  `state='urgent'` rows become `priority='urgent'` first
--                   (while the value still exists to read), get one
--                   'priority_migrated' activity row each, THEN the enum swap
--                   maps any remaining 'urgent' state to 'todo'. Existing
--                   'done' rows are backfilled from the newest matching
--                   'state_changed to done' activity row, or flagged
--                   'migration_observed' with the migration's own now().
--                   Nothing is deleted or renamed; no row count changes.
--    New objects    task_priority enum; tasks.priority/starts_on/completed_at/
--                   completion_source/archived_at/archived_by/archive_reason;
--                   can_edit_task(), guard_task_edit() (+ trigger),
--                   log_task_change() (extends log_task_lifecycle in place),
--                   log_task_archive_change() (+ trigger), archive_task(),
--                   restore_task(), archive_stale_done_tasks(),
--                   attention(p_season, p_today); milestones window CHECK.
--    Locking        The task_state enum swap (create type, ALTER COLUMN ...
--                   TYPE ... USING, drop old type) takes an ACCESS EXCLUSIVE
--                   lock on `tasks` for the rewrite. At club scale (dozens of
--                   rows) this is sub-second. Adding nullable columns and
--                   CHECK constraints on `tasks`/`milestones` is likewise an
--                   ACCESS EXCLUSIVE but non-rewriting (no NOT NULL, no
--                   volatile default) lock, held only for the DDL statement.
--    Authorization  Every new function is SECURITY DEFINER (except attention,
--                   which is SECURITY INVOKER on purpose — it only reads
--                   through the caller's own is_member() read policies, same
--                   as v_attention did) with search_path pinned to public.
--                   EXECUTE is revoked from public/anon on every SECURITY
--                   DEFINER function; archive_stale_done_tasks additionally
--                   has EXECUTE revoked from `authenticated` — nothing a
--                   browser can reach may force an archive.
--    Rollback       DROP TRIGGER/FUNCTION for the new ones; DROP COLUMN for
--                   the new tasks/milestones columns; re-widen task_state to
--                   include 'urgent' via the same create-type/alter/drop-type
--                   dance in reverse. Priority information from converted
--                   rows would be lost on a real rollback — this migration is
--                   intended to ship together with the client that stops
--                   sending 'urgent' as a state (ADR-0004 consequence).
--    Deploy order   Apply the database first. The old client (Board.tsx with
--                   useDeleteTask, Gantt.tsx's "Add to Board") must not run
--                   against this schema — task_insert/task_delete no longer
--                   exist, so those paths would surface as permission errors
--                   the old UI does not explain. Deploy the Phase 2 frontend
--                   in the same release.
-- =============================================================================

-- ============================================================ 1. priority
do $$ begin
  create type task_priority as enum ('normal', 'urgent');
exception when duplicate_object then null; end $$;

alter table tasks add column if not exists priority task_priority not null default 'normal';

-- Capture which rows were urgent via a plain SELECT — not yet an UPDATE, so
-- trg_log_task_lifecycle (AFTER UPDATE, unmodified until section 7) never
-- fires here and never caches a query plan against the current task_state
-- type's OID. That distinction matters in a moment: the type swap below
-- drops that very OID, and a trigger function that had already compiled a
-- plan against it earlier in THIS session would fail with a "cache lookup
-- failed for type ..." error the next time it fired — proven the hard way
-- when this migration was first drafted (see the note by the priority
-- backfill UPDATE below, which is why it now runs AFTER the swap, not
-- before).
--
-- No `on commit drop`: this migration runs as separate autocommit
-- statements, not one wrapped transaction, so `on commit drop` would drop
-- the table at the end of THIS statement's own implicit commit — before the
-- later statements that read it even run. A plain temp table simply outlives
-- the migration's own connection instead, which is what every other use of
-- pg_temp in this codebase's tests also relies on.
create temp table legacy_urgent_tasks as
select id, season_id, title from tasks where state::text = 'urgent';

-- ============================================== 2. state enum: drop 'urgent'
-- Postgres cannot remove a value from an enum in place — expand/contract via
-- a second type, exactly like a column rename (database-migrations skill).
-- Every dependent object is dropped and recreated around the swap. Pure DDL
-- (CREATE TYPE, DROP VIEW/FUNCTION, ALTER COLUMN TYPE, DROP/ALTER TYPE) never
-- fires a row-level trigger, so none of this touches the plan-cache hazard
-- above either.
create type task_state_v2 as enum ('todo', 'wip', 'blocked', 'done', 'cancelled');

drop view if exists v_attention;
drop function if exists promote_proposal(uuid, uuid, uuid, date, task_state);

alter table tasks alter column state drop default;
alter table tasks alter column state type task_state_v2
  using (case when state::text = 'urgent' then 'todo' else state::text end)::task_state_v2;
alter table tasks alter column state set default 'todo';

drop type task_state;
alter type task_state_v2 rename to task_state;

-- NOW it is safe to UPDATE tasks for the first time this session: the
-- log_task_lifecycle() trigger that fires on it will compile its first plan
-- against the already-swapped, now-stable task_state type — see the comment
-- by legacy_urgent_tasks above for why this order matters.
update tasks set priority = 'urgent'
where id in (select id from pg_temp.legacy_urgent_tasks);

insert into activity (actor_id, season_id, entity, entity_id, action, detail)
select null, season_id, 'task', id::text, 'priority_migrated',
       jsonb_build_object('title', title, 'from_state', 'urgent', 'to_state', 'todo', 'priority', 'urgent')
from pg_temp.legacy_urgent_tasks;

comment on column tasks.state is
  'Workflow state only: todo/wip/blocked/done/cancelled. Urgency lives in '
  'priority (task_priority), not here — a task can be Blocked AND Urgent. '
  'A historical activity row reading to: "urgent" predates this migration; '
  'the UI labels it "Urgent (legacy state)", never rewritten (ADR-0004).';

comment on column tasks.priority is
  'normal | urgent. Orthogonal to state. Migrated once from the old '
  'state=''urgent'' value (20260116); every row converted that way also got '
  'one activity row, action=''priority_migrated''.';

-- promote_proposal(): same body as 20260110, referencing the (renamed)
-- task_state type. Authorization is unchanged this phase — Phase 3 re-scopes
-- who may call this to can_review_proposal() when task_proposals gains a
-- department column (ADR-0005).
create or replace function promote_proposal(
  p_proposal_id uuid,
  p_season_id   uuid,
  p_owner_id    uuid default null,
  p_due_date    date default null,
  p_state       task_state default 'todo'
) returns table (task tasks, created boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_proposal task_proposals%rowtype;
  v_task     tasks%rowtype;
begin
  if not is_admin() then
    raise exception 'Only the President, Vice President or a Developer may promote a proposal'
      using errcode = '42501';
  end if;

  select * into v_proposal from task_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'Proposal % does not exist', p_proposal_id using errcode = '23503';
  end if;

  if v_proposal.season_id <> p_season_id then
    raise exception 'That proposal belongs to a different season than the one you are working in. '
      'Switch to its season before promoting it.'
      using errcode = '22023';
  end if;

  select * into v_task from tasks where source_proposal = p_proposal_id limit 1;
  if found then
    return query select v_task, false;
    return;
  end if;

  insert into tasks (season_id, title, detail, owner_id, due_date, state, source_proposal, created_by)
  values (
    p_season_id, v_proposal.title, v_proposal.context,
    coalesce(p_owner_id, v_proposal.owner_id), p_due_date, p_state, p_proposal_id, auth.uid()
  )
  on conflict (source_proposal) where source_proposal is not null do nothing
  returning * into v_task;

  if not found then
    select * into v_task from tasks where source_proposal = p_proposal_id limit 1;
    return query select v_task, false;
    return;
  end if;

  update task_proposals set state = 'decided', decided_at = now() where id = p_proposal_id;

  return query select v_task, true;
end;
$fn$;

comment on function promote_proposal(uuid, uuid, uuid, date, task_state) is
  'Converts a proposal into a board task and marks the proposal decided, as '
  'one transaction. Idempotent: promoting an already-promoted proposal '
  'returns the existing task with created = false instead of erroring.';

revoke all on function promote_proposal(uuid, uuid, uuid, date, task_state) from public;
revoke all on function promote_proposal(uuid, uuid, uuid, date, task_state) from anon;
grant execute on function promote_proposal(uuid, uuid, uuid, date, task_state) to authenticated;

-- =========================================================== 3. dates
alter table tasks add column if not exists starts_on date null;

do $$ begin
  alter table tasks add constraint tasks_starts_before_due
    check (starts_on is null or due_date is null or starts_on <= due_date);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table milestones add constraint milestones_window_ordered
    check (opens_on is null or due_on is null or opens_on <= due_on);
exception when duplicate_object then null; end $$;

comment on column tasks.starts_on is
  'Optional. starts_on <= due_date when both are set (tasks_starts_before_due). '
  'A task with both renders as a period on the Gantt; legacy rows with '
  'neither, or only due_date, stay exactly as valid as before.';

-- ==================================================== 4. completion
alter table tasks add column if not exists completed_at timestamptz null;
alter table tasks add column if not exists completion_source text null;

do $$ begin
  alter table tasks add constraint tasks_completion_source_known
    check (completion_source is null or completion_source in ('recorded', 'migration_observed', 'activity_backfill'));
exception when duplicate_object then null; end $$;

comment on column tasks.completed_at is
  'Set only by guard_task_edit() from the state transition, never by a '
  'client-supplied value — see that function''s comment. Null unless state '
  'is currently ''done''.';
comment on column tasks.completion_source is
  '''recorded'': a real transition into done, seen by this trigger. '
  '''activity_backfill''/''migration_observed'': this migration''s own '
  'best-effort reconstruction of legacy done rows — see below. The UI must '
  'never present either backfilled kind as an exact completion time.';

-- Legacy 'done' rows: prefer the newest matching audit row over a guess.
update tasks t
set completed_at = a.at, completion_source = 'activity_backfill'
from (
  select distinct on (entity_id) entity_id, at
  from activity
  where entity = 'task' and action = 'state_changed' and detail ->> 'to' = 'done'
  order by entity_id, at desc
) a
where t.id::text = a.entity_id
  and t.state = 'done'
  and t.completed_at is null;

-- No matching activity row exists (predates the audit trail, or was already
-- done at import): the migration's own now() is the best available evidence,
-- and completion_source says so plainly rather than pretending precision.
update tasks
set completed_at = now(), completion_source = 'migration_observed'
where state = 'done' and completed_at is null;

-- ======================================================= 5. archive
alter table tasks add column if not exists archived_at timestamptz null;
alter table tasks add column if not exists archived_by uuid null references members(id) on delete set null;
alter table tasks add column if not exists archive_reason text null;

do $$ begin
  alter table tasks add constraint tasks_archive_reason_known
    check (archive_reason is null or archive_reason in ('auto_done_24h', 'manual'));
exception when duplicate_object then null; end $$;

create index if not exists tasks_archived on tasks (archived_at);

comment on column tasks.archived_at is
  'Archive is not deletion — the row and its history stay. Set only by '
  'archive_task()/restore_task()/archive_stale_done_tasks(); guard_task_edit() '
  'refuses any other write path that touches it.';

-- ================================================== 6. helpers and guard
-- can_edit_task(): the active owner, the active Head of the task's
-- department, or a Developer — and the task must not be archived. Mirrors
-- is_department_head()'s own pattern (Phase 1): SECURITY DEFINER re-reading
-- `tasks` directly is not the "recursive RLS helper query" the contract
-- warns against, because this function's owner bypasses RLS on that read —
-- the same pattern already proven safe by department_lifecycle_test.sql.
create or replace function can_edit_task(p_task_id uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select is_active_member() and exists (
    select 1 from tasks t
    where t.id = p_task_id
      and t.archived_at is null
      and (
        t.owner_id = auth.uid()
        or (t.subteam_key is not null and is_department_head(t.subteam_key))
        or is_developer()
      )
  );
$fn$;

revoke all on function can_edit_task(uuid) from public;
revoke all on function can_edit_task(uuid) from anon;
grant execute on function can_edit_task(uuid) to authenticated;

-- guard_task_edit(): the single BEFORE trigger that makes RLS's row-level
-- can_edit_task() check enough, even though RLS itself cannot restrict
-- individual columns (ADR-0003). Two independent jobs, kept in one function
-- so there is no ordering question between them:
--
--  1. Completion is computed here, unconditionally, on every insert/update —
--     never merely validated. Whatever a client sends in completed_at/
--     completion_source is discarded outright, not rejected as an error, so
--     there is no trigger-ordering hazard with a second trigger that also
--     wants to touch this column.
--  2. Everything else genuinely needs to REFUSE a forged write: season_id,
--     source_proposal, created_by, created_at, subteam_key and the three
--     archive_* columns are never touched by an ordinary edit, from anyone —
--     that list matches the field table's "never, through a generic edit"
--     row exactly, Developer included. archive_task()/restore_task() are the
--     only legitimate writers of the archive_* columns, and they mark their
--     own UPDATE with a transaction-local flag
--     (reqon.task_lifecycle_write) that a PostgREST client can never set —
--     set_config lives in pg_catalog, which PostgREST's RPC endpoint never
--     exposes, so this is not reachable from the API (the same is_local
--     technique Phase 1 used, and got the true/false scoping wrong twice
--     before landing on it — see department_lifecycle_test.sql's own notes).
--     owner_id may change, but only when the caller is the Head of the
--     task's (unchanged) department or a Developer — never the owner
--     reassigning themselves away — and only onto another active member.
--     A promoted task's due_date can never be cleared by an ordinary edit.
create or replace function guard_task_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_internal boolean;
  v_head boolean;
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

  -- UPDATE from here on.
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
  ) then
    raise exception 'That field cannot be changed through an ordinary task edit.' using errcode = '42501';
  end if;

  if new.owner_id is distinct from old.owner_id then
    v_head := old.subteam_key is not null and is_department_head(old.subteam_key);
    if not v_internal and not (v_head or is_developer()) then
      raise exception 'Only the Head of this department or a Developer may reassign this task''s owner.'
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

drop trigger if exists trg_guard_task_edit on tasks;
create trigger trg_guard_task_edit before insert or update on tasks
  for each row execute function guard_task_edit();

-- =========================================== 7. audit (extends 20260114)
-- log_task_lifecycle() is replaced in place (same function/trigger name) so
-- it now covers every dimension the contract names: status, owner, priority,
-- dates, completion and archive — one activity row per changed dimension,
-- exactly the pattern department_lifecycle_test.sql already proved for
-- subteams (20260115).
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
  return new;
end $fn$;

-- Trigger already exists (20260114); this leaves its name and firing time
-- (AFTER UPDATE) unchanged, only the function body grew.
drop trigger if exists trg_log_task_lifecycle on tasks;
create trigger trg_log_task_lifecycle after update on tasks
  for each row execute function log_task_lifecycle();

-- ============================================== 8. archive/restore/sweep
create or replace function archive_task(p_task_id uuid, p_reason text default 'manual') returns tasks
language plpgsql security definer set search_path = public as $fn$
declare v_task tasks%rowtype;
begin
  select * into v_task from tasks where id = p_task_id;
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
  set archived_at = now(), archived_by = auth.uid(),
      archive_reason = case when p_reason = 'auto_done_24h' then p_reason else 'manual' end
  where id = p_task_id
  returning * into v_task;
  perform set_config('reqon.task_lifecycle_write', 'off', true);

  return v_task;
end $fn$;

comment on function archive_task(uuid, text) is
  'Archives a task. Head-of-department or Developer only. Archive is not '
  'deletion: the row, and every activity row about it, stay.';

revoke all on function archive_task(uuid, text) from public;
revoke all on function archive_task(uuid, text) from anon;
grant execute on function archive_task(uuid, text) to authenticated;

create or replace function restore_task(p_task_id uuid) returns tasks
language plpgsql security definer set search_path = public as $fn$
declare v_task tasks%rowtype;
begin
  select * into v_task from tasks where id = p_task_id;
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
    -- Restoring a Done task explicitly reopens it — never restored as
    -- overdue-for-archival Done, which archive_stale_done_tasks() would just
    -- immediately re-archive (ADR-0004). guard_task_edit()'s completion
    -- logic clears completed_at from this same state change; the state
    -- transition itself is logged by log_task_lifecycle as normal, keeping
    -- the prior completion in activity history.
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

comment on function restore_task(uuid) is
  'Restores an archived task. Head-of-department or Developer only. A Done '
  'task is explicitly reopened to todo, clearing completed_at; anything else '
  'returns in its current state.';

revoke all on function restore_task(uuid) from public;
revoke all on function restore_task(uuid) from anon;
grant execute on function restore_task(uuid) to authenticated;

-- Idempotent sweep for the Phase 11 scheduler. Not reachable from PostgREST —
-- see the grants below: "never a browser timer" (source §15) is enforced by
-- there being no path from the browser to this function at all, not by a
-- client-side convention that a compromised or future screen could ignore.
create or replace function archive_stale_done_tasks(p_now timestamptz default now())
returns setof tasks
language plpgsql security definer set search_path = public as $fn$
begin
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  return query
    update tasks
    set archived_at = p_now, archived_by = null, archive_reason = 'auto_done_24h'
    where state = 'done'
      and archived_at is null
      and completed_at is not null
      and completed_at <= p_now - interval '24 hours'
    returning *;
  perform set_config('reqon.task_lifecycle_write', 'off', true);
end $fn$;

comment on function archive_stale_done_tasks(timestamptz) is
  'Archives every task done for >= 24h as of p_now, archived_by left null '
  '(nobody chose to). Idempotent: a second call touches nothing already '
  'archived. p_now defaults to now() in production; tests pass a fixed '
  'instant. Not granted to authenticated/anon — a scheduler (pg_cron, or its '
  'documented fallback, Phase 11) calls this as a role PostgREST never sees.';

revoke all on function archive_stale_done_tasks(timestamptz) from public;
revoke all on function archive_stale_done_tasks(timestamptz) from anon;
revoke all on function archive_stale_done_tasks(timestamptz) from authenticated;

-- ======================================================= 9. RLS
-- No task_insert policy: the only path onto the Board is promote_proposal()
-- (SECURITY DEFINER, bypasses RLS as the table owner — unchanged mechanism
-- from 20260108/20260110). No task_delete policy: nothing in the product
-- deletes a task; Developer maintenance is a service-role operation outside
-- RLS entirely, not a grant this policy set could name (ADR-0004).
drop policy if exists task_insert on tasks;
drop policy if exists task_update on tasks;
drop policy if exists task_delete on tasks;

create policy task_update on tasks for update to authenticated
  using (can_edit_task(id))
  with check (can_edit_task(id));

-- member_read (is_member(), 20260101) is unchanged: alumni keep read access
-- to active and archived work (ADR-0003's permission matrix), same as today.

-- =============================================== 10. attention(p_season, p_today)
-- Replaces v_attention's implicit current_date (bug D2, ADR-0007): the
-- client passes todayIso(), so the server's notion of "today" is the
-- reader's, not the database session's UTC day. SECURITY INVOKER (the
-- default — no `security definer` here) on purpose, exactly like
-- v_attention's security_invoker=on: it only reads through the caller's own
-- member_read policies on clause_status/clauses/tasks, same access as before.
create or replace function attention(p_season uuid, p_today date)
returns table (
  kind text, ref text, title text, owner_id uuid, season_id uuid,
  reason text, starred boolean, clause_key text
)
language sql stable set search_path = public as $fn$
  select 'clause'::text as kind, c.printed_ref as ref, c.body as title,
         cs.owner_id, cs.season_id,
         case when cs.state = 'blocked' then 'blocked'
              when c.criticality = 'blocking' then 'score-killer'
              when c.criticality = 'penalty' then 'penalty'
              else 'starred' end as reason,
         cs.starred,
         c.clause_key
  from clause_status cs
  join clauses c on c.clause_key = cs.clause_key
  where cs.season_id = p_season
    and cs.state not in ('compliant', 'verified', 'na')
    and (cs.starred or cs.state = 'blocked' or c.criticality in ('blocking', 'penalty'))
  union all
  select 'task', t.id::text, t.title, t.owner_id, t.season_id,
         case when t.state = 'blocked' then 'blocked'
              when t.due_date < p_today then 'overdue'
              else 'starred' end,
         t.starred,
         null::text
  from tasks t
  where t.season_id = p_season
    and t.archived_at is null
    and t.state not in ('done', 'cancelled')
    and (t.starred or t.state = 'blocked' or t.priority = 'urgent' or t.due_date < p_today);
$fn$;

comment on function attention(uuid, date) is
  'Replaces v_attention. Takes the reader''s own "today" (ADR-0007) instead '
  'of the database session''s current_date, so the client and the server '
  'never disagree about what is overdue (bug D2). Excludes archived tasks.';

revoke all on function attention(uuid, date) from public;
revoke all on function attention(uuid, date) from anon;
grant execute on function attention(uuid, date) to authenticated;
