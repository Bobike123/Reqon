-- =============================================================================
--  2026/27 reconciliation checks (20260125000000..20260125000300).
--
--  The migrated end state (five departments, subjects kept, clause owners and
--  pages), that no API session can reach the maintenance functions, that every
--  function is a no-op on retry, that each refuses a conflict and changes
--  nothing, and that a crafted legacy department with live work, a Head, a
--  handover note and a requirement is remapped without losing or inventing
--  anything.
--
--  Everything happens in one block that ends by raising an exception, so every
--  row rolls back. Safe against a real project for that reason, but written
--  for the disposable database scripts/verify_db.sh builds.
--      DEPARTMENT RECONCILIATION CHECKS PASSED   or   ... CHECKS FAILED
-- =============================================================================

create or replace function pg_temp.as_api(stmt text) returns text
language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  begin
    execute stmt into r;
    r := 'ALLOWED';
  exception when others then
    r := 'E:' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  return r;
end $fn$;

create or replace function pg_temp.try(stmt text) returns text
language plpgsql as $fn$
begin
  execute stmt;
  return 'ALLOWED';
exception when others then
  return 'E:' || sqlstate || ' ' || sqlerrm;
end $fn$;

create temp table results (n serial, label text, ok boolean, detail text);
create or replace function pg_temp.chk(label text, ok boolean, detail text default null) returns void
language plpgsql as $fn$
begin
  insert into results (label, ok, detail) values (label, coalesce(ok, false), detail);
end $fn$;

do $test$
declare
  c_legacy constant text[] := array['ADMIN','GEOM','CHASSIS','BODY','CONTROL','BRAKES','WHEELS',
                                    'LIVERY','RIDER','PWR_EF','SCRUT','DOCS','RACEOP'];
  hd uuid := gen_random_uuid();
  claudiu uuid := gen_random_uuid();
  sX uuid; s27 uuid;
  t_live uuid; t_done uuid; t_done_at timestamptz; p_open uuid; h_note uuid;
  t_bank uuid; t_cvr uuid; t_sdu uuid;
  res jsonb; q text;
  nfail int; ntotal int;
