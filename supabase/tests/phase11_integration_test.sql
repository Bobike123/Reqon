-- =============================================================================
-- Phase 11 integration: complete audit dimensions, immutable history, checked
-- link-season context, and durable proposal/task/spec provenance.
-- Every fixture is rolled back by the final deliberate exception.
-- =============================================================================

create or replace function pg_temp.note(
  inout lines text[], inout failures text[], label text, ok boolean, detail text default null
) returns record language plpgsql as $fn$
begin
  ok := coalesce(ok, false);
  lines := lines || format('%s  %s%s', case when ok then 'ok  ' else 'FAIL' end, label,
    case when detail is null then '' else ' — ' || detail end);
  if not ok then
    failures := failures || format('%s%s', label, case when detail is null then '' else ': ' || detail end);
  end if;
end
$fn$;

do $test$
declare
  dev uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  season uuid;
  other_season uuid;
  v_task_id uuid;
  v_proposal_id uuid;
  v_promoted_id uuid;
  v_promoted_task uuid;
  v_spec_id uuid;
  v_measurement_id uuid;
  dept_a text;
  dept_b text;
  clause_a text;
  clause_b text;
  v_section_id uuid;
  ms_a text := 'P11-MS-A';
  ms_b text := 'P11-MS-B';
  n int;
  row_ record;
  lines text[] := '{}';
  failures text[] := '{}';
