-- =============================================================================
--  Traceability links and atomic proposal commands.
--
--  Reqon redesign Phase 3 (docs/redesign/adr/0005-proposal-state-machine-and-
--  promotion.md, 0006-traceability-and-progress.md, 0003-permission-model.md).
--
--  WHAT WAS WRONG (docs/redesign/BASELINE.md V8, V9, V15, V19, V10):
--    * A proposal had no department, deadline, priority, milestone or
--      requirements, so a Head could not own its review and nothing said what
--      work it was meant to satisfy.
--    * "decided" did not say whether a proposal was approved or rejected.
--    * promote_proposal() was gated on is_admin() (President/VP/Developer),
--      accepted any starting state and lane, and let a task appear with no
--      links to anything.
--    * A task reached a milestone only through section_id, nothing checked the
--      section was in the task's season, and deleting a section silently
--      unlinked its tasks (ON DELETE SET NULL).
--
--  WHAT THIS DOES
--    * task_requirements / proposal_requirements: many-to-many links keyed by
--      clauses.clause_key (never printed_ref, which is not unique).
--    * tasks.milestone_key + a trigger that keeps it consistent with the
--      task's season and with section_id; section re-parenting is refused
--      while tasks reference the section; tasks.section_id no longer nulls
--      itself when a section disappears.
--    * task_proposals gains department, deadline, priority, milestone,
--      outcome (approved|rejected), archive metadata and a server-set
--      legacy_incomplete flag. context stays the description, owner_id stays
--      the proposed owner.
--    * submit_proposal(): the only way to create a proposal. review_proposal():
--      review / park / reject / reopen. set_proposal_requirements(),
--      link_task_requirement(), unlink_task_requirement(). promote_proposal()
--      is extended in place (old signature dropped): Head-of-department or
--      Developer only, one transaction, requirements copied, proposal archived.
--    * proposal_insert / proposal_delete policies are removed; proposal_update
--      becomes department-scoped and a guard trigger fences protected columns.
--    * guard_department_archive() and reconciliation_preflight() now count
--      unresolved proposals (the half Phase 1 deferred).
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        See above.
--    Existing data  Every existing proposal is kept and gets
--                   legacy_incomplete = true: it stays readable and cannot be
--                   promoted until a permitted repair supplies the missing
--                   department, deadline, milestone and requirement. Nothing
--                   is invented. A proposal that already has a task
--                   (tasks.source_proposal) becomes state decided, outcome
--                   approved, archived with reason promoted_legacy at its
--                   decided_at (or the migration time when decided_at is
--                   missing; the basis is written to the activity trail), and
--                   takes its department and milestone from that task when the
--                   task has them. Decided proposals with no task keep
--                   outcome NULL (shown "Decided (outcome not recorded)"), not
--                   assumed rejected. tasks.milestone_key is backfilled from
--                   the task's section only when the section's milestone is in
--                   the task's own season. No task becomes links_required.
--    Authorization  can_review_proposal(id): the active Head of the proposal's
--                   active department, or a Developer. President/VP alone gain
--                   no proposal power. submit_proposal: any active member.
--                   link/unlink: can_edit_task(). Every command is SECURITY
--                   DEFINER, search_path pinned, EXECUTE revoked from
--                   public/anon and granted to authenticated only.
--    Locking        Commands lock in one order: department row (FOR SHARE),
--                   then the proposal row (FOR UPDATE). A Head replacement or
--                   a department archive is an UPDATE of the department row
--                   and therefore waits for, or is waited on by, a promotion;
--                   authorization is evaluated AFTER both locks, so it sees
--                   the committed outcome of whichever came first. unlink
--                   locks the task row so two unlinks cannot both pass the
--                   last-link check.
--    Rollback       Forward recovery only. The columns and tables are
--                   additive; dropping them discards links and outcomes. The
--                   promote_proposal signature change cannot be reverted
--                   without redeploying the previous client.
--    Deploy order   After 20260116. Deploy the Phase 3 client with it: the old
--                   client's direct proposal INSERT and its five-argument
--                   promote_proposal call are refused.
-- =============================================================================

-- ------------------------------------------------------------ 1. proposals
do $$ begin
  create type proposal_outcome as enum ('approved', 'rejected');
exception when duplicate_object then null; end $$;

alter table task_proposals
  add column if not exists subteam_key text references subteams(key) on delete restrict,
  add column if not exists due_date date,
  add column if not exists priority task_priority not null default 'normal',
  add column if not exists milestone_key text references milestones(key),
  add column if not exists outcome proposal_outcome,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references members(id) on delete set null,
  add column if not exists archive_reason text,
  add column if not exists legacy_incomplete boolean not null default false;

