-- =============================================================================
--  Department lifecycle checks (20260115000000_department_lifecycle.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything happens inside one DO
--  block that always ends by raising an exception, so Postgres rolls every
--  change back — reconciliation_apply() included, even though it commits
--  actions internally as part of the same outer statement. Nothing is left
--  behind, pass or fail.
--
--  The REAL two-process races for the 10-active cap (two concurrent creates,
--  and a create racing a restore) cannot run inside one session and are
--  therefore in scripts/verify_db.sh instead, alongside the existing
--  promote_proposal() race. This file covers everything that a single
--  session can prove: the role matrix, protected-column-style invariants
--  (valid Head, no stranding, the cap's single-session boundary), Head
--  authority following current roster status, and reconciliation
--  preflight/apply including its refusal path.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations.
--  The result arrives as an "error" message that begins with
--      DEPARTMENT LIFECYCLE CHECKS PASSED   every check behaved as expected, or
--      DEPARTMENT LIFECYCLE CHECKS FAILED   followed by the ones that did not.
-- =============================================================================

-- Unlike the upstream copy of this helper (roles_rls_test.sql and
-- friends), this one resets role/claims in EVERY outcome, not only the
-- success path: this file interleaves plain (non-attempt) admin-privileged
-- setup statements between attempt() calls, and set_config(..., true) is
-- transaction-scoped, so a DENIED/ERROR attempt that skipped the reset
-- would leave every later statement in this same DO block silently running
-- as that last-attempted (often unprivileged) caller instead of the
-- superuser session identity.
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
    perform set_config('request.jwt.claims',
      json_build_object('sub', who, 'role', 'authenticated')::text, true);
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
    -- A raised invariant (cap, invalid head, stranded work) is not an RLS
    -- refusal; tests that expect one check its errcode/message directly
    -- instead of relying on this generic classifier.
    when others then result := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;

  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return result;
end $fn$;

do $test$
declare
  pre  uuid := gen_random_uuid();  -- president
  vp   uuid := gen_random_uuid();  -- vice-president
  dev  uuid := gen_random_uuid();  -- developer
  tre  uuid := gen_random_uuid();  -- treasurer (alone: no department authority)
  m1   uuid := gen_random_uuid();  -- active member, becomes Head of two departments
  m2   uuid := gen_random_uuid();  -- active member, retires mid-test
  alum uuid := gen_random_uuid();  -- alumnus, no privileged role
  season uuid;
  got text;
  failures text[] := '{}';
  scratch int;
begin
  insert into auth.users (id, email) values
    (pre,'dl-pre@t.test'),(vp,'dl-vp@t.test'),(dev,'dl-dev@t.test'),(tre,'dl-tre@t.test'),
    (m1,'dl-m1@t.test'),(m2,'dl-m2@t.test'),(alum,'dl-alum@t.test');
  insert into members (id, full_name, status) values
    (pre,'DL President','active'),(vp,'DL Vice','active'),(dev,'DL Developer','active'),
    (tre,'DL Treasurer','active'),(m1,'DL Member One','active'),(m2,'DL Member Two','active'),
    (alum,'DL Alumnus','alumni');
  insert into member_roles (member_id, role) values
    (pre,'president'),(vp,'vicepresident'),(dev,'developer'),(tre,'treasurer');

  select id into season from seasons where is_current;

  -- Guarantee headroom under the cap regardless of how many departments are
  -- active when this file runs: a bare seed starts at 14 (over the cap, see
  -- BASELINE V1), and this file may also run after verify_db.sh has already
  -- reconciled down to exactly 10. Keep a small, guaranteed task-free set
  -- active and archive the rest — safe because this file rolls back
  -- everything at the end regardless, and safe against the archive-guard
  -- trigger because it never selects a department that has an active task.
  update subteams set archived_at = now(), archived_by = pre, archive_reason = 'dl-test-headroom'
  where archived_at is null
    and not exists (select 1 from tasks t where t.subteam_key = subteams.key and t.state not in ('done', 'cancelled'))
    and key not in (
      select s.key from subteams s
      where s.archived_at is null
        and not exists (select 1 from tasks t2 where t2.subteam_key = s.key and t2.state not in ('done', 'cancelled'))
      order by s.key limit 2
    );

  -- =========================================================== role matrix
  -- can_manage_departments(): president, vp, developer allowed; treasurer
  -- alone, an ordinary member, an alumnus and a signed-out caller denied.
  got := pg_temp.attempt(pre, 'insert into subteams (key, name) values (''DL_P'', ''DL P'')');
  if got <> 'ALLOWED' then failures := failures || format('president create: expected ALLOWED, got %s', got); end if;

  got := pg_temp.attempt(vp, 'insert into subteams (key, name) values (''DL_V'', ''DL V'')');
  if got <> 'ALLOWED' then failures := failures || format('vp create: expected ALLOWED, got %s', got); end if;

  got := pg_temp.attempt(dev, 'insert into subteams (key, name) values (''DL_D'', ''DL D'')');
  if got <> 'ALLOWED' then failures := failures || format('developer create: expected ALLOWED, got %s', got); end if;

  got := pg_temp.attempt(tre, 'insert into subteams (key, name) values (''DL_T'', ''DL T'')');
  if got <> 'DENIED' then failures := failures || format('treasurer-alone create: expected DENIED, got %s', got); end if;

  got := pg_temp.attempt(m1, 'insert into subteams (key, name) values (''DL_M'', ''DL M'')');
  if got <> 'DENIED' then failures := failures || format('member create: expected DENIED, got %s', got); end if;

  got := pg_temp.attempt(alum, 'insert into subteams (key, name) values (''DL_A'', ''DL A'')');
  if got <> 'DENIED' then failures := failures || format('alumnus create: expected DENIED, got %s', got); end if;

  got := pg_temp.attempt(null, 'insert into subteams (key, name) values (''DL_N'', ''DL N'')');
  if got <> 'DENIED' then failures := failures || format('signed-out create: expected DENIED, got %s', got); end if;

  -- Rename/describe do not touch archived_at, so they cannot collide with
  -- the cap trigger: a clean test of RLS alone, independent of "the cap"
  -- below.
  got := pg_temp.attempt(m1, 'update subteams set description = ''hi'' where key = ''DL_P''');
  if got <> 'DENIED' then failures := failures || format('member rename/describe: expected DENIED, got %s', got); end if;

  got := pg_temp.attempt(tre, 'update subteams set archived_at = now() where key = ''DL_P''');
  if got <> 'DENIED' then failures := failures || format('treasurer-alone archive: expected DENIED, got %s', got); end if;

  -- Everyone, including alumni, still reads every department.
  got := pg_temp.attempt(alum, 'select count(*) from subteams', 'read');
  if got <> 'ALLOWED' then failures := failures || format('alumnus read: expected ALLOWED, got %s', got); end if;

  -- ===================================================== invalid Head, valid Head
  got := pg_temp.attempt(pre, format('update subteams set lead_id = %L where key = ''DL_P''', alum));
  if got <> 'ERROR 23514: The Head of a department must be an active member.' then
    failures := failures || format('lead_id = alumnus: expected the active-member error, got %s', got);
  end if;

  got := pg_temp.attempt(pre, format('update subteams set lead_id = %L where key = ''DL_P''', gen_random_uuid()));
  if got <> 'ERROR 23514: The Head of a department must be an active member.' then
    failures := failures || format('lead_id = nonexistent id: expected the active-member error, got %s', got);
  end if;

  -- Multi-department Head: m1 heads both DL_P and DL_V at once.
  perform pg_temp.attempt(pre, format('update subteams set lead_id = %L where key in (''DL_P'',''DL_V'')', m1));
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', m1::text, true);
  if not is_department_head('DL_P') then failures := failures || array['multi-head: expected is_department_head(DL_P) true for m1']::text[]; end if;
  if not is_department_head('DL_V') then failures := failures || array['multi-head: expected is_department_head(DL_V) true for m1']::text[]; end if;
  if is_department_head('DL_D') then failures := failures || array['multi-head: expected is_department_head(DL_D) false for m1']::text[]; end if;
  perform set_config('role', 'none', true);

  -- Head authority follows CURRENT roster status, not a stored flag: make m2
  -- Head of DL_D, confirm authority, retire m2, confirm authority is gone —
  -- with no edit to lead_id at all.
  perform pg_temp.attempt(pre, format('update subteams set lead_id = %L where key = ''DL_D''', m2));
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', m2::text, true);
  if not is_department_head('DL_D') then failures := failures || array['retirement: expected is_department_head(DL_D) true for m2 before retiring']::text[]; end if;
  perform set_config('role', 'none', true);
  -- The President retires m2 (20260118: only an active administrator may change
  -- roster status, so this is done as the President rather than as a bare owner
  -- session that still carries m2's claims).
  got := pg_temp.attempt(pre, format('update members set status = ''alumni'' where id = %L', m2));
  if got <> 'ALLOWED' then failures := failures || format('retirement: the President retiring m2 expected ALLOWED, got %s', got); end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', m2::text, true);
  if is_department_head('DL_D') then failures := failures || array['retirement: expected is_department_head(DL_D) false for m2 after retiring, with lead_id untouched']::text[]; end if;
  perform set_config('role', 'none', true);
  if not exists (select 1 from subteams where key = 'DL_D' and lead_id = m2) then
    failures := failures || array['retirement: lead_id should stay pointing at m2 (stale, for Settings to flag) rather than being cleared']::text[];
  end if;

  -- Head revocation: the President clears it explicitly.
  got := pg_temp.attempt(pre, 'update subteams set lead_id = null where key = ''DL_D''');
  if got <> 'ALLOWED' then failures := failures || format('head revocation: expected ALLOWED, got %s', got); end if;
  if exists (select 1 from subteams where key = 'DL_D' and lead_id is not null) then
    failures := failures || array['head revocation: lead_id should now be null']::text[];
  end if;

  -- ============================================================ parked != archived
  -- A dedicated department (not the seed's RACEOP, whose state this test's
  -- own headroom-clearing above may already have archived): setting
  -- is_parked must not touch archived_at, and a parked-but-active row must
  -- still count toward the active total.
  insert into subteams (key, name, is_parked) values ('DL_PARK', 'DL Parked', true);
  if not exists (select 1 from subteams where key = 'DL_PARK' and is_parked and archived_at is null) then
    failures := failures || array['parked/archived: a parked department should stay active (counts toward the cap) until explicitly archived']::text[];
  end if;
  update subteams set archived_at = now(), archive_reason = 'dl-test' where key = 'DL_PARK';
  if not exists (select 1 from subteams where key = 'DL_PARK' and is_parked and archived_at is not null) then
    failures := failures || array['parked/archived: archiving a parked department must not clear is_parked']::text[];
  end if;

  -- =========================================================== archive guards
  insert into tasks (season_id, title, subteam_key, state) values (season, 'DL active work', 'DL_P', 'todo');
  got := pg_temp.attempt(pre, 'update subteams set archived_at = now(), archive_reason = ''t'' where key = ''DL_P''');
  if got <> 'ERROR 23514: Cannot archive department "DL_P": 1 task(s) still reference it. Reassign or finish them first.' then
    failures := failures || format('archive with active task: expected the stranded-work error, got %s', got);
  end if;
  update tasks set state = 'done' where subteam_key = 'DL_P';
  got := pg_temp.attempt(pre, 'update subteams set archived_at = now(), archived_by = null, archive_reason = ''t'' where key = ''DL_P''');
  if got <> 'ALLOWED' then failures := failures || format('archive once work is done: expected ALLOWED, got %s', got); end if;
  if not exists (select 1 from subteams where key = 'DL_P' and archived_at is not null) then
    failures := failures || array['archive: DL_P should now be archived']::text[];
  end if;
  -- Archived departments keep classifying and stay readable — never deleted.
  update clauses set subteam_key = 'DL_P' where clause_key = (select clause_key from clauses limit 1);
  got := pg_temp.attempt(alum, 'select count(*) from subteams where key = ''DL_P''', 'read');
  if got <> 'ALLOWED' then failures := failures || array['archived department should remain readable']::text[]; end if;

  -- Restoring DL_P: allowed while under the cap.
  got := pg_temp.attempt(pre, 'update subteams set archived_at = null, archived_by = null, archive_reason = null where key = ''DL_P''');
  if got <> 'ALLOWED' then failures := failures || format('restore under the cap: expected ALLOWED, got %s', got); end if;

  -- =================================================================== the cap
  -- Reach exactly 9 active using fresh, dedicated departments only — never
  -- restoring an arbitrary seed key by alphabetical position, which could
  -- silently reuse a key another part of this test (e.g. DL_D, used below
  -- as the deterministic "restore at the cap" target) depends on staying
  -- archived. Archive DL_P/DL_V/DL_D first (they are not touched again),
  -- then create as many DL_Cn as needed, or archive further if somehow
  -- already above 9.
  update subteams set archived_at = now(), archive_reason = 'dl-test' where key in ('DL_P','DL_V','DL_D');
  declare
    need int;
    i int := 1;
  begin
    select 9 - count(*) into need from subteams where archived_at is null;
    while need > 0 loop
      insert into subteams (key, name, sort_order) values ('DL_C' || i, 'DL Cap ' || i, 200 + i);
      i := i + 1;
      need := need - 1;
    end loop;
    if need < 0 then
      update subteams set archived_at = now(), archive_reason = 'dl-test'
      where key in (select key from subteams where archived_at is null order by key limit (-need));
    end if;
  end;
  if (select count(*) from subteams where archived_at is null) <> 9 then
    failures := failures || array['cap setup: expected exactly 9 active departments before the boundary check']::text[];
  end if;

  got := pg_temp.attempt(pre, 'insert into subteams (key, name) values (''DL_10'', ''DL 10'')');
  if got <> 'ALLOWED' then failures := failures || format('10th active department: expected ALLOWED, got %s', got); end if;

  got := pg_temp.attempt(pre, 'insert into subteams (key, name) values (''DL_11'', ''DL 11'')');
  if got !~ '^ERROR 23514: At most 10 active departments' then
    failures := failures || format('11th active department: expected the cap error, got %s', got);
  end if;
  if exists (select 1 from subteams where key = 'DL_11') then
    failures := failures || array['11th active department: the row should not have been created at all']::text[];
  end if;

  -- The cap binds EVERY writer, not only a hypothetical "create" command: an
  -- admin restoring an archived row is refused identically once at the cap.
  -- DL_D was archived at the top of this section and untouched since, so
  -- its state here is certain (unlike an alphabetically-picked seed key).
  got := pg_temp.attempt(pre, 'update subteams set archived_at = null where key = ''DL_D''');
  if got !~ '^ERROR 23514: At most 10 active departments' then
    failures := failures || format('restore at the cap: expected the cap error, got %s', got);
  end if;

  -- ==================================================== reorder_departments
  got := pg_temp.attempt(m1, 'select reorder_departments(array[''OPS''])');
  if got <> 'DENIED' then failures := failures || format('member reorder: expected DENIED, got %s', got); end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', pre, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', pre::text, true);
  begin
    perform reorder_departments(array['DL_10']); -- incomplete on purpose
    failures := failures || array['reorder with an incomplete list should have raised']::text[];
  exception when others then
    if sqlstate <> '22023' then
      failures := failures || format('reorder incomplete-list error: expected 22023, got %s', sqlstate);
    end if;
  end;
  perform set_config('role', 'none', true);

  -- ============================================== reconciliation preflight/apply
  -- A bad manifest: MECH (an existing department) missing entirely, and DL_10
  -- listed twice. Both problems must be diagnosed, and apply must refuse
  -- the whole thing and change nothing.
  declare
    bad_manifest jsonb;
    active_count_before int;
    active_count_after int;
    preflight_problems int;
  begin
    -- The manifest must list EVERY existing key, active or already
    -- archived (DEPARTMENT_RECONCILIATION.md §2) — so this starts from
    -- every row in subteams, not just the active ones, deliberately drops
    -- MECH, and lists DL_10 twice.
    select jsonb_build_object(
      'label', 'dl-bad', 'purpose', 'test_fixture',
      'departments',
        (select jsonb_agg(jsonb_build_object('key', s.key, 'action', 'keep'))
         from subteams s where s.key not in ('MECH', 'DL_10'))
        || jsonb_build_array(jsonb_build_object('key', 'DL_10', 'action', 'keep'))
        || jsonb_build_array(jsonb_build_object('key', 'DL_10', 'action', 'keep'))
    ) into bad_manifest;

    select count(*) into active_count_before from subteams where archived_at is null;

    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', pre, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', pre::text, true);

    select count(*) into preflight_problems from reconciliation_preflight(bad_manifest) where not ok;
    if preflight_problems < 2 then -- at least: MECH missing, DL_10 duplicated
      failures := failures || format('bad manifest preflight: expected >= 2 problem rows, got %s', preflight_problems);
    end if;

    begin
      perform reconciliation_apply(bad_manifest);
      failures := failures || array['apply of a bad manifest should have raised and changed nothing']::text[];
    exception when others then
      if sqlstate <> '23514' then
        failures := failures || format('bad manifest apply error: expected 23514, got %s', sqlstate);
      end if;
    end;

    select count(*) into active_count_after from subteams where archived_at is null;
    if active_count_after <> active_count_before then
      failures := failures || format(
        'bad manifest apply must change nothing: active count was %s, now %s',
        active_count_before, active_count_after);
    end if;

    perform set_config('role', 'none', true);
  end;

  -- A GOOD manifest: archive DL_10 (freeing a slot) and keep the rest.
  declare
    good_manifest jsonb;
    result jsonb;
  begin
    -- Every existing key again, active or already archived; only DL_10
    -- changes action (archive), freeing its slot under the cap.
    select jsonb_build_object(
      'label', 'dl-good', 'purpose', 'test_fixture',
      'departments', jsonb_agg(
        case when s.key = 'DL_10'
          then jsonb_build_object('key', s.key, 'action', 'archive', 'reason', 'dl-test-reconcile')
          else jsonb_build_object('key', s.key, 'action', 'keep')
        end
      )
    ) into good_manifest
    from subteams s;

    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', pre, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', pre::text, true);
    result := reconciliation_apply(good_manifest);
    perform set_config('role', 'none', true);

    if (result ->> 'applied') <> 'true' then
      failures := failures || format('good manifest apply: expected applied=true, got %s', result);
    end if;
    if exists (select 1 from subteams where key = 'DL_10' and archived_at is null) then
      failures := failures || array['good manifest apply: DL_10 should now be archived']::text[];
    end if;
    if not exists (select 1 from activity where entity = 'department_reconciliation' and entity_id = 'dl-good') then
      failures := failures || array['good manifest apply: expected a department_reconciliation activity row']::text[];
    end if;
  end;

  -- =================================================================== verdict
  if array_length(failures, 1) > 0 then
    raise exception 'DEPARTMENT LIFECYCLE CHECKS FAILED (%): %', array_length(failures, 1), array_to_string(failures, ' | ');
  end if;

  raise exception 'DEPARTMENT LIFECYCLE CHECKS PASSED — all % checks', 42;
end $test$;
