-- =============================================================================
--  Backend completion Phase 4, step 5 of 7: "checked and ready" is a person's
--  confirmation, and it lapses when what was checked changes. (PERMISSIONS.md §8;
--  open decision OD-4, default adopted; requirement "passing a limit or reaching an
--  ideal does not itself constitute readiness approval".)
--
--  WHAT WAS WRONG. A specification turned green as soon as its value passed the rule and
--  met the internal goal. Nothing recorded that anybody had checked it, on which
--  measurement, or when — and a later measurement, a withdrawal or a changed target left that
--  "green" standing.
--
--  AFTER.
--   * spec_readiness: append-only confirmations. One row says: this person, with this written
--     evidence note, confirmed THIS exact team measurement as ready, on this day. Rows are never
--     edited; the only change is a one-time revocation (who, when, why; revoked_by is NULL when
--     the system lapsed it).
--   * Who: can_manage_spec_evidence — President, Vice President, Developer, or the authority
--     of the department that owns the specification's requirement. Confirming needs the
--     CURRENT team measurement (not a competition one), that measurement must PASS the
--     regulatory rule, and a note is required. Passing, or meeting the goal, confirms nothing by
--     itself.
--   * Lapse — automatic, durable, audited:
--       - a newer team observation becomes current, a correction replaces the checked one,
--         or the checked one is withdrawn  → the confirmation is revoked ("a newer measurement",
--         "the measurement was corrected or withdrawn");
--       - the rule or any target changes (comparator, targets, bounds, tolerance, goals, ideal,
--         direction, unit, plausible range) → revoked ("the rule or targets changed").
--     A lapsed confirmation is never revived by itself, even if an older measurement becomes
--     current again: someone confirms again. The screen shows "was ready on <date>", not
--     "ready".
--   * One live confirmation per specification (partial unique index); a new confirmation
--     supersedes the old one in the same transaction under the specification's row lock.
--   * Retry-safe: confirming the same measurement again returns the existing confirmation.
--   * Audit: readiness_confirmed / readiness_withdrawn / readiness_lapsed on the specification.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Explicit, invalidating readiness evidence.
--    Existing data  New empty table. Nothing is confirmed for any existing specification (none was
--                   ever checked in Reqon), so no row can read "ready" until a person confirms.
--    Authorization  RLS SELECT for members; no write policy or grant. Commands SECURITY DEFINER,
--                   pinned search_path, EXECUTE for authenticated and service_role only; the
--                   lapse helper and triggers are not executable by API roles.
--    Locking        CREATE TABLE; each command and each lapse takes the specification row FOR UPDATE
--                   (the same lock the measurement commands take), so a confirmation and a new
--                   measurement serialise.
--    Rollback       Drop spec_readiness and the four functions; re-create refresh_spec_current
--                   from 20260129000300.
--    Deploy order   After 20260129000300; the Spec Sheet shows readiness after 20260129000500.
-- =============================================================================

create table if not exists spec_readiness (
  id             uuid        primary key default gen_random_uuid(),
  spec_id        uuid        not null references specs(id) on delete restrict,
  season_id      uuid        not null references seasons(id) on delete restrict,
  measurement_id uuid        not null references spec_measurements(id) on delete restrict,
  confirmed_by   uuid        references members(id) on delete set null,
  -- clock_timestamp(), not now(): two confirmations in one transaction still order correctly.
  confirmed_at   timestamptz not null default clock_timestamp(),
  note           text        not null check (length(clean_text(note)) between 1 and 500),
  revoked_at     timestamptz,
  revoked_by     uuid        references members(id) on delete set null,
  revoke_reason  text        check (revoke_reason is null or length(clean_text(revoke_reason)) between 1 and 500),
  constraint spec_readiness_revocation check ((revoked_at is null) = (revoke_reason is null))
);
create unique index if not exists spec_readiness_one_live on spec_readiness (spec_id) where revoked_at is null;
create index if not exists spec_readiness_history on spec_readiness (spec_id, confirmed_at desc, id desc);
create index if not exists spec_readiness_season on spec_readiness (season_id);
create index if not exists spec_readiness_measurement on spec_readiness (measurement_id);

comment on table spec_readiness is
  'Append-only "checked and ready" confirmations of one exact team measurement of a specification. Revoked (never edited or deleted) when the measurement stops being current, is corrected or withdrawn, or the rule/targets change.';

create or replace function guard_spec_readiness_rows() returns trigger
language plpgsql set search_path = public as $fn$
declare frozen text[] := array['revoked_at', 'revoked_by', 'revoke_reason', 'confirmed_by'];
begin
  if TG_OP = 'DELETE' then
    raise exception 'readiness history is append-only' using errcode = '42501';
  end if;
  if (to_jsonb(new) - frozen) is distinct from (to_jsonb(old) - frozen) then
    raise exception 'readiness history is append-only' using errcode = '42501';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at or new.revoke_reason is distinct from old.revoke_reason) then
    raise exception 'a revoked confirmation cannot be changed' using errcode = '42501';
  end if;
  return new;
