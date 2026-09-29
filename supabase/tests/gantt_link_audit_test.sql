-- =============================================================================
--  Gantt linkage (20260121000000_gantt_link_audit.sql and the rules it audits):
--  who may link, unlink and relink a task, that a relink is atomic or refused,
--  that season and archive rules hold, and that every link change and every
--  milestone date change leaves an audit row. Real authenticated sessions.
--  SAFE TO RUN AGAINST THE REAL PROJECT: everything happens in one block that
--  ends by raising an exception, so every row rolls back.
--      GANTT LINK CHECKS PASSED   or   GANTT LINK CHECKS FAILED
-- =============================================================================

create or replace function pg_temp.act(who uuid, stmt text) returns text
language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt;
    r := 'ok';
  exception when others then
    r := sqlstate;
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
  vp  uuid := gen_random_uuid();   -- Vice President
  own uuid := gen_random_uuid();   -- owner of the task under test
  hdA uuid := gen_random_uuid();   -- Head of department A
  hdB uuid := gen_random_uuid();   -- Head of department B
  mem uuid := gen_random_uuid();   -- an unrelated member
  sA uuid; sB uuid; dA text; dB text;
  secA1 uuid; secA2 uuid; secB1 uuid;
  t uuid; tReq uuid; tArch uuid; clause text;
  q text; n0 int; n1 int;
  nfail int; ntotal int;
  ev jsonb;
