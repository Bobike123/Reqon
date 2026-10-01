-- =============================================================================
--  Season integrity (backend completion Phase 4): migration 20260129000600;
--  PERMISSIONS.md §2.1; phase-01 findings F-03, F-11.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every
--  fixture rolls back. Fixture people are new @p4-season.test identities.
--
--  Result: SEASON INTEGRITY CHECKS PASSED / FAILED.
--
--  Covers: President / Developer only for starting, inserting and switching seasons on every
--  path (command, direct INSERT/UPDATE, the switch function; Vice President, Head, member,
--  retired Developer and anonymous refused); a new season is not current; the rollover copies
--  milestone and section DEFINITIONS (with subsection structure) and nothing else - no dates, no
--  submission, no drafted tick, no task, status or measurement; the previous season is
--  untouched; the same milestone label can exist in two seasons but not twice in one; labels are
--  case-insensitively unique per season; cross-season links are refused by the database
--  (task milestone/section, source proposal, requirement status and specification editions,
--  dependencies, measurements); a season that holds work cannot be deleted; switching leaves
--  exactly one current season.
-- =============================================================================

create or replace function pg_temp.q(who uuid, expr text) returns text language plpgsql as $fn$
declare r text;
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
    execute 'select (' || expr || ')::text' into r;
  exception
    when insufficient_privilege then r := 'DENIED';
    when others then r := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return coalesce(r, 'null');
end $fn$;

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

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

-- Run a statement as the owner (these are structural rules that hold for every writer),
-- returning its SQLSTATE, or ALLOWED. Each call is its own savepoint, so a refusal rolls back only itself.
create or replace function pg_temp.state_of(stmt text) returns text language plpgsql as $fn$
begin
  execute stmt;
  return 'ALLOWED';
exception when others then
  return sqlstate;
end $fn$;

