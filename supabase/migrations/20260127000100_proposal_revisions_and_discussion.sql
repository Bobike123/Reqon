-- =============================================================================
--  Backend completion Phase 3, step 2 of 4: revisions, approval evidence and the
--  member-Head discussion. (docs/backend-completion/PERMISSIONS.md §5.)
--
--  WHAT WAS MISSING / WRONG.
--   * Nothing recorded WHICH wording of a proposal was approved, so an approval
--     could not be told apart from a later edit, and a reviewer could rewrite a
--     proposal through a plain UPDATE (title, deadline, owner, milestone...)
--     immediately before promoting it.
--   * A generic UPDATE carried no version precondition: two people editing the
--     same proposal silently overwrote each other (finding F-12 for proposals).
--   * There was no place to keep the conversation between the member who raised
--     a proposal and the Head who reviews it; the single `decision` text is one
--     person's note, not a discussion.
--
--  AFTER.
--   * task_proposals.revision (starts at 1): raised by exactly one for every
--     change to a MATERIAL field — title, description, proposed owner,
--     department, deadline, priority, milestone, or the requirement set. A
--     BEFORE UPDATE trigger does this for every writer, so no path (command,
--     reviewer UPDATE, maintenance script) can change material content without
--     a new revision. Star, decision note and meeting link are not material.
--   * Approval evidence: approved_revision, approved_by, approved_at,
--     approved_as (the authority the approver acted with: head, parent_head,
--     governance_fallback or developer) and approved_digest (a hash of the
--     approved content). While state = 'approved', a material change moves the
--     proposal back to 'agenda' and clears the evidence (activity row
--     'approval_invalidated'). After promotion the evidence stays, as the record
--     of what was approved. Proposals promoted before this migration carry NO
--     evidence: none is invented.
--   * proposal_content_digest(): the hash of the material content, recomputed at
--     promotion so a change that bypassed the revision counter still cannot be
--     promoted under an old approval.
--   * proposal_comments: append-only discussion. Each row is attributed to its
--     author (stamped from the session, never from the payload), carries the
--     proposal revision it was written against and one of the kinds
--     comment | changes_requested | approval | revision | decision. No UPDATE or
--     DELETE for any role. Written only by the review commands (next file).
--   * guard_proposal_edit(): a plain UPDATE may now change only the star, the
--     decision note and the meeting link. Material fields go through
--     revise_proposal() (with the revision the editor saw) and the department
--     through set_proposal_department(); state, outcome, archive, provenance,
--     revision and approval evidence stay command-only.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Revision counter, approval evidence, discussion table.
--    Existing data  Two-step ADD COLUMN with a constant default: revision = 1 for
--                   all 12 hosted proposals; approved_* NULL; nothing written to
--                   proposal_comments. Historical approvals are not fabricated.
--    Authorization  proposal_comments: RLS SELECT for members, no write policy and
--                   no write grant; the guard trigger also refuses UPDATE/DELETE.
--                   Functions: SECURITY DEFINER with a pinned search_path; the
--                   digest and trigger functions are not executable by API roles.
--    Locking        ADD COLUMN with a constant default is metadata-only on
--                   PG 11+. CREATE TRIGGER: SHARE ROW EXCLUSIVE on two small
--                   tables, briefly.
--    Rollback       Drop the trigger, the table and the columns (losing recorded
--                   approvals and discussion) and restore guard_proposal_edit()
--                   from 20260117. Forward recovery preferred.
--    Deploy order   After 20260127000000. The current client sends direct UPDATEs
--                   of material fields from the review dialog; deploy the Phase 3
--                   client with this migration (the old dialog would be refused).
-- =============================================================================

-- ------------------------------------------------------------------ columns
alter table task_proposals add column if not exists revision int not null default 1;
alter table task_proposals drop constraint if exists task_proposals_revision_positive;
alter table task_proposals add constraint task_proposals_revision_positive check (revision >= 1);

