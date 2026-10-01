-- =============================================================================
--  Role hierarchy: the President and the Vice President act in EVERY department.
--
--  Purpose. The user's decision of 2026-10-01: Developer > President > Vice
--  President > Head of department > member, with the Treasurer a separate
--  finance lane. Until now (20260126000200) the President/VP had department
--  authority only where a department had no Head ('governance_fallback'). From
--  this migration an active President or Vice President has the same authority
--  as a Head over the work of every non-archived department, and over work with
--  no department: edit and reassign any task, archive and restore it, move it
--  between departments, review / approve / promote / park / reject proposals,
--  manage department members, confirm spec readiness. Supersedes R5.3 / ADR-0003
--  ("President or VP alone never edit tasks or promote") and PERMISSIONS §3.3
--  (fallback only). Season and role powers are unchanged (President over VP:
--  can_manage_seasons, can_grant_role). Finance is unchanged (Treasurer and
--  Developer write; President and VP read). Members are unchanged.
--
--  How. One predicate decides department authority everywhere
--  (department_authority(); every check calls it or has_department_authority()),
--  so only it changes: after head / parent_head / developer it now returns
--  'president' or 'vicepresident' (highest rank first) for an active holder, for
--  any non-archived department or for unassigned work. The authority kind is
--  stored with an approval (task_proposals.approved_as), so the CHECK gains the
--  two kinds; 'governance_fallback' stays allowed because existing approvals carry
--  it (history is never rewritten). set_proposal_department compared the kind with
--  'governance_fallback' by name and now compares with the two new kinds. Seven
--  commands are re-created only to correct their refusal wording ("where it has
--  none"), which members see verbatim; their logic is byte-for-byte the applied one.
--
--  Existing data. None changes. No row is rewritten; old approvals keep
--  'governance_fallback'. A retired President/VP still has no authority
--  (has_role() requires an active member), and an archived department still gives
--  them none.
--
--  Authorization. Functions keep their ACLs (CREATE OR REPLACE): definer, pinned
--  search_path, EXECUTE for authenticated/service_role only, none for anon.
--
--  Locking. The constraint is dropped and re-added on task_proposals (a brief
--  ACCESS EXCLUSIVE lock on a table of a few dozen rows; validation is a scan of
--  those rows). Function replacement takes no table lock. Commands keep their own
--  locks and re-check authority after locking, as before.
--
--  Rollback / forward recovery. Forward only. To return to the fallback rule,
--  re-create department_authority() and set_proposal_department() from
--  20260126000700 / 20260128000400; approvals stored as 'president' or
--  'vicepresident' stay valid history and the CHECK must keep allowing them.
--
--  Deploy order. After 20260129000700. The frontend that shows the matching
--  controls (src/data/useTaskActor.ts, src/auth/permissions.ts) can be deployed
--  before or after: an older client only shows fewer controls to the President/VP.
-- =============================================================================

create or replace function public.department_authority(p_key text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_dept subteams%rowtype;
  v_parent subteams%rowtype;
begin
  if v_uid is null or not is_active_member() then
    return null;
  end if;

  if p_key is null then
    -- Work not yet assigned to any department.
    if is_developer() then return 'developer'; end if;
    if has_role('president') then return 'president'; end if;
    if has_role('vicepresident') then return 'vicepresident'; end if;
    return null;
  end if;

  select * into v_dept from subteams where key = p_key;
  if not found then
    return case when is_developer() then 'developer' end;
  end if;
  if v_dept.parent_key is not null then
    select * into v_parent from subteams where key = v_dept.parent_key;
  end if;

  if v_dept.archived_at is null then
    if v_dept.lead_id = v_uid then
      return 'head';
    end if;
    if v_parent.key is not null and v_parent.archived_at is null and v_parent.lead_id = v_uid then
      return 'parent_head';
    end if;
  end if;

  if is_developer() then
    return 'developer';
  end if;

  -- The President and the Vice President rank above every Head: authority over every
  -- non-archived department, whether or not it has a Head (role hierarchy, 2026-10-01).
  if v_dept.archived_at is null then
    if has_role('president') then return 'president'; end if;
    if has_role('vicepresident') then return 'vicepresident'; end if;
  end if;
  return null;
end
$function$;

comment on function public.department_authority(text) is
  'Department authority of the caller over department p_key (NULL = unassigned work): head, parent_head, developer, '
  'president or vicepresident (any non-archived department), or NULL. The one predicate every department-scoped '
  'check uses. Role hierarchy 20260130000000.';

alter table public.task_proposals drop constraint task_proposals_approval_known_authority;
alter table public.task_proposals add constraint task_proposals_approval_known_authority
  check (approved_as is null or approved_as in ('head', 'parent_head', 'governance_fallback', 'developer', 'president', 'vicepresident'));

comment on column public.task_proposals.approved_as is
  'The authority the approver acted with: head, parent_head, developer, president or vicepresident '
  '(governance_fallback on approvals given before 20260130000000, when the President/VP acted only where a department had no Head).';

-- approve_proposal: unchanged except the refusal wording.
CREATE OR REPLACE FUNCTION public.approve_proposal(p_proposal_id uuid, p_expected_revision integer, p_note text)
 RETURNS task_proposals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception 'Only the Head of this proposal''s department, the President, the Vice President '
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
end $function$;

-- set_proposal_requirements: unchanged except the refusal wording.
CREATE OR REPLACE FUNCTION public.set_proposal_requirements(p_proposal_id uuid, p_clause_keys text[], p_expected_revision integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception 'Only the Head of this proposal''s department, the President, the Vice President '
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
end $function$;

-- review_proposal: unchanged except the refusal wording.
CREATE OR REPLACE FUNCTION public.review_proposal(p_proposal_id uuid, p_action text, p_expected_revision integer, p_note text DEFAULT NULL::text)
 RETURNS task_proposals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v task_proposals%rowtype;
  v_note text := nullif(clean_text(coalesce(p_note, '')), '');
begin
  if p_expected_revision is null then
    raise exception 'Say which revision you are reviewing.' using errcode = '22004';
  end if;
  v := lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department, the President, the Vice President '
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
end $function$;

-- promote_proposal: unchanged except the refusal wording.
CREATE OR REPLACE FUNCTION public.promote_proposal(p_proposal_id uuid, p_season_id uuid, p_owner_id uuid DEFAULT NULL::uuid, p_starts_on date DEFAULT NULL::date)
 RETURNS TABLE(task tasks, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception 'Only the Head of this proposal''s department, the President, the Vice President '
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
end $function$;

-- approve_and_promote: unchanged except the refusal wording.
CREATE OR REPLACE FUNCTION public.approve_and_promote(p_proposal_id uuid, p_season_id uuid, p_expected_revision integer, p_note text, p_owner_id uuid DEFAULT NULL::uuid, p_starts_on date DEFAULT NULL::date)
 RETURNS TABLE(task tasks, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_task tasks%rowtype;
begin
  perform lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department, the President, the Vice President '
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
end $function$;

-- guard_task_edit: unchanged except the refusal wording.
CREATE OR REPLACE FUNCTION public.guard_task_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      raise exception 'Only the Head of this task''s department, the President, the Vice President '
        'or a Developer may reassign its owner.'
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
end $function$;

-- archive_task: unchanged except the refusal wording.
CREATE OR REPLACE FUNCTION public.archive_task(p_task_id uuid, p_reason text DEFAULT 'manual'::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_task tasks%rowtype;
begin
  if p_reason is not null and p_reason <> 'manual' then
    raise exception 'A task archived by a person is always a manual archive; only the scheduler archives automatically.'
      using errcode = '22023';
  end if;

  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task % does not exist', p_task_id using errcode = '23503';
  end if;
  if v_task.archived_at is not null then
    raise exception 'This task is already archived' using errcode = '22023';
  end if;
  if not has_department_authority(v_task.subteam_key) then
    raise exception 'Only the Head of this task''s department, the President, the Vice President '
      'or a Developer may archive it'
      using errcode = '42501';
  end if;

  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks
  set archived_at = now(), archived_by = auth.uid(), archive_reason = 'manual'
  where id = p_task_id
  returning * into v_task;
  perform set_config('reqon.task_lifecycle_write', 'off', true);

  return v_task;
end $function$;

-- set_proposal_department: unchanged except the refusal wording and the authority comparison.
CREATE OR REPLACE FUNCTION public.set_proposal_department(p_proposal_id uuid, p_subteam_key text, p_reason text, p_expected_revision integer)
 RETURNS task_proposals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    or coalesce(department_authority(v.subteam_key) in ('president', 'vicepresident'), false)
    or (v.subteam_key is not null
        and coalesce(department_authority(v.subteam_key) in ('head', 'parent_head'), false)
        and coalesce(department_authority(p_subteam_key) in ('head', 'parent_head'), false));
  if not v_allowed then
    raise exception 'Only the author (before review), a Head of both departments, the President, the Vice President '
      'or a Developer may move this proposal.'
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
end $function$;
