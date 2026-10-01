-- =============================================================================
--  Backend completion Phase 3, review fixes (step 5 of 5, task side). Follows the
--  /code-review, /react-review and database-review passes over 20260127* and
--  20260128*; nothing in an earlier file is edited.
--
--  M1  A Blocked task could be "explained" by a link to a finished, cancelled or
--      archived task, and then that link could not be removed. Only a link to an
--      UNFINISHED, active prerequisite now explains entering Blocked (guard_task_edit)
--      or protects a blocked task from losing its last explanation
--      (remove_task_dependency).
--  M2  The promoter could assign a different owner than the approved proposal named,
--      and any start date. promote_proposal now refuses an owner that differs from the
--      approved owner (a proposal with no owner can still be given one at promotion),
--      and a start date more than one day away from the club's day (Europe/Copenhagen;
--      the client sends the reader's own day, which is at most a day either side), so
--      history cannot be fabricated through the parameter.
--  L1  A maintenance write that changed a material column of an already PROMOTED
--      proposal bumped its revision and erased the approval evidence (and logged a
--      false approval_invalidated). Evidence is now cleared only while the proposal is
--      still 'approved'.
--  L2  set_proposal_department returned the row for a no-op move before checking
--      authority; the check now comes first.
--  L3  anon held UPDATE on task_proposals (and write privileges on tasks). RLS already
--      refused it; the grants are removed too.
--  L4  btrim() strips spaces only, so a comment, note or blocker reason made of newlines
--      or tabs counted as text. clean_text() strips all whitespace; the affected commands,
--      the comment stamp trigger, the comment CHECK and the blocker guard use it.
--  L5  guard_section_hierarchy read the parent and children without a lock: two
--      concurrent re-parentings could build a 3-level tree. It now takes one advisory
--      lock per milestone.
--  L6  The cycle check needs READ COMMITTED (the default of Supabase and PostgREST):
--      recorded as a comment on the function.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Close the review findings above.
--    Existing data  Untouched. The comment CHECK is re-created with the wider trim;
--                   existing rows already satisfy it (none is whitespace-only).
--    Authorization  Only tightens (owner override, start-date window, no-op ordering,
--                   anon write grants). Every function keeps its pinned search_path
--                   and its existing grants.
--    Locking        CREATE OR REPLACE FUNCTION; a CHECK swap on proposal_comments
--                   (small table); REVOKE.
--    Rollback       Re-apply the earlier definitions from 20260127000100/0200 and
--                   20260128000000/0100/0300; re-grant is not needed.
--    Deploy order   After 20260128000300.
-- =============================================================================

create or replace function clean_text(p_text text) returns text
language sql immutable parallel safe set search_path = public as $fn$
  select regexp_replace(p_text, '^\s+|\s+$', '', 'g');
$fn$;
grant execute on function clean_text(text) to authenticated, service_role;
revoke execute on function clean_text(text) from public, anon;

-- ------------------------------------------------------------------ comments
alter table proposal_comments drop constraint if exists proposal_comments_body_check;
alter table proposal_comments add constraint proposal_comments_body_check
  check (length(clean_text(body)) between 1 and 2000);

create or replace function stamp_proposal_comment() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_season uuid;
  v_revision int;
begin
  select season_id, revision into v_season, v_revision from task_proposals where id = new.proposal_id;
  if v_season is null then
    raise exception 'proposal % does not exist', new.proposal_id using errcode = '23503';
  end if;
  new.season_id := v_season;
  new.revision := v_revision;
  new.body := clean_text(new.body);
  if auth.uid() is not null then
    new.author_id := auth.uid();
  end if;
  new.created_at := now();
  return new;
end $fn$;

-- --------------------------------------------- approval evidence survives promotion
create or replace function apply_proposal_revision() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_material boolean;
  v_bumped boolean;
