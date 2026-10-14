-- =============================================================================
--  Club accounts: migration 20260136000000_club_credentials.sql.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every fixture rolls
--  back. Fixture people are new @creds.test identities, fixture services are new rows, and the
--  passwords are made-up strings; nothing real is read or changed.
--
--  Result: CLUB ACCOUNT CHECKS PASSED / FAILED.
--
--  Covers: who may open the club accounts (President, Developer - not the Vice President,
--  Treasurer, members, an alumnus Developer, a login that is not on the roster, or anon); that
--  browsers can read the rows but never the Vault pointer, and can write nothing directly; that a
--  password comes out only through reveal_club_credential and that every successful reveal (and
--  only those) is recorded; saving (new password, blank keeps the old one, replacing updates the
--  Vault row in place); the length limits and unknown ids; and that the password is not stored
--  anywhere in the table itself.
-- =============================================================================

-- Runs a one-value statement as role r (authenticated as `who`, or anon / service_role with who null)
-- and returns that value as text; a privilege error (this includes the 42501 the functions raise for
-- someone who may not) is 'DENIED', anything else 'ERROR <sqlstate>: <message>'.
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
    v := coalesce(v, '<null>');
  exception
    when insufficient_privilege then v := 'DENIED';
    when others then v := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $fn$;

-- A write statement as an authenticated person: ALLOWED when it changed a row, DENIED when it was
-- refused or changed none.
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

create or replace function pg_temp.reveal(who uuid, cid uuid) returns text language sql as $fn$
  select pg_temp.scalar_as('authenticated', who, format('select reveal_club_credential(%L)', cid));
$fn$;

create or replace function pg_temp.save(who uuid, cid uuid, lg text, sec text) returns text language sql as $fn$
  select pg_temp.scalar_as('authenticated', who,
    format('select ''saved'' from (select save_club_credential(%L, %L, %L)) t', cid, lg, sec));
$fn$;

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

do $test$
declare
  pre uuid := gen_random_uuid(); dev uuid := gen_random_uuid(); vp uuid := gen_random_uuid();
  tre uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); alum_dev uuid := gen_random_uuid();
  outs uuid := gen_random_uuid();
  one uuid; empty uuid;
  who uuid;
  r text; rows_total text;
  total int; bad int; report text;