begin
  -- ===================================================== the migrated state
  perform pg_temp.chk('the five departments exist, active, named and ordered as adopted',
    (select string_agg(key || '=' || name, '; ' order by sort_order) from subteams
      where key in ('SWDATA','MECH','ELEC','BUILD','OPS') and archived_at is null)
    = 'SWDATA=Software & Data Acquisition; MECH=Mechanical Design & Testing; ELEC=Electrical Systems & Integration; BUILD=Manufacturing & Assembly; OPS=Project Operations & Documentation');
  perform pg_temp.chk('no legacy department row survives',
    not exists (select 1 from subteams where key = any(c_legacy)));
  perform pg_temp.chk('the 14 rulebook subjects are kept as reference data',
    (select count(*) from regulation_subjects) = 14);
  perform pg_temp.chk('every clause keeps the subject it was filed under',
    not exists (select 1 from clauses where source_subject_key is null));
  perform pg_temp.chk('757 clauses owned by one of the five, 389 unassigned',
    (select count(*) from clauses where subteam_key in ('SWDATA','MECH','ELEC','BUILD','OPS')) = 757
    and (select count(*) from clauses where subteam_key is null) = 389);
  perform pg_temp.chk('ownership follows the reviewed data, not the old subject (spot checks)',
    (select string_agg(clause_key || '>' || coalesce(subteam_key, '-'), ' ' order by clause_key) from clauses
      where clause_key in ('A.1.1.1', 'B.10.1.1', 'B.12.1.1', 'E.5.4.5#2', 'F.5.2.3#2'))
    = 'A.1.1.1>OPS B.10.1.1>ELEC B.12.1.1>- E.5.4.5#2>- F.5.2.3#2>-');
  perform pg_temp.chk('every MS2627 Rev.01 clause opens on a page within 1..234',
    not exists (select 1 from clauses where regs_ref = 'MS2627 Rev.01'
                  and (source_page is null or source_page not between 1 and 234)));
  perform pg_temp.chk('duplicate printed numbers keep their own pages (E.5.4.5 121/122, F.13.3.1 171)',
    (select string_agg(clause_key || '@' || source_page, ' ' order by clause_key) from clauses
      where clause_key in ('E.5.4.5', 'E.5.4.5#2', 'F.13.3.1'))
    = 'E.5.4.5@121 E.5.4.5#2@122 F.13.3.1@171');
  perform pg_temp.chk('the book records 234 pages, offset 0, and no file path SQL could not have uploaded',
    (select page_count = 234 and page_offset = 0 and storage_path is null and url is null
       from regulation_documents where regs_ref = 'MS2627 Rev.01'));

  -- =================================================== no API access at all
  perform pg_temp.chk('no API role has USAGE on the maintenance schema',
    not has_schema_privilege('authenticated', 'maintenance', 'USAGE')
    and not has_schema_privilege('anon', 'maintenance', 'USAGE'));
  q := pg_temp.as_api('select maintenance.reconcile_five_departments(''[]''::jsonb)::text');
  perform pg_temp.chk('a signed-in session cannot run the department reconciliation', q = 'E:42501', q);
  q := pg_temp.as_api('select maintenance.apply_requirement_pages(''MS2627 Rev.01'', 234, ''[]''::jsonb)::text');
  perform pg_temp.chk('a signed-in session cannot run the page map', q = 'E:42501', q);
  q := pg_temp.as_api('select maintenance.reconcile_source_tasks()::text');
  perform pg_temp.chk('a signed-in session cannot run the task reconciliation', q = 'E:42501', q);

  -- ================================================================ retries
  res := maintenance.reconcile_five_departments('[]');
  perform pg_temp.chk('running the department reconciliation again changes nothing', res->>'applied' = 'false', res::text);

  q := pg_temp.try('update clauses set source_subject_key = ''GEOM'' where clause_key = ''A.1.1.1''');
  perform pg_temp.chk('a clause''s rulebook subject cannot be rewritten', q like 'E:23514%', q);

  -- ================================ a crafted legacy department, remapped
  -- Other test fixtures may have left extra active departments; the
  -- reconciliation rightly refuses to run beside an unknown one, so park them.
  update subteams set archived_at = now(), archive_reason = 'recon-test headroom'
  where archived_at is null and key not in ('SWDATA','MECH','ELEC','BUILD','OPS')
    and not exists (select 1 from tasks t where t.subteam_key = subteams.key and t.state not in ('done', 'cancelled'));

  insert into auth.users (id, email) values (hd, 'recon-head@t.test'), (claudiu, 'recon-claudiu@t.test');
  insert into members (id, full_name, role, status) values (hd, 'Recon Head', 'Chassis', 'active');
  insert into seasons (label, is_current) values ('RECON-X', false) returning id into sX;
  insert into subteams (key, name, sort_order, lead_id) values ('CHASSIS', 'Chassis & Structure', 2, hd);
  insert into tasks (season_id, title, subteam_key, state) values (sX, 'Recon live work', 'CHASSIS', 'wip') returning id into t_live;
  insert into tasks (season_id, title, subteam_key, state) values (sX, 'Recon finished work', 'CHASSIS', 'done') returning id into t_done;
  select completed_at into t_done_at from tasks where id = t_done;
  insert into task_proposals (season_id, title, raised_by, subteam_key) values (sX, 'Recon open proposal', hd, 'CHASSIS') returning id into p_open;
  insert into handover_notes (season_id, subteam_key, body) values (sX, 'CHASSIS', 'Recon note') returning id into h_note;
  update clauses set subteam_key = 'CHASSIS' where clause_key = 'B.3.1.1';

  res := maintenance.reconcile_five_departments('[["B.3.1.1","CHASSIS","MECH"]]');
  perform pg_temp.chk('a legacy department with live work is reconciled', res->>'applied' = 'true', res::text);
  perform pg_temp.chk('its live and finished tasks move to MECH with ids kept',
    (select count(*) from tasks where id in (t_live, t_done) and subteam_key = 'MECH') = 2);
  perform pg_temp.chk('the finished task keeps its original completion time',
    (select completed_at = t_done_at from tasks where id = t_done));
  perform pg_temp.chk('its open proposal moves to MECH',
    (select subteam_key = 'MECH' from task_proposals where id = p_open));
  perform pg_temp.chk('its handover note keeps its id and text and moves to MECH',
    (select subteam_key = 'MECH' and body = 'Recon note' from handover_notes where id = h_note));
  perform pg_temp.chk('its requirement moves to the reviewed owner',
    (select subteam_key = 'MECH' and source_subject_key = 'CHASSIS' from clauses where clause_key = 'B.3.1.1'));
  perform pg_temp.chk('the legacy row is gone, but recorded with its Head',
    not exists (select 1 from subteams where key = 'CHASSIS')
    and exists (select 1 from activity where entity = 'department' and entity_id = 'CHASSIS'
                  and action = 'removed' and detail->'row'->>'lead_id' = hd::text));
  perform pg_temp.chk('the Head is reported as a hold and NOT given the new department',
    (select lead_id is null from subteams where key = 'MECH')
    and res->'holds' @> jsonb_build_array(jsonb_build_object('legacy_department', 'CHASSIS', 'lead_id', hd)));
  perform pg_temp.chk('every move is in the audit trail',
    (select count(*) from activity where action = 'department_remapped'
       and entity_id in (t_live::text, t_done::text, p_open::text, h_note::text)) = 4);

  -- ======================================= conflicts are refused, all-or-nothing
  insert into subteams (key, name, sort_order) values ('RIDER', 'Rider Equipment', 9);
  insert into handover_notes (season_id, subteam_key, body) values (sX, 'RIDER', 'Rider note');
  q := pg_temp.try('select maintenance.reconcile_five_departments(''[]''::jsonb)');
  perform pg_temp.chk('a written handover note with no target department is refused', q like 'E:23514%RIDER%', q);
  perform pg_temp.chk('the refusal changed nothing',
    exists (select 1 from subteams where key = 'RIDER')
    and exists (select 1 from handover_notes where subteam_key = 'RIDER' and body = 'Rider note'));
  delete from handover_notes where season_id = sX and subteam_key = 'RIDER';

  insert into subteams (key, name, sort_order) values ('XTRA', 'Unknown department', 50);
  q := pg_temp.try('select maintenance.reconcile_five_departments(''[]''::jsonb)');
  perform pg_temp.chk('an unknown active department is refused, not silently kept or dropped', q like 'E:23514%XTRA%', q);
  delete from subteams where key = 'XTRA';

  update clauses set subteam_key = 'RIDER' where clause_key = 'B.12.1.1';
  q := pg_temp.try('select maintenance.reconcile_five_departments(''[["B.12.1.1","GEOM",null]]''::jsonb)');
  perform pg_temp.chk('reviewed data that disagrees with the recorded subject is refused', q like 'E:23514%subject GEOM%', q);

  res := maintenance.reconcile_five_departments('[["B.12.1.1","RIDER",null]]');
  perform pg_temp.chk('an uncertain requirement is left unassigned, its subject kept',
    res->>'applied' = 'true'
    and (select subteam_key is null and source_subject_key = 'RIDER' from clauses where clause_key = 'B.12.1.1'));

  -- ================================================================ page map
  q := pg_temp.try('select maintenance.apply_requirement_pages(''MS2627 Rev.01'', 234, ''[["A.1.1.1", 8]]''::jsonb)');
  perform pg_temp.chk('a page that disagrees with the recorded page is refused', q like 'E:23514%A.1.1.1%', q);
  q := pg_temp.try('select maintenance.apply_requirement_pages(''MS2627 Rev.01'', 234, ''[["A.1.1.1", 999]]''::jsonb)');
  perform pg_temp.chk('a page outside the book is refused', q like 'E:23514%outside%', q);
  q := pg_temp.try('select maintenance.apply_requirement_pages(''MS2627 Rev.01'', 235, ''[]''::jsonb)');
  perform pg_temp.chk('a different page count for the same edition is refused', q like 'E:23514%234 pages%', q);
  res := maintenance.apply_requirement_pages('MS2627 Rev.01', 234, '[["A.1.1.1", 7]]');
  perform pg_temp.chk('re-applying a recorded page is a no-op',
    (res->>'pages_set')::int = 0 and (res->>'pages_already_recorded')::int = 1, res::text);

  -- ============================================ task source reconciliation
  select id into s27 from seasons where label = '2026/27';
  insert into tasks (season_id, title, state, updated_at)
    values (s27, 'Open organization bank account (Danske Bank)', 'todo', '2026-09-11T18:23:33Z') returning id into t_bank;
  insert into tasks (season_id, title, state)
    values (s27, 'Register organization as non-profit to get business CVR', 'todo') returning id into t_cvr;
  insert into tasks (season_id, title, state, updated_at)
    values (s27, 'Submit official SDU form for new student organization', 'done', '2026-09-11T18:23:33Z') returning id into t_sdu;

  res := maintenance.reconcile_source_tasks();
  perform pg_temp.chk('a seed-default todo older than the sheet becomes wip, with no completion time',
    (select state = 'wip' and completed_at is null from tasks where id = t_bank), res::text);
  perform pg_temp.chk('a task edited after the sheet was saved is left alone',
    (select state = 'todo' from tasks where id = t_cvr));
  perform pg_temp.chk('a live done is never downgraded by an older source status',
    (select state = 'done' from tasks where id = t_sdu));
  perform pg_temp.chk('the source-backed task is held while its owner does not resolve',
    not exists (select 1 from tasks where season_id = s27 and title = 'Develop the requirements and project database'));

  insert into members (id, full_name, role, status) values (claudiu, 'Claudiu-Bogdan Ispas', 'Developer', 'active');
  res := maintenance.reconcile_source_tasks();
  perform pg_temp.chk('once the owner resolves, the task is inserted once, in progress, with nothing invented',
    (select count(*) = 1 and bool_and(state = 'wip' and owner_id = claudiu and created_by is null
                 and source_proposal is null and subteam_key is null and due_date is null
                 and starts_on = '2026-09-08')
       from tasks where season_id = s27 and title = 'Develop the requirements and project database'), res::text);
  perform pg_temp.chk('the import names its sources in the audit trail',
    exists (select 1 from activity where action = 'imported'
              and detail->>'title' = 'Develop the requirements and project database'
              and jsonb_array_length(detail->'sources') = 2));

  res := maintenance.reconcile_source_tasks();
  perform pg_temp.chk('running the task reconciliation again changes nothing',
    jsonb_array_length(res->'applied') = 0
    and (select count(*) from tasks where season_id = s27 and title = 'Develop the requirements and project database') = 1
    and (select count(*) from activity where action = 'source_reconciled' and entity_id = t_bank::text) = 1, res::text);

  -- ================================================================ verdict
  select count(*) filter (where not ok), count(*) into nfail, ntotal from results;
  if nfail > 0 then
    raise exception E'DEPARTMENT RECONCILIATION CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      nfail, ntotal,
      (select string_agg(label || coalesce(': ' || detail, ''), E'\n' order by n) from results where not ok),
      (select string_agg(case when ok then 'ok  ' else 'FAIL' end || '  ' || label, E'\n' order by n) from results);
  end if;
  raise exception E'DEPARTMENT RECONCILIATION CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    ntotal, (select string_agg('ok    ' || label, E'\n' order by n) from results);
end
$test$;