create index if not exists task_proposals_subteam on task_proposals (subteam_key);
create index if not exists task_proposals_milestone on task_proposals (milestone_key);
create index if not exists task_proposals_active on task_proposals (season_id, archived_at);

-- --------------------------------------------------------------- 2. tasks
alter table tasks
  add column if not exists milestone_key text references milestones(key),
  add column if not exists links_required boolean not null default false;
create index if not exists tasks_milestone on tasks (milestone_key);

-- A section can no longer vanish out from under its tasks (V10). NO ACTION
-- rather than RESTRICT so deleting a whole season, which cascades to both
-- tasks and sections in one statement, still works; deleting a referenced
-- section or milestone on its own is refused at the end of the statement.
alter table tasks drop constraint if exists tasks_section_id_fkey;
alter table tasks add constraint tasks_section_id_fkey
  foreign key (section_id) references milestone_sections(id) on delete no action;

-- ------------------------------------------------ 3. requirement link tables
create table if not exists task_requirements (
  task_id uuid not null references tasks(id) on delete cascade,
  clause_key text not null references clauses(clause_key) on delete restrict,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (task_id, clause_key)
);
create index if not exists task_requirements_clause on task_requirements (clause_key);

create table if not exists proposal_requirements (
  proposal_id uuid not null references task_proposals(id) on delete cascade,
  clause_key text not null references clauses(clause_key) on delete restrict,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (proposal_id, clause_key)
);
create index if not exists proposal_requirements_clause on proposal_requirements (clause_key);

alter table task_requirements enable row level security;
alter table proposal_requirements enable row level security;
revoke insert, update, delete, truncate on task_requirements from anon, authenticated;
revoke insert, update, delete, truncate on proposal_requirements from anon, authenticated;
drop policy if exists member_read on task_requirements;
drop policy if exists member_read on proposal_requirements;
create policy member_read on task_requirements for select to authenticated using (is_member());
create policy member_read on proposal_requirements for select to authenticated using (is_member());

comment on table task_requirements is
  'Which requirements (clauses) a task serves. Written only by link_task_requirement / unlink_task_requirement / promote_proposal.';
comment on table proposal_requirements is
  'Which requirements (clauses) a proposal cites. Written only by submit_proposal / set_proposal_requirements.';

-- ------------------------------------------------------- 4. backfill (legacy)
-- Triggers that would rewrite updated_at, refuse edits to archived rows, or
-- log a second event for what is one migration step are paused around the
-- backfill only. This migration writes its own activity rows below.
alter table tasks disable trigger trg_guard_task_edit;
alter table tasks disable trigger trg_touch_tasks;
alter table task_proposals disable trigger trg_log_proposal_decision;
alter table task_proposals disable trigger trg_topic_decided;
alter table task_proposals disable trigger trg_touch_topics;

update tasks t set milestone_key = s.milestone_key
from milestone_sections s
join milestones m on m.key = s.milestone_key
where t.section_id = s.id and t.milestone_key is null and m.season_id = t.season_id;

insert into activity (season_id, entity, entity_id, action, detail)
select p.season_id, 'proposal', p.id::text, 'legacy_archived',
  jsonb_build_object('title', p.title, 'task_id', t.id,
    'basis', case when p.decided_at is null then 'migration_time' else 'decided_at' end)
from task_proposals p
join tasks t on t.source_proposal = p.id;

update task_proposals p set
  state = 'decided',
  outcome = 'approved',
  decided_at = coalesce(p.decided_at, now()),
  archived_at = coalesce(p.decided_at, now()),
  archive_reason = 'promoted_legacy',
  subteam_key = coalesce(p.subteam_key,
    (select t.subteam_key from tasks t
      where t.source_proposal = p.id
        and exists (select 1 from subteams s where s.key = t.subteam_key))),
  milestone_key = coalesce(p.milestone_key,
    (select t.milestone_key from tasks t where t.source_proposal = p.id))
where exists (select 1 from tasks t where t.source_proposal = p.id);

update task_proposals set legacy_incomplete = true;

alter table tasks enable trigger trg_guard_task_edit;
alter table tasks enable trigger trg_touch_tasks;
alter table task_proposals enable trigger trg_log_proposal_decision;
alter table task_proposals enable trigger trg_topic_decided;
alter table task_proposals enable trigger trg_touch_topics;