begin
  insert into auth.users (id, email)
  select id, k || '@creds.test' from (values (pre, 'pre'), (dev, 'dev'), (vp, 'vp'), (tre, 'tre'), (mem, 'mem'),
    (alum_dev, 'alumdev'), (outs, 'outs')) v(id, k);
  -- 'outs' has a login but is not on the roster.
  insert into members (id, full_name, role, status)
  select id, 'T ' || k, 'Member', case when k = 'alumdev' then 'alumni' else 'active' end::member_state
  from (values (pre, 'pre'), (dev, 'dev'), (vp, 'vp'), (tre, 'tre'), (mem, 'mem'), (alum_dev, 'alumdev')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (dev, 'developer'), (vp, 'vicepresident'),
    (tre, 'treasurer'), (alum_dev, 'developer');

  insert into club_credentials (service, sort_order) values ('Fixture one', 900) returning id into one;
  insert into club_credentials (service, sort_order) values ('Fixture empty', 901) returning id into empty;
  select count(*)::text into rows_total from club_credentials;

  -- ===================================================================== who may open the accounts
  perform pg_temp.expect('the President passes the gate', pg_temp.scalar_as('authenticated', pre, 'select can_view_club_credentials()::text'), 'true');
  perform pg_temp.expect('a Developer passes the gate', pg_temp.scalar_as('authenticated', dev, 'select can_view_club_credentials()::text'), 'true');
  perform pg_temp.expect('the Vice President does not', pg_temp.scalar_as('authenticated', vp, 'select can_view_club_credentials()::text'), 'false');
  perform pg_temp.expect('the Treasurer does not', pg_temp.scalar_as('authenticated', tre, 'select can_view_club_credentials()::text'), 'false');
  perform pg_temp.expect('an ordinary member does not', pg_temp.scalar_as('authenticated', mem, 'select can_view_club_credentials()::text'), 'false');
  perform pg_temp.expect('an alumnus Developer does not (only active members hold a role)', pg_temp.scalar_as('authenticated', alum_dev, 'select can_view_club_credentials()::text'), 'false');
  perform pg_temp.expect('a login that is not on the roster does not', pg_temp.scalar_as('authenticated', outs, 'select can_view_club_credentials()::text'), 'false');
  perform pg_temp.expect('anon cannot even ask', pg_temp.scalar_as('anon', null, 'select can_view_club_credentials()::text'), 'DENIED');

  -- ===================================================================== the rows
  perform pg_temp.expect('the President sees every row', pg_temp.scalar_as('authenticated', pre, 'select count(*)::text from club_credentials'), rows_total);
  perform pg_temp.expect('a Developer sees every row', pg_temp.scalar_as('authenticated', dev, 'select count(*)::text from club_credentials'), rows_total);
  foreach who in array array[vp, tre, mem, alum_dev, outs] loop
    perform pg_temp.expect('someone without the gate sees no row (' || who || ')', pg_temp.scalar_as('authenticated', who, 'select count(*)::text from club_credentials'), '0');
  end loop;
  perform pg_temp.expect('anon cannot read the table', pg_temp.scalar_as('anon', null, 'select count(*)::text from club_credentials'), 'DENIED');
  perform pg_temp.expect('the listed columns can be read', pg_temp.scalar_as('authenticated', pre, 'select count(id)::text from club_credentials where has_secret is not null'), rows_total);
  perform pg_temp.expect('even the President cannot read the Vault pointer', pg_temp.scalar_as('authenticated', pre, 'select secret_id::text from club_credentials limit 1'), 'DENIED');
  perform pg_temp.expect('select * is refused too (the app must list its columns)', pg_temp.scalar_as('authenticated', pre, 'select count(*)::text from (select * from club_credentials) t'), 'DENIED');
  perform pg_temp.expect('nobody writes a row directly: update', pg_temp.attempt(pre, 'update club_credentials set login = ''x'''), 'DENIED');
  perform pg_temp.expect('nobody writes a row directly: insert', pg_temp.attempt(pre, 'insert into club_credentials (service) values (''Sneaky'')'), 'DENIED');
  perform pg_temp.expect('nobody writes a row directly: delete', pg_temp.attempt(pre, 'delete from club_credentials'), 'DENIED');
  perform pg_temp.expect('a developer does not write directly either', pg_temp.attempt(dev, 'update club_credentials set login = ''x'''), 'DENIED');
  perform pg_temp.expect('the Vault is closed to browsers', pg_temp.scalar_as('authenticated', pre, 'select count(*)::text from vault.decrypted_secrets'), 'DENIED');
  select count(*)::text into r from club_credentials where service in ('Cloudflare', 'Supabase', 'Vercel');
  perform pg_temp.expect('Cloudflare, Supabase and Vercel are seeded', r, '3');

  -- ===================================================================== a refused change leaves no trace
  foreach who in array array[vp, tre, mem, alum_dev, outs] loop
    perform pg_temp.expect('save is refused without the gate (' || who || ')', pg_temp.save(who, one, 'x@y.test', 'Hacked-1'), 'DENIED');
  end loop;
  perform pg_temp.expect('anon cannot save', pg_temp.scalar_as('anon', null, format('select save_club_credential(%L, ''x'', ''y'')', one)), 'DENIED');
  select (not has_secret and login = '')::text into r from club_credentials where id = one;
  perform pg_temp.expect('after those refusals the fixture is still empty', r, 'true');

  -- ===================================================================== saving
  perform pg_temp.expect('the President saves a login and password', pg_temp.save(pre, one, '  club@example.test  ', 'Fixture-Alpha-1'), 'saved');
  select (has_secret and login = 'club@example.test' and updated_by = pre and updated_at is not null)::text into r from club_credentials where id = one;
  perform pg_temp.expect('the row now has a password, a trimmed login and who saved it', r, 'true');
  perform pg_temp.expect('browsers see has_secret as true', pg_temp.scalar_as('authenticated', dev, format('select has_secret::text from club_credentials where id = %L', one)), 'true');
  select (to_jsonb(c)::text like '%Fixture-Alpha-1%')::text into r from club_credentials c where id = one;
  perform pg_temp.expect('the password appears nowhere in the table row', r, 'false');
  select string_agg(column_name::text, ',' order by column_name) into r from information_schema.columns
   where table_schema = 'public' and table_name = 'club_credentials' and (column_name ilike '%secret%' or column_name ilike '%pass%');
  perform pg_temp.expect('the only secret-looking columns are the pointer and its flag', r, 'has_secret,secret_id');

  -- ===================================================================== revealing
  perform pg_temp.expect('the President reveals the password', pg_temp.reveal(pre, one), 'Fixture-Alpha-1');
  select (last_revealed_by = pre and last_revealed_at is not null)::text into r from club_credentials where id = one;
  perform pg_temp.expect('the reveal is recorded with who asked', r, 'true');
  perform pg_temp.expect('a Developer reveals it too', pg_temp.reveal(dev, one), 'Fixture-Alpha-1');
  select (last_revealed_by = dev)::text into r from club_credentials where id = one;
  perform pg_temp.expect('the record follows the latest reveal', r, 'true');
  foreach who in array array[vp, tre, mem, alum_dev, outs] loop
    perform pg_temp.expect('reveal is refused without the gate (' || who || ')', pg_temp.reveal(who, one), 'DENIED');
  end loop;
  perform pg_temp.expect('anon cannot reveal', pg_temp.scalar_as('anon', null, format('select reveal_club_credential(%L)', one)), 'DENIED');
  select (last_revealed_by = dev)::text into r from club_credentials where id = one;
  perform pg_temp.expect('refused attempts leave the record untouched', r, 'true');
  perform pg_temp.expect('an account without a password says so', pg_temp.reveal(pre, empty), 'ERROR P0002%');
  select (last_revealed_at is null)::text into r from club_credentials where id = empty;
  perform pg_temp.expect('and that failed reveal is not recorded', r, 'true');
  perform pg_temp.expect('an unknown id is reported', pg_temp.reveal(pre, gen_random_uuid()), 'ERROR P0002%');

  -- ===================================================================== changing it later
  perform pg_temp.expect('a blank password keeps the old one', pg_temp.save(pre, one, 'second@example.test', ''), 'saved');
  perform pg_temp.expect('...which still reveals', pg_temp.reveal(pre, one), 'Fixture-Alpha-1');
  perform pg_temp.expect('a null password keeps it as well', pg_temp.save(pre, one, 'third@example.test', null), 'saved');
  select (login = 'third@example.test')::text into r from club_credentials where id = one;
  perform pg_temp.expect('the login changed meanwhile', r, 'true');
  perform pg_temp.expect('a Developer replaces the password', pg_temp.save(dev, one, 'third@example.test', 'Fixture-Beta-2'), 'saved');
  perform pg_temp.expect('the new password is what comes out', pg_temp.reveal(pre, one), 'Fixture-Beta-2');
  select count(*)::text into r from vault.secrets where name = 'club_credential:' || one::text;
  perform pg_temp.expect('replacing updates the Vault row in place (no leftover copy)', r, '1');

  -- ===================================================================== limits
  perform pg_temp.expect('a login over 200 characters is refused', pg_temp.save(pre, one, repeat('a', 201), null), 'ERROR 22023%');
  perform pg_temp.expect('a password over 500 characters is refused', pg_temp.save(pre, one, 'x', repeat('p', 501)), 'ERROR 22023%');
  perform pg_temp.expect('saving an unknown id is reported', pg_temp.save(pre, gen_random_uuid(), 'x', 'y'), 'ERROR P0002%');
  perform pg_temp.expect('those refused saves changed nothing', pg_temp.reveal(pre, one), 'Fixture-Beta-2');
  select (login = 'third@example.test')::text into r from club_credentials where id = one;
  perform pg_temp.expect('...including the login', r, 'true');
  perform pg_temp.expect('a login of exactly 200 is fine', pg_temp.save(pre, one, repeat('a', 200), null), 'saved');
  perform pg_temp.expect('a password of exactly 500 is fine', pg_temp.save(pre, one, 'x', repeat('p', 500)), 'saved');
  perform pg_temp.expect('and comes back whole', pg_temp.reveal(pre, one), repeat('p', 500));

  -- ================================================================================ verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'CLUB ACCOUNT CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'CLUB ACCOUNT CHECKS PASSED — all % checks', total;
end
$test$;
