-- =============================================================================
--  Proposal commands and traceability links (20260117000000).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything happens inside one block
--  that always ends by raising an exception, so Postgres rolls every change
--  back. The result arrives as an "error" beginning
--      PROPOSAL COMMAND CHECKS PASSED   or   PROPOSAL COMMAND CHECKS FAILED
--
--  Covers: submit_proposal validation (every required field, each refusal on
--  its own), direct-write closure, review/park/reject/reopen and the
--  approved/rejected outcome, department-scoped authorization, requirement
--  links (many-to-many, duplicates, last-link protection, audit), the
--  milestone/section rules, legacy proposals and their repair, promotion
--  rollback after a forced link failure, and the department archive guard.
--  Real concurrency (two sessions, and promotion racing a Head change) is in
--  scripts/verify_db.sh.
-- =============================================================================

-- Runs one statement as `who` (an authenticated session) and reports 'ok' or
-- the SQLSTATE it failed with. A failed statement's own effects roll back (it
-- runs in an inner block); the session goes back to the superuser afterwards.
create or replace function pg_temp.act(who uuid, stmt text) returns text
language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt;
    r := 'ok';
  exception when others then
    r := sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $fn$;

-- Same, but returns the statement's first column as text ('E:<sqlstate>' on failure).
create or replace function pg_temp.val(who uuid, stmt text) returns text
language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt into r;
  exception when others then
    r := 'E:' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $fn$;

create temp table results (n serial, label text, ok boolean, detail text);
create or replace function pg_temp.chk(label text, ok boolean, detail text default null) returns void
language plpgsql as $fn$
begin
  insert into results (label, ok, detail) values (label, coalesce(ok, false), detail);
end $fn$;

do $test$
declare
  dev uuid := gen_random_uuid();   -- Developer
  pre uuid := gen_random_uuid();   -- President (no proposal power)
  hd  uuid := gen_random_uuid();   -- Head of department A
  hd2 uuid := gen_random_uuid();   -- Head of department B
  mem uuid := gen_random_uuid();   -- ordinary member
  own uuid := gen_random_uuid();   -- owns tasks
  alum uuid := gen_random_uuid();  -- alumnus
  sA uuid; sB uuid;
  dA text; dB text; dC text;
  c text[]; c1 text; c2 text; c3 text; c4 text;
  p uuid; p3 uuid; p_leg uuid; p_leg2 uuid; p_block uuid;
  t1 uuid; t2 uuid; t3 uuid; t_leg uuid; t_sec uuid;
  secA1 uuid; secA2 uuid; secB1 uuid;
  r text; a1 bigint; a2 bigint;
  row_ record;
  bad text;
  manifest text;
  nfail int; ntotal int;
  q1 text;
  q2 text;
