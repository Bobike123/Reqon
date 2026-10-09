-- The manifest of a backup: per-table row count and md5, plus the migration version.
-- Run with:  psql -X -At -v ON_ERROR_STOP=1 -f manifest.sql   (as backup_reader, or any role that sees every row)
--
-- Used three times: before a dump and after it (the two must agree, otherwise the database changed under
-- the dump and the run is repeated), and later by the restore tooling (Phase 5) on a restored copy — which
-- is why the session settings below are fixed: a row's text form must not depend on who asks.
--
-- Prints ONE line of JSON. It holds counts and hashes of club data, so the file it ends up in is encrypted.
set timezone = 'UTC';
set datestyle = 'ISO, YMD';
set extra_float_digits = 3;
set bytea_output = 'hex';
set intervalstyle = 'postgres';

select jsonb_build_object(
  'migration_version', (select max(version) from supabase_migrations.schema_migrations),
  'tables', coalesce((
    select jsonb_object_agg(name, jsonb_build_object('rows', rows, 'md5', md5) order by name)
    from (
      select format('%s.%s', n.nspname, c.relname) as name,
             (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint as rows,
             (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, E''\n'' order by t::text), '''')) as h from %I.%I t', n.nspname, c.relname), false, true, '')))[1]::text as md5
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p')
         and (n.nspname in ('public', 'supabase_migrations')
              or (n.nspname = 'auth' and c.relname in ('users', 'identities')))
    ) per_table
  ), '{}'::jsonb)
)::text;
