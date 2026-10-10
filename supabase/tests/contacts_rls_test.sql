-- =============================================================================
--  Contacts checks for Reqon (contact_categories, contacts, migration 20260136).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything happens inside one block
--  that always ends by raising an exception, so every change is rolled back.
--  The result arrives as an "error" that begins with
--      CONTACTS CHECKS PASSED   or   CONTACTS CHECKS FAILED
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
  head     uuid := gen_random_uuid();
  exhead   uuid := gen_random_uuid();
  pre      uuid := gen_random_uuid();
  mem      uuid := gen_random_uuid();
  alum     uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  cat      uuid;
  person   uuid;
  c        record;
  got      text;
  stamped  uuid;
  lines    text[] := '{}';
  failures text[] := '{}';
begin
  insert into auth.users (id, email) values
    (head, 'con-head@roles.test'), (exhead, 'con-exhead@roles.test'), (pre, 'con-pre@roles.test'),
    (mem, 'con-mem@roles.test'), (alum, 'con-alum@roles.test'), (outsider, 'con-out@roles.test');
  insert into members (id, full_name, role, status) values
    (head, 'Con Head', 'Chassis', 'active'), (exhead, 'Con Ex-Head', 'Chassis', 'active'),
    (pre, 'Con President', 'Team lead', 'active'), (mem, 'Con Member', 'Chassis', 'active'),
    (alum, 'Con Alumnus', 'Chassis', 'alumni');
  insert into member_roles (member_id, role) values (pre, 'president');
  insert into subteams (key, name, lead_id) values ('CON_LIVE', 'Contacts live dept', head);
  insert into subteams (key, name, lead_id, archived_at) values ('CON_GONE', 'Contacts archived dept', exhead, now());
  insert into contact_categories (name) values ('Administration') returning id into cat;
  insert into contacts (category_id, name, help, website)
    values (cat, 'Studieliv', 'Student administration', 'https://studieliv.sdu.dk') returning id into person;

  create temp table checks (n serial, label text, who uuid, stmt text, kind text, expected text);
  insert into checks (label, who, stmt, kind, expected) values
    ('anon          reads contacts',         null,     'select count(*) from contacts', 'read', 'DENIED'),
    ('non-member    reads contacts',         outsider, 'select count(*) from contacts', 'read', 'DENIED'),
    ('member        reads contacts',         mem,      'select count(*) from contacts', 'read', 'ALLOWED'),
    ('alumnus       reads categories',       alum,     'select count(*) from contact_categories', 'read', 'ALLOWED'),
    ('member        adds a category',        mem,      'insert into contact_categories (name) values (''Member cat'')', 'write', 'DENIED'),
    ('ex-Head       adds a category',        exhead,   'insert into contact_categories (name) values (''Ex cat'')', 'write', 'DENIED'),
    ('Head          adds a category',        head,     'insert into contact_categories (name) values (''Mechanical design'')', 'write', 'ALLOWED'),
    ('Head          adds a duplicate name',  head,     'insert into contact_categories (name) values (''administration '')', 'write', 'ERROR 23505'),
    ('president     renames a category',     pre,      format('update contact_categories set name = ''Admin'' where id = %L', cat), 'write', 'ALLOWED'),
    ('member        edits a contact',        mem,      format('update contacts set help = ''x'' where id = %L', person), 'write', 'DENIED'),
    ('Head          adds a contact',         head,     format('insert into contacts (category_id, name, help, email, created_by) values (%L, ''Andrei'', ''NX design'', ''a@sdu.dk'', %L)', cat, pre), 'write', 'ALLOWED'),
    ('Head          adds an unreachable one',head,     format('insert into contacts (category_id, name, help) values (%L, ''Nobody'', ''x'')', cat), 'write', 'ERROR 23514'),
    ('Head          adds a bad email',       head,     format('insert into contacts (category_id, name, help, email) values (%L, ''Bad'', ''x'', ''not-an-email'')', cat), 'write', 'ERROR 23514'),
    ('alumnus       deletes a contact',      alum,     format('delete from contacts where id = %L', person), 'write', 'DENIED'),
    ('Head          empties the table',      head,     'truncate contacts', 'write', 'DENIED'),
    ('Head          deletes a contact',      head,     format('delete from contacts where id = %L', person), 'write', 'ALLOWED');

  for c in select * from checks order by n loop
    got := pg_temp.attempt(c.who, c.stmt, c.kind);
    if c.expected like 'ERROR %' and got like c.expected || '%' then got := c.expected; end if;
    lines := lines || format('%s  %-40s expected %-11s got %s',
      case when got = c.expected then 'ok  ' else 'FAIL' end, c.label, c.expected, got);
    if got <> c.expected then
      failures := failures || format('%s: expected %s, got %s', c.label, c.expected, got);
    end if;
  end loop;

  -- The database, not the browser, says who added a contact.
  select created_by into stamped from contacts where name = 'Andrei';
  lines := lines || format('%s  %-40s', case when stamped = head then 'ok  ' else 'FAIL' end,
    '  -> a forged created_by is replaced');
  if stamped is distinct from head then failures := failures || 'created_by was not stamped on insert'; end if;

  -- Deleting a category takes its contacts with it.
  delete from contact_categories where id = cat;
  lines := lines || format('%s  %-40s', case when not exists (select 1 from contacts where category_id = cat) then 'ok  ' else 'FAIL' end,
    '  -> deleting a category removes its contacts');
  if exists (select 1 from contacts where category_id = cat) then failures := failures || 'category delete left contacts behind'; end if;

  if array_length(failures, 1) > 0 then
    raise exception E'CONTACTS CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'CONTACTS CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
