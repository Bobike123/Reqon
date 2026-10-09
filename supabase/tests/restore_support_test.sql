-- =============================================================================
--  Restore engine (Ultraplan Phase 5): migration 20260134000000_restore_support.sql.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every fixture, every
--  staged row, every restore run and every trigger change rolls back. Fixture people are new
--  @restore.test identities; fixture tasks are titled 'RS …'.
--
--  Result: RESTORE CHECKS PASSED / FAILED.
--
--  The "backup" here is the database itself, staged into restore_staging at a moment in time
--  (pg_temp.stage_live) — the same tables ops/backup/restore.sh builds from a decrypted dump. After
--  that moment rows are lost (deleted with every trigger off, so no tombstone), deleted on purpose,
--  changed, or added, and the checks below hold the restore to ARCHITECTURE.md §9's truth table:
--    missing live, not tombstoned          → inserted, logged
--    exists live (any version)             → left alone
--    missing live, tombstoned AFTER backup → skipped
--    missing live, tombstoned BEFORE       → inserted (the backup is newer than that deletion)
--    violates a constraint now             → rejected; the run aborts unless rejections are accepted
--    second run                            → 0 inserts
--  plus: plan() leaves no trace; foreign-key order across tables; exact values (no trigger rewrites
--  them); identity values and their sequence; members without a login (RST-11); attachments whose file
--  was purged; triggers come back exactly as they were; undo (and its refusals); targeted revert
--  (RST-10); the version gate and missing required columns (RST-03); exact mode for a new project
--  (Runbook B) and its refusal on a project in use; the snapshot (RST-04); tombstones written by a
--  member's delete; every public table carries the tombstone trigger; nothing is reachable from the API.
-- =============================================================================

create or replace function pg_temp.scalar_as(r text, who uuid, stmt text) returns text language plpgsql as $fn$
declare v text;
begin
  perform set_config('role', r, true);
  if who is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', r)::text, true);
    perform set_config('request.jwt.claim.sub', who::text, true);
  end if;
  begin
    execute stmt into v;
  exception
    when insufficient_privilege then v := 'DENIED';
    when others then v := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $fn$;

-- Runs a statement and returns 'OK' or the SQLSTATE (after rolling its effects back on error).
create or replace function pg_temp.try_sql(stmt text) returns text language plpgsql as $fn$
begin
  execute stmt;
  return 'OK';
exception when others then return sqlstate;
end $fn$;

-- Runs a statement with every user trigger of every public table off: a loss nobody recorded.
create or replace function pg_temp.quiet(stmt text) returns void language plpgsql as $fn$
declare v_rels regclass[];
begin
  select array_agg(c.oid::regclass) into v_rels from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r';
  perform restore.set_user_triggers(v_rels, false);
  execute stmt;
  perform restore.set_user_triggers(v_rels, true);
end $fn$;

-- Stages every public table (and auth.users / auth.identities) as it is NOW, like a decrypted backup.
create or replace function pg_temp.stage_live() returns timestamptz language plpgsql as $fn$
declare
  r record;
  v_cols text[];
  v_staging text;
  v_taken timestamptz := clock_timestamp();
begin
  perform restore.reset_staging();
  for r in
    select n.nspname, c.relname, c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname in ('users', 'identities')))
  loop
    select array_agg(a.attname::text order by a.attnum) into v_cols from pg_attribute a
     where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
    v_staging := 's_' || r.nspname || '__' || r.relname;
    execute format('create table restore_staging.%I (_n bigint generated always as identity primary key, %s)', v_staging,
                   (select string_agg(format('%I text', c), ', ') from unnest(v_cols) c));
    execute format('insert into restore_staging.%I (%s) select %s from %I.%I', v_staging,
                   (select string_agg(format('%I', c), ', ') from unnest(v_cols) c),
                   (select string_agg(format('%I::text', c), ', ') from unnest(v_cols) c), r.nspname, r.relname);
    insert into restore_staging.tables values (v_staging, r.nspname, r.relname, v_cols);
  end loop;
  insert into restore_staging.meta (backup_name, backup_taken_at, migration_version, manifest)
  values ('reqon-backup-20261008T031700Z.tar.age', v_taken, restore.target_migration(), '{"format": 1, "tables": {}}');
  perform pg_temp.restage_counts();
  return v_taken;
end $fn$;

