-- =============================================================================
--  Finance checks for Reqon (finance_entries, migration 20260106).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates happens inside
--  one block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations. The
--  result arrives as an "error" message that begins with
--      FINANCE CHECKS PASSED   or   FINANCE CHECKS FAILED
--  That "error" is the rollback doing its job.
-- =============================================================================

create or replace function pg_temp.attempt(who uuid, stmt text, kind text)
returns text language plpgsql as $fn$
declare
  n bigint;
begin
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

    if kind = 'read' then
      execute stmt into n;
    else
      execute stmt;
      get diagnostics n = row_count;
    end if;

    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return case when n > 0 then 'ALLOWED' else 'DENIED' end;
  exception
    when insufficient_privilege then return 'DENIED';
    when others then return 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
end $fn$;

do $test$
declare
  dev      uuid := gen_random_uuid();
  tre      uuid := gen_random_uuid();
  pre      uuid := gen_random_uuid();
  vp       uuid := gen_random_uuid();
  mem      uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  season   uuid;
  entry    uuid;
  c        record;
  got      text;
  stamped  uuid;
  remaining int;
  lines    text[] := '{}';
  failures text[] := '{}';
begin
  insert into auth.users (id, email) values
    (dev, 'fin-dev@roles.test'), (tre, 'fin-tre@roles.test'), (pre, 'fin-pre@roles.test'),
    (vp, 'fin-vp@roles.test'), (mem, 'fin-mem@roles.test'), (outsider, 'fin-out@roles.test');
  insert into members (id, full_name, role) values
    (dev, 'Fin Developer', 'Software'), (tre, 'Fin Treasurer', 'Finance'),
    (pre, 'Fin President', 'Team lead'), (vp, 'Fin Vice', 'Operations'), (mem, 'Fin Member', 'Chassis');
  insert into member_roles (member_id, role) values
    (dev, 'developer'), (tre, 'treasurer'), (pre, 'president'), (vp, 'vicepresident');
  insert into seasons (label, is_current) values ('FINANCE-TEST', false) returning id into season;
  insert into finance_entries (season_id, kind, description, amount_cents)
    values (season, 'expense', 'Entry fee', 455000) returning id into entry;

  create temp table checks (n serial, label text, who uuid, stmt text, kind text, expected text);
  insert into checks (label, who, stmt, kind, expected) values
    ('developer     reads finances',   dev,      'select count(*) from finance_entries', 'read', 'ALLOWED'),
    ('president     reads finances',   pre,      'select count(*) from finance_entries', 'read', 'ALLOWED'),
    ('vicepresident reads finances',   vp,       'select count(*) from finance_entries', 'read', 'ALLOWED'),
    ('treasurer     reads finances',   tre,      'select count(*) from finance_entries', 'read', 'ALLOWED'),
    ('member        reads finances',   mem,      'select count(*) from finance_entries', 'read', 'DENIED'),
    ('off-roster    reads finances',   outsider, 'select count(*) from finance_entries', 'read', 'DENIED'),
    ('signed out    reads finances',   null,     'select count(*) from finance_entries', 'read', 'DENIED'),
    ('developer     adds an entry',    dev, format('insert into finance_entries (season_id, kind, description, amount_cents) values (%L, ''income'', ''x'', 100)', season), 'write', 'DENIED'),
    ('president     adds an entry',    pre, format('insert into finance_entries (season_id, kind, description, amount_cents) values (%L, ''income'', ''x'', 100)', season), 'write', 'DENIED'),
    ('vicepresident adds an entry',    vp,  format('insert into finance_entries (season_id, kind, description, amount_cents) values (%L, ''income'', ''x'', 100)', season), 'write', 'DENIED'),
    ('member        adds an entry',    mem, format('insert into finance_entries (season_id, kind, description, amount_cents) values (%L, ''income'', ''x'', 100)', season), 'write', 'DENIED'),
    ('treasurer     adds an entry',    tre, format('insert into finance_entries (season_id, kind, description, amount_cents) values (%L, ''income'', ''Sponsor'', 100000)', season), 'write', 'ALLOWED'),
    ('developer     edits an entry',   dev, format('update finance_entries set amount_cents = 1 where id = %L', entry), 'write', 'DENIED'),
    ('president     edits an entry',   pre, format('update finance_entries set amount_cents = 1 where id = %L', entry), 'write', 'DENIED'),
    ('vicepresident edits an entry',   vp,  format('update finance_entries set amount_cents = 1 where id = %L', entry), 'write', 'DENIED'),
    ('member        edits an entry',   mem, format('update finance_entries set amount_cents = 1 where id = %L', entry), 'write', 'DENIED'),
    ('treasurer     edits an entry',   tre, format('update finance_entries set amount_cents = 460000 where id = %L', entry), 'write', 'ALLOWED'),
    ('developer     deletes an entry', dev, format('delete from finance_entries where id = %L', entry), 'write', 'DENIED'),
    ('president     deletes an entry', pre, format('delete from finance_entries where id = %L', entry), 'write', 'DENIED'),
    ('vicepresident deletes an entry', vp,  format('delete from finance_entries where id = %L', entry), 'write', 'DENIED'),
    ('member        deletes an entry', mem, format('delete from finance_entries where id = %L', entry), 'write', 'DENIED'),
    ('treasurer     empties the table (TRUNCATE)', tre, 'truncate finance_entries', 'write', 'DENIED'),
    ('treasurer     forges created_by', tre, format('insert into finance_entries (season_id, kind, description, amount_cents, created_by) values (%L, ''expense'', ''forged'', 100, %L)', season, dev), 'write', 'ALLOWED'),
    ('treasurer     rewrites created_by', tre, format('update finance_entries set created_by = %L where id = %L', dev, entry), 'write', 'ALLOWED'),
    ('treasurer     deletes an entry', tre, format('delete from finance_entries where description = %L', 'Sponsor'), 'write', 'ALLOWED');

  for c in select * from checks order by n loop
    got := pg_temp.attempt(c.who, c.stmt, c.kind);
    lines := lines || format('%s  %-46s expected %-7s got %s',
      case when got = c.expected then 'ok  ' else 'FAIL' end, c.label, c.expected, got);
    if got <> c.expected then
      failures := failures || format('%s: expected %s, got %s', c.label, c.expected, got);
    end if;
  end loop;

  -- The database, not the browser, says who recorded an entry.
  select created_by into stamped from finance_entries where description = 'forged';
  lines := lines || format('%s  %-46s', case when stamped = tre then 'ok  ' else 'FAIL' end,
    '  -> a forged created_by is replaced by the real one');
  if stamped is distinct from tre then failures := failures || 'created_by was not stamped on insert'; end if;

  select created_by into stamped from finance_entries where id = entry;
  lines := lines || format('%s  %-46s', case when stamped is null then 'ok  ' else 'FAIL' end,
    '  -> an edit cannot rewrite created_by');
  if stamped is not null then failures := failures || 'created_by was rewritten by an update'; end if;

  select count(*) into remaining from finance_entries where season_id = season;
  lines := lines || format('%s  %-46s', case when remaining > 0 then 'ok  ' else 'FAIL' end,
    '  -> TRUNCATE really left the rows alone');
  if remaining = 0 then failures := failures || 'TRUNCATE emptied the table'; end if;

  if array_length(failures, 1) > 0 then
    raise exception E'FINANCE CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'FINANCE CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