do $$ begin
  alter table task_proposals add constraint task_proposals_archive_reason_known
    check (archive_reason is null or archive_reason in ('promoted', 'promoted_legacy', 'rejected'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table task_proposals add constraint task_proposals_outcome_needs_decided
    check (outcome is null or state = 'decided');
exception when duplicate_object then null; end $$;

-- ------------------------------------- 5. task milestone / section consistency
create or replace function enforce_task_milestone_consistency() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_section_milestone text;
begin
  if TG_OP = 'UPDATE'
     and new.milestone_key is not distinct from old.milestone_key
     and new.section_id is not distinct from old.section_id
     and new.season_id is not distinct from old.season_id then
    return new; -- an ordinary edit; legacy rows are not re-judged
  end if;

  if new.section_id is not null then
    select s.milestone_key into v_section_milestone
      from milestone_sections s where s.id = new.section_id;
    if new.milestone_key is null then
      new.milestone_key := v_section_milestone;
    elsif new.milestone_key <> v_section_milestone then
      raise exception 'That section belongs to milestone %, but the task is on milestone %. '
        'Change the milestone and the section together, or unlink the section first.',
        v_section_milestone, new.milestone_key using errcode = '23514';
    end if;
  end if;

  if new.milestone_key is not null and not exists (
    select 1 from milestones m where m.key = new.milestone_key and m.season_id = new.season_id
  ) then
    raise exception 'Milestone % does not belong to this task''s season.', new.milestone_key
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_task_milestone_consistency on tasks;
create trigger trg_task_milestone_consistency before insert or update on tasks
  for each row execute function enforce_task_milestone_consistency();

create or replace function guard_section_parent() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.milestone_key is distinct from old.milestone_key
     and exists (select 1 from tasks t where t.section_id = old.id) then
    raise exception 'This section still has tasks linked to it, so it cannot move to another milestone. '
      'Unlink them first.' using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guard_section_parent on milestone_sections;
create trigger trg_guard_section_parent before update of milestone_key on milestone_sections
  for each row execute function guard_section_parent();

-- ----------------------------------- 6. promoted work keeps its required links
create or replace function assert_task_links(p_task_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v tasks%rowtype;
begin
  select * into v from tasks where id = p_task_id;
  if not found then return; end if;
  if v.links_required and (
    v.milestone_key is null
    or not exists (select 1 from task_requirements r where r.task_id = p_task_id)
  ) then
    raise exception 'A task created from a proposal must keep its milestone and at least one requirement.'
      using errcode = '23514';
  end if;
end $fn$;

create or replace function check_task_links_after_task() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  perform assert_task_links(new.id);
  return null;
end $fn$;

create or replace function check_task_links_after_link() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  perform assert_task_links(old.task_id);
  return null;
end $fn$;

drop trigger if exists trg_task_required_links on tasks;
create constraint trigger trg_task_required_links after insert or update of milestone_key, links_required on tasks
  deferrable initially deferred for each row execute function check_task_links_after_task();
drop trigger if exists trg_task_required_links_link on task_requirements;
create constraint trigger trg_task_required_links_link after update or delete on task_requirements
  deferrable initially deferred for each row execute function check_task_links_after_link();

create or replace function log_task_requirement_link() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_task uuid := case when TG_OP = 'DELETE' then old.task_id else new.task_id end;
  v_key text := case when TG_OP = 'DELETE' then old.clause_key else new.clause_key end;
  v_season uuid;
begin
  select season_id into v_season from tasks where id = v_task;
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), v_season, 'task', v_task::text,
    case when TG_OP = 'DELETE' then 'requirement_unlinked' else 'requirement_linked' end,
    jsonb_build_object('clause_key', v_key));
  return null;
end $fn$;

drop trigger if exists trg_log_task_requirement_link on task_requirements;
create trigger trg_log_task_requirement_link after insert or delete on task_requirements
  for each row execute function log_task_requirement_link();

-- ------------------------------------------------ 7. guard_task_edit (extended)
-- Same as 20260116 plus: links_required is server-controlled, and a task that
-- requires its links can never have its milestone cleared (unlinking a section
-- must leave the milestone in place).
create or replace function guard_task_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_internal boolean;
  v_head boolean;
begin
  v_internal := coalesce(current_setting('reqon.task_lifecycle_write', true), '') = 'on';

  if TG_OP = 'INSERT' then
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
    v_head := old.subteam_key is not null and is_department_head(old.subteam_key);
    if not v_internal and not (v_head or is_developer()) then
      raise exception 'Only the Head of this department or a Developer may reassign this task''s owner.'
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

-- -------------------------------------------------------- 8. proposal authority
create or replace function can_review_proposal(p_proposal_id uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select is_active_member() and exists (
    select 1 from task_proposals p
    where p.id = p_proposal_id
      and ((p.subteam_key is not null and is_department_head(p.subteam_key)) or is_developer())
  );
$fn$;

-- Direct UPDATEs (title, description, owner, decision note, star, deadline,
-- priority, milestone) stay possible for the reviewer; everything that carries
-- meaning (state, outcome, archive, provenance, the legacy flag) moves only
-- through the commands below, which set reqon.proposal_write.
create or replace function guard_proposal_edit() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_internal boolean := coalesce(current_setting('reqon.proposal_write', true), '') = 'on';
begin
  if not v_internal then
    if old.archived_at is not null then
      raise exception 'This proposal is archived. Reopen it before editing.' using errcode = '42501';
    end if;
    if new.season_id is distinct from old.season_id
       or new.raised_by is distinct from old.raised_by
       or new.raised_on is distinct from old.raised_on
       or new.state is distinct from old.state
       or new.decided_at is distinct from old.decided_at
       or new.outcome is distinct from old.outcome
       or new.archived_at is distinct from old.archived_at
       or new.archived_by is distinct from old.archived_by
       or new.archive_reason is distinct from old.archive_reason
       or new.legacy_incomplete is distinct from old.legacy_incomplete then
      raise exception 'That field cannot be changed through an ordinary proposal edit.' using errcode = '42501';
    end if;
    if new.subteam_key is distinct from old.subteam_key and not is_developer() then
      raise exception 'Only a Developer may move a proposal to another department.' using errcode = '42501';
    end if;
    if (old.subteam_key is not null and new.subteam_key is null)
       or (old.due_date is not null and new.due_date is null)
       or (old.milestone_key is not null and new.milestone_key is null) then
      raise exception 'A proposal must keep its department, deadline and milestone.' using errcode = '23514';
    end if;
  end if;

  if new.subteam_key is distinct from old.subteam_key and new.subteam_key is not null
     and not exists (select 1 from subteams s where s.key = new.subteam_key and s.archived_at is null) then
    raise exception 'A proposal can only belong to an active department.' using errcode = '23514';
  end if;
  if new.owner_id is distinct from old.owner_id and new.owner_id is not null
     and not exists (select 1 from members m where m.id = new.owner_id and m.status = 'active') then
    raise exception 'A proposal can only be given to an active member.' using errcode = '23514';
  end if;
  if new.milestone_key is distinct from old.milestone_key and new.milestone_key is not null
     and not exists (select 1 from milestones m where m.key = new.milestone_key and m.season_id = new.season_id) then
    raise exception 'That milestone belongs to another season.' using errcode = '23514';
  end if;

  if old.legacy_incomplete and new.legacy_incomplete
     and new.subteam_key is not null and new.due_date is not null and new.milestone_key is not null
     and exists (select 1 from proposal_requirements r where r.proposal_id = new.id) then
    new.legacy_incomplete := false;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guard_proposal_edit on task_proposals;
create trigger trg_guard_proposal_edit before update on task_proposals
  for each row execute function guard_proposal_edit();

create or replace function log_proposal_decision() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.state is distinct from old.state or new.decision is distinct from old.decision then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text,
      case when new.state is distinct from old.state then 'state_changed' else 'decision_updated' end,
      jsonb_build_object('title', new.title, 'from_state', old.state, 'to_state', new.state,
        'outcome', new.outcome, 'archive_reason', new.archive_reason));
  end if;
  if new.subteam_key is distinct from old.subteam_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'department_changed',
      jsonb_build_object('title', new.title, 'from', old.subteam_key, 'to', new.subteam_key));
  end if;
  if new.due_date is distinct from old.due_date then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'deadline_changed',
      jsonb_build_object('title', new.title, 'from', old.due_date, 'to', new.due_date));
  end if;
  if new.priority is distinct from old.priority then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'priority_changed',
      jsonb_build_object('title', new.title, 'from', old.priority, 'to', new.priority));
  end if;
  if new.milestone_key is distinct from old.milestone_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'milestone_changed',
      jsonb_build_object('title', new.title, 'from', old.milestone_key, 'to', new.milestone_key));
  end if;
  if new.owner_id is distinct from old.owner_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'owner_changed',
      jsonb_build_object('title', new.title, 'from', old.owner_id, 'to', new.owner_id));
  end if;
  if old.legacy_incomplete and not new.legacy_incomplete then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'legacy_repaired',
      jsonb_build_object('title', new.title));
  end if;
  return new;
