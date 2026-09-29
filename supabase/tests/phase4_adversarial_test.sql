-- =============================================================================
--  Phase 4 independent review: adversarial checks written as REAL
--  authenticated/anon sessions (never as the postgres owner), against the whole
--  migration chain. Each check names the finding it pins (docs/redesign/reviews/
--  phase-04.md). SAFE TO RUN AGAINST THE REAL PROJECT: everything happens in
--  one block that ends by raising an exception, so every row rolls back.
--      PHASE FOUR CHECKS PASSED   or   PHASE FOUR CHECKS FAILED
-- =============================================================================

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

-- The same, as the anonymous (signed-out) role.
create or replace function pg_temp.anon_val(stmt text) returns text
language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin
    execute stmt into r;
  exception when others then
    r := 'E:' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return r;
end $fn$;


-- Runs an attack as `who`, then (as the superuser) evaluates `probe`, then ROLLS
-- THE ATTACK BACK so the next check starts from the same fixture. Returns
-- '<sqlstate or ok>|<probe result>'.
create or replace function pg_temp.attack(who uuid, stmt text, probe text) returns text
language plpgsql as $fn$
declare r text; pr text;
begin
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
    execute probe into pr;
    raise exception 'rollback-attack' using errcode = 'P0777';
  exception when sqlstate 'P0777' then
    perform set_config('role', 'none', true);
  end;
  return r || '|' || pr;
end $fn$;

create temp table results (n serial, label text, ok boolean, detail text);
create or replace function pg_temp.chk(label text, ok boolean, detail text default null) returns void
language plpgsql as $fn$
begin
  insert into results (label, ok, detail) values (label, coalesce(ok, false), detail);
end $fn$;

do $test$
declare
  pre uuid := gen_random_uuid();     -- President
  vp  uuid := gen_random_uuid();     -- Vice President
  dev uuid := gen_random_uuid();     -- Developer
  hd  uuid := gen_random_uuid();     -- Head of a department
  mem uuid := gen_random_uuid();     -- ordinary member
  alum uuid := gen_random_uuid();    -- alumnus, no roles
  alumvp uuid := gen_random_uuid();  -- alumnus who still holds the vicepresident role
  alumdev uuid := gen_random_uuid(); -- alumnus who still holds the developer role
  tre uuid := gen_random_uuid();     -- Treasurer
  sX uuid; sY uuid; deptFree text; dept text; clause text; clause2 text; secY uuid;
  t1 uuid; p1 uuid;
  q1 text;
  bad text;
  nfail int; ntotal int;
