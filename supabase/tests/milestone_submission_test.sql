-- =============================================================================
--  Milestone work, submission and acceptance are three facts (backend completion
--  Phase 4): migration 20260129000200; PERMISSIONS.md §2.1.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every
--  fixture rolls back. Fixture people are new @p4-sub.test identities.
--
--  Result: MILESTONE SUBMISSION CHECKS PASSED / FAILED.
--
--  Covers: who may record (President, Vice President, Developer, Documentation; not a
--  member, Treasurer, retired member or anonymous); order rules (acceptance needs a
--  submission and cannot precede it; no future dates); the recorder is stamped by the server;
--  a retry changes and logs nothing; clearing is allowed and audited; the columns cannot be
--  edited directly, even by an administrator; finishing every linked task records neither a
--  submission nor an acceptance; window and points editing is untouched.
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

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

do $test$
declare
  season uuid;
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid();
  doc uuid := gen_random_uuid(); tre uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); alum uuid := gen_random_uuid();
  ms text; ms_open text;
  today_cph date := (now() at time zone 'Europe/Copenhagen')::date;
  audit_before bigint;
  n_total int; n_bad int; v_report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into ms from milestones where season_id = season order by ordinal limit 1;
  select key into ms_open from milestones where season_id = season and key <> ms order by ordinal limit 1;

  insert into auth.users (id, email)
  select id, k || '@p4-sub.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (doc, 'doc'), (tre, 'tre'), (mem, 'mem'), (alum, 'alum')) v(id, k);
  insert into members (id, full_name, role, status)
  select id, 'S ' || k, 'Member', case when k = 'alum' then 'alumni' else 'active' end::member_state
    from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (doc, 'doc'), (tre, 'tre'), (mem, 'mem'), (alum, 'alum')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'),
    (doc, 'documentation'), (tre, 'treasurer'), (alum, 'developer');

  perform pg_temp.expect('nothing is recorded for any milestone until someone records it',
    (select count(*)::text from milestones where submitted_on is not null or accepted_on is not null or submitted_by is not null or accepted_by is not null), '0');

  perform pg_temp.expect('a member cannot record a submission', pg_temp.attempt(mem, format('select set_milestone_submission(%L, %L, null)', ms, today_cph - 1)), 'DENIED');
  perform pg_temp.expect('nor the Treasurer', pg_temp.attempt(tre, format('select set_milestone_submission(%L, %L, null)', ms, today_cph - 1)), 'DENIED');
  perform pg_temp.expect('nor a retired Developer', pg_temp.attempt(alum, format('select set_milestone_submission(%L, %L, null)', ms, today_cph - 1)), 'DENIED');
  perform pg_temp.expect('nor anonymous', pg_temp.attempt(null, format('select set_milestone_submission(%L, %L, null)', ms, today_cph - 1)), 'DENIED');
  perform pg_temp.expect('an unknown milestone is refused', pg_temp.attempt(pre, 'select set_milestone_submission(''NOPE'', null, null)'), 'ERROR P0002%');

  perform pg_temp.expect('Documentation records a submission', pg_temp.attempt(doc, format('select set_milestone_submission(%L, %L, null)', ms, today_cph - 2)), 'ALLOWED');
  perform pg_temp.expect('... the recorder is stamped by the server, and nothing is accepted',
    (select (submitted_on = today_cph - 2 and submitted_by = doc and accepted_on is null and accepted_by is null)::text from milestones where key = ms), 'true');
  perform pg_temp.expect('... and it is audited', (select count(*)::text || ':' || max(detail ->> 'to') from activity where entity = 'milestone' and entity_id = ms and action = 'submission_changed'), '1:' || (today_cph - 2)::text);

  perform pg_temp.expect('acceptance cannot come before the submission',
    pg_temp.attempt(pre, format('select set_milestone_submission(%L, %L, %L)', ms, today_cph - 2, today_cph - 3)), 'ERROR 23514%');
  perform pg_temp.expect('acceptance without a submission is refused',
    pg_temp.attempt(pre, format('select set_milestone_submission(%L, null, %L)', ms_open, today_cph)), 'ERROR 23514%');
  perform pg_temp.expect('a date in the future is not something that happened',
    pg_temp.attempt(pre, format('select set_milestone_submission(%L, %L, null)', ms_open, today_cph + 30)), 'ERROR 23514%');
  perform pg_temp.expect('the Vice President records the acceptance',
    pg_temp.attempt(vp, format('select set_milestone_submission(%L, %L, %L)', ms, today_cph - 2, today_cph - 1)), 'ALLOWED');
  perform pg_temp.expect('... stamped with the Vice President, the submitter unchanged',
    (select (accepted_on = today_cph - 1 and accepted_by = vp and submitted_by = doc)::text from milestones where key = ms), 'true');

  select count(*) into audit_before from activity where entity = 'milestone' and entity_id = ms;
  perform pg_temp.expect('the same call again is a retry: it succeeds',
    pg_temp.attempt(vp, format('select set_milestone_submission(%L, %L, %L)', ms, today_cph - 2, today_cph - 1)), 'ALLOWED');
  perform pg_temp.expect('... and logs nothing', ((select count(*) from activity where entity = 'milestone' and entity_id = ms) - audit_before)::text, '0');

  perform pg_temp.expect('a submission cannot be cleared while the acceptance stands',
    pg_temp.attempt(dev, format('select set_milestone_submission(%L, null, %L)', ms, today_cph - 1)), 'ERROR 23514%');
  perform pg_temp.expect('the acceptance can be cleared (an honest correction)',
    pg_temp.attempt(dev, format('select set_milestone_submission(%L, %L, null)', ms, today_cph - 2)), 'ALLOWED');
  perform pg_temp.expect('... it is audited, and its stamp is cleared with it',
    (select count(*)::text from activity where entity = 'milestone' and entity_id = ms and action = 'acceptance_changed' and detail ->> 'to' is null)
    || ':' || (select (accepted_by is null)::text from milestones where key = ms), '1:true');

  perform pg_temp.expect('an administrator cannot write the columns directly',
    pg_temp.attempt(pre, format('update milestones set submitted_on = %L where key = %L', today_cph, ms_open)), 'DENIED');
  perform pg_temp.expect('... not even to fabricate an acceptance',
    pg_temp.attempt(dev, format('update milestones set accepted_on = %L, submitted_on = %L where key = %L', today_cph, today_cph, ms_open)), 'DENIED');
  perform pg_temp.expect('editing a window or points still works (the guard is only for the submission columns)',
    pg_temp.attempt(pre, format('update milestones set max_points = max_points where key = %L', ms_open)), 'ALLOWED');

  -- Work completion is a separate fact: finishing everything records nothing.
  insert into tasks (season_id, title, state, milestone_key) values (season, '[SUB] done work', 'done', ms_open);
  perform pg_temp.expect('a milestone whose linked work is all done is still not submitted or accepted',
    (select (submitted_on is null and accepted_on is null)::text from milestones where key = ms_open)
    || ':' || (select coalesce(percent, -1)::text from v_task_progress where season_id = season and scope = 'milestone' and scope_key = ms_open), 'true:100');

  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into n_total, n_bad, v_report from pg_temp.results;
  if n_bad > 0 then
    raise exception E'MILESTONE SUBMISSION CHECKS FAILED — % of % checks did not behave as expected.\n%', n_bad, n_total, v_report;
  end if;
  raise exception 'MILESTONE SUBMISSION CHECKS PASSED — all % checks', n_total;
end
$test$;
