-- =============================================================================
--  Proposal discussion, revisions, approval and promotion (backend completion
--  Phase 3): migrations 20260127000000 .. 0300, PERMISSIONS.md §3.3, §5, §7.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every
--  fixture rolls back. Fixture people are new @p3-prop.test identities.
--
--  Result: PROPOSAL DISCUSSION CHECKS PASSED / FAILED.
--
--  Covers: append-only, attributed discussion; revisions and stale writes; who may
--  revise / ask for changes / approve / promote (author, member, wrong-department Head,
--  Head, parent Head, President/VP fallback, Developer, retired holders); approval
--  evidence (revision, approver, authority, note); invalidation by every material field
--  and by the requirement set, and non-invalidation by comments and stars; no-Head
--  handling; a Head change between approval and promotion; promotion only from an
--  approved, unchanged proposal, once, with a start date; retries; a tampered proposal;
--  failure leaving nothing behind; edition consistency.
-- =============================================================================

create or replace function pg_temp.attempt(who uuid, stmt text) returns text language plpgsql as $fn$
declare n bigint; result text;
begin
  if who is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', who::text, true);
  end if;
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

create or replace function pg_temp.val(who uuid, expr text) returns text language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute 'select (' || expr || ')::text' into r;
  exception
    when insufficient_privilege then r := 'DENIED';
    when others then r := 'ERROR ' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return coalesce(r, 'null');
end $fn$;

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

-- A complete, open proposal in a department, authored by p_author.
create or replace function pg_temp.mk(p_dept text, p_author uuid, p_state text default 'open', p_due date default '2099-12-01')
returns uuid language plpgsql as $fn$
declare
  pid uuid;
  v_season uuid := (select id from seasons where is_current limit 1);
begin
  insert into task_proposals (season_id, title, context, raised_by, subteam_key, due_date, milestone_key, state)
  values (v_season, 'P3 proposal', 'context', p_author, p_dept, p_due,
          (select key from milestones where season_id = v_season order by ordinal limit 1), p_state::topic_state)
  returning id into pid;
  insert into proposal_requirements (proposal_id, clause_key)
    select pid, clause_key from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = v_season order by clause_key limit 1;
  return pid;
end $fn$;

