-- =============================================================================
--  Backend completion Phase 3, step 3 of 4: the proposal review commands.
--  (docs/backend-completion/PERMISSIONS.md §2.3, §3.3, §5, §7.)
--
--  WHAT WAS WRONG (phase-01.md F-02, F-06, F-12, F-14).
--   * promote_proposal() created the task from a merely 'open' or 'agenda'
--     proposal: no approval, no evidence, and the reviewer could edit any field
--     (owner, deadline, milestone...) in the same breath.
--   * The author could not answer the Head: no comment, no revision.
--   * A promoted task had no start date (starts_on stayed NULL).
--   * Concurrent edits overwrote each other.
--
--  AFTER — the workflow (all commands SECURITY DEFINER, active members only):
--     add_proposal_comment(id, body)              any member, on an unresolved proposal
--     revise_proposal(id, expected_revision, changes jsonb, note)
--                                                 the author (open / under review /
--                                                 changes requested) or whoever has
--                                                 department authority (also when approved)
--     request_proposal_changes(id, expected_revision, note)
--                                                 department authority; a note is required
--     approve_proposal(id, expected_revision, note)
--                                                 department authority; a note is required;
--                                                 records revision, approver, authority and a
--                                                 content digest. Idempotent for a retry.
--     promote_proposal(id, season, owner, today)  department authority; ONLY from 'approved',
--                                                 re-checks the approved revision AND the
--                                                 content digest under the row lock; at most
--                                                 one task per proposal (idempotent); the task
--                                                 gets starts_on = min(today, deadline)
--     approve_and_promote(id, season, expected_revision, note, owner, today)
--                                                 both, in one transaction; a retry after
--                                                 success returns the same task
--     review_proposal(id, action, expected_revision, note)
--                                                 review | park | reject | reopen, optional note
--     set_proposal_requirements(id, keys, expected_revision)
--                                                 raises the revision when the set changes
--
--  DECISIONS (docs/backend-completion/PERMISSIONS.md §3.3, §5):
--   * Who approves: department_authority(department) — the Head, the parent's
--     Head, a Developer, or (only where neither the department nor its parent has
--     a Head) the President / Vice President as 'governance_fallback'. The approval
--     records which of them acted. Nothing is auto-approved and no unrelated Head
--     gains authority.
--   * An approval stays valid if the approver later loses the headship (it was valid
--     when given); PROMOTION re-checks the PROMOTER's authority under the lock, so a
--     former Head cannot promote, and the fallback stops the moment a Head is
--     appointed. A change of department invalidates the approval (the reviewer changes).
--   * Approving needs a note (stored as a discussion entry of kind 'approval').
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        The approval-gated proposal workflow.
--    Existing data  None written. Existing rows keep their state; a proposal that is
--                   already 'open' or 'agenda' now needs an approval before promotion.
--    Authorization  Every command checks in SQL after taking the proposal lock.
--                   EXECUTE is revoked from PUBLIC/anon and granted to authenticated.
--    Locking        lock_proposal_for_command(): department FOR SHARE then proposal
--                   FOR UPDATE, then a re-check, exactly as review_proposal already did.
--    Rollback       Forward recovery: re-create promote_proposal()/review_proposal()
--                   from 20260117 and drop the new functions.
--    Deploy order   After 20260127000100, with the Phase 3 client. The two functions
--                   whose signature changes (promote_proposal, review_proposal) are
--                   dropped first so no overload remains.
-- =============================================================================

drop function if exists promote_proposal(uuid, uuid, uuid);
drop function if exists review_proposal(uuid, text);
drop function if exists set_proposal_department(uuid, text, text);
drop function if exists set_proposal_requirements(uuid, text[]);