end $fn$;

create or replace function log_proposal_submitted() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), new.season_id, 'proposal', new.id::text, 'submitted',
    jsonb_build_object('title', new.title, 'department', new.subteam_key,
      'due_date', new.due_date, 'priority', new.priority, 'milestone', new.milestone_key));
  return new;
end $fn$;

drop trigger if exists trg_log_proposal_submitted on task_proposals;
create trigger trg_log_proposal_submitted after insert on task_proposals
  for each row execute function log_proposal_submitted();

-- Creating and deleting proposals is no longer a table operation.
drop policy if exists proposal_insert on task_proposals;
drop policy if exists proposal_update on task_proposals;
drop policy if exists proposal_delete on task_proposals;
create policy proposal_update on task_proposals for update to authenticated
  using (can_review_proposal(id)) with check (can_review_proposal(id));
revoke insert, delete, truncate on task_proposals from anon, authenticated;

-- ------------------------------------------------------------- 9. commands
-- Department first, proposal second: the one lock order every command uses.
create or replace function lock_proposal_for_command(p_proposal_id uuid) returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v_sub text;
  v_row task_proposals%rowtype;
begin
  select subteam_key into v_sub from task_proposals where id = p_proposal_id;
  if not found then
    raise exception 'Proposal % does not exist', p_proposal_id using errcode = '23503';
  end if;
  if v_sub is not null then
    perform 1 from subteams where key = v_sub for share;
  end if;
  select * into v_row from task_proposals where id = p_proposal_id for update;
  if v_row.subteam_key is distinct from v_sub then
    raise exception 'The proposal changed department while it was being processed. Try again.'
      using errcode = '40001';
  end if;
  return v_row;