begin
  insert into auth.users (id, email) select x.i, x.e from (values
    (vp,'gl-vp@t.test'),(own,'gl-own@t.test'),(hdA,'gl-ha@t.test'),(hdB,'gl-hb@t.test'),(mem,'gl-mem@t.test')) as x(i, e);
  insert into members (id, full_name, role, status) values
    (vp,'GL VP','Lead','active'),(own,'GL Own','Ch','active'),(hdA,'GL HeadA','Ch','active'),
    (hdB,'GL HeadB','Ch','active'),(mem,'GL Mem','Ch','active');
  insert into member_roles (member_id, role) values (vp,'vicepresident');

  select key into dA from subteams where archived_at is null order by sort_order, key limit 1;
  select key into dB from subteams where archived_at is null and key <> dA order by sort_order, key limit 1;
  update subteams set lead_id = hdA where key = dA;
  update subteams set lead_id = hdB where key = dB;

  insert into seasons (label, is_current) values ('GL-A', false) returning id into sA;
  insert into seasons (label, is_current) values ('GL-B', false) returning id into sB;
  insert into milestones (key, season_id, ordinal, name, opens_on, due_on) values
    ('GL-A1', sA, 1, 'A one', '2026-11-01', '2026-11-30'),
    ('GL-A2', sA, 2, 'A two', null, '2027-02-28'),
    ('GL-B1', sB, 1, 'B one', null, null);
  insert into milestone_sections (milestone_key, ordinal, name) values ('GL-A1', 1, 'Sec A1') returning id into secA1;
  insert into milestone_sections (milestone_key, ordinal, name) values ('GL-A2', 1, 'Sec A2') returning id into secA2;
  insert into milestone_sections (milestone_key, ordinal, name) values ('GL-B1', 1, 'Sec B1') returning id into secB1;
  select clause_key into clause from clauses order by clause_key limit 1;

  insert into tasks (season_id, title, owner_id, subteam_key, due_date) values (sA, 'GL task', own, dA, '2026-11-20') returning id into t;

  -- ----------------------------------------------------- owner links a task
  q := pg_temp.act(own, format('update tasks set milestone_key = %L, section_id = %L where id = %L', 'GL-A1', secA1, t));
  perform pg_temp.chk('G1 the owner links their own task to a section (milestone and section together)',
    q = 'ok' and (select section_id from tasks where id = t) = secA1 and (select milestone_key from tasks where id = t) = 'GL-A1', q);
  perform pg_temp.chk('G2 a milestone_changed event was written, attributed to the owner',
    (select count(*) from activity where entity = 'task' and entity_id = t::text and action = 'milestone_changed'
       and actor_id = own and detail ->> 'from' is null and detail ->> 'to' = 'GL-A1') = 1);
  perform pg_temp.chk('G3 a section_linked event was written, carrying the section and milestone',
    (select count(*) from activity where entity = 'task' and entity_id = t::text and action = 'section_linked'
       and actor_id = own and detail ->> 'to' = secA1::text and detail ->> 'milestone' = 'GL-A1') = 1);

  -- --------------------------------------------- unlinking keeps the milestone
  q := pg_temp.act(own, format('update tasks set section_id = null where id = %L', t));
  perform pg_temp.chk('G4 unlinking the section keeps the milestone (the task becomes unsectioned work)',
    q = 'ok' and (select section_id from tasks where id = t) is null and (select milestone_key from tasks where id = t) = 'GL-A1', q);
  perform pg_temp.chk('G5 a section_unlinked event was written and no further milestone event',
    (select count(*) from activity where entity = 'task' and entity_id = t::text and action = 'section_unlinked') = 1
    and (select count(*) from activity where entity = 'task' and entity_id = t::text and action = 'milestone_changed') = 1);

  -- ------------------------------------------- relink: atomic, or it fails
  select count(*) into n0 from activity where entity = 'task' and entity_id = t::text;
  q := pg_temp.act(own, format('update tasks set section_id = %L where id = %L', secA2, t));
  perform pg_temp.chk('G6 a section of ANOTHER milestone alone is refused, never a contradiction', q = '23514', q);
  perform pg_temp.chk('G7 the refused relink changed nothing and wrote no event',
    (select section_id from tasks where id = t) is null and (select milestone_key from tasks where id = t) = 'GL-A1'
    and (select count(*) from activity where entity = 'task' and entity_id = t::text) = n0);

  q := pg_temp.act(own, format('update tasks set milestone_key = %L, section_id = %L where id = %L', 'GL-A2', secA2, t));
  perform pg_temp.chk('G8 changing milestone and section together (a conscious relink) succeeds atomically',
    q = 'ok' and (select milestone_key from tasks where id = t) = 'GL-A2' and (select section_id from tasks where id = t) = secA2, q);
  perform pg_temp.chk('G9 the relink logged both dimensions',
    (select count(*) from activity where entity = 'task' and entity_id = t::text and action = 'milestone_changed'
       and detail ->> 'from' = 'GL-A1' and detail ->> 'to' = 'GL-A2') = 1
    and (select count(*) from activity where entity = 'task' and entity_id = t::text and action = 'section_linked'
       and detail ->> 'to' = secA2::text) = 1);

  q := pg_temp.act(own, format('update tasks set section_id = %L where id = %L', secA1, t));
  perform pg_temp.chk('G10 moving between sections of different milestones without the milestone is refused', q = '23514', q);

  -- ------------------------------------------------------------ season rules
  q := pg_temp.act(own, format('update tasks set milestone_key = %L, section_id = %L where id = %L', 'GL-B1', secB1, t));
  perform pg_temp.chk('G11 a section of another season is refused', q = '23514', q);
  q := pg_temp.act(own, format('update tasks set milestone_key = %L, section_id = null where id = %L', 'GL-B1', t));
  perform pg_temp.chk('G12 a milestone of another season is refused', q = '23514', q);
  perform pg_temp.chk('G13 nothing moved',
    (select milestone_key from tasks where id = t) = 'GL-A2' and (select section_id from tasks where id = t) = secA2);

  -- ---------------------------------------------------------- who may relink
  q := pg_temp.act(mem, format('update tasks set milestone_key = %L, section_id = %L where id = %L', 'GL-A1', secA1, t));
  perform pg_temp.chk('G14 an unrelated member changes nothing (the task stays readable, not editable)',
    (select milestone_key from tasks where id = t) = 'GL-A2', q);
  q := pg_temp.act(hdB, format('update tasks set milestone_key = %L, section_id = %L where id = %L', 'GL-A1', secA1, t));
  perform pg_temp.chk('G15 the Head of ANOTHER department changes nothing',
    (select milestone_key from tasks where id = t) = 'GL-A2', q);
  q := pg_temp.act(hdA, format('update tasks set milestone_key = %L, section_id = %L where id = %L', 'GL-A1', secA1, t));
  perform pg_temp.chk('G16 the Head of the task''s department relinks it',
    q = 'ok' and (select milestone_key from tasks where id = t) = 'GL-A1' and (select section_id from tasks where id = t) = secA1, q);
  perform pg_temp.chk('G17 that relink is attributed to the Head',
    (select count(*) from activity where entity = 'task' and entity_id = t::text and action = 'milestone_changed' and actor_id = hdA) = 1);

  -- ----------------------------------------------- an ordinary edit is silent
  select count(*) into n0 from activity where entity = 'task' and entity_id = t::text and action in ('milestone_changed','section_linked','section_unlinked','section_changed');
  perform pg_temp.act(own, format('update tasks set starred = true where id = %L', t));
  select count(*) into n1 from activity where entity = 'task' and entity_id = t::text and action in ('milestone_changed','section_linked','section_unlinked','section_changed');
  perform pg_temp.chk('G18 an edit that does not touch a link writes no link event', n0 = n1);

  -- ----------------------------------------------------------- archived work
  insert into tasks (season_id, title, owner_id, subteam_key, due_date) values (sA, 'GL archived', own, dA, '2026-11-20') returning id into tArch;
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks set archived_at = now(), archive_reason = 'manual' where id = tArch;
  perform set_config('reqon.task_lifecycle_write', 'off', true);
  q := pg_temp.act(own, format('update tasks set milestone_key = %L, section_id = %L where id = %L', 'GL-A1', secA1, tArch));
  -- RLS hides an archived row from UPDATE (zero rows, no error), exactly as on the Board.
  perform pg_temp.chk('G19 an archived task cannot be linked until it is restored (row unchanged)',
    (select milestone_key from tasks where id = tArch) is null and (select section_id from tasks where id = tArch) is null, q);

  -- --------------------------------------------- promoted work keeps its milestone
  insert into tasks (season_id, title, owner_id, subteam_key, due_date, milestone_key, links_required)
    values (sA, 'GL promoted', own, dA, '2026-11-20', 'GL-A1', true) returning id into tReq;
  insert into task_requirements (task_id, clause_key) values (tReq, clause);
  q := pg_temp.act(own, format('set constraints all immediate; update tasks set milestone_key = null where id = %L', tReq));
  perform pg_temp.chk('G20 a promoted task''s milestone cannot be cleared (unlinking the section keeps it)', q <> 'ok', q);
  q := pg_temp.act(own, format('update tasks set section_id = %L where id = %L', secA1, tReq));
  perform pg_temp.chk('G21 ...but it can still be linked to a section of its own milestone', q = 'ok' and (select section_id from tasks where id = tReq) = secA1, q);
  q := pg_temp.act(own, format('set constraints all immediate; update tasks set section_id = null where id = %L', tReq));
  perform pg_temp.chk('G22 ...and unlinked again, the milestone staying',
    q = 'ok' and (select section_id from tasks where id = tReq) is null and (select milestone_key from tasks where id = tReq) = 'GL-A1', q);

  -- --------------------------------------------- milestone date changes audited
  q := pg_temp.act(vp, $$update milestones set due_on = '2026-12-05' where key = 'GL-A1'$$);
  select detail into ev from activity where entity = 'milestone' and entity_id = 'GL-A1' and action = 'configuration_changed' order by id desc limit 1;
  perform pg_temp.chk('G23 an administrator changes a deadline and the change is audited with from and to',
    q = 'ok' and ev -> 'due_on' ->> 'from' = '2026-11-30' and ev -> 'due_on' ->> 'to' = '2026-12-05', q);
  perform pg_temp.chk('G24 the audit row carries the actor and the season',
    exists (select 1 from activity where entity = 'milestone' and entity_id = 'GL-A1' and actor_id = vp and season_id = sA));
  q := pg_temp.act(vp, $$update milestones set opens_on = '2027-01-01' where key = 'GL-A1'$$);
  perform pg_temp.chk('G25 a window that opens after it closes is refused', q = '23514', q);
  q := pg_temp.act(mem, $$update milestones set due_on = '2026-12-31' where key = 'GL-A1'$$);
  perform pg_temp.chk('G26 an ordinary member cannot move a deadline', (select due_on from milestones where key = 'GL-A1') = '2026-12-05', q);

  select count(*) filter (where not ok), count(*) into nfail, ntotal from results;
  if nfail > 0 then
    raise exception E'GANTT LINK CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      nfail, ntotal,
      (select string_agg(label || coalesce(': ' || detail, ''), E'\n' order by n) from results where not ok),
      (select string_agg(case when ok then 'ok  ' else 'FAIL' end || '  ' || label, E'\n' order by n) from results);
  end if;
  raise exception E'GANTT LINK CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    ntotal, (select string_agg('ok    ' || label, E'\n' order by n) from results);
end
$test$;
