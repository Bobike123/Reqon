-- =============================================================================
--  Ultraplan Phase 5: safe, idempotent restore from an encrypted backup.
--  docs/ultraplan/ARCHITECTURE.md section 9; decisions D-12, D-13 (revised by D-41), D-42…;
--  requirements RST-01…RST-13.
--
--  WHAT WAS MISSING. A backup (Phase 4) could be decrypted, but there was no safe way to put
--  its rows back into a LIVE database: restoring blindly would overwrite newer work, and
--  nothing recorded which rows had been deleted on purpose (the audit trail records deletes
--  on 4 of 27 tables, Phase 0 finding F0-03).
--
--  AFTER.
--   * restore.row_tombstones + a generic AFTER DELETE trigger (zz_record_tombstone) on EVERY
--     public table: table, primary key (jsonb) and time of every deleted row.
--     restore.install_tombstone_triggers() adds it to tables that lack it; a SQL test fails
--     when a future table is created without it.
--   * restore_staging: the backup's rows, as text columns, loaded by ops/backup/restore.sh
--     from the decrypted dump (never straight into public). Not exposed to any API role.
--   * restore.plan()   dry run, per table: staged / already live / deleted after the backup /
--                      would insert / rejected (+ reasons). Runs everything, then rolls back.
--   * restore.apply()  one transaction, foreign-key order, INSERT-MISSING-ONLY: a row whose
--                      primary key exists live is never touched (live wins); a row deleted
--                      after the backup (tombstone newer than the backup) is not resurrected.
--                      Every inserted row is logged (restore.log). Any rejection aborts the
--                      whole run unless the operator explicitly accepts skipping them.
--                      Running it again inserts nothing (idempotent).
--   * restore.apply(p_exact => true)  Runbook B only (a NEW, empty project after `db push`):
--                      makes the project EQUAL to the backup — rows the migrations seeded are
--                      overwritten with the backup's values, seeded rows the backup does not have
--                      are removed, tombstones are ignored. Refused as soon as the project has a login the backup does
--                      not know, so it can never run against a database in real use.
--   * The migration history (supabase_migrations) is never written: it belongs to the target.
--   * restore.undo()   deletes exactly the rows a run inserted — refused if one of them was
--                      changed since, or if new rows now depend on them (unless forced).
--   * restore.revert_rows()  manual, explicit list of primary keys, tables with updated_at
--                      only: puts those rows back to their backup values; logged and undoable.
--   * restore.snapshot()     copies every public table into maintenance_backup.rs<time>_*
--                      before an apply (the existing maintenance pattern, RST-04).
--
--  TRIGGERS DURING A RESTORE (decision D-41, revising D-13): apply/undo/revert switch OFF the
--  user triggers of the public tables they write, inside their own transaction, and switch the
--  same ones back on before it ends (ALTER TABLE ... DISABLE TRIGGER needs table ownership, which
--  `postgres` has on the hosted project; session_replication_role would need a superuser).
--  Reason: stamp/touch/default triggers would rewrite the restored values (actors, timestamps),
--  and guard triggers would refuse historic rows that were valid when they were backed up.
--  Primary keys, foreign keys, unique and CHECK constraints stay enforced. The truthful audit of a
--  restore is restore.runs + restore.log.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Tombstones for every delete; the restore engine.
--    Existing data  None touched. One AFTER DELETE trigger is added to every public table: it only
--                   INSERTs into restore.row_tombstones and cannot change the outcome of the delete.
--    Locking        CREATE TRIGGER takes SHARE ROW EXCLUSIVE on each table, briefly (no rewrite).
--    Authorization  Schemas restore and restore_staging: no USAGE for public/anon/authenticated/
--                   service_role. Every function: EXECUTE revoked from them; only the owner runs a
--                   restore. The tombstone trigger function is SECURITY DEFINER so a member's delete
--                   can record its tombstone without any access to the schema.
--    Rollback       docs/ultraplan/rollbacks/20260134000000_restore_support_down.sql
--    Deploy order   After 20260133000000.
-- =============================================================================

create schema if not exists restore;
create schema if not exists restore_staging;
revoke all on schema restore, restore_staging from public;
do $roles$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema restore, restore_staging from %I', r);
    end if;
  end loop;
end
$roles$;

-- --------------------------------------------------------------------------- tombstones
create table if not exists restore.row_tombstones (
  id          bigint generated always as identity primary key,
  table_name  text not null,                        -- schema-qualified: public.tasks
  pk          jsonb not null,                       -- {"id": "…"} as to_jsonb() renders each key column
  deleted_at  timestamptz not null default clock_timestamp(),
  deleted_by  uuid                                  -- auth.uid() of the deleting session, if any
);
create index if not exists row_tombstones_lookup on restore.row_tombstones (table_name, pk);

create or replace function restore.record_tombstone() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare
  v_old jsonb := to_jsonb(old);
  v_pk jsonb := '{}'::jsonb;
  i integer;
begin
  for i in 0 .. tg_nargs - 1 loop
    v_pk := v_pk || jsonb_build_object(tg_argv[i], v_old -> tg_argv[i]);
  end loop;
  insert into restore.row_tombstones (table_name, pk, deleted_by)
  values (tg_table_schema || '.' || tg_table_name, v_pk, auth.uid());
  return old;
end $fn$;

-- Primary-key columns of a table, in key order (null when it has none).
create or replace function restore.pk_columns(p_rel regclass) returns text[]
language sql stable set search_path = pg_catalog as $fn$
  select array_agg(a.attname::text order by k.ord)
    from pg_index i
    cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
   where i.indrelid = p_rel and i.indisprimary;
$fn$;

-- Adds the tombstone trigger to every public table that lacks it. Returns how many it added.
-- Tables without a primary key cannot be restored row by row; they are skipped with a warning.
create or replace function restore.install_tombstone_triggers() returns integer
language plpgsql set search_path = pg_catalog as $fn$
declare
  r record;
  v_cols text[];
  v_added integer := 0;
begin
  for r in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'zz_record_tombstone')
     order by c.relname
  loop
    v_cols := restore.pk_columns(r.oid);
    if v_cols is null then
      raise warning 'public.% has no primary key: deletions are not tombstoned and it cannot be restored row by row', r.relname;
      continue;
    end if;
    execute format('create trigger zz_record_tombstone after delete on public.%I for each row execute function restore.record_tombstone(%s)',
                   r.relname, (select string_agg(quote_literal(c), ', ') from unnest(v_cols) c));
    v_added := v_added + 1;
  end loop;
  return v_added;