do $test$
declare
  season uuid; s2 uuid := gen_random_uuid();
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid(); tre uuid := gen_random_uuid();
  ha uuid := gen_random_uuid(); hb uuid := gen_random_uuid(); hs uuid := gen_random_uuid(); hnew uuid := gen_random_uuid();
  au uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); alum uuid := gen_random_uuid(); inactive uuid := gen_random_uuid();
  pa text; pb text; pc text;
  ms text; ms_b text; ms2 text; cl1 text; cl2 text; cl_other text;
  p uuid; p2 uuid; p_leg uuid; t uuid;
  f record; r text; before_n int; today_cph date; tid text;
  total int; bad int; report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into ms from milestones where season_id = season order by ordinal limit 1;
  select key into ms_b from milestones where season_id = season and key <> ms order by ordinal limit 1;
  select clause_key into cl1 from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season order by clause_key limit 1;
  select clause_key into cl2 from clauses c join seasons s on s.regs_ref = c.regs_ref where s.id = season and clause_key <> cl1 order by clause_key limit 1;
  select key into pa from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select key into pb from subteams where archived_at is null and parent_key is null and key <> pa order by sort_order, key limit 1;
  select key into pc from subteams where archived_at is null and parent_key is null and key not in (pa, pb) order by sort_order, key limit 1;
  today_cph := (now() at time zone 'Europe/Copenhagen')::date;

  insert into auth.users (id, email)
  select id, k || '@p3-prop.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (ha, 'ha'), (hb, 'hb'),
    (hs, 'hs'), (hnew, 'hnew'), (au, 'au'), (mem, 'mem'), (alum, 'alum'), (inactive, 'inactive')) v(id, k);
  insert into members (id, full_name, role, status)
  select id, 'P ' || k, 'Member', case when k in ('alum', 'inactive') then 'alumni' else 'active' end::member_state
  from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (ha, 'ha'), (hb, 'hb'), (hs, 'hs'), (hnew, 'hnew'),
    (au, 'au'), (mem, 'mem'), (alum, 'alum'), (inactive, 'inactive')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'), (tre, 'treasurer');
  update subteams set lead_id = ha where key = pa;
  update subteams set lead_id = hb where key = pb;
  update subteams set lead_id = null where key = pc;              -- a department with NO Head
  insert into subteams (key, name, parent_key, lead_id) values ('PD_SUB', 'P sub', pa, hs);
  insert into subteams (key, name, parent_key) values ('PD_ARCH', 'P archived', pa);
  update subteams set archived_at = now() where key = 'PD_ARCH';

  insert into seasons (id, label, regs_ref) select s2, 'P3 other season', regs_ref from seasons where id = season;
  insert into milestones (key, season_id, ordinal, name) values ('PD-M2', s2, 1, 'Other season milestone');
  ms2 := 'PD-M2';
  insert into regulation_documents (regs_ref) values ('P3 OTHER Rev.9');
  insert into clauses (clause_key, printed_ref, section, article, body, obligation, criticality, regs_ref)
    select 'P3-OTHER-EDITION', printed_ref, section, article, body, obligation, criticality, 'P3 OTHER Rev.9'
    from clauses where clause_key = cl1;
  cl_other := 'P3-OTHER-EDITION';

  -- ================================================================ discussion
  p := pg_temp.mk(pa, au);
  perform pg_temp.expect('a member comments on someone else''s proposal', pg_temp.attempt(mem, format('select add_proposal_comment(%L, ''Have you thought about X?'')', p)), 'ALLOWED');
  perform pg_temp.expect('the author replies', pg_temp.attempt(au, format('select add_proposal_comment(%L, ''Yes'')', p)), 'ALLOWED');
  perform pg_temp.expect('the Head joins', pg_temp.attempt(ha, format('select add_proposal_comment(%L, ''Agreed'')', p)), 'ALLOWED');
  perform pg_temp.expect('a retired member cannot comment', pg_temp.attempt(alum, format('select add_proposal_comment(%L, ''hi'')', p)), 'DENIED');
  perform pg_temp.expect('anon cannot comment', pg_temp.attempt(null, format('select add_proposal_comment(%L, ''hi'')', p)), 'DENIED');
  perform pg_temp.expect('an empty comment is refused', pg_temp.attempt(mem, format('select add_proposal_comment(%L, ''   '')', p)), 'ERROR 23514%');
  perform pg_temp.expect('an oversize comment is refused', pg_temp.attempt(mem, format('select add_proposal_comment(%L, %L)', p, repeat('x', 2001))), 'ERROR 23514%');
  perform pg_temp.expect('an unknown proposal is refused', pg_temp.attempt(mem, format('select add_proposal_comment(%L, ''x'')', gen_random_uuid())), 'ERROR 23503%');
  perform pg_temp.expect('every comment is attributed to its own author and the revision it was written against',
    (select (count(*) = 3 and count(distinct author_id) = 3 and bool_and(revision = 1)
             and array_agg(author_id order by author_id) @> array[mem, au, ha])::text
       from proposal_comments c where c.proposal_id = p),
    'true');
  perform pg_temp.expect('nobody can insert a comment directly (no forged author)', pg_temp.attempt(mem, format('insert into proposal_comments (proposal_id, author_id, body) values (%L, %L, ''forged'')', p, ha)), 'DENIED');
  perform pg_temp.expect('nobody can edit a comment, not even a Developer', pg_temp.attempt(dev, format('update proposal_comments set body = ''x'' where proposal_id = %L', p)), 'DENIED');
  perform pg_temp.expect('nobody can delete a comment', pg_temp.attempt(dev, format('delete from proposal_comments where proposal_id = %L', p)), 'DENIED');
  begin
    delete from proposal_comments where proposal_id = p;
    perform pg_temp.expect('even the table owner cannot delete a comment', 'deleted', 'refused');
  exception when others then
    perform pg_temp.expect('even the table owner cannot delete a comment', 'refused', 'refused');
  end;
  perform pg_temp.expect('members read the discussion', pg_temp.attempt(mem, 'select 1 from proposal_comments limit 1'), 'ALLOWED');

  -- ================================================================= revisions
  perform pg_temp.expect('the author revises the title (revision 1 -> 2)', pg_temp.val(au, format('(revise_proposal(%L, 1, ''{"title":"Better title"}''::jsonb)).revision', p)), '2');
  perform pg_temp.expect('a stale edit is refused (40001)', pg_temp.attempt(au, format('select revise_proposal(%L, 1, ''{"title":"Overwrite"}''::jsonb)', p)), 'ERROR 40001%');
  perform pg_temp.expect('... and the first change is still there', (select title from task_proposals where id = p), 'Better title');
  perform pg_temp.expect('a member who is neither author nor reviewer cannot revise', pg_temp.attempt(mem, format('select revise_proposal(%L, 2, ''{"title":"Mine"}''::jsonb)', p)), 'DENIED');
  perform pg_temp.expect('the Head of another department cannot revise', pg_temp.attempt(hb, format('select revise_proposal(%L, 2, ''{"title":"Mine"}''::jsonb)', p)), 'DENIED');
  perform pg_temp.expect('a retired author cannot revise', pg_temp.attempt(alum, format('select revise_proposal(%L, 2, ''{"title":"Mine"}''::jsonb)', p)), 'DENIED');
  perform pg_temp.expect('the Head revises (revision 2 -> 3)', pg_temp.val(ha, format('(revise_proposal(%L, 2, ''{"description":"clearer"}''::jsonb, ''tightened the wording'')).revision', p)), '3');
  perform pg_temp.expect('... the note is a revision comment by the Head at revision 3',
    (select count(*)::text from proposal_comments where proposal_id = p and kind = 'revision' and author_id = ha and revision = 3), '1');
  perform pg_temp.expect('nothing to change: no new revision and no extra revised row',
    pg_temp.val(au, format('(revise_proposal(%L, 3, ''{"title":"Better title"}''::jsonb)).revision', p)) || '/' ||
    (select count(*)::text from activity where entity = 'proposal' and entity_id = p::text and action = 'revised'), '3/2');
  perform pg_temp.expect('the department is not a revise field', pg_temp.attempt(au, format('select revise_proposal(%L, 3, ''{"subteam_key":"X"}''::jsonb)', p)), 'ERROR 22023%');
  perform pg_temp.expect('the state is not a revise field', pg_temp.attempt(au, format('select revise_proposal(%L, 3, ''{"state":"approved"}''::jsonb)', p)), 'ERROR 22023%');
  perform pg_temp.expect('a deadline cannot be cleared', pg_temp.attempt(au, format('select revise_proposal(%L, 3, ''{"due_date":null}''::jsonb)', p)), 'ERROR 23502%');
  perform pg_temp.expect('a milestone cannot be cleared', pg_temp.attempt(au, format('select revise_proposal(%L, 3, ''{"milestone_key":""}''::jsonb)', p)), 'ERROR 23502%');
  perform pg_temp.expect('requirements cannot be emptied', pg_temp.attempt(au, format('select revise_proposal(%L, 3, ''{"requirement_keys":[]}''::jsonb)', p)), 'ERROR 23514%');
  perform pg_temp.expect('a milestone of another season is refused', pg_temp.attempt(au, format('select revise_proposal(%L, 3, %L::jsonb)', p, jsonb_build_object('milestone_key', ms2))), 'ERROR 23514%');
  perform pg_temp.expect('a retired owner is refused', pg_temp.attempt(au, format('select revise_proposal(%L, 3, %L::jsonb)', p, jsonb_build_object('owner_id', inactive))), 'ERROR 23514%');
  perform pg_temp.expect('a requirement of another regulations edition is refused', pg_temp.attempt(au, format('select revise_proposal(%L, 3, %L::jsonb)', p, jsonb_build_object('requirement_keys', jsonb_build_array(cl_other)))), 'ERROR 23514%');
  perform pg_temp.expect('a title that is too long is refused', pg_temp.attempt(au, format('select revise_proposal(%L, 3, %L::jsonb)', p, jsonb_build_object('title', repeat('t', 201)))), 'ERROR 23514%');
  perform pg_temp.expect('none of those failed calls changed anything', (select revision::text || ':' || title from task_proposals where id = p), '3:Better title');
  r := pg_temp.val(au, format('(revise_proposal(%L, 3, %L::jsonb)).revision', p, jsonb_build_object('requirement_keys', jsonb_build_array(cl1, cl2))));
  perform pg_temp.expect('changing the requirements raises the revision',
    r || '/' || (select count(*)::text from proposal_requirements where proposal_id = p), '4/2');
  perform pg_temp.expect('a title and a requirement change together raise it once',
    pg_temp.val(au, format('(revise_proposal(%L, 4, %L::jsonb)).revision', p, jsonb_build_object('title', 'Both', 'requirement_keys', jsonb_build_array(cl1)))), '5');

  perform pg_temp.expect('a Head cannot rewrite the title with a plain UPDATE', pg_temp.attempt(ha, format('update task_proposals set title = ''sneak'' where id = %L', p)), 'DENIED');
  perform pg_temp.expect('nor the deadline', pg_temp.attempt(ha, format('update task_proposals set due_date = ''2027-01-01'' where id = %L', p)), 'DENIED');
  perform pg_temp.expect('nor the revision counter', pg_temp.attempt(ha, format('update task_proposals set revision = 99 where id = %L', p)), 'DENIED');
  perform pg_temp.expect('nor the approval evidence, not even a Developer', pg_temp.attempt(dev, format('update task_proposals set approved_revision = 5, approved_at = now(), approved_as = ''head'', approved_digest = ''x'' where id = %L', p)), 'DENIED');
  perform pg_temp.expect('the star stays editable by the reviewer through its narrow command', pg_temp.attempt(ha, format('select set_proposal_star(%L, true)', p)), 'ALLOWED');
  perform pg_temp.expect('... and do not raise the revision', (select revision::text from task_proposals where id = p), '5');

  -- ============================================================ changes requested
  p := pg_temp.mk(pa, au);
  perform pg_temp.expect('a member cannot ask for changes', pg_temp.attempt(mem, format('select request_proposal_changes(%L, 1, ''fix it'')', p)), 'DENIED');
  perform pg_temp.expect('the author cannot ask for changes on their own proposal', pg_temp.attempt(au, format('select request_proposal_changes(%L, 1, ''fix it'')', p)), 'DENIED');
  perform pg_temp.expect('another department''s Head cannot', pg_temp.attempt(hb, format('select request_proposal_changes(%L, 1, ''fix it'')', p)), 'DENIED');
  perform pg_temp.expect('a note is required', pg_temp.attempt(ha, format('select request_proposal_changes(%L, 1, '' '')', p)), 'ERROR 23514%');
  perform pg_temp.expect('a stale request is refused', pg_temp.attempt(ha, format('select request_proposal_changes(%L, 7, ''fix it'')', p)), 'ERROR 40001%');
  perform pg_temp.expect('the Head asks for changes', pg_temp.val(ha, format('(request_proposal_changes(%L, 1, ''Please say why the deadline'')).state', p)), 'changes_requested');
  perform pg_temp.expect('... the request is on record, attributed', (select count(*)::text from proposal_comments where proposal_id = p and kind = 'changes_requested' and author_id = ha), '1');
  perform pg_temp.expect('the author answers with a revision: back under review', pg_temp.val(au, format('(revise_proposal(%L, 1, ''{"description":"Reason added"}''::jsonb, ''Added the reason'')).state', p)), 'agenda');
  perform pg_temp.expect('an under-review proposal cannot be promoted', pg_temp.attempt(ha, format('select promote_proposal(%L, %L)', p, season)), 'ERROR 22023%Approve%');
  r := pg_temp.val(ha, format('(request_proposal_changes(%L, 2, ''One more thing'')).state', p));
  perform pg_temp.expect('the author can resubmit without any edit', r || '/' ||
    pg_temp.val(au, format('(revise_proposal(%L, 2, ''{}''::jsonb)).state', p)), 'changes_requested/agenda');

  -- ================================================================== approval
  p := pg_temp.mk(pa, au);
  perform pg_temp.expect('the author cannot approve their own proposal', pg_temp.attempt(au, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  perform pg_temp.expect('another department''s Head cannot approve', pg_temp.attempt(hb, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  perform pg_temp.expect('a subdepartment Head has no authority over the parent', pg_temp.attempt(hs, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  -- Role hierarchy (20260130000000): the President ranks above the Head. Asked without approving, so the Head's
  -- own approval below still applies to revision 1.
  perform pg_temp.expect('the President may approve although a Head exists', pg_temp.val(pre, format('can_review_proposal(%L)', p)), 'true');
  perform pg_temp.expect('the Treasurer cannot', pg_temp.attempt(tre, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  perform pg_temp.expect('a retired member cannot', pg_temp.attempt(alum, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  perform pg_temp.expect('anon cannot', pg_temp.attempt(null, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  perform pg_temp.expect('the Head needs a note', pg_temp.attempt(ha, format('select approve_proposal(%L, 1, '''')', p)), 'ERROR 23514%');
  perform pg_temp.expect('a stale approval is refused', pg_temp.attempt(ha, format('select approve_proposal(%L, 3, ''ok'')', p)), 'ERROR 40001%');
  perform pg_temp.expect('the revision must be named', pg_temp.attempt(ha, format('select approve_proposal(%L, null, ''ok'')', p)), 'ERROR 22004%');
  perform pg_temp.expect('no refusal approved anything', (select state::text || ':' || coalesce(approved_revision::text, '-') from task_proposals where id = p), 'open:-');
  perform pg_temp.expect('the Head approves', pg_temp.val(ha, format('(approve_proposal(%L, 1, ''Fits the plan for MS1'')).state', p)), 'approved');
  perform pg_temp.expect('... evidence: revision, approver, authority, digest',
    (select (approved_revision = revision and approved_by = ha and approved_as = 'head' and approved_at is not null
             and approved_digest = proposal_content_digest(id))::text from task_proposals where id = p), 'true');
  perform pg_temp.expect('... the approval note is on record, attributed', (select count(*)::text from proposal_comments where proposal_id = p and kind = 'approval' and author_id = ha and revision = 1), '1');
  perform pg_temp.expect('a retry of the same approval is harmless (no second note)',
    pg_temp.attempt(ha, format('select approve_proposal(%L, 1, ''ok'')', p)) || '/' ||
    (select count(*)::text from proposal_comments where proposal_id = p and kind = 'approval'), 'ALLOWED/1');
  perform pg_temp.expect('the author cannot revise an approved proposal', pg_temp.attempt(au, format('select revise_proposal(%L, 1, ''{"title":"Sneak"}''::jsonb)', p)), 'DENIED');
  perform pg_temp.expect('the author can still comment on it', pg_temp.attempt(au, format('select add_proposal_comment(%L, ''Thanks'')', p)), 'ALLOWED');

  p2 := pg_temp.mk('PD_SUB', au);
  perform pg_temp.expect('the parent''s Head approves a subdepartment proposal, as parent_head', pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).approved_as', p2)), 'parent_head');
  p2 := pg_temp.mk(pa, au);
  perform pg_temp.expect('a Developer approves, as developer', pg_temp.val(dev, format('(approve_proposal(%L, 1, ''ok'')).approved_as', p2)), 'developer');

  insert into task_proposals
    (season_id, title, context, raised_by, subteam_key, due_date, milestone_key, state, legacy_incomplete)
  values
    (season, 'Older incomplete proposal', 'context', au, pa, current_date + 30, ms, 'open', true)
  returning id into p_leg;
  insert into proposal_requirements (proposal_id, clause_key) values (p_leg, cl1);
  perform pg_temp.expect('an older incomplete proposal cannot be approved', pg_temp.attempt(ha, format('select approve_proposal(%L, 1, ''ok'')', p_leg)), 'ERROR 22023%older%');
  p_leg := pg_temp.mk(pa, au);
  delete from proposal_requirements where proposal_id = p_leg;
  perform pg_temp.expect('a proposal with no requirement cannot be approved', pg_temp.attempt(ha, format('select approve_proposal(%L, 1, ''ok'')', p_leg)), 'ERROR 22023%');
  p_leg := pg_temp.mk('PD_ARCH', au);
  perform pg_temp.expect('a proposal in an archived department cannot be approved', pg_temp.attempt(dev, format('select approve_proposal(%L, 1, ''ok'')', p_leg)), 'ERROR 22023%');

  -- ============================================================ no-Head handling
  p := pg_temp.mk(pc, au);
  perform pg_temp.expect('nothing is auto-approved: it stays open', (select state::text from task_proposals where id = p), 'open');
  perform pg_temp.expect('a plain member cannot decide for a department without a Head', pg_temp.attempt(mem, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  perform pg_temp.expect('an unrelated Head cannot', pg_temp.attempt(ha, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  perform pg_temp.expect('the Treasurer cannot', pg_temp.attempt(tre, format('select approve_proposal(%L, 1, ''ok'')', p)), 'DENIED');
  perform pg_temp.expect('the Vice President can, recorded as vicepresident', pg_temp.val(vp, format('(approve_proposal(%L, 1, ''No Head yet; fits the plan'')).approved_as', p)), 'vicepresident');
  update subteams set lead_id = hnew where key = pc;
  perform pg_temp.expect('a Head being appointed leaves the President''s authority in place', pg_temp.val(pre, format('can_review_proposal(%L)', p)), 'true');
  perform pg_temp.expect('... and the Vice President''s', pg_temp.val(vp, format('can_review_proposal(%L)', p)), 'true');
  perform pg_temp.expect('the approval is still valid: the new Head promotes it', pg_temp.attempt(hnew, format('select promote_proposal(%L, %L)', p, season)), 'ALLOWED');
  perform pg_temp.expect('... and the record still says who approved and as what',
    (select (approved_by = vp and approved_as = 'vicepresident' and state = 'decided' and outcome = 'approved')::text from task_proposals where id = p), 'true');
  update subteams set lead_id = null where key = pc;
  p := pg_temp.mk(pc, au);
  perform pg_temp.expect('the President decides for a department without a Head in one step (approve_and_promote)',
    pg_temp.attempt(pre, format('select approve_and_promote(%L, %L, 1, ''Deciding: no Head'')', p, season)), 'ALLOWED');

  -- ============================================================== invalidation
  for f in select * from (values
      ('title', '{"title":"Renamed after approval"}'),
      ('description', '{"description":"Rewritten after approval"}'),
      ('owner', jsonb_build_object('owner_id', mem)::text),
      ('deadline', '{"due_date":"2027-02-02"}'),
      ('priority', '{"priority":"urgent"}'),
      ('milestone', jsonb_build_object('milestone_key', ms_b)::text),
      ('requirements', jsonb_build_object('requirement_keys', jsonb_build_array(cl2))::text),
      ('department', null)) v(field, changes) loop
    p := pg_temp.mk(pa, au);
    perform pg_temp.expect('(' || f.field || ') the Head approves first', pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).state', p)), 'approved');
    if f.field = 'department' then
      r := pg_temp.attempt(ha, format('select set_proposal_department(%L, ''PD_SUB'', ''belongs to the sub'', 1)', p));
    else
      r := pg_temp.attempt(ha, format('select revise_proposal(%L, 1, %L::jsonb)', p, f.changes));
    end if;
    perform pg_temp.expect('(' || f.field || ') the reviewer may change it', r, 'ALLOWED');
    perform pg_temp.expect('(' || f.field || ') the change withdraws the approval and raises the revision',
      (select state::text || ':' || coalesce(approved_revision::text, '-') || ':' || revision::text from task_proposals where id = p), 'agenda:-:2');
    perform pg_temp.expect('(' || f.field || ') it is on record that the approval was withdrawn',
      (select count(*)::text from activity where entity = 'proposal' and entity_id = p::text and action = 'approval_invalidated'), '1');
    perform pg_temp.expect('(' || f.field || ') the withdrawn approval cannot be used to promote',
      pg_temp.attempt(ha, format('select promote_proposal(%L, %L)', p, season)), 'ERROR 22023%Approve%');
  end loop;

  -- a plain set_proposal_requirements call is a revision too
  p := pg_temp.mk(pa, au);
  perform pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  r := pg_temp.attempt(ha, format('select set_proposal_requirements(%L, array[%L], 1)', p, cl2));
  perform pg_temp.expect('the legacy requirements command withdraws an approval as well',
    r || '/' ||
    (select state::text || ':' || revision::text from task_proposals where id = p), 'ALLOWED/agenda:2');

  -- what does NOT invalidate an approval
  p := pg_temp.mk(pa, au);
  perform pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  perform pg_temp.attempt(ha, format('select set_proposal_star(%L, true)', p));
  perform pg_temp.attempt(mem, format('select add_proposal_comment(%L, ''looks good'')', p));
  perform pg_temp.expect('a star, a note and a comment leave the approval intact',
    (select state::text || ':' || approved_revision::text || ':' || revision::text from task_proposals where id = p), 'approved:1:1');

  -- a change that bypassed the revision counter still cannot be promoted
  perform pg_temp.expect('(tamper) the approved content is bound by a digest', (select (approved_digest = proposal_content_digest(id))::text from task_proposals where id = p), 'true');
  alter table task_proposals disable trigger trg_proposal_revision;
  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals set title = 'Tampered behind the counter' where id = p;
  perform set_config('reqon.proposal_write', 'off', true);
  alter table task_proposals enable trigger trg_proposal_revision;
  perform pg_temp.expect('(tamper) promotion re-checks the content, not just the counter',
    pg_temp.attempt(ha, format('select promote_proposal(%L, %L)', p, season)), 'ERROR 40001%no longer matches%');
  perform pg_temp.expect('(tamper) and created no task', (select count(*)::text from tasks where source_proposal = p), '0');

  -- ===================================================== a Head change in between
  p := pg_temp.mk(pb, au);
  perform pg_temp.val(hb, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  update subteams set lead_id = hnew where key = pb;
  perform pg_temp.expect('the former Head can no longer promote what they approved', pg_temp.attempt(hb, format('select promote_proposal(%L, %L)', p, season)), 'DENIED');
  perform pg_temp.expect('the new Head promotes it (the approval is still valid)', pg_temp.attempt(hnew, format('select promote_proposal(%L, %L)', p, season)), 'ALLOWED');
  p := pg_temp.mk(pb, au);
  perform pg_temp.val(hnew, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  update members set status = 'alumni' where id = hnew;
  perform pg_temp.expect('an approver who has retired cannot promote', pg_temp.attempt(hnew, format('select promote_proposal(%L, %L)', p, season)), 'DENIED');
  perform pg_temp.expect('a Head who retired leaves the department to the fallback, which can promote', pg_temp.attempt(pre, format('select promote_proposal(%L, %L)', p, season)), 'ALLOWED');
  update members set status = 'active' where id = hnew;
  update subteams set lead_id = hb where key = pb;

  -- ================================================================= promotion
  foreach r in array array['open', 'agenda', 'changes_requested', 'parked'] loop
    p := pg_temp.mk(pa, au, r);
    perform pg_temp.expect('a ' || r || ' proposal cannot be promoted', pg_temp.attempt(ha, format('select promote_proposal(%L, %L)', p, season)), 'ERROR 22023%');
  end loop;

  p := pg_temp.mk(pa, au, 'open', '2099-12-01');
  perform pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  perform pg_temp.expect('a member cannot promote (even the author)', pg_temp.attempt(au, format('select promote_proposal(%L, %L)', p, season)), 'DENIED');
  perform pg_temp.expect('another department''s Head cannot promote', pg_temp.attempt(hb, format('select promote_proposal(%L, %L)', p, season)), 'DENIED');
  perform pg_temp.expect('the President may promote where a Head exists (asked without promoting)', pg_temp.val(pre, format('can_review_proposal(%L)', p)), 'true');
  perform pg_temp.expect('the Treasurer cannot promote', pg_temp.attempt(tre, format('select promote_proposal(%L, %L)', p, season)), 'DENIED');
  perform pg_temp.expect('a wrong season is refused', pg_temp.attempt(ha, format('select promote_proposal(%L, %L)', p, s2)), 'ERROR 22023%');
  perform pg_temp.expect('a retired owner is refused and nothing is created', pg_temp.attempt(ha, format('select promote_proposal(%L, %L, %L)', p, season, inactive)) || '/' ||
    (select count(*)::text from tasks where source_proposal = p), 'ERROR 23514: A task can only be assigned to an active member./0');
  tid := pg_temp.val(ha, format('(select (task).id from promote_proposal(%L, %L, %L, %L))', p, season, mem, today_cph + 1));
  perform pg_temp.expect('the Head promotes: one task, started on the given day, owned by the chosen member, from this proposal',
    (select (count(*) = 1 and bool_and(id::text = tid and starts_on = today_cph + 1 and due_date = '2099-12-01' and owner_id = mem
       and subteam_key = pa and source_proposal = p and links_required and state = 'todo' and created_by = ha))::text from tasks where source_proposal = p), 'true');
  perform pg_temp.expect('... with its requirement links copied', (select count(*)::text from task_requirements where task_id = tid::uuid), '1');
  perform pg_temp.expect('... and the proposal archived as promoted, with its approval kept as evidence',
    (select (state = 'decided' and outcome = 'approved' and archive_reason = 'promoted' and archived_at is not null
             and approved_revision = 1 and approved_as = 'head' and approved_by = ha)::text from task_proposals where id = p), 'true');
  perform pg_temp.expect('a second promotion returns the same task and creates nothing',
    pg_temp.val(ha, format('(select (task).id::text || (created)::text from promote_proposal(%L, %L))', p, season)), tid || 'false');
  perform pg_temp.expect('... still exactly one task', (select count(*)::text from tasks where source_proposal = p), '1');
  perform pg_temp.expect('a closed proposal takes no more comments', pg_temp.attempt(mem, format('select add_proposal_comment(%L, ''late'')', p)), 'ERROR 22023%');
  perform pg_temp.expect('the promotion is audited with the approval it used',
    (select (detail ->> 'approved_revision' = '1' and detail ->> 'approved_as' = 'head')::text from activity where entity = 'proposal' and entity_id = p::text and action = 'promoted'), 'true');

  p := pg_temp.mk(pa, au, 'open', '2026-09-01');
  perform pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  perform pg_temp.expect('a deadline already past: the task starts on its deadline, never after it',
    pg_temp.val(ha, format('(select (task).starts_on from promote_proposal(%L, %L, null, %L))', p, season, today_cph)), '2026-09-01');
  p := pg_temp.mk(pa, au, 'open', '2099-01-01');
  perform pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  perform pg_temp.expect('no day given: the club''s day (Europe/Copenhagen) is used',
    pg_temp.val(ha, format('(select (task).starts_on = (now() at time zone ''Europe/Copenhagen'')::date from promote_proposal(%L, %L))', p, season)), 'true');

  -- M2 (20260128000400): the approval covers the owner, and a start date cannot invent history.
  p := pg_temp.mk(pa, au, 'open', '2099-01-01');
  perform pg_temp.expect('a proposal that names an owner ...', pg_temp.val(au, format('(revise_proposal(%L, 1, %L::jsonb)).revision', p, jsonb_build_object('owner_id', mem))), '2');
  perform pg_temp.val(ha, format('(approve_proposal(%L, 2, ''ok'')).state', p));
  perform pg_temp.expect('... keeps that owner: promotion with another one is refused',
    pg_temp.attempt(ha, format('select promote_proposal(%L, %L, %L)', p, season, au)), 'ERROR 22023%different owner%');
  perform pg_temp.expect('... a start date years in the past is refused',
    pg_temp.attempt(ha, format('select promote_proposal(%L, %L, null, %L)', p, season, today_cph - 400)), 'ERROR 22023%starts today%');
  perform pg_temp.expect('... and so is one far in the future',
    pg_temp.attempt(ha, format('select promote_proposal(%L, %L, null, %L)', p, season, today_cph + 30)), 'ERROR 22023%starts today%');
  perform pg_temp.expect('... nothing was created by the refusals', (select count(*)::text from tasks where source_proposal = p), '0');
  perform pg_temp.expect('... but the same owner, and a reader-local day one day either side of the club''s, are accepted',
    pg_temp.attempt(ha, format('select promote_proposal(%L, %L, %L, %L)', p, season, mem, today_cph - 1)), 'ALLOWED');

  -- L1: a maintenance write to a promoted proposal keeps its approval evidence.
  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals set title = 'Renamed after promotion' where id = p;
  perform set_config('reqon.proposal_write', 'off', true);
  perform pg_temp.expect('L1: the approval evidence of a promoted proposal survives a maintenance write',
    (select (approved_revision = 2 and approved_by = ha)::text from task_proposals where id = p) || ':' ||
    (select count(*)::text from activity where entity = 'proposal' and entity_id = p::text and action = 'approval_invalidated'), 'true:0');

  -- L4: whitespace that is not a space is not text.
  p := pg_temp.mk(pa, au);
  perform pg_temp.expect('L4: a comment of newlines only is refused', pg_temp.attempt(mem, format('select add_proposal_comment(%L, %L)', p, E'\n\t \n')), 'ERROR 23514%');
  perform pg_temp.expect('L4: an approval note of newlines only is refused', pg_temp.attempt(ha, format('select approve_proposal(%L, 1, %L)', p, E'\n\n')), 'ERROR 23514%');

  -- L2: a no-op department move needs the same authority as a real one.
  perform pg_temp.expect('L2: a member cannot use a no-op department move to read a proposal back',
    pg_temp.attempt(mem, format('select set_proposal_department(%L, %L, ''noop'', 1)', p, pa)), 'DENIED');
  perform pg_temp.expect('L2: the author (before review) still may',
    pg_temp.attempt(au, format('select set_proposal_department(%L, %L, ''noop'', 1)', p, pa)), 'ALLOWED');

  -- Promotion is the only supported ordinary creation path and always supplies
  -- a start. A maintenance/import insert remains distinct and keeps an absent
  -- historical date absent rather than pretending it happened today.
  insert into tasks (season_id, title, due_date, links_required, milestone_key)
    values (season, 'P3 historical import fixture', '2099-01-01', false, ms) returning id into t;
  perform pg_temp.expect('a historical/import row with no sourced start keeps NULL',
    (select coalesce(starts_on::text, 'NULL') from tasks where id = t), 'NULL');

  -- ================================================= approve and promote, atomically
  p := pg_temp.mk(pa, au);
  before_n := (select count(*) from tasks);
  perform pg_temp.expect('approve_and_promote without a note fails', pg_temp.attempt(ha, format('select approve_and_promote(%L, %L, 1, '' '')', p, season)), 'ERROR 23514%');
  perform pg_temp.expect('... a stale revision fails', pg_temp.attempt(ha, format('select approve_and_promote(%L, %L, 9, ''ok'')', p, season)), 'ERROR 40001%');
  perform pg_temp.expect('... a wrong season fails after the approval step', pg_temp.attempt(ha, format('select approve_and_promote(%L, %L, 1, ''ok'')', p, s2)), 'ERROR 22023%');
  perform pg_temp.expect('... a retired owner fails after the approval step', pg_temp.attempt(ha, format('select approve_and_promote(%L, %L, 1, ''ok'', %L)', p, season, inactive)), 'ERROR 23514%');
  perform pg_temp.expect('... a member cannot', pg_temp.attempt(au, format('select approve_and_promote(%L, %L, 1, ''ok'')', p, season)), 'DENIED');
  perform pg_temp.expect('none of the failures left a partial approval, note or task',
    (select state::text || ':' || coalesce(approved_revision::text, '-') from task_proposals where id = p) || ':' ||
    (select count(*)::text from proposal_comments where proposal_id = p and kind = 'approval') || ':' || ((select count(*) from tasks) - before_n)::text, 'open:-:0:0');
  tid := pg_temp.val(ha, format('(select (task).id from approve_and_promote(%L, %L, 1, ''Approved and started'', null, %L))', p, season, today_cph));
  perform pg_temp.expect('the whole thing in one call: approved, one task, started on the day',
    (select (state = 'decided' and approved_by = ha)::text from task_proposals where id = p) || ':' ||
    (select count(*)::text || ':' || max(starts_on::text) from tasks where source_proposal = p), 'true:1:' || today_cph::text);
  perform pg_temp.expect('a retry returns the same task and adds no second approval',
    pg_temp.val(ha, format('(select (task).id::text || created::text from approve_and_promote(%L, %L, 1, ''again''))', p, season)) || ':' ||
    (select count(*)::text from proposal_comments where proposal_id = p and kind = 'approval'), tid || 'false:1');

  -- ============================================================ review commands
  p := pg_temp.mk(pa, au);
  perform pg_temp.expect('a member cannot take a proposal under review', pg_temp.attempt(mem, format('select review_proposal(%L, ''review'', 1)', p)), 'DENIED');
  perform pg_temp.expect('the Head takes it under review', pg_temp.val(ha, format('(review_proposal(%L, ''review'', 1)).state', p)), 'agenda');
  perform pg_temp.expect('it cannot be taken under review twice', pg_temp.attempt(ha, format('select review_proposal(%L, ''review'', 1)', p)), 'ERROR 22023%');
  perform pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  r := pg_temp.val(ha, format('(review_proposal(%L, ''park'', 1, ''Waiting for the budget'')).state', p));
  perform pg_temp.expect('parking an approved proposal withdraws the approval and keeps the note',
    r || ':' ||
    (select coalesce(approved_revision::text, '-') from task_proposals where id = p) || ':' ||
    (select count(*)::text from proposal_comments where proposal_id = p and kind = 'decision' and author_id = ha), 'parked:-:1');
  perform pg_temp.expect('a parked proposal cannot be approved or promoted', pg_temp.attempt(ha, format('select approve_proposal(%L, 1, ''ok'')', p)) || '/' ||
    pg_temp.attempt(ha, format('select promote_proposal(%L, %L)', p, season)), 'ERROR 22023: Only a suggested, under-review or changes-requested proposal can be approved./ERROR 22023: Only an approved proposal can be promoted. Reopen a parked or rejected proposal and get it approved.');
  perform pg_temp.expect('reopening a parked proposal', pg_temp.val(ha, format('(review_proposal(%L, ''reopen'', 1)).state', p)), 'open');
  perform pg_temp.val(ha, format('(approve_proposal(%L, 1, ''ok'')).state', p));
  r := pg_temp.val(ha, format('(review_proposal(%L, ''reject'', 1, ''Not this year'')).outcome', p));
  perform pg_temp.expect('rejecting an approved proposal withdraws the approval',
    r || ':' ||
    (select coalesce(approved_revision::text, '-') || ':' || (archived_at is not null)::text from task_proposals where id = p), 'rejected:-:true');
  perform pg_temp.expect('an oversize decision note is refused', pg_temp.attempt(ha, format('select review_proposal(%L, ''reopen'', 1, %L)', p, repeat('n', 2001))), 'ERROR 23514%');

  -- ============================================ regulations edition consistency
  insert into tasks (season_id, title, subteam_key, owner_id, milestone_key) values (season, 'P3 edition', pa, mem, ms) returning id into t;
  perform pg_temp.expect('a task cannot cite a rule of another edition', pg_temp.attempt(mem, format('select link_task_requirement(%L, %L)', t, cl_other)), 'ERROR 23514%edition%');
  perform pg_temp.expect('... but one of its own season''s', pg_temp.attempt(mem, format('select link_task_requirement(%L, %L)', t, cl1)), 'ALLOWED');
  perform pg_temp.expect('a proposal cannot be raised citing another edition',
    pg_temp.attempt(mem, format('select submit_proposal(%L, ''Edition check'', %L, ''2099-12-01'', %L, array[%L])', season, pa, ms, cl_other)), 'ERROR 23514%edition%');
  p := pg_temp.mk(pa, au);
  perform pg_temp.expect('nor have its requirements replaced by one', pg_temp.attempt(ha, format('select set_proposal_requirements(%L, array[%L], 1)', p, cl_other)), 'ERROR 23514%edition%');

  -- ================================================================= verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'PROPOSAL DISCUSSION CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'PROPOSAL DISCUSSION CHECKS PASSED — all % checks', total;
end
$test$;
