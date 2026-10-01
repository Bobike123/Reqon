-- =============================================================================
--  Backend completion Phase 4, step 6 of 7: engineering direction is reviewed per
--  parameter, and the verdict view separates regulation, readiness and competition.
--  (PERMISSIONS.md §8; phase-01 finding F-16; open decision OD-10.)
--
--  WHAT WAS WRONG.
--   * `direction` (which way the PROJECT wants a value to move) was backfilled mechanically
--     from the regulatory comparator: every "minimum" became higher_better. That is wrong
--     whenever lower is better for the design (the seeded "Minimum total weight, no rider" is a
--     floor set by the rules, yet a heavier bike is worse for us). It stayed harmless only
--     because no goal was set yet.
--   * The zone turned green on "passes AND goal met" — no person had checked anything.
--
--  AFTER.
--   * specs.direction_reviewed_at / _by / direction_note. A higher_better / lower_better direction
--     is UNREVIEWED until President, Vice President or a Developer confirms it with
--     review_spec_direction(spec, direction, note) — which may keep or flip it. Range, exact and
--     boolean directions carry no min/max ambiguity and are not flagged. Nothing is reviewed on
--     the club's behalf: every existing higher_better / lower_better specification starts
--     "direction not reviewed", and the migration changes no direction.
--   * While a direction is unreviewed, acceptable / goal / ideal cannot be set on that
--     specification from a user session (trigger), and any goal that exists anyway (an import, a
--     maintenance write) is NOT scored: goal_status reads 'direction_unreviewed' instead of
--     met/short/unacceptable. Unknown stays unknown instead of being scored the wrong way round.
--     The reviewed_* columns can be written by the command only; changing a direction by hand
--     makes it unreviewed again.
--   * spec_verdicts is rebuilt (columns are added; the old ones keep their names and meaning
--     except `zone`):
--       verdict       pass | fail | unmeasured | unevaluable         (regulation, TEAM value)
--       goal_status   unchanged (internal targets)
--       readiness     not_confirmed | ready | lapsed + readiness_reason / _confirmed_at / _by / _note
--       zone          red = fails the rule; green = passes AND a person confirmed the current
--                     measurement ready (spec_readiness); amber = passes but not (or no longer)
--                     confirmed; grey = anything unknown. Passing or meeting the goal alone is amber.
--       competition_* the latest accepted COMPETITION observation and its own verdict; it never
--                     feeds the team value, the zone or readiness
--       direction_needs_review
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Reviewed directions; readiness-based zone; competition columns.
--    Existing data  Three nullable columns; no direction, target or measurement is changed. The 28
--                   seeded specifications keep their values (26 higher/lower ones now read
--                   "direction not reviewed"); none has an internal target, so the new trigger
--                   refuses nothing already stored.
--    Authorization  review_spec_direction: can_edit_spec_targets() (President, Vice President,
--                   Developer). SECURITY DEFINER, pinned search_path, EXECUTE for authenticated and
--                   service_role only. View is security_invoker.
--    Locking        ADD COLUMN nullable; DROP/CREATE VIEW; the command locks one specification row.
--    Rollback       Re-create spec_verdicts from 20260122000000; drop the columns, trigger and command.
--    Deploy order   After 20260129000400. The Spec Sheet reads the new columns after this.
-- =============================================================================

alter table specs
  add column if not exists direction_reviewed_at timestamptz null,
  add column if not exists direction_reviewed_by uuid null references members(id) on delete set null,
  add column if not exists direction_note text null;

do $c$ begin
  alter table specs add constraint specs_direction_note_length
    check (direction_note is null or char_length(direction_note) <= 500);
exception when duplicate_object then null; end $c$;

comment on column specs.direction_reviewed_at is
  'When a person confirmed which way is better for the project. NULL for a higher_better/lower_better direction = not reviewed (it was derived from the regulatory comparator and may be the wrong way round).';

-- Internal targets need a reviewed direction; the review columns belong to the command.
create or replace function guard_spec_direction() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if current_user in ('authenticated', 'anon') then
    if TG_OP = 'INSERT' and (new.direction_reviewed_at is not null or new.direction_reviewed_by is not null
                             or new.direction_note is not null) then
      raise exception 'A direction is reviewed with review_spec_direction.' using errcode = '42501';
    end if;
    if TG_OP = 'UPDATE' and (new.direction_reviewed_at, new.direction_reviewed_by, new.direction_note)
         is distinct from (old.direction_reviewed_at, old.direction_reviewed_by, old.direction_note) then
      raise exception 'A direction is reviewed with review_spec_direction.' using errcode = '42501';
    end if;
    -- A changed direction is a new question: it is unreviewed again.
    if TG_OP = 'UPDATE' and new.direction is distinct from old.direction then
      new.direction_reviewed_at := null;
      new.direction_reviewed_by := null;
      new.direction_note := null;
    end if;
    if new.direction in ('higher_better', 'lower_better') and new.direction_reviewed_at is null
       and (new.acceptable is not null or new.goal is not null or new.ideal is not null) then
      raise exception 'Review which way is better for "%" before setting an acceptable, goal or ideal value: its direction was derived from the rule and has not been confirmed.',
        new.parameter using errcode = '23514';
    end if;
  end if;
  return new;
end $fn$;
revoke all on function guard_spec_direction() from public, anon, authenticated;
drop trigger if exists trg_guard_spec_direction on specs;
create trigger trg_guard_spec_direction before insert or update on specs
  for each row execute function guard_spec_direction();

create or replace function review_spec_direction(p_spec_id uuid, p_direction text, p_note text)
returns specs
language plpgsql security definer set search_path = public as $fn$
declare
  sp specs;
  v_note text := clean_text(coalesce(p_note, ''));
