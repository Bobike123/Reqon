-- =============================================================================
--  Subdepartments and department authority (backend completion Phase 2):
--  docs/backend-completion/PERMISSIONS.md §3; migration 20260126000200.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: all fixtures live inside one DO block
--  that always raises, so everything rolls back. Fixture people are new
--  @p2-hier.test identities; existing departments only get a temporary Head.
--
--  Result: DEPARTMENT HIERARCHY CHECKS PASSED / FAILED.
--
--  Covers: one-level depth, self/cycle prevention, top-level-only cap,
--  archive/restore rules between parent and child, who may configure the
--  hierarchy, department_authority() for own Head / parent Head / sibling /
--  other Head / several headships / revoked and retired Heads / the President
--  and Vice President in every department (role hierarchy 20260130000000, which
--  replaced the no-Head-only fallback) / archived departments / unassigned work, and that the
--  RLS task paths and proposal review follow it.
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

create or replace function pg_temp.val(who uuid, expr text) returns text language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute 'select (' || expr || ')::text' into r;
  exception when others then r := 'ERROR ' || sqlstate;
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
  season uuid;
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid();
  tre uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); mem2 uuid := gen_random_uuid();
  ha uuid := gen_random_uuid(); hb uuid := gen_random_uuid(); hs uuid := gen_random_uuid();
  hm uuid := gen_random_uuid();
  pa text; pb text; pfree text;
  t_sa1 uuid; t_pa uuid; t_sa2 uuid; t_sn uuid; t_sb1 uuid; t_sn2 uuid;
  prop uuid; ms text; clause text;
  n_top int;
  total int; bad int; report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into ms from milestones where season_id = season order by ordinal limit 1;
  select clause_key into clause from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season order by clause_key limit 1;
  select key into pa from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select key into pb from subteams where archived_at is null and parent_key is null and key <> pa order by sort_order, key limit 1;
  -- A top-level department with no active work, for the archive/restore checks.
  select key into pfree from subteams s
   where archived_at is null and parent_key is null and key not in (pa, pb)
     and not exists (select 1 from tasks t where t.subteam_key = s.key and t.archived_at is null and t.state not in ('done', 'cancelled'))
     and not exists (select 1 from task_proposals p where p.subteam_key = s.key and p.archived_at is null and p.state <> 'decided')
   order by sort_order, key limit 1;

  insert into auth.users (id, email)
  select id, k || '@p2-hier.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (mem, 'mem'),
    (mem2, 'mem2'), (ha, 'ha'), (hb, 'hb'), (hs, 'hs'), (hm, 'hm')) v(id, k);
  insert into members (id, full_name, role)
  select id, 'H ' || k, 'Member' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (mem, 'mem'),
    (mem2, 'mem2'), (ha, 'ha'), (hb, 'hb'), (hs, 'hs'), (hm, 'hm')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'), (tre, 'treasurer');
  update subteams set lead_id = ha where key = pa;
  update subteams set lead_id = hb where key = pb;

  -- ========================================================== configuration
  perform pg_temp.expect('President creates a subdepartment',
    pg_temp.attempt(pre, format('insert into subteams (key, name, parent_key) values (''H_SA1'', ''Sub A1'', %L)', pa)), 'ALLOWED');
  perform pg_temp.expect('Vice President creates a subdepartment',
    pg_temp.attempt(vp, format('insert into subteams (key, name, parent_key) values (''H_SA2'', ''Sub A2'', %L)', pa)), 'ALLOWED');
  perform pg_temp.expect('Developer creates a subdepartment',
    pg_temp.attempt(dev, format('insert into subteams (key, name, parent_key) values (''H_SB1'', ''Sub B1'', %L)', pb)), 'ALLOWED');
  perform pg_temp.expect('the parent''s Head cannot create a subdepartment (configuration is governance)',
    pg_temp.attempt(ha, format('insert into subteams (key, name, parent_key) values (''H_SAX'', ''x'', %L)', pa)), 'DENIED');
  perform pg_temp.expect('a member cannot create one',
    pg_temp.attempt(mem, format('insert into subteams (key, name, parent_key) values (''H_SAY'', ''y'', %L)', pa)), 'DENIED');
  perform pg_temp.expect('Vice President appoints a subdepartment Head',
    pg_temp.attempt(vp, format('update subteams set lead_id = %L where key = ''H_SA1''', hs)), 'ALLOWED');
  perform pg_temp.expect('a Head cannot rename their own department',
    pg_temp.attempt(ha, format('update subteams set name = ''renamed'' where key = %L', pa)), 'DENIED');
  perform pg_temp.expect('the new rows record their parent', (select string_agg(key || '>' || parent_key, ',' order by key) from subteams where key like 'H\_S%'),
    format('H_SA1>%s,H_SA2>%s,H_SB1>%s', pa, pa, pb));

  -- ================================================== depth, self and cycles
  perform pg_temp.expect('a subdepartment of a subdepartment is refused',
    pg_temp.attempt(pre, 'insert into subteams (key, name, parent_key) values (''H_DEEP'', ''deep'', ''H_SA1'')'), 'ERROR 23514%one level%');
  perform pg_temp.expect('a department cannot be its own parent',
    pg_temp.attempt(pre, 'update subteams set parent_key = key where key = ''H_SA2'''), 'ERROR 23514%');
  perform pg_temp.expect('a department with subdepartments cannot become one (no cycles, no depth 2)',
    pg_temp.attempt(pre, format('update subteams set parent_key = %L where key = %L', pb, pa)), 'ERROR 23514%has subdepartments%');
  perform pg_temp.expect('a top-level department cannot sit under a subdepartment',
    pg_temp.attempt(pre, format('update subteams set parent_key = ''H_SB1'' where key = %L', pb)), 'ERROR 23514%');
  perform pg_temp.expect('an unknown parent is refused',
    pg_temp.attempt(pre, 'update subteams set parent_key = ''NO_SUCH_DEPT'' where key = ''H_SA2'''), 'ERROR 23503%');
  perform pg_temp.expect('a subdepartment may move to another parent',
    pg_temp.attempt(pre, format('update subteams set parent_key = %L where key = ''H_SA2''', pb)), 'ALLOWED');
  perform pg_temp.expect('... and back', pg_temp.attempt(pre, format('update subteams set parent_key = %L where key = ''H_SA2''', pa)), 'ALLOWED');
  perform pg_temp.expect('the hierarchy is still one level everywhere',
    (select count(*)::text from subteams c join subteams p on p.key = c.parent_key where p.parent_key is not null), '0');

  -- ======================================================== cap: top level only
  for i in 1..11 loop
    insert into subteams (key, name, parent_key) values ('H_CAP' || i, 'cap ' || i, pa);
  end loop;
  perform pg_temp.expect('eleven more subdepartments never touch the cap', (select count(*)::text from subteams where key like 'H\_CAP%'), '11');
  select count(*) into n_top from subteams where archived_at is null and parent_key is null;
  for i in 1..(10 - n_top) loop
    insert into subteams (key, name) values ('H_TOP' || i, 'top ' || i);
  end loop;
  perform pg_temp.expect('ten active top-level departments now', (select count(*)::text from subteams where archived_at is null and parent_key is null), '10');
  perform pg_temp.expect('promoting a subdepartment to top level counts against the cap',
    pg_temp.attempt(pre, 'update subteams set parent_key = null where key = ''H_CAP1'''), 'ERROR 23514%At most 10%');
  perform pg_temp.expect('... but a new subdepartment is still fine',
    pg_temp.attempt(pre, format('insert into subteams (key, name, parent_key) values (''H_CAP12'', ''cap 12'', %L)', pa)), 'ALLOWED');
  delete from subteams where key like 'H\_TOP%' or key like 'H\_CAP%';

  -- ================================================== archive / restore rules
  perform pg_temp.expect('a parent with active subdepartments cannot be archived',
    pg_temp.attempt(pre, format('update subteams set archived_at = now() where key = %L', pa)), 'ERROR 23514%subdepartment%');
  if pfree is null then
    perform pg_temp.expect('fixture: a top-level department without active work exists', 'none', 'a key');
  else
    insert into subteams (key, name, parent_key) values ('H_SF', 'Sub free', pfree);
    perform pg_temp.expect('archive the subdepartment', pg_temp.attempt(pre, 'update subteams set archived_at = now() where key = ''H_SF'''), 'ALLOWED');
    perform pg_temp.expect('then the parent', pg_temp.attempt(pre, format('update subteams set archived_at = now() where key = %L', pfree)), 'ALLOWED');
    perform pg_temp.expect('a subdepartment cannot be restored under an archived parent',
      pg_temp.attempt(pre, 'update subteams set archived_at = null where key = ''H_SF'''), 'ERROR 23514%archived%');
    perform pg_temp.expect('nor created under one',
      pg_temp.attempt(pre, format('insert into subteams (key, name, parent_key) values (''H_SF2'', ''x'', %L)', pfree)), 'ERROR 23514%archived%');
    perform pg_temp.expect('restore the parent, then the subdepartment',
      pg_temp.attempt(pre, format('update subteams set archived_at = null where key = %L', pfree)) || '/' ||
      pg_temp.attempt(pre, 'update subteams set archived_at = null where key = ''H_SF'''), 'ALLOWED/ALLOWED');
  end if;

  -- ================================================== department_authority()
  perform pg_temp.expect('Head of the parent -> head on the parent', pg_temp.val(ha, format('department_authority(%L)', pa)), 'head');
  perform pg_temp.expect('Head of the parent -> parent_head on its subdepartment', pg_temp.val(ha, 'department_authority(''H_SA1'')'), 'parent_head');
  perform pg_temp.expect('Head of the subdepartment -> head there', pg_temp.val(hs, 'department_authority(''H_SA1'')'), 'head');
  perform pg_temp.expect('Head of the subdepartment has nothing on the parent', pg_temp.val(hs, format('department_authority(%L)', pa)), 'null');
  perform pg_temp.expect('... nor on a sibling subdepartment', pg_temp.val(hs, 'department_authority(''H_SA2'')'), 'null');
  perform pg_temp.expect('Head of another department has nothing here', pg_temp.val(hb, 'department_authority(''H_SA1'')'), 'null');
  perform pg_temp.expect('Developer -> developer', pg_temp.val(dev, 'department_authority(''H_SA1'')'), 'developer');
  -- Role hierarchy (20260130000000) supersedes the Phase 2 no-Head-only fallback: the President ranks above a Head.
  perform pg_temp.expect('President -> president even where a Head exists', pg_temp.val(pre, 'department_authority(''H_SA1'')'), 'president');
  perform pg_temp.expect('Treasurer -> none', pg_temp.val(tre, 'department_authority(''H_SA1'')'), 'null');
  perform pg_temp.expect('member -> none', pg_temp.val(mem, 'department_authority(''H_SA1'')'), 'null');
  perform pg_temp.expect('is_department_head is true through the parent', pg_temp.val(ha, 'is_department_head(''H_SA1'')'), 'true');
  perform pg_temp.expect('is_department_head is false for a Developer', pg_temp.val(dev, 'is_department_head(''H_SA1'')'), 'false');

  -- tasks follow the same rule through RLS and guard_task_edit
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'H in SA1', 'H_SA1', mem2) returning id into t_sa1;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'H in PA', pa, mem2) returning id into t_pa;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'H in SA2', 'H_SA2', mem2) returning id into t_sa2;
  perform pg_temp.expect('parent Head edits a subdepartment task', pg_temp.attempt(ha, format('update tasks set detail = ''ha'' where id = %L', t_sa1)), 'ALLOWED');
  perform pg_temp.expect('subdepartment Head edits it', pg_temp.attempt(hs, format('update tasks set detail = ''hs'' where id = %L', t_sa1)), 'ALLOWED');
  perform pg_temp.expect('subdepartment Head cannot edit a parent task', pg_temp.attempt(hs, format('update tasks set detail = ''x'' where id = %L', t_pa)), 'DENIED');
  perform pg_temp.expect('... nor a sibling task', pg_temp.attempt(hs, format('update tasks set detail = ''x'' where id = %L', t_sa2)), 'DENIED');
  perform pg_temp.expect('another Head cannot edit it', pg_temp.attempt(hb, format('update tasks set detail = ''x'' where id = %L', t_sa1)), 'DENIED');
  perform pg_temp.expect('parent Head reassigns the owner of a subdepartment task', pg_temp.attempt(ha, format('update tasks set owner_id = %L where id = %L', mem, t_sa1)), 'ALLOWED');
  perform pg_temp.expect('the owner cannot reassign themselves away', pg_temp.attempt(mem, format('update tasks set owner_id = %L where id = %L', mem2, t_sa1)), 'DENIED');
  perform pg_temp.expect('parent Head archives a subdepartment task', pg_temp.attempt(ha, format('select archive_task(%L)', t_sa1)), 'ALLOWED');
  perform pg_temp.expect('subdepartment Head cannot archive a sibling task', pg_temp.attempt(hs, format('select archive_task(%L)', t_sa2)), 'DENIED');

  -- proposal review follows it
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key)
    values (season, 'H proposal', mem, 'H_SA1', '2026-12-01', ms) returning id into prop;
  insert into proposal_requirements (proposal_id, clause_key) values (prop, clause);
  perform pg_temp.expect('parent Head may review a subdepartment proposal', pg_temp.val(ha, format('can_review_proposal(%L)', prop)), 'true');
  perform pg_temp.expect('subdepartment Head may review it', pg_temp.val(hs, format('can_review_proposal(%L)', prop)), 'true');
  perform pg_temp.expect('another Head may not', pg_temp.val(hb, format('can_review_proposal(%L)', prop)), 'false');
  perform pg_temp.expect('the President may review it although a Head exists', pg_temp.val(pre, format('can_review_proposal(%L)', prop)), 'true');
  perform pg_temp.expect('a Treasurer may not', pg_temp.val(tre, format('can_review_proposal(%L)', prop)), 'false');

  -- ======================================================= several headships
  update subteams set lead_id = hm where key = 'H_SA2';
  update subteams set lead_id = hm where key = 'H_SB1';
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'H in SB1', 'H_SB1', mem2) returning id into t_sb1;
  perform pg_temp.expect('one person heading two departments edits in the first', pg_temp.attempt(hm, format('update tasks set detail = ''hm'' where id = %L', t_sa2)), 'ALLOWED');
  perform pg_temp.expect('... and in the second', pg_temp.attempt(hm, format('update tasks set detail = ''hm'' where id = %L', t_sb1)), 'ALLOWED');
  perform pg_temp.expect('... but not in a third', pg_temp.attempt(hm, format('update tasks set detail = ''x'' where id = %L', t_pa)), 'DENIED');

  -- ============================================ revocation takes effect at once
  update subteams set lead_id = null where key = pa;
  perform pg_temp.expect('a revoked parent Head loses the subdepartment immediately', pg_temp.val(ha, 'department_authority(''H_SA1'')'), 'null');
  perform pg_temp.expect('... and cannot edit its tasks', pg_temp.attempt(ha, format('update tasks set detail = ''x'' where id = %L', t_sa2)), 'DENIED');
  perform pg_temp.expect('the subdepartment Head keeps their own', pg_temp.val(hs, 'department_authority(''H_SA1'')'), 'head');
  update subteams set lead_id = hb where key = pa;
  perform pg_temp.expect('a reassigned Head gains it on the next call', pg_temp.val(hb, 'department_authority(''H_SA1'')'), 'parent_head');
  update subteams set lead_id = ha where key = pa;

  -- ================================================= no-Head governance fallback
  update subteams set lead_id = null where key = pb;
  insert into subteams (key, name, parent_key) values ('H_SN', 'Sub no head', pb);
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'H in SN', 'H_SN', mem2) returning id into t_sn;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'H in SN 2', 'H_SN', mem2) returning id into t_sn2;
  perform pg_temp.expect('President -> president where neither department nor parent has a Head', pg_temp.val(pre, 'department_authority(''H_SN'')'), 'president');
  perform pg_temp.expect('Vice President -> vicepresident there', pg_temp.val(vp, 'department_authority(''H_SN'')'), 'vicepresident');
  perform pg_temp.expect('Treasurer -> none there', pg_temp.val(tre, 'department_authority(''H_SN'')'), 'null');
  perform pg_temp.expect('the President edits a task there', pg_temp.attempt(pre, format('update tasks set detail = ''pre'' where id = %L', t_sn)), 'ALLOWED');
  perform pg_temp.expect('the Vice President archives one there', pg_temp.attempt(vp, format('select archive_task(%L)', t_sn2)), 'ALLOWED');
  perform pg_temp.expect('a member still cannot', pg_temp.attempt(mem, format('update tasks set detail = ''x'' where id = %L', t_sn)), 'DENIED');
  update subteams set lead_id = hb where key = pb;
  perform pg_temp.expect('a Head appointed to the parent does not remove the President''s authority', pg_temp.val(pre, 'department_authority(''H_SN'')'), 'president');
  perform pg_temp.expect('... and the President still edits there', pg_temp.attempt(pre, format('update tasks set detail = ''x'' where id = %L', t_sn)), 'ALLOWED');
  perform pg_temp.expect('... while the Treasurer still cannot', pg_temp.attempt(tre, format('update tasks set detail = ''y'' where id = %L', t_sn)), 'DENIED');
  update members set status = 'alumni' where id = hb;
  perform pg_temp.expect('a retired Head has no authority', pg_temp.val(hb, 'department_authority(''H_SN'')'), 'null');
  perform pg_temp.expect('... and the President''s authority does not depend on any Head', pg_temp.val(pre, 'department_authority(''H_SN'')'), 'president');
  update members set status = 'active' where id = hb;

  -- ================================================ archived and unassigned
  insert into subteams (key, name, parent_key) values ('H_SARCH', 'Sub archived', pa);
  update subteams set lead_id = hs where key = 'H_SARCH';
  update subteams set archived_at = now() where key = 'H_SARCH';
  perform pg_temp.expect('an archived department''s Head has no authority', pg_temp.val(hs, 'department_authority(''H_SARCH'')'), 'null');
  perform pg_temp.expect('... nor its parent''s Head', pg_temp.val(ha, 'department_authority(''H_SARCH'')'), 'null');
  perform pg_temp.expect('... nor the President', pg_temp.val(pre, 'department_authority(''H_SARCH'')'), 'null');
  perform pg_temp.expect('... a Developer still does', pg_temp.val(dev, 'department_authority(''H_SARCH'')'), 'developer');
  perform pg_temp.expect('unassigned work: President -> president', pg_temp.val(pre, 'department_authority(null)'), 'president');
  perform pg_temp.expect('unassigned work: Developer -> developer', pg_temp.val(dev, 'department_authority(null)'), 'developer');
  perform pg_temp.expect('unassigned work: a Head -> none', pg_temp.val(ha, 'department_authority(null)'), 'null');
  perform pg_temp.expect('unassigned work: member -> none', pg_temp.val(mem, 'department_authority(null)'), 'null');

  -- ================================================================= verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'DEPARTMENT HIERARCHY CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'DEPARTMENT HIERARCHY CHECKS PASSED — all % checks', total;
end
$test$;