end $fn$;
revoke all on function guard_spec_readiness_rows() from public, anon, authenticated;
drop trigger if exists trg_guard_spec_readiness_rows on spec_readiness;
create trigger trg_guard_spec_readiness_rows before update or delete on spec_readiness
  for each row execute function guard_spec_readiness_rows();

alter table spec_readiness enable row level security;
alter table spec_readiness replica identity full;
drop policy if exists member_read on spec_readiness;
create policy member_read on spec_readiness for select to authenticated using (is_member());
revoke all on spec_readiness from anon, authenticated;
grant select on spec_readiness to authenticated;
grant all on spec_readiness to service_role;

do $pub$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'spec_readiness') then
    alter publication supabase_realtime add table spec_readiness;
  end if;
end
$pub$;

-- Internal: revoke the live confirmation of one specification. The caller holds its row lock.
create or replace function lapse_spec_readiness(p_spec_id uuid, p_reason text, p_by uuid default null) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  r spec_readiness%rowtype;
  sp specs%rowtype;
begin
  update spec_readiness set revoked_at = now(), revoked_by = p_by, revoke_reason = p_reason
   where spec_id = p_spec_id and revoked_at is null
  returning * into r;
  if not found then
    return false;
  end if;
  select * into sp from specs where id = p_spec_id;
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (p_by, r.season_id, 'spec', p_spec_id::text,
          case when p_by is null then 'readiness_lapsed' else 'readiness_withdrawn' end,
          jsonb_build_object('parameter', sp.parameter, 'measurement_id', r.measurement_id,
                             'confirmed_at', r.confirmed_at, 'reason', p_reason));
  return true;
end $fn$;
revoke all on function lapse_spec_readiness(uuid, text, uuid) from public, anon, authenticated;