-- The manifest's row counts, recomputed after a test edited the staged rows.
create or replace function pg_temp.restage_counts() returns void language plpgsql as $fn$
declare r record; v_n bigint; v_tables jsonb := '{}'::jsonb;
begin
  for r in select * from restore_staging.tables loop
    execute format('select count(*) from restore_staging.%I', r.staging_table) into v_n;
    v_tables := v_tables || jsonb_build_object(r.source_schema || '.' || r.source_table, jsonb_build_object('rows', v_n));
  end loop;
  update restore_staging.meta set manifest = jsonb_build_object('format', 1, 'tables', v_tables);
end $fn$;

create or replace function pg_temp.plan_of(p_table text, p_col text, p_exact boolean default false) returns text language plpgsql as $fn$
declare v jsonb;
begin
  select to_jsonb(p) into v from restore.plan(p_exact => p_exact) p where p.table_name = p_table;
  return v ->> p_col;
end $fn$;

create or replace function pg_temp.trigger_state(p_rel regclass, p_name text) returns text language sql as $fn$
  select tgenabled::text from pg_trigger where tgrelid = p_rel and tgname = p_name;
$fn$;

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

do $test$
declare
  season uuid;
  dept text;
  own uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); late uuid := gen_random_uuid(); ghost uuid := gen_random_uuid();
  t_lost uuid; t_del uuid; t_chg uuid; t_old uuid; t_par uuid; t_chi uuid; t_bad uuid; t_keep uuid; t_new uuid;
  att uuid := gen_random_uuid();
  q_id bigint; q_next bigint;
  taken timestamptz;
  run1 uuid; run2 uuid; run3 uuid; run4 uuid;
  v text; v_n bigint; v_label text;
  v_runs_before bigint;
  v_member_cols text;
  total int; bad int; report text;