end $fn$;

select restore.install_tombstone_triggers();

-- ------------------------------------------------------------------------ runs and log
create table if not exists restore.runs (
  id                uuid primary key default gen_random_uuid(),
  mode              text not null check (mode in ('apply', 'revert')),
  status            text not null default 'running' check (status in ('running', 'applied', 'undone')),
  backup_name       text not null,
  backup_taken_at   timestamptz not null,
  backup_migration  text not null,
  target_migration  text,
  options           jsonb not null default '{}'::jsonb,
  summary           jsonb,
  snapshot_label    text,
  actor             text not null default session_user,
  started_at        timestamptz not null default clock_timestamp(),
  finished_at       timestamptz,
  undone_at         timestamptz
);

create table if not exists restore.log (
  id          bigint generated always as identity primary key,
  run_id      uuid not null references restore.runs (id),
  action      text not null check (action in ('insert', 'revert', 'delete')),
  table_name  text not null,
  pk          jsonb not null,
  new_row     jsonb,                    -- the row as it was written (null for delete)
  old_row     jsonb                     -- revert/delete: the row before
);
create index if not exists log_run on restore.log (run_id, id);

-- ------------------------------------------------------------------------------ staging
-- The staged backup: one row of metadata, one registration per staged table, and one text-column
-- table per backed-up table (s_<schema>__<table>, with a row number _n), created by
-- ops/backup/restore.sh. reset_staging() empties it before a load; drop_staging() after a restore.
create table if not exists restore_staging.meta (
  backup_name       text not null,
  backup_taken_at   timestamptz not null,
  migration_version text not null,
  manifest          jsonb not null,
  loaded_at         timestamptz not null default clock_timestamp()
);
create table if not exists restore_staging.tables (
  staging_table text primary key,
  source_schema text not null,
  source_table  text not null,
  columns       text[] not null,
  unique (source_schema, source_table)
);

create or replace function restore.reset_staging() returns void
language plpgsql set search_path = pg_catalog as $fn$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'restore_staging' and tablename like 's\_%' loop
    execute format('drop table restore_staging.%I', r.tablename);
  end loop;
  truncate restore_staging.meta, restore_staging.tables;
end $fn$;

create or replace function restore.drop_staging() returns void
language plpgsql set search_path = pg_catalog as $fn$
begin
  perform restore.reset_staging();
end $fn$;

-- ------------------------------------------------------------------------------ helpers
-- The fixed text form used by the backup manifest (ops/backup/manifest.sql), for md5 comparisons.
create or replace function restore.manifest_settings() returns void
language plpgsql set search_path = pg_catalog as $fn$
begin
  perform set_config('timezone', 'UTC', true);
  perform set_config('datestyle', 'ISO, YMD', true);
  perform set_config('extra_float_digits', '3', true);
  perform set_config('bytea_output', 'hex', true);
  perform set_config('intervalstyle', 'postgres', true);
end $fn$;

create or replace function restore.meta() returns restore_staging.meta
language plpgsql stable set search_path = pg_catalog as $fn$
declare m restore_staging.meta;
begin
  select * into m from restore_staging.meta limit 1;
  if not found then
    raise exception 'Nothing is staged. Load a backup with ops/backup/restore.sh first.' using errcode = 'P0002';
  end if;
  return m;
end $fn$;

-- The newest migration version of this database (null when it has no migration history).
create or replace function restore.target_migration() returns text
language plpgsql stable set search_path = pg_catalog as $fn$
declare v text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then return null; end if;
  execute 'select max(version) from supabase_migrations.schema_migrations' into v;
  return v;
end $fn$;

-- Version gate (RST-03): a backup from a NEWER database than this one is refused.
create or replace function restore.check_version() returns text
language plpgsql stable set search_path = pg_catalog as $fn$
declare
  m restore_staging.meta := restore.meta();
  v_target text := restore.target_migration();
begin
  if v_target is null then
    raise exception 'This database has no migration history (supabase_migrations.schema_migrations); the version gate cannot be checked.' using errcode = '55000';
  end if;
  if m.migration_version > v_target then
    raise exception 'The backup is from database version %, newer than this database (%). Apply the newer migrations first.',
      m.migration_version, v_target using errcode = '55000';
  end if;
  return v_target;
end $fn$;

-- Per staged table: what it maps to in this database. Columns are matched by name; generated
-- columns are never written; a target column that is NOT NULL, has no default and is missing
-- from the backup makes the table impossible to restore (RST-03).
create or replace function restore.table_map()
returns table (staging_table text, qualified text, rel regclass, pk text[], cols text[], casts text[],
               dropped text[], missing_required text[])
