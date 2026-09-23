-- =============================================================================
--  Atomic proposal promotion checks (20260110000000_atomic_proposal_promotion.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates happens inside
--  one block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations. The
--  result arrives as an "error" message that begins with
--      PROMOTION CHECKS PASSED   or   PROMOTION CHECKS FAILED
--  That "error" is the rollback doing its job.
--
--  What it proves:
--    * a member (not admin) cannot promote — 42501, nothing created
--    * an admin promoting a proposal from a DIFFERENT season is refused
--    * a normal promotion creates exactly one task and marks the proposal
--      decided, in the one call
--    * promoting the SAME proposal again is idempotent: no second task,
--      created = false, the first task's id comes back unchanged
--    * a caller that bypasses the function and inserts a second task for the
--      same source_proposal directly is refused by the unique index — the
--      database's own backstop, independent of the function
--
--  Real concurrency (two separate sessions promoting the same proposal at the
--  same instant) cannot be expressed inside one SQL session, so it is proven
--  separately by scripts/verify_db.sh, which races two actual psql processes
--  against a disposable Postgres container.
-- =============================================================================

create or replace function pg_temp.as_user(who uuid) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
end $fn$;

-- Accumulates one PASS/FAIL line (and, on failure, one failure summary) into
-- the two arrays the DO block below passes in and reassigns from the result —
-- PL/pgSQL has no nested procedures to close over local variables with, so
-- this is a plain INOUT function instead.
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
  pre     uuid := gen_random_uuid();  -- president: may promote
  mem     uuid := gen_random_uuid();  -- ordinary member: may not
  season  uuid;
  season2 uuid;
  prop    uuid;   -- the proposal under test
  prop2   uuid;   -- a second proposal, for the "bypass the function" check
  task1_id  uuid;
  task1_created boolean;
  task2_id  uuid;
  task2_created boolean;
  bad_row_count int;
  lines    text[] := '{}';
  failures text[] := '{}';
begin
  insert into auth.users (id, email) values
    (pre, 'promo-pre@roles.test'), (mem, 'promo-mem@roles.test');
  insert into members (id, full_name, role) values
    (pre, 'Promo President', 'President'), (mem, 'Promo Member', 'Chassis');
  insert into member_roles (member_id, role) values (pre, 'president');

  insert into seasons (label, is_current) values ('PROMO-TEST-A', false) returning id into season;
  insert into seasons (label, is_current) values ('PROMO-TEST-B', false) returning id into season2;

  insert into task_proposals (season_id, title, context, raised_by)
    values (season, 'Promote me', 'why it matters', mem) returning id into prop;
  insert into task_proposals (season_id, title, raised_by)
    values (season, 'Promote me too', mem) returning id into prop2;

  -- ----------------------------------------------- a member may not promote
  perform pg_temp.as_user(mem);
  begin
    perform promote_proposal(prop, season);
    select * into lines, failures from pg_temp.note(lines, failures, 'member cannot promote', false, 'no exception was raised');
  exception
    when insufficient_privilege then
      select * into lines, failures from pg_temp.note(lines, failures, 'member cannot promote', true);
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'member cannot promote', false, format('wrong error: %s %s', sqlstate, sqlerrm));
  end;
  perform 1 from tasks where source_proposal = prop;
  select * into lines, failures from pg_temp.note(lines, failures, 'member''s refused attempt created nothing', not found);

  -- ------------------------------------------ cross-season promotion refused
  perform pg_temp.as_user(pre);
  begin
    perform promote_proposal(prop, season2);
    select * into lines, failures from pg_temp.note(lines, failures, 'cross-season promotion is refused', false, 'no exception was raised');
  exception
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'cross-season promotion is refused', sqlstate = '22023',
        format('got %s %s', sqlstate, sqlerrm));
  end;
  perform 1 from tasks where source_proposal = prop;
  select * into lines, failures from pg_temp.note(lines, failures, 'refused cross-season attempt created nothing', not found);

  -- --------------------------------------------------- a normal, one-shot promotion
  select (t.task).id, t.created into task1_id, task1_created
    from promote_proposal(prop, season, mem, '2026-12-01'::date, 'wip') as t;
  select * into lines, failures from pg_temp.note(lines, failures, 'promotion returns created = true', task1_created is true);
  select * into lines, failures from pg_temp.note(lines, failures, 'promotion returns the new task id', task1_id is not null);

  select count(*) into bad_row_count from tasks where source_proposal = prop;
  select * into lines, failures from pg_temp.note(lines, failures, 'exactly one task exists for the proposal', bad_row_count = 1, format('found %s', bad_row_count));

  perform 1 from tasks
    where id = task1_id and season_id = season and title = 'Promote me'
      and detail = 'why it matters' and owner_id = mem and due_date = '2026-12-01'
      and state = 'wip' and created_by = pre;
  select * into lines, failures from pg_temp.note(lines, failures, 'the task carries the fields the promoter chose', found);

  perform 1 from task_proposals where id = prop and state = 'decided' and decided_at is not null;
  select * into lines, failures from pg_temp.note(lines, failures, 'the proposal is marked decided with a timestamp', found);

  -- ---------------------------------------- retry is idempotent, not a duplicate
  select (t.task).id, t.created into task2_id, task2_created
    from promote_proposal(prop, season) as t;
  select * into lines, failures from pg_temp.note(lines, failures, 'retrying promotion returns created = false', task2_created is false);
  select * into lines, failures from pg_temp.note(lines, failures, 'retrying promotion returns the SAME task id', task2_id = task1_id,
    format('first %s, second %s', task1_id, task2_id));

  select count(*) into bad_row_count from tasks where source_proposal = prop;
  select * into lines, failures from pg_temp.note(lines, failures, 'retry did not create a second task', bad_row_count = 1, format('found %s', bad_row_count));

  -- ------------------- the unique index refuses a bypass even outside the function
  insert into tasks (season_id, title, source_proposal) values (season, 'Sneaky duplicate', prop2);
  begin
    insert into tasks (season_id, title, source_proposal) values (season, 'Sneaky duplicate 2', prop2);
    select * into lines, failures from pg_temp.note(lines, failures, 'the unique index refuses a second task for one proposal', false, 'no exception was raised');
  exception
    when unique_violation then
      select * into lines, failures from pg_temp.note(lines, failures, 'the unique index refuses a second task for one proposal', true);
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'the unique index refuses a second task for one proposal', false,
        format('wrong error: %s %s', sqlstate, sqlerrm));
  end;

  -- ------------------------------------------------------------------- verdict
  if array_length(failures, 1) > 0 then
    raise exception E'PROMOTION CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'PROMOTION CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
