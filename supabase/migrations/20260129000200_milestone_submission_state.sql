-- =============================================================================
--  Backend completion Phase 4, step 3 of 7: a milestone's WORK, its SUBMISSION and
--  its ACCEPTANCE are three different facts. (PERMISSIONS.md §2.1; requirement
--  "do not infer evidence or acceptance from a progress bar".)
--
--  WHAT WAS MISSING. Reqon drew one progress bar per milestone (work completion) and
--  the Milestones screen even said it "does not record" a submission or an
--  acceptance. Nothing stopped the bar from being read as either.
--
--  AFTER.
--   * milestones.submitted_on / submitted_by  — the club sent it to the organisers.
--   * milestones.accepted_on  / accepted_by   — the organisers accepted it.
--     Both are calendar dates the club records; both are NULL until someone with authority
--     records them. A finished progress bar sets neither, and neither changes a progress
--     figure. Acceptance needs a submission and cannot precede it.
--   * set_milestone_submission(key, submitted_on, accepted_on) is the only way to change
--     them. Who: the people who manage milestone structure — President, Vice President,
--     Developer, Documentation (can_manage_milestone_structure). Passing NULL clears a
--     value (an honest correction, audited). The same call twice changes nothing and logs
--     nothing. A date more than one day in the future is refused (an event that has not
--     happened is not recorded).
--   * Direct UPDATE of the four columns is refused for every session (guard trigger), so
--     the admin_write policy that lets administrators edit windows and points cannot be used
--     to record a submission without the audit row.
--   * Audit: 'submission_changed' and 'acceptance_changed' on the milestone, with the old and
--     new dates and who.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Separate work completion, submission and acceptance.
--    Existing data  Four nullable columns; nothing is backfilled and no submission or
--                   acceptance is ever inferred for an existing milestone.
--    Authorization  Command SECURITY DEFINER, pinned search_path, EXECUTE for authenticated
--                   and service_role only; guard and log functions are not executable by API
--                   roles.
--    Locking        ADD COLUMN nullable (metadata only); each call locks one milestone row.
--    Rollback       Drop the two triggers, the command and the four columns.
--    Deploy order   After 20260129000100. The Milestones screen shows the state after this.
-- =============================================================================

alter table milestones
  add column if not exists submitted_on date null,
  add column if not exists submitted_by uuid null references members(id) on delete set null,
  add column if not exists accepted_on  date null,
  add column if not exists accepted_by  uuid null references members(id) on delete set null;

do $c$ begin
  alter table milestones add constraint milestones_acceptance_needs_submission
    check (accepted_on is null or (submitted_on is not null and accepted_on >= submitted_on));
exception when duplicate_object then null; end $c$;

comment on column milestones.submitted_on is 'The day the club submitted this milestone. NULL = not recorded as submitted. Never inferred from progress.';
comment on column milestones.accepted_on  is 'The day the organisers accepted it. NULL = not recorded as accepted. Needs a submission; never inferred.';

create or replace function guard_milestone_submission() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if (new.submitted_on, new.submitted_by, new.accepted_on, new.accepted_by)
       is distinct from (old.submitted_on, old.submitted_by, old.accepted_on, old.accepted_by)
     and auth.uid() is not null
     and coalesce(current_setting('reqon.milestone_submission_write', true), '') <> 'on' then
    raise exception 'A submission or acceptance is recorded with the submission command, not by editing the milestone.'
      using errcode = '42501';
  end if;
  return new;
end $fn$;
revoke all on function guard_milestone_submission() from public, anon, authenticated;

create or replace function log_milestone_submission() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.submitted_on is distinct from old.submitted_on then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'milestone', new.key, 'submission_changed',
      jsonb_build_object('from', old.submitted_on, 'to', new.submitted_on));
  end if;
  if new.accepted_on is distinct from old.accepted_on then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'milestone', new.key, 'acceptance_changed',
      jsonb_build_object('from', old.accepted_on, 'to', new.accepted_on));
  end if;
  return null;
end $fn$;
revoke all on function log_milestone_submission() from public, anon, authenticated;

drop trigger if exists trg_a_guard_milestone_submission on milestones;
create trigger trg_a_guard_milestone_submission before update on milestones
  for each row execute function guard_milestone_submission();
drop trigger if exists trg_log_milestone_submission on milestones;
create trigger trg_log_milestone_submission after update of submitted_on, accepted_on on milestones
  for each row execute function log_milestone_submission();

create or replace function set_milestone_submission(p_key text, p_submitted_on date, p_accepted_on date)
returns milestones
language plpgsql security definer set search_path = public as $fn$
declare
  v milestones%rowtype;
  v_today date := (now() at time zone 'Europe/Copenhagen')::date;
begin
  if auth.uid() is null or not is_active_member() or not can_manage_milestone_structure() then
    raise exception 'Only the President, Vice President, Documentation or a Developer can record a submission or an acceptance.'
      using errcode = '42501';
  end if;
  select * into v from milestones where key = p_key for update;
  if not found then
    raise exception 'That milestone does not exist.' using errcode = 'P0002';
  end if;
  if p_accepted_on is not null and p_submitted_on is null then
    raise exception 'A milestone cannot be accepted before it was submitted.' using errcode = '23514';
  end if;
  if p_accepted_on is not null and p_accepted_on < p_submitted_on then
    raise exception 'The acceptance date cannot be before the submission date.' using errcode = '23514';
  end if;
  if p_submitted_on > v_today + 1 or p_accepted_on > v_today + 1 then
    raise exception 'A date in the future cannot be recorded as something that already happened.' using errcode = '23514';
  end if;
  if p_submitted_on is not distinct from v.submitted_on and p_accepted_on is not distinct from v.accepted_on then
    return v; -- nothing to change: a retry
  end if;

  perform set_config('reqon.milestone_submission_write', 'on', true);
  update milestones set
    submitted_on = p_submitted_on,
    submitted_by = case when p_submitted_on is null then null
                        when p_submitted_on is distinct from v.submitted_on then auth.uid() else v.submitted_by end,
    accepted_on  = p_accepted_on,
    accepted_by  = case when p_accepted_on is null then null
                        when p_accepted_on is distinct from v.accepted_on then auth.uid() else v.accepted_by end
   where key = p_key
  returning * into v;
  perform set_config('reqon.milestone_submission_write', 'off', true);
  return v;
end $fn$;

revoke all on function set_milestone_submission(text, date, date) from public, anon;
grant execute on function set_milestone_submission(text, date, date) to authenticated, service_role;
