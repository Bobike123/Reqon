-- =============================================================================
--  Task lifecycle, priority, dates and scoped authorization checks
--  (20260116000000_task_lifecycle_and_authorization.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything happens inside one DO
--  block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations. The
--  result arrives as an "error" message that begins with
--      TASK AUTHORIZATION CHECKS PASSED   every check behaved as expected, or
--      TASK AUTHORIZATION CHECKS FAILED   followed by the ones that did not.
--
--  What this file does NOT cover:
--   * the 24h archive-sweep boundary (archive_stale_done_tasks with a fixed
--     p_now) — see task_archive_sweep_test.sql for that, kept separate
--     because it needs its own deterministic-clock fixture set;
--   * the legacy-data backfill (state='urgent' -> priority='urgent', done
--     rows getting completed_at/completion_source) — that only happens once,
--     at migration time, on rows that predate this file's own fixtures, and
--     is proven directly against a disposable container in
--     scripts/verify_db.sh instead;
--   * promotion authority (promote_proposal's is_admin() check) — unchanged
--     this phase, already covered by proposal_promotion_test.sql.
-- =============================================================================

-- Same "always reset, every outcome" pg_temp.attempt() as
-- department_lifecycle_test.sql: this file also interleaves plain
-- admin-privileged setup between attempt() calls.
create or replace function pg_temp.attempt(who uuid, stmt text, kind text default 'write')
returns text language plpgsql as $fn$
declare
  n bigint;
  result text;
begin
  if who is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', who, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', who::text, true);
  end if;

  begin
    if kind = 'read' then
      execute stmt into n;
    else
      execute stmt;
      get diagnostics n = row_count;
    end if;
    result := case when n > 0 then 'ALLOWED' else 'DENIED' end;
  exception
    when insufficient_privilege then result := 'DENIED';
    when others then result := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;

  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return result;
end $fn$;

create or replace function pg_temp.note(
  inout lines text[], inout failures text[], label text, ok boolean, detail text default null
) returns record language plpgsql as $fn$
begin
  -- A NULL ok is not a pass — see task_archive_sweep_test.sql's identical
  -- helper for why this coalesce matters (it silently under-counted
  -- failures without it, caught while drafting that file).
  ok := coalesce(ok, false);
  lines := lines || format('%s  %s%s', case when ok then 'ok  ' else 'FAIL' end, label,
    case when detail is null then '' else ' — ' || detail end);
  if not ok then
    failures := failures || format('%s%s', label, case when detail is null then '' else ': ' || detail end);
  end if;
end $fn$;

do $test$
declare
  pre    uuid := gen_random_uuid();  -- president, not a Head
  headx  uuid := gen_random_uuid();  -- active member, Head of dept X (TA_X) and Y (TA_Y)
  heady  uuid := gen_random_uuid();  -- active member, Head of dept Z only (TA_Z)
  owner1 uuid := gen_random_uuid();  -- active member, owns tasks, no headship
  owner2 uuid := gen_random_uuid();
  tre    uuid := gen_random_uuid();  -- treasurer alone: no task authority
  dev    uuid := gen_random_uuid();  -- developer
  alum   uuid := gen_random_uuid();  -- retires mid-test
  season uuid;
  t_own       uuid;  -- owned by owner1, dept TA_X, headed by headx
  t_other_dep uuid;  -- owned by owner2, dept TA_Z, headed by heady
  t_head_owns uuid;  -- owned by headx himself, dept TA_Z (a department headx does NOT head)
  t_no_dept   uuid;  -- owner1's task, no department
  t_alum      uuid;  -- owned by alum from the start (INSERT, not a guarded UPDATE)
  t_promoted  uuid;  -- owner1's task, dept TA_X, source_proposal set, has a due_date
  t_plain_due uuid;  -- owner1's task, dept TA_X, due_date but no source_proposal
  prop uuid;
  got text;
  lines text[] := '{}';
  failures text[] := '{}';
  before_id text;
  scratch_ts timestamptz;
  scratch_ts2 timestamptz;
  scratch_task tasks%rowtype;
  c record;
begin
  insert into auth.users (id, email) values
    (pre,'ta-pre@t.test'),(headx,'ta-headx@t.test'),(heady,'ta-heady@t.test'),
    (owner1,'ta-o1@t.test'),(owner2,'ta-o2@t.test'),(tre,'ta-tre@t.test'),
    (dev,'ta-dev@t.test'),(alum,'ta-alum@t.test');
  insert into members (id, full_name, status) values
    (pre,'TA President','active'),(headx,'TA Head X','active'),(heady,'TA Head Y','active'),
    (owner1,'TA Owner 1','active'),(owner2,'TA Owner 2','active'),(tre,'TA Treasurer','active'),
    (dev,'TA Developer','active'),(alum,'TA Alum','active');
  insert into member_roles (member_id, role) values
    (pre,'president'),(tre,'treasurer'),(dev,'developer');

  -- Free room under the 10-active department cap (20260115) before adding
  -- three fixture departments, same pattern roles_rls_test.sql already uses.
  update subteams set archived_at = now(), archive_reason = 'task-auth-test'
  where key in (
    select s.key from subteams s where s.archived_at is null
      and not exists (select 1 from tasks t where t.subteam_key = s.key and t.state not in ('done','cancelled'))
    order by s.key limit 3
  );
  insert into subteams (key, name, book_section, lead_id) values
    ('TA_X', 'TA Dept X', 'X', headx),
    ('TA_Y', 'TA Dept Y', 'Y', headx),
    ('TA_Z', 'TA Dept Z', 'Z', heady);

  insert into seasons (label, is_current) values ('TASK-AUTH-TEST', false) returning id into season;
  insert into task_proposals (season_id, title, raised_by) values (season, 'TA prop', owner1) returning id into prop;

  -- Fixtures inserted as the migration owner (bypasses RLS, like every other
  -- test file's setup) — task_insert has no policy at all for authenticated
  -- now, so ordinary fixture rows must be seeded this way regardless.
  insert into tasks (season_id, title, owner_id, subteam_key, due_date)
    values (season, 'Owned by owner1 in X', owner1, 'TA_X', '2026-10-01') returning id into t_own;
  insert into tasks (season_id, title, owner_id, subteam_key, due_date)
    values (season, 'Owned by owner2 in Z', owner2, 'TA_Z', '2026-10-05') returning id into t_other_dep;
  insert into tasks (season_id, title, owner_id, subteam_key)
    values (season, 'Headx owns this one in Z', headx, 'TA_Z') returning id into t_head_owns;
  insert into tasks (season_id, title, owner_id)
    values (season, 'No department', owner1) returning id into t_no_dept;
  -- owner_id is only guarded on UPDATE (guard_task_edit returns early for
  -- INSERT) — owned by alum from creation, not via a later reassignment, so
  -- this fixture needs no authorized actor to set it up.
  insert into tasks (season_id, title, owner_id)
    values (season, 'Alum''s task', alum) returning id into t_alum;
  insert into tasks (season_id, title, owner_id, subteam_key, due_date, source_proposal)
    values (season, 'Promoted, has a deadline', owner1, 'TA_X', '2026-11-01', prop) returning id into t_promoted;
  insert into tasks (season_id, title, owner_id, subteam_key, due_date)
    values (season, 'Plain task with a due date', owner1, 'TA_X', '2026-11-05') returning id into t_plain_due;

  -- ========================================================= ROLE MATRIX
  -- Mirrors ADR-0003's operational permission matrix and source §41.
  create temp table checks (n serial, label text, who uuid, stmt text, kind text, expected text) on commit drop;
  insert into checks (label, who, stmt, kind, expected) values
    ('owner1 edits own task',                    owner1, format('update tasks set detail = ''mine'' where id = %L', t_own), 'write', 'ALLOWED'),
    ('owner2 cannot edit owner1''s task',         owner2, format('update tasks set detail = ''nope'' where id = %L', t_own), 'write', 'DENIED'),
    ('headx edits a task in dept X (not owner)',  headx,  format('update tasks set detail = ''head edit'' where id = %L', t_own), 'write', 'ALLOWED'),
    ('headx cannot edit a task in dept Z',        headx,  format('update tasks set detail = ''nope'' where id = %L', t_other_dep), 'write', 'DENIED'),
    ('headx CAN edit a task he owns in dept Z',   headx,  format('update tasks set detail = ''own in other dept'' where id = %L', t_head_owns), 'write', 'ALLOWED'),
    ('heady heads Z, edits owner2''s task there', heady,  format('update tasks set detail = ''heady edit'' where id = %L', t_other_dep), 'write', 'ALLOWED'),
    ('treasurer alone cannot edit any task',      tre,    format('update tasks set detail = ''nope'' where id = %L', t_own), 'write', 'DENIED'),
    -- Role hierarchy (20260130000000): the President ranks above the Head and edits any department's task.
    ('president (not a Head) edits it too',       pre,    format('update tasks set detail = ''president'' where id = %L', t_own), 'write', 'ALLOWED'),
    -- Backend completion Phase 2 (PERMISSIONS §1): a task with NO department is
    -- unassigned work, which the President/VP may act on as the governance
    -- fallback (to classify it). This row used to expect DENIED; since the role
    -- hierarchy (20260130000000) the President acts in every department.
    ('president acts on an unassigned task (governance fallback)', pre, format('update tasks set detail = ''pres tries'' where id = %L', t_no_dept), 'write', 'ALLOWED'),
    ('developer edits any task',                  dev,    format('update tasks set detail = ''dev edit'' where id = %L', t_other_dep), 'write', 'ALLOWED'),
    ('nobody may INSERT a task directly (owner1)',owner1, format('insert into tasks (season_id, title) values (%L, ''sneaky'')', season), 'write', 'DENIED'),
    ('nobody may INSERT a task directly (dev)',   dev,    format('insert into tasks (season_id, title) values (%L, ''sneaky dev'')', season), 'write', 'DENIED'),
    ('nobody may DELETE a task directly (dev)',   dev,    format('delete from tasks where id = %L', t_no_dept), 'write', 'DENIED'),
    ('nobody may DELETE a task directly (pres)',  pre,    format('delete from tasks where id = %L', t_no_dept), 'write', 'DENIED');

  for c in select * from checks order by n loop
    got := pg_temp.attempt(c.who, c.stmt, c.kind);
    select * into lines, failures from pg_temp.note(lines, failures, c.label, got = c.expected,
      format('expected %s, got %s', c.expected, got));
  end loop;

  -- ============================================== ALUMNI LOSE EDIT AUTHORITY
  got := pg_temp.attempt(alum, format('update tasks set detail = ''alum edits own'' where id = %L', t_alum), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'active alum edits own task', got = 'ALLOWED', got);

  update members set status = 'alumni' where id = alum;
  got := pg_temp.attempt(alum, format('update tasks set detail = ''alum edits after retiring'' where id = %L', t_alum), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'retired alumnus denied on their former task', got = 'DENIED', got);
  update members set status = 'active' where id = alum;

  -- ==================================================== OWNER REASSIGNMENT
  got := pg_temp.attempt(owner1, format('update tasks set owner_id = %L where id = %L', owner2, t_own), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'owner cannot reassign their own task''s owner', got = 'DENIED', got);

  got := pg_temp.attempt(headx, format('update tasks set owner_id = %L where id = %L', owner2, t_own), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'Head reassigns owner within their department', got = 'ALLOWED', got);
  -- Reset through the same authorized actor — a plain superuser statement
  -- would hit the same owner_id-reassignment guard as anyone else, since
  -- that check runs regardless of who is connected, not just under RLS.
  perform pg_temp.attempt(headx, format('update tasks set owner_id = %L where id = %L', owner1, t_own), 'write');

  update members set status = 'alumni' where id = owner2;
  got := pg_temp.attempt(headx, format('update tasks set owner_id = %L where id = %L', owner2, t_own), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'Head cannot assign an inactive member as owner', got != 'ALLOWED', got);
  update members set status = 'active' where id = owner2;

  -- ========================================== PROTECTED-COLUMN ATTACKS
  -- Every one of these is attempted by headx, who DOES have ordinary edit
  -- authority over t_own — proving the refusal is column-specific, not just
  -- "headx cannot write this row at all". created_at uses now() - interval
  -- '1 day', not now(): now() is constant for the whole surrounding
  -- transaction (this entire test is one transaction), so a bare `now()`
  -- would equal old.created_at exactly and look like a no-op change rather
  -- than an actual forge attempt.
  insert into checks (label, who, stmt, kind, expected) values
    ('season_id cannot be forged',       headx, format('update tasks set season_id = gen_random_uuid() where id = %L', t_own), 'write', 'DENIED'),
    ('source_proposal cannot be forged', headx, format('update tasks set source_proposal = %L where id = %L', prop, t_own), 'write', 'DENIED'),
    ('created_by cannot be forged',      headx, format('update tasks set created_by = %L where id = %L', headx, t_own), 'write', 'DENIED'),
    ('created_at cannot be forged',      headx, format('update tasks set created_at = now() - interval ''1 day'' where id = %L', t_own), 'write', 'DENIED'),
    ('subteam_key cannot be forged',     headx, format('update tasks set subteam_key = ''TA_Y'' where id = %L', t_own), 'write', 'DENIED'),
    ('archived_at cannot be forged',     headx, format('update tasks set archived_at = now() where id = %L', t_own), 'write', 'DENIED'),
    ('archived_by cannot be forged',     headx, format('update tasks set archived_by = %L where id = %L', headx, t_own), 'write', 'DENIED'),
    ('archive_reason cannot be forged',  headx, format('update tasks set archive_reason = ''manual'' where id = %L', t_own), 'write', 'DENIED');

  for c in select * from checks where n > (select max(n) - 8 from checks) order by n loop
    got := pg_temp.attempt(c.who, c.stmt, c.kind);
    select * into lines, failures from pg_temp.note(lines, failures, c.label, got = c.expected,
      format('expected %s, got %s', c.expected, got));
  end loop;

  -- completed_at/completion_source are handled differently from the columns
  -- above: guard_task_edit() SILENTLY DISCARDS whatever a client sends there
  -- (it always recomputes them from the state transition), rather than
  -- rejecting the statement — so the UPDATE itself "succeeds" (the row
  -- matched), but the forged value never lands. t_own's state is still
  -- 'todo' at this point (untouched since the fixture insert), so a forged
  -- completed_at must come back exactly null, not the client's value.
  got := pg_temp.attempt(headx, format('update tasks set completed_at = now(), completion_source = ''recorded'' where id = %L', t_own), 'write');
  select * into lines, failures from pg_temp.note(lines, failures,
    'a forged completed_at/completion_source update "succeeds" (matches the row)', got = 'ALLOWED', got);
  perform 1 from tasks where id = t_own and (completed_at is not null or completion_source is not null);
  select * into lines, failures from pg_temp.note(lines, failures, 'but the forged value never actually lands on the row', not found);

  -- ======================================= A PROMOTED TASK'S DEADLINE
  got := pg_temp.attempt(headx, format('update tasks set due_date = null where id = %L', t_promoted), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'a promoted task''s due_date cannot be cleared', got = 'DENIED', got);

  got := pg_temp.attempt(headx, format('update tasks set due_date = null where id = %L', t_plain_due), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'a plain (non-promoted) task''s due_date CAN be cleared', got = 'ALLOWED', got);
  update tasks set due_date = '2026-11-05' where id = t_plain_due;

  -- ============================================== DATE ORDERING CHECKS
  begin
    insert into tasks (season_id, title, starts_on, due_date) values (season, 'Bad window', '2026-12-10', '2026-12-01');
    select * into lines, failures from pg_temp.note(lines, failures, 'starts_on > due_date is refused', false, 'no exception was raised');
  exception when check_violation then
    select * into lines, failures from pg_temp.note(lines, failures, 'starts_on > due_date is refused', true);
  end;

  insert into tasks (season_id, title, starts_on, due_date) values (season, 'Good window', '2026-12-01', '2026-12-10');
  select * into lines, failures from pg_temp.note(lines, failures, 'starts_on <= due_date is accepted', true);

  begin
    insert into milestones (key, season_id, ordinal, name, opens_on, due_on)
      values ('TA-MS-BAD', season, 90, 'Bad milestone window', '2026-12-10', '2026-12-01');
    select * into lines, failures from pg_temp.note(lines, failures, 'milestone opens_on > due_on is refused', false, 'no exception was raised');
  exception when check_violation then
    select * into lines, failures from pg_temp.note(lines, failures, 'milestone opens_on > due_on is refused', true);
  end;

  -- ====================================================== COMPLETION
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role','authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', owner1::text, true);

  update tasks set state = 'done' where id = t_own;
  select completed_at, completion_source into scratch_ts, before_id from tasks where id = t_own;
  select * into lines, failures from pg_temp.note(lines, failures, 'entering done sets completed_at',
    scratch_ts is not null and before_id = 'recorded');

  update tasks set detail = 'still done, edited' where id = t_own;
  select completed_at into scratch_ts2 from tasks where id = t_own;
  select * into lines, failures from pg_temp.note(lines, failures, 'staying done through an unrelated edit keeps completed_at',
    scratch_ts2 = scratch_ts, format('%s vs %s', scratch_ts, scratch_ts2));

  update tasks set state = 'wip' where id = t_own;
  perform 1 from tasks where id = t_own and completed_at is null and completion_source is null;
  select * into lines, failures from pg_temp.note(lines, failures, 'leaving done clears completed_at and completion_source', found);

  update tasks set state = 'done' where id = t_own;
  select completed_at into scratch_ts2 from tasks where id = t_own;
  select * into lines, failures from pg_temp.note(lines, failures, 're-entering done starts a fresh completed_at',
    scratch_ts2 is not null and scratch_ts2 >= scratch_ts);

  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- =============================================== ARCHIVE / RESTORE
  -- t_own is currently 'done' (owned by owner1, dept TA_X, headed by headx).
  got := pg_temp.attempt(owner1, format('select archive_task(%L, ''manual'')', t_own), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'the owner alone (not Head, not Developer) cannot archive', got != 'ALLOWED', got);

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', headx, 'role','authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', headx::text, true);
  scratch_task := archive_task(t_own, 'manual');
  select * into lines, failures from pg_temp.note(lines, failures, 'the Head archives a Done task in their department',
    scratch_task.archived_at is not null and scratch_task.archived_by = headx and scratch_task.archive_reason = 'manual');

  begin
    perform archive_task(t_own, 'manual');
    select * into lines, failures from pg_temp.note(lines, failures, 'archiving an already-archived task is refused', false, 'no exception was raised');
  exception when others then
    select * into lines, failures from pg_temp.note(lines, failures, 'archiving an already-archived task is refused', sqlstate = '22023', format('got %s %s', sqlstate, sqlerrm));
  end;

  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  got := pg_temp.attempt(headx, format('update tasks set detail = ''sneaky archived edit'' where id = %L', t_own), 'write');
  select * into lines, failures from pg_temp.note(lines, failures, 'an archived task is read-only even to its own Head', got = 'DENIED', got);

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', headx, 'role','authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', headx::text, true);
  scratch_task := restore_task(t_own);
  select * into lines, failures from pg_temp.note(lines, failures, 'restoring a Done task reopens it to todo and clears completion',
    scratch_task.archived_at is null and scratch_task.state = 'todo' and scratch_task.completed_at is null);
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  begin
    perform restore_task(t_own);
    select * into lines, failures from pg_temp.note(lines, failures, 'restoring a task that is not archived is refused', false, 'no exception was raised');
  exception when others then
    select * into lines, failures from pg_temp.note(lines, failures, 'restoring a task that is not archived is refused', sqlstate = '22023', format('got %s %s', sqlstate, sqlerrm));
  end;

  begin
    perform archive_task(gen_random_uuid(), 'manual');
    select * into lines, failures from pg_temp.note(lines, failures, 'archiving a nonexistent task is refused', false, 'no exception was raised');
  exception when others then
    select * into lines, failures from pg_temp.note(lines, failures, 'archiving a nonexistent task is refused', sqlstate = '23503', format('got %s %s', sqlstate, sqlerrm));
  end;

  -- Give t_no_dept every attention-worthy flag BEFORE archiving it — once
  -- archived it is read-only to ordinary edits, even a Developer's, so this
  -- has to happen first (used below to prove attention() excludes archived
  -- work regardless of how many flags it carries).
  update tasks set priority = 'urgent', starred = true, due_date = '2026-01-01' where id = t_no_dept;

  -- A Developer may archive a task with NO department (nobody else has
  -- authority over t_no_dept: is_department_head(null) is always false, and
  -- its owner alone is not enough — only Developer can here).
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role','authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', dev::text, true);
  scratch_task := archive_task(t_no_dept, 'manual');
  select * into lines, failures from pg_temp.note(lines, failures, 'a Developer archives a task with no department', scratch_task.archived_at is not null);
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- ========================================== attention(p_season, p_today)
  -- Phase 3: entering Blocked now needs a reason or a prerequisite (20260128000100).
  update tasks set state = 'blocked', blocked_reason = 'Waiting for a decision' where id = t_other_dep;
  update tasks set priority = 'urgent', starred = false where id = t_head_owns;
  update tasks set due_date = '2026-09-01', starred = false, state = 'todo' where id = t_plain_due;

  perform 1 from attention(season, '2026-09-15'::date) where kind = 'task' and ref = t_plain_due::text and reason = 'overdue';
  select * into lines, failures from pg_temp.note(lines, failures, 'attention() marks a task overdue against the given p_today', found);

  perform 1 from attention(season, '2026-08-01'::date) where kind = 'task' and ref = t_plain_due::text;
  select * into lines, failures from pg_temp.note(lines, failures, 'attention() does NOT call it overdue before its due date', not found);

  perform 1 from attention(season, '2026-09-15'::date) where kind = 'task' and ref = t_other_dep::text and reason = 'blocked';
  select * into lines, failures from pg_temp.note(lines, failures, 'attention() reports a blocked task', found);

  perform 1 from attention(season, '2026-09-15'::date) where kind = 'task' and ref = t_head_owns::text and reason = 'urgent';
  select * into lines, failures from pg_temp.note(lines, failures, 'attention() surfaces an urgent-priority task with the reason "urgent"', found);

  -- t_no_dept is archived (the Developer archived it just above, already
  -- carrying every attention-worthy flag set before that archiving) —
  -- archived work must never appear in attention regardless of how many
  -- flags it carries. t_own was archived-then-restored earlier and would NOT
  -- prove this (it is active again by now), which is exactly why this uses
  -- t_no_dept instead.
  perform 1 from attention(season, '2026-09-15'::date) where kind = 'task' and ref = t_no_dept::text;
  select * into lines, failures from pg_temp.note(lines, failures, 'attention() excludes archived tasks', not found);

  -- ------------------------------------------------------------------- verdict
  if array_length(failures, 1) > 0 then
    raise exception E'TASK AUTHORIZATION CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'TASK AUTHORIZATION CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
