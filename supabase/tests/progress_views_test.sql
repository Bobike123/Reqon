-- =============================================================================
--  One definition of progress (backend completion Phase 4): migrations
--  20260129000000 (attention v2) and 20260129000100 (progress views);
--  PERMISSIONS.md §6.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every
--  fixture rolls back. Fixture people are new @p4-prog.test identities; fixture
--  departments are PG_*; fixture tasks are titled "[PG] ...".
--
--  Result: PROGRESS VIEW CHECKS PASSED / FAILED.
--
--  Covers v_task_progress: distinct tasks (a task linked twice counts once); a parent is
--  computed from its unique descendant tasks, never by averaging child percentages
--  (department roll-up, section + subsection); cancelled tasks leave the denominator and are
--  reported; archived DONE keeps its contribution, archived UNFINISHED never becomes done and
--  is reported; a scope with only cancelled work is "no linked work" (percent NULL), not 0 %;
--  season isolation; milestone scope through direct and section links; unassigned scope.
--  v_book_progress: N/A excluded from numerator AND denominator and counted apart; compliant +
--  verified = complied; content_state (imported / no_numbered_rules / out_of_scope /
--  not_imported is missing data, not a zero); reassigning a requirement's department changes
--  no book figure. v_subteam_progress: every season, active departments only, team-duty
--  blocked. attention(): flags are independent (blocked AND overdue counts as both).
-- =============================================================================

create or replace function pg_temp.attempt(who uuid, stmt text) returns text language plpgsql as $fn$
declare n bigint; result text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt;
    get diagnostics n = row_count;
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

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

-- One task; optionally archived (through the internal lifecycle flag the archive command uses).
create or replace function pg_temp.mkt(p_season uuid, p_title text, p_dept text, p_state text default 'todo',
  p_archived boolean default false, p_ms text default null, p_sec uuid default null, p_due date default null)
returns uuid language plpgsql as $fn$
declare tid uuid;
begin
  insert into tasks (season_id, title, subteam_key, state, milestone_key, section_id, due_date)
  values (p_season, '[PG] ' || p_title, p_dept, p_state::task_state, p_ms, p_sec, p_due) returning id into tid;
  if p_archived then
    perform set_config('reqon.task_lifecycle_write', 'on', true);
    update tasks set archived_at = now(), archive_reason = 'manual' where id = tid;
    perform set_config('reqon.task_lifecycle_write', 'off', true);
  end if;
  return tid;
end $fn$;

-- "total|done|archived_done|archived_unfinished|cancelled|open_active|percent" of one scope, or 'none'.
create or replace function pg_temp.prog(p_season uuid, p_scope text, p_key text) returns text language sql as $fn$
  select coalesce((select concat_ws('|', total, done, archived_done, archived_unfinished, cancelled, open_active, coalesce(percent::text, 'null'))
                     from v_task_progress where season_id = p_season and scope = p_scope and scope_key = p_key), 'none');
$fn$;

