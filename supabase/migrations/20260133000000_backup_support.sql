-- =============================================================================
--  Ultraplan Phase 4: support for automated encrypted backups.
--  docs/ultraplan/ARCHITECTURE.md sections 7-8; decisions D-11, D-22.
--
--  WHAT WAS MISSING. Nothing dumped the database on a schedule, and nothing told the
--  club whether a backup had actually happened.
--
--  AFTER.
--   * A login role `backup_reader` for the backup workflow: member of pg_read_all_data
--     (reads every table in every schema) AND BYPASSRLS (without it, pg_dump either
--     refuses or — with row security on — silently skips rows, because public tables and
--     auth.users have RLS; Phase 0 finding F0-04). It owns nothing, can write nothing and
--     runs read-only transactions by default. THE MIGRATION SETS NO PASSWORD: until the
--     owner sets one (Phase 7), nobody can log in as it.
--   * backup_runs: one row per destination per run (r2 | github | drive) with size,
--     checksum, migration version and the recipients' key fingerprints — never a key,
--     never a row of club data. The Board (President, Vice President, Developer) reads
--     it in Settings → Backups; nobody writes it directly.
--   * record_backup_run(): SERVICE-ONLY. The `backup-record` Edge Function calls it after
--     the workflow proved itself with a shared secret (like attachment-purge, D-22), so
--     the workflow never holds the service-role key.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        A least-privilege reader for pg_dump and a status record for the UI.
--    Existing data  None touched. One new role, one new table, one new function.
--    Locking        CREATE ROLE / TABLE / FUNCTION: no lock on existing tables.
--    Authorization  RLS on backup_runs: SELECT for is_admin() only; no write policy;
--                   writes only through record_backup_run (service_role).
--    Rollback       docs/ultraplan/rollbacks/20260133000000_backup_support_down.sql
--                   (the objects in R2 / GitHub / Drive are never touched by it).
--    Deploy order   Any time after 20260132000000. Hosted: only via
--                   `supabase db push --linked`, then the owner sets the role password.
-- =============================================================================

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'backup_reader') then
    create role backup_reader login bypassrls inherit nosuperuser nocreatedb nocreaterole noreplication
      connection limit 3;
  end if;
end
$role$;

grant pg_read_all_data to backup_reader;
-- Read-only by default and bounded: a runaway dump cannot hold the database for long.
alter role backup_reader set default_transaction_read_only = on;
alter role backup_reader set statement_timeout = '10min';
alter role backup_reader set idle_in_transaction_session_timeout = '5min';

-- ---------------------------------------------------------------------- status table
create table if not exists backup_runs (
  id                bigint generated always as identity primary key,
  destination       text not null check (destination in ('r2', 'github', 'drive')),
  taken_at          timestamptz not null,
  recorded_at       timestamptz not null default now(),
  ok                boolean not null,
  -- Bucket-relative key of the encrypted file (r2 only), e.g. daily/reqon-backup-20261008T031700Z.tar.age
  object_key        text,
  size_bytes        bigint check (size_bytes is null or size_bytes > 0),
  sha256            text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  migration_version text,
  db_size_bytes     bigint check (db_size_bytes is null or db_size_bytes >= 0),
  row_count         bigint check (row_count is null or row_count >= 0),
  -- Short fingerprints (16 hex) of the age public keys it was encrypted to.
  recipients        text[] not null default '{}',
  -- A short failure code for people ('dump_too_big', 'upload_failed'); never a secret or a row.
  detail            text check (detail is null or char_length(detail) <= 200),
  constraint backup_runs_ok_has_proof
    check (not ok or (size_bytes is not null and sha256 is not null and migration_version is not null)),
  constraint backup_runs_object_key_shape
    check (object_key is null or object_key ~ '^(daily|weekly|monthly)/reqon-backup-[0-9]{8}T[0-9]{6}Z\.tar\.age$'),
  constraint backup_runs_fingerprints
    check (array_to_string(recipients, ',') ~ '^([0-9a-f]{16}(,[0-9a-f]{16})*)?$')
);

create index if not exists backup_runs_latest on backup_runs (destination, taken_at desc);

alter table backup_runs enable row level security;
drop policy if exists admin_read on backup_runs;
create policy admin_read on backup_runs for select to authenticated using (is_admin());
revoke all on backup_runs from anon, authenticated;
grant select on backup_runs to authenticated;
grant all on backup_runs to service_role;

-- ---------------------------------------------------------------- service-only writer
create or replace function record_backup_run(
  p_destination text, p_taken_at timestamptz, p_ok boolean, p_object_key text default null,
  p_size_bytes bigint default null, p_sha256 text default null, p_migration_version text default null,
  p_db_size_bytes bigint default null, p_row_count bigint default null,
  p_recipients text[] default '{}', p_detail text default null)
returns bigint language plpgsql security definer set search_path = public as $fn$
declare v_id bigint;
begin
  insert into backup_runs (destination, taken_at, ok, object_key, size_bytes, sha256, migration_version,
                           db_size_bytes, row_count, recipients, detail)
  values (p_destination, p_taken_at, p_ok, p_object_key, p_size_bytes, p_sha256, p_migration_version,
          p_db_size_bytes, p_row_count, coalesce(p_recipients, '{}'), left(p_detail, 200))
  returning id into v_id;
  -- Keep the table small: more than a year of history helps nobody.
  delete from backup_runs where recorded_at < now() - interval '400 days';
  return v_id;
end $fn$;

revoke all on function record_backup_run(text, timestamptz, boolean, text, bigint, text, text, bigint, bigint, text[], text)
  from public, anon, authenticated;
grant execute on function record_backup_run(text, timestamptz, boolean, text, bigint, text, text, bigint, bigint, text[], text)
  to service_role;