language plpgsql stable set search_path = pg_catalog as $fn$
declare t record; v_rel regclass;
begin
  for t in select * from restore_staging.tables order by source_schema, source_table loop
    v_rel := to_regclass(format('%I.%I', t.source_schema, t.source_table));
    staging_table := t.staging_table;
    qualified := t.source_schema || '.' || t.source_table;
    rel := v_rel;
    if v_rel is null then
      pk := null; cols := '{}'; casts := '{}'; dropped := t.columns; missing_required := '{}';
      return next;
      continue;
    end if;
    pk := restore.pk_columns(v_rel);
    select coalesce(array_agg(a.attname::text order by a.attnum), '{}'),
           coalesce(array_agg(format('s.%I::%s', a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum), '{}')
      into cols, casts
      from pg_attribute a
     where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and a.attname::text = any (t.columns);
    select coalesce(array_agg(c order by c), '{}') into dropped
      from unnest(t.columns) c
     where not exists (select 1 from pg_attribute a where a.attrelid = v_rel and a.attname::text = c and not a.attisdropped and a.attgenerated = '');
    select coalesce(array_agg(a.attname::text order by a.attnum), '{}') into missing_required
      from pg_attribute a
     where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attnotnull
       and a.attgenerated = '' and a.attidentity = ''
       and not exists (select 1 from pg_attrdef d where d.adrelid = v_rel and d.adnum = a.attnum)
       and not (a.attname::text = any (t.columns));
    return next;
  end loop;
end $fn$;

-- Rows staged vs the manifest, and (where comparable) the md5 of the content (RST-02).
create or replace function restore.verify_staging()
returns table (table_name text, manifest_rows bigint, staged_rows bigint, rows_match boolean, md5_match boolean)
language plpgsql set search_path = pg_catalog as $fn$
declare
  m restore_staging.meta := restore.meta();
  t record;
  v_entry jsonb;
  v_md5 text;
  v_generated boolean;
  v_exprs text;
begin
  perform restore.manifest_settings();
  for t in select tm.*, st.columns as staged_cols from restore.table_map() tm
             join restore_staging.tables st using (staging_table) order by tm.qualified loop
    table_name := t.qualified;
    v_entry := m.manifest -> 'tables' -> t.qualified;
    manifest_rows := (v_entry ->> 'rows')::bigint;
    execute format('select count(*) from restore_staging.%I', t.staging_table) into staged_rows;
    rows_match := manifest_rows is not distinct from staged_rows;
    md5_match := null;
    -- Comparable only when every backed-up column still exists and the table has no generated column
    -- (the manifest's row text includes generated values, the dump does not).
    v_generated := t.rel is not null and exists (select 1 from pg_attribute a where a.attrelid = t.rel and a.attnum > 0 and not a.attisdropped and a.attgenerated <> '');
    if t.rel is not null and cardinality(t.dropped) = 0 and not v_generated and v_entry ? 'md5' then
      select string_agg(format('s.%I::%s', c, (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = t.rel and a.attname::text = c)), ', ' order by o)
        into v_exprs from unnest(t.staged_cols) with ordinality u(c, o);
      execute format('select md5(coalesce(string_agg(r::text, E''\n'' order by r::text), '''')) from (select row(%s) as r from restore_staging.%I s) x',
                     v_exprs, t.staging_table) into v_md5;
      md5_match := v_md5 = (v_entry ->> 'md5');
    end if;
    return next;
  end loop;
end $fn$;

-- Tables in foreign-key order (parents first). Self-references and cycles are left to the
-- multi-pass insert in merge(), so the order only needs to be good, not perfect.
create or replace function restore.fk_order(p_rels regclass[]) returns table (rel regclass, depth integer)
language plpgsql set search_path = pg_catalog as $fn$
declare v_changed integer; i integer := 0;
begin
  create temp table if not exists _rst_order (rel regclass primary key, depth integer not null) on commit drop;
  truncate _rst_order;
  insert into _rst_order select r, 0 from unnest(p_rels) r where r is not null on conflict do nothing;
  loop
    i := i + 1;
    update _rst_order o set depth = sub.d
      from (select c.conrelid as child, max(p.depth) + 1 as d
              from pg_constraint c join _rst_order p on p.rel = c.confrelid
             where c.contype = 'f' and c.conrelid <> c.confrelid
             group by c.conrelid) sub
     where o.rel = sub.child and o.depth < sub.d and sub.d <= 100;
    get diagnostics v_changed = row_count;
    exit when v_changed = 0 or i > 100;
  end loop;
  return query select o.rel, o.depth from _rst_order o order by o.depth, o.rel::text;
end $fn$;

-- Switch the enabled user triggers of the given public tables off (p_on = false) or back on.
-- Remembers exactly which ones it switched off, so a trigger that was already disabled stays so.
create or replace function restore.set_user_triggers(p_rels regclass[], p_on boolean) returns void
language plpgsql set search_path = pg_catalog as $fn$
declare r record;
begin
  create temp table if not exists _rst_triggers (rel regclass, tgname name) on commit drop;
  if not p_on then
    -- ALTER TABLE is refused while deferred trigger events are pending (tasks and task_requirements have
    -- deferred constraint triggers). Run those checks now: a violated invariant fails here, before anything
    -- is restored. The rest of this transaction then checks constraints immediately.
    set constraints all immediate;
    for r in
      select t.tgrelid::regclass as rel, t.tgname
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where t.tgrelid = any (p_rels) and not t.tgisinternal and t.tgenabled <> 'D' and n.nspname = 'public'
         and not exists (select 1 from _rst_triggers x where x.rel = t.tgrelid and x.tgname = t.tgname)
    loop
      execute format('alter table %s disable trigger %I', r.rel, r.tgname);
      insert into _rst_triggers values (r.rel, r.tgname);
    end loop;
  else
    for r in select * from _rst_triggers where rel = any (p_rels) loop
      execute format('alter table %s enable trigger %I', r.rel, r.tgname);
    end loop;
    delete from _rst_triggers where rel = any (p_rels);
  end if;
end $fn$;

-- After explicit ids were inserted, move each owned sequence past the largest value.
create or replace function restore.bump_sequences(p_rel regclass) returns void
language plpgsql set search_path = pg_catalog as $fn$
declare r record; v_max bigint; v_seq text;
begin
  for r in select a.attname from pg_attribute a where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped loop
    v_seq := pg_get_serial_sequence(p_rel::text, r.attname);
    if v_seq is null then continue; end if;
    execute format('select max(%I)::bigint from %s', r.attname, p_rel) into v_max;
    if v_max is not null then
      execute format('select setval(%L, greatest(%s, (select last_value from %s)))', v_seq, v_max, v_seq);
    end if;
  end loop;
end $fn$;

-- ------------------------------------------------------------------------- the engine
-- Does the whole merge in the CURRENT transaction and returns the report. plan() calls it and
-- then rolls it back; apply() keeps it. Rows are written INSERT-MISSING-ONLY:
--   live row with the same primary key       → left alone          (exists_live)
--   tombstone newer than the backup          → not resurrected     (deleted_after_backup)
--   insert fails on a constraint             → rejected, with the reason
--   insert fails on a missing parent (FK)    → retried after the other rows; rejected if it never fits
create or replace function restore.merge(p_run uuid, p_exclude text[], p_include_auth boolean, p_exact boolean default false)
returns jsonb
language plpgsql set search_path = pg_catalog as $fn$
declare
  m restore_staging.meta := restore.meta();
  t record;
  o record;
  p record;
  v_tables jsonb := '{}'::jsonb;
  v_entry jsonb;
  v_rels regclass[];
  v_write_rels regclass[];
  v_r regclass;
  v_n bigint;
  v_row jsonb;
  v_pkv jsonb;
  v_progress integer;
  v_pass integer := 0;
  v_fk_cols text[];
  v_broke integer;
  v_state text;
  v_msg text;
  v_cons text;
  v_total_inserted bigint := 0;
  v_total_rejected bigint := 0;
  -- Tombstones newer than this are respected. Exact mode makes the project equal to the backup, so none are.
  v_after timestamptz := case when p_exact then 'infinity'::timestamptz else m.backup_taken_at end;
begin
  create temp table if not exists _rst_pending (qualified text, n bigint, ord integer) on commit drop;
  create temp table if not exists _rst_rejected (qualified text, pk jsonb, reason text) on commit drop;
  create temp table if not exists _rst_inserted (qualified text, n bigint) on commit drop;
  create temp table if not exists _rst_fix (qualified text, n bigint, pk jsonb) on commit drop;
  truncate _rst_pending; truncate _rst_rejected; truncate _rst_inserted; truncate _rst_fix;

  -- The map, computed once, with the SQL each taking-part table needs.
  drop table if exists _rst_map;
  create temp table _rst_map on commit drop as
    select tm.*, null::text as pk_match, null::text as pk_json, null::text as insert_sql,
           null::text as insert_nofk_sql, null::text as fix_sql, false as takes_part
      from restore.table_map() tm;

  for t in select * from _rst_map loop
    execute format('select count(*) from restore_staging.%I', t.staging_table) into v_n;
    v_entry := jsonb_build_object('staged', v_n, 'exists_live', 0, 'deleted_after_backup', 0, 'inserted', 0, 'rejected', 0,
                                  'overwritten', 0, 'removed', 0, 'notes', '[]'::jsonb);
    if t.rel is null then
      v_entry := jsonb_set(v_entry, '{notes}', '["the table no longer exists in this database: its rows are not restored"]');
    elsif t.qualified = any (coalesce(p_exclude, '{}')) then
      v_entry := jsonb_set(v_entry, '{notes}', '["excluded by the operator"]');
    elsif split_part(t.qualified, '.', 1) = 'supabase_migrations' then
      v_entry := jsonb_set(v_entry, '{notes}', '["migration history: always the target''s own, never restored"]');
    elsif split_part(t.qualified, '.', 1) = 'auth' and not (p_include_auth or p_exact) then
      v_entry := jsonb_set(v_entry, '{notes}', '["auth tables are restored only for a lost project (Runbook B, include_auth)"]');
    elsif t.pk is null then
      v_entry := jsonb_set(v_entry, '{notes}', '["no primary key: cannot be restored row by row"]');
    elsif cardinality(t.missing_required) > 0 then
      raise exception 'Cannot restore %: the backup has no value for required column(s) % that have no default. Restore into a database at the backup''s version, or add defaults first.',
        t.qualified, array_to_string(t.missing_required, ', ') using errcode = '23502';
    else
      v_rels := array_append(v_rels, t.rel);
      if cardinality(t.dropped) > 0 then
        v_entry := jsonb_set(v_entry, '{notes}', to_jsonb(array['column(s) ' || array_to_string(t.dropped, ', ') || ' no longer exist; their values are not restored']));
      end if;
      update _rst_map x set takes_part = true,
        pk_match = (select '(' || string_agg(format('x.%I', u.c), ', ' order by u.ord) || ') = ('
                           || string_agg(format('s.%I::%s', u.c, format_type(a.atttypid, a.atttypmod)), ', ' order by u.ord) || ')'
                      from unnest(t.pk) with ordinality u(c, ord) join pg_attribute a on a.attrelid = t.rel and a.attname::text = u.c),
        pk_json = (select 'jsonb_build_object(' || string_agg(format('%L, to_jsonb(s.%I::%s)', u.c, u.c, format_type(a.atttypid, a.atttypmod)), ', ' order by u.ord) || ')'
                     from unnest(t.pk) with ordinality u(c, ord) join pg_attribute a on a.attrelid = t.rel and a.attname::text = u.c),
        insert_sql = format('insert into %s as x (%s) overriding system value select %s from restore_staging.%I s where s._n = $1 returning to_jsonb(x)',
                            t.rel, (select string_agg(format('%I', c), ', ') from unnest(t.cols) c), array_to_string(t.casts, ', '), t.staging_table)
       where x.staging_table = t.staging_table;
      -- For foreign-key cycles (specs.current_measurement_id ↔ spec_measurements.spec_id): the same insert
      -- with every nullable foreign-key column left empty, and the update that fills them in afterwards.
      select array_agg(distinct a.attname::text) into v_fk_cols
        from pg_constraint c cross join lateral unnest(c.conkey) k(attnum)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conrelid = t.rel and c.contype = 'f' and not a.attnotnull and a.attname::text = any (t.cols)
         and not (a.attname::text = any (t.pk));
      if v_fk_cols is not null then
        update _rst_map x set
          insert_nofk_sql = format('insert into %s as x (%s) overriding system value select %s from restore_staging.%I s where s._n = $1 returning to_jsonb(x)',
            t.rel, (select string_agg(format('%I', c), ', ') from unnest(t.cols) c),
            (select string_agg(case when c = any (v_fk_cols) then 'null' else e end, ', ' order by k)
               from unnest(t.cols, t.casts) with ordinality u(c, e, k)),
            t.staging_table),
          fix_sql = format('update %s x set (%s) = (select %s from restore_staging.%I s where s._n = $1) where exists (select 1 from restore_staging.%I s where s._n = $1 and %s) returning to_jsonb(x)',
            t.rel,
            (select string_agg(format('%I', c), ', ' order by c) from unnest(v_fk_cols) c),
            (select string_agg(e, ', ' order by c) from unnest(t.cols, t.casts) u(c, e) where c = any (v_fk_cols)),
            t.staging_table, t.staging_table, x.pk_match)
         where x.staging_table = t.staging_table;
      end if;
    end if;
    v_tables := v_tables || jsonb_build_object(t.qualified, v_entry);
  end loop;

  -- Exact mode (Runbook B): only for a project whose logins are all in the backup, i.e. a new one.
  if p_exact then
    if to_regclass('auth.users') is null or not exists (select 1 from _rst_map where qualified = 'auth.users') then
      raise exception 'Exact mode needs the backup''s auth tables and an auth schema in this database.' using errcode = '55000';
    end if;
    execute format('select count(*) from auth.users u where not exists (select 1 from restore_staging.%I s where s.id::uuid = u.id)',
                   (select staging_table from _rst_map where qualified = 'auth.users')) into v_n;
    if v_n > 0 then
      raise exception 'Exact mode refused: this project has % login(s) that are not in the backup, so it is in use. Exact mode is only for a new, empty project (Runbook B); use the normal merge (Runbook A).', v_n
        using errcode = '55000';
    end if;
    -- Rows the migrations seeded that the backup does not have are removed, children first.
    perform restore.set_user_triggers(v_rels, false);
    for o in select f.rel, f.depth from restore.fk_order(v_rels) f order by f.depth desc, f.rel::text desc loop
      select * into t from _rst_map where rel = o.rel;
      for v_row in execute format('delete from %s x where not exists (select 1 from restore_staging.%I s where %s) returning to_jsonb(x)',
                                  t.rel, t.staging_table, t.pk_match) loop
        select jsonb_object_agg(c, v_row -> c) into v_pkv from unnest(t.pk) c;
        if p_run is not null then
          insert into restore.log (run_id, action, table_name, pk, new_row, old_row) values (p_run, 'delete', t.qualified, v_pkv, null, v_row);
        end if;
        v_tables := jsonb_set(v_tables, array[t.qualified, 'removed'], to_jsonb((v_tables -> t.qualified ->> 'removed')::bigint + 1));
      end loop;
    end loop;
    perform restore.set_user_triggers(v_rels, true);
  end if;

  -- Classify every staged row of every taking-part table, in foreign-key order.
  for o in select f.rel, f.depth from restore.fk_order(v_rels) f loop
    select * into t from _rst_map where rel = o.rel;
    execute format('select count(*) from restore_staging.%I s where exists (select 1 from %s x where %s)', t.staging_table, t.rel, t.pk_match) into v_n;
    v_tables := jsonb_set(v_tables, array[t.qualified, 'exists_live'], to_jsonb(v_n));
    execute format('select count(*) from restore_staging.%I s where not exists (select 1 from %s x where %s)
                      and exists (select 1 from restore.row_tombstones z where z.table_name = %L and z.pk = %s and z.deleted_at > %L)',
                   t.staging_table, t.rel, t.pk_match, t.qualified, t.pk_json, v_after) into v_n;
    v_tables := jsonb_set(v_tables, array[t.qualified, 'deleted_after_backup'], to_jsonb(v_n));
    execute format('insert into _rst_pending select %L, s._n, %s from restore_staging.%I s
                     where not exists (select 1 from %s x where %s)
                       and not exists (select 1 from restore.row_tombstones z where z.table_name = %L and z.pk = %s and z.deleted_at > %L)',
                   t.qualified, o.depth, t.staging_table, t.rel, t.pk_match, t.qualified, t.pk_json, v_after);

    -- An attachment whose file was already purged from storage would be a broken tile: reject it.
    if t.qualified = 'public.task_attachments' then
      execute format('insert into _rst_rejected select %L, %s, %L from restore_staging.%I s join _rst_pending p on p.qualified = %L and p.n = s._n
                        where exists (select 1 from public.attachment_purge_queue q where q.attachment_id = s.id::uuid and q.purged_at is not null)',
                     t.qualified, t.pk_json, 'its file was already deleted from storage', t.staging_table, t.qualified);
      execute format('delete from _rst_pending p using restore_staging.%I s
                       where p.qualified = %L and p.n = s._n
                         and exists (select 1 from public.attachment_purge_queue q where q.attachment_id = s.id::uuid and q.purged_at is not null)',
                     t.staging_table, t.qualified);
    end if;
  end loop;

  -- Write, with the written public tables' user triggers off (D-41).
  select array_agg(distinct x.rel) into v_write_rels from _rst_pending pe join _rst_map x on x.qualified = pe.qualified;
  if v_write_rels is not null then
    perform restore.set_user_triggers(v_write_rels, false);
  end if;

  <<outer>>
  loop
  loop
    v_pass := v_pass + 1;
    v_progress := 0;
    for p in select pe.qualified, pe.n, x.insert_sql, x.pk, x.pk_json, x.staging_table
               from _rst_pending pe join _rst_map x on x.qualified = pe.qualified
              order by pe.ord, pe.qualified, pe.n loop
      begin
        execute p.insert_sql into v_row using p.n;
        select jsonb_object_agg(c, v_row -> c) into v_pkv from unnest(p.pk) c;
        if p_run is not null then
          insert into restore.log (run_id, action, table_name, pk, new_row) values (p_run, 'insert', p.qualified, v_pkv, v_row);
        end if;
        insert into _rst_inserted values (p.qualified, p.n);
        delete from _rst_pending where qualified = p.qualified and n = p.n;
        v_progress := v_progress + 1;
      exception
        when foreign_key_violation then
          null; -- a parent may come later in this pass; tried again in the next one
        when others then
          get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_cons = constraint_name;
          execute format('select %s from restore_staging.%I s where s._n = $1', p.pk_json, p.staging_table) into v_pkv using p.n;
          insert into _rst_rejected values (p.qualified, v_pkv,
            case v_state when '23505' then 'conflicts with a live row on ' || coalesce(nullif(v_cons, ''), 'a unique constraint')
                         when '23514' then 'breaks the rule ' || coalesce(nullif(v_cons, ''), '(check constraint)')
                         when '23502' then 'a required value is missing: ' || v_msg
                         else v_state || ': ' || v_msg end);
          delete from _rst_pending where qualified = p.qualified and n = p.n;
      end;
    end loop;
    exit when v_progress = 0 or not exists (select 1 from _rst_pending) or v_pass > 50;
  end loop;
  exit outer when not exists (select 1 from _rst_pending) or v_pass > 50;
  -- No row can go in any more: break foreign-key cycles by inserting rows with their nullable foreign-key
  -- columns empty; those columns are filled in once everything is in.
  v_broke := 0;
  for p in select pe.qualified, pe.n, x.insert_nofk_sql, x.pk from _rst_pending pe join _rst_map x on x.qualified = pe.qualified
            where x.insert_nofk_sql is not null order by pe.ord, pe.qualified, pe.n loop
    begin
      execute p.insert_nofk_sql into v_row using p.n;
      select jsonb_object_agg(c, v_row -> c) into v_pkv from unnest(p.pk) c;
      if p_run is not null then
        insert into restore.log (run_id, action, table_name, pk, new_row) values (p_run, 'insert', p.qualified, v_pkv, v_row);
      end if;
      insert into _rst_inserted values (p.qualified, p.n);
      insert into _rst_fix values (p.qualified, p.n, v_pkv);
      delete from _rst_pending where qualified = p.qualified and n = p.n;
      v_broke := v_broke + 1;
    exception when foreign_key_violation then
      null; -- a NOT NULL reference is missing: this row cannot be placed
    end;
  end loop;
  exit outer when v_broke = 0;
  end loop outer;

  -- Fill in the foreign keys left empty to break a cycle.
  for p in select f.qualified, f.n, f.pk, x.fix_sql, x.rel from _rst_fix f join _rst_map x on x.qualified = f.qualified loop
    begin
      execute p.fix_sql into v_row using p.n;
      if p_run is not null then
        update restore.log set new_row = v_row where run_id = p_run and table_name = p.qualified and pk = p.pk and action = 'insert';
      end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      insert into _rst_rejected values (p.qualified, p.pk, 'a row it refers to does not exist (foreign key, after breaking a cycle): ' || v_msg);
      delete from _rst_inserted where qualified = p.qualified and n = p.n;
    end;
  end loop;

  -- Exact mode: live rows that differ from the backup take the backup's values (parents exist by now).
  if p_exact then
    perform restore.set_user_triggers(v_rels, false);
    for o in select f.rel, f.depth from restore.fk_order(v_rels) f loop
      select * into t from _rst_map where rel = o.rel;
      if cardinality(t.cols) <= cardinality(t.pk) then continue; end if;
      for p in execute format(
          'select to_jsonb(x) as old_row, s._n as n from %s x join restore_staging.%I s on %s
            where (%s) is distinct from (%s)',
          t.rel, t.staging_table, t.pk_match,
          (select string_agg(format('x.%I', c), ', ') from unnest(t.cols) c),
          array_to_string(t.casts, ', ')) loop
        begin
          execute format('update %s x set (%s) = (select %s from restore_staging.%I s where s._n = $1) where %s returning to_jsonb(x)',
                         t.rel, (select string_agg(format('%I', c), ', ') from unnest(t.cols) c), array_to_string(t.casts, ', '),
                         t.staging_table,
                         (select string_agg(format('x.%I = ($2 ->> %L)::%s', c, c, format_type(a.atttypid, a.atttypmod)), ' and ')
                            from unnest(t.pk) c join pg_attribute a on a.attrelid = t.rel and a.attname::text = c))
            into v_row using p.n, p.old_row;
          select jsonb_object_agg(c, v_row -> c) into v_pkv from unnest(t.pk) c;
          if p_run is not null then
            insert into restore.log (run_id, action, table_name, pk, new_row, old_row) values (p_run, 'revert', t.qualified, v_pkv, v_row, p.old_row);
          end if;
          v_tables := jsonb_set(v_tables, array[t.qualified, 'overwritten'], to_jsonb((v_tables -> t.qualified ->> 'overwritten')::bigint + 1));
        exception when others then
          get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
          insert into _rst_rejected values (t.qualified, (select jsonb_object_agg(c, p.old_row -> c) from unnest(t.pk) c),
                                            'could not take the backup''s values: ' || v_state || ': ' || v_msg);
        end;
      end loop;
    end loop;
    perform restore.set_user_triggers(v_rels, true);
  end if;

  -- What never found its parent.
  for p in select pe.qualified, pe.n, x.pk_json, x.staging_table from _rst_pending pe join _rst_map x on x.qualified = pe.qualified loop
    execute format('select %s from restore_staging.%I s where s._n = $1', p.pk_json, p.staging_table) into v_pkv using p.n;
    insert into _rst_rejected values (p.qualified, v_pkv,
      case when p.qualified = 'public.members' then 'its login (auth.users) does not exist: re-invite the person with Settings → Roster → Add (create-member)'
           else 'a row it refers to does not exist (foreign key) and is not in the backup either' end);
  end loop;

  if v_write_rels is not null then
    perform restore.set_user_triggers(v_write_rels, true);
    foreach v_r in array v_write_rels loop
      perform restore.bump_sequences(v_r);
    end loop;
  end if;

  for t in select qualified, count(*) as n from _rst_inserted group by 1 loop
    v_tables := jsonb_set(v_tables, array[t.qualified, 'inserted'], to_jsonb(t.n));
    v_total_inserted := v_total_inserted + t.n;
  end loop;
  for t in select qualified, count(*) as n, jsonb_agg(jsonb_build_object('pk', pk, 'reason', reason) order by reason) as ex from _rst_rejected group by 1 loop
    v_tables := jsonb_set(v_tables, array[t.qualified, 'rejected'], to_jsonb(t.n));
    v_tables := jsonb_set(v_tables, array[t.qualified, 'rejections'], t.ex);
    v_total_rejected := v_total_rejected + t.n;
  end loop;

  return jsonb_build_object('tables', v_tables, 'inserted', v_total_inserted, 'rejected', v_total_rejected,
                            'backup', m.backup_name, 'backup_taken_at', m.backup_taken_at, 'passes', v_pass);
end $fn$;

-- ------------------------------------------------------------------------- public face
-- Dry run (RST-05): everything apply would do, rolled back; one row per staged table.
create or replace function restore.plan(p_exclude text[] default '{}', p_include_auth boolean default false, p_exact boolean default false)
returns table (table_name text, staged bigint, exists_live bigint, deleted_after_backup bigint, would_insert bigint,
               would_overwrite bigint, would_remove bigint, rejected bigint, notes text, rejections jsonb)
language plpgsql set search_path = pg_catalog as $fn$
declare v_report jsonb;
begin
  perform restore.check_version();
  begin
    v_report := restore.merge(null, p_exclude, p_include_auth, p_exact);
    raise exception using errcode = 'P0R01', message = 'dry run: rolled back';
  exception when sqlstate 'P0R01' then
    null;
  end;
  return query
    select k, (v ->> 'staged')::bigint, (v ->> 'exists_live')::bigint, (v ->> 'deleted_after_backup')::bigint,
           (v ->> 'inserted')::bigint, (v ->> 'overwritten')::bigint, (v ->> 'removed')::bigint, (v ->> 'rejected')::bigint,
           (select string_agg(x, '; ') from jsonb_array_elements_text(v -> 'notes') x),
           coalesce(v -> 'rejections', '[]'::jsonb)
      from jsonb_each(v_report -> 'tables') e(k, v)
     order by k;
end $fn$;

-- The real thing (RST-06, RST-07, RST-09). Call inside BEGIN … COMMIT; returns the run id.
create or replace function restore.apply(p_exclude text[] default '{}', p_include_auth boolean default false,
                                         p_skip_rejected boolean default false, p_snapshot text default null,
                                         p_exact boolean default false)
returns uuid
language plpgsql set search_path = pg_catalog as $fn$
declare
  m restore_staging.meta := restore.meta();
  v_target text := restore.check_version();
  v_run uuid;
  v_report jsonb;
  v_bad text;
begin
  -- The staged rows must be exactly what the manifest says (RST-02): counts always; content where comparable
  -- and the database versions are the same.
  select string_agg(table_name, ', ') into v_bad from restore.verify_staging()
   where not rows_match or (md5_match is false and m.migration_version = v_target);
  if v_bad is not null then
    raise exception 'The staged rows do not match the backup''s manifest for: %. Nothing was restored.', v_bad using errcode = '22000';
  end if;

  insert into restore.runs (mode, backup_name, backup_taken_at, backup_migration, target_migration, options, snapshot_label)
  values ('apply', m.backup_name, m.backup_taken_at, m.migration_version, v_target,
          jsonb_build_object('exclude', coalesce(p_exclude, '{}'), 'include_auth', p_include_auth, 'skip_rejected', p_skip_rejected, 'exact', p_exact),
          p_snapshot)
  returning id into v_run;

  v_report := restore.merge(v_run, p_exclude, p_include_auth, p_exact);
  if (v_report ->> 'rejected')::bigint > 0 and not p_skip_rejected then
    raise exception 'Restore stopped: % row(s) would be rejected (see restore.plan()). Nothing was restored. Exclude those tables, or accept skipping the rejected rows explicitly.',
      v_report ->> 'rejected' using errcode = '23000';
  end if;

  update restore.runs set status = 'applied', summary = v_report, finished_at = clock_timestamp() where id = v_run;
  return v_run;
end $fn$;

-- Undo a run (RST-09): delete exactly the rows it inserted, newest first, and put reverted rows back.
-- Refuses when a restored row was changed since, or when rows that are not part of the run now refer
-- to it (deleting would take them along through ON DELETE CASCADE) — unless p_force.
create or replace function restore.undo(p_run uuid, p_force boolean default false)
returns table (table_name text, deleted bigint, reverted bigint)
language plpgsql set search_path = pg_catalog as $fn$
declare
  v_run restore.runs;
  l record;
  f record;
  v_rel regclass;
  v_now jsonb;
  v_where text;
  v_n bigint;
  v_problems text[] := '{}';
  v_rels regclass[];
begin
  select * into v_run from restore.runs where id = p_run for update;
  if not found then raise exception 'No restore run %.', p_run using errcode = 'P0002'; end if;
  if v_run.status <> 'applied' then raise exception 'Run % is %, not applied.', p_run, v_run.status using errcode = '55000'; end if;

  create temp table if not exists _rst_undo (table_name text, deleted bigint, reverted bigint) on commit drop;
  truncate _rst_undo;

  -- Checks first: nothing is touched unless the whole run can be undone.
  for l in select * from restore.log where run_id = p_run order by id loop
    v_rel := to_regclass(l.table_name);
    if v_rel is null then v_problems := v_problems || (l.table_name || ' no longer exists'); continue; end if;
    v_rels := array_append(v_rels, v_rel);
    select string_agg(format('x.%I = (%L::jsonb ->> %L)::%s', k, l.pk, k,
                             (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = v_rel and a.attname = k)), ' and ')
      into v_where from jsonb_object_keys(l.pk) k;
    execute format('select to_jsonb(x) from %s x where %s', v_rel, v_where) into v_now;
    if l.action = 'delete' then
      if v_now is not null then
        v_problems := v_problems || format('%s %s was removed by the restore but exists again', l.table_name, l.pk);
      end if;
      continue;
    end if;
    if v_now is null then
      continue; -- already gone: nothing to undo for this row
    end if;
    if v_now <> l.new_row and l.action = 'insert' then
      v_problems := v_problems || format('%s %s was changed after the restore', l.table_name, l.pk);
    end if;
    if l.action = 'revert' and v_now <> l.new_row then
      v_problems := v_problems || format('%s %s was changed after the revert', l.table_name, l.pk);
    end if;
    if l.action = 'insert' then
      -- rows outside this run that refer to this row
      for f in
        select c.conrelid::regclass as child, c.conkey, c.confkey from pg_constraint c
         where c.contype = 'f' and c.confrelid = v_rel
      loop
        execute format(
          'select count(*) from %s ch where (%s) = (select %s from %s x where %s)
             and not exists (select 1 from restore.log l2 where l2.run_id = %L and l2.table_name = %L and l2.pk = (select jsonb_object_agg(k, to_jsonb(ch) -> k) from unnest(%L::text[]) k))',
          f.child,
          (select string_agg(format('ch.%I', a.attname), ', ' order by u.o) from unnest(f.conkey) with ordinality u(n, o) join pg_attribute a on a.attrelid = f.child and a.attnum = u.n),
          (select string_agg(format('x.%I', a.attname), ', ' order by u.o) from unnest(f.confkey) with ordinality u(n, o) join pg_attribute a on a.attrelid = v_rel and a.attnum = u.n),
          v_rel, v_where, p_run,
          (select n.nspname || '.' || c2.relname from pg_class c2 join pg_namespace n on n.oid = c2.relnamespace where c2.oid = f.child),
          restore.pk_columns(f.child))
          into v_n;
        if v_n > 0 then
          v_problems := v_problems || format('%s %s is now referred to by %s row(s) of %s', l.table_name, l.pk, v_n, f.child);
        end if;
      end loop;
    end if;
  end loop;

  if cardinality(v_problems) > 0 and not p_force then
    raise exception E'Undo refused (nothing was changed):\n  %', array_to_string(v_problems[1:20], E'\n  ') using errcode = '55000';
  end if;

  select array_agg(distinct r) into v_rels from unnest(v_rels) r where (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = r) = 'public';
  if v_rels is not null then perform restore.set_user_triggers(v_rels, false); end if;

  for l in select * from restore.log where run_id = p_run order by id desc loop
    v_rel := to_regclass(l.table_name);
    if v_rel is null then continue; end if;
    select string_agg(format('x.%I = (%L::jsonb ->> %L)::%s', k, l.pk, k,
                             (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = v_rel and a.attname = k)), ' and ')
      into v_where from jsonb_object_keys(l.pk) k;
    if l.action = 'insert' then
      execute format('delete from %s x where %s', v_rel, v_where);
      get diagnostics v_n = row_count;
      insert into _rst_undo values (l.table_name, v_n, 0);
    elsif l.action = 'delete' then
      execute format('insert into %s (%s) overriding system value select %s from jsonb_populate_record(null::%s, %L::jsonb) r',
                     v_rel,
                     (select string_agg(format('%I', a.attname), ', ' order by a.attnum) from pg_attribute a where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''),
                     (select string_agg(format('r.%I', a.attname), ', ' order by a.attnum) from pg_attribute a where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''),
                     v_rel, l.old_row);
      insert into _rst_undo values (l.table_name, 0, 1);
    else
      execute format('update %s x set (%s) = (select %s from jsonb_populate_record(null::%s, %L::jsonb) r) where %s',
                     v_rel,
                     (select string_agg(format('%I', a.attname), ', ' order by a.attnum) from pg_attribute a where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''),
                     (select string_agg(format('r.%I', a.attname), ', ' order by a.attnum) from pg_attribute a where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''),
                     v_rel, l.old_row, v_where);
      get diagnostics v_n = row_count;
      insert into _rst_undo values (l.table_name, 0, v_n);
    end if;
  end loop;

  if v_rels is not null then perform restore.set_user_triggers(v_rels, true); end if;
  update restore.runs set status = 'undone', undone_at = clock_timestamp() where id = p_run;
  return query select u.table_name, sum(u.deleted)::bigint, sum(u.reverted)::bigint from _rst_undo u group by 1 order by 1;
end $fn$;

-- Targeted revert (RST-10): put an explicit list of rows back to their backup values. Manual only,
-- tables with an updated_at column only, logged as its own run and undoable. Returns the run id.
create or replace function restore.revert_rows(p_table text, p_pks jsonb[])
returns uuid
language plpgsql set search_path = pg_catalog as $fn$
declare
  m restore_staging.meta := restore.meta();
  v_target text := restore.check_version();
  t record;
  v_pk jsonb;
  v_where_live text;
  v_where_staged text;
  v_old jsonb;
  v_new jsonb;
  v_n bigint;
  v_run uuid;
  v_set text;
begin
  select * into t from restore.table_map() tm where tm.qualified = p_table;
  if not found or t.rel is null then raise exception 'Table % is not in the staged backup or not in this database.', p_table using errcode = 'P0002'; end if;
  if split_part(p_table, '.', 1) <> 'public' then raise exception 'Only public tables can be reverted.' using errcode = '22023'; end if;
  if not exists (select 1 from pg_attribute where attrelid = t.rel and attname = 'updated_at' and not attisdropped) then
    raise exception 'Table % has no updated_at column; targeted revert is only for tables that record changes.', p_table using errcode = '22023';
  end if;
  if p_pks is null or cardinality(p_pks) = 0 then raise exception 'Name the rows to revert (a list of primary keys).' using errcode = '22023'; end if;

  insert into restore.runs (mode, backup_name, backup_taken_at, backup_migration, target_migration, options)
  values ('revert', m.backup_name, m.backup_taken_at, m.migration_version, v_target, jsonb_build_object('table', p_table, 'rows', to_jsonb(p_pks)))
  returning id into v_run;

  perform restore.set_user_triggers(array[t.rel], false);
  v_set := (select string_agg(format('%I = r.%I', c, c), ', ') from unnest(t.cols) c where not (c = any (t.pk)));
  foreach v_pk in array p_pks loop
    if (select array_agg(k order by k) from jsonb_object_keys(v_pk) k) is distinct from (select array_agg(c order by c) from unnest(t.pk) c) then
      raise exception 'Key % does not name exactly the primary key (%).', v_pk, array_to_string(t.pk, ', ') using errcode = '22023';
    end if;
    select string_agg(format('x.%I = (%L::jsonb ->> %L)::%s', k, v_pk, k, (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = t.rel and a.attname = k)), ' and '),
           string_agg(format('s.%I::%s = (%L::jsonb ->> %L)::%s', k, (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = t.rel and a.attname = k), v_pk, k, (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = t.rel and a.attname = k)), ' and ')
      into v_where_live, v_where_staged from jsonb_object_keys(v_pk) k;
    execute format('select to_jsonb(x) from %s x where %s', t.rel, v_where_live) into v_old;
    if v_old is null then raise exception 'Row % of % does not exist live; use apply() to restore missing rows.', v_pk, p_table using errcode = 'P0002'; end if;
    execute format('update %s x set %s from (select %s from restore_staging.%I s where %s) r(%s) where %s returning to_jsonb(x)',
                   t.rel, v_set, array_to_string(t.casts, ', '), t.staging_table, v_where_staged,
                   (select string_agg(format('%I', c), ', ') from unnest(t.cols) c), v_where_live)
      into v_new;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'Row % of % is not in the backup.', v_pk, p_table using errcode = 'P0002'; end if;
    insert into restore.log (run_id, action, table_name, pk, new_row, old_row) values (v_run, 'revert', p_table, v_pk, v_new, v_old);
  end loop;
  perform restore.set_user_triggers(array[t.rel], true);
  update restore.runs set status = 'applied', finished_at = clock_timestamp(),
         summary = jsonb_build_object('reverted', cardinality(p_pks), 'table', p_table) where id = v_run;
  return v_run;
end $fn$;

-- Safety copy of every public table before an apply (RST-04): maintenance_backup.rs<time>_<table>
-- + a manifest, server-side, like supabase/maintenance/2026-10-01_backup_before_phase5.sql. Returns the label.
create or replace function restore.snapshot() returns text
language plpgsql set search_path = pg_catalog as $fn$
declare
  v_label text := 'rs' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISS');
  t text;
  v_count bigint;
  v_md5 text;
begin
  create schema if not exists maintenance_backup;
  revoke all on schema maintenance_backup from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema maintenance_backup from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema maintenance_backup from authenticated'; end if;
  execute format('create table maintenance_backup.%I (table_name text primary key, row_count bigint not null, content_md5 text not null, taken_at timestamptz not null default clock_timestamp())',
                 v_label || '_manifest');
  for t in select tablename from pg_tables where schemaname = 'public' order by tablename loop
    if char_length(v_label || '_' || t) > 63 then
      raise exception 'Snapshot table name for % would be too long.', t;
    end if;
    execute format('create table maintenance_backup.%I as table public.%I', v_label || '_' || t, t);
    execute format('select count(*), coalesce(md5(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text)), md5('''')) from maintenance_backup.%I x',
                   v_label || '_' || t) into v_count, v_md5;
    execute format('insert into maintenance_backup.%I values (%L, %s, %L)', v_label || '_manifest', t, v_count, v_md5);
  end loop;
  return v_label;
end $fn$;

-- ---------------------------------------------------------------------- EXECUTE surface
-- Nothing here is for the app. Only the owner (who runs ops/backup/restore.sh) may call it.
do $grants$
declare
  f record;
  r text;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restore' loop
    execute format('revoke all on function %s from public', f.sig);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f.sig, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema restore, restore_staging from %I', r);
    end if;
  end loop;
end
$grants$;