alter table task_proposals add column if not exists approved_revision int null;
alter table task_proposals add column if not exists approved_by uuid null;
alter table task_proposals add column if not exists approved_at timestamptz null;
alter table task_proposals add column if not exists approved_as text null;
alter table task_proposals add column if not exists approved_digest text null;

alter table task_proposals drop constraint if exists task_proposals_approved_by_fkey;
alter table task_proposals add constraint task_proposals_approved_by_fkey
  foreign key (approved_by) references members(id) on delete restrict;

alter table task_proposals drop constraint if exists task_proposals_approval_known_authority;
alter table task_proposals add constraint task_proposals_approval_known_authority
  check (approved_as is null or approved_as in ('head', 'parent_head', 'governance_fallback', 'developer'));
alter table task_proposals drop constraint if exists task_proposals_approval_all_or_none;
alter table task_proposals add constraint task_proposals_approval_all_or_none
  check ((approved_revision is null) = (approved_at is null)
     and (approved_revision is null) = (approved_by is null)
     and (approved_revision is null) = (approved_as is null)
     and (approved_revision is null) = (approved_digest is null));
alter table task_proposals drop constraint if exists task_proposals_approved_has_evidence;
alter table task_proposals add constraint task_proposals_approved_has_evidence
  check (state <> 'approved' or approved_revision is not null);

create index if not exists task_proposals_approved_by on task_proposals (approved_by) where approved_by is not null;

comment on column task_proposals.revision is
  'Raised by one for every change to a material field (title, description, owner, department, deadline, priority, milestone, requirement set). Editors send the revision they saw; a mismatch is a conflict, not an overwrite.';
comment on column task_proposals.approved_revision is
  'The revision the approval covers. NULL when no approval is on record (never approved, or withdrawn/invalidated). Kept after promotion as the evidence of what was approved.';
comment on column task_proposals.approved_as is
  'The authority the approver acted with: head, parent_head, governance_fallback (President/VP where the department has no Head) or developer.';

-- ---------------------------------------------------------- content digest
create or replace function proposal_content_digest(p_proposal_id uuid) returns text
language sql stable set search_path = public as $fn$
  select md5(jsonb_build_object(
    'title', p.title,
    'context', p.context,
    'owner_id', p.owner_id,
    'subteam_key', p.subteam_key,
    'due_date', p.due_date,
    'priority', p.priority,
    'milestone_key', p.milestone_key,
    'requirements', coalesce(
      (select jsonb_agg(r.clause_key order by r.clause_key) from proposal_requirements r where r.proposal_id = p.id),
      '[]'::jsonb)
  )::text)
  from task_proposals p where p.id = p_proposal_id;
$fn$;
revoke all on function proposal_content_digest(uuid) from public, anon, authenticated;
grant execute on function proposal_content_digest(uuid) to service_role;

-- ------------------------------------------------------ revision + invalidation
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
  if v_bumped and old.approved_revision is not null then
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
revoke all on function apply_proposal_revision() from public, anon, authenticated;

drop trigger if exists trg_proposal_revision on task_proposals;
create trigger trg_proposal_revision before update on task_proposals
  for each row execute function apply_proposal_revision();

