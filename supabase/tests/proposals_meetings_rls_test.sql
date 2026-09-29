-- =============================================================================
--  Authorization checks for task proposals, board tasks and meetings
--  (20260108000000_proposals_and_meetings.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates happens inside
--  one block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Run it in the Supabase SQL Editor after ALL migrations. The result arrives
--  as an "error" beginning with
--      PROPOSAL/MEETING CHECKS PASSED   every check behaved as expected, or
--      PROPOSAL/MEETING CHECKS FAILED   followed by the ones that did not.
--  That "error" is the rollback doing its job.
--
--  What it proves, per role:
--    suggest a proposal         everyone, and only in their own name
--    review / decide a proposal president, vice-president, developer
--    promote (insert a task)    NOBODY, directly — see the note below
--    move/edit a task           owner, Head of its department, or Developer
--                                only (task_authorization_test.sql covers
--                                this exhaustively; the three checks kept
--                                here just prove the OLD blanket policy is
--                                gone)
--    delete a task               NOBODY — no task_delete policy exists
--    call / edit a meeting      president, vice-president, developer
--    delete a meeting           president, developer only
--    edit the meeting template  president, developer only
--    read the template          everyone on the roster
--
--  Corrected 20260117 (traceability_and_proposal_commands): a proposal is
--  created only by submit_proposal() and changed only by its department Head
--  (or a Developer) through can_review_proposal(); the President/VP alone have
--  no proposal power, direct INSERT/DELETE is closed for everyone, and state
--  moves only through review_proposal()/promote_proposal(). See
--  proposal_commands_test.sql for the positive side of every one of these.
--
--  Corrected 20260116 (task_lifecycle_and_authorization): promoting a
--  proposal was always ONE call to promote_proposal() (20260110), even
--  before this file existed — the three "promotes" checks below never
--  actually promoted anything, they inserted a task directly with
--  source_proposal set, to prove which roles COULD bypass
--  promote_proposal() and do it by hand. That bypass is now closed for
--  everyone, including President/VP/Developer: task_insert has no policy at
--  all, so only promote_proposal() itself (SECURITY DEFINER, unchanged) can
--  create a task. Likewise task_update is now can_edit_task()-scoped
--  (owner/Head/Developer), not "everyone", and task_delete has no policy at
--  all — see task_authorization_test.sql for the full matrix this file no
--  longer needs to carry.
-- =============================================================================

create or replace function pg_temp.attempt(who uuid, stmt text, kind text)
returns text language plpgsql as $fn$
declare
  n bigint;
begin
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', who, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', who::text, true);

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
  dev    uuid := gen_random_uuid();
  tre    uuid := gen_random_uuid();
  pre    uuid := gen_random_uuid();
  vp     uuid := gen_random_uuid();
  mem    uuid := gen_random_uuid();
  season uuid;
  prop   uuid;           -- a proposal to review
  -- 20260110 added a UNIQUE index on tasks(source_proposal): at most one task
  -- per proposal. The three ALLOWED promotion checks below each insert a real
  -- task, so each needs its OWN proposal — sharing `prop` between them would
  -- make the 2nd and 3rd fail on the unique index, which is not what those
  -- checks are testing (they test per-role INSERT permission, not promotion).
  prop_vp  uuid;
  prop_pre uuid;
  prop_dev uuid;
  p_del1 uuid; p_del2 uuid; p_del3 uuid;
  t_keep uuid; t_del1 uuid; t_del2 uuid; t_del3 uuid; t_del4 uuid;
  m_keep uuid; m_del1 uuid; m_del2 uuid;
  c      record;
  got    text;
  lines  text[] := '{}';
  failures text[] := '{}';
