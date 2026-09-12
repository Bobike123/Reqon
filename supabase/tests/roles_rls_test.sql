-- =============================================================================
--  Role and RLS checks for Reqon.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates (test users, a
--  test season, a finance probe table) happens inside one block that always
--  ends by raising an exception, so Postgres rolls every change back. Nothing
--  is left behind, pass or fail.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations. The
--  result arrives as an "error" message that begins with
--      ROLE CHECKS PASSED   every check behaved as expected, or
--      ROLE CHECKS FAILED   followed by the checks that did not.
--  That "error" is the rollback doing its job.
--
--  How it tests: for each check it becomes the `authenticated` role with a
--  given user id — exactly what the Data API does for a signed-in browser —
--  runs one statement, and records whether the DATABASE allowed it. No check
--  relies on what the UI shows.
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
      execute stmt into n;          -- a count(*): how many rows are visible
    else
      execute stmt;                 -- a write: how many rows it touched
      get diagnostics n = row_count;
    end if;

    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return case when n > 0 then 'ALLOWED' else 'DENIED' end;
  exception
    -- Permission errors and RLS rejections are what "DENIED" means. Anything
    -- else is a broken check, reported as such rather than counted as a pass.
    when insufficient_privilege then return 'DENIED';
    when others then return 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
end $fn$;

do $test$
declare
  dev      uuid := gen_random_uuid();   -- developer
  tre      uuid := gen_random_uuid();   -- treasurer
  pre      uuid := gen_random_uuid();   -- president
  vp       uuid := gen_random_uuid();   -- vice-president
  mem      uuid := gen_random_uuid();   -- ordinary member, no privileged role
  outsider uuid := gen_random_uuid();   -- has a login, not on the roster
  recruit  uuid := gen_random_uuid();   -- login to be linked to the roster
  spare    uuid := gen_random_uuid();   -- login nobody is allowed to link
  spare2   uuid := gen_random_uuid();   -- login only an admin may link
  season   uuid;
  c        record;
  got      text;
  lines    text[] := '{}';
  failures text[] := '{}';
  presidents int;