end $fn$;

create or replace function submit_proposal(
  p_season_id uuid,
  p_title text,
  p_subteam_key text,
  p_due_date date,
  p_milestone_key text,
  p_clause_keys text[],
  p_description text default null,
  p_priority task_priority default 'normal',
  p_owner_id uuid default null
) returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_keys text[];
  v_row task_proposals%rowtype;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may raise a proposal.' using errcode = '42501';
  end if;
  if length(v_title) < 1 or length(v_title) > 200 then
    raise exception 'A proposal needs a title of 1 to 200 characters.' using errcode = '23514';
  end if;
  if p_season_id is null or not exists (select 1 from seasons where id = p_season_id) then
    raise exception 'That season does not exist.' using errcode = '23503';
  end if;
  if p_due_date is null then
    raise exception 'A proposal needs a deadline.' using errcode = '23502';
  end if;
  if p_priority is null then
    raise exception 'A proposal needs a priority (normal or urgent).' using errcode = '23502';
  end if;
  if p_subteam_key is null then
    raise exception 'A proposal needs a department.' using errcode = '23502';
  end if;
  perform 1 from subteams where key = p_subteam_key for share;
  if not exists (select 1 from subteams where key = p_subteam_key and archived_at is null) then
    raise exception 'A proposal can only be raised to an active department.' using errcode = '23514';
  end if;
  if p_milestone_key is null or not exists (
    select 1 from milestones where key = p_milestone_key and season_id = p_season_id
  ) then
    raise exception 'A proposal needs a milestone from the same season.' using errcode = '23514';
  end if;
  select array_agg(distinct k order by k) into v_keys
    from unnest(coalesce(p_clause_keys, '{}'::text[])) as k where k is not null;
  if v_keys is null or cardinality(v_keys) < 1 then
    raise exception 'A proposal needs at least one requirement.' using errcode = '23514';
  end if;
  if exists (select 1 from unnest(v_keys) k where not exists (select 1 from clauses c where c.clause_key = k)) then
    raise exception 'One of the requirements does not exist.' using errcode = '23503';
  end if;
  if p_owner_id is not null and not exists (
    select 1 from members m where m.id = p_owner_id and m.status = 'active'
  ) then
    raise exception 'A proposal can only be given to an active member.' using errcode = '23514';
  end if;

  insert into task_proposals (season_id, title, context, owner_id, raised_by,
                              subteam_key, due_date, priority, milestone_key)
  values (p_season_id, v_title, nullif(btrim(coalesce(p_description, '')), ''), p_owner_id, auth.uid(),
          p_subteam_key, p_due_date, p_priority, p_milestone_key)
  returning * into v_row;

  insert into proposal_requirements (proposal_id, clause_key, created_by)
  select v_row.id, k, auth.uid() from unnest(v_keys) as k;

  return v_row;
end $fn$;

