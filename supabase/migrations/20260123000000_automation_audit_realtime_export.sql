-- =============================================================================
--  Phase 11: automatic archive, complete audit context, and realtime links.
--
--  Purpose
--    * Replace the clock-accepting archive sweep with a no-argument production
--      command that uses server time. Keep a deterministic owner-only seam for
--      database tests; no API role can supply a clock.
--    * Lock and recheck eligible Done tasks before archiving, attribute the
--      action to the system (actor_id NULL), and keep repeat runs idempotent.
--    * Complete task/proposal/link audit payloads and make activity immutable
--      to API roles.
--    * Give requirement junction rows explicit, checked season context so
--      Realtime DELETE events can be filtered without guessing through a
--      missing parent row. Publish proposal links and milestones.
--
--  Existing data mapping
--    task_requirements.season_id is copied from tasks.season_id;
--    proposal_requirements.season_id is copied from task_proposals.season_id.
--    The columns become NOT NULL only after every row has been checked. No
--    activity row is reconstructed and no historical actor is invented.
--
--  Authorization
--    archive_stale_done_tasks() is SECURITY DEFINER and executable only by
--    service_role (trusted scheduler fallback) and the function owner
--    (pg_cron). anon/authenticated cannot call either sweep function, and only
--    the owner can call archive_stale_done_tasks_at(timestamptz). API roles
--    lose INSERT/UPDATE/DELETE/TRUNCATE on activity; member SELECT remains.
--
--  Locking and concurrency
--    The sweep selects candidates in UUID order FOR UPDATE SKIP LOCKED, then
--    repeats every eligibility predicate in the UPDATE. A concurrent reopen
--    that locked first is skipped; if the sweep locked first, the later normal
--    edit sees an archived row and is refused. The migration adds columns and
--    validates them under ordinary ALTER TABLE locks; at club scale this is a
--    short deploy, but it should still be applied before the matching client.
--
--  Scheduler deployment order
--    This migration deliberately does NOT install pg_cron: the plain-Postgres
--    verification image may not provide it, and hosted support is blocker X4.
--    After this migration is deployed, explicitly enable pg_cron and run
--    supabase/scheduler/install_archive_job.sql, or configure the documented
--    trusted-server fallback. Production activation is therefore observable
--    and cannot be silently skipped by a conditional migration.
--
--  Rollback / forward recovery
--    Do not drop populated season columns or their audit context. Forward-fix
--    the functions/triggers. The scheduler is independently recoverable by
--    rerunning its idempotent install script or unscheduling its stable name.
--    Reverting the no-argument function would re-open the fake-clock hazard and
--    is not a safe production rollback.
-- =============================================================================

-- ---------------------------------------------------------------- sweep path
drop function if exists public.archive_stale_done_tasks(timestamptz);

create index if not exists tasks_auto_archive_eligible
  on public.tasks (completed_at, id)
  where state = 'done' and archived_at is null and completed_at is not null;

-- Deterministic test seam. It is intentionally absent from PostgREST roles.
create or replace function public.archive_stale_done_tasks_at(p_now timestamptz)
returns setof public.tasks
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_now is null then
    raise exception 'archive sweep time cannot be null' using errcode = '22004';
  end if;

  perform set_config('reqon.task_lifecycle_write', 'on', true);
  perform set_config('reqon.system_actor', 'archive_scheduler', true);

  return query
  with candidates as materialized (
    select t.id
      from public.tasks t
     where t.state = 'done'
       and t.archived_at is null
       and t.completed_at is not null
       and t.completed_at <= p_now - interval '24 hours'
     order by t.id
     for update skip locked
  )
  update public.tasks t
     set archived_at = p_now,
         archived_by = null,
         archive_reason = 'auto_done_24h'
    from candidates c
   where t.id = c.id
     -- Recheck under the row lock. These predicates are not redundant: they
     -- are the concurrency contract if a candidate changed while we waited.
     and t.state = 'done'
     and t.archived_at is null
     and t.completed_at is not null
     and t.completed_at <= p_now - interval '24 hours'
  returning t.*;

  perform set_config('reqon.system_actor', 'off', true);
  perform set_config('reqon.task_lifecycle_write', 'off', true);
end
$fn$;

comment on function public.archive_stale_done_tasks_at(timestamptz) is
  'Owner-only deterministic seam for database tests. Production schedulers '
  'must call archive_stale_done_tasks(), which supplies server time.';

create or replace function public.archive_stale_done_tasks()
returns setof public.tasks
language sql
security definer
set search_path = public
as $fn$
  select * from public.archive_stale_done_tasks_at(statement_timestamp());
$fn$;

