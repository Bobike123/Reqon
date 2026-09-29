-- =============================================================================
--  Governance permission matrix (backend completion Phase 2):
--  docs/backend-completion/PERMISSIONS.md §2.1, §4, §9 and migrations
--  20260126000100 / 0200 / 0500 / 0600.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: every fixture is created inside one DO
--  block that always ends by raising an exception, so Postgres rolls it all
--  back. Real members and grants are never modified; the fixture people are
--  new auth.users rows with @p2-matrix.test addresses.
--
--  Result: an "error" whose message begins with
--      PERMISSION MATRIX CHECKS PASSED   or   PERMISSION MATRIX CHECKS FAILED
--
--  Covers: seasons (RPC and direct writes), the role-grant matrix per role and
--  actor, apply_role_plan atomicity, last-President protection, roster status
--  of role holders, finance visibility (Documentation sees nothing), meeting
--  and agenda editing, task restore/archive authority and provenance, job
--  titles and retired role holders granting nothing, milestone-section
--  structure, requirement-status history (no delete, audited), and the
--  function EXECUTE surface.
-- =============================================================================

create or replace function pg_temp.attempt(who uuid, stmt text, kind text default 'write')
returns text language plpgsql as $fn$
declare
  n bigint;
  result text;
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
    if kind = 'read' then
      execute stmt into n;
    else
      execute stmt;
      get diagnostics n = row_count;
    end if;
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