begin
  insert into auth.users (id, email) values
    (dev, 'p11-dev@audit.test'), (other, 'p11-other@audit.test');
  insert into members (id, full_name, role) values
    (dev, 'Phase Eleven Developer', 'Software'),
    (other, 'Phase Eleven Member', 'Chassis');
  insert into member_roles (member_id, role) values (dev, 'developer');
  insert into seasons (label, is_current) values ('P11-AUDIT', false) returning id into season;
  insert into seasons (label, is_current) values ('P11-AUDIT-OTHER', false) returning id into other_season;
  select key into dept_a from subteams where archived_at is null order by sort_order, key limit 1;
  select key into dept_b from subteams where archived_at is null and key <> dept_a order by sort_order, key limit 1;
  select clause_key into clause_a from clauses order by clause_key limit 1;
  select clause_key into clause_b from clauses where clause_key <> clause_a order by clause_key limit 1;

  insert into milestones (season_id, key, ordinal, name, max_points)
    values (season, ms_a, 1, 'Phase 11 first milestone', 10),
           (season, ms_b, 2, 'Phase 11 second milestone', 20);
  insert into milestone_sections (milestone_key, ordinal, name)
    values (ms_b, 1, 'Phase 11 section') returning id into v_section_id;
  insert into tasks (season_id, title, owner_id, subteam_key, state)
    values (season, 'Phase 11 audited task', dev, dept_a, 'todo') returning id into v_task_id;
  insert into specs (season_id, parameter, comparator, target, unit)
    values (season, 'Phase 11 mass', 'max', 160, 'kg') returning id into v_spec_id;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', dev::text, true);

  -- Task fields and transitions: one row per changed dimension.
     -- Phase 3: entering Blocked now needs a reason or a prerequisite (20260128000100).
  update tasks
     set state = 'blocked', blocked_reason = 'Waiting for the supplier', priority = 'urgent', starts_on = '2026-10-01', due_date = '2026-10-10',
         milestone_key = ms_a
   where id = v_task_id;
  update tasks set state = 'done' where id = v_task_id;
  update tasks set state = 'wip' where id = v_task_id;
  update tasks set milestone_key = ms_b, section_id = v_section_id where id = v_task_id;
  update tasks set section_id = null where id = v_task_id;

  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks set subteam_key = dept_b, owner_id = other where id = v_task_id;
  perform set_config('reqon.task_lifecycle_write', 'off', true);

  perform link_task_requirement(v_task_id, clause_a);
  perform link_task_requirement(v_task_id, clause_b);
  perform unlink_task_requirement(v_task_id, clause_b);

  select count(*) into n from activity
   where entity = 'task' and entity_id = v_task_id::text
     and action in ('state_changed', 'priority_changed', 'starts_on_changed', 'deadline_changed',
                    'completed', 'completion_cleared', 'department_transferred', 'owner_changed',
                    'milestone_changed', 'section_linked', 'section_unlinked',
                    'requirement_linked', 'requirement_unlinked');
  select * into lines, failures from pg_temp.note(lines, failures,
    'task audit covers lifecycle, dates, priority, ownership, department and every link dimension',
    n = 17, format('found %s rows', n));

  perform 1 from activity
   where entity = 'task' and entity_id = v_task_id::text and action = 'state_changed'
     and detail->>'from' = 'todo' and detail->>'to' = 'blocked';
  select * into lines, failures from pg_temp.note(lines, failures,
    'the blocked transition is explicit old/new structured data', found);

  perform 1 from activity
   where entity = 'task' and entity_id = v_task_id::text and action = 'deadline_changed'
     and detail->>'from' is null and detail->>'to' = '2026-10-10';
  select * into lines, failures from pg_temp.note(lines, failures,
    'deadline movement is its own readable old/new event', found);

  select * into row_ from activity
   where entity = 'task' and entity_id = v_task_id::text and action = 'requirement_unlinked' limit 1;
  select * into lines, failures from pg_temp.note(lines, failures,
    'a requirement unlink keeps season and a durable composite identity',
    row_.season_id = season
      and row_.detail->>'task_id' = v_task_id::text
      and row_.detail->>'clause_key' = clause_b
      and row_.detail->>'link_key' = v_task_id::text || '|' || clause_b);

  perform 1 from task_requirements tr
   where tr.task_id = v_task_id and tr.clause_key = clause_a and tr.season_id = season;
  select * into lines, failures from pg_temp.note(lines, failures,
    'task requirement season is derived from its parent', found);

  begin
    perform set_config('role', 'postgres', true);
    insert into task_requirements (task_id, clause_key, season_id)
      values (v_task_id, clause_b, other_season);
    select * into lines, failures from pg_temp.note(lines, failures,
      'a forged cross-season task link is refused', false, 'insert succeeded');
  exception when check_violation then
    select * into lines, failures from pg_temp.note(lines, failures,
      'a forged cross-season task link is refused', true);
  end;
  perform set_config('role', 'authenticated', true);

  -- Proposal review/archive and promotion are distinct, linked events.
  select (submit_proposal(
    p_season_id => season, p_title => 'Phase 11 rejected proposal', p_subteam_key => dept_a,
    p_due_date => '2026-11-01', p_milestone_key => ms_a, p_clause_keys => array[clause_a]
  )).id into v_proposal_id;
  perform review_proposal(v_proposal_id, 'review', 1);
  perform review_proposal(v_proposal_id, 'reject', 1);

  select (submit_proposal(
    p_season_id => season, p_title => 'Phase 11 promoted proposal', p_subteam_key => dept_a,
    p_due_date => '2026-11-02', p_milestone_key => ms_a, p_clause_keys => array[clause_a]
  )).id into v_promoted_id;
  perform approve_proposal(v_promoted_id, 1, 'Phase 11 fixture approval');
  select (p.task).id into v_promoted_task from promote_proposal(v_promoted_id, season) p;

  perform 1 from proposal_requirements pr
   where pr.proposal_id = v_proposal_id and pr.clause_key = clause_a and pr.season_id = season;
  select * into lines, failures from pg_temp.note(lines, failures,
    'proposal requirement season is derived from its parent', found);

  perform 1 from activity
   where entity = 'proposal' and entity_id = v_proposal_id::text and action = 'archived'
     and detail->>'reason' = 'rejected' and detail->>'to' is not null;
  select * into lines, failures from pg_temp.note(lines, failures,
    'proposal rejection records an explicit archive event and reason', found);

  perform 1 from activity
   where entity = 'proposal' and entity_id = v_promoted_id::text and action = 'promoted'
     and detail->>'task_id' = v_promoted_task::text;
  select * into lines, failures from pg_temp.note(lines, failures,
    'proposal promotion keeps the created task identity as provenance', found);

  perform 1 from activity
   where entity = 'proposal' and entity_id = v_promoted_id::text and action = 'archived'
     and detail->>'reason' = 'promoted';
  select * into lines, failures from pg_temp.note(lines, failures,
    'promotion also records the proposal archive transition', found);

  -- Global department Head history remains global; milestone dates are seasonal.
  update subteams set lead_id = other where key = dept_a;
  perform 1 from activity
   where entity = 'department' and entity_id = dept_a and action = 'head_changed'
     and season_id is null and actor_id = dev and detail->>'to' = other::text;
  select * into lines, failures from pg_temp.note(lines, failures,
    'department Head changes remain identifiable global events', found);

  update milestones set opens_on = '2026-10-01', due_on = '2026-10-31' where key = ms_a;
  perform 1 from activity
   where entity = 'milestone' and entity_id = ms_a and action = 'configuration_changed'
     and season_id = season and actor_id = dev
     and detail->'due_on'->>'to' = '2026-10-31';
  select * into lines, failures from pg_temp.note(lines, failures,
    'milestone window/deadline changes keep actor, season and old/new values', found);

  -- Engineering history stays structured; activity links to its identities.
  select (record_spec_measurement(
    p_season_id => season, p_spec_id => v_spec_id, p_request_id => gen_random_uuid(),
    p_value_numeric => 153.2, p_source => 'Phase 11 fixture'
  )).id into v_measurement_id;
  perform correct_spec_measurement(
    p_measurement_id => v_measurement_id, p_reason => 'Calibration correction',
    p_request_id => gen_random_uuid(), p_value_numeric => 152.8
  );
  perform 1 from activity
   where entity = 'spec' and entity_id = v_spec_id::text and action = 'measurement_corrected'
     and detail->>'corrects' = v_measurement_id::text
     and detail->>'reason' = 'Calibration correction';
  select * into lines, failures from pg_temp.note(lines, failures,
    'measurement correction activity points to the preserved observation and reason', found);

  -- API sessions can read but can never mutate the audit trail.
  begin
    update activity set action = 'forged' where entity = 'task' and entity_id = v_task_id::text;
    get diagnostics n = row_count;
    select * into lines, failures from pg_temp.note(lines, failures,
      'an authenticated member cannot update activity', n = 0, format('%s changed', n));
  exception when insufficient_privilege then
    select * into lines, failures from pg_temp.note(lines, failures,
      'an authenticated member cannot update activity', true);
  end;

  begin
    delete from activity where entity = 'task' and entity_id = v_task_id::text;
    get diagnostics n = row_count;
    select * into lines, failures from pg_temp.note(lines, failures,
      'an authenticated member cannot delete activity', n = 0, format('%s deleted', n));
  exception when insufficient_privilege then
    select * into lines, failures from pg_temp.note(lines, failures,
      'an authenticated member cannot delete activity', true);
  end;

  select count(*) into n from activity
   where (entity_id in (v_task_id::text, v_proposal_id::text, v_promoted_id::text, v_spec_id::text)
          or (entity = 'department' and entity_id = dept_a))
     and detail::text ~* '(password|token|secret|jwt|bearer|service_role|phone|skills|member_notes)';
  select * into lines, failures from pg_temp.note(lines, failures,
    'Phase 11 audit payloads contain no secret or private-roster fields', n = 0,
    format('%s suspect row(s)', n));

  if array_length(failures, 1) > 0 then
    raise exception E'PHASE ELEVEN INTEGRATION CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'PHASE ELEVEN INTEGRATION CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