-- ---------------------------------------------------------- department move
-- The Phase 2 command gains the same revision precondition as every other
-- material edit. Dropping the old signature avoids an unguarded overload.
create or replace function set_proposal_department(
  p_proposal_id uuid,
  p_subteam_key text,
  p_reason text,
  p_expected_revision int
) returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_allowed boolean;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may move a proposal between departments.' using errcode = '42501';
  end if;
  if p_expected_revision is null then
    raise exception 'Say which revision you are moving.' using errcode = '22004';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'Say why the proposal changes department (1 to 500 characters).' using errcode = '23514';
  end if;
  if p_subteam_key is null then
    raise exception 'A proposal needs a department.' using errcode = '23502';
  end if;

  v := lock_proposal_for_command(p_proposal_id);
  if v.revision <> p_expected_revision then
    raise exception 'This proposal changed since you opened it (it is now at revision %). Reload it first.', v.revision
      using errcode = '40001';
  end if;
  if v.archived_at is not null or v.state in ('decided', 'parked') then
    raise exception 'Reopen this proposal before moving it to another department.' using errcode = '22023';
  end if;
  if v.subteam_key is not distinct from p_subteam_key then
    return v;
  end if;

  perform 1 from subteams where key = p_subteam_key for share;
  if not exists (select 1 from subteams where key = p_subteam_key and archived_at is null) then
    raise exception 'A proposal can only belong to an active department.' using errcode = '23514';
  end if;

  -- Re-evaluated only after both the proposal/source department and target
  -- department are locked. A Head appointment or revocation therefore either
  -- happens wholly before this check or waits until this command commits.
  v_allowed := is_developer()
    or (v.raised_by = auth.uid() and v.state = 'open')
    or coalesce(department_authority(v.subteam_key) = 'governance_fallback', false)
    or (v.subteam_key is not null
        and coalesce(department_authority(v.subteam_key) in ('head', 'parent_head'), false)
        and coalesce(department_authority(p_subteam_key) in ('head', 'parent_head'), false));
  if not v_allowed then
    raise exception 'Only the author (before review), a Head of both departments, a Developer, or the '
      'President or Vice President for a department without a Head may move this proposal.'
      using errcode = '42501';
  end if;

  perform set_config('reqon.change_reason', v_reason, true);
  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals set subteam_key = p_subteam_key where id = p_proposal_id returning * into v;
  perform set_config('reqon.proposal_write', 'off', true);
  perform set_config('reqon.change_reason', '', true);
  return v;
end $fn$;

-- ---------------------------------------------------------------- comments
create or replace function add_proposal_comment(p_proposal_id uuid, p_body text) returns proposal_comments
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
  c proposal_comments%rowtype;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may join a proposal''s discussion.' using errcode = '42501';
  end if;
  if length(v_body) < 1 or length(v_body) > 2000 then
    raise exception 'A comment needs 1 to 2000 characters.' using errcode = '23514';
  end if;
  select * into v from task_proposals where id = p_proposal_id for share;
  if not found then
    raise exception 'Proposal % does not exist', p_proposal_id using errcode = '23503';
  end if;
  if v.archived_at is not null or v.state = 'decided' then
    raise exception 'This proposal is closed. Its discussion is kept, but nothing more can be added.' using errcode = '22023';
  end if;
  insert into proposal_comments (proposal_id, season_id, author_id, kind, revision, body)
  values (p_proposal_id, v.season_id, auth.uid(), 'comment', v.revision, v_body)
  returning * into c;
  return c;
end $fn$;

