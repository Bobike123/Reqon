-- =============================================================================
--  Activity audit trail, made real (Phase 5 §5.5)
--
--  `activity` (20260101000000) has existed since day one and nothing has ever
--  written to it — worse, its RLS policy from that same migration is
--  `member_write ... for all to authenticated using (is_member())`, which
--  means any signed-in member could INSERT, UPDATE or DELETE rows in it
--  directly from the browser. An audit trail nobody writes to, that anyone
--  can forge or erase, is not an audit trail. This closes both problems:
--
--    1. Drop that policy. `member_read` (same migration) stays, so every
--       member can still see the history — see also the export in
--       exportSeason.ts, which already carries `activity`.
--    2. Add SECURITY DEFINER triggers that write activity rows for the
--       specific, meaningful transitions §5.5 names, so the record exists
--       regardless of which code path performed the write — a client cannot
--       simply forget to log something, because the client never does.
--       These bypass RLS the same way promote_proposal() and
--       apply_role_plan() already do: owned by the role that applies
--       migrations, which is exempt from RLS, not by any grant to members.
--
--  What is deliberately NOT logged: every field on every row, every INSERT
--  or bulk import (the regs-book seed, a season's fresh milestones), or
--  anything that duplicates what git/created_at columns already answer. Each
--  trigger below fires on ONE meaningful transition per table, not on every
--  UPDATE — "do not log everything indiscriminately" (§5.5).
--
--  What never goes in `detail`: passwords, tokens, phone numbers, notes, or
--  any other free-text member field. Every jsonb payload below is built from
--  a short, named, reviewed list of columns.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Make `activity` a real, unforgeable audit trail.
--    Existing data  Existing activity rows are untouched; they simply become
--                   read-only to members once member_write is dropped.
--    New objects    Trigger functions log_task_lifecycle, log_proposal_decision,
--                   log_role_change, log_milestone_change, log_spec_measurement,
--                   log_finance_change, and one trigger each on tasks,
--                   task_proposals, member_roles, milestones, specs,
--                   finance_entries. Policy member_write on activity dropped.
--    Locking        CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on each of
--                   those six tables (writes wait briefly; reads continue);
--                   DROP POLICY briefly locks `activity`. At runtime each
--                   audited transition adds one INSERT inside the same
--                   transaction as the write it records.
--    Authorization  Members lose direct write access to `activity`. The
--                   triggers are SECURITY DEFINER with search_path pinned to
--                   public and write only reviewed columns.
--    Rollback       DROP TRIGGER / DROP FUNCTION for each: audited writes stop
--                   being recorded; rows already written stay. Do NOT
--                   recreate member_write — that reopens forging and erasing
--                   history from the browser.
--    Deploy order   Apply any time after 20260113; no frontend change depends
--                   on it (the export already reads `activity`).
-- =============================================================================

drop policy if exists member_write on activity;

-- --- tasks: lifecycle (state) changes ---------------------------------------
create or replace function log_task_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.state is distinct from old.state then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'task', new.id::text, 'state_changed',
      jsonb_build_object('title', new.title, 'from', old.state, 'to', new.state));
  end if;
  return new;
end $fn$;

drop trigger if exists trg_log_task_lifecycle on tasks;
create trigger trg_log_task_lifecycle after update on tasks
  for each row execute function log_task_lifecycle();

-- --- task_proposals: decision / promotion ------------------------------------
-- promote_proposal() (20260110000000) marks the proposal decided as part of
-- its own transaction, so this one trigger also captures promotion — there is
-- no separate "was this a promotion" signal to duplicate here.
create or replace function log_proposal_decision() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.state is distinct from old.state or new.decision is distinct from old.decision then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'proposal', new.id::text,
      case when new.state is distinct from old.state then 'state_changed' else 'decision_updated' end,
      jsonb_build_object('title', new.title, 'from_state', old.state, 'to_state', new.state));
  end if;
  return new;
end $fn$;

drop trigger if exists trg_log_proposal_decision on task_proposals;
create trigger trg_log_proposal_decision after update on task_proposals
  for each row execute function log_proposal_decision();

-- --- member_roles: privileged role grants and revocations --------------------
-- Fires for BOTH the single-role giveRole()/takeRole() path and the
-- apply_role_plan() transaction (20260111000000) — the underlying table
-- write is the same event either way.
create or replace function log_role_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if TG_OP = 'INSERT' then
    insert into activity (actor_id, entity, entity_id, action, detail)
    values (auth.uid(), 'member_role', new.member_id::text, 'role_granted',
      jsonb_build_object('role', new.role));
    return new;
  end if;
  insert into activity (actor_id, entity, entity_id, action, detail)
  values (auth.uid(), 'member_role', old.member_id::text, 'role_revoked',
    jsonb_build_object('role', old.role));
  return old;
end $fn$;

drop trigger if exists trg_log_role_change on member_roles;
create trigger trg_log_role_change after insert or delete on member_roles
  for each row execute function log_role_change();

-- --- milestones: submission window / points configuration --------------------
create or replace function log_milestone_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.due_on is distinct from old.due_on
     or new.opens_on is distinct from old.opens_on
     or new.max_points is distinct from old.max_points then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'milestone', new.key, 'configuration_changed',
      jsonb_build_object(
        'name', new.name,
        'due_on', jsonb_build_object('from', old.due_on, 'to', new.due_on),
        'opens_on', jsonb_build_object('from', old.opens_on, 'to', new.opens_on),
        'max_points', jsonb_build_object('from', old.max_points, 'to', new.max_points)
      ));
  end if;
  return new;
end $fn$;

drop trigger if exists trg_log_milestone_change on milestones;
create trigger trg_log_milestone_change after update on milestones
  for each row execute function log_milestone_change();

-- --- specs: measurements recorded --------------------------------------------
create or replace function log_spec_measurement() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.measured is distinct from old.measured then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'spec', new.id::text, 'measurement_recorded',
      jsonb_build_object('parameter', new.parameter, 'from', old.measured, 'to', new.measured));
  end if;
  return new;
end $fn$;

drop trigger if exists trg_log_spec_measurement on specs;
create trigger trg_log_spec_measurement after update on specs
  for each row execute function log_spec_measurement();

-- --- finance_entries: not previously covered ---------------------------------
create or replace function log_finance_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if TG_OP = 'INSERT' then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'finance_entry', new.id::text, 'created',
      jsonb_build_object('kind', new.kind, 'amount_cents', new.amount_cents, 'category', new.category));
    return new;
  elsif TG_OP = 'UPDATE' then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'finance_entry', new.id::text, 'updated',
      jsonb_build_object(
        'amount_cents', jsonb_build_object('from', old.amount_cents, 'to', new.amount_cents),
        'kind', jsonb_build_object('from', old.kind, 'to', new.kind)
      ));
    return new;
  end if;
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), old.season_id, 'finance_entry', old.id::text, 'deleted',
    jsonb_build_object('kind', old.kind, 'amount_cents', old.amount_cents));
  return old;
end $fn$;

drop trigger if exists trg_log_finance_change on finance_entries;
create trigger trg_log_finance_change after insert or update or delete on finance_entries
  for each row execute function log_finance_change();