begin
  insert into auth.users (id, email) values
    (dev,'pc-dev@t.test'),(pre,'pc-pre@t.test'),(hd,'pc-hd@t.test'),(hd2,'pc-hd2@t.test'),
    (mem,'pc-mem@t.test'),(own,'pc-own@t.test'),(alum,'pc-alum@t.test');
  insert into members (id, full_name, role, status) values
    (dev,'PC Dev','Software','active'),(pre,'PC Pre','Lead','active'),(hd,'PC Head','Chassis','active'),
    (hd2,'PC Head2','Chassis','active'),(mem,'PC Member','Chassis','active'),(own,'PC Owner','Chassis','active'),
    (alum,'PC Alum','Chassis','alumni');
  insert into member_roles (member_id, role) values (dev,'developer'),(pre,'president');

  insert into seasons (label, is_current) values ('PC-A', false) returning id into sA;
  insert into seasons (label, is_current) values ('PC-B', false) returning id into sB;
  insert into milestones (key, season_id, ordinal, name) values
    ('PC-A1', sA, 1, 'A one'), ('PC-A2', sA, 2, 'A two'), ('PC-B1', sB, 1, 'B one');
  insert into milestone_sections (milestone_key, ordinal, name) values ('PC-A1', 1, 'Sec A1') returning id into secA1;
  insert into milestone_sections (milestone_key, ordinal, name) values ('PC-A2', 1, 'Sec A2') returning id into secA2;
  insert into milestone_sections (milestone_key, ordinal, name) values ('PC-B1', 1, 'Sec B1') returning id into secB1;

  -- Departments with no active tasks or open proposals, so the archive guard
  -- test is about the proposals this file creates.
  select array_agg(key order by sort_order, key) into c from (
    select s.key, s.sort_order from subteams s
     where s.archived_at is null
       and not exists (select 1 from tasks t where t.subteam_key = s.key and t.state not in ('done','cancelled'))
       and not exists (select 1 from task_proposals q where q.subteam_key = s.key and q.archived_at is null and q.state <> 'decided')
     order by s.sort_order, s.key limit 3) x;
  dA := c[1]; dB := c[2]; dC := c[3];
  update subteams set lead_id = hd where key = dA;
  update subteams set lead_id = hd2 where key = dB;

  select array_agg(clause_key order by clause_key) into c from (select clause_key from clauses order by clause_key limit 4) x;
  c1 := c[1]; c2 := c[2]; c3 := c[3]; c4 := c[4];

  -- ================================================================ SUBMIT
  r := pg_temp.val(mem, format('select (submit_proposal(%L, %L, %L, %L::date, %L, %L::text[], %L)).id::text',
        sA, '  Trimmed title  ', dA, '2026-12-01', 'PC-A1', array[c1, c2, c1]::text[], 'because'));
  perform pg_temp.chk('an active member can submit a complete proposal', r is not null and r !~ '^E:', r);
  p := r::uuid;
  perform pg_temp.chk('the title is trimmed', (select title from task_proposals where id = p) = 'Trimmed title');
  perform pg_temp.chk('the author is the caller, set by auth.uid()', (select raised_by from task_proposals where id = p) = mem);
  perform pg_temp.chk('priority defaults to normal, state to open, description kept',
    (select priority::text || state::text || context from task_proposals where id = p) = 'normalopenbecause');
  perform pg_temp.chk('duplicate requirement keys are stored once', (select count(*) from proposal_requirements where proposal_id = p) = 2);
  perform pg_temp.chk('a new proposal is not flagged legacy', not (select legacy_incomplete from task_proposals where id = p));
  perform pg_temp.chk('submission writes one submitted activity row by the author',
    (select count(*) from activity where entity = 'proposal' and entity_id = p::text and action = 'submitted' and actor_id = mem) = 1);

  select count(*) into a1 from task_proposals;
  perform pg_temp.chk('empty title refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', sA, '   ', dA, '2026-12-01', 'PC-A1', array[c1])) = 'E:23514');
  perform pg_temp.chk('title over 200 characters refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', sA, repeat('x', 201), dA, '2026-12-01', 'PC-A1', array[c1])) = 'E:23514');
  perform pg_temp.chk('missing department refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, null, %L::date, %L, %L::text[])::text', sA, 'T', '2026-12-01', 'PC-A1', array[c1])) = 'E:23502');
  perform pg_temp.chk('unknown department refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', sA, 'T', 'NO_SUCH_DEPT', '2026-12-01', 'PC-A1', array[c1])) = 'E:23514');
  perform pg_temp.chk('missing deadline refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, null, %L, %L::text[])::text', sA, 'T', dA, 'PC-A1', array[c1])) = 'E:23502');
  perform pg_temp.chk('missing milestone refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, null, %L::text[])::text', sA, 'T', dA, '2026-12-01', array[c1])) = 'E:23514');
  perform pg_temp.chk('a milestone from another season refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', sA, 'T', dA, '2026-12-01', 'PC-B1', array[c1])) = 'E:23514');
  perform pg_temp.chk('null requirement list refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, null)::text', sA, 'T', dA, '2026-12-01', 'PC-A1')) = 'E:23514');
  perform pg_temp.chk('empty requirement list refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', sA, 'T', dA, '2026-12-01', 'PC-A1', '{}'::text[])) = 'E:23514');
  perform pg_temp.chk('an unknown requirement refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', sA, 'T', dA, '2026-12-01', 'PC-A1', array['NOT-A-CLAUSE'])) = 'E:23503');
  perform pg_temp.chk('an explicit null priority refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[], null, null)::text', sA, 'T', dA, '2026-12-01', 'PC-A1', array[c1])) = 'E:23502');
  perform pg_temp.chk('an invalid priority value refused', pg_temp.act(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[], null, ''critical'')', sA, 'T', dA, '2026-12-01', 'PC-A1', array[c1])) <> 'ok');
  perform pg_temp.chk('an alumnus owner refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[], null, ''normal'', %L)::text', sA, 'T', dA, '2026-12-01', 'PC-A1', array[c1], alum)) = 'E:23514');
  perform pg_temp.chk('an unknown season refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', gen_random_uuid(), 'T', dA, '2026-12-01', 'PC-A1', array[c1])) = 'E:23503');
  perform pg_temp.chk('an alumnus cannot submit', pg_temp.val(alum, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', sA, 'T', dA, '2026-12-01', 'PC-A1', array[c1])) = 'E:42501');
  select count(*) into a2 from task_proposals;
  perform pg_temp.chk('no refused submission left a proposal behind', a1 = a2, format('%s -> %s', a1, a2));
  update subteams set archived_at = now(), archive_reason = 'test' where key = dC;
  perform pg_temp.chk('an archived department refused', pg_temp.val(mem, format('select submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])::text', sA, 'T', dC, '2026-12-01', 'PC-A1', array[c1])) = 'E:23514');
  update subteams set archived_at = null, archive_reason = null where key = dC;
  r := pg_temp.val(mem, format('select (submit_proposal(%L, %L, %L, %L::date, %L, %L::text[], null, ''urgent'', %L)).id::text', sA, 'Owned', dA, '2026-12-01', 'PC-A1', array[c3], own));
  perform pg_temp.chk('an active owner and urgent priority are accepted', r !~ '^E:' and (select owner_id = own and priority = 'urgent' from task_proposals where id = r::uuid), r);
  perform pg_temp.chk('one requirement can serve several proposals', (select count(*) from proposal_requirements where clause_key = c1) >= 1
    and (select count(distinct proposal_id) from proposal_requirements where clause_key in (c1, c2, c3)) >= 2);

  -- ============================================== NO DIRECT WRITE ROUTES
  perform pg_temp.chk('a member cannot insert a proposal directly', pg_temp.act(mem, format('insert into task_proposals (season_id, title, raised_by) values (%L, ''X'', %L)', sA, mem)) <> 'ok');
  perform pg_temp.chk('a member cannot delete a proposal', pg_temp.act(mem, format('delete from task_proposals where id = %L', p)) <> 'ok');
  perform pg_temp.chk('the President cannot delete a proposal', pg_temp.act(pre, format('delete from task_proposals where id = %L', p)) <> 'ok');
  q1 := pg_temp.act(mem, format('update task_proposals set title = ''mine'' where id = %L', p));
  perform pg_temp.chk('the author cannot edit their own proposal (Head or Developer only)',
    q1 = 'ok'
    and (select title from task_proposals where id = p) = 'Trimmed title');
  bad := '';
  for row_ in select unnest(array['state = ''decided''', 'outcome = ''approved''', 'archived_at = now()', 'archive_reason = ''promoted''',
      'legacy_incomplete = true', 'raised_by = ''' || pre || '''', 'season_id = ''' || sB || '''', 'decided_at = now()']) as sett loop
    r := pg_temp.act(hd, format('update task_proposals set %s where id = %L', row_.sett, p));
    if r <> '42501' then bad := bad || row_.sett || '=' || r || '; '; end if;
  end loop;
  perform pg_temp.chk('the Head cannot forge state, outcome, archive, legacy flag, author, season or decided_at', bad = '', bad);
  perform pg_temp.chk('a Head cannot move a proposal to another department', pg_temp.act(hd, format('update task_proposals set subteam_key = %L where id = %L', dB, p)) = '42501');
  q1 := pg_temp.act(hd, format('update task_proposals set title = ''Head edit'', context = ''ctx'', due_date = ''2027-01-05'', priority = ''urgent'', owner_id = %L where id = %L', own, p));
  perform pg_temp.chk('a Head can edit title, description, deadline, priority and owner',
    q1 = 'ok'
    and (select title || priority::text from task_proposals where id = p) = 'Head editurgent');
  perform pg_temp.chk('a Head cannot clear the deadline of a complete proposal', pg_temp.act(hd, format('update task_proposals set due_date = null where id = %L', p)) = '23514');
  perform pg_temp.chk('a Head cannot set a milestone from another season', pg_temp.act(hd, format('update task_proposals set milestone_key = ''PC-B1'' where id = %L', p)) = '23514');
  q1 := pg_temp.act(hd2, format('update task_proposals set title = ''hijack'' where id = %L', p));
  perform pg_temp.chk('the Head of another department cannot edit it',
    q1 = 'ok' and (select title from task_proposals where id = p) = 'Head edit');
  q1 := pg_temp.act(pre, format('update task_proposals set title = ''pres'' where id = %L', p));
  perform pg_temp.chk('the President cannot edit it',
    q1 = 'ok' and (select title from task_proposals where id = p) = 'Head edit');
  q1 := pg_temp.act(dev, format('update task_proposals set title = ''Dev edit'' where id = %L', p));
  perform pg_temp.chk('the Developer can edit it',
    q1 = 'ok' and (select title from task_proposals where id = p) = 'Dev edit');

  -- ======================================================== REVIEW COMMANDS
  perform pg_temp.chk('a member cannot review', pg_temp.val(mem, format('select review_proposal(%L, ''review'')::text', p)) = 'E:42501');
  perform pg_temp.chk('the President cannot review', pg_temp.val(pre, format('select review_proposal(%L, ''review'')::text', p)) = 'E:42501');
  perform pg_temp.chk('the Head of another department cannot review', pg_temp.val(hd2, format('select review_proposal(%L, ''review'')::text', p)) = 'E:42501');
  q1 := pg_temp.act(hd, format('select review_proposal(%L, ''review'')', p));
  perform pg_temp.chk('the Head takes a proposal under review', q1 = 'ok' and (select state::text from task_proposals where id = p) = 'agenda');
  perform pg_temp.chk('review is refused from the wrong state', pg_temp.val(hd, format('select review_proposal(%L, ''review'')::text', p)) = 'E:22023');
  perform pg_temp.chk('an unknown action is refused', pg_temp.val(hd, format('select review_proposal(%L, ''approve'')::text', p)) = 'E:22023');
  q1 := pg_temp.act(hd, format('select review_proposal(%L, ''park'')', p));
  perform pg_temp.chk('the Head parks it', q1 = 'ok' and (select state::text from task_proposals where id = p) = 'parked');
  perform pg_temp.chk('a parked proposal cannot be promoted', pg_temp.val(hd, format('select (promote_proposal(%L, %L)).created::text', p, sA)) = 'E:22023');
  q1 := pg_temp.act(hd, format('select review_proposal(%L, ''reopen'')', p));
  perform pg_temp.chk('the Head reopens a parked proposal', q1 = 'ok' and (select state::text from task_proposals where id = p) = 'open');
  q1 := pg_temp.act(hd, format('select review_proposal(%L, ''reject'')', p));
  perform pg_temp.chk('the Head rejects it: decided, outcome rejected, archived by the Head, no task',
    q1 = 'ok'
    and (select state::text || outcome::text || archive_reason || (archived_at is not null)::text || coalesce(archived_by::text, '') from task_proposals where id = p) = 'decidedrejectedrejectedtrue' || hd::text
    and not exists (select 1 from tasks where source_proposal = p));
  perform pg_temp.chk('rejection is a machine-readable outcome, not free text', (select decision from task_proposals where id = p) is null);
  perform pg_temp.chk('a rejected proposal cannot be promoted until reopened', pg_temp.val(hd, format('select (promote_proposal(%L, %L)).created::text', p, sA)) = 'E:22023');
  perform pg_temp.chk('an archived proposal cannot be edited', pg_temp.act(hd, format('update task_proposals set title = ''x'' where id = %L', p)) = '42501');
  perform pg_temp.chk('rejection is audited with its outcome',
    (select count(*) from activity where entity = 'proposal' and entity_id = p::text and action = 'outcome_changed' and detail->>'to' = 'rejected') = 1
    and (select count(*) from activity where entity = 'proposal' and entity_id = p::text and action = 'archived' and detail->>'reason' = 'rejected') = 1);
  q1 := pg_temp.act(hd, format('select review_proposal(%L, ''reopen'')', p));
  perform pg_temp.chk('the Head reopens a rejected proposal (outcome and archive cleared)',
    q1 = 'ok'
    and (select state::text || coalesce(outcome::text, '-') || coalesce(archived_at::text, '-') from task_proposals where id = p) = 'open--');
  perform pg_temp.chk('a direct UPDATE of state is refused even for the Developer', pg_temp.act(dev, format('update task_proposals set state = ''decided'' where id = %L', p)) = '42501');

  -- ======================================================== PROMOTION (happy)
  perform pg_temp.chk('the Developer may promote any department''s proposal', pg_temp.val(dev, format('select (promote_proposal(%L, %L)).created::text', p, sA)) = 'true');
  select id into t1 from tasks where source_proposal = p;
  perform pg_temp.chk('the promoted task keeps its milestone and department and is links_required',
    (select links_required and milestone_key = 'PC-A1' and subteam_key = dA from tasks where id = t1));
  perform pg_temp.chk('the promoted task received both requirement links', (select count(*) from task_requirements where task_id = t1) = 2);

  -- ============================================ REQUIREMENT LINKS (tasks)
  insert into tasks (season_id, title, owner_id, subteam_key) values (sA, 'Legacy task', own, dA) returning id into t_leg;
  insert into tasks (season_id, title, owner_id, subteam_key) values (sA, 'Second task', own, dA) returning id into t2;
  perform pg_temp.chk('the owner links a requirement', pg_temp.val(own, format('select link_task_requirement(%L, %L)::text', t_leg, c1)) = 'true');
  q1 := pg_temp.val(own, format('select link_task_requirement(%L, %L)::text', t_leg, c1));
  perform pg_temp.chk('linking the same pair again adds nothing (returns false)',
    q1 = 'false' and (select count(*) from task_requirements where task_id = t_leg) = 1);
  perform pg_temp.chk('the Head of the task''s department links one too', pg_temp.val(hd, format('select link_task_requirement(%L, %L)::text', t_leg, c2)) = 'true');
  q1 := pg_temp.val(own, format('select link_task_requirement(%L, %L)::text', t2, c1));
  perform pg_temp.chk('one requirement serves many tasks (many-to-many)',
    q1 = 'true'
    and (select count(*) from task_requirements where clause_key = c1 and task_id in (t_leg, t2)) = 2);
  perform pg_temp.chk('a stranger cannot link', pg_temp.val(mem, format('select link_task_requirement(%L, %L)::text', t_leg, c3)) = 'E:42501');
  perform pg_temp.chk('the President alone cannot link', pg_temp.val(pre, format('select link_task_requirement(%L, %L)::text', t_leg, c3)) = 'E:42501');
  perform pg_temp.chk('an unknown requirement cannot be linked', pg_temp.val(own, format('select link_task_requirement(%L, ''NOPE'')::text', t_leg)) = 'E:23503');
  begin
    insert into task_requirements (task_id, clause_key) values (t_leg, c1);
    perform pg_temp.chk('the database itself refuses a duplicate pair', false, 'no exception');
  exception when unique_violation then
    perform pg_temp.chk('the database itself refuses a duplicate pair', true);
  end;
  perform pg_temp.chk('members cannot write task_requirements directly', pg_temp.act(own, format('insert into task_requirements (task_id, clause_key) values (%L, %L)', t_leg, c4)) <> 'ok');
  q1 := pg_temp.act(own, format('delete from task_requirements where task_id = %L', t_leg));
  perform pg_temp.chk('members cannot delete task_requirements directly',
    q1 <> 'ok'
    and (select count(*) from task_requirements where task_id = t_leg) = 2);
  perform pg_temp.chk('linking is audited', (select count(*) from activity where entity = 'task' and entity_id = t_leg::text and action = 'requirement_linked') = 2);
  perform pg_temp.chk('the owner unlinks a requirement (not the last, legacy task)', pg_temp.val(own, format('select unlink_task_requirement(%L, %L)::text', t_leg, c2)) = 'true');
  perform pg_temp.chk('unlinking twice reports false and changes nothing', pg_temp.val(own, format('select unlink_task_requirement(%L, %L)::text', t_leg, c2)) = 'false');
  perform pg_temp.chk('unlinking keeps the task, the clause and the earlier link event',
    exists (select 1 from tasks where id = t_leg) and exists (select 1 from clauses where clause_key = c2)
    and (select count(*) from activity where entity = 'task' and entity_id = t_leg::text and action = 'requirement_linked' and detail->>'clause_key' = c2) = 1
    and (select count(*) from activity where entity = 'task' and entity_id = t_leg::text and action = 'requirement_unlinked' and detail->>'clause_key' = c2) = 1);
  perform pg_temp.chk('a legacy task may drop its last requirement', pg_temp.val(own, format('select unlink_task_requirement(%L, %L)::text', t_leg, c1)) = 'true');

  select count(*) into a1 from task_requirements where task_id = t1;
  q1 := pg_temp.val(hd, format('select unlink_task_requirement(%L, %L)::text', t1, c2));
  perform pg_temp.chk('promoted work can drop a requirement while another remains', a1 = 2 and q1 = 'true');
  q1 := pg_temp.val(hd, format('select unlink_task_requirement(%L, %L)::text', t1, c1));
  perform pg_temp.chk('the LAST requirement of promoted work cannot be unlinked',
    q1 = 'E:23514' and (select count(*) from task_requirements where task_id = t1) = 1);
  begin
    delete from task_requirements where task_id = t1;
    set constraints all immediate;
    perform pg_temp.chk('a direct delete of the last link is refused by the constraint trigger', false, 'no exception');
  exception when check_violation then
    perform pg_temp.chk('a direct delete of the last link is refused by the constraint trigger', true);
  end;
  set constraints all deferred;

  -- ======================================= MILESTONE / SECTION CONSISTENCY
  insert into tasks (season_id, title, section_id, owner_id) values (sA, 'Sectioned', secA1, own) returning id into t_sec;
  perform pg_temp.chk('linking only a section fills the milestone in', (select milestone_key from tasks where id = t_sec) = 'PC-A1');
  begin
    insert into tasks (season_id, title, section_id) values (sA, 'Wrong season', secB1);
    perform pg_temp.chk('a section from another season is refused', false, 'no exception');
  exception when check_violation then
    perform pg_temp.chk('a section from another season is refused', true);
  end;
  begin
    update tasks set milestone_key = 'PC-A2' where id = t_sec;
    perform pg_temp.chk('changing the milestone while the section points elsewhere is refused', false, 'no exception');
  exception when check_violation then
    perform pg_temp.chk('changing the milestone while the section points elsewhere is refused', true);
  end;
  update tasks set milestone_key = 'PC-A2', section_id = null where id = t_sec;
  perform pg_temp.chk('changing the milestone and clearing the section together is accepted',
    (select milestone_key from tasks where id = t_sec) = 'PC-A2' and (select section_id from tasks where id = t_sec) is null);
  update tasks set milestone_key = 'PC-A1', section_id = secA1 where id = t_sec;
  perform pg_temp.chk('changing the milestone and reassigning the section together is accepted', (select milestone_key from tasks where id = t_sec) = 'PC-A1');
  begin
    update tasks set milestone_key = 'PC-B1', section_id = null where id = t_sec;
    perform pg_temp.chk('a milestone from another season is refused for a task', false, 'no exception');
  exception when check_violation then
    perform pg_temp.chk('a milestone from another season is refused for a task', true);
  end;
  q1 := pg_temp.act(own, format('update tasks set section_id = null where id = %L', t_sec));
  perform pg_temp.chk('the owner relinks a section by the Board''s rule and the milestone stays',
    q1 = 'ok'
    and (select section_id from tasks where id = t_sec) is null and (select milestone_key from tasks where id = t_sec) = 'PC-A1');
  q1 := pg_temp.act(mem, format('update tasks set section_id = %L where id = %L', secA1, t_sec));
  perform pg_temp.chk('a stranger cannot relink a section',
    q1 = 'ok' and (select section_id from tasks where id = t_sec) is null);
  q1 := pg_temp.act(hd, format('update tasks set section_id = %L where id = %L', secA1, t1));
  q2 := pg_temp.act(hd, format('update tasks set section_id = null where id = %L', t1));
  perform pg_temp.chk('unlinking a section leaves a promoted task''s milestone in place',
    q1 = 'ok'
    and q2 = 'ok'
    and (select milestone_key from tasks where id = t1) = 'PC-A1');
  perform pg_temp.chk('a promoted task cannot lose its milestone', pg_temp.act(hd, format('update tasks set milestone_key = null where id = %L', t1)) = '23514');
  perform pg_temp.chk('links_required cannot be turned off by an ordinary edit', pg_temp.act(hd, format('update tasks set links_required = false where id = %L', t1)) = '42501');
  update tasks set section_id = secA1 where id = t_sec;
  begin
    update milestone_sections set milestone_key = 'PC-A2' where id = secA1;
    perform pg_temp.chk('a section cannot be re-parented while tasks reference it', false, 'no exception');
  exception when check_violation then
    perform pg_temp.chk('a section cannot be re-parented while tasks reference it', true);
  end;
  begin
    delete from milestone_sections where id = secA1;
    perform pg_temp.chk('a section with tasks cannot be deleted (no silent unlink)', false, 'no exception');
  exception when foreign_key_violation then
    perform pg_temp.chk('a section with tasks cannot be deleted (no silent unlink)', true);
  end;

  -- ====================================================== LEGACY PROPOSALS
  insert into task_proposals (season_id, title, raised_by, legacy_incomplete, state, decision)
    values (sA, 'Old incomplete', mem, true, 'agenda', 'discussed') returning id into p_leg;
  insert into task_proposals (season_id, title, raised_by, legacy_incomplete, subteam_key)
    values (sA, 'Old with department', mem, true, dA) returning id into p_leg2;
  perform pg_temp.chk('a legacy proposal stays readable', pg_temp.val(mem, format('select title from task_proposals where id = %L', p_leg)) = 'Old incomplete');
  perform pg_temp.chk('a Head cannot promote a legacy proposal that has no department', pg_temp.val(hd, format('select (promote_proposal(%L, %L)).created::text', p_leg, sA)) = 'E:42501');
  perform pg_temp.chk('even the Developer cannot promote a legacy proposal while it is incomplete', pg_temp.val(dev, format('select (promote_proposal(%L, %L)).created::text', p_leg, sA)) = 'E:22023');
  q1 := pg_temp.act(hd, format('update task_proposals set subteam_key = %L where id = %L', dA, p_leg));
  perform pg_temp.chk('a Head cannot supply the missing department',
    q1 = 'ok' and (select subteam_key from task_proposals where id = p_leg) is null);
  q1 := pg_temp.act(dev, format('update task_proposals set subteam_key = %L where id = %L', dA, p_leg));
  perform pg_temp.chk('the Developer supplies the department',
    q1 = 'ok' and (select subteam_key from task_proposals where id = p_leg) = dA);
  perform pg_temp.chk('a legacy proposal with a department but no details is still not promotable', pg_temp.val(hd, format('select (promote_proposal(%L, %L)).created::text', p_leg2, sA)) = 'E:22023');
  q1 := pg_temp.act(hd, format('update task_proposals set due_date = ''2027-02-01'', milestone_key = ''PC-A1'' where id = %L', p_leg2));
  perform pg_temp.chk('the Head supplies deadline and milestone, the flag stays until a requirement exists',
    q1 = 'ok'
    and (select legacy_incomplete from task_proposals where id = p_leg2));
  perform pg_temp.chk('an empty requirement list does not repair it', pg_temp.act(hd, format('select set_proposal_requirements(%L, ''{}'')', p_leg2)) = '23514');
  q1 := pg_temp.act(hd, format('select set_proposal_requirements(%L, array[%L])', p_leg2, c4));
  perform pg_temp.chk('the Head supplies a requirement: the flag clears and a repair event is written',
    q1 = 'ok'
    and not (select legacy_incomplete from task_proposals where id = p_leg2)
    and (select count(*) from activity where entity = 'proposal' and entity_id = p_leg2::text and action = 'legacy_repaired') = 1);
  perform pg_temp.chk('the repaired proposal can now be promoted', pg_temp.val(hd, format('select (promote_proposal(%L, %L)).created::text', p_leg2, sA)) = 'true');
  perform pg_temp.chk('the President and a member cannot change requirements',
    pg_temp.act(pre, format('select set_proposal_requirements(%L, array[%L])', p_leg, c1)) = '42501'
    and pg_temp.act(mem, format('select set_proposal_requirements(%L, array[%L])', p_leg, c1)) = '42501');

  -- ========================================= ROLLBACK AFTER A FORCED FAILURE
  r := pg_temp.val(mem, format('select (submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])).id::text', sA, 'Will fail to promote', dA, '2026-12-01', 'PC-A1', array[c3]));
  p3 := r::uuid;
  create function public.zz_force_link_failure() returns trigger language plpgsql as $f$
  begin raise exception 'forced link failure' using errcode = 'P0001'; end $f$;
  execute format('create trigger zz_force_link_failure before insert on task_requirements for each row when (new.clause_key = %L) execute function public.zz_force_link_failure()', c3);
  select count(*) into a1 from activity where entity_id = p3::text or (detail->>'proposal_id') = p3::text;
  perform pg_temp.chk('a forced link failure aborts promotion', pg_temp.val(hd, format('select (promote_proposal(%L, %L)).created::text', p3, sA)) = 'E:P0001');
  select count(*) into a2 from activity where entity_id = p3::text or (detail->>'proposal_id') = p3::text;
  perform pg_temp.chk('...and rolls back the task, its links, the proposal state and the audit rows together',
    not exists (select 1 from tasks where source_proposal = p3)
    and (select state::text || coalesce(outcome::text, '-') || coalesce(archived_at::text, '-') from task_proposals where id = p3) = 'open--'
    and a1 = a2, format('activity %s -> %s', a1, a2));
  drop trigger zz_force_link_failure on task_requirements;
  drop function public.zz_force_link_failure();
  perform pg_temp.chk('once the fault is gone the same promotion succeeds', pg_temp.val(hd, format('select (promote_proposal(%L, %L)).created::text', p3, sA)) = 'true');
  q1 := pg_temp.val(hd, format('select (promote_proposal(%L, %L)).created::text', p3, sA));
  perform pg_temp.chk('a double click returns the same task and does not create a second',
    q1 = 'false'
    and (select count(*) from tasks where source_proposal = p3) = 1);

  -- ============================================== AUDIT / PROVENANCE
  select id into t3 from tasks where source_proposal = p3;
  perform pg_temp.chk('promotion writes promoted, created_from_proposal and an approved state change, all by the Head',
    (select count(*) from activity where entity = 'proposal' and entity_id = p3::text and action = 'promoted' and actor_id = hd) = 1
    and (select count(*) from activity where entity = 'task' and entity_id = t3::text and action = 'created_from_proposal' and actor_id = hd) = 1
    and (select count(*) from activity where entity = 'proposal' and entity_id = p3::text and action = 'outcome_changed' and detail->>'to' = 'approved') = 1);
  perform pg_temp.chk('provenance survives: the task points at the archived, approved proposal',
    (select source_proposal from tasks where id = t3) = p3 and (select archive_reason || outcome::text from task_proposals where id = p3) = 'promotedapproved');
  perform pg_temp.chk('an approved proposal cannot be reopened', pg_temp.val(hd, format('select review_proposal(%L, ''reopen'')::text', p3)) = 'E:22023');
  perform pg_temp.chk('no path deletes a promoted proposal, so the task keeps its provenance', pg_temp.act(dev, format('delete from task_proposals where id = %L', p3)) <> 'ok');
  -- Phase 11 gives each junction its own checked, derived season_id (so a
  -- realtime DELETE can be filtered without a parent-row lookup); see
  -- phase11_integration_test.sql for the derivation and forgery checks.
  perform pg_temp.chk('the requirement link tables carry season_id derived from their owning record',
    (select tr.season_id from task_requirements tr where tr.task_id = t1 limit 1) = sA);

  -- ================================================ DEPARTMENT ARCHIVE GUARD
  r := pg_temp.val(mem, format('select (submit_proposal(%L, %L, %L, %L::date, %L, %L::text[])).id::text', sA, 'Blocks archive', dC, '2026-12-01', 'PC-A1', array[c1]));
  p_block := r::uuid;
  perform pg_temp.chk('a department with an unresolved proposal cannot be archived',
    pg_temp.act(pre, format('update subteams set archived_at = now(), archive_reason = ''x'' where key = %L', dC)) = '23514');
  manifest := format('{"departments":[{"key":"%s","action":"archive"}]}', dC);
  q1 := pg_temp.val(pre, format('select ok::text || ''|'' || unresolved_proposals::text from reconciliation_preflight(%L::jsonb) where key = %L', manifest, dC));
  perform pg_temp.chk('reconciliation preflight counts and refuses the unresolved proposal', q1 = 'false|1', q1);
  perform pg_temp.act(dev, format('select review_proposal(%L, ''reject'')', p_block));
  q1 := pg_temp.act(pre, format('update subteams set archived_at = now(), archive_reason = ''x'' where key = %L', dC));
  perform pg_temp.chk('once the proposal is resolved the department can be archived',
    q1 = 'ok'
    and (select archived_at is not null from subteams where key = dC));

  -- every promoted task still satisfies its required links at "commit"
  begin
    set constraints all immediate;
    perform pg_temp.chk('every deferred link check passes for every task created in this test', true);
  exception when others then
    perform pg_temp.chk('every deferred link check passes for every task created in this test', false, sqlerrm);
  end;

  select count(*) filter (where not ok), count(*) into nfail, ntotal from results;
  if nfail > 0 then
    raise exception E'PROPOSAL COMMAND CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      nfail, ntotal,
      (select string_agg(label || coalesce(': ' || detail, ''), E'\n' order by n) from results where not ok),
      (select string_agg(case when ok then 'ok  ' else 'FAIL' end || '  ' || label, E'\n' order by n) from results);
  end if;
  raise exception E'PROPOSAL COMMAND CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    ntotal, (select string_agg('ok    ' || label, E'\n' order by n) from results);
end
$test$;
