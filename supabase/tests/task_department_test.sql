-- =============================================================================
--  Assigning and moving work between departments (backend completion Phase 2):
--  docs/backend-completion/PERMISSIONS.md §2.2, §2.3; migration 20260126000400.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so
--  every fixture rolls back. Fixture people are new @p2-dept.test identities.
--
--  Result: DEPARTMENT ASSIGNMENT CHECKS PASSED / FAILED.
--
--  Covers set_task_department(): governance (President, VP, Developer) may
--  classify, move and unassign; a Head only between departments they head
--  (including parent <-> subdepartment and two separate headships); owner,
--  member, other Head, subdepartment Head (upward), Treasurer, retired Developer
--  refused; reason required; archived task / archived target / unknown task
--  refused; no-op; owner, state and requirement links preserved; refusals
--  change nothing; the audit row carries the reason; the generic UPDATE path
--  stays closed. set_proposal_department(): author before review, Heads of both,
--  governance; legacy repair; decided/archived/null refused; generic path closed.
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

do $test$
declare
  season uuid;
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid();
  tre uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); alum_dev uuid := gen_random_uuid();
  ha uuid := gen_random_uuid(); hb uuid := gen_random_uuid(); hs uuid := gen_random_uuid(); hm uuid := gen_random_uuid();
  pa text; pb text;
  t1 uuid; t_un uuid; t_arch uuid; t_m uuid; t_g uuid;
  p_legacy uuid; p_review uuid; p_open uuid; p_decided uuid; p_nodept uuid;
  ms text; clause text;
  before_activity bigint;
  total int; bad int; report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into ms from milestones where season_id = season order by ordinal limit 1;
  select clause_key into clause from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season order by clause_key limit 1;
  select key into pa from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select key into pb from subteams where archived_at is null and parent_key is null and key <> pa order by sort_order, key limit 1;

  insert into auth.users (id, email)
  select id, k || '@p2-dept.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (mem, 'mem'),
    (alum_dev, 'alumdev'), (ha, 'ha'), (hb, 'hb'), (hs, 'hs'), (hm, 'hm')) v(id, k);
  insert into members (id, full_name, role, status)
  select id, 'T ' || k, 'Member', case when k = 'alumdev' then 'alumni' else 'active' end::member_state
  from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (mem, 'mem'), (alum_dev, 'alumdev'),
    (ha, 'ha'), (hb, 'hb'), (hs, 'hs'), (hm, 'hm')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'),
    (tre, 'treasurer'), (alum_dev, 'developer');
  update subteams set lead_id = ha where key = pa;
  update subteams set lead_id = hb where key = pb;
  insert into subteams (key, name, parent_key, lead_id) values ('TD_SUB', 'Dept sub', pa, hs);
  insert into subteams (key, name, parent_key, lead_id) values ('TD_M1', 'Dept m1', pa, hm);
  insert into subteams (key, name, parent_key, lead_id) values ('TD_M2', 'Dept m2', pb, hm);
  insert into subteams (key, name, parent_key) values ('TD_ARCH', 'Dept archived', pa);
  update subteams set archived_at = now() where key = 'TD_ARCH';

  insert into tasks (season_id, title, subteam_key, owner_id, state, milestone_key) values (season, 'TD one', pa, mem, 'wip', ms) returning id into t1;
  insert into task_requirements (task_id, clause_key) values (t1, clause);
  insert into tasks (season_id, title, owner_id) values (season, 'TD unassigned', mem) returning id into t_un;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'TD archived', pa, mem) returning id into t_arch;
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks set archived_at = now(), archive_reason = 'manual' where id = t_arch;
  perform set_config('reqon.task_lifecycle_write', 'off', true);
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'TD two headships', 'TD_M1', mem) returning id into t_m;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'TD generic', pa, mem) returning id into t_g;

  -- =================================================== refusals change nothing
  select count(*) into before_activity from activity where entity = 'task' and entity_id = t1::text;
  perform pg_temp.expect('a reason is required', pg_temp.attempt(pre, format('select set_task_department(%L, %L, null)', t1, pb)), 'ERROR 23514%');
  perform pg_temp.expect('a blank reason is refused', pg_temp.attempt(pre, format('select set_task_department(%L, %L, ''   '')', t1, pb)), 'ERROR 23514%');
  perform pg_temp.expect('the owner cannot move their task', pg_temp.attempt(mem, format('select set_task_department(%L, %L, ''mine'')', t1, pb)), 'DENIED');
  perform pg_temp.expect('the target''s Head cannot pull it in', pg_temp.attempt(hb, format('select set_task_department(%L, %L, ''want it'')', t1, pb)), 'DENIED');
  perform pg_temp.expect('the source''s Head cannot push it to a department they do not head', pg_temp.attempt(ha, format('select set_task_department(%L, %L, ''give'')', t1, pb)), 'DENIED');
  perform pg_temp.expect('Treasurer cannot move work', pg_temp.attempt(tre, format('select set_task_department(%L, %L, ''x'')', t1, pb)), 'DENIED');
  perform pg_temp.expect('a retired Developer cannot move work', pg_temp.attempt(alum_dev, format('select set_task_department(%L, %L, ''x'')', t1, pb)), 'DENIED');
  perform pg_temp.expect('a Head cannot unassign work', pg_temp.attempt(ha, format('select set_task_department(%L, null, ''x'')', t1)), 'DENIED');
  perform pg_temp.expect('a Head cannot claim unassigned work', pg_temp.attempt(ha, format('select set_task_department(%L, %L, ''mine now'')', t_un, pa)), 'DENIED');
  perform pg_temp.expect('an archived target department is refused', pg_temp.attempt(pre, format('select set_task_department(%L, ''TD_ARCH'', ''x'')', t1)), 'ERROR 23514%');
  perform pg_temp.expect('an archived task is refused', pg_temp.attempt(pre, format('select set_task_department(%L, %L, ''x'')', t_arch, pb)), 'ERROR 22023%');
  perform pg_temp.expect('an unknown task is refused', pg_temp.attempt(pre, format('select set_task_department(%L, %L, ''x'')', gen_random_uuid(), pb)), 'ERROR 23503%');
  perform pg_temp.expect('after every refusal the task is where it was, with no new audit row',
    (select subteam_key from tasks where id = t1) || '/' ||
    ((select count(*) from activity where entity = 'task' and entity_id = t1::text) = before_activity)::text, pa || '/true');

  -- =================================================================== moves
  perform pg_temp.expect('the parent''s Head moves work into its subdepartment', pg_temp.attempt(ha, format('select set_task_department(%L, ''TD_SUB'', ''belongs to the sub'')', t1)), 'ALLOWED');
  perform pg_temp.expect('the subdepartment Head cannot move it up to the parent', pg_temp.attempt(hs, format('select set_task_department(%L, %L, ''up'')', t1, pa)), 'DENIED');
  perform pg_temp.expect('the parent''s Head moves it back', pg_temp.attempt(ha, format('select set_task_department(%L, %L, ''back'')', t1, pa)), 'ALLOWED');
  perform pg_temp.expect('someone heading two departments moves work between them', pg_temp.attempt(hm, format('select set_task_department(%L, ''TD_M2'', ''rebalance'')', t_m)), 'ALLOWED');
  perform pg_temp.expect('the President moves work between departments with Heads', pg_temp.attempt(pre, format('select set_task_department(%L, %L, ''reorganised'')', t1, pb)), 'ALLOWED');
  perform pg_temp.expect('moving to the same department is a no-op', pg_temp.attempt(pre, format('select set_task_department(%L, %L, ''again'')', t1, pb)), 'ALLOWED');
  perform pg_temp.expect('the Vice President classifies unassigned work', pg_temp.attempt(vp, format('select set_task_department(%L, %L, ''classified'')', t_un, pa)), 'ALLOWED');
  perform pg_temp.expect('a Developer unassigns work', pg_temp.attempt(dev, format('select set_task_department(%L, null, ''misfiled'')', t_un)), 'ALLOWED');
  perform pg_temp.expect('owner, state, milestone and requirement links survive the moves',
    (select (owner_id = mem and state = 'wip' and milestone_key = ms)::text from tasks where id = t1) || '/' ||
    (select count(*)::text from task_requirements where task_id = t1 and clause_key = clause), 'true/1');
  perform pg_temp.expect('audit: every move is one department_transferred row with actor and reason (no row for the no-op)',
    (select count(*)::text from activity where entity = 'task' and entity_id = t1::text and action = 'department_transferred'), '3');
  perform pg_temp.expect('... the President''s row says why',
    (select (actor_id = pre and detail ->> 'from' = pa and detail ->> 'to' = pb and detail ->> 'reason' = 'reorganised')::text
       from activity where entity = 'task' and entity_id = t1::text and action = 'department_transferred' and actor_id = pre), 'true');
  perform pg_temp.expect('... unassigning is recorded with to = null',
    (select (detail -> 'to' = 'null'::jsonb and detail ->> 'reason' = 'misfiled')::text
       from activity where entity = 'task' and entity_id = t_un::text and action = 'department_transferred' and actor_id = dev), 'true');
  perform pg_temp.expect('the reason does not leak into later audit rows',
    (select count(*)::text from activity where entity = 'task' and entity_id = t1::text and action <> 'department_transferred' and detail ? 'reason' and detail ->> 'reason' = 'reorganised'), '0');

  -- ============================================== the generic path stays closed
  perform pg_temp.expect('a Developer still cannot change a department by UPDATE', pg_temp.attempt(dev, format('update tasks set subteam_key = %L where id = %L', pb, t_g)), 'DENIED');
  perform pg_temp.expect('nor the department''s Head', pg_temp.attempt(ha, format('update tasks set subteam_key = %L where id = %L', pb, t_g)), 'DENIED');

  -- =============================================================== proposals
  insert into task_proposals (season_id, title, raised_by, due_date, milestone_key, legacy_incomplete)
    values (season, 'TD legacy', mem, '2026-12-01', ms, true) returning id into p_legacy;
  insert into proposal_requirements (proposal_id, clause_key) values (p_legacy, clause);
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key, state)
    values (season, 'TD under review', mem, pa, '2026-12-01', ms, 'agenda') returning id into p_review;
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key)
    values (season, 'TD open', hb, pa, '2026-12-01', ms) returning id into p_open;
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key, state, outcome)
    values (season, 'TD decided', mem, pa, '2026-12-01', ms, 'decided', 'rejected') returning id into p_decided;

  perform pg_temp.expect('the author gives a legacy proposal its department', pg_temp.attempt(mem, format('select set_proposal_department(%L, %L, ''completing it'', 1)', p_legacy, pa)), 'ALLOWED');
  perform pg_temp.expect('... which repairs it (no longer legacy-incomplete)', (select (not legacy_incomplete and subteam_key = pa)::text from task_proposals where id = p_legacy), 'true');
  perform pg_temp.expect('... audited as department_changed (with reason) and legacy_repaired',
    (select count(*) filter (where action = 'department_changed' and detail ->> 'reason' = 'completing it')::text || '/' ||
            count(*) filter (where action = 'legacy_repaired')::text
       from activity where entity = 'proposal' and entity_id = p_legacy::text), '1/1');
  perform pg_temp.expect('the author cannot move it once under review', pg_temp.attempt(mem, format('select set_proposal_department(%L, %L, ''x'', 1)', p_review, pb)), 'DENIED');
  perform pg_temp.expect('the Head of the source alone cannot move it out', pg_temp.attempt(ha, format('select set_proposal_department(%L, %L, ''x'', 1)', p_review, pb)), 'DENIED');
  perform pg_temp.expect('a Head moves it within their own departments', pg_temp.attempt(ha, format('select set_proposal_department(%L, ''TD_SUB'', ''sub work'', 1)', p_review)), 'ALLOWED');
  -- Role hierarchy (20260130000000) supersedes the Phase 2 fix (20260126000700, fallback only): the
  -- President may move a proposal out of a department that has a Head. Shown with a same-department
  -- "move", which the command answers only for someone who could make the move and which changes nothing.
  perform pg_temp.expect('the President has the authority to move it although a Head exists', pg_temp.attempt(pre, format('select set_proposal_department(%L, %L, ''reorganised'', 2)', p_review, 'TD_SUB')), 'ALLOWED');
  perform pg_temp.expect('... and that changed nothing', (select subteam_key || '/' || revision from task_proposals where id = p_review), 'TD_SUB/2');
  insert into task_proposals (season_id, title, raised_by, due_date, milestone_key, state)
    values (season, 'TD no department', null, '2026-12-01', ms, 'agenda') returning id into p_nodept;
  perform pg_temp.expect('the President classifies a proposal that has no department', pg_temp.attempt(pre, format('select set_proposal_department(%L, %L, ''classified'', 1)', p_nodept, pb)), 'ALLOWED');
  perform pg_temp.expect('a Developer moves one anywhere active', pg_temp.attempt(dev, format('select set_proposal_department(%L, %L, ''reorganised'', 2)', p_review, pb)), 'ALLOWED');
  perform pg_temp.expect('a Treasurer cannot', pg_temp.attempt(tre, format('select set_proposal_department(%L, %L, ''x'', 3)', p_review, pa)), 'DENIED');
  perform pg_temp.expect('the author of an open proposal may move it (before review)', pg_temp.attempt(hb, format('select set_proposal_department(%L, %L, ''wrong department'', 1)', p_open, pb)), 'ALLOWED');
  perform pg_temp.expect('a decided proposal cannot move', pg_temp.attempt(pre, format('select set_proposal_department(%L, %L, ''x'', 1)', p_decided, pb)), 'ERROR 22023%');
  perform pg_temp.expect('a proposal cannot lose its department', pg_temp.attempt(pre, format('select set_proposal_department(%L, null, ''x'', 3)', p_review)), 'ERROR 23502%');
  perform pg_temp.expect('an archived target is refused', pg_temp.attempt(pre, format('select set_proposal_department(%L, ''TD_ARCH'', ''x'', 3)', p_review)), 'ERROR 23514%');
  perform pg_temp.expect('a reason is required', pg_temp.attempt(pre, format('select set_proposal_department(%L, %L, '''', 3)', p_review, pa)), 'ERROR 23514%');
  perform pg_temp.expect('the generic UPDATE path stays Developer-only', pg_temp.attempt(hb, format('update task_proposals set subteam_key = %L where id = %L', pa, p_review)), 'DENIED');

  -- ================================================================= verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'DEPARTMENT ASSIGNMENT CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'DEPARTMENT ASSIGNMENT CHECKS PASSED — all % checks', total;
end
$test$;