create or replace function review_proposal(p_proposal_id uuid, p_action text) returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
begin
  v := lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department, or a Developer, may review it.'
      using errcode = '42501';
  end if;

  perform set_config('reqon.proposal_write', 'on', true);
  if p_action = 'review' then
    if v.archived_at is not null or v.state <> 'open' then
      raise exception 'Only a suggested proposal can be taken under review.' using errcode = '22023';
    end if;
    update task_proposals set state = 'agenda' where id = p_proposal_id returning * into v;
  elsif p_action = 'park' then
    if v.archived_at is not null or v.state not in ('open', 'agenda') then
      raise exception 'Only a suggested or under-review proposal can be parked.' using errcode = '22023';
    end if;
    update task_proposals set state = 'parked' where id = p_proposal_id returning * into v;
  elsif p_action = 'reject' then
    if v.archived_at is not null or v.state not in ('open', 'agenda') then
      raise exception 'Only a suggested or under-review proposal can be rejected.' using errcode = '22023';
    end if;
    update task_proposals set state = 'decided', outcome = 'rejected', archived_at = now(),
      archived_by = auth.uid(), archive_reason = 'rejected'
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
  return v;
end $fn$;

create or replace function set_proposal_requirements(p_proposal_id uuid, p_clause_keys text[]) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_keys text[];
  v_before text[];
begin
  v := lock_proposal_for_command(p_proposal_id);
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department, or a Developer, may change its requirements.'
      using errcode = '42501';
  end if;
  if v.archived_at is not null then
    raise exception 'This proposal is archived. Reopen it before editing.' using errcode = '22023';
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
  delete from proposal_requirements where proposal_id = p_proposal_id and clause_key <> all (v_keys);
  insert into proposal_requirements (proposal_id, clause_key, created_by)
    select p_proposal_id, k, auth.uid() from unnest(v_keys) as k
    on conflict do nothing;
  if v_before is distinct from v_keys then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), v.season_id, 'proposal', p_proposal_id::text, 'requirements_changed',
      jsonb_build_object('title', v.title, 'from', to_jsonb(v_before), 'to', to_jsonb(v_keys)));
  end if;

  if v.legacy_incomplete then
    perform set_config('reqon.proposal_write', 'on', true);
    update task_proposals set title = title where id = p_proposal_id;
    perform set_config('reqon.proposal_write', 'off', true);
  end if;
end $fn$;

create or replace function link_task_requirement(p_task_id uuid, p_clause_key text) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_rows int;
begin
  if not can_edit_task(p_task_id) then
    raise exception 'You cannot change the requirements of this task.' using errcode = '42501';
  end if;
  if not exists (select 1 from clauses where clause_key = p_clause_key) then
    raise exception 'That requirement does not exist.' using errcode = '23503';
  end if;
  insert into task_requirements (task_id, clause_key, created_by)
  values (p_task_id, p_clause_key, auth.uid())
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $fn$;

create or replace function unlink_task_requirement(p_task_id uuid, p_clause_key text) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_required boolean;
  v_rows int;
begin
  select links_required into v_required from tasks where id = p_task_id for update;
  if not found or not can_edit_task(p_task_id) then
    raise exception 'You cannot change the requirements of this task.' using errcode = '42501';
  end if;
  if v_required
     and exists (select 1 from task_requirements where task_id = p_task_id and clause_key = p_clause_key)
     and (select count(*) from task_requirements where task_id = p_task_id) <= 1 then
    raise exception 'A task created from a proposal must keep at least one requirement.'
      using errcode = '23514';
  end if;
  delete from task_requirements where task_id = p_task_id and clause_key = p_clause_key;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $fn$;

-- The old five-argument function let the promoter pick a due date and any
-- starting lane, and answered to is_admin(). Dropped, not overloaded.
drop function if exists promote_proposal(uuid, uuid, uuid, date, task_state);

create or replace function promote_proposal(p_proposal_id uuid, p_season_id uuid, p_owner_id uuid default null)
returns table (task tasks, created boolean)
language plpgsql security definer set search_path = public as $fn$
declare
  v_prop task_proposals%rowtype;
  v_task tasks%rowtype;
  v_owner uuid;