begin
  v_material := new.title is distinct from old.title
             or new.context is distinct from old.context
             or new.owner_id is distinct from old.owner_id
             or new.subteam_key is distinct from old.subteam_key
             or new.due_date is distinct from old.due_date
             or new.priority is distinct from old.priority
             or new.milestone_key is distinct from old.milestone_key;
  -- A command that changed the requirement set raises the revision itself.
  if new.revision < old.revision or new.revision > old.revision + 1 then
    raise exception 'A proposal revision must advance by exactly one.' using errcode = '23514';
  end if;
  v_bumped := new.revision = old.revision + 1;
  if v_material and not v_bumped then
    new.revision := old.revision + 1;
    v_bumped := true;
  end if;

  -- An approval belongs to one exact revision. Anything that moves the content
  -- while the proposal is still 'approved' withdraws it.
  if v_bumped and old.approved_revision is not null and old.state = 'approved' then
    if new.state = 'approved' then
      new.state := 'agenda';
    end if;
    new.approved_revision := null;
    new.approved_by := null;
    new.approved_at := null;
    new.approved_as := null;
    new.approved_digest := null;
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'approval_invalidated',
      jsonb_build_object('title', new.title, 'approved_revision', old.approved_revision, 'revision', new.revision));
  end if;
  return new;
end $fn$;

-- ------------------------------------------------- proposal commands (L2, L4, M2)
create or replace function set_proposal_department(
  p_proposal_id uuid,
  p_subteam_key text,
  p_reason text,
  p_expected_revision int
) returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_reason text := nullif(clean_text(coalesce(p_reason, '')), '');
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
  if v.subteam_key is not distinct from p_subteam_key then
    return v; -- a no-op, but only for someone who could have made the move
  end if;

  perform set_config('reqon.change_reason', v_reason, true);
  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals set subteam_key = p_subteam_key where id = p_proposal_id returning * into v;
  perform set_config('reqon.proposal_write', 'off', true);
  perform set_config('reqon.change_reason', '', true);
  return v;
end $fn$;
create or replace function add_proposal_comment(p_proposal_id uuid, p_body text) returns proposal_comments
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_body text := clean_text(coalesce(p_body, ''));
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
create or replace function revise_proposal(p_proposal_id uuid, p_expected_revision int, p_changes jsonb, p_note text default null)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_note text := nullif(clean_text(coalesce(p_note, '')), '');
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
    v_title := clean_text(coalesce(p_changes ->> 'title', ''));
    if length(v_title) < 1 or length(v_title) > 200 then
      raise exception 'A proposal needs a title of 1 to 200 characters.' using errcode = '23514';
    end if;
  end if;
  if p_changes ? 'description' then
    v_context := nullif(clean_text(coalesce(p_changes ->> 'description', '')), '');
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
      from jsonb_array_elements_text(p_changes -> 'requirement_keys') x where x is not null and clean_text(x) <> '';
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
create or replace function request_proposal_changes(p_proposal_id uuid, p_expected_revision int, p_note text)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_note text := clean_text(coalesce(p_note, ''));
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
create or replace function approve_proposal(p_proposal_id uuid, p_expected_revision int, p_note text)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_note text := clean_text(coalesce(p_note, ''));
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
create or replace function review_proposal(p_proposal_id uuid, p_action text, p_expected_revision int, p_note text default null)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_note text := nullif(clean_text(coalesce(p_note, '')), '');
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
  -- The approval covers the proposal's owner. A proposal that names none may be given
  -- one at promotion; one that names an owner keeps that owner.
  if p_owner_id is not null and v_prop.owner_id is not null and p_owner_id <> v_prop.owner_id then
    raise exception 'The approved proposal names a different owner. Change the owner on the proposal (which needs a new approval) instead of at promotion.'
      using errcode = '22023';
  end if;
  v_owner := coalesce(p_owner_id, v_prop.owner_id);
  if v_owner is not null and not exists (select 1 from members m where m.id = v_owner and m.status = 'active') then
    raise exception 'A task can only be assigned to an active member.' using errcode = '23514';
  end if;

  -- The task starts today (the caller's day, or the club's day, Europe/Copenhagen,
  -- when none is given) but never after its own deadline.
  if p_starts_on is not null
     and abs(p_starts_on - (now() at time zone 'Europe/Copenhagen')::date) > 1 then
    raise exception 'A new task starts today. That start date is more than a day away from today, which would invent history or a far-off start.'
      using errcode = '22023';
  end if;
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