-- ------------------------------------------------------------------ revise
create or replace function revise_proposal(p_proposal_id uuid, p_expected_revision int, p_changes jsonb, p_note text default null)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_author boolean;
  v_authority boolean;
  k text;
  v_title text; v_context text; v_owner uuid; v_due date; v_priority task_priority; v_milestone text;
  v_keys text[]; v_before text[];
  v_changed text[] := '{}';
  v_req_changed boolean := false;
  v_resubmit boolean;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may revise a proposal.' using errcode = '42501';
  end if;
  if p_expected_revision is null then
    raise exception 'Say which revision you are editing.' using errcode = '22004';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'p_changes must be a JSON object.' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('title', 'description', 'owner_id', 'due_date', 'priority', 'milestone_key', 'requirement_keys') then
      raise exception 'A proposal''s % cannot be changed here (department: set_proposal_department).', k
        using errcode = '22023';
    end if;
  end loop;
  if v_note is not null and length(v_note) > 2000 then
    raise exception 'A note needs at most 2000 characters.' using errcode = '23514';
  end if;

  v := lock_proposal_for_command(p_proposal_id);
  if v.revision <> p_expected_revision then
    raise exception 'This proposal changed since you opened it (it is now at revision %). Reload it and apply your change again.', v.revision
      using errcode = '40001';
  end if;
  if v.archived_at is not null or v.state in ('decided', 'parked') then
    raise exception 'Reopen this proposal before editing it.' using errcode = '22023';
  end if;
  v_author := v.raised_by = auth.uid();
  v_authority := has_department_authority(v.subteam_key);
  if v.state = 'approved' then
    if not v_authority then
      raise exception 'This proposal is approved. Only its reviewer can change it (which withdraws the approval); add a comment instead.'
        using errcode = '42501';
    end if;
  elsif not (v_authority or v_author) then
    raise exception 'Only the author, or whoever decides for this department, may revise this proposal.' using errcode = '42501';
  end if;

  v_title := v.title; v_context := v.context; v_owner := v.owner_id;
  v_due := v.due_date; v_priority := v.priority; v_milestone := v.milestone_key;

  if p_changes ? 'title' then
    v_title := btrim(coalesce(p_changes ->> 'title', ''));
    if length(v_title) < 1 or length(v_title) > 200 then
      raise exception 'A proposal needs a title of 1 to 200 characters.' using errcode = '23514';
    end if;
  end if;
  if p_changes ? 'description' then
    v_context := nullif(btrim(coalesce(p_changes ->> 'description', '')), '');
  end if;
  if p_changes ? 'owner_id' then
    v_owner := nullif(p_changes ->> 'owner_id', '')::uuid;
  end if;
  if p_changes ? 'due_date' then
    if nullif(p_changes ->> 'due_date', '') is null then
      raise exception 'A proposal needs a deadline.' using errcode = '23502';
    end if;
    v_due := (p_changes ->> 'due_date')::date;
  end if;
  if p_changes ? 'priority' then
    if nullif(p_changes ->> 'priority', '') is null then
      raise exception 'A proposal needs a priority (normal or urgent).' using errcode = '23502';
    end if;
    v_priority := (p_changes ->> 'priority')::task_priority;
  end if;
  if p_changes ? 'milestone_key' then
    if nullif(p_changes ->> 'milestone_key', '') is null then
      raise exception 'A proposal needs a milestone.' using errcode = '23502';
    end if;
    v_milestone := p_changes ->> 'milestone_key';
    if not exists (select 1 from milestones m where m.key = v_milestone and m.season_id = v.season_id) then
      raise exception 'That milestone belongs to another season.' using errcode = '23514';
    end if;
  end if;

  select coalesce(array_agg(clause_key order by clause_key), '{}') into v_before
    from proposal_requirements where proposal_id = p_proposal_id;
  if p_changes ? 'requirement_keys' then
    if jsonb_typeof(p_changes -> 'requirement_keys') <> 'array' then
      raise exception 'requirement_keys must be a list.' using errcode = '22023';
    end if;
    select array_agg(distinct x order by x) into v_keys
      from jsonb_array_elements_text(p_changes -> 'requirement_keys') x where x is not null and btrim(x) <> '';
    if v_keys is null or cardinality(v_keys) < 1 then
      raise exception 'A proposal needs at least one requirement.' using errcode = '23514';
    end if;
    if exists (select 1 from unnest(v_keys) x where not exists (select 1 from clauses c where c.clause_key = x)) then
      raise exception 'One of the requirements does not exist.' using errcode = '23503';
    end if;
    v_req_changed := v_keys is distinct from v_before;
  end if;

  if v_title is distinct from v.title then v_changed := array_append(v_changed, 'title'); end if;
  if v_context is distinct from v.context then v_changed := array_append(v_changed, 'description'); end if;
  if v_owner is distinct from v.owner_id then v_changed := array_append(v_changed, 'owner'); end if;
  if v_due is distinct from v.due_date then v_changed := array_append(v_changed, 'deadline'); end if;
  if v_priority is distinct from v.priority then v_changed := array_append(v_changed, 'priority'); end if;
  if v_milestone is distinct from v.milestone_key then v_changed := array_append(v_changed, 'milestone'); end if;
  if v_req_changed then v_changed := array_append(v_changed, 'requirements'); end if;

  v_resubmit := v.state = 'changes_requested';
  if cardinality(v_changed) = 0 and v_note is null and not v_resubmit then
    return v; -- nothing to save: no revision, no audit row, no false "saved"
  end if;

  perform set_config('reqon.proposal_write', 'on', true);
  if v_req_changed then
    delete from proposal_requirements where proposal_id = p_proposal_id and clause_key <> all (v_keys);
    insert into proposal_requirements (proposal_id, clause_key, created_by)
      select p_proposal_id, x, auth.uid() from unnest(v_keys) x on conflict do nothing;
  end if;
  update task_proposals
     set title = v_title, context = v_context, owner_id = v_owner, due_date = v_due,
         priority = v_priority, milestone_key = v_milestone,
         revision = case when v_req_changed then v.revision + 1 else revision end,
         state = case when v_resubmit then 'agenda'::topic_state else state end
   where id = p_proposal_id
   returning * into v;
  perform set_config('reqon.proposal_write', 'off', true);

  if v_note is not null then
    insert into proposal_comments (proposal_id, season_id, author_id, kind, revision, body)
    values (p_proposal_id, v.season_id, auth.uid(), 'revision', v.revision, v_note);
  end if;
  if cardinality(v_changed) > 0 then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), v.season_id, 'proposal', p_proposal_id::text, 'revised',
      jsonb_build_object('title', v.title, 'fields', to_jsonb(v_changed), 'revision', v.revision));
  end if;
  return v;