begin
  v_prop := lock_proposal_for_command(p_proposal_id);

  -- Authorized after both locks, and before the idempotent early return, so a
  -- retry by someone who has since lost the headship is refused.
  if not can_review_proposal(p_proposal_id) then
    raise exception 'Only the Head of this proposal''s department, or a Developer, may promote it.'
      using errcode = '42501';
  end if;
  if v_prop.season_id <> p_season_id then
    raise exception 'That proposal belongs to a different season than the one you are working in. '
      'Switch to its season before promoting it.'
      using errcode = '22023';
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
  if v_prop.archived_at is not null or v_prop.state not in ('open', 'agenda') then
    raise exception 'Only a suggested or under-review proposal can be promoted. '
      'Reopen a parked or rejected proposal first.' using errcode = '22023';
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

  insert into tasks (season_id, title, detail, owner_id, subteam_key, due_date, priority,
                     milestone_key, state, source_proposal, created_by, links_required)
  values (v_prop.season_id, v_prop.title, v_prop.context, v_owner, v_prop.subteam_key, v_prop.due_date,
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
    jsonb_build_object('title', v_prop.title, 'task_id', v_task.id, 'department', v_prop.subteam_key));
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), v_prop.season_id, 'task', v_task.id::text, 'created_from_proposal',
    jsonb_build_object('title', v_task.title, 'proposal_id', p_proposal_id));

  return query select v_task, true;
end $fn$;

-- ------------------------------------------ 10. department archive, extended
create or replace function guard_department_archive() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  active_tasks int;
  open_proposals int;
begin
  if new.archived_at is null or old.archived_at is not null then
    return new; -- not an archive transition (restore, or an ordinary edit)
  end if;

  -- A BEFORE trigger runs before the UPDATE has locked the row, so without this
  -- a submit_proposal() or promote_proposal() that already holds the department
  -- row (FOR SHARE) could commit after the counts below were taken. Taking the
  -- row lock here waits for it, and the counts that follow (a fresh statement
  -- snapshot in READ COMMITTED) see what it committed.
  perform 1 from subteams where key = old.key for update;

  select count(*) into active_tasks from tasks
    where subteam_key = old.key and state not in ('done', 'cancelled');
  if active_tasks > 0 then
    raise exception 'Cannot archive department "%": % task(s) still reference it. '
      'Reassign or finish them first.', old.key, active_tasks
      using errcode = '23514';
  end if;

  select count(*) into open_proposals from task_proposals
    where subteam_key = old.key and archived_at is null and state <> 'decided';
  if open_proposals > 0 then
    raise exception 'Cannot archive department "%": % unresolved proposal(s) still reference it. '
      'Promote, reject or move them first.', old.key, open_proposals
      using errcode = '23514';
  end if;
  return new;
end $fn$;

-- ---------------------------------------------------------------- 11. grants
revoke all on function assert_task_links(uuid) from public, anon, authenticated;
revoke all on function lock_proposal_for_command(uuid) from public, anon, authenticated;
revoke all on function submit_proposal(uuid, text, text, date, text, text[], text, task_priority, uuid) from public, anon;
revoke all on function review_proposal(uuid, text) from public, anon;
revoke all on function set_proposal_requirements(uuid, text[]) from public, anon;
revoke all on function link_task_requirement(uuid, text) from public, anon;
revoke all on function unlink_task_requirement(uuid, text) from public, anon;
revoke all on function promote_proposal(uuid, uuid, uuid) from public, anon;
grant execute on function submit_proposal(uuid, text, text, date, text, text[], text, task_priority, uuid) to authenticated;
grant execute on function review_proposal(uuid, text) to authenticated;
grant execute on function set_proposal_requirements(uuid, text[]) to authenticated;
grant execute on function link_task_requirement(uuid, text) to authenticated;
grant execute on function unlink_task_requirement(uuid, text) to authenticated;
grant execute on function promote_proposal(uuid, uuid, uuid) to authenticated;

-- --------------------------------------- 12. reconciliation_preflight (extended)
create or replace function reconciliation_preflight(p_manifest jsonb)
returns table (
  key text, action text, clauses int, duties int, active_tasks int, archived_tasks int,
  unresolved_proposals int, handovers int, head_id uuid, head_status text,
  ok boolean, problem text
)
language plpgsql security definer set search_path = public as $fn$
declare
  entries department_reconciliation_entry[];
  resulting_active int;