comment on function public.archive_stale_done_tasks() is
  'Archives unarchived Done tasks whose server-recorded completed_at is at '
  'least 24 hours old. Idempotent and system-attributed. Intended only for '
  'pg_cron or the trusted service-role fallback.';

revoke all on function public.archive_stale_done_tasks_at(timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.archive_stale_done_tasks()
  from public, anon, authenticated;
grant execute on function public.archive_stale_done_tasks() to service_role;

-- ----------------------------------------------------------- junction seasons
alter table public.task_requirements add column if not exists season_id uuid;
update public.task_requirements tr
   set season_id = t.season_id
  from public.tasks t
 where t.id = tr.task_id
   and tr.season_id is null;

alter table public.proposal_requirements add column if not exists season_id uuid;
update public.proposal_requirements pr
   set season_id = p.season_id
  from public.task_proposals p
 where p.id = pr.proposal_id
   and pr.season_id is null;

-- The existing promoted-task integrity trigger is DEFERRABLE and fires on an
-- UPDATE of task_requirements. Drain those checks before ALTER TABLE; otherwise
-- PostgreSQL correctly refuses DDL while trigger events are pending.
do $drain$
begin
  execute 'set constraints all immediate';
end
$drain$;

do $constraints$
begin
  if exists (select 1 from public.task_requirements where season_id is null) then
    raise exception 'cannot assign a season to every task requirement link';
  end if;
  if exists (select 1 from public.proposal_requirements where season_id is null) then
    raise exception 'cannot assign a season to every proposal requirement link';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.task_requirements'::regclass
       and conname = 'task_requirements_season_id_fkey'
  ) then
    alter table public.task_requirements
      add constraint task_requirements_season_id_fkey
      foreign key (season_id) references public.seasons(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.proposal_requirements'::regclass
       and conname = 'proposal_requirements_season_id_fkey'
  ) then
    alter table public.proposal_requirements
      add constraint proposal_requirements_season_id_fkey
      foreign key (season_id) references public.seasons(id) on delete cascade;
  end if;
end
$constraints$;

alter table public.task_requirements alter column season_id set not null;
alter table public.proposal_requirements alter column season_id set not null;

create index if not exists task_requirements_season
  on public.task_requirements (season_id, task_id, clause_key);
create index if not exists proposal_requirements_season
  on public.proposal_requirements (season_id, proposal_id, clause_key);

create or replace function public.enforce_task_requirement_season()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare parent_season uuid;
begin
  select t.season_id into parent_season from public.tasks t where t.id = new.task_id;
  if parent_season is null then
    raise exception 'task % does not exist', new.task_id using errcode = '23503';
  end if;
  if new.season_id is not null and new.season_id is distinct from parent_season then
    raise exception 'task requirement season must match its task' using errcode = '23514';
  end if;
  new.season_id := parent_season;
  return new;
end
$fn$;

drop trigger if exists trg_task_requirement_season on public.task_requirements;
create trigger trg_task_requirement_season
  before insert or update of task_id, season_id on public.task_requirements
  for each row execute function public.enforce_task_requirement_season();

create or replace function public.enforce_proposal_requirement_season()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare parent_season uuid;
begin
  select p.season_id into parent_season
    from public.task_proposals p where p.id = new.proposal_id;
  if parent_season is null then
    raise exception 'proposal % does not exist', new.proposal_id using errcode = '23503';
  end if;
  if new.season_id is not null and new.season_id is distinct from parent_season then
    raise exception 'proposal requirement season must match its proposal' using errcode = '23514';
  end if;
  new.season_id := parent_season;
  return new;
end
$fn$;

drop trigger if exists trg_proposal_requirement_season on public.proposal_requirements;
create trigger trg_proposal_requirement_season
  before insert or update of proposal_id, season_id on public.proposal_requirements
  for each row execute function public.enforce_proposal_requirement_season();

-- DELETE payloads need the season column for server-side filters. FULL keeps
-- it in old records; these link rows contain no sensitive free text.
alter table public.task_requirements replica identity full;
alter table public.proposal_requirements replica identity full;
alter table public.milestone_sections replica identity full;

-- ------------------------------------------------------------- audit coverage
create index if not exists activity_entity_history
  on public.activity (season_id, entity, entity_id, at desc, id desc);
create index if not exists activity_global_entity_history
  on public.activity (entity, entity_id, at desc, id desc)
  where season_id is null;

revoke insert, update, delete, truncate on public.activity
  from anon, authenticated, service_role;

create or replace function public.log_task_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  actor uuid := case
    when current_setting('reqon.system_actor', true) = 'archive_scheduler' then null
    else auth.uid()
  end;
  actor_kind text := case
    when current_setting('reqon.system_actor', true) = 'archive_scheduler' then 'system'
    else 'member'
  end;