begin
  if auth.uid() is null or not is_active_member() or not can_edit_spec_targets() then
    raise exception 'Only the President, Vice President or a Developer can review a direction.' using errcode = '42501';
  end if;
  select * into sp from specs where id = p_spec_id for update;
  if not found then
    raise exception 'That specification does not exist.' using errcode = 'P0002';
  end if;
  if sp.direction not in ('higher_better', 'lower_better') then
    raise exception 'This specification does not have a higher/lower direction to review (it is %).', sp.direction using errcode = '22023';
  end if;
  if p_direction is null or p_direction not in ('higher_better', 'lower_better') then
    raise exception 'The direction is higher_better or lower_better.' using errcode = '22023';
  end if;
  if v_note = '' or char_length(v_note) > 500 then
    raise exception 'Say why (1 to 500 characters): the engineering reason for this direction.' using errcode = '23514';
  end if;

  if p_direction = sp.direction and sp.direction_reviewed_at is not null and sp.direction_note is not distinct from v_note then
    return sp; -- a retry of the same review
  end if;

  update specs set direction = p_direction, direction_reviewed_at = now(),
                   direction_reviewed_by = auth.uid(), direction_note = v_note
   where id = p_spec_id
  returning * into sp;

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), sp.season_id, 'spec', sp.id::text, 'direction_reviewed',
          jsonb_build_object('parameter', sp.parameter, 'direction', sp.direction, 'note', v_note));
  return sp;
end $fn$;
revoke all on function review_spec_direction(uuid, text, text) from public, anon;
grant execute on function review_spec_direction(uuid, text, text) to authenticated, service_role;

-- The review columns have their own event ('direction_reviewed'); they are not a change of the rule.
create or replace function log_spec_targets() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  skip text[] := array['measured', 'measured_bool', 'measured_at', 'measured_by', 'current_measurement_id',
                      'direction_reviewed_at', 'direction_reviewed_by', 'direction_note'];
  diff jsonb;
begin
  select jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
    into diff
  from jsonb_each(to_jsonb(new) - skip) n
  join jsonb_each(to_jsonb(old) - skip) o on o.key = n.key
  where n.value is distinct from o.value;
  if diff is not null then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), new.season_id, 'spec', new.id::text, 'targets_changed',
      jsonb_build_object('parameter', new.parameter, 'changes', diff));
  end if;
  return new;
end $fn$;

-- ---------------------------------------------------------------- the view
drop view if exists spec_verdicts;
create view spec_verdicts as
select s.*,
       rv.verdict,
       case when s.direction in ('higher_better', 'lower_better') and s.direction_reviewed_at is null
                 and s.measured is not null and (s.goal is not null or s.acceptable is not null)
            then 'direction_unreviewed' else gs.goal_status end as goal_status,
       case
         when rv.verdict = 'fail' then 'red'
         when rv.verdict = 'pass' and rd_state.readiness = 'ready' then 'green'
         when rv.verdict = 'pass' then 'amber'
         else 'grey'
       end as zone,
       rd_state.readiness,
       rd_state.reason as readiness_reason,
       rd.confirmed_at as readiness_confirmed_at,
       rd.confirmed_by as readiness_confirmed_by,
       rd.note as readiness_note,
       rd.measurement_id as readiness_measurement_id,
       rd.revoked_at as readiness_revoked_at,
       cc.measurement_id as competition_measurement_id,
       cc.value_numeric as competition_value,
       cc.value_bool as competition_value_bool,
       cc.measured_at as competition_measured_at,
       (spec_regulatory_verdict(s.comparator, s.target, s.target_max, s.target_min_inclusive, s.target_max_inclusive,
                                s.target_tolerance, s.target_bool, cc.value_numeric, cc.value_bool)) as competition_verdict,
       (s.direction in ('higher_better', 'lower_better') and s.direction_reviewed_at is null) as direction_needs_review
from specs s
cross join lateral (select spec_regulatory_verdict(
  s.comparator, s.target, s.target_max, s.target_min_inclusive, s.target_max_inclusive,
  s.target_tolerance, s.target_bool, s.measured, s.measured_bool) as verdict) rv
cross join lateral (select spec_goal_status(
  s.direction, s.goal, s.goal_max, s.goal_tolerance, s.goal_bool, s.acceptable,
  s.measured, s.measured_bool) as goal_status) gs
left join lateral (
  select r.* from spec_readiness r where r.spec_id = s.id
   order by (r.revoked_at is null) desc, r.confirmed_at desc, r.id desc limit 1
) rd on true
cross join lateral (select
  case when rd.id is null then 'not_confirmed'
       when rd.revoked_at is null and rd.measurement_id = s.current_measurement_id and rv.verdict = 'pass' then 'ready'
       else 'lapsed' end as readiness,
  case when rd.id is null then null
       when rd.revoked_at is not null then rd.revoke_reason
       when rd.measurement_id is distinct from s.current_measurement_id then 'A newer measurement became the current one.'
       when rv.verdict <> 'pass' then 'The current measurement no longer passes.'
       else null end as reason) rd_state
left join v_spec_competition_current cc on cc.spec_id = s.id;
alter view spec_verdicts set (security_invoker = on);

comment on view spec_verdicts is
  'One row per specification: regulatory verdict and goal status of the TEAM value, readiness (a person''s confirmation of the current measurement, lapsing when it changes), zone (green only when passing AND confirmed ready), the latest COMPETITION observation with its own verdict, and whether the engineering direction still needs review.';

revoke all on spec_verdicts from anon;
grant select on spec_verdicts to authenticated;