-- The current value is recomputed after every observation command; a confirmation of anything
-- other than the (new) current team measurement lapses here, in the same transaction.
create or replace function refresh_spec_current(p_spec_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  m spec_measurements;
  checked spec_measurements;
begin
  select * into m from spec_measurements
   where spec_id = p_spec_id and invalidated_at is null and context = 'team'
   order by measured_at desc nulls last, recorded_at desc, id desc
   limit 1;
  update specs set measured = m.value_numeric, measured_bool = m.value_bool,
                   measured_at = m.measured_at, measured_by = m.measured_by,
                   current_measurement_id = m.id
   where id = p_spec_id;

  select cm.* into checked
    from spec_readiness r join spec_measurements cm on cm.id = r.measurement_id
   where r.spec_id = p_spec_id and r.revoked_at is null;
  if found and checked.id is distinct from m.id then
    perform lapse_spec_readiness(p_spec_id,
      case when checked.invalidated_at is not null
           then 'The measurement that was checked was corrected or withdrawn.'
           else 'A newer measurement became the current one.' end);
  end if;
end $fn$;

-- The rule or the targets changed: what was checked no longer describes the requirement.
create or replace function lapse_readiness_on_target_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if (new.comparator, new.target, new.target_max, new.target_min_inclusive, new.target_max_inclusive,
      new.target_tolerance, new.target_bool, new.acceptable, new.goal, new.goal_max, new.goal_tolerance,
      new.ideal, new.goal_bool, new.direction, new.unit, new.plausible_min, new.plausible_max)
     is distinct from
     (old.comparator, old.target, old.target_max, old.target_min_inclusive, old.target_max_inclusive,
      old.target_tolerance, old.target_bool, old.acceptable, old.goal, old.goal_max, old.goal_tolerance,
      old.ideal, old.goal_bool, old.direction, old.unit, old.plausible_min, old.plausible_max) then
    perform lapse_spec_readiness(new.id, 'The rule or the targets of this specification changed.');
  end if;
  return null;
end $fn$;
revoke all on function lapse_readiness_on_target_change() from public, anon, authenticated;
drop trigger if exists trg_lapse_readiness_on_target_change on specs;
create trigger trg_lapse_readiness_on_target_change after update on specs
  for each row execute function lapse_readiness_on_target_change();

-- ------------------------------------------------------------------ commands
create or replace function confirm_spec_readiness(p_spec_id uuid, p_measurement_id uuid, p_note text)
returns spec_readiness
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := auth.uid();
  sp specs;
  m spec_measurements;
  live spec_readiness;
  r spec_readiness;
  v_note text := clean_text(coalesce(p_note, ''));
  had_live boolean;
begin
  if actor is null or not is_active_member() then
    raise exception 'Only an active member can confirm readiness.' using errcode = '42501';
  end if;
  if p_measurement_id is null then
    raise exception 'Say which measurement you checked.' using errcode = '22004';
  end if;
  select * into sp from specs where id = p_spec_id for update;       -- serialises with measuring
  if not found then
    raise exception 'That specification does not exist.' using errcode = 'P0002';
  end if;
  if not can_manage_spec_evidence(p_spec_id) then
    raise exception 'Readiness is confirmed by the President, Vice President, a Developer or the authority of the requirement''s department.'
      using errcode = '42501';
  end if;
  if v_note = '' or char_length(v_note) > 500 then
    raise exception 'Confirming readiness needs a written note of what was checked (1 to 500 characters).' using errcode = '23514';
  end if;

  select * into live from spec_readiness where spec_id = p_spec_id and revoked_at is null;
  had_live := found;
  if had_live and live.measurement_id = p_measurement_id then
    return live;                                  -- a retry of the same confirmation
  end if;

  if sp.current_measurement_id is distinct from p_measurement_id then
    raise exception 'The current measurement changed since you looked at it. Check the current one before confirming.'
      using errcode = '40001';
  end if;
  select * into m from spec_measurements where id = p_measurement_id;
  if m.invalidated_at is not null or m.context <> 'team' then
    raise exception 'Only a current team measurement can be confirmed ready.' using errcode = '22023';
  end if;
  if spec_regulatory_verdict(sp.comparator, sp.target, sp.target_max, sp.target_min_inclusive, sp.target_max_inclusive,
                             sp.target_tolerance, sp.target_bool, m.value_numeric, m.value_bool) <> 'pass' then
    raise exception 'Only a measurement that passes the requirement can be confirmed ready.' using errcode = '22023';
  end if;

  if had_live then
    perform lapse_spec_readiness(p_spec_id, 'Superseded by a new confirmation.', actor);
  end if;
  insert into spec_readiness (spec_id, season_id, measurement_id, confirmed_by, note)
  values (p_spec_id, sp.season_id, p_measurement_id, actor, v_note)
  returning * into r;

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (actor, sp.season_id, 'spec', sp.id::text, 'readiness_confirmed',
          jsonb_build_object('parameter', sp.parameter, 'measurement_id', p_measurement_id, 'readiness_id', r.id));
  return r;
end $fn$;

create or replace function revoke_spec_readiness(p_spec_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := auth.uid();
  v_reason text := clean_text(coalesce(p_reason, ''));
begin
  if actor is null or not is_active_member() then
    raise exception 'Only an active member can withdraw a readiness confirmation.' using errcode = '42501';
  end if;
  perform 1 from specs where id = p_spec_id for update;
  if not found then
    raise exception 'That specification does not exist.' using errcode = 'P0002';
  end if;
  if not can_manage_spec_evidence(p_spec_id) then
    raise exception 'Readiness is withdrawn by the President, Vice President, a Developer or the authority of the requirement''s department.'
      using errcode = '42501';
  end if;
  if v_reason = '' or char_length(v_reason) > 500 then
    raise exception 'Withdrawing a confirmation needs a reason of at most 500 characters.' using errcode = '23514';
  end if;
  return lapse_spec_readiness(p_spec_id, v_reason, actor);
end $fn$;

revoke all on function confirm_spec_readiness(uuid, uuid, text) from public, anon;
revoke all on function revoke_spec_readiness(uuid, text) from public, anon;
grant execute on function confirm_spec_readiness(uuid, uuid, text) to authenticated, service_role;
grant execute on function revoke_spec_readiness(uuid, text) to authenticated, service_role;