begin
  insert into auth.users (id, email) select x.i, x.e from (values
    (pre,'p4-pre@t.test'),(vp,'p4-vp@t.test'),(dev,'p4-dev@t.test'),(hd,'p4-hd@t.test'),
    (mem,'p4-mem@t.test'),(alum,'p4-alum@t.test'),(alumvp,'p4-avp@t.test'),(alumdev,'p4-adev@t.test'),(tre,'p4-tre@t.test')) as x(i, e);
  insert into members (id, full_name, role, status) values
    (pre,'P4 Pre','Lead','active'),(vp,'P4 VP','Lead','active'),(dev,'P4 Dev','Sw','active'),
    (hd,'P4 Head','Ch','active'),(mem,'P4 Mem','Ch','active'),
    (alum,'P4 Alum','Ch','alumni'),(alumvp,'P4 AlumVP','Ch','alumni'),(alumdev,'P4 AlumDev','Ch','alumni'),(tre,'P4 Tre','Fin','active');
  insert into member_roles (member_id, role) values
    (pre,'president'),(vp,'vicepresident'),(dev,'developer'),(alumvp,'vicepresident'),(alumdev,'developer'),(tre,'treasurer');

  insert into seasons (label, is_current) values ('P4-X', false) returning id into sX;
  insert into seasons (label, is_current) values ('P4-Y', false) returning id into sY;
  insert into milestones (key, season_id, ordinal, name) values ('P4-X1', sX, 1, 'X one'), ('P4-Y1', sY, 1, 'Y one');
  select key into dept from subteams where archived_at is null order by sort_order, key limit 1;
  update subteams set lead_id = hd where key = dept;
  select s.key into deptFree from subteams s where s.archived_at is null and s.key <> dept
     and not exists (select 1 from tasks t where t.subteam_key = s.key and t.state not in ('done','cancelled'))
     and not exists (select 1 from task_proposals q where q.subteam_key = s.key and q.archived_at is null and q.state <> 'decided')
   order by s.sort_order desc, s.key limit 1;
  select clause_key into clause from clauses order by clause_key limit 1;
  select clause_key into clause2 from clauses order by clause_key offset 1 limit 1;
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key)
    values (sX, 'P4 prop', mem, dept, '2026-12-01', 'P4-X1') returning id into p1;
  insert into proposal_requirements (proposal_id, clause_key) values (p1, clause);
  insert into tasks (season_id, title, subteam_key, milestone_key) values (sX, 'P4 task', dept, 'P4-X1') returning id into t1;
  insert into task_requirements (task_id, clause_key) values (t1, clause);
  insert into clause_status (season_id, clause_key) values (sX, clause);
  insert into handover_notes (season_id, subteam_key, body) values (sX, dept, 'original');
  insert into specs (season_id, parameter, comparator) values (sX, 'P4 width', 'max');
  insert into milestone_sections (milestone_key, ordinal, name) values ('P4-Y1', 1, 'P4 section') returning id into secY;

  -- ============ F1: AUTHORIZATION REVOCATION (roster status) ============
  q1 := pg_temp.attack(alum, format('update members set status = ''active'' where id = %L', alum), format('select status::text from members where id = %L', alum));
  perform pg_temp.chk('F1a an alumnus cannot reactivate themselves', q1 like '%|alumni', q1);
  q1 := pg_temp.attack(mem, format('update members set status = ''alumni'' where id = %L', mem), format('select status::text from members where id = %L', mem));
  perform pg_temp.chk('F1b a member cannot retire themselves either (roster status is an admin decision)', q1 like '%|active', q1);
  perform pg_temp.chk('F1c an alumnus who kept the vicepresident role has no governance power', pg_temp.val(alumvp, 'select is_admin()::text') = 'false');
  perform pg_temp.chk('F1d ... and cannot manage departments', pg_temp.val(alumvp, 'select can_manage_departments()::text') = 'false');
  perform pg_temp.chk('F1e ... and cannot call a meeting', pg_temp.act(alumvp, format('insert into meetings (season_id, title, held_on) values (%L, ''x'', ''2026-10-01'')', sX)) <> 'ok');
  perform pg_temp.chk('F1f an alumnus who kept the developer role has no override', pg_temp.val(alumdev, 'select is_developer()::text') = 'false');
  perform pg_temp.chk('F1g ... and cannot edit a task', pg_temp.val(alumdev, format('select can_edit_task(%L)::text', t1)) = 'false');
  perform pg_temp.chk('F1h an active member with the role still has it', pg_temp.val(vp, 'select is_admin()::text') = 'true' and pg_temp.val(dev, 'select is_developer()::text') = 'true');
  perform pg_temp.chk('F1i an alumnus keeps read access (roster status revokes writes, not reads)', pg_temp.val(alum, 'select count(*)::text from tasks') <> '0');

  -- ================= F2: NO GOVERNANCE PATH DELETES WORK =================
  q1 := pg_temp.attack(vp, format('delete from seasons where id = %L', sX),
    format('select (exists (select 1 from seasons where id = %L) and exists (select 1 from tasks where id = %L) and exists (select 1 from task_proposals where id = %L))::text', sX, t1, p1));
  perform pg_temp.chk('F2a a Vice President cannot delete a season (it would cascade into tasks and proposals)', q1 like '%|true', q1);
  q1 := pg_temp.attack(pre, format('delete from seasons where id = %L', sX), format('select exists (select 1 from tasks where id = %L)::text', t1));
  perform pg_temp.chk('F2b nor can the President', q1 like '%|true', q1);
  q1 := pg_temp.attack(dev, format('delete from seasons where id = %L', sX), format('select exists (select 1 from tasks where id = %L)::text', t1));
  perform pg_temp.chk('F2c nor a Developer through the API', q1 like '%|true', q1);
  q1 := pg_temp.attack(vp, format('delete from milestones where key = %L', 'P4-X1'), 'select exists (select 1 from milestones where key = ''P4-X1'')::text');
  perform pg_temp.chk('F2e a referenced milestone cannot be deleted', q1 like '%|true', q1);
  q1 := pg_temp.attack(vp, format('delete from clauses where clause_key = %L', clause), format('select exists (select 1 from clauses where clause_key = %L)::text', clause));
  perform pg_temp.chk('F2f a requirement with links cannot be deleted', q1 like '%|true', q1);
  q1 := pg_temp.attack(vp, format('delete from subteams where key = %L', dept), format('select exists (select 1 from subteams where key = %L)::text', dept));
  perform pg_temp.chk('F2g a department with work cannot be deleted', q1 like '%|true', q1);
  q1 := pg_temp.attack(pre, format('delete from members where id = %L', mem), format('select exists (select 1 from members where id = %L)::text', mem));
  perform pg_temp.chk('F2h nobody deletes a member through the API', q1 like '%|true', q1);
  select string_agg(c.relname, ' ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'));
  perform pg_temp.chk('F2i neither anon nor authenticated holds TRUNCATE on any public table (RLS does not cover it)', bad is null, bad);

  -- ==================== F3: SEASON BOUNDARY, REFERENCED KEYS ====================
  q1 := pg_temp.attack(vp, format('update milestones set season_id = %L where key = %L', sY, 'P4-X1'), 'select (season_id)::text from milestones where key = ''P4-X1''');
  perform pg_temp.chk('F3a a milestone that tasks or proposals use cannot be moved to another season', q1 like '%|' || sX::text, q1);
  q1 := pg_temp.act(vp, format('update milestones set due_on = ''2027-01-01'' where key = %L', 'P4-Y1'));
  perform pg_temp.chk('F3b an unreferenced milestone may still be re-dated', q1 = 'ok' and (select due_on::text from milestones where key = 'P4-Y1') = '2027-01-01', q1);
  q1 := pg_temp.attack(vp, format('update milestones set key = %L where key = %L', 'P4-RENAMED', 'P4-X1'), 'select exists (select 1 from milestones where key = ''P4-X1'')::text');
  perform pg_temp.chk('F3c a referenced milestone key cannot be renamed under its links', q1 like '%|true', q1);

  -- ================== F4: SIGNED-OUT ROLE SEES AND CHANGES NOTHING ==================
  perform pg_temp.chk('F4a anon reads no tasks', pg_temp.anon_val('select count(*)::text from tasks') in ('0', 'E:42501'));
  perform pg_temp.chk('F4b anon reads no proposals', pg_temp.anon_val('select count(*)::text from task_proposals') in ('0', 'E:42501'));
  perform pg_temp.chk('F4c anon reads no requirement links', pg_temp.anon_val('select count(*)::text from task_requirements') in ('0', 'E:42501'));
  perform pg_temp.chk('F4d anon cannot submit a proposal', pg_temp.anon_val(format('select submit_proposal(%L, ''x'', %L, ''2026-12-01''::date, ''P4-X1'', array[%L])::text', sX, dept, clause)) = 'E:42501');
  perform pg_temp.chk('F4e anon cannot promote', pg_temp.anon_val(format('select (promote_proposal(%L, %L)).created::text', p1, sX)) = 'E:42501');
  perform pg_temp.chk('F4f anon cannot read the audit trail', pg_temp.anon_val('select count(*)::text from activity') in ('0', 'E:42501'));

  -- ====================== F5: ROLE COMBINATIONS / INTERPRETATION ======================
  update subteams set lead_id = pre where key = dept;
  perform pg_temp.chk('F5a a President who is also the department Head may review as Head', pg_temp.val(pre, format('select can_review_proposal(%L)::text', p1)) = 'true');
  update subteams set lead_id = hd where key = dept;
  perform pg_temp.chk('F5b once no longer Head the same person has no proposal power', pg_temp.val(pre, format('select can_review_proposal(%L)::text', p1)) = 'false');
  perform pg_temp.chk('F5c a Developer is not restricted to one department', pg_temp.val(dev, format('select can_review_proposal(%L)::text', p1)) = 'true');
  perform pg_temp.chk('F5d a Vice President has no power over a department they do not head', pg_temp.val(vp, format('select can_review_proposal(%L)::text', p1)) = 'false');

  -- ====================== F6: NOTHING FORGEABLE THROUGH A GENERIC EDIT ======================
  perform pg_temp.chk('F6a the Head cannot forge who created a task', pg_temp.act(hd, format('update tasks set created_by = %L where id = %L', mem, t1)) = '42501');
  perform pg_temp.chk('F6b nor its creation time', pg_temp.act(hd, format('update tasks set created_at = now() - interval ''9 days'' where id = %L', t1)) = '42501');
  perform pg_temp.chk('F6c nor its archive fields', pg_temp.act(hd, format('update tasks set archived_at = now() where id = %L', t1)) = '42501');
  q1 := pg_temp.act(hd, format('update tasks set completed_at = now() - interval ''30 days'' where id = %L', t1));
  perform pg_temp.chk('F6d nor a completion time (the value is discarded)', q1 = 'ok' and (select completed_at is null from tasks where id = t1), q1);
  perform pg_temp.chk('F6e nor a proposal author', pg_temp.act(hd, format('update task_proposals set raised_by = %L where id = %L', pre, p1)) = '42501');
  perform pg_temp.chk('F6f nor a link author (no direct write)', pg_temp.act(hd, format('update task_requirements set created_by = %L where task_id = %L', pre, t1)) <> 'ok');
  q1 := pg_temp.val(hd, format('select link_task_requirement(%L, %L)::text', t1, clause2));
  perform pg_temp.chk('F6g a link written through the command is attributed to the caller',
    q1 = 'true' and (select created_by from task_requirements where task_id = t1 and clause_key = clause2) = hd, q1);
  perform pg_temp.chk('F6h a member cannot mint an activity row', pg_temp.act(mem, format('insert into activity (entity, entity_id, action) values (''task'', %L, ''completed'')', t1::text)) <> 'ok');


  -- ============ F7: ALUMNI ARE READ-ONLY ON EVERY PROJECT TABLE ============
  q1 := pg_temp.attack(alum, format('update clause_status set starred = true where season_id = %L', sX), format('select starred::text from clause_status where season_id = %L', sX));
  perform pg_temp.chk('F7a an alumnus cannot change requirement compliance', q1 like '%|false', q1);
  q1 := pg_temp.attack(alum, format('insert into clause_status (season_id, clause_key) values (%L, %L)', sX, clause2), format('select count(*)::text from clause_status where season_id = %L', sX));
  perform pg_temp.chk('F7b nor add a compliance row', q1 like '%|1', q1);
  q1 := pg_temp.attack(alum, format('update handover_notes set body = ''defaced'' where season_id = %L', sX), format('select body from handover_notes where season_id = %L', sX));
  perform pg_temp.chk('F7c nor rewrite a handover note', q1 like '%|original', q1);
  q1 := pg_temp.attack(alum, format('update specs set parameter = ''defaced'' where season_id = %L', sX), format('select parameter from specs where season_id = %L', sX));
  perform pg_temp.chk('F7d nor edit a specification', q1 like '%|P4 width', q1);
  q1 := pg_temp.attack(alum, format('update milestone_sections set name = ''defaced'' where id = %L', secY), format('select name from milestone_sections where id = %L', secY));
  perform pg_temp.chk('F7e nor edit a milestone section', q1 like '%|P4 section', q1);
  q1 := pg_temp.attack(mem, format('update clause_status set starred = true where season_id = %L', sX), format('select starred::text from clause_status where season_id = %L', sX));
  perform pg_temp.chk('F7f an active member still can (the fix must not over-block)', q1 like '%|true', q1);
  q1 := pg_temp.attack(mem, format('update members set phone = ''123'' where id = %L', mem), format('select phone from members where id = %L', mem));
  perform pg_temp.chk('F7g and still edits their own contact details', q1 like '%|123', q1);
  q1 := pg_temp.attack(vp, format('update members set status = ''alumni'' where id = %L', mem), format('select status::text from members where id = %L', mem));
  perform pg_temp.chk('F7h an active Vice President can retire a member (roster management still works)', q1 like 'ok|alumni', q1);
  q1 := pg_temp.attack(alumvp, format('update members set status = ''alumni'' where id = %L', mem), format('select status::text from members where id = %L', mem));
  perform pg_temp.chk('F7i a retired Vice President cannot', q1 like '%|active', q1);

  -- ============ F8: ARCHIVE METADATA IS SERVER-STAMPED, NOT CLIENT-SUPPLIED ============
  q1 := pg_temp.attack(vp, format('update subteams set archived_at = ''2001-01-01T00:00:00Z'', archived_by = %L, archive_reason = ''forged'' where key = %L', mem, deptFree),
    format('select (archived_at > now() - interval ''1 minute'' and archived_by = %L)::text from subteams where key = %L', vp, deptFree));
  perform pg_temp.chk('F8a a department archive cannot be backdated or blamed on someone else', q1 like 'ok|true', q1);
  update subteams set archived_at = now(), archived_by = vp, archive_reason = 'setup' where key = deptFree;
  q1 := pg_temp.attack(pre, format('update subteams set archived_at = ''2001-01-01T00:00:00Z'', archived_by = %L where key = %L', mem, deptFree),
    format('select (archived_at > now() - interval ''1 minute'' and archived_by = %L)::text from subteams where key = %L', vp, deptFree));
  perform pg_temp.chk('F8b an already-archived department keeps its original archive time and actor', q1 like '%|true', q1);

  -- ====== F9: RETIRING A ROLE HOLDER IS A ROLE DECISION (consequence of F-2) ======
  update members set status = 'alumni' where id in (select member_id from member_roles where role = 'president' and member_id <> pre);
  q1 := pg_temp.attack(vp, format('update members set status = ''alumni'' where id = %L', pre), format('select status::text from members where id = %L', pre));
  perform pg_temp.chk('F9a a Vice President cannot retire the President', q1 like '%|active', q1);
  q1 := pg_temp.attack(vp, format('update members set status = ''alumni'' where id = %L', tre), format('select status::text from members where id = %L', tre));
  -- Backend completion Phase 2 (PERMISSIONS §4): the VP now manages the treasurer
  -- role, so may retire its holder; F9b used to expect the Treasurer to stay active.
  perform pg_temp.chk('F9b a Vice President may retire a Treasurer (a role the VP manages)', q1 like 'ok|alumni', q1);
  update members set status = 'active' where id = tre;
  q1 := pg_temp.attack(vp, format('update members set status = ''alumni'' where id = %L', dev), format('select status::text from members where id = %L', dev));
  perform pg_temp.chk('F9b2 but not a Developer (a role the VP does not manage)', q1 like '%|active', q1);
  q1 := pg_temp.attack(pre, format('update members set status = ''alumni'' where id = %L', tre), format('select status::text from members where id = %L', tre));
  perform pg_temp.chk('F9c the President can retire a role holder', q1 like 'ok|alumni', q1);
  q1 := pg_temp.attack(dev, format('update members set status = ''alumni'' where id = %L', tre), format('select status::text from members where id = %L', tre));
  perform pg_temp.chk('F9d and so can a Developer', q1 like 'ok|alumni', q1);
  q1 := pg_temp.attack(pre, format('update members set status = ''alumni'' where id = %L', pre), format('select status::text from members where id = %L', pre));
  perform pg_temp.chk('F9e the last active President cannot be retired, not even by themselves', q1 like '%|active', q1);
  q1 := pg_temp.attack(dev, format('update members set status = ''alumni'' where id = %L', pre), format('select status::text from members where id = %L', pre));
  perform pg_temp.chk('F9f nor by a Developer', q1 like '%|active', q1);
  update members set status = 'active' where id = alumvp;
  insert into member_roles (member_id, role) values (alumvp, 'president') on conflict do nothing;
  q1 := pg_temp.attack(dev, format('update members set status = ''alumni'' where id = %L', pre), format('select status::text from members where id = %L', pre));
  perform pg_temp.chk('F9g once another active President exists, the first can be retired', q1 like 'ok|alumni', q1);

  -- ============================ verdict ============================
  select count(*) filter (where not ok), count(*) into nfail, ntotal from results;
  if nfail > 0 then
    raise exception E'PHASE FOUR CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      nfail, ntotal,
      (select string_agg(label || coalesce(': ' || detail, ''), E'\n' order by n) from results where not ok),
      (select string_agg(case when ok then 'ok  ' else 'FAIL' end || '  ' || label, E'\n' order by n) from results);
  end if;
  raise exception E'PHASE FOUR CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    ntotal, (select string_agg('ok    ' || label, E'\n' order by n) from results);
end
$test$;