end $fn$;

-- --------------------------------------------------------- request changes
create or replace function request_proposal_changes(p_proposal_id uuid, p_expected_revision int, p_note text)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
  v_was_approved boolean;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may review a proposal.' using errcode = '42501';
  end if;
  if p_expected_revision is null then
    raise exception 'Say which revision you are reviewing.' using errcode = '22004';
  end if;
  v := lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only whoever decides for this proposal''s department may ask for changes.' using errcode = '42501';
  end if;
  if v.revision <> p_expected_revision then
    raise exception 'This proposal changed since you opened it (it is now at revision %). Reload it first.', v.revision
      using errcode = '40001';
  end if;
  if length(v_note) < 1 or length(v_note) > 2000 then
    raise exception 'Say what should change (1 to 2000 characters), so the author can act on it.' using errcode = '23514';
  end if;
  if v.archived_at is not null or v.state not in ('open', 'agenda', 'approved') then
    raise exception 'Changes can only be requested on a suggested, under-review or approved proposal.' using errcode = '22023';
  end if;
  v_was_approved := v.state = 'approved';

  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals
     set state = 'changes_requested', approved_revision = null, approved_by = null, approved_at = null,
         approved_as = null, approved_digest = null
   where id = p_proposal_id returning * into v;
  perform set_config('reqon.proposal_write', 'off', true);

  insert into proposal_comments (proposal_id, season_id, author_id, kind, revision, body)
  values (p_proposal_id, v.season_id, auth.uid(), 'changes_requested', v.revision, v_note);
  if v_was_approved then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), v.season_id, 'proposal', p_proposal_id::text, 'approval_withdrawn',
      jsonb_build_object('title', v.title, 'revision', v.revision));
  end if;
  return v;
end $fn$;

