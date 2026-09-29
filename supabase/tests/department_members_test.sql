-- =============================================================================
--  Department membership (backend completion Phase 2):
--  docs/backend-completion/PERMISSIONS.md §2.1, §3.4; migration 20260126000300.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so
--  every fixture rolls back. Fixture people are new @p2-members.test identities.
--
--  Result: DEPARTMENT MEMBERSHIP CHECKS PASSED / FAILED.
--
--  Covers: who may add/remove (President, VP, Developer, the Head, the parent's
--  Head) and who may not (subdepartment Head on the parent, another Head,
--  Documentation, Treasurer, member, alumnus, job title); many-to-many and
--  season scoping; duplicates; inactive members, archived departments and
--  unknown seasons/departments refused; no direct table writes; the audit rows;
--  and that membership grants NO authority anywhere.
-- =============================================================================

create or replace function pg_temp.attempt(who uuid, stmt text, kind text default 'write') returns text language plpgsql as $fn$
declare n bigint; result text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    if kind = 'read' then execute stmt into n; else execute stmt; get diagnostics n = row_count; end if;
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
  doc uuid := gen_random_uuid(); tre uuid := gen_random_uuid(); mem uuid := gen_random_uuid();
  mem2 uuid := gen_random_uuid(); mem3 uuid := gen_random_uuid(); alum uuid := gen_random_uuid();
  titled uuid := gen_random_uuid(); ha uuid := gen_random_uuid(); hs uuid := gen_random_uuid();
  hb uuid := gen_random_uuid();
  pa text; pb text;
  t_other uuid; t_arch uuid; prop uuid; ms text; clause text;
  actor record;
  total int; bad int; report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into ms from milestones where season_id = season order by ordinal limit 1;
  select clause_key into clause from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season order by clause_key limit 1;
  select key into pa from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select key into pb from subteams where archived_at is null and parent_key is null and key <> pa order by sort_order, key limit 1;
  insert into seasons (id, label, regs_ref) select s2, 'P2 members season', regs_ref from seasons where id = season;

  insert into auth.users (id, email)
  select id, k || '@p2-members.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (doc, 'doc'), (tre, 'tre'),
    (mem, 'mem'), (mem2, 'mem2'), (mem3, 'mem3'), (alum, 'alum'), (titled, 'titled'), (ha, 'ha'), (hs, 'hs'), (hb, 'hb')) v(id, k);
  insert into members (id, full_name, role, status)
  select id, 'D ' || k, case when k = 'titled' then 'Head of Department' else 'Member' end,
         case when k = 'alum' then 'alumni' else 'active' end::member_state
  from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (doc, 'doc'), (tre, 'tre'), (mem, 'mem'), (mem2, 'mem2'),
    (mem3, 'mem3'), (alum, 'alum'), (titled, 'titled'), (ha, 'ha'), (hs, 'hs'), (hb, 'hb')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'),
    (doc, 'documentation'), (tre, 'treasurer'), (alum, 'president');
  update subteams set lead_id = ha where key = pa;
  update subteams set lead_id = hb where key = pb;
  insert into subteams (key, name, parent_key, lead_id) values ('DM_SUB', 'Members sub', pa, hs);
  insert into subteams (key, name, parent_key) values ('DM_ARCH', 'Members archived', pa);
  update subteams set archived_at = now() where key = 'DM_ARCH';

  -- ================================================================ who may add
  for actor in select * from (values
      ('president', pre, pa, 'true'), ('vicepresident', vp, pb, 'true'), ('developer', dev, 'DM_SUB', 'true'),
      ('Head of the department', ha, pa, 'true'), ('parent''s Head, on the subdepartment', ha, 'DM_SUB', 'true'),
      ('subdepartment Head, on their own', hs, 'DM_SUB', 'true'),
      ('subdepartment Head, on the parent', hs, pa, 'DENIED'), ('Head of another department', hb, pa, 'DENIED'),
      ('documentation', doc, pa, 'DENIED'), ('treasurer', tre, pa, 'DENIED'), ('member', mem, pa, 'DENIED'),
      ('retired president', alum, pa, 'DENIED'), ('job title "Head of Department"', titled, pa, 'DENIED')) v(k, id, d, e) loop
    delete from department_members where member_id = mem3 and subteam_key = actor.d;
    perform pg_temp.expect(actor.k || ' adds a member',
      pg_temp.val(actor.id, format('add_department_member(%L, %L, %L)', season, actor.d, mem3)), actor.e);
  end loop;

  -- ========================================================= many-to-many, season
  perform pg_temp.expect('one person joins a first department', pg_temp.val(pre, format('add_department_member(%L, %L, %L)', season, pa, mem2)), 'true');
  perform pg_temp.expect('... and a second', pg_temp.val(pre, format('add_department_member(%L, %L, %L)', season, pb, mem2)), 'true');
  perform pg_temp.expect('... and a subdepartment', pg_temp.val(pre, format('add_department_member(%L, ''DM_SUB'', %L)', season, mem2)), 'true');
  perform pg_temp.expect('three memberships in the season', (select count(*)::text from department_members where member_id = mem2 and season_id = season), '3');
  perform pg_temp.expect('a second person joins the same department', pg_temp.val(vp, format('add_department_member(%L, %L, %L)', season, pa, mem)), 'true');
  perform pg_temp.expect('a department holds several people', (select (count(*) >= 2)::text from department_members where subteam_key = pa and season_id = season), 'true');
  perform pg_temp.expect('adding the same membership again changes nothing', pg_temp.val(pre, format('add_department_member(%L, %L, %L)', season, pa, mem2)), 'false');
  perform pg_temp.expect('... still one row for it', (select count(*)::text from department_members where member_id = mem2 and subteam_key = pa and season_id = season), '1');
  perform pg_temp.expect('another season is separate', pg_temp.val(pre, format('add_department_member(%L, %L, %L)', s2, pa, mem2)), 'true');
  perform pg_temp.expect('... two seasons, two rows', (select count(*)::text from department_members where member_id = mem2 and subteam_key = pa), '2');

  -- ================================================================ refusals
  perform pg_temp.expect('an alumnus cannot join', pg_temp.val(pre, format('add_department_member(%L, %L, %L)', season, pa, alum)), 'ERROR 23514');
  perform pg_temp.expect('an archived department takes no members', pg_temp.val(pre, format('add_department_member(%L, ''DM_ARCH'', %L)', season, mem2)), 'ERROR 23514');
  perform pg_temp.expect('an unknown season is refused', pg_temp.val(pre, format('add_department_member(%L, %L, %L)', gen_random_uuid(), pa, mem2)), 'ERROR 23503');
  perform pg_temp.expect('an unknown department is refused', pg_temp.val(pre, format('add_department_member(%L, ''NO_SUCH'', %L)', season, mem2)), 'ERROR 23503');
  perform pg_temp.expect('no direct insert', pg_temp.attempt(pre, format('insert into department_members (season_id, subteam_key, member_id) values (%L, %L, %L)', season, pb, mem)), 'DENIED');
  perform pg_temp.expect('no direct delete', pg_temp.attempt(dev, format('delete from department_members where member_id = %L', mem2)), 'DENIED');
  perform pg_temp.expect('no direct update', pg_temp.attempt(dev, format('update department_members set added_by = %L where member_id = %L', dev, mem2)), 'DENIED');
  perform pg_temp.expect('members read memberships', pg_temp.attempt(mem, 'select count(*) from department_members', 'read'), 'ALLOWED');

  -- ================================================================ removal
  perform pg_temp.expect('subdepartment Head cannot remove from the parent', pg_temp.val(hs, format('remove_department_member(%L, %L, %L)', season, pa, mem2)), 'DENIED');
  perform pg_temp.expect('the Head removes from their department', pg_temp.val(ha, format('remove_department_member(%L, %L, %L)', season, pa, mem2)), 'true');
  perform pg_temp.expect('removing again changes nothing', pg_temp.val(ha, format('remove_department_member(%L, %L, %L)', season, pa, mem2)), 'false');
  perform pg_temp.expect('the other memberships are untouched', (select count(*)::text from department_members where member_id = mem2 and season_id = season), '2');
  perform pg_temp.expect('audit: added and removed, with actor and season',
    (select count(*) filter (where action = 'member_added' and actor_id = pre)::text || '/' ||
            count(*) filter (where action = 'member_removed' and actor_id = ha)::text
       from activity where entity = 'department' and entity_id = pa and season_id = season and detail ->> 'member_id' = mem2::text), '1/1');

  -- ======================================================= grants NO authority
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'DM other''s task', pb, mem) returning id into t_other;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'DM archived', pb, mem) returning id into t_arch;
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks set archived_at = now(), archive_reason = 'manual' where id = t_arch;
  perform set_config('reqon.task_lifecycle_write', 'off', true);
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key)
    values (season, 'DM proposal', mem, pb, '2026-12-01', ms) returning id into prop;
  insert into proposal_requirements (proposal_id, clause_key) values (prop, clause);
  -- mem2 is a member of pb this season
  perform pg_temp.expect('a department member has no department authority', pg_temp.val(mem2, format('department_authority(%L)', pb)), 'null');
  perform pg_temp.expect('... cannot edit a colleague''s task', pg_temp.attempt(mem2, format('update tasks set detail = ''x'' where id = %L', t_other)), 'DENIED');
  perform pg_temp.expect('... cannot reassign it', pg_temp.attempt(mem2, format('update tasks set owner_id = %L where id = %L', mem2, t_other)), 'DENIED');
  perform pg_temp.expect('... cannot archive it', pg_temp.attempt(mem2, format('select archive_task(%L)', t_other)), 'DENIED');
  perform pg_temp.expect('... cannot restore', pg_temp.attempt(mem2, format('select restore_task(%L)', t_arch)), 'DENIED');
  perform pg_temp.expect('... cannot review the department''s proposal', pg_temp.val(mem2, format('can_review_proposal(%L)', prop)), 'false');
  perform pg_temp.expect('... cannot add colleagues', pg_temp.val(mem2, format('add_department_member(%L, %L, %L)', season, pb, mem)), 'DENIED');
  perform pg_temp.expect('... cannot move work', pg_temp.attempt(mem2, format('select set_task_department(%L, %L, ''member'')', t_other, pa)), 'DENIED');
  perform pg_temp.expect('... and gets no governance role', pg_temp.val(mem2, 'can_manage_departments()'), 'false');

  -- ================================================== retirement keeps history
  update members set status = 'alumni' where id = mem2;
  perform pg_temp.expect('retiring a member keeps their membership rows as history',
    (select count(*)::text from department_members where member_id = mem2 and season_id = season), '2');

  -- ================================================================= verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'DEPARTMENT MEMBERSHIP CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'DEPARTMENT MEMBERSHIP CHECKS PASSED — all % checks', total;
end
$test$;