-- Evaluates a scalar expression as `who` (NULL = anon); errors come back as text.
create or replace function pg_temp.val(who uuid, expr text) returns text language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', case when who is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
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
  s2 uuid := gen_random_uuid();
  pre uuid := gen_random_uuid();  vp uuid := gen_random_uuid();   tre uuid := gen_random_uuid();
  doc uuid := gen_random_uuid();  dev uuid := gen_random_uuid();  head uuid := gen_random_uuid();
  head2 uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); mem2 uuid := gen_random_uuid();
  alum_pre uuid := gen_random_uuid(); titled uuid := gen_random_uuid();
  da text; db text;
  actor record; r text; exp text;
  t_r uuid[] := array[]::uuid[]; t uuid; t_done uuid; t_live uuid;
  sec uuid; clause text; fin uuid; mtg uuid;
  total int; bad int; report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into da from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select key into db from subteams where archived_at is null and parent_key is null and key <> da order by sort_order, key limit 1;
  select clause_key into clause from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season order by clause_key limit 1;

  insert into auth.users (id, email)
  select id, k || '@p2-matrix.test' from (values
    (pre, 'pre'), (vp, 'vp'), (tre, 'tre'), (doc, 'doc'), (dev, 'dev'), (head, 'head'), (head2, 'head2'),
    (mem, 'mem'), (mem2, 'mem2'), (alum_pre, 'alum'), (titled, 'titled')) v(id, k);
  insert into members (id, full_name, role, status) values
    (pre, 'M Pre', 'Member', 'active'), (vp, 'M VP', 'Member', 'active'), (tre, 'M Tre', 'Member', 'active'),
    (doc, 'M Doc', 'Member', 'active'), (dev, 'M Dev', 'Member', 'active'), (head, 'M Head', 'Member', 'active'),
    (head2, 'M Head2', 'Member', 'active'), (mem, 'M Mem', 'Member', 'active'), (mem2, 'M Mem2', 'Member', 'active'),
    (alum_pre, 'M Alum', 'Member', 'alumni'),
    -- A job title that names a role grants nothing (members.role is display text).
    (titled, 'M Titled', 'President', 'active');
  insert into member_roles (member_id, role) values
    (pre, 'president'), (vp, 'vicepresident'), (tre, 'treasurer'), (doc, 'documentation'),
    (dev, 'developer'), (alum_pre, 'president');
  update subteams set lead_id = head where key = da;
  update subteams set lead_id = head2 where key = db;

  -- ================================================================= seasons
  insert into seasons (id, label, regs_ref, is_current) select s2, 'P2 matrix season', regs_ref, false from seasons where id = season;
  for actor in select * from (values ('vicepresident', vp), ('treasurer', tre), ('documentation', doc),
                                     ('member', mem), ('retired president', alum_pre), ('job title President', titled)) v(k, id) loop
    perform pg_temp.expect(actor.k || ' switches the season (RPC)',
      pg_temp.attempt(actor.id, format('select set_current_season(%L)', s2)), 'DENIED');
    perform pg_temp.expect(actor.k || ' flips is_current directly',
      pg_temp.attempt(actor.id, format('update seasons set is_current = true where id = %L', s2)), 'DENIED');
    perform pg_temp.expect(actor.k || ' creates a season directly',
      pg_temp.attempt(actor.id, format('insert into seasons (label) values (%L)', 'P2 forged ' || actor.k)), 'DENIED');
    perform pg_temp.expect(actor.k || ' deletes an empty season',
      pg_temp.attempt(actor.id, format('delete from seasons where id = %L', s2)), 'DENIED');
  end loop;
  perform pg_temp.expect('the current season did not move', (select is_current::text from seasons where id = season), 'true');
  perform pg_temp.expect('president switches the season (RPC)', pg_temp.attempt(pre, format('select set_current_season(%L)', s2)), 'ALLOWED');
  perform pg_temp.expect('... and it moved', (select is_current::text from seasons where id = s2), 'true');
  perform pg_temp.expect('developer switches it back (RPC)', pg_temp.attempt(dev, format('select set_current_season(%L)', season)), 'ALLOWED');
  perform pg_temp.expect('president creates a season directly', pg_temp.attempt(pre, 'insert into seasons (label) values (''P2 pres season'')'), 'ALLOWED');
  perform pg_temp.expect('developer edits a season', pg_temp.attempt(dev, format('update seasons set bike_number = 42 where id = %L', s2)), 'ALLOWED');
  perform pg_temp.expect('exactly one current season afterwards', (select count(*)::text from seasons where is_current), '1');

  -- ======================================================= role-grant matrix
  -- Expected values are written out here, not derived from can_grant_role().
  for actor in select * from (values ('president', pre), ('vicepresident', vp), ('developer', dev),
                                     ('treasurer', tre), ('documentation', doc), ('member', mem),
                                     ('retired president', alum_pre), ('job title President', titled)) v(k, id) loop
    foreach r in array array['president', 'vicepresident', 'treasurer', 'documentation', 'developer'] loop
      exp := case
        when actor.k = 'developer' then 'ALLOWED'
        when actor.k = 'president' and r <> 'developer' then 'ALLOWED'
        when actor.k = 'vicepresident' and r in ('treasurer', 'documentation') then 'ALLOWED'
        else 'DENIED' end;
      perform pg_temp.expect(format('%s grants %s', actor.k, r),
        pg_temp.attempt(actor.id, format('insert into member_roles (member_id, role, assigned_by) values (%L, %L, %L)', mem2, r, actor.id)), exp);
      delete from member_roles where member_id = mem2;
      insert into member_roles (member_id, role) values (mem2, r::privileged_role);
      perform pg_temp.expect(format('%s removes %s', actor.k, r),
        pg_temp.attempt(actor.id, format('delete from member_roles where member_id = %L and role = %L', mem2, r)), exp);
      delete from member_roles where member_id = mem2;
    end loop;
  end loop;
  perform pg_temp.expect('can_grant_role(null) is false, even for a Developer', pg_temp.val(dev, 'can_grant_role(null)'), 'false');
  perform pg_temp.expect('a grant cannot be attributed to someone else',
    pg_temp.attempt(vp, format('insert into member_roles (member_id, role, assigned_by) values (%L, ''treasurer'', %L)', mem2, pre)), 'DENIED');

  -- apply_role_plan: one forbidden row refuses the whole plan
  perform pg_temp.expect('VP plan with a forbidden developer grant is refused',
    pg_temp.attempt(vp, format('select apply_role_plan(%L::jsonb)', jsonb_build_array(
      jsonb_build_object('member_id', mem2, 'role', 'treasurer', 'action', 'add'),
      jsonb_build_object('member_id', mem2, 'role', 'developer', 'action', 'add')))), 'DENIED');
  perform pg_temp.expect('... and the allowed treasurer grant before it was rolled back too',
    (select count(*)::text from member_roles where member_id = mem2), '0');
  perform pg_temp.expect('VP plan granting documentation applies',
    pg_temp.attempt(vp, format('select apply_role_plan(%L::jsonb)', jsonb_build_array(
      jsonb_build_object('member_id', mem2, 'role', 'documentation', 'action', 'add')))), 'ALLOWED');
  perform pg_temp.expect('... it landed, attributed to the VP',
    (select (assigned_by = vp)::text from member_roles where member_id = mem2 and role = 'documentation'), 'true');
  perform pg_temp.expect('president cannot remove a Developer grant through a plan',
    pg_temp.attempt(pre, format('select apply_role_plan(%L::jsonb)', jsonb_build_array(
      jsonb_build_object('member_id', dev, 'role', 'developer', 'action', 'remove')))), 'DENIED');
  perform pg_temp.expect('... the Developer keeps the role', (select count(*)::text from member_roles where member_id = dev and role = 'developer'), '1');
  perform pg_temp.expect('member cannot call apply_role_plan',
    pg_temp.attempt(mem, format('select apply_role_plan(%L::jsonb)', jsonb_build_array(
      jsonb_build_object('member_id', mem, 'role', 'treasurer', 'action', 'add')))), 'DENIED');

  -- last President: make pre the only (active) President for this block
  delete from member_roles where role = 'president' and member_id <> pre;
  perform pg_temp.expect('VP cannot remove the President role at all',
    pg_temp.attempt(vp, format('delete from member_roles where member_id = %L and role = ''president''', pre)), 'DENIED');
  perform pg_temp.expect('a Developer cannot remove the LAST President',
    pg_temp.attempt(dev, format('delete from member_roles where member_id = %L and role = ''president''', pre)), 'DENIED');
  perform pg_temp.expect('... not through a plan either',
    pg_temp.attempt(dev, format('select apply_role_plan(%L::jsonb)', jsonb_build_array(
      jsonb_build_object('member_id', pre, 'role', 'president', 'action', 'remove')))), 'DENIED');
  perform pg_temp.expect('... the President still holds the role', (select count(*)::text from member_roles where member_id = pre and role = 'president'), '1');
  perform pg_temp.expect('the last active President cannot be retired, even by a Developer',
    pg_temp.attempt(dev, format('update members set status = ''alumni'' where id = %L', pre)), 'DENIED');

  -- roster status of role holders
  perform pg_temp.expect('VP retires a Treasurer (a role the VP manages)',
    pg_temp.attempt(vp, format('update members set status = ''alumni'' where id = %L', tre)), 'ALLOWED');
  update members set status = 'active' where id = tre;
  perform pg_temp.expect('VP cannot retire a Developer',
    pg_temp.attempt(vp, format('update members set status = ''alumni'' where id = %L', dev)), 'DENIED');
  perform pg_temp.expect('President cannot retire a Developer either',
    pg_temp.attempt(pre, format('update members set status = ''alumni'' where id = %L', dev)), 'DENIED');
  perform pg_temp.expect('member cannot retire anyone',
    pg_temp.attempt(mem, format('update members set status = ''alumni'' where id = %L', mem2)), 'DENIED');
  perform pg_temp.expect('the Developer is still active', (select status::text from members where id = dev), 'active');

  -- ================================================================= finance
  insert into finance_entries (season_id, kind, description, amount_cents) values (season, 'expense', 'P2 matrix', 100) returning id into fin;
  for actor in select * from (values ('president', pre, 'true'), ('vicepresident', vp, 'true'), ('treasurer', tre, 'true'),
                                     ('developer', dev, 'true'), ('documentation', doc, 'false'), ('member', mem, 'false'),
                                     ('retired president', alum_pre, 'false'), ('job title President', titled, 'false')) v(k, id, e) loop
    perform pg_temp.expect(actor.k || ' can_view_finances()', pg_temp.val(actor.id, 'can_view_finances()'), actor.e);
    perform pg_temp.expect(actor.k || ' reads the ledger', pg_temp.attempt(actor.id, 'select count(*) from finance_entries', 'read'),
      case when actor.e = 'true' then 'ALLOWED' else 'DENIED' end);
  end loop;
  perform pg_temp.expect('documentation cannot write the ledger',
    pg_temp.attempt(doc, format('insert into finance_entries (season_id, kind, description, amount_cents) values (%L, ''income'', ''x'', 1)', season)), 'DENIED');

  -- ================================================================ meetings
  for actor in select * from (values ('president', pre, 'ALLOWED'), ('vicepresident', vp, 'ALLOWED'), ('developer', dev, 'ALLOWED'),
                                     ('documentation', doc, 'ALLOWED'), ('treasurer', tre, 'DENIED'), ('member', mem, 'DENIED'),
                                     ('retired president', alum_pre, 'DENIED'), ('job title President', titled, 'DENIED')) v(k, id, e) loop
    perform pg_temp.expect(actor.k || ' creates a meeting',
      pg_temp.attempt(actor.id, format('insert into meetings (season_id, title, held_on) values (%L, %L, ''2026-10-01'')', season, 'P2 ' || actor.k)), actor.e);
  end loop;
  insert into meetings (season_id, title, held_on) values (season, 'P2 matrix meeting', '2026-10-02') returning id into mtg;
  perform pg_temp.expect('documentation edits a meeting', pg_temp.attempt(doc, format('update meetings set notes = ''minutes'' where id = %L', mtg)), 'ALLOWED');
  perform pg_temp.expect('member cannot edit a meeting', pg_temp.attempt(mem, format('update meetings set notes = ''x'' where id = %L', mtg)), 'DENIED');
  perform pg_temp.expect('documentation cannot delete a meeting', pg_temp.attempt(doc, format('delete from meetings where id = %L', mtg)), 'DENIED');
  perform pg_temp.expect('vicepresident cannot delete a meeting', pg_temp.attempt(vp, format('delete from meetings where id = %L', mtg)), 'DENIED');
  perform pg_temp.expect('president deletes a meeting', pg_temp.attempt(pre, format('delete from meetings where id = %L', mtg)), 'ALLOWED');
  insert into meeting_template (id, body) values (true, 'P2 template') on conflict (id) do nothing;
  perform pg_temp.expect('documentation edits the default agenda', pg_temp.attempt(doc, 'update meeting_template set body = ''doc agenda'''), 'ALLOWED');
  perform pg_temp.expect('treasurer cannot edit the default agenda', pg_temp.attempt(tre, 'update meeting_template set body = ''x'''), 'DENIED');
  perform pg_temp.expect('documentation cannot delete the default agenda', pg_temp.attempt(doc, 'delete from meeting_template'), 'DENIED');

  -- ======================================================= restore / archive
  for i in 1..10 loop
    insert into tasks (season_id, title, subteam_key, owner_id, state) values (season, 'P2 archived ' || i, da, mem, 'wip') returning id into t;
    t_r := t_r || t;
  end loop;
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks set archived_at = now(), archive_reason = 'manual' where id = any(t_r);
  perform set_config('reqon.task_lifecycle_write', 'off', true);

  perform pg_temp.expect('Head of the department restores', pg_temp.attempt(head, format('select restore_task(%L)', t_r[1])), 'ALLOWED');
  perform pg_temp.expect('Head of ANOTHER department cannot restore', pg_temp.attempt(head2, format('select restore_task(%L)', t_r[2])), 'DENIED');
  perform pg_temp.expect('President restores', pg_temp.attempt(pre, format('select restore_task(%L)', t_r[2])), 'ALLOWED');
  perform pg_temp.expect('Vice President restores', pg_temp.attempt(vp, format('select restore_task(%L)', t_r[3])), 'ALLOWED');
  perform pg_temp.expect('Developer restores', pg_temp.attempt(dev, format('select restore_task(%L)', t_r[4])), 'ALLOWED');
  perform pg_temp.expect('the owner cannot restore', pg_temp.attempt(mem, format('select restore_task(%L)', t_r[5])), 'DENIED');
  perform pg_temp.expect('Treasurer cannot restore', pg_temp.attempt(tre, format('select restore_task(%L)', t_r[5])), 'DENIED');
  perform pg_temp.expect('Documentation cannot restore', pg_temp.attempt(doc, format('select restore_task(%L)', t_r[5])), 'DENIED');
  perform pg_temp.expect('a retired President cannot restore', pg_temp.attempt(alum_pre, format('select restore_task(%L)', t_r[5])), 'DENIED');
  perform pg_temp.expect('a job title of President cannot restore', pg_temp.attempt(titled, format('select restore_task(%L)', t_r[5])), 'DENIED');
  perform pg_temp.expect('restoring an active task is refused', pg_temp.attempt(pre, format('select restore_task(%L)', t_r[1])), 'ERROR 22023%');
  -- a revoked headship takes effect on the next call
  update subteams set lead_id = head2 where key = da;
  perform pg_temp.expect('a former Head can no longer restore', pg_temp.attempt(head, format('select restore_task(%L)', t_r[6])), 'DENIED');
  perform pg_temp.expect('the newly appointed Head can', pg_temp.attempt(head2, format('select restore_task(%L)', t_r[6])), 'ALLOWED');
  update subteams set lead_id = head where key = da;

  -- provenance: a scheduler-archived Done task restored by the VP reopens to todo
  insert into tasks (season_id, title, subteam_key, owner_id, state) values (season, 'P2 done', da, mem, 'done') returning id into t_done;
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  perform set_config('reqon.system_actor', 'archive_scheduler', true);
  update tasks set archived_at = now(), archive_reason = 'auto_done_24h' where id = t_done;
  perform set_config('reqon.system_actor', 'off', true);
  perform set_config('reqon.task_lifecycle_write', 'off', true);
  perform pg_temp.expect('VP restores an automatically archived Done task', pg_temp.attempt(vp, format('select restore_task(%L)', t_done)), 'ALLOWED');
  perform pg_temp.expect('... it reopens to todo with completion and archive metadata cleared',
    (select (state = 'todo' and completed_at is null and completion_source is null
             and archived_at is null and archived_by is null and archive_reason is null)::text from tasks where id = t_done), 'true');
  perform pg_temp.expect('... the audit row names the VP and the original archive reason',
    (select count(*)::text from activity where entity = 'task' and entity_id = t_done::text and action = 'restored'
       and actor_id = vp and detail ->> 'reason' = 'auto_done_24h'), '1');

  -- archive: Head of the department yes; another Head, the President (department HAS a Head) no
  insert into tasks (season_id, title, subteam_key, owner_id, state) values (season, 'P2 live', da, mem, 'wip') returning id into t_live;
  perform pg_temp.expect('Head of ANOTHER department cannot archive', pg_temp.attempt(head2, format('select archive_task(%L)', t_live)), 'DENIED');
  perform pg_temp.expect('President cannot archive in a department that has a Head', pg_temp.attempt(pre, format('select archive_task(%L)', t_live)), 'DENIED');
  perform pg_temp.expect('President cannot edit a task in a department that has a Head', pg_temp.attempt(pre, format('update tasks set detail = ''x'' where id = %L', t_live)), 'DENIED');
  perform pg_temp.expect('Head archives in their department', pg_temp.attempt(head, format('select archive_task(%L)', t_live)), 'ALLOWED');
  perform pg_temp.expect('... recorded as a manual archive by the Head',
    (select (archive_reason = 'manual' and archived_by = head)::text from tasks where id = t_live), 'true');

  -- ===================================== job titles and retired holders grant nothing
  foreach r in array array['can_manage_departments()', 'can_manage_seasons()', 'can_manage_roles()', 'is_admin()',
                           'can_edit_meetings()', 'can_view_finances()', 'has_department_authority(null)'] loop
    perform pg_temp.expect('job title "President" -> ' || r, pg_temp.val(titled, r), 'false');
    perform pg_temp.expect('retired President -> ' || r, pg_temp.val(alum_pre, r), 'false');
  end loop;

  -- ======================================================== milestone sections
  insert into milestone_sections (milestone_key, ordinal, name)
    select key, 900, 'P2 section' from milestones where season_id = season order by ordinal limit 1
    returning id into sec;
  perform pg_temp.expect('member cannot create a section',
    pg_temp.attempt(mem, format('insert into milestone_sections (milestone_key, ordinal, name) select milestone_key, 901, ''x'' from milestone_sections where id = %L', sec)), 'DENIED');
  perform pg_temp.expect('documentation creates a section',
    pg_temp.attempt(doc, format('insert into milestone_sections (milestone_key, ordinal, name) select milestone_key, 902, ''doc'' from milestone_sections where id = %L', sec)), 'ALLOWED');
  perform pg_temp.expect('member ticks a section drafted', pg_temp.attempt(mem, format('update milestone_sections set is_drafted = true where id = %L', sec)), 'ALLOWED');
  perform pg_temp.expect('member cannot rename a section', pg_temp.attempt(mem, format('update milestone_sections set name = ''renamed'' where id = %L', sec)), 'DENIED');
  perform pg_temp.expect('member cannot take ownership of a section', pg_temp.attempt(mem, format('update milestone_sections set owner_id = %L where id = %L', mem, sec)), 'DENIED');
  perform pg_temp.expect('member cannot delete a section', pg_temp.attempt(mem, format('delete from milestone_sections where id = %L', sec)), 'DENIED');
  perform pg_temp.expect('vicepresident deletes an unreferenced section', pg_temp.attempt(vp, format('delete from milestone_sections where id = %L', sec)), 'ALLOWED');

  -- ======================================================= requirement status
  delete from clause_status where season_id = season and clause_key = clause;
  perform pg_temp.expect('member records a requirement status',
    pg_temp.attempt(mem, format('insert into clause_status (season_id, clause_key, state) values (%L, %L, ''wip'')', season, clause)), 'ALLOWED');
  perform pg_temp.expect('member changes it', pg_temp.attempt(mem, format('update clause_status set state = ''compliant'', evidence = ''photo'' where season_id = %L and clause_key = %L', season, clause)), 'ALLOWED');
  perform pg_temp.expect('member cannot delete it', pg_temp.attempt(mem, format('delete from clause_status where season_id = %L and clause_key = %L', season, clause)), 'DENIED');
  perform pg_temp.expect('nor can the President', pg_temp.attempt(pre, format('delete from clause_status where season_id = %L and clause_key = %L', season, clause)), 'DENIED');
  perform pg_temp.expect('the status changes are audited (open->wip, wip->compliant) with the actor',
    (select count(*)::text from activity where entity = 'requirement' and entity_id = clause and action = 'status_changed' and actor_id = mem and season_id = season), '2');
  perform pg_temp.expect('the evidence change is audited without its text',
    (select (detail = '{"had_value": false, "has_value": true}'::jsonb)::text from activity
       where entity = 'requirement' and entity_id = clause and action = 'evidence_changed' and actor_id = mem), 'true');
  perform pg_temp.expect('an alumnus cannot change requirement status',
    pg_temp.attempt(alum_pre, format('update clause_status set state = ''open'' where season_id = %L and clause_key = %L', season, clause)), 'DENIED');

  -- ================================================== function EXECUTE surface
  perform pg_temp.expect('anon can execute no SECURITY DEFINER function in public',
    (select count(*)::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
       and has_function_privilege('anon', p.oid, 'execute')), '0');
  perform pg_temp.expect('authenticated can execute no SECURITY DEFINER trigger function',
    (select count(*)::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
       and p.prorettype = 'trigger'::regtype and has_function_privilege('authenticated', p.oid, 'execute')), '0');
  perform pg_temp.expect('authenticated still executes the helpers RLS needs',
    (select bool_and(has_function_privilege('authenticated', p.oid, 'execute'))::text from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('is_member', 'is_active_member', 'is_admin', 'can_edit_task', 'can_review_proposal',
                           'can_manage_departments', 'can_view_finances', 'can_manage_finances', 'can_edit_meetings',
                           'can_delete_records', 'can_grant_role', 'can_manage_seasons', 'can_edit_spec_targets',
                           'can_manage_milestone_structure', 'department_authority', 'has_department_authority')), 'true');
  perform pg_temp.expect('anon cannot call a command', pg_temp.attempt(null, format('select set_current_season(%L)', s2)), 'DENIED');
  perform pg_temp.expect('the maintenance schema is not usable by API roles',
    coalesce((select (not has_schema_privilege('authenticated', n.oid, 'usage') and not has_schema_privilege('anon', n.oid, 'usage'))::text
       from pg_namespace n where n.nspname = 'maintenance'), 'true'), 'true');

  -- ================================================================= verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'PERMISSION MATRIX CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'PERMISSION MATRIX CHECKS PASSED — all % checks', total;
end
$test$;