do $test$
declare
  season uuid; s2 uuid := gen_random_uuid();
  mem uuid := gen_random_uuid();
  pa text; ms text; ms2 text;
  clause_x text; clause_y text;
  t uuid; tb uuid; tc uuid; td uuid;
  sec1 uuid; sub1 uuid;
  base_req bigint; base_ms bigint;
  b_art record; a_before record; a_after record;
  r text;
  n_total int; n_bad int; v_report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into ms from milestones where season_id = season order by ordinal limit 1;
  select key into pa from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select clause_key into clause_x from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season and c.is_team_duty order by clause_key limit 1;

  insert into auth.users (id, email) values (mem, 'mem@p4-prog.test');
  insert into members (id, full_name, role, status) values (mem, 'P4 mem', 'Member', 'active');
  insert into subteams (key, name, parent_key) values ('PG_SUB1', 'PG sub 1', pa), ('PG_SUB2', 'PG sub 2', pa),
    ('PG_CAN', 'PG only cancelled', pa), ('PG_EMPTY', 'PG no work', pa);
  insert into seasons (id, label, regs_ref) select s2, 'P4 progress other season', regs_ref from seasons where id = season;
  insert into milestones (key, code, season_id, ordinal, name) values ('PG-M2', 'PG-M2', s2, 1, 'Other season milestone');
  ms2 := 'PG-M2';

  -- The department the fixtures hang under may hold real tasks in a populated database:
  -- measure it before adding any, and compare differences for it.
  -- ------------------------------------------------------------- departments
  t := pg_temp.mkt(season, 'sub1 archived done', 'PG_SUB1', 'done', true);
  t := pg_temp.mkt(season, 'sub1 archived unfinished', 'PG_SUB1', 'wip', true);
  t := pg_temp.mkt(season, 'sub1 cancelled', 'PG_SUB1', 'cancelled');
  t := pg_temp.mkt(season, 'sub2 todo', 'PG_SUB2', 'todo');
  t := pg_temp.mkt(season, 'only cancelled', 'PG_CAN', 'cancelled');

  perform pg_temp.expect('archived DONE keeps its contribution; archived UNFINISHED stays undone and is reported; cancelled leaves the denominator',
    pg_temp.prog(season, 'department', 'PG_SUB1'), '2|1|1|1|1|0|50');
  perform pg_temp.expect('a department with open work only is 0 %, which is a real zero',
    pg_temp.prog(season, 'department', 'PG_SUB2'), '1|0|0|0|0|1|0');
  perform pg_temp.expect('a department with only cancelled work is "no linked work" (percent NULL), never 0 %',
    pg_temp.prog(season, 'department', 'PG_CAN'), '0|0|0|0|1|0|null');
  perform pg_temp.expect('a department with no task has no row at all (no linked work)',
    pg_temp.prog(season, 'department', 'PG_EMPTY'), 'none');
  -- The parent's own tasks are what a populated database may add: use a parent of our own instead.
  insert into subteams (key, name) values ('PG_PARENT', 'PG parent');
  insert into subteams (key, name, parent_key) values ('PG_CHILD_A', 'PG child A', 'PG_PARENT'), ('PG_CHILD_B', 'PG child B', 'PG_PARENT');
  t := pg_temp.mkt(season, 'parent done', 'PG_PARENT', 'done');
  t := pg_temp.mkt(season, 'parent todo', 'PG_PARENT', 'todo');
  t := pg_temp.mkt(season, 'child a done, archived', 'PG_CHILD_A', 'done', true);
  t := pg_temp.mkt(season, 'child a wip, archived', 'PG_CHILD_A', 'wip', true);
  t := pg_temp.mkt(season, 'child a cancelled', 'PG_CHILD_A', 'cancelled');
  t := pg_temp.mkt(season, 'child b todo', 'PG_CHILD_B', 'todo');
  perform pg_temp.expect('a department counts its own tasks only (2 tasks, 1 done = 50 %)', pg_temp.prog(season, 'department', 'PG_PARENT'), '2|1|0|0|0|1|50');
  perform pg_temp.expect('the roll-up is computed from the UNIQUE tasks of the parent and its subdepartments (5 counted, 2 done = 40 %), not by averaging their percentages (50 % and 0 %)',
    pg_temp.prog(season, 'department_rollup', 'PG_PARENT'), '5|2|1|1|1|2|40');
  perform pg_temp.expect('a subdepartment''s roll-up is its own tasks', pg_temp.prog(season, 'department_rollup', 'PG_CHILD_A'), '2|1|1|1|1|0|50');

  -- ---------------------------------------------------------------- unassigned
  t := pg_temp.mkt(season, 'unassigned', null, 'todo');
  perform pg_temp.expect('work without a department is its own scope', (select (total >= 1)::text from v_task_progress where season_id = season and scope = 'unassigned'), 'true');

  -- ------------------------------------------------ sections, subsections, links
  insert into milestone_sections (milestone_key, ordinal, name) values (ms, 951, 'PG section') returning id into sec1;
  insert into milestone_sections (milestone_key, ordinal, name, parent_section_id) values (ms, 952, 'PG subsection', sec1) returning id into sub1;
  select coalesce(sum(total), 0) into base_ms from v_task_progress where season_id = season and scope = 'milestone' and scope_key = ms;
  select coalesce(sum(total), 0) into base_req from v_task_progress where season_id = season and scope = 'requirement' and scope_key = clause_x;

  t  := pg_temp.mkt(season, 'A in section, done', 'PG_PARENT', 'done', false, ms, sec1);
  tb := pg_temp.mkt(season, 'B in subsection, wip', 'PG_PARENT', 'wip', false, ms, sub1);
  tc := pg_temp.mkt(season, 'C in subsection, done', 'PG_PARENT', 'done', false, ms, sub1);
  td := pg_temp.mkt(season, 'D on milestone only', 'PG_PARENT', 'todo', false, ms, null);
  select clause_key into clause_y from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season and c.clause_key <> clause_x order by clause_key limit 1;
  -- C cites two requirements, B one, and both cite clause_x: join rows are duplicated on purpose.
  insert into task_requirements (task_id, clause_key) values (tc, clause_x), (tc, clause_y), (tb, clause_x);

  perform pg_temp.expect('a subsection counts its own tasks (1 of 2 = 50 %)', pg_temp.prog(season, 'section', sub1::text), '2|1|0|0|0|1|50');
  perform pg_temp.expect('the section counts its own AND its subsection''s tasks once each: 2 of 3 = 67 %, not the average of 100 % and 50 %',
    pg_temp.prog(season, 'section', sec1::text), '3|2|0|0|0|1|67');
  perform pg_temp.expect('the milestone counts the four tasks on it once each, however they are linked',
    (select (total - base_ms)::text from v_task_progress where season_id = season and scope = 'milestone' and scope_key = ms), '4');
  perform pg_temp.expect('requirement scope counts distinct tasks (B and C; C also cites another rule)',
    (select (total - base_req)::text from v_task_progress where season_id = season and scope = 'requirement' and scope_key = clause_x), '2');
  perform pg_temp.expect('the other rule it cites sees the task once', (select (done >= 1 and total >= 1)::text from v_task_progress where season_id = season and scope = 'requirement' and scope_key = clause_y), 'true');

  -- ---------------------------------------------------------- season isolation
  t := pg_temp.mkt(s2, 'other season task', 'PG_PARENT', 'done', false, ms2, null);
  perform pg_temp.expect('another season''s task is in that season''s scopes only',
    pg_temp.prog(s2, 'milestone', ms2) || ':' || (select count(*)::text from v_task_progress where season_id = season and scope = 'milestone' and scope_key = ms2), '1|1|0|0|0|0|100:0');
  perform pg_temp.expect('... and the first season''s department figure is unchanged by it', pg_temp.prog(season, 'department', 'PG_PARENT'), '6|3|0|0|0|3|50');
  perform pg_temp.expect('a member (RLS) can read the view', pg_temp.attempt(mem, 'select * from v_task_progress limit 1'), 'ALLOWED');
  perform pg_temp.expect('anonymous has no privilege on it', (select count(*)::text from information_schema.role_table_grants where table_name = 'v_task_progress' and grantee = 'anon'), '0');

  -- ============================================================ book progress
  select * into b_art from v_book_progress
   where season_id = season and level = 'subchapter' and kind = 'article' and requirements >= 4 order by requirements desc limit 1;
  select * into a_before from v_book_progress where season_id = season and level = 'subchapter' and chapter_code = b_art.chapter_code and number = b_art.number;
  -- Three requirements of that article: one compliant, one verified, one N/A.
  insert into clause_status (season_id, clause_key, state)
  select season, clause_key, (array['compliant', 'verified', 'na'])[rn]::clause_state
    from (select clause_key, row_number() over (order by clause_key) rn from clauses
           where regs_ref = b_art.regs_ref and section = b_art.chapter_code and article = b_art.number and is_team_duty) q
   where rn <= 3
  on conflict (season_id, clause_key) do update set state = excluded.state;
  select * into a_after from v_book_progress where season_id = season and level = 'subchapter' and chapter_code = b_art.chapter_code and number = b_art.number;
  perform pg_temp.expect('N/A is counted apart and leaves the denominator: applicable falls by 1',
    (a_after.not_applicable - a_before.not_applicable)::text || ':' || (a_before.applicable - a_after.applicable)::text, '1:1');
  perform pg_temp.expect('compliant + verified = complied (2 more), verified shown alone (1 more)',
    (a_after.complied - a_before.complied)::text || ':' || (a_after.verified - a_before.verified)::text, '2:1');
  perform pg_temp.expect('the total requirement count does not move with status', (a_after.requirements = a_before.requirements)::text, 'true');
  perform pg_temp.expect('the legacy resolved column still counts N/A (kept for one release)', (a_after.resolved - a_before.resolved)::text, '3');
  perform pg_temp.expect('an imported article reads content_state imported', a_after.content_state, 'imported');

  -- Department ownership never enters the book figures.
  update clauses set subteam_key = (select key from subteams where archived_at is null and parent_key is null and key <> pa order by sort_order limit 1)
   where regs_ref = b_art.regs_ref and section = b_art.chapter_code and article = b_art.number;
  perform pg_temp.expect('reassigning every requirement of the article to another department changes no book figure',
    (select (requirements = a_after.requirements and applicable = a_after.applicable and complied = a_after.complied)::text
       from v_book_progress where season_id = season and level = 'subchapter' and chapter_code = b_art.chapter_code and number = b_art.number), 'true');

  perform pg_temp.expect('a chapter the book has no numbered rules for is a CONFIRMED zero (no_numbered_rules)',
    (select coalesce(bool_and(content_state = 'no_numbered_rules'), false)::text from v_book_progress
      where season_id = season and level = 'chapter' and not has_numbered_rules and not out_of_scope), 'true');
  perform pg_temp.expect('a chapter of another category is out_of_scope, not missing',
    (select coalesce(bool_and(content_state = 'out_of_scope'), false)::text from v_book_progress where season_id = season and out_of_scope), 'true');
  insert into book_chapters (regs_ref, code, label, heading, page, sort_order, has_numbered_rules)
  select regs_ref, 'Z', 'Z', 'Chapter with rules that were never imported', 999, 999, true from seasons where id = season;
  perform pg_temp.expect('a chapter that has rules in the book but none imported is not_imported (missing data), never a confirmed zero',
    (select content_state || ':' || requirements::text from v_book_progress where season_id = season and level = 'chapter' and chapter_code = 'Z'), 'not_imported:0');

  -- ================================================== department requirements
  perform pg_temp.expect('v_subteam_progress has a row per active department for EVERY season',
    (select (count(*) filter (where season_id = season) = 1 and count(*) filter (where season_id = s2) = 1)::text from v_subteam_progress where key = 'PG_PARENT'), 'true');
  update subteams set archived_at = now(), archive_reason = 'test' where key = 'PG_EMPTY';
  perform pg_temp.expect('an archived department is left out', (select count(*)::text from v_subteam_progress where key = 'PG_EMPTY'), '0');
  perform pg_temp.expect('applicable + not_applicable = duties (N/A is counted apart)',
    (select bool_and(applicable + not_applicable = duties)::text from v_subteam_progress where season_id = season), 'true');
  perform pg_temp.expect('complied never exceeds applicable', (select bool_and(complied <= applicable)::text from v_subteam_progress where season_id = season), 'true');
  update clause_status set state = 'blocked' where season_id = season and clause_key = clause_x;
  update clauses set is_team_duty = false where clause_key = clause_x;
  perform pg_temp.expect('a blocked status on something that is not a team duty is not counted as blocked (the same filter as everything else)',
    (select coalesce(sum(blocked), 0)::text from v_subteam_progress where season_id = season and key = (select subteam_key from clauses where clause_key = clause_x)), (
      select coalesce(count(*), 0)::text from clause_status cs join clauses c on c.clause_key = cs.clause_key
       where cs.season_id = season and cs.state = 'blocked' and c.is_team_duty
         and c.subteam_key = (select subteam_key from clauses where clause_key = clause_x)));

  -- =========================================================== attention v2
  t := pg_temp.mkt(season, 'blocked and overdue', 'PG_PARENT', 'blocked', false, ms, null, (current_date - 3));
  t := pg_temp.mkt(season, 'urgent only', 'PG_PARENT', 'todo', false, ms, null, current_date + 30);
  update tasks set priority = 'urgent' where title = '[PG] urgent only';
  select string_agg(distinct reason, ',') into r from attention(season, current_date) where title = '[PG] blocked and overdue';
  perform pg_temp.expect('a task that is blocked AND overdue is listed once, with the first reason', coalesce(r, '-'), 'blocked');
  perform pg_temp.expect('... and carries both flags',
    (select (is_blocked and is_overdue and not is_urgent)::text from attention(season, current_date) where title = '[PG] blocked and overdue'), 'true');
  perform pg_temp.expect('the overdue count taken from the flag includes it (the count by reason would not)',
    (select count(*) filter (where is_overdue)::text || ':' || count(*) filter (where reason = 'overdue')::text
       from attention(season, current_date) where title like '[PG] %'), '1:0');
  perform pg_temp.expect('an urgent, not overdue task carries only is_urgent',
    (select (is_urgent and not is_overdue and not is_blocked)::text from attention(season, current_date) where title = '[PG] urgent only'), 'true');
  perform pg_temp.expect('done, cancelled and archived tasks are never listed',
    (select count(*)::text from attention(season, current_date + 3650) where title in ('[PG] parent done', '[PG] child a cancelled', '[PG] child a wip, archived')), '0');

  -- ================================================================= verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into n_total, n_bad, v_report from pg_temp.results;
  if n_bad > 0 then
    raise exception E'PROGRESS VIEW CHECKS FAILED — % of % checks did not behave as expected.\n%', n_bad, n_total, v_report;
  end if;
  raise exception 'PROGRESS VIEW CHECKS PASSED — all % checks', n_total;
end
$test$;