-- ------------------------------------------------------------------ approve
create or replace function approve_proposal(p_proposal_id uuid, p_expected_revision int, p_note text)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
  v_as text;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may approve a proposal.' using errcode = '42501';
  end if;
  if p_expected_revision is null then
    raise exception 'Say which revision you are approving.' using errcode = '22004';
  end if;
  v := lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department (or, where it has none, the President or Vice President) '
      'or a Developer may approve it.' using errcode = '42501';
  end if;
  if v.revision <> p_expected_revision then
    raise exception 'This proposal changed since you opened it (it is now at revision %). Read the change, then approve again.', v.revision
      using errcode = '40001';
  end if;
  if v.state = 'approved' and v.archived_at is null then
    return v; -- a retry of the same approval
  end if;
  if v.archived_at is not null or v.state not in ('open', 'agenda', 'changes_requested') then
    raise exception 'Only a suggested, under-review or changes-requested proposal can be approved.' using errcode = '22023';
  end if;
  if v.legacy_incomplete then
    raise exception 'This older proposal is missing required details (department, deadline, milestone or requirements). '
      'Complete them before approving it.' using errcode = '22023';
  end if;
  if v.subteam_key is null or v.due_date is null or v.milestone_key is null
     or not exists (select 1 from proposal_requirements r where r.proposal_id = p_proposal_id) then
    raise exception 'The proposal is missing its department, deadline, milestone or requirements.' using errcode = '22023';
  end if;
  if not exists (select 1 from subteams s where s.key = v.subteam_key and s.archived_at is null) then
    raise exception 'The proposal''s department is archived.' using errcode = '22023';
  end if;
  if length(v_note) < 1 or length(v_note) > 2000 then
    raise exception 'Approving needs a note (1 to 2000 characters) that says why, so the author can see it.'
      using errcode = '23514';
  end if;

  v_as := department_authority(v.subteam_key);
  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals
     set state = 'approved', approved_revision = revision, approved_by = auth.uid(), approved_at = now(),
         approved_as = v_as, approved_digest = proposal_content_digest(id)
   where id = p_proposal_id returning * into v;
  perform set_config('reqon.proposal_write', 'off', true);

  insert into proposal_comments (proposal_id, season_id, author_id, kind, revision, body)
  values (p_proposal_id, v.season_id, auth.uid(), 'approval', v.revision, v_note);
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), v.season_id, 'proposal', p_proposal_id::text, 'approved',
    jsonb_build_object('title', v.title, 'revision', v.revision, 'approved_as', v_as));
  return v;
end $fn$;

-- ------------------------------------------------------------------ promote
create or replace function promote_proposal(p_proposal_id uuid, p_season_id uuid, p_owner_id uuid default null, p_starts_on date default null)
returns table(task tasks, created boolean)
language plpgsql security definer set search_path = public as $fn$
declare
  v_prop task_proposals%rowtype;
  v_task tasks%rowtype;
  v_owner uuid;
  v_start date;
