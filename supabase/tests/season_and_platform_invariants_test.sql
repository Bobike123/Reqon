-- =============================================================================
--  Season lifecycle + platform invariants.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates happens inside
--  one block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Run it with psql (scripts/verify_db.sh does) after ALL migrations. The
--  result arrives as an "error" message that begins with
--      SEASON/PLATFORM CHECKS PASSED   or   SEASON/PLATFORM CHECKS FAILED
--  That "error" is the rollback doing its job.
--
--  What it proves:
--    * set_current_season() leaves EXACTLY one current season, and it is the
--      one asked for — the app's season resolution (v_current_season) depends
--      on that, and a zero-current state reads as "every list is empty"
--    * switching to a season that does not exist is refused and leaves the
--      previous current season in place (no half-applied switch)
--    * the seasons_one_current index refuses a second current season even to a
--      caller that bypasses the RPC
--    * a signed-out caller cannot resolve the current season at all
--    * the realtime publication contains exactly the tables the client
--      subscribes to (src/data/useRealtime*.ts) — no more, no fewer.
--    * every SECURITY DEFINER function in `public` pins its search_path
--    * the transactional RPCs are executable by signed-in users only
--    * every table in `public` has row-level security enabled
-- =============================================================================

create or replace function pg_temp.as_user(who uuid) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
end $fn$;

create or replace function pg_temp.as_anon() returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $fn$;

create or replace function pg_temp.as_owner() returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $fn$;

create or replace function pg_temp.note(
  inout lines text[], inout failures text[], label text, ok boolean, detail text default null
) returns record language plpgsql as $fn$
begin
  lines := lines || format('%s  %s%s', case when ok then 'ok  ' else 'FAIL' end, label,
    case when detail is null then '' else ' — ' || detail end);
  if not ok then
    failures := failures || format('%s%s', label, case when detail is null then '' else ': ' || detail end);
  end if;
end $fn$;

do $test$
declare
  pre      uuid := gen_random_uuid();
  season_a uuid;
  season_b uuid;
  n        int;
  txt      text;
  lines    text[] := '{}';
  failures text[] := '{}';