begin
  -- ---------------------------------------------------------------- people
  insert into auth.users (id, email) values
    (dev, 'dev@roles.test'), (tre, 'tre@roles.test'), (pre, 'pre@roles.test'),
    (vp, 'vp@roles.test'), (mem, 'mem@roles.test'), (outsider, 'out@roles.test'),
    (recruit, 'new@roles.test'), (spare, 'spare@roles.test'), (spare2, 'spare2@roles.test');
  insert into members (id, full_name, role) values
    (dev, 'Test Developer', 'Software'), (tre, 'Test Treasurer', 'Treasurer'),
    (pre, 'Test President', 'President'), (vp, 'Test Vice', 'Vice-president'),
    (mem, 'Test Member', 'Chassis');
  insert into member_roles (member_id, role) values
    (dev, 'developer'), (tre, 'treasurer'), (pre, 'president'), (vp, 'vicepresident');

  -- ------------------------------------------------------ things to act on
  insert into seasons (label, is_current) values ('ROLES-TEST', false) returning id into season;
  insert into subteams (key, name, book_section) values ('ZZTEST', 'Test subsystem', 'Z');
  insert into clauses (clause_key, printed_ref, section, article, body, obligation, criticality)
    values ('ZZ.1', 'ZZ.1', 'Z', 1, 'Test rule', 'info', 'info');
  insert into milestones (key, season_id, ordinal, name) values ('ZZ-MS', season, 99, 'Test milestone');
  insert into tasks (season_id, title) values (season, 'Test task');

  -- A finance table secured with exactly the template from
  -- 20260105000000_privileged_roles.sql.
  create table public.zz_finance_probe (id serial primary key, amount numeric not null, note text);
  alter table public.zz_finance_probe enable row level security;
  create policy finance_read on public.zz_finance_probe for select to authenticated
    using (can_view_finances());
  create policy finance_insert on public.zz_finance_probe for insert to authenticated
    with check (can_manage_finances());
  create policy finance_update on public.zz_finance_probe for update to authenticated
    using (can_manage_finances()) with check (can_manage_finances());
  create policy finance_delete on public.zz_finance_probe for delete to authenticated
    using (can_manage_finances());
  grant select, insert, update, delete on public.zz_finance_probe to anon, authenticated;
  grant usage, select on sequence public.zz_finance_probe_id_seq to anon, authenticated;
  insert into public.zz_finance_probe (amount, note) values (4550, 'Entry fee');

  create temp table checks (n serial, label text, who uuid, stmt text, kind text, expected text) on commit drop;
  insert into checks (label, who, stmt, kind, expected) values
    -- ============================== FINANCE ==============================
    -- The developer has full access (20260107). Its write checks act on a row
    -- of their own, so the Entry fee row stays for the treasurer's checks.
    ('developer     SELECT finance',          dev, 'select count(*) from zz_finance_probe', 'read', 'ALLOWED'),
    ('developer     INSERT finance',          dev, 'insert into zz_finance_probe (amount, note) values (7, ''dev row'')', 'write', 'ALLOWED'),
    ('developer     UPDATE finance',          dev, 'update zz_finance_probe set amount = 8 where note = ''dev row''', 'write', 'ALLOWED'),
    ('developer     DELETE finance',          dev, 'delete from zz_finance_probe where note = ''dev row''', 'write', 'ALLOWED'),
    ('president     SELECT finance',          pre, 'select count(*) from zz_finance_probe', 'read', 'ALLOWED'),
    ('president     UPDATE finance',          pre, 'update zz_finance_probe set amount = 1', 'write', 'DENIED'),
    ('president     INSERT finance',          pre, 'insert into zz_finance_probe (amount) values (1)', 'write', 'DENIED'),
    ('vicepresident SELECT finance',          vp,  'select count(*) from zz_finance_probe', 'read', 'ALLOWED'),
    ('vicepresident UPDATE finance',          vp,  'update zz_finance_probe set amount = 1', 'write', 'DENIED'),
    ('vicepresident INSERT finance',          vp,  'insert into zz_finance_probe (amount) values (1)', 'write', 'DENIED'),
    ('treasurer     SELECT finance',          tre, 'select count(*) from zz_finance_probe', 'read', 'ALLOWED'),
    ('treasurer     INSERT finance',          tre, 'insert into zz_finance_probe (amount, note) values (45, ''Admin fee'')', 'write', 'ALLOWED'),
    ('treasurer     UPDATE finance',          tre, 'update zz_finance_probe set amount = 4550 where note = ''Entry fee''', 'write', 'ALLOWED'),
    ('treasurer     DELETE finance',          tre, 'delete from zz_finance_probe where note = ''Admin fee''', 'write', 'ALLOWED'),
    ('member        SELECT finance',          mem, 'select count(*) from zz_finance_probe', 'read', 'DENIED'),
    ('member        INSERT finance',          mem, 'insert into zz_finance_probe (amount) values (1)', 'write', 'DENIED'),
    ('off-roster    SELECT finance',          outsider, 'select count(*) from zz_finance_probe', 'read', 'DENIED'),
    ('signed out    SELECT finance',          null, 'select count(*) from zz_finance_probe', 'read', 'DENIED'),

    -- ========================= ROLE MANAGEMENT ===========================
    ('president     assigns treasurer to member', pre, format('insert into member_roles (member_id, role) values (%L, ''treasurer'')', mem), 'write', 'ALLOWED'),
    ('  -> that member may now write finance',    mem, 'insert into zz_finance_probe (amount, note) values (1, ''granted'')', 'write', 'ALLOWED'),
    ('president     removes that role again',     pre, format('delete from member_roles where member_id = %L and role = ''treasurer''', mem), 'write', 'ALLOWED'),
    ('  -> that member may no longer write it',   mem, 'insert into zz_finance_probe (amount) values (1)', 'write', 'DENIED'),
    ('vicepresident assigns a role',              vp,  format('insert into member_roles (member_id, role) values (%L, ''developer'')', mem), 'write', 'DENIED'),
    ('vicepresident makes self president',        vp,  format('insert into member_roles (member_id, role) values (%L, ''president'')', vp), 'write', 'DENIED'),
    ('vicepresident removes the president',       vp,  format('delete from member_roles where member_id = %L and role = ''president''', pre), 'write', 'DENIED'),
    ('developer     makes someone president',     dev, format('insert into member_roles (member_id, role) values (%L, ''president'')', mem), 'write', 'ALLOWED'),
    ('  -> and takes it back',                    dev, format('delete from member_roles where member_id = %L and role = ''president''', mem), 'write', 'ALLOWED'),
    ('developer     assigns a role to someone',   dev, format('insert into member_roles (member_id, role) values (%L, ''treasurer'')', mem), 'write', 'ALLOWED'),
    ('  -> and takes it away again',              dev, format('delete from member_roles where member_id = %L and role = ''treasurer''', mem), 'write', 'ALLOWED'),
    ('developer     cannot remove the last president', dev, format('delete from member_roles where member_id = %L and role = ''president''', pre), 'write', 'DENIED'),
    ('treasurer     makes self president',        tre, format('insert into member_roles (member_id, role) values (%L, ''president'')', tre), 'write', 'DENIED'),
    ('treasurer     assigns a role to someone',   tre, format('insert into member_roles (member_id, role) values (%L, ''vicepresident'')', mem), 'write', 'DENIED'),
    ('member        makes self president',        mem, format('insert into member_roles (member_id, role) values (%L, ''president'')', mem), 'write', 'DENIED'),
    ('off-roster    makes self president',        outsider, format('insert into member_roles (member_id, role) values (%L, ''president'')', outsider), 'write', 'DENIED'),
    ('signed out    grants a role',               null, format('insert into member_roles (member_id, role) values (%L, ''president'')', mem), 'write', 'DENIED'),
    ('president     forges assigned_by',          pre, format('insert into member_roles (member_id, role, assigned_by) values (%L, ''developer'', %L)', mem, vp), 'write', 'DENIED'),
    ('nobody edits a role in place (president)',  pre, format('update member_roles set role = ''developer'' where member_id = %L', vp), 'write', 'DENIED'),
    ('developer     sees member roles',           dev, 'select count(*) from member_roles', 'read', 'ALLOWED'),
    ('member        sees member roles',           mem, 'select count(*) from member_roles', 'read', 'ALLOWED'),
    ('off-roster    sees member roles',           outsider, 'select count(*) from member_roles', 'read', 'DENIED'),
    ('signed out    sees member roles',           null, 'select count(*) from member_roles', 'read', 'DENIED'),

    -- ===================== THE OLD ESCALATION IS GONE ====================
    ('member        sets own job title "President"', mem, format('update members set role = ''President'' where id = %L', mem), 'write', 'ALLOWED'),
    ('  -> a job title grants nothing',           mem, 'update subteams set name = ''x'' where key = ''ZZTEST''', 'write', 'DENIED'),

    -- ========================= ADMINISTRATION ============================
    ('president     edits a subsystem',           pre, 'update subteams set description = ''p'' where key = ''ZZTEST''', 'write', 'ALLOWED'),
    ('vicepresident edits a subsystem',           vp,  'update subteams set description = ''v'' where key = ''ZZTEST''', 'write', 'ALLOWED'),
    ('developer     edits a subsystem',           dev, 'update subteams set description = ''d'' where key = ''ZZTEST''', 'write', 'ALLOWED'),
    ('treasurer     edits a subsystem',           tre, 'update subteams set description = ''t'' where key = ''ZZTEST''', 'write', 'DENIED'),
    ('member        edits a subsystem',           mem, 'update subteams set description = ''m'' where key = ''ZZTEST''', 'write', 'DENIED'),
    ('vicepresident edits the rulebook',          vp,  'update clauses set body = ''edited'' where clause_key = ''ZZ.1''', 'write', 'ALLOWED'),
    ('developer     edits the rulebook',          dev, 'update clauses set body = ''edited'' where clause_key = ''ZZ.1''', 'write', 'ALLOWED'),
    ('treasurer     edits the rulebook',          tre, 'update clauses set body = ''edited'' where clause_key = ''ZZ.1''', 'write', 'DENIED'),
    ('vicepresident links a login to the roster', vp,  format('insert into members (id, full_name) values (%L, ''New Recruit'')', recruit), 'write', 'ALLOWED'),
    ('developer     links a login to the roster', dev, format('insert into members (id, full_name) values (%L, ''Dev Recruit'')', spare2), 'write', 'ALLOWED'),
    ('treasurer     links a login to the roster', tre, format('insert into members (id, full_name) values (%L, ''Nope'')', spare), 'write', 'DENIED'),
    ('member        links a login to the roster', mem, format('insert into members (id, full_name) values (%L, ''Nope'')', spare), 'write', 'DENIED'),
    ('vicepresident edits another member',        vp,  format('update members set phone = ''1'' where id = %L', mem), 'write', 'ALLOWED'),
    ('developer     edits another member',        dev, format('update members set phone = ''1'' where id = %L', mem), 'write', 'ALLOWED'),
    ('member        edits another member',        mem, format('update members set phone = ''1'' where id = %L', tre), 'write', 'DENIED'),
    ('member        edits own details',           mem, format('update members set phone = ''2'' where id = %L', mem), 'write', 'ALLOWED'),
    ('president     starts a season',             pre, 'insert into seasons (label) values (''ROLES-TEST-2'')', 'write', 'ALLOWED'),
    ('member        starts a season',             mem, 'insert into seasons (label) values (''ROLES-TEST-3'')', 'write', 'DENIED'),
    ('developer     starts a season',             dev, 'insert into seasons (label) values (''ROLES-TEST-4'')', 'write', 'ALLOWED'),
    ('member        flips is_current directly',   mem, format('update seasons set is_current = false where id = %L', season), 'write', 'DENIED'),
    ('vicepresident switches the season',         vp,  format('select set_current_season(%L)', season), 'write', 'ALLOWED'),
    ('president     switches the season',         pre, format('select set_current_season(%L)', season), 'write', 'ALLOWED'),
    ('developer     switches the season',         dev, format('select set_current_season(%L)', season), 'write', 'ALLOWED'),
    ('treasurer     switches the season',         tre, format('select set_current_season(%L)', season), 'write', 'DENIED'),
    ('member        switches the season',         mem, format('select set_current_season(%L)', season), 'write', 'DENIED'),
    ('vicepresident sets milestone points',       vp,  'update milestones set max_points = 10 where key = ''ZZ-MS''', 'write', 'ALLOWED'),
    ('member        sets milestone points',       mem, 'update milestones set max_points = 10 where key = ''ZZ-MS''', 'write', 'DENIED'),
    ('developer     sets milestone points',       dev, 'update milestones set max_points = 10 where key = ''ZZ-MS''', 'write', 'ALLOWED'),

    -- ================== EVERYDAY WORK STILL WORKS =========================
    ('member        adds a task',                 mem, format('insert into tasks (season_id, title) values (%L, ''m'')', season), 'write', 'ALLOWED'),
    ('treasurer     adds a task',                 tre, format('insert into tasks (season_id, title) values (%L, ''t'')', season), 'write', 'ALLOWED'),
    ('developer     adds a task',                 dev, format('insert into tasks (season_id, title) values (%L, ''d'')', season), 'write', 'ALLOWED'),

    -- ============ THE DEVELOPER SEES (AND DOES) EVERYTHING ================
    ('developer     reads members',               dev, 'select count(*) from members', 'read', 'ALLOWED'),
    ('developer     reads the rulebook',          dev, 'select count(*) from clauses', 'read', 'ALLOWED'),
    ('developer     reads tasks',                 dev, 'select count(*) from tasks', 'read', 'ALLOWED'),
    ('developer     reads seasons',               dev, 'select count(*) from seasons', 'read', 'ALLOWED'),
    ('developer     reads milestones',            dev, 'select count(*) from milestones', 'read', 'ALLOWED'),
    ('developer     reads subsystems',            dev, 'select count(*) from subteams', 'read', 'ALLOWED'),
    ('off-roster    reads tasks',                 outsider, 'select count(*) from tasks', 'read', 'DENIED'),
    ('off-roster    reads members',               outsider, 'select count(*) from members', 'read', 'DENIED');

  for c in select * from checks order by n loop
    got := pg_temp.attempt(c.who, c.stmt, c.kind);
    lines := lines || format('%s  %-46s expected %-7s got %s',
      case when got = c.expected then 'ok  ' else 'FAIL' end, c.label, c.expected, got);
    if got <> c.expected then
      failures := failures || format('%s: expected %s, got %s', c.label, c.expected, got);
    end if;
  end loop;

  -- Last: the club can never be left without a president. With only the test
  -- president holding the role this must be refused; if the real project
  -- already has a president of its own, removing the test one is fine.
  select count(*) into presidents from member_roles where role = 'president';
  got := pg_temp.attempt(pre, format('delete from member_roles where member_id = %L and role = ''president''', pre), 'write');
  lines := lines || format('%s  %-46s expected %-7s got %s',
    case when got = (case when presidents = 1 then 'DENIED' else 'ALLOWED' end) then 'ok  ' else 'FAIL' end,
    'president     removes the last president', case when presidents = 1 then 'DENIED' else 'ALLOWED' end, got);
  if got <> (case when presidents = 1 then 'DENIED' else 'ALLOWED' end) then
    failures := failures || format('last-president guard: got %s', got);
  end if;

  if array_length(failures, 1) > 0 then
    raise exception E'ROLE CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'ROLE CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
