-- =============================================================================
--  archive_stale_done_tasks() boundary checks
--  (20260123000000_automation_audit_realtime_export.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything happens inside one DO
--  block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Boundaries use the owner-only archive_stale_done_tasks_at(p_now) seam.
--  The production function takes no clock and is tested separately below.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations. The
--  result arrives as an "error" message that begins with
--      TASK ARCHIVE SWEEP CHECKS PASSED   every check behaved as expected, or
--      TASK ARCHIVE SWEEP CHECKS FAILED   followed by the ones that did not.
-- =============================================================================

create or replace function pg_temp.note(
  inout lines text[], inout failures text[], label text, ok boolean, detail text default null
) returns record language plpgsql as $fn$
begin
  -- A NULL ok (an aggregate/ANY() over an empty or all-null set, most often)
  -- is not a pass. Without this coalesce, `if not ok` on a NULL silently
  -- skips the failures append while the label above still prints "FAIL" —
  -- a check that looks failed in the output but never counts as one.
  ok := coalesce(ok, false);
  lines := lines || format('%s  %s%s', case when ok then 'ok  ' else 'FAIL' end, label,
    case when detail is null then '' else ' — ' || detail end);
  if not ok then
    failures := failures || format('%s%s', label, case when detail is null then '' else ': ' || detail end);
  end if;
end $fn$;

do $test$
declare
  mem uuid := gen_random_uuid();
  season uuid;
  t_23h59 uuid;  -- done for 23h59m as of p_now: must NOT be archived
  t_24h   uuid;  -- done for exactly 24h as of p_now: MUST be archived (inclusive boundary)
  t_25h   uuid;  -- done for more than 24h: MUST be archived
  t_already uuid;  -- already archived before the sweep: untouched, no duplicate action
  t_left  uuid;  -- was done, left done before 24h elapsed: NOT archived
  t_redone uuid; -- done, left, done again: archival counts from the SECOND completion
  t_server uuid; -- proves the production no-argument command uses server time
  p_now timestamptz := '2026-09-24T12:00:00Z'::timestamptz;
  lines text[] := '{}';
  failures text[] := '{}';
  swept_ids uuid[];
  n_before int;
  n_after int;
  redone_completed_at timestamptz;
  archived_once_at timestamptz;
  archive_events_before int;
  archive_events_after int;
begin
  insert into auth.users (id, email) values (mem, 'sweep-mem@t.test');
  insert into members (id, full_name, status) values (mem, 'Sweep Member', 'active');
  insert into seasons (label, is_current) values ('SWEEP-TEST', false) returning id into season;

  insert into tasks (season_id, title, owner_id, state) values (season, 'T-23h59', mem, 'done') returning id into t_23h59;
  insert into tasks (season_id, title, owner_id, state) values (season, 'T-24h', mem, 'done') returning id into t_24h;
  insert into tasks (season_id, title, owner_id, state) values (season, 'T-25h', mem, 'done') returning id into t_25h;
  insert into tasks (season_id, title, owner_id, state) values (season, 'T-already', mem, 'done') returning id into t_already;
  -- Was done long enough ago to qualify, but left done BEFORE this sweep —
  -- completed_at is null now, so it must never be swept.
  insert into tasks (season_id, title, owner_id, state) values (season, 'T-left', mem, 'wip') returning id into t_left;
  insert into tasks (season_id, title, owner_id, state) values (season, 'T-redone', mem, 'done') returning id into t_redone;

  -- guard_task_edit() always recomputes completed_at/archived_* from the
  -- live transition or its own transaction-local flag — by design, an
  -- ordinary UPDATE can never backdate them (see the migration's own
  -- comment). Seeding "done N hours ago" fixtures needs the trigger off
  -- entirely, exactly like disabling a NOT NULL constraint temporarily to
  -- load historical data; nothing here is a path a client could reach.
  set constraints all immediate;
  alter table tasks disable trigger trg_guard_task_edit;
  update tasks set completed_at = p_now - interval '23 hours 59 minutes' where id = t_23h59;
  update tasks set completed_at = p_now - interval '24 hours' where id = t_24h;
  update tasks set completed_at = p_now - interval '25 hours' where id = t_25h;
  update tasks set completed_at = p_now - interval '48 hours', archived_at = p_now - interval '10 hours', archive_reason = 'manual'
    where id = t_already;
  update tasks set completed_at = p_now - interval '48 hours' where id = t_redone;
  alter table tasks enable trigger trg_guard_task_edit;

  -- From here on the trigger is back on, and T-redone's leave-then-redo goes
  -- through it for real: this is what actually proves "completed again ->
  -- a fresh completed_at, not the backdated one" (R43.1's last clause).
  update tasks set state = 'wip' where id = t_redone;               -- left done: completed_at cleared
  update tasks set state = 'done' where id = t_redone;               -- done again: fresh completed_at (now(), not p_now)
  select completed_at into redone_completed_at from tasks where id = t_redone;

  -- ---------------------------------------------------- first sweep at p_now
  select array_agg(id) into swept_ids from archive_stale_done_tasks_at(p_now);

  select * into lines, failures from pg_temp.note(lines, failures, 'done for 23h59m is NOT archived',
    not (t_23h59 = any(swept_ids)));
  select * into lines, failures from pg_temp.note(lines, failures, 'done for EXACTLY 24h IS archived (inclusive boundary)',
    t_24h = any(swept_ids));
  select * into lines, failures from pg_temp.note(lines, failures, 'done for more than 24h IS archived',
    t_25h = any(swept_ids));
  select * into lines, failures from pg_temp.note(lines, failures, 'already-archived task is not swept again',
    not (t_already = any(swept_ids)));
  select * into lines, failures from pg_temp.note(lines, failures, 'a task left done before 24h is not archived',
    not (t_left = any(swept_ids)));

  -- T-redone's fresh completed_at is real now(), most likely far more recent
  -- than p_now - 24h (p_now is fixed at a point in this test's own past/near
  -- future relative to the wall clock) — assert directly on the value rather
  -- than assuming it is or isn't in this particular sweep, since that
  -- depends on when this test happens to run.
  select * into lines, failures from pg_temp.note(lines, failures,
    'completing again after leaving done starts a fresh completed_at (not p_now-derived)',
    redone_completed_at > p_now - interval '24 hours' or redone_completed_at > now() - interval '1 minute');

  perform 1 from tasks where id = t_24h and archive_reason = 'auto_done_24h' and archived_by is null;
  select * into lines, failures from pg_temp.note(lines, failures,
    'the sweep records archive_reason = auto_done_24h with no archived_by (nobody chose to)', found);

  perform 1 from activity
   where entity = 'task' and entity_id = t_24h::text and action = 'archived'
     and actor_id is null and detail->>'actor_kind' = 'system'
     and detail->>'reason' = 'auto_done_24h';
  select * into lines, failures from pg_temp.note(lines, failures,
    'automatic archival records a system actor and reason without inventing a member', found);

  -- ------------------------------------------------- idempotent second sweep
  select count(*) into n_before from tasks where archived_at is not null and season_id = season;
  select archived_at into archived_once_at from tasks where id = t_24h;
  select count(*) into archive_events_before from activity
    where entity = 'task' and entity_id = t_24h::text and action = 'archived';
  perform archive_stale_done_tasks_at(p_now);
  select count(*) into n_after from tasks where archived_at is not null and season_id = season;
  select count(*) into archive_events_after from activity
    where entity = 'task' and entity_id = t_24h::text and action = 'archived';
  select * into lines, failures from pg_temp.note(lines, failures,
    'running the sweep again at the same p_now archives nothing new', n_after = n_before,
    format('%s archived before, %s after', n_before, n_after));
  perform 1 from tasks where id = t_24h and archived_at = archived_once_at;
  select * into lines, failures from pg_temp.note(lines, failures,
    'a repeat does not churn the existing archive timestamp', found);
  select * into lines, failures from pg_temp.note(lines, failures,
    'a repeat writes no duplicate archive event', archive_events_after = archive_events_before,
    format('%s before, %s after', archive_events_before, archive_events_after));

  -- --------------------------------------------- a later sweep catches T-left
  update tasks set state = 'done' where id = t_left;  -- sets completed_at = now() for real, via the trigger
  -- Backdate it to be stale as of p_now — same disable/enable as the initial
  -- fixtures: a second ordinary UPDATE while state stays 'done' would only
  -- have the trigger discard this and re-preserve the now() value.
  set constraints all immediate;
  alter table tasks disable trigger trg_guard_task_edit;
  update tasks set completed_at = p_now - interval '30 hours' where id = t_left;
  alter table tasks enable trigger trg_guard_task_edit;
  select array_agg(id) into swept_ids from archive_stale_done_tasks_at(p_now);
  select * into lines, failures from pg_temp.note(lines, failures,
    'a task done again is swept on ITS OWN completion, once stale enough', t_left = any(swept_ids));

  -- The production surface has no time argument and uses statement_timestamp().
  insert into tasks (season_id, title, owner_id, state)
    values (season, 'T-server-time', mem, 'done') returning id into t_server;
  set constraints all immediate;
  alter table tasks disable trigger trg_guard_task_edit;
  update tasks set completed_at = statement_timestamp() - interval '25 hours' where id = t_server;
  alter table tasks enable trigger trg_guard_task_edit;
  perform archive_stale_done_tasks();
  perform 1 from tasks where id = t_server and archived_at is not null;
  select * into lines, failures from pg_temp.note(lines, failures,
    'the no-argument production sweep archives against server time', found);

  -- --------------------------------------------------------- not a browser RPC
  select * into lines, failures from pg_temp.note(lines, failures,
    'the old caller-supplied-clock overload no longer exists',
    to_regprocedure('public.archive_stale_done_tasks(timestamptz)') is null);
  select * into lines, failures from pg_temp.note(lines, failures,
    'anon may not call the production sweep', not has_function_privilege('anon', 'archive_stale_done_tasks()', 'execute'));
  select * into lines, failures from pg_temp.note(lines, failures,
    'authenticated may not call the production sweep', not has_function_privilege('authenticated', 'archive_stale_done_tasks()', 'execute'));
  select * into lines, failures from pg_temp.note(lines, failures,
    'authenticated may not call the deterministic seam', not has_function_privilege('authenticated', 'archive_stale_done_tasks_at(timestamptz)', 'execute'));
  select * into lines, failures from pg_temp.note(lines, failures,
    'the trusted service-role fallback may call only the no-argument sweep',
    has_function_privilege('service_role', 'archive_stale_done_tasks()', 'execute')
      and not has_function_privilege('service_role', 'archive_stale_done_tasks_at(timestamptz)', 'execute'));

  -- ------------------------------------------------------------------- verdict
  if array_length(failures, 1) > 0 then
    raise exception E'TASK ARCHIVE SWEEP CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'TASK ARCHIVE SWEEP CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