begin
  v_prop := lock_proposal_for_command(p_proposal_id);

  -- Authorized after both locks and before the idempotent early return, so a
  -- retry by someone who has since lost the headship is refused.
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department (or, where it has none, the President or Vice President) '
      'or a Developer may promote it.' using errcode = '42501';
  end if;
  if v_prop.season_id <> p_season_id then
    raise exception 'That proposal belongs to a different season than the one you are working in. '
      'Switch to its season before promoting it.' using errcode = '22023';
  end if;

  select * into v_task from tasks where source_proposal = p_proposal_id limit 1;
  if found then
    return query select v_task, false;
    return;
  end if;

  if v_prop.legacy_incomplete then
    raise exception 'This older proposal is missing required details (department, deadline, milestone or requirements). '
      'Complete them before promoting it.' using errcode = '22023';
  end if;
  if v_prop.archived_at is not null then
    raise exception 'This proposal is archived. Reopen it first.' using errcode = '22023';
  end if;
  if v_prop.state in ('open', 'agenda', 'changes_requested') then
    raise exception 'Approve the proposal first: it becomes a task only after its department''s reviewer has approved its current wording.'
      using errcode = '22023';
  end if;
  if v_prop.state <> 'approved' then
    raise exception 'Only an approved proposal can be promoted. Reopen a parked or rejected proposal and get it approved.'
      using errcode = '22023';
  end if;
  if v_prop.approved_revision is distinct from v_prop.revision
     or v_prop.approved_digest is distinct from proposal_content_digest(p_proposal_id) then
    raise exception 'The approval no longer matches the proposal: it was changed after it was approved. It needs a new approval.'
      using errcode = '40001';
  end if;
  if not exists (select 1 from subteams s where s.key = v_prop.subteam_key and s.archived_at is null) then
    raise exception 'The proposal''s department is archived.' using errcode = '22023';
  end if;
  if v_prop.due_date is null or v_prop.milestone_key is null
     or not exists (select 1 from proposal_requirements r where r.proposal_id = p_proposal_id) then
    raise exception 'The proposal is missing its deadline, milestone or requirements.' using errcode = '22023';
  end if;
  v_owner := coalesce(p_owner_id, v_prop.owner_id);
  if v_owner is not null and not exists (select 1 from members m where m.id = v_owner and m.status = 'active') then
    raise exception 'A task can only be assigned to an active member.' using errcode = '23514';
  end if;

  -- The task starts today (the caller's day, or the club's day, Europe/Copenhagen,
  -- when none is given) but never after its own deadline.
  v_start := least(coalesce(p_starts_on, (now() at time zone 'Europe/Copenhagen')::date), v_prop.due_date);

  insert into tasks (season_id, title, detail, owner_id, subteam_key, due_date, starts_on, priority,
                     milestone_key, state, source_proposal, created_by, links_required)
  values (v_prop.season_id, v_prop.title, v_prop.context, v_owner, v_prop.subteam_key, v_prop.due_date, v_start,
          v_prop.priority, v_prop.milestone_key, 'todo', p_proposal_id, auth.uid(), true)
  on conflict (source_proposal) where source_proposal is not null do nothing
  returning * into v_task;

  if not found then
    select * into v_task from tasks where source_proposal = p_proposal_id limit 1;
    return query select v_task, false;
    return;
  end if;

  insert into task_requirements (task_id, clause_key, created_by)
  select v_task.id, r.clause_key, auth.uid() from proposal_requirements r where r.proposal_id = p_proposal_id;

  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals set state = 'decided', outcome = 'approved', decided_at = now(),
    archived_at = now(), archived_by = auth.uid(), archive_reason = 'promoted'
    where id = p_proposal_id;
  perform set_config('reqon.proposal_write', 'off', true);

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), v_prop.season_id, 'proposal', p_proposal_id::text, 'promoted',
    jsonb_build_object('title', v_prop.title, 'task_id', v_task.id, 'department', v_prop.subteam_key,
      'approved_revision', v_prop.approved_revision, 'approved_as', v_prop.approved_as));
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), v_prop.season_id, 'task', v_task.id::text, 'created_from_proposal',
    jsonb_build_object('title', v_task.title, 'proposal_id', p_proposal_id));

  return query select v_task, true;
end $fn$;

-- ----------------------------------------------------- approve and promote
create or replace function approve_and_promote(p_proposal_id uuid, p_season_id uuid, p_expected_revision int, p_note text,
                                               p_owner_id uuid default null, p_starts_on date default null)
returns table(task tasks, created boolean)
language plpgsql security definer set search_path = public as $fn$
declare
  v_task tasks%rowtype;
begin
  perform lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department (or, where it has none, the President or Vice President) '
      'or a Developer may approve and promote it.' using errcode = '42501';
  end if;
  -- A retry after the whole thing succeeded returns the same task.
  select * into v_task from tasks where source_proposal = p_proposal_id limit 1;
  if found then
    return query select v_task, false;
    return;
  end if;
  perform approve_proposal(p_proposal_id, p_expected_revision, p_note);
  return query select * from promote_proposal(p_proposal_id, p_season_id, p_owner_id, p_starts_on);
end $fn$;