begin
  insert into auth.users (id, email) values
    (dev, 'pm-dev@roles.test'), (tre, 'pm-tre@roles.test'), (pre, 'pm-pre@roles.test'),
    (vp, 'pm-vp@roles.test'), (mem, 'pm-mem@roles.test');
  insert into members (id, full_name, role) values
    (dev, 'PM Developer', 'Software'), (tre, 'PM Treasurer', 'Finance'),
    (pre, 'PM President', 'Team lead'), (vp, 'PM Vice', 'Operations'), (mem, 'PM Member', 'Chassis');
  insert into member_roles (member_id, role) values
    (dev, 'developer'), (tre, 'treasurer'), (pre, 'president'), (vp, 'vicepresident');

  insert into seasons (label, is_current) values ('PM-TEST', false) returning id into season;

  insert into task_proposals (season_id, title, raised_by) values (season, 'Review me', mem)
    returning id into prop;
  insert into task_proposals (season_id, title, raised_by) values (season, 'Promote (VP)', mem)
    returning id into prop_vp;
  insert into task_proposals (season_id, title, raised_by) values (season, 'Promote (president)', mem)
    returning id into prop_pre;
  insert into task_proposals (season_id, title, raised_by) values (season, 'Promote (developer)', mem)
    returning id into prop_dev;
  insert into task_proposals (season_id, title, raised_by) values (season, 'Delete 1', mem)
    returning id into p_del1;
  insert into task_proposals (season_id, title, raised_by) values (season, 'Delete 2', mem)
    returning id into p_del2;
  insert into task_proposals (season_id, title, raised_by) values (season, 'Delete 3', mem)
    returning id into p_del3;

  insert into tasks (season_id, title) values (season, 'Keep')     returning id into t_keep;
  insert into tasks (season_id, title) values (season, 'Delete 1') returning id into t_del1;
  insert into tasks (season_id, title) values (season, 'Delete 2') returning id into t_del2;
  insert into tasks (season_id, title) values (season, 'Delete 3') returning id into t_del3;
  insert into tasks (season_id, title) values (season, 'Delete 4') returning id into t_del4;

  insert into meetings (season_id, title, held_on) values (season, 'Keep', '2026-09-20')
    returning id into m_keep;
  insert into meetings (season_id, title, held_on) values (season, 'Delete 1', '2026-09-21')
    returning id into m_del1;
  insert into meetings (season_id, title, held_on) values (season, 'Delete 2', '2026-09-22')
    returning id into m_del2;

  create temp table checks (n serial, label text, who uuid, stmt text, kind text, expected text)
    on commit drop;
  insert into checks (label, who, stmt, kind, expected) values
    -- ============================== PROPOSALS =============================
    ('member    inserts a proposal directly, in own name', mem, format('insert into task_proposals (season_id, title, raised_by) values (%L, ''Mine'', %L)', season, mem), 'write', 'DENIED'),
    ('member    suggests as someone else',   mem, format('insert into task_proposals (season_id, title, raised_by) values (%L, ''Forged'', %L)', season, pre), 'write', 'DENIED'),
    ('treasurer inserts a proposal directly',      tre, format('insert into task_proposals (season_id, title, raised_by) values (%L, ''Mine'', %L)', season, tre), 'write', 'DENIED'),
    ('member    reads proposals',            mem, 'select count(*) from task_proposals', 'read', 'ALLOWED'),
    ('member    decides a proposal',         mem, format('update task_proposals set state = ''decided'' where id = %L', prop), 'write', 'DENIED'),
    ('treasurer decides a proposal',         tre, format('update task_proposals set state = ''decided'' where id = %L', prop), 'write', 'DENIED'),
    ('vicepresident edits a proposal (no department power)', vp,  format('update task_proposals set decision = ''vp'' where id = %L', prop), 'write', 'DENIED'),
    ('president edits a proposal (no department power)', pre, format('update task_proposals set decision = ''yes'' where id = %L', prop), 'write', 'DENIED'),
    ('developer edits a proposal decision note', dev, format('update task_proposals set decision = ''dev note'' where id = %L', prop), 'write', 'ALLOWED'),
    ('developer forces state by direct UPDATE', dev, format('update task_proposals set state = ''decided'' where id = %L', prop), 'write', 'DENIED'),

    -- =========== BYPASSING promote_proposal() BY INSERTING DIRECTLY ========
    -- Every one of these is now refused, President/VP/Developer included:
    -- there is no task_insert policy at all (20260116). Real promotion still
    -- works (proposal_promotion_test.sql), through promote_proposal() only.
    ('member    promotes (inserts a task)',  mem, format('insert into tasks (season_id, title, source_proposal) values (%L, ''Sneaky'', %L)', season, prop), 'write', 'DENIED'),
    ('treasurer promotes',                   tre, format('insert into tasks (season_id, title, source_proposal) values (%L, ''Sneaky'', %L)', season, prop), 'write', 'DENIED'),
    ('vicepresident promotes, with owner',   vp,  format('insert into tasks (season_id, title, source_proposal, owner_id, due_date) values (%L, ''Promoted by VP'', %L, %L, ''2026-10-01'')', season, prop_vp, mem), 'write', 'DENIED'),
    ('president promotes',                   pre, format('insert into tasks (season_id, title, source_proposal) values (%L, ''Promoted by president'', %L)', season, prop_pre), 'write', 'DENIED'),
    ('developer promotes',                   dev, format('insert into tasks (season_id, title, source_proposal) values (%L, ''Promoted by developer'', %L)', season, prop_dev), 'write', 'DENIED'),

    -- =================== THE BOARD IS NO LONGER EVERYONE'S =================
    -- t_keep has no owner and no department — nobody in this fixture owns or
    -- heads it, so can_edit_task() denies all three. task_authorization_test.sql
    -- proves the ALLOWED side (owner, Head-of-department, Developer) properly.
    ('member    moves a task they do not own',       mem, format('update tasks set state = ''wip'' where id = %L', t_keep), 'write', 'DENIED'),
    ('member    assigns an owner on a task they do not own', mem, format('update tasks set owner_id = %L where id = %L', mem, t_keep), 'write', 'DENIED'),
    ('treasurer moves a task they do not own',       tre, format('update tasks set state = ''todo'' where id = %L', t_keep), 'write', 'DENIED'),

    -- ========================= DELETING A TASK =============================
    -- No task_delete policy exists for anyone (20260116) — archiving
    -- (archive_task/restore_task, task_authorization_test.sql) replaces
    -- deletion; Developer maintenance happens outside RLS entirely.
    ('member    deletes a task',             mem, format('delete from tasks where id = %L', t_del1), 'write', 'DENIED'),
    ('treasurer deletes a task',             tre, format('delete from tasks where id = %L', t_del2), 'write', 'DENIED'),
    ('vicepresident deletes a task',         vp,  format('delete from tasks where id = %L', t_del3), 'write', 'DENIED'),
    ('president deletes a task',             pre, format('delete from tasks where id = %L', t_del3), 'write', 'DENIED'),
    ('developer deletes a task',             dev, format('delete from tasks where id = %L', t_del4), 'write', 'DENIED'),

    -- ============================== MEETINGS ===============================
    ('member    reads meetings',             mem, 'select count(*) from meetings', 'read', 'ALLOWED'),
    ('member    calls a meeting',            mem, format('insert into meetings (season_id, title, held_on) values (%L, ''Mine'', ''2026-09-25'')', season), 'write', 'DENIED'),
    ('treasurer calls a meeting',            tre, format('insert into meetings (season_id, title, held_on) values (%L, ''Mine'', ''2026-09-25'')', season), 'write', 'DENIED'),
    ('vicepresident calls a meeting',        vp,  format('insert into meetings (season_id, title, held_on, starts_at) values (%L, ''Build review'', ''2026-09-25'', ''18:30'')', season), 'write', 'ALLOWED'),
    ('developer calls a meeting',            dev, format('insert into meetings (season_id, title, held_on) values (%L, ''Maintenance'', ''2026-09-26'')', season), 'write', 'ALLOWED'),
    ('member    writes meeting minutes',     mem, format('update meetings set notes = ''mine'' where id = %L', m_keep), 'write', 'DENIED'),
    ('vicepresident writes minutes',         vp,  format('update meetings set notes = ''Decided X'', agenda = ''1. X'' where id = %L', m_keep), 'write', 'ALLOWED'),
    ('vicepresident deletes a meeting',      vp,  format('delete from meetings where id = %L', m_del1), 'write', 'DENIED'),
    ('treasurer deletes a meeting',          tre, format('delete from meetings where id = %L', m_del1), 'write', 'DENIED'),
    ('president deletes a meeting',          pre, format('delete from meetings where id = %L', m_del1), 'write', 'ALLOWED'),
    ('developer deletes a meeting',          dev, format('delete from meetings where id = %L', m_del2), 'write', 'ALLOWED'),

    -- ========================= MEETING TEMPLATE ============================
    ('member    reads the template',         mem, 'select count(*) from meeting_template', 'read', 'ALLOWED'),
    ('member    edits the template',         mem, 'update meeting_template set body = ''mine'' where id', 'write', 'DENIED'),
    ('treasurer edits the template',         tre, 'update meeting_template set body = ''mine'' where id', 'write', 'DENIED'),
    ('vicepresident edits the template',     vp,  'update meeting_template set body = ''mine'' where id', 'write', 'DENIED'),
    ('president edits the template',         pre, 'update meeting_template set body = ''president wrote this'' where id', 'write', 'ALLOWED'),
    ('developer edits the template',         dev, 'update meeting_template set body = ''developer wrote this'' where id', 'write', 'ALLOWED'),

    -- ================== PROPOSALS ARE NOT DELETED LIGHTLY ==================
    ('member    deletes a proposal',         mem, format('delete from task_proposals where id = %L', p_del1), 'write', 'DENIED'),
    ('vicepresident deletes a proposal',     vp,  format('delete from task_proposals where id = %L', p_del2), 'write', 'DENIED'),
    ('president deletes a proposal',         pre, format('delete from task_proposals where id = %L', p_del3), 'write', 'DENIED');

  for c in select * from checks order by n loop
    got := pg_temp.attempt(c.who, c.stmt, c.kind);
    lines := lines || format('%s  %-42s expected %-7s got %s',
      case when got = c.expected then 'ok  ' else 'FAIL' end, c.label, c.expected, got);
    if got <> c.expected then
      failures := failures || format('%s: expected %s, got %s', c.label, c.expected, got);
    end if;
  end loop;

  if array_length(failures, 1) > 0 then
    raise exception E'PROPOSAL/MEETING CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'PROPOSAL/MEETING CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