-- --------------------------------------------------- blocker explanations (M1, L4)
create or replace function guard_task_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_internal boolean;
begin
  v_internal := coalesce(current_setting('reqon.task_lifecycle_write', true), '') = 'on';

  if TG_OP = 'INSERT' then
    -- A task created blocked (an import) gets the stamp; an explanation is not
    -- demanded of history. Only ENTERING blocked later needs one.
    if new.state = 'blocked' then
      new.blocked_since := now();
    else
      new.blocked_reason := null;
      new.blocked_since := null;
    end if;
    if new.state = 'done' then
      new.completed_at := now();
      new.completion_source := 'recorded';
    else
      new.completed_at := null;
      new.completion_source := null;
    end if;
    return new;
  end if;

  if new.state = 'done' and old.state is distinct from 'done' then
    new.completed_at := now();
    new.completion_source := 'recorded';
  elsif new.state = 'done' and old.state = 'done' then
    new.completed_at := old.completed_at;
    new.completion_source := old.completion_source;
  else
    new.completed_at := null;
    new.completion_source := null;
  end if;


  -- ---------------------------------------------------------- blocker reason
  -- Entering Blocked needs an explanation: a written reason (an EXTERNAL
  -- blocker — a supplier, a decision, an event) or at least one prerequisite
  -- task. A task that was already Blocked before this rule existed may stay so
  -- with neither; it is only asked when someone edits the reason away.
  new.blocked_reason := nullif(clean_text(coalesce(new.blocked_reason, '')), '');
  if length(new.blocked_reason) > 500 then
    raise exception 'A blocker reason can be at most 500 characters.' using errcode = '23514';
  end if;
  if new.state = 'blocked' then
    if old.state is distinct from 'blocked' then
      new.blocked_since := now();
      if new.blocked_reason is null and not exists (select 1 from task_dependencies d join tasks p on p.id = d.depends_on_task_id
                      where d.task_id = new.id and p.state not in ('done', 'cancelled') and p.archived_at is null) then
        raise exception 'Say why this task is blocked: write the reason, or link the task it is waiting for.'
          using errcode = '23514';
      end if;
    else
      new.blocked_since := old.blocked_since;
      if old.blocked_reason is not null and new.blocked_reason is null
         and not exists (select 1 from task_dependencies d join tasks p on p.id = d.depends_on_task_id
                      where d.task_id = new.id and p.state not in ('done', 'cancelled') and p.archived_at is null) then
        raise exception 'A blocked task must say why. Write the reason, link the task it is waiting for, or move it out of Blocked.'
          using errcode = '23514';
      end if;
    end if;
  else
    if old.state <> 'blocked' and new.blocked_reason is not null then
      raise exception 'A blocker reason only applies to a Blocked task.' using errcode = '23514';
    end if;
    -- Leaving Blocked closes the blocker.
    new.blocked_reason := null;
    new.blocked_since := null;
  end if;

  if not v_internal and old.archived_at is not null then
    raise exception 'This task is archived. Restore it before editing.' using errcode = '42501';
  end if;

  if not v_internal and (
    new.season_id is distinct from old.season_id
    or new.source_proposal is distinct from old.source_proposal
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.subteam_key is distinct from old.subteam_key
    or new.archived_at is distinct from old.archived_at
    or new.archived_by is distinct from old.archived_by
    or new.archive_reason is distinct from old.archive_reason
    or new.links_required is distinct from old.links_required
  ) then
    raise exception 'That field cannot be changed through an ordinary task edit.' using errcode = '42501';
  end if;

  if old.links_required and new.milestone_key is null then
    raise exception 'A task created from a proposal must keep its milestone.' using errcode = '23514';
  end if;

  if new.owner_id is distinct from old.owner_id then
    if not v_internal and not has_department_authority(old.subteam_key) then
      raise exception 'Only the Head of this task''s department (or, when it has none, the President or '
        'Vice President) or a Developer may reassign its owner.'
        using errcode = '42501';
    end if;
    if new.owner_id is not null and not exists (
      select 1 from members m where m.id = new.owner_id and m.status = 'active'
    ) then
      raise exception 'A task can only be assigned to an active member.' using errcode = '23514';
    end if;
  end if;

  if not v_internal and old.source_proposal is not null and old.due_date is not null and new.due_date is null then
    raise exception 'A promoted task''s deadline cannot be cleared. Archive or reopen it instead.'
      using errcode = '42501';
  end if;

  return new;