begin
  if new.state is distinct from old.state then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'state_changed',
      jsonb_build_object('title', new.title, 'from', old.state, 'to', new.state));
  end if;
  if new.owner_id is distinct from old.owner_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'owner_changed',
      jsonb_build_object('title', new.title, 'from', old.owner_id, 'to', new.owner_id));
  end if;
  if new.subteam_key is distinct from old.subteam_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'department_transferred',
      jsonb_build_object('title', new.title, 'from', old.subteam_key, 'to', new.subteam_key));
  end if;
  if new.priority is distinct from old.priority then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'priority_changed',
      jsonb_build_object('title', new.title, 'from', old.priority, 'to', new.priority));
  end if;
  if new.due_date is distinct from old.due_date then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'deadline_changed',
      jsonb_build_object('title', new.title, 'from', old.due_date, 'to', new.due_date));
  end if;
  if new.starts_on is distinct from old.starts_on then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'starts_on_changed',
      jsonb_build_object('title', new.title, 'from', old.starts_on, 'to', new.starts_on));
  end if;
  if new.completed_at is distinct from old.completed_at then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text,
      case when new.completed_at is null then 'completion_cleared' else 'completed' end,
      jsonb_build_object('title', new.title, 'from', old.completed_at,
        'to', new.completed_at, 'source', new.completion_source));
  end if;
  if new.archived_at is distinct from old.archived_at then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text,
      case when new.archived_at is not null then 'archived' else 'restored' end,
      case when new.archived_at is not null then
        jsonb_build_object('title', new.title, 'reason', new.archive_reason,
          'from', old.archived_at, 'to', new.archived_at, 'actor_kind', actor_kind)
      else
        jsonb_build_object('title', new.title, 'reason', old.archive_reason,
          'from', old.archived_at, 'to', new.archived_at, 'actor_kind', actor_kind)
      end);
  end if;
  if new.milestone_key is distinct from old.milestone_key then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text, 'milestone_changed',
      jsonb_build_object('title', new.title, 'from', old.milestone_key, 'to', new.milestone_key));
  end if;
  if new.section_id is distinct from old.section_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (actor, new.season_id, 'task', new.id::text,
      case when old.section_id is null then 'section_linked'
           when new.section_id is null then 'section_unlinked'
           else 'section_changed' end,
      jsonb_build_object('title', new.title, 'from', old.section_id, 'to', new.section_id,
        'milestone', new.milestone_key));
  end if;
  return new;
end
$fn$;

create or replace function public.log_task_requirement_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  link_task uuid := case when TG_OP = 'DELETE' then old.task_id else new.task_id end;
  link_clause text := case when TG_OP = 'DELETE' then old.clause_key else new.clause_key end;
  link_season uuid := case when TG_OP = 'DELETE' then old.season_id else new.season_id end;
begin
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), link_season, 'task', link_task::text,
    case when TG_OP = 'DELETE' then 'requirement_unlinked' else 'requirement_linked' end,
    jsonb_build_object('task_id', link_task, 'clause_key', link_clause,
      'link_key', link_task::text || '|' || link_clause));
  return null;
end
$fn$;

create or replace function public.log_proposal_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.state is distinct from old.state then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'state_changed',
      jsonb_build_object('title', new.title, 'from', old.state, 'to', new.state));
  end if;
  if new.decision is distinct from old.decision then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'decision_updated',
      jsonb_build_object('title', new.title, 'had_value', old.decision is not null,
        'has_value', new.decision is not null));
  end if;
  if new.outcome is distinct from old.outcome then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text, 'outcome_changed',
      jsonb_build_object('title', new.title, 'from', old.outcome, 'to', new.outcome));
  end if;
  if new.archived_at is distinct from old.archived_at then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text,
      case when new.archived_at is not null then 'archived' else 'reopened' end,
      jsonb_build_object('title', new.title,
        'reason', coalesce(new.archive_reason, old.archive_reason),
        'from', old.archived_at, 'to', new.archived_at));
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
end
$fn$;

-- ------------------------------------------------------ realtime publication
do $publication$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'proposal_requirements'
  ) then
    alter publication supabase_realtime add table public.proposal_requirements;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'milestones'
  ) then
    alter publication supabase_realtime add table public.milestones;
  end if;
exception when undefined_object then
  -- A bare PostgreSQL deployment may omit the Supabase publication. The
  -- database functions still install; the exact-publication test on a
  -- Supabase-compatible stack makes a missing table visible.
  null;
end
$publication$;
