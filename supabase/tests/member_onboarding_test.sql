-- =============================================================================
--  Member onboarding checks (20260131000000_member_onboarding.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates happens inside
--  one block that always ends by raising an exception, so Postgres rolls every
--  change back. The fixture people are new auth.users rows with
--  @onboarding.test addresses.
--
--  Result: an "error" whose message begins with
--      MEMBER ONBOARDING CHECKS PASSED   or   MEMBER ONBOARDING CHECKS FAILED
--
--  Covers what the create-member Edge Function relies on: can_add_members()
--  answers true only for an ACTIVE President, Vice President or Developer;
--  the roster INSERT is refused to everyone else (RLS, as the caller); anon
--  cannot even call the permission check; and adding someone grants no
--  privileged role.
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
    when insufficient_privilege then
      perform set_config('role', 'none', true);
      return 'DENIED';
    when others then
      perform set_config('role', 'none', true);
      return 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
end $fn$;

do $test$
declare
  pre      uuid := gen_random_uuid();   -- president
  vp       uuid := gen_random_uuid();   -- vice president
  dev      uuid := gen_random_uuid();   -- developer
  tre      uuid := gen_random_uuid();   -- treasurer
  doc      uuid := gen_random_uuid();   -- documentation
  mem      uuid := gen_random_uuid();   -- member, no privileged role
  retired  uuid := gen_random_uuid();   -- vice president, now alumni
  outsider uuid := gen_random_uuid();   -- a login that is not on the roster
  new_p    uuid := gen_random_uuid();   -- logins to be added by each admin
  new_v    uuid := gen_random_uuid();
  new_d    uuid := gen_random_uuid();
  spare    uuid := gen_random_uuid();   -- a login nobody else may add
  c        record;
  got      text;
  lines    text[] := '{}';
  failures text[] := '{}';
  check_stmt constant text := 'select count(*) from (select 1 where can_add_members()) x';
  add_stmt   constant text := 'insert into members (id, full_name, role) values (%L, %L, ''Member'')';
begin
  insert into auth.users (id, email) values
    (pre, 'pre@onboarding.test'), (vp, 'vp@onboarding.test'), (dev, 'dev@onboarding.test'),
    (tre, 'tre@onboarding.test'), (doc, 'doc@onboarding.test'), (mem, 'mem@onboarding.test'),
    (retired, 'retired@onboarding.test'), (outsider, 'out@onboarding.test'),
    (new_p, 'new.p@onboarding.test'), (new_v, 'new.v@onboarding.test'),
    (new_d, 'new.d@onboarding.test'), (spare, 'spare@onboarding.test');
  insert into members (id, full_name, role, status) values
    (pre, 'Onb President', 'Team lead', 'active'), (vp, 'Onb Vice', 'Operations', 'active'),
    (dev, 'Onb Developer', 'Software', 'active'), (tre, 'Onb Treasurer', 'Finance', 'active'),
    (doc, 'Onb Docs', 'Documentation', 'active'), (mem, 'Onb Member', 'Chassis', 'active'),
    (retired, 'Onb Retired VP', 'Operations', 'alumni');
  insert into member_roles (member_id, role) values
    (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'),
    (tre, 'treasurer'), (doc, 'documentation'), (retired, 'vicepresident');

  for c in
    select * from (values
      ('president      may add members',        pre,      check_stmt, 'read', 'ALLOWED'),
      ('vice president may add members',        vp,       check_stmt, 'read', 'ALLOWED'),
      ('developer      may add members',        dev,      check_stmt, 'read', 'ALLOWED'),
      ('treasurer      may not add members',    tre,      check_stmt, 'read', 'DENIED'),
      ('documentation  may not add members',    doc,      check_stmt, 'read', 'DENIED'),
      ('member         may not add members',    mem,      check_stmt, 'read', 'DENIED'),
      ('retired VP     may not add members',    retired,  check_stmt, 'read', 'DENIED'),
      ('not on roster  may not add members',    outsider, check_stmt, 'read', 'DENIED'),
      ('anon           cannot call the check',  null,     check_stmt, 'read', 'DENIED'),

      ('president      adds a roster row',      pre,      format(add_stmt, new_p, 'New by P'),  'write', 'ALLOWED'),
      ('vice president adds a roster row',      vp,       format(add_stmt, new_v, 'New by VP'), 'write', 'ALLOWED'),
      ('developer      adds a roster row',      dev,      format(add_stmt, new_d, 'New by Dev'), 'write', 'ALLOWED'),
      ('treasurer      adds a roster row',      tre,      format(add_stmt, spare, 'Sneaky'),    'write', 'DENIED'),
      ('documentation  adds a roster row',      doc,      format(add_stmt, spare, 'Sneaky'),    'write', 'DENIED'),
      ('member         adds a roster row',      mem,      format(add_stmt, spare, 'Sneaky'),    'write', 'DENIED'),
      ('retired VP     adds a roster row',      retired,  format(add_stmt, spare, 'Sneaky'),    'write', 'DENIED'),
      ('not on roster  adds themselves',        outsider, format(add_stmt, outsider, 'Me'),     'write', 'DENIED'),
      ('anon           adds a roster row',      null,     format(add_stmt, spare, 'Sneaky'),    'write', 'DENIED')
    ) as t(label, who, stmt, kind, expected)
  loop
    got := pg_temp.attempt(c.who, c.stmt, c.kind);
    lines := lines || format('%s  %-42s expected %-7s got %s',
      case when got = c.expected then 'ok  ' else 'FAIL' end, c.label, c.expected, got);
    if got <> c.expected then
      failures := failures || format('%s: expected %s, got %s', c.label, c.expected, got);
    end if;
  end loop;

  -- Adding someone gives them no privileged role, whoever added them.
  if exists (select 1 from member_roles where member_id in (new_p, new_v, new_d)) then
    failures := failures || 'a newly added member holds a privileged role'::text;
    lines := lines || 'FAIL  a newly added member holds no privileged role'::text;
  else
    lines := lines || 'ok    a newly added member holds no privileged role'::text;
  end if;
  if exists (select 1 from members where id in (spare, outsider)) then
    failures := failures || 'a refused roster insert left a row behind'::text;
    lines := lines || 'FAIL  refused roster inserts left nothing behind'::text;
  else
    lines := lines || 'ok    refused roster inserts left nothing behind'::text;
  end if;

  if array_length(failures, 1) > 0 then
    raise exception E'MEMBER ONBOARDING CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'MEMBER ONBOARDING CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
