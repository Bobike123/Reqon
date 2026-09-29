-- =============================================================================
--  Phase 14 independent final audit: regression checks for findings F14-01 and
--  F14-02 (docs/redesign/reviews/phase-14.md), written as REAL authenticated
--  sessions, never as the postgres owner. Everything happens in one block that
--  ends by raising an exception, so every row rolls back.
--      PHASE FOURTEEN CHECKS PASSED   or   PHASE FOURTEEN CHECKS FAILED
-- =============================================================================

create or replace function pg_temp.val(who uuid, stmt text) returns text
language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt into r;
  exception when others then
    r := 'E:' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $fn$;

create temp table results (n serial, label text, ok boolean, detail text);
create or replace function pg_temp.chk(label text, ok boolean, detail text default null) returns void
language plpgsql as $fn$
begin
  insert into results (label, ok, detail) values (label, coalesce(ok, false), detail);
end $fn$;

do $test$
declare
  pre uuid := gen_random_uuid();   -- President (meeting_template writer)
  hd  uuid := gen_random_uuid();   -- Head of dept
  mem uuid := gen_random_uuid();   -- ordinary member
  other uuid := gen_random_uuid(); -- the member someone tries to blame
  sX uuid; dept text; clause text;
  t_open uuid; t_done uuid; m1 uuid;
  q text;
  nfail int; ntotal int;
begin
  insert into auth.users (id, email) select x.i, x.e from (values
    (pre,'p14-pre@t.test'),(hd,'p14-hd@t.test'),(mem,'p14-mem@t.test'),(other,'p14-other@t.test')) as x(i, e);
  insert into members (id, full_name, role, status) values
    (pre,'P14 Pre','Lead','active'),(hd,'P14 Head','Ch','active'),(mem,'P14 Mem','Ch','active'),(other,'P14 Other','Ch','active');
  insert into member_roles (member_id, role) values (pre,'president');

  insert into seasons (label, is_current) values ('P14-X', false) returning id into sX;
  select key into dept from subteams where archived_at is null order by sort_order, key limit 1;
  update subteams set lead_id = hd where key = dept;
  select clause_key into clause from clauses order by clause_key limit 1;

  insert into tasks (season_id, title, subteam_key, state) values (sX, 'P14 open work', dept, 'wip') returning id into t_open;
  insert into tasks (season_id, title, subteam_key, state) values (sX, 'P14 finished work', dept, 'done') returning id into t_done;

  -- ======================= F14-01: archive provenance =======================
  q := pg_temp.val(hd, format('select archive_reason from archive_task(%L, ''auto_done_24h'')', t_open));
  perform pg_temp.chk('F14-01a a Head cannot record a manual archive as automatic (refused, 22023)', q = 'E:22023', q);
  perform pg_temp.chk('F14-01b the refused call left the task unarchived',
    (select archived_at is null from tasks where id = t_open));

  q := pg_temp.val(hd, format('select state::text || ''|'' || archive_reason from archive_task(%L, ''manual'')', t_open));
  perform pg_temp.chk('F14-01c the same Head archives unfinished work, recorded as manual and unfinished', q = 'wip|manual', q);
  perform pg_temp.chk('F14-01d archived_by is the Head, not a system actor',
    (select archived_by = hd from tasks where id = t_open));

  q := pg_temp.val(hd, format('select archive_reason from archive_task(%L)', t_done));
  perform pg_temp.chk('F14-01e the default reason is manual, even for Done work', q = 'manual', q);

  q := pg_temp.val(mem, format('select archive_reason from archive_task(%L, ''manual'')', t_open));
  perform pg_temp.chk('F14-01f archiving an already archived task is refused (22023), not re-stamped', q = 'E:22023', q);

  q := pg_temp.val(hd, format('select state::text || ''|'' || coalesce(archive_reason, ''-'') from restore_task(%L)', t_done));
  perform pg_temp.chk('F14-01g restoring Done work still reopens it to todo with no archive reason', q = 'todo|-', q);

  q := pg_temp.val(mem, format('select state::text from restore_task(%L)', t_open));
  perform pg_temp.chk('F14-01h a member still cannot restore (42501)', q = 'E:42501', q);

  -- The scheduler keeps its own reason (it never goes through archive_task).
  -- completed_at cannot be backdated by an UPDATE (guard_task_edit), so the
  -- deterministic seam is run 25 hours in the future instead.
  update tasks set state = 'done' where id = t_done;
  perform 1 from archive_stale_done_tasks_at(now() + interval '25 hours') where id = t_done;
  perform pg_temp.chk('F14-01i the sweep still records auto_done_24h with no archived_by',
    (select archive_reason = 'auto_done_24h' and archived_by is null from tasks where id = t_done));

  -- ======================= F14-02: actor attribution =======================
  q := pg_temp.val(mem, format(
    'insert into clause_status (season_id, clause_key, state, updated_by) values (%L, %L, ''wip'', %L) returning updated_by::text',
    sX, clause, other));
  perform pg_temp.chk('F14-02a clause_status insert naming someone else is stamped with the writer', q = mem::text, q);

  q := pg_temp.val(mem, format(
    'update clause_status set state = ''compliant'', updated_by = %L where season_id = %L and clause_key = %L returning updated_by::text',
    other, sX, clause));
  perform pg_temp.chk('F14-02b clause_status update naming someone else is stamped with the writer', q = mem::text, q);

  q := pg_temp.val(mem, format(
    'insert into handover_notes (season_id, subteam_key, body, updated_by) values (%L, %L, ''note'', %L) returning updated_by::text',
    sX, dept, other));
  perform pg_temp.chk('F14-02c handover note naming someone else is stamped with the writer', q = mem::text, q);

  q := pg_temp.val(pre, format(
    'insert into meetings (season_id, held_on, title, created_by) values (%L, ''2026-10-01'', ''P14 meeting'', %L) returning id::text',
    sX, other));
  m1 := case when q like 'E:%' then null else q::uuid end;
  perform pg_temp.chk('F14-02d a meeting created while naming someone else records the real creator',
    m1 is not null and (select created_by = pre from meetings where id = m1), q);

  q := pg_temp.val(pre, format('update meetings set title = ''renamed'', created_by = %L where id = %L returning created_by::text', other, m1));
  perform pg_temp.chk('F14-02e a meeting''s creator cannot be rewritten by an update', q = pre::text, q);

  q := pg_temp.val(pre, format('update meeting_template set body = body, updated_by = %L where id returning updated_by::text', other));
  perform pg_temp.chk('F14-02f the agenda template is stamped with the President who saved it', q = pre::text, q);

  -- Service-role/maintenance writes (no signed-in user) keep what they supply.
  update clause_status set updated_by = other where season_id = sX and clause_key = clause;
  perform pg_temp.chk('F14-02g an owner/maintenance write with no session keeps the supplied actor',
    (select updated_by = other from clause_status where season_id = sX and clause_key = clause));

  -- ============================ verdict ============================
  select count(*) filter (where not ok), count(*) into nfail, ntotal from results;
  if nfail > 0 then
    raise exception E'PHASE FOURTEEN CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      nfail, ntotal,
      (select string_agg(label || coalesce(': ' || detail, ''), E'\n' order by n) from results where not ok),
      (select string_agg(case when ok then 'ok  ' else 'FAIL' end || '  ' || label, E'\n' order by n) from results);
  end if;
  raise exception E'PHASE FOURTEEN CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    ntotal, (select string_agg('ok    ' || label, E'\n' order by n) from results);
end
$test$;