-- -------------------------------------------------------------- ordinary edits
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
       or new.legacy_incomplete is distinct from old.legacy_incomplete
       or new.revision is distinct from old.revision
       or new.approved_revision is distinct from old.approved_revision
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at
       or new.approved_as is distinct from old.approved_as
       or new.approved_digest is distinct from old.approved_digest then
      raise exception 'That field cannot be changed through an ordinary proposal edit.' using errcode = '42501';
    end if;
    if new.title is distinct from old.title
       or new.context is distinct from old.context
       or new.owner_id is distinct from old.owner_id
       or new.subteam_key is distinct from old.subteam_key
       or new.due_date is distinct from old.due_date
       or new.priority is distinct from old.priority
       or new.milestone_key is distinct from old.milestone_key then
      raise exception 'Change a proposal with revise_proposal() (its department with set_proposal_department()), '
        'so a concurrent edit cannot be overwritten and an approval cannot outlive the change.'
        using errcode = '42501';
    end if;
  end if;

  -- Phase 2's preserved maintenance.reconcile_five_departments() temporarily
  -- releases the retired department keys before repointing them.  Keep that
  -- replayable without opening a general "clear department" path.
  if (old.subteam_key is not null and new.subteam_key is null
      and not (v_internal and old.subteam_key = any(array[
        'ADMIN','GEOM','CHASSIS','BODY','CONTROL','BRAKES','WHEELS',
        'LIVERY','RIDER','PWR_EF','SCRUT','DOCS','RACEOP']::text[])))
     or (old.due_date is not null and new.due_date is null)
     or (old.milestone_key is not null and new.milestone_key is null) then
    raise exception 'A proposal must keep its department, deadline and milestone.' using errcode = '23514';
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

-- --------------------------------------------------------------- discussion
create table if not exists proposal_comments (
  id          uuid        primary key default gen_random_uuid(),
  proposal_id uuid        not null references task_proposals(id) on delete restrict,
  season_id   uuid        not null references seasons(id) on delete restrict,
  author_id   uuid        not null references members(id) on delete restrict,
  kind        text        not null default 'comment'
              check (kind in ('comment', 'changes_requested', 'approval', 'revision', 'decision')),
  revision    int         not null check (revision >= 1),
  body        text        not null check (length(btrim(body)) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index if not exists proposal_comments_proposal on proposal_comments (proposal_id, created_at, id);
create index if not exists proposal_comments_season on proposal_comments (season_id);
create index if not exists proposal_comments_author on proposal_comments (author_id);

comment on table proposal_comments is
  'The member-Head discussion on one proposal. Append-only: attributed to the session that wrote it, stamped with the proposal revision it was written against. Written only by add_proposal_comment() and the review commands.';

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
  new.body := btrim(new.body);
  if auth.uid() is not null then
    new.author_id := auth.uid();
  end if;
  new.created_at := now();
  return new;
end $fn$;

create or replace function guard_proposal_comment_rows() returns trigger
language plpgsql set search_path = public as $fn$
begin
  raise exception 'the proposal discussion is append-only' using errcode = '42501';
end $fn$;

create or replace function log_proposal_comment() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (new.author_id, new.season_id, 'proposal', new.proposal_id::text, 'commented',
    jsonb_build_object('kind', new.kind, 'comment_id', new.id, 'revision', new.revision));
  return null;
end $fn$;

revoke all on function stamp_proposal_comment() from public, anon, authenticated;
revoke all on function guard_proposal_comment_rows() from public, anon, authenticated;
revoke all on function log_proposal_comment() from public, anon, authenticated;

drop trigger if exists trg_stamp_proposal_comment on proposal_comments;
create trigger trg_stamp_proposal_comment before insert on proposal_comments
  for each row execute function stamp_proposal_comment();
drop trigger if exists trg_guard_proposal_comment_rows on proposal_comments;
create trigger trg_guard_proposal_comment_rows before update or delete on proposal_comments
  for each row execute function guard_proposal_comment_rows();
drop trigger if exists trg_log_proposal_comment on proposal_comments;
create trigger trg_log_proposal_comment after insert on proposal_comments
  for each row execute function log_proposal_comment();

alter table proposal_comments enable row level security;
alter table proposal_comments replica identity full;
drop policy if exists member_read on proposal_comments;
create policy member_read on proposal_comments for select to authenticated using (is_member());
revoke all on proposal_comments from anon, authenticated;
grant select on proposal_comments to authenticated;
grant all on proposal_comments to service_role;

do $pub$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'proposal_comments'
     ) then
    alter publication supabase_realtime add table proposal_comments;
  end if;
end
$pub$;
