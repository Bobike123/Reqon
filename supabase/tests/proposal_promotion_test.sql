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
  hd      uuid := gen_random_uuid();  -- Head of the proposal's department
  hd2     uuid := gen_random_uuid();  -- Head of a different department
  dept    text;
  dept2   text;
  clause  text;
  ms      text := 'PROMO-MS1';
  lines    text[] := '{}';
  failures text[] := '{}';
begin
  insert into auth.users (id, email) values
    (pre, 'promo-pre@roles.test'), (mem, 'promo-mem@roles.test'),
    (hd, 'promo-hd@roles.test'), (hd2, 'promo-hd2@roles.test');
  insert into members (id, full_name, role) values
    (pre, 'Promo President', 'President'), (mem, 'Promo Member', 'Chassis'),
    (hd, 'Promo Head', 'Chassis'), (hd2, 'Promo Head Two', 'Chassis');
  insert into member_roles (member_id, role) values (pre, 'president');

  insert into seasons (label, is_current) values ('PROMO-TEST-A', false) returning id into season;
  insert into seasons (label, is_current) values ('PROMO-TEST-B', false) returning id into season2;
  insert into milestones (key, season_id, ordinal, name) values (ms, season, 1, 'Promo milestone');

  select key into dept from subteams where archived_at is null order by sort_order, key limit 1;
  select key into dept2 from subteams where archived_at is null and key <> dept order by sort_order, key limit 1;
  update subteams set lead_id = hd where key = dept;
  update subteams set lead_id = hd2 where key = dept2;
  select clause_key into clause from clauses order by clause_key limit 1;

  insert into task_proposals (season_id, title, context, raised_by, owner_id, subteam_key, due_date, priority, milestone_key)
    values (season, 'Promote me', 'why it matters', mem, mem, dept, '2026-12-01', 'urgent', ms) returning id into prop;
  insert into proposal_requirements (proposal_id, clause_key) values (prop, clause);
  insert into task_proposals (season_id, title, raised_by) values (season, 'Promote me too', mem) returning id into prop2;

  -- ------------------------------- only the department Head (or a Developer)
  perform pg_temp.as_user(mem);
  begin
    perform promote_proposal(prop, season);
    select * into lines, failures from pg_temp.note(lines, failures, 'a member cannot promote', false, 'no exception was raised');
  exception
    when insufficient_privilege then
      select * into lines, failures from pg_temp.note(lines, failures, 'a member cannot promote', true);
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'a member cannot promote', false, format('wrong error: %s %s', sqlstate, sqlerrm));
  end;
  perform pg_temp.as_user(pre);
  begin
    perform promote_proposal(prop, season);
    select * into lines, failures from pg_temp.note(lines, failures, 'the President alone cannot promote (ADR-0003)', false, 'no exception was raised');
  exception
    when insufficient_privilege then
      select * into lines, failures from pg_temp.note(lines, failures, 'the President alone cannot promote (ADR-0003)', true);
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'the President alone cannot promote (ADR-0003)', false, format('wrong error: %s %s', sqlstate, sqlerrm));
  end;
  perform pg_temp.as_user(hd2);
  begin
    perform promote_proposal(prop, season);
    select * into lines, failures from pg_temp.note(lines, failures, 'the Head of another department cannot promote', false, 'no exception was raised');
  exception
    when insufficient_privilege then
      select * into lines, failures from pg_temp.note(lines, failures, 'the Head of another department cannot promote', true);
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'the Head of another department cannot promote', false, format('wrong error: %s %s', sqlstate, sqlerrm));
  end;
  perform 1 from tasks where source_proposal = prop;
  select * into lines, failures from pg_temp.note(lines, failures, 'the three refused attempts created nothing', not found);

  -- ------------------------------------------ cross-season promotion refused
  perform pg_temp.as_user(hd);
  begin
    perform promote_proposal(prop, season2);
    select * into lines, failures from pg_temp.note(lines, failures, 'cross-season promotion is refused', false, 'no exception was raised');
  exception
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'cross-season promotion is refused', sqlstate = '22023',
        format('got %s %s', sqlstate, sqlerrm));
  end;

  -- --------------------------------------------------- a normal, one-shot promotion
  select (t.task).id, t.created into task1_id, task1_created
    from promote_proposal(prop, season, mem) as t;
  select * into lines, failures from pg_temp.note(lines, failures, 'promotion returns created = true', task1_created is true);
  select count(*) into bad_row_count from tasks where source_proposal = prop;
  select * into lines, failures from pg_temp.note(lines, failures, 'exactly one task exists for the proposal', bad_row_count = 1, format('found %s', bad_row_count));

  perform 1 from tasks
    where id = task1_id and season_id = season and title = 'Promote me'
      and detail = 'why it matters' and owner_id = mem and due_date = '2026-12-01'
      and state = 'todo' and priority = 'urgent' and subteam_key = dept and milestone_key = ms
      and created_by = hd and links_required and source_proposal = prop;
  select * into lines, failures from pg_temp.note(lines, failures, 'the task carries the proposal''s title, detail, department, owner, deadline, priority and milestone', found);

  select count(*) into bad_row_count from task_requirements where task_id = task1_id and clause_key = clause;
  select * into lines, failures from pg_temp.note(lines, failures, 'the requirement link was copied to the task', bad_row_count = 1);

  perform 1 from task_proposals
    where id = prop and state = 'decided' and outcome = 'approved' and decided_at is not null
      and archived_at is not null and archive_reason = 'promoted' and archived_by = hd;
  select * into lines, failures from pg_temp.note(lines, failures, 'the proposal is decided, approved and archived as promoted', found);

  -- ---------------------------------------- retry is idempotent, not a rewrite
  update tasks set title = 'Renamed after promotion' where id = task1_id;
  select (t.task).id, t.created into task2_id, task2_created
    from promote_proposal(prop, season) as t;
  select * into lines, failures from pg_temp.note(lines, failures, 'retrying promotion returns created = false', task2_created is false);
  select * into lines, failures from pg_temp.note(lines, failures, 'retrying promotion returns the SAME task id', task2_id = task1_id,
    format('first %s, second %s', task1_id, task2_id));
  perform 1 from tasks where id = task1_id and title = 'Renamed after promotion';
  select * into lines, failures from pg_temp.note(lines, failures, 'a retry does not rewrite the task from the old proposal snapshot', found);
  select count(*) into bad_row_count from tasks where source_proposal = prop;
  select * into lines, failures from pg_temp.note(lines, failures, 'retry did not create a second task', bad_row_count = 1, format('found %s', bad_row_count));

  -- authorization is re-checked on the idempotent path
  perform set_config('role', 'none', true);
  update subteams set lead_id = hd2 where key = dept;
  perform pg_temp.as_user(hd);
  begin
    perform promote_proposal(prop, season);
    select * into lines, failures from pg_temp.note(lines, failures, 'a former Head is refused even on a retry', false, 'no exception was raised');
  exception
    when insufficient_privilege then
      select * into lines, failures from pg_temp.note(lines, failures, 'a former Head is refused even on a retry', true);
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'a former Head is refused even on a retry', false, format('wrong error: %s %s', sqlstate, sqlerrm));
  end;

  -- ------------------- the unique index refuses a bypass even outside the function
  -- 20260116 (task_lifecycle_and_authorization) removed task_insert
  -- entirely, so no RLS-governed caller — pre included — can reach this
  -- INSERT at all any more; only a superuser/service-role connection can, in
  -- which case this backstop is the only thing left to matter. Reset to that
  -- (unset role/claims) before proving it, rather than testing it as `pre`
  -- and hitting an RLS refusal that has nothing to do with the unique index.
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
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
