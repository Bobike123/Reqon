-- =============================================================================
--  Task blockers, prerequisite links, automatic start date and subsections
--  (backend completion Phase 3): migrations 20260128000000 .. 0300,
--  PERMISSIONS.md §2.2 and §7.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every
--  fixture rolls back. Fixture people are new @p3-task.test identities.
--
--  Result: TASK WORKFLOW CHECKS PASSED / FAILED.
--
--  Covers: entering Blocked needs a reason or a prerequisite; external blockers;
--  reasons trimmed, bounded, cleared on leaving, refused on tasks that are not
--  Blocked; legacy Blocked tasks left alone; audit of the reason. Prerequisite links:
--  cross-department, idempotent, no self-link, no direct or transitive cycle, no
--  cross-season link, no archived endpoint, who may add/remove (owner, Head, fallback
--  President, Developer; not the prerequisite's owner, another Head, a retired holder),
--  re-evaluated after reassignment, closed table, last explanation of a blocked task
--  protected. Automatic start date for a promoted task on any insert path, none invented
--  for an import. Subsections: one level, same milestone, no self-parent, guarded
--  delete, structure authority, task regrouping by the task's editors and persistence.
-- =============================================================================

create or replace function pg_temp.attempt(who uuid, stmt text) returns text language plpgsql as $fn$
declare n bigint; result text;
begin
  if who is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', who::text, true);
  end if;
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

create or replace function pg_temp.val(who uuid, expr text) returns text language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute 'select (' || expr || ')::text' into r;
  exception
    when insufficient_privilege then r := 'DENIED';
    when others then r := 'ERROR ' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return coalesce(r, 'null');
end $fn$;

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

do $test$
declare
  season uuid; s2 uuid := gen_random_uuid();
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid();
  doc uuid := gen_random_uuid(); ha uuid := gen_random_uuid(); hb uuid := gen_random_uuid();
  o1 uuid := gen_random_uuid(); o2 uuid := gen_random_uuid(); mem uuid := gen_random_uuid();
  alum uuid := gen_random_uuid(); new_owner uuid := gen_random_uuid();
  pa text; pb text; pc text;
  ms text; ms_b text; ms2 text;
  ta uuid; tz uuid; tdone uuid; tvac uuid; tb uuid; tc uuid; tx uuid; tarch uuid; tother uuid; tlegacy uuid; tmove uuid; tstart uuid;
  sec1 uuid; sec2 uuid; sec_b uuid; sub1 uuid; sub_b uuid;
  today_cph date;
  r text;
  total int; bad int; report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into ms from milestones where season_id = season order by ordinal limit 1;
  select key into ms_b from milestones where season_id = season and key <> ms order by ordinal limit 1;
  select key into pa from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select key into pb from subteams where archived_at is null and parent_key is null and key <> pa order by sort_order, key limit 1;
  select key into pc from subteams where archived_at is null and parent_key is null and key not in (pa, pb) order by sort_order, key limit 1;
  today_cph := (now() at time zone 'Europe/Copenhagen')::date;

  insert into auth.users (id, email)
  select id, k || '@p3-task.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (doc, 'doc'), (ha, 'ha'), (hb, 'hb'),
    (o1, 'o1'), (o2, 'o2'), (mem, 'mem'), (alum, 'alum'), (new_owner, 'new')) v(id, k);
  insert into members (id, full_name, role, status)
  select id, 'T ' || k, 'Member', case when k = 'alum' then 'alumni' else 'active' end::member_state
  from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (doc, 'doc'), (ha, 'ha'), (hb, 'hb'),
    (o1, 'o1'), (o2, 'o2'), (mem, 'mem'), (alum, 'alum'), (new_owner, 'new')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'), (doc, 'documentation');
  update subteams set lead_id = ha where key = pa;
  update subteams set lead_id = hb where key = pb;
  update subteams set lead_id = null where key = pc;              -- a department with NO Head

  insert into seasons (id, label, regs_ref) select s2, 'P3 task other season', regs_ref from seasons where id = season;
  insert into milestones (key, season_id, ordinal, name) values ('PT-M2', s2, 1, 'Other season milestone');
  ms2 := 'PT-M2';

  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key, due_date) values (season, 'Task A', o1, pa, ms, '2099-01-01') returning id into ta;
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key, due_date) values (season, 'Task B', o2, pb, ms, '2099-01-01') returning id into tb;
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key, due_date) values (season, 'Task C', o2, pc, ms, '2099-01-01') returning id into tc;
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key, due_date) values (season, 'Task X', o1, pa, ms, '2099-01-01') returning id into tx;
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key) values (s2, 'Other season', o1, pa, ms2) returning id into tother;
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key, due_date) values (season, 'Task Z', o1, pa, ms, '2099-01-01') returning id into tz;

  -- ================================================================= blockers
  perform pg_temp.expect('entering Blocked with no reason and no prerequisite is refused',
    pg_temp.attempt(o1, format('update tasks set state = ''blocked'' where id = %L', ta)), 'ERROR 23514: Say why this task is blocked%');
  perform pg_temp.expect('... and nothing changed', (select state::text from tasks where id = ta), 'todo');
  perform pg_temp.expect('a whitespace-only reason counts as none',
    pg_temp.attempt(o1, format('update tasks set state = ''blocked'', blocked_reason = ''   '' where id = %L', ta)), 'ERROR 23514%');
  perform pg_temp.expect('a reason over 500 characters is refused with a clear message',
    pg_temp.attempt(o1, format('update tasks set state = ''blocked'', blocked_reason = %L where id = %L', repeat('x', 501), ta)),
    'ERROR 23514: A blocker reason can be at most 500 characters.');
  perform pg_temp.expect('a reason on a task that is not Blocked is refused',
    pg_temp.attempt(o1, format('update tasks set state = ''wip'', blocked_reason = ''waiting'' where id = %L', ta)),
    'ERROR 23514: A blocker reason only applies to a Blocked task.');
  perform pg_temp.expect('an external blocker: the owner blocks it with a reason (no prerequisite task)',
    pg_temp.attempt(o1, format('update tasks set state = ''blocked'', blocked_reason = ''  Waiting for the sponsor''''s quote  '' where id = %L', ta)), 'ALLOWED');
  perform pg_temp.expect('the reason is trimmed and the moment is stamped by the server',
    (select blocked_reason || ':' || (blocked_since is not null)::text from tasks where id = ta), 'Waiting for the sponsor''s quote:true');
  perform pg_temp.expect('the audit event carries the reason',
    (select detail->>'reason' from activity where entity = 'task' and entity_id = ta::text and action = 'state_changed' and detail->>'to' = 'blocked'),
    'Waiting for the sponsor''s quote');
  perform pg_temp.expect('rewriting the reason while Blocked is allowed',
    pg_temp.attempt(o1, format('update tasks set blocked_reason = ''Sponsor answered, waiting for the invoice'' where id = %L', ta)), 'ALLOWED');
  perform pg_temp.expect('... and audited as blocker_changed with the old and new text',
    (select (detail->>'from') || ' > ' || (detail->>'to') from activity where entity_id = ta::text and action = 'blocker_changed'),
    'Waiting for the sponsor''s quote > Sponsor answered, waiting for the invoice');
  perform pg_temp.expect('a client cannot forge the blocked-since stamp',
    pg_temp.attempt(o1, format('update tasks set blocked_since = ''2001-01-01'' where id = %L', ta)), 'ALLOWED');
  perform pg_temp.expect('... the server kept its own stamp', (select (blocked_since > '2001-01-01')::text from tasks where id = ta), 'true');
  perform pg_temp.expect('clearing the only explanation while Blocked is refused',
    pg_temp.attempt(o1, format('update tasks set blocked_reason = null where id = %L', ta)), 'ERROR 23514: A blocked task must say why%');
  perform pg_temp.expect('a member without authority cannot edit the reason',
    pg_temp.attempt(mem, format('update tasks set blocked_reason = ''nope'' where id = %L', ta)), 'DENIED');
  perform pg_temp.expect('another department''s Head cannot',
    pg_temp.attempt(hb, format('update tasks set blocked_reason = ''nope'' where id = %L', ta)), 'DENIED');
  perform pg_temp.expect('the department Head can unblock it',
    pg_temp.attempt(ha, format('update tasks set state = ''wip'' where id = %L', ta)), 'ALLOWED');
  perform pg_temp.expect('... which clears the reason and the stamp',
    (select coalesce(blocked_reason, '-') || ':' || coalesce(blocked_since::text, '-') from tasks where id = ta), '-:-');
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key, state) values (season, 'Legacy blocked', o1, pa, ms, 'blocked') returning id into tlegacy;
  perform pg_temp.expect('a task that was Blocked without a reason (history) can still be edited',
    pg_temp.attempt(o1, format('update tasks set title = ''Legacy blocked, renamed'' where id = %L', tlegacy)), 'ALLOWED');
  perform pg_temp.expect('... and stays Blocked with nothing invented',
    (select state::text || ':' || coalesce(blocked_reason, '-') from tasks where id = tlegacy), 'blocked:-');

  -- ================================================================ dependencies
  perform pg_temp.expect('the owner links a task of another department as a prerequisite',
    pg_temp.val(o1, format('add_task_dependency(%L, %L)', ta, tb)), 'true');
  perform pg_temp.expect('... a retry adds nothing and says so',
    pg_temp.val(o1, format('add_task_dependency(%L, %L)', ta, tb)) || ':' || (select count(*)::text from task_dependencies where task_id = ta), 'false:1');
  perform pg_temp.expect('... the link is audited on the waiting task, naming the prerequisite',
    (select count(*)::text || ':' || max(detail->>'depends_on_title') from activity where entity_id = ta::text and action = 'dependency_added'), '1:Task B');
  perform pg_temp.expect('the season is derived from the tasks, never supplied',
    (select (season_id = season)::text from task_dependencies where task_id = ta and depends_on_task_id = tb), 'true');
  perform pg_temp.expect('a task cannot wait for itself', pg_temp.attempt(o1, format('select add_task_dependency(%L, %L)', ta, ta)),
    'ERROR 23514: A task cannot wait for itself.');
  perform pg_temp.expect('a direct circle is refused', pg_temp.attempt(o2, format('select add_task_dependency(%L, %L)', tb, ta)), 'ERROR 23514%circle%');
  perform pg_temp.expect('B waits for C (fine)', pg_temp.val(o2, format('add_task_dependency(%L, %L)', tb, tc)), 'true');
  perform pg_temp.expect('a longer circle A -> B -> C -> A is refused', pg_temp.attempt(o2, format('select add_task_dependency(%L, %L)', tc, ta)), 'ERROR 23514%circle%');
  perform pg_temp.expect('... and nothing was written', (select count(*)::text from task_dependencies where task_id = tc), '0');
  perform pg_temp.expect('a task cannot wait for a task of another season',
    pg_temp.attempt(o1, format('select add_task_dependency(%L, %L)', ta, tother)), 'ERROR 23514: A task can only wait for a task of the same season.');
  perform pg_temp.expect('... in either direction',
    pg_temp.attempt(o1, format('select add_task_dependency(%L, %L)', tother, ta)), 'ERROR 23514: A task can only wait for a task of the same season.');

  perform pg_temp.expect('a member with no authority over the waiting task cannot link',
    pg_temp.attempt(mem, format('select add_task_dependency(%L, %L)', tx, tb)), 'DENIED');
  perform pg_temp.expect('the prerequisite''s owner cannot link someone else''s task to theirs',
    pg_temp.attempt(o2, format('select add_task_dependency(%L, %L)', tx, tb)), 'DENIED');
  perform pg_temp.expect('another department''s Head cannot', pg_temp.attempt(hb, format('select add_task_dependency(%L, %L)', tx, tb)), 'DENIED');
  -- Role hierarchy (20260130000000): the President may, although the department has a Head (asked without linking).
  perform pg_temp.expect('the President may where the department has a Head',
    pg_temp.val(pre, format('can_edit_task(%L)', tx)), 'true');
  perform pg_temp.expect('a retired member cannot', pg_temp.attempt(alum, format('select add_task_dependency(%L, %L)', tx, tb)), 'DENIED');
  perform pg_temp.expect('anonymous cannot', pg_temp.attempt(null, format('select add_task_dependency(%L, %L)', tx, tb)), 'DENIED');
  perform pg_temp.expect('the department''s Head can', pg_temp.attempt(ha, format('select add_task_dependency(%L, %L)', tx, tb)), 'ALLOWED');
  perform pg_temp.expect('the President can where the department has no Head (governance fallback)',
    pg_temp.val(pre, format('add_task_dependency(%L, %L)', tc, tz)), 'true');
  perform pg_temp.expect('a Developer can', pg_temp.val(dev, format('add_task_dependency(%L, %L)', tx, tc)), 'true');

  perform pg_temp.expect('nobody writes the table directly (insert)',
    pg_temp.attempt(dev, format('insert into task_dependencies (task_id, depends_on_task_id) values (%L, %L)', tb, tx)), 'DENIED');
  perform pg_temp.expect('... nor deletes', pg_temp.attempt(dev, format('delete from task_dependencies where task_id = %L', tx)), 'DENIED');
  perform pg_temp.expect('... nor updates', pg_temp.attempt(dev, format('update task_dependencies set created_at = now() where task_id = %L', tx)), 'DENIED');
  perform pg_temp.expect('any active member can read the links', pg_temp.attempt(mem, 'select * from task_dependencies'), 'ALLOWED');
  begin
    insert into task_dependencies (task_id, depends_on_task_id) values (tc, ta);
    r := 'inserted';
  exception when others then r := sqlstate;
  end;
  perform pg_temp.expect('the circle rule holds for every writer, not only the command', r, '23514');

  -- archived endpoints
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key) values (season, 'Archived one', o1, pa, ms) returning id into tarch;
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks set archived_at = now(), archive_reason = 'manual' where id = tarch;
  perform set_config('reqon.task_lifecycle_write', 'off', true);
  perform pg_temp.expect('a new link to an archived task is refused', pg_temp.attempt(ha, format('select add_task_dependency(%L, %L)', tx, tarch)), 'ERROR 23514%archived%');
  perform pg_temp.expect('... and so is one from an archived task', pg_temp.attempt(dev, format('select add_task_dependency(%L, %L)', tarch, tx)), 'DENIED');

  -- M1 (20260128000400): only an unfinished prerequisite explains a block.
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key, state) values (season, 'Finished prereq', o1, pa, ms, 'done') returning id into tdone;
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key) values (season, 'Wants a vacuous block', o1, pa, ms) returning id into tvac;
  perform pg_temp.expect('a link to a finished task is allowed', pg_temp.val(o1, format('add_task_dependency(%L, %L)', tvac, tdone)), 'true');
  perform pg_temp.expect('M1: ... but it does not explain a block',
    pg_temp.attempt(o1, format('update tasks set state = ''blocked'' where id = %L', tvac)), 'ERROR 23514: Say why this task is blocked%');
  perform pg_temp.expect('M1: a whitespace-only (newlines/tabs) reason is no reason',
    pg_temp.attempt(o1, format('update tasks set state = ''blocked'', blocked_reason = %L where id = %L', E'\n\t\n', tvac)), 'ERROR 23514%');
  perform pg_temp.expect('M1: the link to finished work can be removed at any time', pg_temp.val(o1, format('remove_task_dependency(%L, %L)', tvac, tdone)), 'true');

  -- blocking on a prerequisite, and protecting the last explanation
  perform pg_temp.expect('with a prerequisite linked, Blocked needs no separate reason',
    pg_temp.attempt(o1, format('update tasks set state = ''blocked'' where id = %L', tx)), 'ALLOWED');
  perform pg_temp.expect('a reason may be added and removed again while a prerequisite explains it',
    pg_temp.attempt(o1, format('update tasks set blocked_reason = ''also the supplier'' where id = %L', tx)) || ':' ||
    pg_temp.attempt(o1, format('update tasks set blocked_reason = null where id = %L', tx)), 'ALLOWED:ALLOWED');
  perform pg_temp.expect('removing a prerequisite is fine while another remains',
    pg_temp.val(ha, format('remove_task_dependency(%L, %L)', tx, tb)), 'true');
  perform pg_temp.expect('... but not the only explanation of a Blocked task',
    pg_temp.attempt(ha, format('select remove_task_dependency(%L, %L)', tx, tc)), 'ERROR 23514%only thing%');
  perform pg_temp.expect('... once a reason is written it can go',
    pg_temp.attempt(ha, format('update tasks set blocked_reason = ''waiting for parts'' where id = %L', tx)) || ':' ||
    pg_temp.val(ha, format('remove_task_dependency(%L, %L)', tx, tc)), 'ALLOWED:true');
  perform pg_temp.expect('removing again is a harmless retry', pg_temp.val(ha, format('remove_task_dependency(%L, %L)', tx, tc)), 'false');
  perform pg_temp.expect('... and is audited once', (select count(*)::text from activity where entity_id = tx::text and action = 'dependency_removed'), '2');

  perform pg_temp.expect('a member cannot remove a link', pg_temp.attempt(mem, format('select remove_task_dependency(%L, %L)', ta, tb)), 'DENIED');
  perform pg_temp.expect('another Head cannot', pg_temp.attempt(hb, format('select remove_task_dependency(%L, %L)', ta, tb)), 'DENIED');
  perform pg_temp.expect('the owner can', pg_temp.val(o1, format('remove_task_dependency(%L, %L)', ta, tb)), 'true');

  -- authority follows the CURRENT owner
  perform pg_temp.val(o1, format('add_task_dependency(%L, %L)', ta, tb));
  perform pg_temp.expect('the Head reassigns the waiting task', pg_temp.attempt(ha, format('update tasks set owner_id = %L where id = %L', new_owner, ta)), 'ALLOWED');
  perform pg_temp.expect('the previous owner can no longer change what it waits for',
    pg_temp.attempt(o1, format('select remove_task_dependency(%L, %L)', ta, tb)), 'DENIED');
  perform pg_temp.expect('the new owner can', pg_temp.val(new_owner, format('remove_task_dependency(%L, %L)', ta, tb)), 'true');

  -- ============================================================ start date
  insert into tasks (season_id, title, subteam_key, milestone_key, due_date, links_required)
    values (season, 'Promoted-like, future deadline', pa, ms, '2099-01-01', true) returning id into tstart;
  perform pg_temp.expect('a proposal-born task inserted without a start gets the club''s day',
    (select starts_on::text from tasks where id = tstart), today_cph::text);
  insert into tasks (season_id, title, subteam_key, milestone_key, due_date, links_required)
    values (season, 'Promoted-like, past deadline', pa, ms, '2020-03-01', true) returning id into tstart;
  perform pg_temp.expect('... clamped so it never falls after its deadline', (select starts_on::text from tasks where id = tstart), '2020-03-01');
  insert into tasks (season_id, title, subteam_key, milestone_key, links_required)
    values (season, 'Promoted-like, no deadline', pa, ms, true) returning id into tstart;
  perform pg_temp.expect('... and works without a deadline', (select starts_on::text from tasks where id = tstart), today_cph::text);
  insert into tasks (season_id, title, subteam_key, milestone_key, due_date, links_required, starts_on)
    values (season, 'Promoted-like, explicit start', pa, ms, '2099-01-01', true, '2026-10-05') returning id into tstart;
  perform pg_temp.expect('an explicit start is kept', (select starts_on::text from tasks where id = tstart), '2026-10-05');
  insert into tasks (season_id, title, subteam_key, milestone_key, due_date)
    values (season, 'Imported history', pa, ms, '2026-01-15') returning id into tstart;
  perform pg_temp.expect('an imported / legacy task gets NO invented start date', (select coalesce(starts_on::text, 'NULL') from tasks where id = tstart), 'NULL');

  -- ============================================================= subsections
  insert into milestone_sections (milestone_key, ordinal, name) values (ms, 901, 'P3 section one') returning id into sec1;
  insert into milestone_sections (milestone_key, ordinal, name) values (ms, 902, 'P3 section two') returning id into sec2;
  insert into milestone_sections (milestone_key, ordinal, name) values (ms_b, 901, 'P3 section elsewhere') returning id into sec_b;
  insert into milestone_sections (milestone_key, ordinal, name, parent_section_id) values (ms, 903, 'P3 subsection', sec1) returning id into sub1;
  perform pg_temp.expect('a subsection under a top-level section of the same milestone',
    (select (parent_section_id = sec1)::text from milestone_sections where id = sub1), 'true');
  perform pg_temp.expect('a subsection cannot have a subsection',
    pg_temp.attempt(pre, format('insert into milestone_sections (milestone_key, ordinal, name, parent_section_id) values (%L, 904, ''deep'', %L)', ms, sub1)),
    'ERROR 23514: Subsections go one level deep%');
  perform pg_temp.expect('a parent in another milestone is refused',
    pg_temp.attempt(pre, format('insert into milestone_sections (milestone_key, ordinal, name, parent_section_id) values (%L, 904, ''cross'', %L)', ms, sec_b)),
    'ERROR 23514: A subsection belongs to the same milestone%');
  perform pg_temp.expect('a section cannot be its own parent',
    pg_temp.attempt(pre, format('update milestone_sections set parent_section_id = id where id = %L', sec2)), 'ERROR 23514: A section cannot be its own parent.');
  perform pg_temp.expect('a section that has subsections cannot become one',
    pg_temp.attempt(pre, format('update milestone_sections set parent_section_id = %L where id = %L', sec2, sec1)), 'ERROR 23514%has subsections of its own%');
  perform pg_temp.expect('... nor move to another milestone',
    pg_temp.attempt(pre, format('update milestone_sections set milestone_key = %L, ordinal = 950 where id = %L', ms_b, sec1)), 'ERROR 23514%');
  perform pg_temp.expect('a parent that still has subsections cannot be deleted',
    pg_temp.attempt(pre, format('delete from milestone_sections where id = %L', sec1)), 'ERROR 23503%');
  insert into milestone_sections (milestone_key, ordinal, name, parent_section_id) values (ms_b, 902, 'P3 subsection elsewhere', sec_b) returning id into sub_b;

  perform pg_temp.expect('a department Head cannot create a subsection',
    pg_temp.attempt(ha, format('insert into milestone_sections (milestone_key, ordinal, name, parent_section_id) values (%L, 905, ''head sub'', %L)', ms, sec2)), 'DENIED');
  perform pg_temp.expect('... nor re-parent one', pg_temp.attempt(ha, format('update milestone_sections set parent_section_id = %L where id = %L', sec2, sub1)), 'DENIED');
  perform pg_temp.expect('a plain member cannot re-parent one', pg_temp.attempt(mem, format('update milestone_sections set parent_section_id = %L where id = %L', sec2, sub1)), 'DENIED');
  perform pg_temp.expect('Documentation can create a subsection',
    pg_temp.attempt(doc, format('insert into milestone_sections (milestone_key, ordinal, name, parent_section_id) values (%L, 906, ''doc sub'', %L)', ms, sec2)), 'ALLOWED');
  perform pg_temp.expect('the President can re-parent it', pg_temp.attempt(pre, format('update milestone_sections set parent_section_id = %L where id = %L', sec2, sub1)), 'ALLOWED');
  perform pg_temp.expect('... and detach it again', pg_temp.attempt(pre, format('update milestone_sections set parent_section_id = null where id = %L', sub1)), 'ALLOWED');
  perform pg_temp.expect('any active member may still tick a subsection drafted', pg_temp.attempt(mem, format('update milestone_sections set is_drafted = true where id = %L', sub1)), 'ALLOWED');
  update milestone_sections set parent_section_id = sec1 where id = sub1;

  -- regrouping reuses the canonical task
  insert into tasks (season_id, title, owner_id, subteam_key, milestone_key) values (season, 'Task move', o1, pa, ms) returning id into tmove;
  perform pg_temp.expect('the owner puts their task in a subsection', pg_temp.attempt(o1, format('update tasks set section_id = %L where id = %L', sub1, tmove)), 'ALLOWED');
  perform pg_temp.expect('a member with no authority over the task cannot regroup it', pg_temp.attempt(mem, format('update tasks set section_id = %L where id = %L', sec2, tmove)), 'DENIED');
  perform pg_temp.expect('another department''s Head cannot', pg_temp.attempt(hb, format('update tasks set section_id = %L where id = %L', sec2, tmove)), 'DENIED');
  perform pg_temp.expect('a section of another milestone is refused',
    pg_temp.attempt(o1, format('update tasks set section_id = %L where id = %L', sub_b, tmove)), 'ERROR 23514%');
  perform pg_temp.expect('the department Head moves it to another section', pg_temp.attempt(ha, format('update tasks set section_id = %L where id = %L', sec2, tmove)), 'ALLOWED');
  perform pg_temp.expect('the move persists on the same task row: one task, its id and milestone unchanged',
    (select (section_id = sec2 and milestone_key = ms)::text from tasks where id = tmove) || ':' || (select count(*)::text from tasks where title = 'Task move'), 'true:1');
  perform pg_temp.expect('each regrouping is audited', (select count(*)::text from activity where entity_id = tmove::text and action in ('section_linked', 'section_changed')), '2');

  -- ================================================================= verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'TASK WORKFLOW CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'TASK WORKFLOW CHECKS PASSED — all % checks', total;
end
$test$;