begin
  -- ============================================================ catalog checks
  -- Run as the owner: these read system catalogs, not application rows.

  -- Realtime publication: exactly the fifteen subscribed tables
  -- (proposal_comments and task_dependencies added by Phase 3, spec_readiness by Phase 4,
  -- task_attachments by Ultraplan Phase 1 — its subscription hook arrives with the UI in Ultraplan Phase 3).
  select string_agg(tablename, ',' order by tablename) into txt
    from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public';
  select * into lines, failures from pg_temp.note(lines, failures,
    'realtime publication holds exactly the fifteen subscribed tables',
    txt = 'clause_status,department_members,milestone_sections,milestones,proposal_comments,proposal_requirements,spec_measurements,spec_readiness,specs,subteams,task_attachments,task_dependencies,task_proposals,task_requirements,tasks',
    format('found: %s', coalesce(txt, '(none)')));

  -- SECURITY DEFINER without a pinned search_path can be hijacked by a
  -- shadowing object in a schema the caller controls.
  select string_agg(p.proname, ', ' order by p.proname) into txt
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.prosecdef
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'
     );
  select * into lines, failures from pg_temp.note(lines, failures,
    'every SECURITY DEFINER function in public pins search_path', txt is null,
    format('unpinned: %s', txt));

  -- The transactional RPCs: signed-in only.
  select string_agg(fn, ', ') into txt
    from unnest(array[
      'public.promote_proposal(uuid,uuid,uuid,date)',
      'public.submit_proposal(uuid,text,text,date,text,text[],text,task_priority,uuid)',
      'public.review_proposal(uuid,text,integer,text)',
      'public.set_proposal_requirements(uuid,text[],integer)',
      'public.set_proposal_department(uuid,text,text,integer)',
      'public.add_proposal_comment(uuid,text)',
      'public.revise_proposal(uuid,integer,jsonb,text)',
      'public.request_proposal_changes(uuid,integer,text)',
      'public.approve_proposal(uuid,integer,text)',
      'public.approve_and_promote(uuid,uuid,integer,text,uuid,date)',
      'public.set_proposal_star(uuid,boolean)',
      'public.link_task_requirement(uuid,text)',
      'public.unlink_task_requirement(uuid,text)',
      'public.apply_role_plan(jsonb)',
      'public.set_current_season(uuid)'
    ]) as fn
   where has_function_privilege('anon', fn, 'execute');
  select * into lines, failures from pg_temp.note(lines, failures,
    'anon cannot execute the transactional RPCs', txt is null, format('executable by anon: %s', txt));

  select string_agg(fn, ', ') into txt
    from unnest(array[
      'public.promote_proposal(uuid,uuid,uuid,date)',
      'public.submit_proposal(uuid,text,text,date,text,text[],text,task_priority,uuid)',
      'public.review_proposal(uuid,text,integer,text)',
      'public.set_proposal_requirements(uuid,text[],integer)',
      'public.set_proposal_department(uuid,text,text,integer)',
      'public.add_proposal_comment(uuid,text)',
      'public.revise_proposal(uuid,integer,jsonb,text)',
      'public.request_proposal_changes(uuid,integer,text)',
      'public.approve_proposal(uuid,integer,text)',
      'public.approve_and_promote(uuid,uuid,integer,text,uuid,date)',
      'public.set_proposal_star(uuid,boolean)',
      'public.link_task_requirement(uuid,text)',
      'public.unlink_task_requirement(uuid,text)',
      'public.apply_role_plan(jsonb)',
      'public.set_current_season(uuid)'
    ]) as fn
   where not has_function_privilege('authenticated', fn, 'execute');
  select * into lines, failures from pg_temp.note(lines, failures,
    'authenticated can execute the transactional RPCs', txt is null, format('not executable: %s', txt));

  -- Row-level security is the authorization boundary; a table without it is
  -- open to every signed-in user through the Data API.
  select string_agg(c.relname, ', ' order by c.relname) into txt
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  select * into lines, failures from pg_temp.note(lines, failures,
    'every public table has row-level security enabled', txt is null, format('without RLS: %s', txt));

  -- ============================================================ fixtures
  insert into auth.users (id, email) values (pre, 'sp-pre@roles.test');
  insert into members (id, full_name, role) values (pre, 'SP President', 'President');
  insert into member_roles (member_id, role) values (pre, 'president');
  insert into seasons (label, is_current) values ('SP-TEST-A', false) returning id into season_a;
  insert into seasons (label, is_current) values ('SP-TEST-B', false) returning id into season_b;

  -- ============================================================ season switch
  perform pg_temp.as_user(pre);
  perform set_current_season(season_a);
  perform pg_temp.as_owner();
  select count(*) into n from seasons where is_current;
  select * into lines, failures from pg_temp.note(lines, failures,
    'after a switch exactly one season is current', n = 1, format('%s current', n));
  perform 1 from seasons where id = season_a and is_current;
  select * into lines, failures from pg_temp.note(lines, failures,
    'the current season is the one asked for', found);

  perform pg_temp.as_user(pre);
  perform set_current_season(season_b);
  perform pg_temp.as_owner();
  select count(*) into n from seasons where is_current;
  select * into lines, failures from pg_temp.note(lines, failures,
    'switching again still leaves exactly one current season', n = 1, format('%s current', n));

  perform pg_temp.as_user(pre);
  select id::text into txt from v_current_season;
  select * into lines, failures from pg_temp.note(lines, failures,
    'v_current_season resolves the switched-to season for a signed-in member',
    txt = season_b::text, format('got %s', coalesce(txt, '(no row)')));

  -- A switch to a season that does not exist: refused, nothing moves.
  begin
    perform set_current_season(gen_random_uuid());
    select * into lines, failures from pg_temp.note(lines, failures,
      'switching to a missing season is refused', false, 'no exception was raised');
  exception
    when others then
      select * into lines, failures from pg_temp.note(lines, failures,
        'switching to a missing season is refused', sqlstate = '23503', format('got %s %s', sqlstate, sqlerrm));
  end;
  perform pg_temp.as_owner();
  perform 1 from seasons where id = season_b and is_current;
  select * into lines, failures from pg_temp.note(lines, failures,
    'the refused switch left the previous current season in place', found);

  -- The index, not the RPC, is the last line: a second current season is
  -- impossible even for a caller that bypasses set_current_season().
  begin
    update seasons set is_current = true where id = season_a;
    select * into lines, failures from pg_temp.note(lines, failures,
      'a second current season is refused by seasons_one_current', false, 'no exception was raised');
  exception
    when unique_violation then
      select * into lines, failures from pg_temp.note(lines, failures,
        'a second current season is refused by seasons_one_current', true);
    when others then
      select * into lines, failures from pg_temp.note(lines, failures,
        'a second current season is refused by seasons_one_current', false, format('wrong error: %s %s', sqlstate, sqlerrm));
  end;

  -- Signed out: the season (and so every season-scoped screen) is invisible.
  perform pg_temp.as_anon();
  select count(*) into n from v_current_season;
  select * into lines, failures from pg_temp.note(lines, failures,
    'a signed-out caller cannot resolve the current season', n = 0, format('%s rows visible', n));
  perform pg_temp.as_owner();

  -- ------------------------------------------------------------------- verdict
  if array_length(failures, 1) > 0 then
    raise exception E'SEASON/PLATFORM CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'SEASON/PLATFORM CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
