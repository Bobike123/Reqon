-- =============================================================================
--  Backend completion Phase 3, task side, step 3 of 4: a promoted task always
--  has a start date, whatever code created it. (PERMISSIONS.md §7 "Start on
--  creation"; phase-01 finding F-14.)
--
--  promote_proposal() / approve_and_promote() (20260127000200) already stamp
--  starts_on = least(the day the client sent, else the club's day, due_date).
--  This trigger is the safety net for any OTHER writer of a proposal-born task
--  (a service-role script, a future command): a row inserted with
--  links_required = true and no starts_on gets the same value.
--
--  Deliberately NOT applied to other rows. A task inserted without links_required
--  is an import or a legacy record (maintenance.reconcile_source_tasks): its start
--  date is what its source says, or NULL. Inventing a historical start date for
--  imported work would falsify the schedule, and imported work is not made to look
--  like proposal-approved work.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Guarantee the agreed automatic start for every creation path.
--    Existing data  Untouched (BEFORE INSERT only).
--    Authorization  Trigger function reads only NEW (no SECURITY DEFINER needed);
--                   not executable by API roles.
--    Locking        CREATE TRIGGER: SHARE ROW EXCLUSIVE on tasks, brief.
--    Rollback       DROP TRIGGER trg_task_default_start; DROP FUNCTION.
--    Deploy order   Any time after 20260128000100; independent of the client.
-- =============================================================================

create or replace function default_task_start() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if new.links_required and new.starts_on is null then
    new.starts_on := least((now() at time zone 'Europe/Copenhagen')::date, new.due_date);
  end if;
  return new;
end $fn$;
revoke all on function default_task_start() from public, anon, authenticated;

-- Named so that it sorts before trg_guard_task_edit (alphabetical order decides
-- BEFORE trigger order); the guard then sees the final row.
drop trigger if exists trg_a_default_task_start on tasks;
create trigger trg_a_default_task_start before insert on tasks
  for each row execute function default_task_start();
