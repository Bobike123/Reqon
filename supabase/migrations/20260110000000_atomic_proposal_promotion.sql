-- =============================================================================
--  Atomic proposal promotion.
--
--  WHAT WAS WRONG. usePromoteProposal() (src/data/useProposals.ts) did this
--  from the browser:
--      check for an existing task with this source_proposal
--      -> insert the task
--      -> update the proposal to 'decided'
--  in three separate round trips. A dropped connection between the insert and
--  the proposal update left a task on the Board whose proposal still read
--  "Suggested" forever. Two admins clicking Promote within the same instant
--  both passed the "no existing task" check before either had inserted, so
--  both inserts landed: two board tasks for one proposal.
--
--  AFTER: one SECURITY DEFINER function, promote_proposal(), replaces all
--  three round trips. It is a single transaction — the insert and the
--  proposal update commit together or neither does — and it locks the
--  proposal row for its own duration, so a second, truly concurrent call for
--  the SAME proposal waits behind the first rather than racing it. The unique
--  partial index below is the second, independent backstop: even a caller
--  that bypassed this function (a script hitting PostgREST directly) cannot
--  create two tasks for one proposal — the database itself refuses the second
--  INSERT.
--
--  Run AFTER 20260109. Idempotent: safe to run twice.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Make promotion one race-safe transaction; add a DB-level
--                   "one task per proposal" backstop.
--    Existing data  Checked first: if any source_proposal already has more
--                   than one task, the migration raises and changes nothing.
--                   No existing row is rewritten.
--    New objects    Unique partial index tasks_source_proposal_unique;
--                   function promote_proposal(uuid,uuid,uuid,date,task_state).
--    Locking        CREATE UNIQUE INDEX (not CONCURRENTLY) holds a SHARE lock
--                   on `tasks` for the build: reads continue, writes to tasks
--                   wait. At runtime each call row-locks one proposal
--                   (FOR UPDATE) for its own transaction only.
--    Authorization  SECURITY DEFINER, search_path pinned to public; re-checks
--                   is_admin() itself. EXECUTE revoked from public/anon,
--                   granted to authenticated only.
--    Rollback       DROP FUNCTION promote_proposal(...); DROP INDEX
--                   tasks_source_proposal_unique. No data to restore — tasks
--                   it created are ordinary rows and stay. The client
--                   (usePromoteProposal) calls this RPC, so rolling the DB
--                   back without reverting the client breaks promotion.
--    Deploy order   Apply BEFORE deploying the frontend that calls
--                   rpc('promote_proposal').
-- =============================================================================

-- --------------------------------------------- 1. one task per proposal, ever
-- Detect duplicates before adding the constraint that would forbid them: an
-- index creation that failed on dirty data would say so in a way nobody
-- reading this migration a year from now could act on. Nothing here deletes a
-- row — a real duplicate must be resolved by a human, in a reviewed follow-up
-- migration, never guessed at here.
do $$
declare
  dup record;
  found_any boolean := false;
begin
  for dup in
    select source_proposal, count(*) as n
    from tasks
    where source_proposal is not null
    group by source_proposal
    having count(*) > 1
  loop
    found_any := true;
    raise warning 'tasks.source_proposal % has % duplicate rows', dup.source_proposal, dup.n;
  end loop;

  if found_any then
    raise exception 'Duplicate tasks.source_proposal values exist — resolve them by hand '
      '(decide which task is authoritative for each proposal, then null out or repoint the '
      'others'' source_proposal) before re-running this migration. Nothing was changed.';
  end if;
end $$;

create unique index if not exists tasks_source_proposal_unique
  on tasks (source_proposal) where source_proposal is not null;

comment on index tasks_source_proposal_unique is
  'At most one task per proposal. promote_proposal() relies on this for its '
  'ON CONFLICT clause; do not drop it without reading 20260110''s comments.';

-- ------------------------------------------------------------- 2. the command
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
  -- Authorization lives here, in the database, exactly matching what
  -- task_insert and proposal_update already require (20260108) — this
  -- function does both writes, so it repeats their shared check rather than
  -- letting SECURITY DEFINER quietly skip it.
  if not is_admin() then
    raise exception 'Only the President, Vice President or a Developer may promote a proposal'
      using errcode = '42501';
  end if;

  -- Locks the proposal for the rest of this transaction. A second call for
  -- the SAME proposal — genuinely concurrent, not just retried — blocks here
  -- until this one commits or rolls back, then sees the task this call made
  -- and returns it instead of racing to insert a second one.
  select * into v_proposal from task_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'Proposal % does not exist', p_proposal_id using errcode = '23503';
  end if;

  if v_proposal.season_id <> p_season_id then
    raise exception 'That proposal belongs to a different season than the one you are working in. '
      'Switch to its season before promoting it.'
      using errcode = '22023';
  end if;

  -- Idempotent: a retry (double-click, reload-and-click-again, a client that
  -- timed out on a response that actually landed) returns the task that
  -- already exists rather than erroring or duplicating it.
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
    -- Lost a race the FOR UPDATE lock above should already have prevented —
    -- kept as a second, independent guarantee. Return the winner's row.
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