end $fn$;
create or replace function remove_task_dependency(p_task_id uuid, p_depends_on_task_id uuid) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v tasks%rowtype;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member can unlink tasks.' using errcode = '42501';
  end if;
  select * into v from tasks where id = p_task_id for update;
  if not found then
    raise exception 'That task does not exist.' using errcode = 'P0002';
  end if;
  if not can_edit_task(p_task_id) then
    raise exception 'You can''t change what this task waits for. Its owner, its department''s Head or a Developer can.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from task_dependencies where task_id = p_task_id and depends_on_task_id = p_depends_on_task_id) then
    return false;
  end if;
  -- Only an unfinished, active prerequisite explains a block, so only the last of
  -- those is protected; links to finished work can always be removed.
  if v.state = 'blocked' and v.blocked_reason is null
     and exists (select 1 from task_dependencies d join tasks p on p.id = d.depends_on_task_id
                  where d.task_id = p_task_id and d.depends_on_task_id = p_depends_on_task_id
                    and p.state not in ('done', 'cancelled') and p.archived_at is null)
     and (select count(*) from task_dependencies d join tasks p on p.id = d.depends_on_task_id
           where d.task_id = p_task_id and p.state not in ('done', 'cancelled') and p.archived_at is null) = 1 then
    raise exception 'This is the only thing the blocked task waits for. Write the blocker reason or move the task out of Blocked first.'
      using errcode = '23514';
  end if;
  delete from task_dependencies where task_id = p_task_id and depends_on_task_id = p_depends_on_task_id;
  return true;
end $fn$;

-- ------------------------------------------------------ subsections (L5)
create or replace function guard_section_hierarchy() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_parent milestone_sections%rowtype;
begin
  -- One lock per milestone: two re-parentings cannot both pass a check that reads the
  -- other's uncommitted change.
  perform pg_advisory_xact_lock(hashtextextended('milestone_sections:' || new.milestone_key, 0));
  if new.parent_section_id is not null then
    if TG_OP = 'UPDATE' and new.parent_section_id = new.id then
      raise exception 'A section cannot be its own parent.' using errcode = '23514';
    end if;
    select * into v_parent from milestone_sections where id = new.parent_section_id;
    if not found then
      raise exception 'The parent section does not exist.' using errcode = '23503';
    end if;
    if v_parent.parent_section_id is not null then
      raise exception 'Subsections go one level deep: “%” is already a subsection.', v_parent.name
        using errcode = '23514';
    end if;
    if v_parent.milestone_key is distinct from new.milestone_key then
      raise exception 'A subsection belongs to the same milestone as its parent section.' using errcode = '23514';
    end if;
    if TG_OP = 'UPDATE' and exists (select 1 from milestone_sections c where c.parent_section_id = new.id) then
      raise exception '“%” has subsections of its own, so it cannot become a subsection.', new.name
        using errcode = '23514';
    end if;
  end if;
  if TG_OP = 'UPDATE' and new.milestone_key is distinct from old.milestone_key
     and exists (select 1 from milestone_sections c where c.parent_section_id = new.id) then
    raise exception '“%” has subsections, so it cannot move to another milestone.', new.name
      using errcode = '23514';
  end if;
  return new;
end $fn$;

comment on function enforce_task_dependency() is
  'Refuses self-links, cross-season links, archived endpoints and circles. The circle check takes a per-season advisory lock and then reads the links with a fresh statement snapshot, which is correct under READ COMMITTED (the default of Supabase and PostgREST); a REPEATABLE READ or SERIALIZABLE caller could miss a concurrent link and must not be used for these writes.';

-- ---------------------------------------------------------------- anon writes
revoke insert, update, delete, truncate on task_proposals from anon;
revoke insert, update, delete, truncate on tasks from anon;