begin
  -- Supabase keeps the migration history here; the disposable test database does not have it.
  if to_regclass('supabase_migrations.schema_migrations') is null then
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
    insert into supabase_migrations.schema_migrations (version) values ('20260134000000');
  end if;

  select id into season from seasons where is_current limit 1;
  select key into dept from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;

  insert into auth.users (id, email) values (own, 'own@restore.test'), (oth, 'oth@restore.test');
  insert into members (id, full_name, role, status) values (own, 'R Own', 'Member', 'active'), (oth, 'R Other', 'Member', 'active');

  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS lost', dept, own) returning id into t_lost;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS deleted', dept, own) returning id into t_del;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS changed', dept, own) returning id into t_chg;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS old tombstone', dept, own) returning id into t_old;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS parent', dept, own) returning id into t_par;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS child', dept, own) returning id into t_chi;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS bad', dept, own) returning id into t_bad;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS keep', dept, own) returning id into t_keep;
  insert into task_dependencies (season_id, task_id, depends_on_task_id) values (season, t_chi, t_par), (season, t_keep, t_chg);
  insert into attachment_purge_queue (kind, object_keys, size_bytes, reason, purge_after)
  values ('photo', array['tasks/00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000a2.jpg'], 10, 'deleted', now())
  returning id into q_id;
  insert into task_attachments (id, task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, status, uploaded_by)
  values (att, t_keep, 'photo', 'tasks/' || t_keep || '/' || att || '.jpg', 'tasks/' || t_keep || '/' || att || '.thumb.webp', 'a.jpg', 'image/jpeg', 10, 'ready', own);

  -- ======================================================================= the "backup"
  taken := pg_temp.stage_live();

  -- An attachment whose bytes were purged after the backup (the queue entry says so).
  insert into attachment_purge_queue (attachment_id, task_id, kind, object_keys, size_bytes, reason, purge_after, purged_at)
  values (att, t_keep, 'photo', array['tasks/' || t_keep || '/' || att || '.jpg'], 10, 'deleted', now(), now());
  -- A backed-up member whose login no longer exists (RST-11): own's staged row under another id.
  select string_agg(format('%I', c), ', ' order by o),
         string_agg(case when c = 'id' then quote_literal(ghost) else format('%I', c) end, ', ' order by o)
    into v_member_cols, v
    from restore_staging.tables t, unnest(t.columns) with ordinality u(c, o) where t.staging_table = 's_public__members';
  execute format('insert into restore_staging.s_public__members (%s) select %s from restore_staging.s_public__members where id = %L',
                 v_member_cols, v, own);
  -- A staged task whose title is now against the rules; its live row is lost.
  update restore_staging.s_public__tasks set title = '   ' where id = t_bad::text;
  -- The lost task had no start date in the backup (a trigger would invent one on insert).
  update restore_staging.s_public__tasks set starts_on = null where id = t_lost::text;
  perform pg_temp.restage_counts();

  -- ======================================================================= after the backup
  perform pg_temp.quiet(format('delete from tasks where id in (%L, %L, %L, %L, %L)', t_lost, t_par, t_chi, t_old, t_bad));
  perform pg_temp.quiet(format('delete from attachment_purge_queue where id = %s', q_id));
  perform pg_temp.quiet(format('delete from task_attachments where id = %L', att));
  insert into restore.row_tombstones (table_name, pk, deleted_at) values ('public.tasks', jsonb_build_object('id', t_old), taken - interval '1 day');
  delete from tasks where id = t_del;                                   -- on purpose: tombstoned
  perform pg_temp.quiet(format('update tasks set title = %L where id = %L', 'RS changed live', t_chg));
  -- A member removes a link through the app's own command: tombstoned with who did it.
  perform pg_temp.expect('a member''s delete through the app works',
    pg_temp.scalar_as('authenticated', own, format('select remove_task_dependency(%L, %L)::text', t_keep, t_chg)), 'true');
  alter table tasks disable trigger trg_touch_tasks;                    -- an operator's own choice: must survive a restore

  -- ======================================================================= tombstones
  perform pg_temp.expect('every public table carries the tombstone trigger',
    (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'zz_record_tombstone')), '0');
  perform pg_temp.expect('a plain delete leaves a tombstone with the primary key',
    (select count(*)::text from restore.row_tombstones where table_name = 'public.tasks' and pk = jsonb_build_object('id', t_del) and deleted_at > taken), '1');
  perform pg_temp.expect('a composite key is recorded whole, with the member who deleted it',
    (select count(*)::text from restore.row_tombstones where table_name = 'public.task_dependencies'
        and pk = jsonb_build_object('task_id', t_keep, 'depends_on_task_id', t_chg) and deleted_by = own), '1');
  perform pg_temp.expect('a loss with triggers off leaves no tombstone',
    (select count(*)::text from restore.row_tombstones where table_name = 'public.tasks' and pk = jsonb_build_object('id', t_lost)), '0');

  -- ======================================================================= nothing for the API
  perform pg_temp.expect('anon has no access to the restore schema', has_schema_privilege('anon', 'restore', 'usage')::text, 'false');
  perform pg_temp.expect('authenticated has no access to the restore schema', has_schema_privilege('authenticated', 'restore', 'usage')::text, 'false');
  perform pg_temp.expect('authenticated has no access to the staging schema', has_schema_privilege('authenticated', 'restore_staging', 'usage')::text, 'false');
  perform pg_temp.expect('the service role has no access to the restore schema', has_schema_privilege('service_role', 'restore', 'usage')::text, 'false');
  perform pg_temp.expect('authenticated cannot run a plan', has_function_privilege('authenticated', 'restore.plan(text[], boolean, boolean)', 'execute')::text, 'false');
  perform pg_temp.expect('the service role cannot apply', has_function_privilege('service_role', 'restore.apply(text[], boolean, boolean, text, boolean)', 'execute')::text, 'false');
  perform pg_temp.expect('a member cannot read tombstones', pg_temp.scalar_as('authenticated', own, 'select count(*) from restore.row_tombstones'), 'DENIED');

  -- ======================================================================= staging matches its manifest
  perform pg_temp.expect('the staged rows match the manifest counts',
    (select count(*)::text from restore.verify_staging() where not rows_match), '0');

  -- ======================================================================= plan (dry run)
  select count(*) into v_runs_before from restore.runs;
  perform pg_temp.expect('plan: tasks — 4 to insert (lost, parent, child, old tombstone)', pg_temp.plan_of('public.tasks', 'would_insert'), '4');
  perform pg_temp.expect('plan: tasks — 1 deleted after the backup is skipped', pg_temp.plan_of('public.tasks', 'deleted_after_backup'), '1');
  perform pg_temp.expect('plan: tasks — 1 rejected (blank title)', pg_temp.plan_of('public.tasks', 'rejected'), '1');
  perform pg_temp.expect('plan: tasks — the reason names the rule',
    (select r ->> 'reason' from restore.plan() p, jsonb_array_elements(p.rejections) r where p.table_name = 'public.tasks'), 'breaks the rule tasks_title_not_blank');
  perform pg_temp.expect('plan: dependencies — the lost link is restored', pg_temp.plan_of('public.task_dependencies', 'would_insert'), '1');
  perform pg_temp.expect('plan: dependencies — the link a member removed is not', pg_temp.plan_of('public.task_dependencies', 'deleted_after_backup'), '1');
  perform pg_temp.expect('plan: a member without a login is rejected (RST-11)', pg_temp.plan_of('public.members', 'rejected'), '1');
  perform pg_temp.expect('plan: … with the way out',
    (select r ->> 'reason' from restore.plan() p, jsonb_array_elements(p.rejections) r where p.table_name = 'public.members'), '%re-invite%');
  perform pg_temp.expect('plan: an attachment whose file was purged is rejected',
    (select r ->> 'reason' from restore.plan() p, jsonb_array_elements(p.rejections) r where p.table_name = 'public.task_attachments'), 'its file was already deleted from storage');
  perform pg_temp.expect('plan: the purge-queue row comes back', pg_temp.plan_of('public.attachment_purge_queue', 'would_insert'), '1');
  perform pg_temp.expect('plan: auth tables are left alone outside Runbook B', pg_temp.plan_of('auth.users', 'notes'), '%Runbook B%');
  perform pg_temp.expect('plan: a changed live row is counted as live', (pg_temp.plan_of('public.tasks', 'exists_live')::bigint >= 2)::text, 'true');
  perform pg_temp.expect('plan changed nothing: the lost task is still missing', (select count(*)::text from tasks where id = t_lost), '0');
  perform pg_temp.expect('plan changed nothing: no run was recorded', (select count(*) from restore.runs)::text, v_runs_before::text);
  perform pg_temp.expect('plan changed nothing: triggers are on', pg_temp.trigger_state('tasks', 'trg_guard_task_edit'), 'O');
  perform pg_temp.expect('plan changed nothing: the trigger the operator disabled is still off', pg_temp.trigger_state('tasks', 'trg_touch_tasks'), 'D');

  -- ======================================================================= apply
  perform pg_temp.expect('apply refuses while rows would be rejected (and writes nothing)', pg_temp.try_sql('select restore.apply()'), '23000');
  perform pg_temp.expect('… the lost task is still missing', (select count(*)::text from tasks where id = t_lost), '0');

  run1 := restore.apply(p_skip_rejected => true);
  perform pg_temp.expect('apply with accepted rejections records an applied run', (select status from restore.runs where id = run1), 'applied');
  perform pg_temp.expect('the lost task is back', (select count(*)::text from tasks where id = t_lost), '1');
  perform pg_temp.expect('… with its exact values (no trigger invented a start date)', (select coalesce(starts_on::text, 'null') from tasks where id = t_lost), 'null');
  perform pg_temp.expect('a task tombstoned before the backup is back', (select count(*)::text from tasks where id = t_old), '1');
  perform pg_temp.expect('parent, child and their link are back (foreign-key order)',
    (select count(*)::text from task_dependencies where task_id = t_chi and depends_on_task_id = t_par), '1');
  perform pg_temp.expect('the task deleted on purpose stays deleted', (select count(*)::text from tasks where id = t_del), '0');
  perform pg_temp.expect('the link a member removed stays removed', (select count(*)::text from task_dependencies where task_id = t_keep and depends_on_task_id = t_chg), '0');
  perform pg_temp.expect('live wins: the changed title is not overwritten', (select title from tasks where id = t_chg), 'RS changed live');
  perform pg_temp.expect('the rejected task stays out', (select count(*)::text from tasks where id = t_bad), '0');
  perform pg_temp.expect('the member without a login stays out', (select count(*)::text from members where id = ghost), '0');
  perform pg_temp.expect('the attachment without a file stays out', (select count(*)::text from task_attachments where id = att), '0');
  perform pg_temp.expect('an identity value comes back unchanged', (select count(*)::text from attachment_purge_queue where id = q_id), '1');
  insert into attachment_purge_queue (kind, object_keys, size_bytes, reason, purge_after)
  values ('photo', array['tasks/00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000a3.jpg'], 10, 'deleted', now()) returning id into q_next;
  perform pg_temp.expect('… and its sequence moved past it', (q_next > q_id)::text, 'true');
  delete from attachment_purge_queue where id = q_next;
  perform pg_temp.expect('every inserted row is logged',
    (select count(*)::text from restore.log where run_id = run1 and action = 'insert'),
    (select (summary ->> 'inserted') from restore.runs where id = run1));
  perform pg_temp.expect('triggers are back on', pg_temp.trigger_state('tasks', 'trg_guard_task_edit'), 'O');
  perform pg_temp.expect('the trigger the operator disabled is still off', pg_temp.trigger_state('tasks', 'trg_touch_tasks'), 'D');
  alter table tasks enable trigger trg_touch_tasks;

  run2 := restore.apply(p_skip_rejected => true);
  perform pg_temp.expect('a second run inserts nothing (idempotent, RST-06)', (select summary ->> 'inserted' from restore.runs where id = run2), '0');

  -- ======================================================================= undo
  perform pg_temp.quiet(format('update tasks set title = %L where id = %L', 'RS lost, edited after the restore', t_lost));
  perform pg_temp.expect('undo refuses when a restored row was changed since', pg_temp.try_sql(format('select * from restore.undo(%L)', run1)), '55000');
  perform pg_temp.quiet(format('update tasks set title = %L where id = %L', 'RS lost', t_lost));
  insert into task_dependencies (season_id, task_id, depends_on_task_id) values (season, t_keep, t_par);
  perform pg_temp.expect('undo refuses when new rows depend on a restored one', pg_temp.try_sql(format('select * from restore.undo(%L)', run1)), '55000');
  perform pg_temp.expect('… and changed nothing', (select count(*)::text from tasks where id = t_lost), '1');
  perform pg_temp.quiet(format('delete from task_dependencies where task_id = %L and depends_on_task_id = %L', t_keep, t_par));
  perform restore.undo(run2);
  perform restore.undo(run1);
  perform pg_temp.expect('undo removes exactly the restored rows', (select count(*)::text from tasks where id in (t_lost, t_old, t_par, t_chi)), '0');
  perform pg_temp.expect('… including the restored link and identity row',
    (select (count(*) filter (where true))::text from attachment_purge_queue where id = q_id), '0');
  perform pg_temp.expect('… and leaves live rows alone', (select title from tasks where id = t_chg), 'RS changed live');
  perform pg_temp.expect('the run is marked undone', (select status from restore.runs where id = run1), 'undone');
  perform pg_temp.expect('undo leaves no tombstones (it was not a deliberate delete)',
    (select count(*)::text from restore.row_tombstones where table_name = 'public.tasks' and pk = jsonb_build_object('id', t_lost)), '0');
  perform pg_temp.expect('a run cannot be undone twice', pg_temp.try_sql(format('select * from restore.undo(%L)', run1)), '55000');
  perform pg_temp.expect('triggers are on after an undo', pg_temp.trigger_state('tasks', 'trg_guard_task_edit'), 'O');

  -- ======================================================================= targeted revert (RST-10)
  run3 := restore.revert_rows('public.tasks', array[jsonb_build_object('id', t_chg)]);
  perform pg_temp.expect('revert puts the named row back to the backup', (select title from tasks where id = t_chg), 'RS changed');
  perform pg_temp.expect('… and only that row', (select title from tasks where id = t_keep), 'RS keep');
  perform pg_temp.expect('… logged with the value it replaced', (select old_row ->> 'title' from restore.log where run_id = run3), 'RS changed live');
  perform restore.undo(run3);
  perform pg_temp.expect('undoing a revert brings the live value back', (select title from tasks where id = t_chg), 'RS changed live');
  perform pg_temp.expect('revert refuses a table without updated_at',
    pg_temp.try_sql(format('select restore.revert_rows(%L, array[%L::jsonb])', 'public.task_dependencies', jsonb_build_object('task_id', t_chi, 'depends_on_task_id', t_par))), '22023');
  perform pg_temp.expect('revert refuses a key that is not the primary key',
    pg_temp.try_sql(format('select restore.revert_rows(%L, array[%L::jsonb])', 'public.tasks', jsonb_build_object('title', 'x'))), '22023');
  perform pg_temp.expect('revert refuses a row that is not live',
    pg_temp.try_sql(format('select restore.revert_rows(%L, array[%L::jsonb])', 'public.tasks', jsonb_build_object('id', t_del))), 'P0002');
  perform pg_temp.expect('revert needs an explicit list', pg_temp.try_sql('select restore.revert_rows(''public.tasks'', array[]::jsonb[])'), '22023');

  -- ======================================================================= gates (RST-03)
  update restore_staging.meta set migration_version = '99999999999999';
  perform pg_temp.expect('a backup from a newer database is refused', pg_temp.try_sql('select * from restore.plan()'), '55000');
  perform pg_temp.expect('… by apply too', pg_temp.try_sql('select restore.apply(p_skip_rejected => true)'), '55000');
  update restore_staging.meta set migration_version = restore.target_migration();
  perform pg_temp.expect('a backup missing a required column cannot be restored',
    pg_temp.try_sql('alter table restore_staging.s_public__tasks drop column title;
                     update restore_staging.tables set columns = array_remove(columns, ''title'') where staging_table = ''s_public__tasks'';
                     select * from restore.plan()'), '23502');
  perform pg_temp.expect('rows that differ from the manifest are refused',
    pg_temp.try_sql('update restore_staging.meta set manifest = jsonb_set(manifest, ''{tables,public.tasks,rows}'', ''1'');
                     select restore.apply(p_skip_rejected => true)'), '22000');

  -- ======================================================================= snapshot (RST-04)
  v_label := restore.snapshot();
  perform pg_temp.expect('the snapshot copies every public table',
    (select count(*)::text from pg_tables where schemaname = 'maintenance_backup' and tablename like v_label || '\_%' and tablename <> v_label || '_manifest'),
    (select count(*)::text from pg_tables where schemaname = 'public'));
  execute format('select row_count from maintenance_backup.%I where table_name = ''tasks''', v_label || '_manifest') into v_n;
  perform pg_temp.expect('… with counts in its manifest', v_n::text, (select count(*)::text from tasks));

  -- ======================================================================= exact mode (Runbook B)
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'RS created after the backup', dept, own) returning id into t_new;
  perform pg_temp.expect('exact plan: rows the backup does not have are removed', (pg_temp.plan_of('public.tasks', 'would_remove', true)::bigint >= 1)::text, 'true');
  perform pg_temp.expect('exact plan: a changed row takes the backup''s values', pg_temp.plan_of('public.tasks', 'would_overwrite', true), '1');
  run4 := restore.apply(p_skip_rejected => true, p_exact => true);
  perform pg_temp.expect('exact: the row created after the backup is gone', (select count(*)::text from tasks where id = t_new), '0');
  perform pg_temp.expect('exact: the changed row has the backup''s title', (select title from tasks where id = t_chg), 'RS changed');
  perform pg_temp.expect('exact: missing rows are back', (select count(*)::text from tasks where id in (t_lost, t_par, t_chi, t_old)), '4');
  perform pg_temp.expect('exact: even the row deleted on purpose (the backup wins)', (select count(*)::text from tasks where id = t_del), '1');
  perform restore.undo(run4);
  perform pg_temp.expect('undoing exact mode brings back the removed row', (select count(*)::text from tasks where id = t_new), '1');
  perform pg_temp.expect('… and the live value', (select title from tasks where id = t_chg), 'RS changed live');
  perform pg_temp.expect('… and removes what it inserted', (select count(*)::text from tasks where id in (t_lost, t_del)), '0');
  insert into auth.users (id, email) values (late, 'late@restore.test');
  perform pg_temp.expect('exact mode is refused once the project has a login the backup does not know',
    pg_temp.try_sql('select restore.apply(p_skip_rejected => true, p_exact => true)'), '55000');

  -- ======================================================================= clean up the staging
  perform restore.drop_staging();
  perform pg_temp.expect('drop_staging leaves only the bookkeeping tables',
    (select count(*)::text from pg_tables where schemaname = 'restore_staging'), '2');
  perform pg_temp.expect('… empty', (select count(*)::text from restore_staging.meta), '0');

  -- ======================================================================= verdict
  select count(*), count(*) filter (where not (got like expected) or got is null),
         string_agg(case when not (got like expected) or got is null then format('  FAIL  %s — expected %s, got %s', label, expected, coalesce(got, 'NULL')) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'RESTORE CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'RESTORE CHECKS PASSED — all % checks', total;
end
$test$;