-- ------------------------------------------------------------------ review
create or replace function review_proposal(p_proposal_id uuid, p_action text, p_expected_revision int, p_note text default null)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_expected_revision is null then
    raise exception 'Say which revision you are reviewing.' using errcode = '22004';
  end if;
  v := lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department (or, where it has none, the President or Vice President) '
      'or a Developer may review it.' using errcode = '42501';
  end if;
  if v.revision <> p_expected_revision then
    raise exception 'This proposal changed since you opened it (it is now at revision %). Reload it first.', v.revision
      using errcode = '40001';
  end if;
  if v_note is not null and length(v_note) > 2000 then
    raise exception 'A note needs at most 2000 characters.' using errcode = '23514';
  end if;

  perform set_config('reqon.proposal_write', 'on', true);
  if p_action = 'review' then
    if v.archived_at is not null or v.state <> 'open' then
      raise exception 'Only a suggested proposal can be taken under review.' using errcode = '22023';
    end if;
    update task_proposals set state = 'agenda' where id = p_proposal_id returning * into v;
  elsif p_action = 'park' then
    if v.archived_at is not null or v.state not in ('open', 'agenda', 'changes_requested', 'approved') then
      raise exception 'Only a suggested, under-review, changes-requested or approved proposal can be parked.' using errcode = '22023';
    end if;
    update task_proposals set state = 'parked', approved_revision = null, approved_by = null, approved_at = null,
      approved_as = null, approved_digest = null where id = p_proposal_id returning * into v;
  elsif p_action = 'reject' then
    if v.archived_at is not null or v.state not in ('open', 'agenda', 'changes_requested', 'approved') then
      raise exception 'Only a suggested, under-review, changes-requested or approved proposal can be rejected.' using errcode = '22023';
    end if;
    update task_proposals set state = 'decided', outcome = 'rejected', archived_at = now(),
      archived_by = auth.uid(), archive_reason = 'rejected', approved_revision = null, approved_by = null,
      approved_at = null, approved_as = null, approved_digest = null
      where id = p_proposal_id returning * into v;
  elsif p_action = 'reopen' then
    if not (v.state = 'parked'
            or (v.state = 'decided' and v.outcome is distinct from 'approved'
                and not exists (select 1 from tasks t where t.source_proposal = p_proposal_id))) then
      raise exception 'Only a parked or rejected proposal can be reopened.' using errcode = '22023';
    end if;
    update task_proposals set state = 'open', outcome = null, decided_at = null,
      archived_at = null, archived_by = null, archive_reason = null
      where id = p_proposal_id returning * into v;
  else
    perform set_config('reqon.proposal_write', 'off', true);
    raise exception 'Unknown review action "%". Use review, park, reject or reopen.', p_action
      using errcode = '22023';
  end if;
  perform set_config('reqon.proposal_write', 'off', true);

  if v_note is not null then
    insert into proposal_comments (proposal_id, season_id, author_id, kind, revision, body)
    values (p_proposal_id, v.season_id, auth.uid(), 'decision', v.revision, v_note);
  end if;
  return v;
end $fn$;

-- ------------------------------------------------ requirements (revision-aware)
create or replace function set_proposal_requirements(p_proposal_id uuid, p_clause_keys text[], p_expected_revision int) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_keys text[];
  v_before text[];
