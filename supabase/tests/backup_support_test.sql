-- =============================================================================
--  Backup support (Ultraplan Phase 4): migration 20260133000000_backup_support.sql.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every fixture
--  rolls back. Fixture people are new @backup.test identities.
--
--  Result: BACKUP SUPPORT CHECKS PASSED / FAILED.
--
--  Covers: the backup_reader role (login, BYPASSRLS, pg_read_all_data, not superuser, no
--  password set by the migration, read-only by default, cannot write, can read what a dump
--  needs: public tables, auth.users, auth.identities, supabase_migrations); backup_runs
--  (RLS, who reads it, nobody writes it directly, every CHECK constraint); record_backup_run
--  (service-only, stores and trims).
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

create or replace function pg_temp.try_sql(stmt text) returns text language plpgsql as $fn$
begin
  execute stmt;
  return 'OK';
exception when others then return sqlstate;
end $fn$;

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

do $test$
declare
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid();
  tre uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); outs uuid := gen_random_uuid();
  fp text := repeat('ab', 8);
  sha text := repeat('c', 64);
  id1 bigint;
  total int; bad int; report text;
begin
  insert into auth.users (id, email)
  select id, k || '@backup.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (mem, 'mem'), (outs, 'outs')) v(id, k);
  insert into members (id, full_name, role, status)
  select id, 'B ' || k, 'Member', 'active'::member_state from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (mem, 'mem')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'), (tre, 'treasurer');

  -- Hosted/local `postgres` is not a superuser: to act AS backup_reader it must be allowed to SET ROLE to it
  -- (the role's creator holds ADMIN OPTION). Rolled back with everything else; a no-op for a superuser.
  begin
    execute format('grant backup_reader to %I with set true', current_user);
  exception when others then null;
  end;

  -- ===================================================================== the login role
  perform pg_temp.expect('backup_reader exists and can log in', (select rolcanlogin::text from pg_roles where rolname = 'backup_reader'), 'true');
  perform pg_temp.expect('backup_reader bypasses RLS (otherwise a dump misses rows)', (select rolbypassrls::text from pg_roles where rolname = 'backup_reader'), 'true');
  perform pg_temp.expect('backup_reader is not a superuser', (select rolsuper::text from pg_roles where rolname = 'backup_reader'), 'false');
  perform pg_temp.expect('backup_reader cannot create roles or databases or replicate',
    (select (rolcreaterole or rolcreatedb or rolreplication)::text from pg_roles where rolname = 'backup_reader'), 'false');
  perform pg_temp.expect('backup_reader reads through pg_read_all_data', pg_has_role('backup_reader', 'pg_read_all_data', 'member')::text, 'true');
  perform pg_temp.expect('backup_reader is not a member of pg_write_all_data', pg_has_role('backup_reader', 'pg_write_all_data', 'member')::text, 'false');
  perform pg_temp.expect('the migration sets no password (nobody can log in until the owner sets one)',
    (select coalesce(passwd is null, true)::text from pg_shadow where usename = 'backup_reader'), 'true');
  perform pg_temp.expect('transactions are read-only by default',
    (select (exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                      where r.rolname = 'backup_reader' and 'default_transaction_read_only=on' = any (s.setconfig)))::text), 'true');
  perform pg_temp.expect('a statement timeout bounds every query',
    (select (exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                      where r.rolname = 'backup_reader' and 'statement_timeout=10min' = any (s.setconfig)))::text), 'true');
  perform pg_temp.expect('it owns nothing', (select count(*)::text from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = 'backup_reader'), '0');
  perform pg_temp.expect('it holds no membership in the API roles',
    (select count(*)::text from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
      where u.rolname = 'backup_reader' and g.rolname in ('authenticated', 'anon', 'service_role', 'authenticator')), '0');

  -- What a dump needs, read AS backup_reader (RLS is on for these tables; BYPASSRLS shows every row).
  perform pg_temp.expect('it sees every member despite RLS',
    pg_temp.scalar_as('backup_reader', null, 'select count(*) from members'), (select count(*)::text from members));
  perform pg_temp.expect('it sees every auth.users row',
    pg_temp.scalar_as('backup_reader', null, 'select count(*) from auth.users'), (select count(*)::text from auth.users));
  perform pg_temp.expect('it can read auth.identities', (pg_temp.scalar_as('backup_reader', null, 'select count(*) from auth.identities') ~ '^[0-9]+$')::text, 'true');
  -- The migration history exists on a Supabase stack, not in the disposable test database.
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    perform pg_temp.expect('it can read the migration history',
      (pg_temp.scalar_as('backup_reader', null, 'select count(*) from supabase_migrations.schema_migrations') ~ '^[0-9]+$')::text, 'true');
  end if;
  perform pg_temp.expect('it can read the backup status table', (pg_temp.scalar_as('backup_reader', null, 'select count(*) from backup_runs') ~ '^[0-9]+$')::text, 'true');

  -- Everything else is refused.
  perform pg_temp.expect('it cannot insert', pg_temp.scalar_as('backup_reader', null, 'insert into member_roles (member_id, role) values (gen_random_uuid(), ''developer'') returning 1'), 'DENIED');
  perform pg_temp.expect('it cannot update', pg_temp.scalar_as('backup_reader', null, 'update members set full_name = full_name returning 1'), 'DENIED');
  perform pg_temp.expect('it cannot delete', pg_temp.scalar_as('backup_reader', null, 'delete from members returning 1'), 'DENIED');
  perform pg_temp.expect('it cannot touch auth.users', pg_temp.scalar_as('backup_reader', null, 'update auth.users set email = email returning 1'), 'DENIED');
  perform pg_temp.expect('it cannot record a backup run', pg_temp.scalar_as('backup_reader', null, 'select record_backup_run(''r2'', now(), false)'), 'DENIED');
  perform pg_temp.expect('it cannot create objects', pg_temp.scalar_as('backup_reader', null, 'create table public.x_backup_probe (a int)'), 'DENIED');

  -- ===================================================================== backup_runs: access
  perform pg_temp.expect('RLS is on for backup_runs', (select relrowsecurity::text from pg_class where oid = 'backup_runs'::regclass), 'true');
  select record_backup_run('r2', now() - interval '1 hour', true, 'daily/reqon-backup-20261008T031700Z.tar.age', 12345, sha, '20260133000000', 20000000, 600, array[fp], null) into id1;
  perform pg_temp.expect('the service role records a run (returns its id)', (id1 is not null)::text, 'true');
  perform pg_temp.expect('the President reads the runs', (pg_temp.scalar_as('authenticated', pre, format('select count(*) from backup_runs where id = %s', id1))), '1');
  perform pg_temp.expect('the Vice President reads the runs', (pg_temp.scalar_as('authenticated', vp, format('select count(*) from backup_runs where id = %s', id1))), '1');
  perform pg_temp.expect('a Developer reads the runs', (pg_temp.scalar_as('authenticated', dev, format('select count(*) from backup_runs where id = %s', id1))), '1');
  perform pg_temp.expect('the Treasurer sees no run', (pg_temp.scalar_as('authenticated', tre, format('select count(*) from backup_runs where id = %s', id1))), '0');
  perform pg_temp.expect('a plain member sees no run', (pg_temp.scalar_as('authenticated', mem, format('select count(*) from backup_runs where id = %s', id1))), '0');
  perform pg_temp.expect('a login with no roster row sees no run', (pg_temp.scalar_as('authenticated', outs, format('select count(*) from backup_runs where id = %s', id1))), '0');
  perform pg_temp.expect('anon cannot read', pg_temp.scalar_as('anon', null, 'select count(*) from backup_runs'), 'DENIED');
  perform pg_temp.expect('not even the President can insert directly',
    pg_temp.scalar_as('authenticated', pre, 'insert into backup_runs (destination, taken_at, ok) values (''r2'', now(), false) returning 1'), 'DENIED');
  perform pg_temp.expect('not even a Developer can update directly', pg_temp.scalar_as('authenticated', dev, 'update backup_runs set ok = false returning 1'), 'DENIED');
  perform pg_temp.expect('not even a Developer can delete directly', pg_temp.scalar_as('authenticated', dev, 'delete from backup_runs returning 1'), 'DENIED');
  perform pg_temp.expect('a President cannot call record_backup_run', pg_temp.scalar_as('authenticated', pre, 'select record_backup_run(''r2'', now(), false)'), 'DENIED');
  perform pg_temp.expect('anon cannot call record_backup_run', pg_temp.scalar_as('anon', null, 'select record_backup_run(''r2'', now(), false)'), 'DENIED');

  -- ===================================================================== the stored values
  perform pg_temp.expect('the run keeps what was recorded',
    (select format('%s|%s|%s|%s|%s|%s', destination, ok::text, object_key, size_bytes, migration_version, recipients) from backup_runs where id = id1),
    format('r2|true|daily/reqon-backup-20261008T031700Z.tar.age|12345|20260133000000|{%s}', fp));
  perform pg_temp.expect('a failure can be recorded without proof',
    pg_temp.scalar_as('service_role', null, 'select (record_backup_run(''github'', now(), false, null, null, null, null, null, null, ''{}'', ''upload_failed'') > 0)::text'), 'true');
  perform pg_temp.expect('a long detail is cut to 200 characters',
    (select char_length(detail)::text from backup_runs where id = (select max(id) from backup_runs)),
    (select char_length(detail)::text from backup_runs where id = (select max(id) from backup_runs)));
  perform pg_temp.expect('detail over 200 characters is trimmed on the way in',
    pg_temp.scalar_as('service_role', null, 'select char_length((select detail from backup_runs where id = record_backup_run(''drive'', now(), false, null, null, null, null, null, null, ''{}'', repeat(''x'', 500))))::text'), '200');

  -- ===================================================================== constraints
  perform pg_temp.expect('a destination outside the three', pg_temp.try_sql('insert into backup_runs (destination, taken_at, ok) values (''ftp'', now(), false)'), '23514');
  perform pg_temp.expect('an ok run needs size, checksum and migration version', pg_temp.try_sql('insert into backup_runs (destination, taken_at, ok) values (''r2'', now(), true)'), '23514');
  perform pg_temp.expect('a checksum must be 64 lowercase hex', pg_temp.try_sql(format('insert into backup_runs (destination, taken_at, ok, size_bytes, sha256, migration_version) values (''r2'', now(), true, 1, %L, ''1'')', repeat('G', 64))), '23514');
  perform pg_temp.expect('a size must be positive', pg_temp.try_sql(format('insert into backup_runs (destination, taken_at, ok, size_bytes, sha256, migration_version) values (''r2'', now(), true, 0, %L, ''1'')', sha)), '23514');
  perform pg_temp.expect('an object key outside the three folders', pg_temp.try_sql('insert into backup_runs (destination, taken_at, ok, object_key) values (''r2'', now(), false, ''other/reqon-backup-20261008T031700Z.tar.age'')'), '23514');
  perform pg_temp.expect('an object key cannot climb out', pg_temp.try_sql('insert into backup_runs (destination, taken_at, ok, object_key) values (''r2'', now(), false, ''daily/../reqon-backup-20261008T031700Z.tar.age'')'), '23514');
  perform pg_temp.expect('a recipient fingerprint must be 16 hex', pg_temp.try_sql('insert into backup_runs (destination, taken_at, ok, recipients) values (''r2'', now(), false, array[''not-a-fingerprint''])'), '23514');
  perform pg_temp.expect('a recipient list may be empty (a failed run)', pg_temp.try_sql('insert into backup_runs (destination, taken_at, ok, recipients) values (''r2'', now(), false, ''{}'')'), 'OK');
  insert into backup_runs (destination, taken_at, ok, recorded_at) values ('r2', now() - interval '500 days', false, now() - interval '401 days');
  perform record_backup_run('github', now(), false);
  perform pg_temp.expect('rows older than 400 days are trimmed when a new run is recorded',
    (select count(*)::text from backup_runs where recorded_at < now() - interval '400 days'), '0');

  -- ===================================================================== verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'BACKUP SUPPORT CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'BACKUP SUPPORT CHECKS PASSED — all % checks', total;
end
$test$;
