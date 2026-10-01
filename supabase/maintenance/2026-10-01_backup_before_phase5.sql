-- =============================================================================
--  SAFETY SNAPSHOT before the Phase 2-4 rollout (backend completion, Phase 5).
--  Run once, as the database owner, immediately BEFORE the first pending migration:
--
--    hosted: SQL editor / MCP execute_sql with this file
--    local : docker exec -i supabase_db_reqon psql -U postgres -v ON_ERROR_STOP=1 -f - < this file
--
--  What it does: copies every base table of the `public` schema into
--  maintenance_backup.r20261001_<table> (server-side CREATE TABLE AS; nothing passes through a
--  client) and records, per table, the row count and an md5 over every row as jsonb in
--  maintenance_backup.r20261001_manifest.
--
--  What it does NOT do: copy anything from `auth` (password hashes, sessions and Auth settings
--  are never duplicated; the ids of the auth users are already in public.members), copy Storage
--  objects (the Book is a repository file, pinned by sha256), or protect against loss of the whole
--  project: it lives in the same database. Off-platform copies need pg_dump with the database
--  password, which this procedure does not use.
--
--  Safety: the schema is revoked from every API role (PostgREST does not expose it and the
--  grants below deny it anyway). Running the file again does NOT overwrite the snapshot; it stops
--  with a notice. Drop the schema deliberately (see the runbook) when the snapshot is no longer needed.
-- =============================================================================

do $backup$
declare
  t text;
  v_count bigint;
  v_md5 text;
begin
  if to_regclass('maintenance_backup.r20261001_manifest') is not null then
    raise notice 'The 2026-10-01 snapshot already exists; nothing was changed.';
    return;
  end if;

  create schema if not exists maintenance_backup;
  revoke all on schema maintenance_backup from public, anon, authenticated;

  create table maintenance_backup.r20261001_manifest (
    table_name  text primary key,
    row_count   bigint not null,
    content_md5 text not null,
    taken_at    timestamptz not null default clock_timestamp()
  );

  for t in
    select tablename from pg_tables where schemaname = 'public' order by tablename
  loop
    execute format('create table maintenance_backup.%I as table public.%I', 'r20261001_' || t, t);
    execute format('revoke all on maintenance_backup.%I from public, anon, authenticated', 'r20261001_' || t);
    execute format(
      'select count(*), coalesce(md5(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text)), md5(''''))
         from maintenance_backup.%I x', 'r20261001_' || t)
      into v_count, v_md5;
    insert into maintenance_backup.r20261001_manifest (table_name, row_count, content_md5)
    values (t, v_count, v_md5);
  end loop;

  revoke all on maintenance_backup.r20261001_manifest from public, anon, authenticated;
end
$backup$;

-- Evidence: the manifest (row count and content hash per table at the moment of the copy).
select m.table_name, m.row_count, left(m.content_md5, 8) as md5_8
  from maintenance_backup.r20261001_manifest m
 order by m.table_name;
