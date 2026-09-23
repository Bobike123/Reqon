-- =============================================================================
--  Activity audit trail checks (20260114000000_activity_audit_trail.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates happens inside
--  one block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations. The
--  result arrives as an "error" message that begins with
--      ACTIVITY AUDIT CHECKS PASSED   or   ACTIVITY AUDIT CHECKS FAILED
--  That "error" is the rollback doing its job.
--
--  Writes as an ordinary member throughout (set_config below), the same way
--  the app itself would — proving the triggers fire from the normal client
--  path, not only from a superuser session.
-- =============================================================================

create or replace function pg_temp.note(
  inout lines text[], inout failures text[], label text, ok boolean, detail text default null
) returns record language plpgsql as $fn$
begin
  lines := lines || format('%s  %s%s', case when ok then 'ok  ' else 'FAIL' end, label,
    case when detail is null then '' else ' — ' || detail end);
  if not ok then
    failures := failures || format('%s%s', label, case when detail is null then '' else ': ' || detail end);
  end if;
end $fn$;

do $test$
declare
  dev      uuid := gen_random_uuid();
  mem      uuid := gen_random_uuid();
  season   uuid;
  task_id  uuid;
  prop_id  uuid;
  ms_key   text := 'AUDIT-MS1';
  spec_id  uuid;
  fin_id   uuid;
  n        bigint;
  row_     record;
  lines    text[] := '{}';
  failures text[] := '{}';
begin
  insert into auth.users (id, email) values (dev, 'audit-dev@roles.test'), (mem, 'audit-mem@roles.test');
  insert into members (id, full_name, role) values
    (dev, 'Audit Developer', 'Software'), (mem, 'Audit Member', 'Chassis');
  insert into member_roles (member_id, role) values (dev, 'developer');

  -- Not the current season: the reference-data seed already has one, and
  -- nothing here depends on is_current — only on a valid season_id.
  insert into seasons (label, edition, is_current) values ('Audit Season', 'AUDIT', false)
    returning id into season;
  insert into milestones (season_id, key, ordinal, name, max_points)
    values (season, ms_key, 1, 'Audit milestone', 50);
  insert into specs (season_id, clause_key, parameter, comparator, target, unit, sort_order)
    values (season, null, 'Audit width', 'max', 600, 'mm', 1)
    returning id into spec_id;

  -- Write as an ordinary developer for the rest of this test — the same
  -- session an app request would run under, not a superuser.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', dev::text, true);

  -- --- tasks: one state change -> exactly one activity row -------------------
  insert into tasks (season_id, title, state, created_by) values (season, 'Audit task', 'todo', dev)
    returning id into task_id;
  update tasks set state = 'wip' where id = task_id;

  select count(*) into n from activity where entity = 'task' and entity_id = task_id::text;
  select * into lines, failures from pg_temp.note(lines, failures,
    'a task state change writes exactly one activity row', n = 1, format('found %s', n));

  select * into row_ from activity where entity = 'task' and entity_id = task_id::text limit 1;
  select * into lines, failures from pg_temp.note(lines, failures,
    'the task row names the actor, action and transition',
    row_.actor_id = dev and row_.action = 'state_changed'
      and row_.detail->>'from' = 'todo' and row_.detail->>'to' = 'wip',
    row_.action || ' ' || row_.detail::text);

  -- --- task_proposals: decision ------------------------------------------------
  insert into task_proposals (season_id, title, raised_by) values (season, 'Audit proposal', dev)
    returning id into prop_id;
  update task_proposals set state = 'decided', decision = 'Approved for audit' where id = prop_id;

  select count(*) into n from activity where entity = 'proposal' and entity_id = prop_id::text;
  select * into lines, failures from pg_temp.note(lines, failures,
    'a proposal decision writes exactly one activity row', n = 1, format('found %s', n));

  -- --- member_roles: grant and revoke ------------------------------------------
  -- `mem`, not `dev`: dev is the actor throughout this test (can_manage_roles()
  -- requires it), so dev must keep its own developer role the whole time.
  insert into member_roles (member_id, role) values (mem, 'treasurer');
  delete from member_roles where member_id = mem and role = 'treasurer';

  select count(*) into n from activity
    where entity = 'member_role' and entity_id = mem::text and action = 'role_granted';
  select * into lines, failures from pg_temp.note(lines, failures,
    'granting a role writes a role_granted row', n = 1, format('found %s', n));

  select count(*) into n from activity
    where entity = 'member_role' and entity_id = mem::text and action = 'role_revoked';
  select * into lines, failures from pg_temp.note(lines, failures,
    'revoking a role writes a role_revoked row', n = 1, format('found %s', n));

  -- --- milestones: configuration change ----------------------------------------
  update milestones set due_on = '2027-01-15' where key = ms_key and season_id = season;

  select count(*) into n from activity where entity = 'milestone' and entity_id = ms_key;
  select * into lines, failures from pg_temp.note(lines, failures,
    'a milestone date change writes exactly one activity row', n = 1, format('found %s', n));

  -- A save that changes nothing must not write a second row.
  update milestones set due_on = '2027-01-15' where key = ms_key and season_id = season;
  select count(*) into n from activity where entity = 'milestone' and entity_id = ms_key;
  select * into lines, failures from pg_temp.note(lines, failures,
    're-saving the same value writes nothing new', n = 1, format('found %s', n));

  -- --- specs: measurement --------------------------------------------------------
  update specs set measured = 612, measured_by = dev, measured_at = now() where id = spec_id;

  select count(*) into n from activity where entity = 'spec' and entity_id = spec_id::text;
  select * into lines, failures from pg_temp.note(lines, failures,
    'recording a measurement writes exactly one activity row', n = 1, format('found %s', n));

  -- --- finance_entries: create, edit, delete --------------------------------------
  insert into finance_entries (season_id, entry_date, kind, description, amount_cents, created_by)
    values (season, current_date, 'expense', 'Audit part', 1234, dev)
    returning id into fin_id;
  update finance_entries set amount_cents = 4321 where id = fin_id;
  delete from finance_entries where id = fin_id;

  select count(*) into n from activity where entity = 'finance_entry' and entity_id = fin_id::text;
  select * into lines, failures from pg_temp.note(lines, failures,
    'create + edit + delete write exactly three activity rows', n = 3, format('found %s', n));

  -- --- no secret material anywhere in this test's own activity rows --------------
  select count(*) into n from activity
    where (actor_id = dev or entity_id in (task_id::text, prop_id::text, ms_key, spec_id::text, fin_id::text))
      and detail::text ~* '(password|token|secret|jwt|bearer|service_role|anon_key)';
  select * into lines, failures from pg_temp.note(lines, failures,
    'no activity row from this test contains secret-shaped material', n = 0, format('%s suspect row(s)', n));

  -- --- the RLS gap this migration closes: a member can no longer write activity directly
  begin
    insert into activity (entity, entity_id, action) values ('task', 'forged', 'state_changed');
    select * into lines, failures from pg_temp.note(lines, failures,
      'a member cannot INSERT into activity directly', false, 'insert succeeded');
  exception when insufficient_privilege then
    select * into lines, failures from pg_temp.note(lines, failures,
      'a member cannot INSERT into activity directly', true);
  end;

  begin
    update activity set action = 'forged' where entity = 'task' and entity_id = task_id::text;
    get diagnostics n = row_count;
    select * into lines, failures from pg_temp.note(lines, failures,
      'a member cannot UPDATE an activity row directly', n = 0, format('%s row(s) changed', n));
  exception when insufficient_privilege then
    select * into lines, failures from pg_temp.note(lines, failures,
      'a member cannot UPDATE an activity row directly', true);
  end;

  -- ------------------------------------------------------------------- verdict
  if array_length(failures, 1) > 0 then
    raise exception E'ACTIVITY AUDIT CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'ACTIVITY AUDIT CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