begin
  if p_expected_revision is null then
    raise exception 'Say which revision you are editing.' using errcode = '22004';
  end if;
  v := lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department (or, where it has none, the President or Vice President) '
      'or a Developer may change its requirements.' using errcode = '42501';
  end if;
  if v.revision <> p_expected_revision then
    raise exception 'This proposal changed since you opened it (it is now at revision %). Reload it first.', v.revision
      using errcode = '40001';
  end if;
  if v.archived_at is not null or v.state in ('decided', 'parked') then
    raise exception 'This proposal is closed. Reopen it before editing.' using errcode = '22023';
  end if;
  select array_agg(distinct k order by k) into v_keys
    from unnest(coalesce(p_clause_keys, '{}'::text[])) as k where k is not null;
  if v_keys is null or cardinality(v_keys) < 1 then
    raise exception 'A proposal needs at least one requirement.' using errcode = '23514';
  end if;
  if exists (select 1 from unnest(v_keys) k where not exists (select 1 from clauses c where c.clause_key = k)) then
    raise exception 'One of the requirements does not exist.' using errcode = '23503';
  end if;

  select coalesce(array_agg(clause_key order by clause_key), '{}') into v_before
    from proposal_requirements where proposal_id = p_proposal_id;
  perform set_config('reqon.proposal_write', 'on', true);
  delete from proposal_requirements where proposal_id = p_proposal_id and clause_key <> all (v_keys);
  insert into proposal_requirements (proposal_id, clause_key, created_by)
    select p_proposal_id, k, auth.uid() from unnest(v_keys) as k
    on conflict do nothing;
  if v_before is distinct from v_keys then
    -- A changed requirement set is a new revision (and withdraws an approval).
    update task_proposals set revision = revision + 1 where id = p_proposal_id;
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), v.season_id, 'proposal', p_proposal_id::text, 'requirements_changed',
      jsonb_build_object('title', v.title, 'from', to_jsonb(v_before), 'to', to_jsonb(v_keys)));
  elsif v.legacy_incomplete then
    update task_proposals set title = title where id = p_proposal_id;
  end if;
  perform set_config('reqon.proposal_write', 'off', true);
end $fn$;

-- -------------------------------------------------------------- star flag
-- Close direct table UPDATE for authenticated callers below, so nobody can
-- bypass the expected-revision commands by setting the internal custom GUC in
-- their own session.  This narrow command preserves the existing reviewer
-- star without reopening material columns.
create or replace function set_proposal_star(p_proposal_id uuid, p_starred boolean)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
begin
  if p_starred is null then
    raise exception 'A proposal star must be true or false.' using errcode = '22004';
  end if;
  v := lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only whoever reviews this proposal may change its star.' using errcode = '42501';
  end if;
  if v.archived_at is not null then
    raise exception 'An archived proposal cannot be changed.' using errcode = '22023';
  end if;
  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals set starred = p_starred where id = p_proposal_id returning * into v;
  perform set_config('reqon.proposal_write', 'off', true);
  return v;
end $fn$;

-- ------------------------------------------------------------------- grants
revoke all on function add_proposal_comment(uuid, text) from public, anon;
revoke all on function set_proposal_department(uuid, text, text, int) from public, anon;
revoke all on function revise_proposal(uuid, int, jsonb, text) from public, anon;
revoke all on function request_proposal_changes(uuid, int, text) from public, anon;
revoke all on function approve_proposal(uuid, int, text) from public, anon;
revoke all on function promote_proposal(uuid, uuid, uuid, date) from public, anon;
revoke all on function approve_and_promote(uuid, uuid, int, text, uuid, date) from public, anon;
revoke all on function review_proposal(uuid, text, int, text) from public, anon;
revoke all on function set_proposal_requirements(uuid, text[], int) from public, anon;
revoke all on function set_proposal_star(uuid, boolean) from public, anon;
grant execute on function add_proposal_comment(uuid, text) to authenticated, service_role;
grant execute on function set_proposal_department(uuid, text, text, int) to authenticated, service_role;
grant execute on function revise_proposal(uuid, int, jsonb, text) to authenticated, service_role;
grant execute on function request_proposal_changes(uuid, int, text) to authenticated, service_role;
grant execute on function approve_proposal(uuid, int, text) to authenticated, service_role;
grant execute on function promote_proposal(uuid, uuid, uuid, date) to authenticated, service_role;
grant execute on function approve_and_promote(uuid, uuid, int, text, uuid, date) to authenticated, service_role;
grant execute on function review_proposal(uuid, text, int, text) to authenticated, service_role;
grant execute on function set_proposal_requirements(uuid, text[], int) to authenticated, service_role;
grant execute on function set_proposal_star(uuid, boolean) to authenticated, service_role;

-- All proposal writes now go through the commands above.  RLS remains as a
-- second line of defence, but table UPDATE is intentionally unavailable to an
-- authenticated API session so a caller cannot opt out of stale-write checks.
revoke update on task_proposals from authenticated;