begin
  if not can_manage_departments() then
    raise exception 'Only the President, Vice President or a Developer may run reconciliation'
      using errcode = '42501';
  end if;

  select coalesce(
    array_agg(row(e.key, e.action, e.name, e.reason, e.sort_order)::department_reconciliation_entry),
    '{}'
  ) into entries
  from jsonb_to_recordset(coalesce(p_manifest -> 'departments', '[]'::jsonb))
    as e(key text, action text, name text, reason text, sort_order int);

  -- Re-callable within the same session/transaction (reconciliation_apply
  -- calls this internally, and a caller may also call it directly to
  -- preview): drop any table a previous call in this transaction left behind
  -- rather than relying on ON COMMIT DROP, which only fires at commit.
  drop table if exists pg_temp.recon_rows;
  create temporary table pg_temp.recon_rows as
  with manifest as (
    select (x).key, (x).action from unnest(entries) as x
  ),
  -- Table-qualified even though "manifest" is not itself a PL/pgSQL
  -- variable: this function's RETURNS TABLE(key text, action text, ...)
  -- declares "key" and "action" as OUT-parameter variables in scope for the
  -- whole function body, so an unqualified `key`/`action` inside any nested
  -- SQL here is ambiguous between "the CTE column" and "the OUT parameter"
  -- (PL/pgSQL raises 42702 for exactly this). Every reference below is
  -- qualified for that reason, not merely style.
  dup as (
    select man.key, count(*) as n from manifest man group by man.key having count(*) > 1
  ),
  known as (
    select s.key, s.lead_id, m.status::text as head_status
    from subteams s left join members m on m.id = s.lead_id
  )
  select
    man.key,
    man.action,
    (select count(*)::int from clauses c where c.subteam_key = man.key) as clauses,
    (select count(*)::int from clauses c where c.subteam_key = man.key and c.is_team_duty) as duties,
    (select count(*)::int from tasks t where t.subteam_key = man.key and t.state not in ('done','cancelled')) as active_tasks,
    (select count(*)::int from tasks t where t.subteam_key = man.key and t.state in ('done','cancelled')) as archived_tasks,
    (select count(*)::int from task_proposals p
      where p.subteam_key = man.key and p.archived_at is null and p.state <> 'decided') as unresolved_proposals,
    (select count(*)::int from handover_notes h where h.subteam_key = man.key) as handovers,
    k.lead_id as head_id,
    k.head_status,
    (case
      when d.key is not null then false
      when man.action = 'create' and k.key is not null then false
      when man.action in ('keep', 'rename', 'archive') and k.key is null then false
      when man.action = 'archive' and exists (
        select 1 from tasks t where t.subteam_key = man.key and t.state not in ('done', 'cancelled')
      ) then false
      when man.action = 'archive' and exists (
        select 1 from task_proposals p
        where p.subteam_key = man.key and p.archived_at is null and p.state <> 'decided'
      ) then false
      when man.action not in ('keep', 'rename', 'archive', 'create') then false
      else true
    end) as ok,
    (case
      when d.key is not null then 'listed ' || d.n || ' times in the manifest'
      when man.action = 'create' and k.key is not null then 'action is create, but this key already exists'
      when man.action in ('keep', 'rename', 'archive') and k.key is null then 'unknown department key'
      when man.action = 'archive' and exists (
        select 1 from tasks t where t.subteam_key = man.key and t.state not in ('done', 'cancelled')
      ) then 'active tasks still reference this department; reassign or finish them first'
      when man.action = 'archive' and exists (
        select 1 from task_proposals p
        where p.subteam_key = man.key and p.archived_at is null and p.state <> 'decided'
      ) then 'unresolved proposals still reference this department; promote, reject or move them first'
      when man.action not in ('keep', 'rename', 'archive', 'create') then 'action must be keep, rename, archive or create'
      else null
    end) as problem
  from manifest man
  left join dup d on d.key = man.key
  left join known k on k.key = man.key;

  -- 'keep'/'rename' do not themselves change active/archived state, so they
  -- count toward the result only when the department is CURRENTLY active —
  -- "keep" on an already-archived row must not be read as "make it active".
  -- 'create' always becomes active; 'archive' never does, whatever its
  -- current state (the common case: currently active, about to leave it).
  select
    coalesce((
      select count(*) from pg_temp.recon_rows r
      join subteams s on s.key = r.key
      where r.ok and r.action in ('keep', 'rename') and s.archived_at is null
    ), 0)
    + coalesce((
      select count(*) from pg_temp.recon_rows r where r.ok and r.action = 'create'
    ), 0)
  into resulting_active;

  return query
    select * from pg_temp.recon_rows
    union all
    select s.key, null::text, null::int, null::int, null::int, null::int, null::int, null::int,
      s.lead_id, m.status::text, false, 'missing from the manifest'
    from subteams s
    left join members m on m.id = s.lead_id
    where not exists (select 1 from pg_temp.recon_rows r where r.key = s.key)
    union all
    select null::text, null::text, null::int, null::int, null::int, null::int, null::int, null::int,
      null::uuid, null::text, resulting_active <= 10,
      'resulting active department count would be ' || resulting_active::text || ' (limit 10)';
end $fn$;

revoke all on function reconciliation_preflight(jsonb) from public, anon;
grant execute on function reconciliation_preflight(jsonb) to authenticated;