do $test$
declare
  season uuid; s2 uuid;
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid();
  ha uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); alum uuid := gen_random_uuid();
  pa text; ms text; ms_count int; sec_count int;
  src_before text; src_after text;
  sec1 uuid;
  sx uuid := gen_random_uuid();
  other_ms text := 'PI-OTHER-M';
  p_other uuid; sp uuid;
  cl_other text := 'PI-OTHER-EDITION'; cl text;
  t uuid; t2 uuid;
  n_total int; n_bad int; v_report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into ms from milestones where season_id = season order by ordinal limit 1;
  select key into pa from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select clause_key into cl from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season order by clause_key limit 1;

  insert into auth.users (id, email)
  select id, k || '@p4-season.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (ha, 'ha'), (mem, 'mem'), (alum, 'alum')) v(id, k);
  insert into members (id, full_name, role, status)
  select id, 'N ' || k, 'Member', case when k = 'alum' then 'alumni' else 'active' end::member_state
    from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (ha, 'ha'), (mem, 'mem'), (alum, 'alum')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'), (alum, 'developer');
  update subteams set lead_id = ha where key = pa;

  -- Give the source season some structure to copy: a section with a subsection, dates, a submission, a drafted tick.
  insert into milestone_sections (milestone_key, ordinal, name, is_drafted) values (ms, 971, 'PI section', true) returning id into sec1;
  insert into milestone_sections (milestone_key, ordinal, name, parent_section_id) values (ms, 972, 'PI subsection', sec1);
  update milestones set due_on = '2027-01-31', opens_on = '2027-01-01', submitted_on = (now() at time zone 'Europe/Copenhagen')::date - 5 where key = ms;
  select count(*) into ms_count from milestones where season_id = season;
  select count(*) into sec_count from milestone_sections s join milestones m on m.key = s.milestone_key where m.season_id = season;
  select md5(string_agg(to_jsonb(m)::text, '|' order by key)) into src_before from milestones m where season_id = season;

  -- ================================================================ authority
  perform pg_temp.expect('the Vice President cannot start a season', pg_temp.q(vp, 'start_season(''P4 vp season'', null, null, null, null)'), 'DENIED');
  perform pg_temp.expect('nor a department Head', pg_temp.q(ha, 'start_season(''P4 head season'', null, null, null, null)'), 'DENIED');
  perform pg_temp.expect('nor a member', pg_temp.q(mem, 'start_season(''P4 member season'', null, null, null, null)'), 'DENIED');
  perform pg_temp.expect('nor a retired Developer', pg_temp.q(alum, 'start_season(''P4 alum season'', null, null, null, null)'), 'DENIED');
  perform pg_temp.expect('nor anonymous', pg_temp.q(null, 'start_season(''P4 anon season'', null, null, null, null)'), 'DENIED');
  perform pg_temp.expect('the Vice President cannot insert a season directly', pg_temp.attempt(vp, 'insert into seasons (label) values (''P4 vp direct'')'), 'DENIED');
  perform pg_temp.expect('nor a member', pg_temp.attempt(mem, 'insert into seasons (label) values (''P4 member direct'')'), 'DENIED');
  perform pg_temp.expect('the Vice President cannot switch the season', pg_temp.q(vp, format('set_current_season(%L)', season)), 'DENIED');
  perform pg_temp.expect('... nor flip the flag by hand', pg_temp.attempt(vp, format('update seasons set is_current = true where id = %L', season)), 'DENIED');
  perform pg_temp.expect('nor rename or edit a season', pg_temp.attempt(vp, format('update seasons set label = ''renamed'' where id = %L', season)), 'DENIED');

  -- ============================================================ starting a season
  perform pg_temp.expect('a label is required', pg_temp.q(pre, 'start_season(E''  \n'', null, null, null, null)'), 'ERROR 23514%');
  perform pg_temp.expect('an unknown category is refused', pg_temp.q(pre, 'start_season(''P4 x'', null, null, ''Hydrogen'', null)'), 'ERROR 23514%');
  perform pg_temp.expect('an unknown regulations edition is refused', pg_temp.q(pre, 'start_season(''P4 x'', null, ''Nope Rev.0'', null, null)'), 'ERROR 23503%');
  perform pg_temp.expect('copying from a season that does not exist is refused', pg_temp.q(pre, format('start_season(''P4 x'', null, null, null, %L)', gen_random_uuid())), 'ERROR P0002%');

  s2 := pg_temp.q(pre, format('(start_season(''P4 2027/28'', ''MotoStudent X'', null, ''Electric'', %L)).id', season))::uuid;
  perform pg_temp.expect('the President starts a season', (s2 is not null)::text, 'true');
  perform pg_temp.expect('... it is NOT current (creating and switching are two steps), and carries what was asked',
    (select (not is_current and category = 'Electric' and edition = 'MotoStudent X' and regs_ref = (select regs_ref from seasons where id = season))::text from seasons where id = s2), 'true');
  perform pg_temp.expect('the same label again (any case) is refused', pg_temp.q(dev, 'start_season(''p4 2027/28'', null, null, null, null)'), 'ERROR 23505%');

  perform pg_temp.expect('every milestone definition was copied, in order, with the SAME label',
    (select count(*)::text from milestones where season_id = s2) || ':' ||
    (select (array_agg(code order by ordinal) = (select array_agg(code order by ordinal) from milestones where season_id = season))::text from milestones where season_id = s2),
    ms_count::text || ':true');
  perform pg_temp.expect('... under keys of their own, so the primary key never collides',
    (select count(distinct key)::text from milestones where season_id in (season, s2)), (ms_count * 2)::text);
  perform pg_temp.expect('no date, submission or acceptance was copied (dates stay TBC)',
    (select count(*)::text from milestones where season_id = s2 and (opens_on is not null or due_on is not null or submitted_on is not null or accepted_on is not null)), '0');
  perform pg_temp.expect('sections and the subsection were copied with the structure, not drafted, not owned',
    (select count(*)::text || ':' || count(*) filter (where parent_section_id is not null)::text || ':' || count(*) filter (where is_drafted or owner_id is not null)::text
       from milestone_sections s join milestones m on m.key = s.milestone_key where m.season_id = s2),
    sec_count::text || ':' || (select count(*)::text from milestone_sections s join milestones m on m.key = s.milestone_key where m.season_id = season and s.parent_section_id is not null) || ':0');
  perform pg_temp.expect('the copied subsection hangs under the COPIED section, in the new milestone',
    (select bool_and(p.milestone_key = c.milestone_key)::text
       from milestone_sections c join milestone_sections p on p.id = c.parent_section_id join milestones m on m.key = c.milestone_key where m.season_id = s2), 'true');
  perform pg_temp.expect('no task, proposal, requirement status, specification, measurement or membership came along',
    (select (select count(*) from tasks where season_id = s2) + (select count(*) from task_proposals where season_id = s2)
          + (select count(*) from clause_status where season_id = s2) + (select count(*) from specs where season_id = s2)
          + (select count(*) from spec_measurements where season_id = s2) + (select count(*) from department_members where season_id = s2))::text, '0');
  select md5(string_agg(to_jsonb(m)::text, '|' order by key)) into src_after from milestones m where season_id = season;
  perform pg_temp.expect('the previous season is byte-for-byte untouched', (src_before = src_after)::text, 'true');
  perform pg_temp.expect('the rollover is audited', (select count(*)::text from activity where entity = 'season' and entity_id = s2::text and action = 'season_started'), '1');

  perform pg_temp.expect('the same label in two seasons is fine; twice in one is refused',
    pg_temp.state_of(format('insert into milestones (key, code, season_id, ordinal, name) values (''PI-X'', ''MS-REUSED'', %L, 98, ''one'')', season)) || ':' ||
    pg_temp.state_of(format('insert into milestones (key, code, season_id, ordinal, name) values (''PI-Y'', ''MS-REUSED'', %L, 97, ''in the other season'')', s2)) || ':' ||
    pg_temp.state_of(format('insert into milestones (key, code, season_id, ordinal, name) values (''PI-Z'', ''MS-REUSED'', %L, 96, ''twice'')', s2)),
    'ALLOWED:ALLOWED:23505');
  insert into milestones (key, season_id, ordinal, name) values ('PI-NOCODE', s2, 95, 'no code');
  perform pg_temp.expect('a milestone with no explicit label shows its key', (select code from milestones where key = 'PI-NOCODE'), 'PI-NOCODE');

  -- ================================================================= switching
  perform pg_temp.expect('the Developer switches to the new season', pg_temp.q(dev, format('set_current_season(%L)', s2)), '');
  perform pg_temp.expect('... exactly one season is current, and it is the new one',
    (select count(*)::text || ':' || bool_and(id = s2)::text from seasons where is_current), '1:true');
  perform pg_temp.expect('... and the President switches back', pg_temp.q(pre, format('set_current_season(%L)', season)), '');
  perform pg_temp.expect('... one current again', (select count(*)::text || ':' || bool_and(id = season)::text from seasons where is_current), '1:true');

  -- ===================================================== cross-season refusals
  insert into seasons (id, label, regs_ref) select sx, 'P4 isolation season', regs_ref from seasons where id = season;
  insert into milestones (key, code, season_id, ordinal, name) values (other_ms, 'OTHER', sx, 1, 'other');
  insert into regulation_documents (regs_ref) values ('P4 OTHER Rev.9');
  insert into clauses (clause_key, printed_ref, section, article, body, obligation, criticality, regs_ref)
    select cl_other, printed_ref, section, article, body, obligation, criticality, 'P4 OTHER Rev.9' from clauses where clause_key = cl;
  insert into tasks (season_id, title, subteam_key) values (season, '[PI] task', pa) returning id into t;
  insert into tasks (season_id, title, subteam_key) values (sx, '[PI] task elsewhere', pa) returning id into t2;
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key)
    values (sx, '[PI] proposal of another season', mem, pa, '2099-01-01', other_ms) returning id into p_other;
  insert into specs (season_id, parameter, comparator, target, direction) values (season, 'PI spec', 'min', 1, 'higher_better') returning id into sp;

  perform pg_temp.expect('a task cannot sit on another season''s milestone', pg_temp.state_of(format('update tasks set milestone_key = %L where id = %L', other_ms, t)), '23514');
  -- Ordinary edits already refuse these columns; the checks below use the internal write flags the
  -- lifecycle commands use, to prove the season rule holds for every writer, not only for edits.
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  perform pg_temp.expect('a task cannot come from another season''s proposal (even for an internal writer)', pg_temp.state_of(format('update tasks set source_proposal = %L where id = %L', p_other, t)), '23514');
  perform set_config('reqon.task_lifecycle_write', 'off', true);
  perform pg_temp.expect('a task cannot be put in a section of another season''s milestone',
    pg_temp.state_of(format('update tasks set section_id = (select id from milestone_sections where milestone_key = %L limit 1) where id = %L',
      (select key from milestones where season_id = s2 order by ordinal limit 1), t)), '23514');
  perform set_config('reqon.proposal_write', 'on', true);
  perform pg_temp.expect('a proposal cannot name another season''s milestone (even for an internal writer)',
    pg_temp.state_of(format('update task_proposals set milestone_key = %L where id = %L', ms, p_other)), '23514');
  perform set_config('reqon.proposal_write', 'off', true);
  perform pg_temp.expect('a task cannot wait for a task of another season',
    pg_temp.state_of(format('insert into task_dependencies (task_id, depends_on_task_id) values (%L, %L)', t, t2)), '23514');
  perform pg_temp.expect('a requirement of another regulations edition cannot get a status in this season',
    pg_temp.state_of(format('insert into clause_status (season_id, clause_key, state) values (%L, %L, ''wip'')', season, cl_other)), '23514');
  perform pg_temp.expect('nor be the requirement behind a specification of this season',
    pg_temp.state_of(format('update specs set clause_key = %L where id = %L', cl_other, sp)), '23514');
  perform pg_temp.expect('nor be cited by a task', pg_temp.state_of(format('insert into task_requirements (task_id, clause_key) values (%L, %L)', t, cl_other)), '23514');
  perform pg_temp.expect('a measurement carries its specification''s season',
    pg_temp.state_of(format('insert into spec_measurements (spec_id, season_id, value_numeric, measured_at) values (%L, %L, 1, now())', sp, sx)), '23514');
  perform pg_temp.expect('a milestone that holds work cannot move to another season',
    pg_temp.state_of(format('insert into tasks (season_id, title, milestone_key) values (%L, ''[PI] on ms'', %L)', season, ms)) || ':' ||
    pg_temp.state_of(format('update milestones set season_id = %L where key = %L', sx, ms)), 'ALLOWED:23514');

  -- ===================================================== history is never dropped
  perform pg_temp.expect('a season that holds work cannot be deleted', pg_temp.state_of(format('delete from seasons where id = %L', season)), '23503');
  perform pg_temp.expect('... not even by the President', pg_temp.attempt(pre, format('delete from seasons where id = %L', sx)), 'ERROR 23503%');

  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into n_total, n_bad, v_report from pg_temp.results;
  if n_bad > 0 then
    raise exception E'SEASON INTEGRITY CHECKS FAILED — % of % checks did not behave as expected.\n%', n_bad, n_total, v_report;
  end if;
  raise exception 'SEASON INTEGRITY CHECKS PASSED — all % checks', n_total;
end
$test$;
