-- =============================================================================
--  Specification domain and measurement history (Phase 9, ADR-0008,
--  requirements R25-R28, R39.1, R44, R54.1).
--
--  BEFORE.
--   * specs had one regulatory rule (comparator + target). `range` was never
--     evaluated (V21). A missing target compared as a fail, and "measured but
--     the rule is incomplete" could not be told apart from "not measured".
--   * Any active member could UPDATE any column of a spec, including the rule
--     itself and the measured value/actor/time, and could DELETE a spec (V10).
--   * The measured value was overwritten in place. The only history was one
--     activity row per change, with the browser's clock as measured_at (V22).
--
--  AFTER.
--   Domain (kept on the existing `specs` entity, one row per characteristic):
--     direction            higher_better | lower_better | range | exact | boolean
--                          Which way the PROJECT wants the value to move. It is
--                          independent of the regulatory comparator (a 85 kg
--                          regulatory minimum is still lower-is-better for us).
--                          Backfilled from the existing comparator; nothing is
--                          parsed from target_text.
--     measure_kind         numeric | boolean (generated from direction).
--     Regulatory rule      comparator min|max|eq|range|bool, target,
--                          target_max, target_min_inclusive/max_inclusive
--                          (range only), target_tolerance (eq only),
--                          target_bool (bool only).
--     Internal targets     acceptable, goal, ideal (higher/lower only),
--                          goal_max (range), goal_tolerance (exact), goal_bool
--                          (boolean). All NULL when unknown; nothing invented.
--     Plausibility         plausible_min / plausible_max per spec. No global cap.
--   History (new): spec_measurements, append-only, one row per accepted
--     observation, with the measured time, the SERVER recorded time and the
--     SERVER-derived measurer.
--   Commands: record_spec_measurement, correct_spec_measurement,
--     invalidate_spec_measurement. They are the only way in.
--   Verdicts (SQL, immutable functions + the rebuilt spec_verdicts view):
--     verdict        pass | fail | unmeasured | unevaluable   (regulatory)
--     goal_status    met | short | unacceptable | not_set | unmeasured
--     zone           red | amber | green | grey
--   Current value ORDER (documented decision): the newest ACCEPTED observation,
--     i.e. not invalidated, by measured_at DESC (unknown time last), then the
--     server recorded_at DESC, then id DESC. A backdated observation therefore
--     adds history without displacing a newer current value. specs.measured,
--     measured_bool, measured_at, measured_by and current_measurement_id remain
--     as a compatibility CACHE that only refresh_spec_current() may write; it
--     runs inside every command's transaction after the spec row is locked.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        See above.
--    Existing data  Every spec keeps its id, rule, unit, clause link and
--                   condition. direction is derived from the comparator. The
--                   one seeded range spec ('Competition number', clause
--                   A.3.1.6 "a bike number between 1 and 99") is given the
--                   bounds 1 and 99 by an exact-match update on that row, not by
--                   parsing text; any other range spec stays 'unevaluable'
--                   until an administrator supplies bounds. Each spec that has a
--                   measured value gets at most ONE observation, origin
--                   'legacy_import': value and measured_at as stored;
--                   measured_by from the audit trail's server-recorded actor
--                   when there is one, else the stored measured_by, else NULL
--                   (unknown, not the migration operator); recorded_at from the
--                   audit row's time, else the migration time. No earlier
--                   history is invented.
--    Authorization  specs: read stays is_member(); insert/update/delete now
--                   need can_edit_spec_targets() (President, Vice President,
--                   Developer). Heads and ordinary members lose the blanket
--                   write they had. Measuring goes only through the commands,
--                   which need an ACTIVE member. spec_measurements has no write
--                   policy and no write grant; a trigger also refuses UPDATE
--                   (except the one-time invalidation) and DELETE for every
--                   role. The cache columns of specs cannot be written by
--                   authenticated/anon at all.
--    Locking        ALTER TABLE ... ADD COLUMN with constant defaults (no
--                   rewrite except the generated column, on a few dozen rows);
--                   the view is dropped and recreated. Each command takes a row
--                   lock on the one spec (FOR UPDATE), so saves for one spec
--                   serialise and different specs do not block each other.
--    Rollback       Forward recovery only: measurements would be lost by
--                   dropping the table. To revert the client, restore the old
--                   view definition and the member_write policy, keep the table.
--    Deploy order   After 20260121. The client of this phase needs this
--                   migration; the previous client still reads spec_verdicts
--                   but its direct specs.measured write is refused.
-- =============================================================================

-- ------------------------------------------------------------ 1. helpers
create or replace function is_finite_number(n numeric) returns boolean
language sql immutable as $fn$
  select n is not null and n not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric);
$fn$;

-- Target administration is its own capability. It deliberately does not reuse
-- is_department_head(): a department Head has no specification-wide authority.
-- The same three roles as department configuration hold it today; it is a
-- separate function so the two can diverge without touching every policy.
create or replace function can_edit_spec_targets() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('vicepresident') or has_role('developer');
$fn$;

-- ------------------------------------------------------- 2. specs: expand
alter table specs drop constraint if exists specs_comparator_check;

alter table specs
  add column if not exists direction             text,
  add column if not exists target_max            numeric,
  add column if not exists target_min_inclusive  boolean not null default true,
  add column if not exists target_max_inclusive  boolean not null default true,
  add column if not exists target_tolerance      numeric,
  add column if not exists target_bool           boolean,
  add column if not exists acceptable            numeric,
  add column if not exists goal                  numeric,
  add column if not exists goal_max              numeric,
  add column if not exists goal_tolerance        numeric,
  add column if not exists ideal                 numeric,
  add column if not exists goal_bool             boolean,
  add column if not exists plausible_min         numeric,
  add column if not exists plausible_max         numeric,
  add column if not exists measured_bool         boolean,
  add column if not exists current_measurement_id uuid;

-- Backfill: the natural project direction of each existing regulatory comparator.
update specs set direction = case comparator
  when 'min'   then 'higher_better'
  when 'max'   then 'lower_better'
  when 'eq'    then 'exact'
  when 'range' then 'range'
end
where direction is null;

-- The one seeded range spec, matched exactly (see the note above).
update specs set target = 1, target_max = 99
where comparator = 'range' and target is null and target_max is null
  and clause_key = 'A.3.1.6' and target_text = '1–99';

alter table specs alter column direction set not null;
alter table specs add column if not exists measure_kind text
  generated always as (case when direction = 'boolean' then 'boolean' else 'numeric' end) stored;

comment on column specs.direction is
  'Which way the project wants the value to move. higher_better/lower_better take acceptable <= goal <= ideal (reversed for lower); range takes a goal band goal..goal_max; exact takes goal with an optional goal_tolerance; boolean takes goal_bool. Independent of the regulatory comparator.';
comment on column specs.comparator is
  'REGULATORY rule only: min (>= target), max (<= target), eq (target within target_tolerance), range (target..target_max, bounds inclusive unless flagged), bool (must equal target_bool).';
comment on column specs.acceptable is
  'Worst value the project accepts. A LOWER-is-better spec reads it as a maximum acceptable value (an upper bound), a higher-is-better one as a minimum. Ordering applies to higher_better/lower_better only; NULL = unknown.';
comment on column specs.goal is 'Internal goal (range: lower edge of the goal band). NULL = not set.';
comment on column specs.ideal is 'Stretch value beyond the goal; higher_better/lower_better only.';

alter table specs
  add constraint specs_comparator_valid check (comparator in ('min', 'max', 'eq', 'range', 'bool')),
  add constraint specs_direction_valid check (direction in ('higher_better', 'lower_better', 'range', 'exact', 'boolean')),
  add constraint specs_kind_matches check ((comparator = 'bool') = (direction = 'boolean')),
  add constraint specs_numbers_finite check (
    (target is null or is_finite_number(target)) and (target_max is null or is_finite_number(target_max))
    and (target_tolerance is null or is_finite_number(target_tolerance))
    and (acceptable is null or is_finite_number(acceptable)) and (goal is null or is_finite_number(goal))
    and (goal_max is null or is_finite_number(goal_max)) and (goal_tolerance is null or is_finite_number(goal_tolerance))
    and (ideal is null or is_finite_number(ideal))
    and (plausible_min is null or is_finite_number(plausible_min)) and (plausible_max is null or is_finite_number(plausible_max))
    and (measured is null or is_finite_number(measured))),
  -- Regulatory rule shape.
  add constraint specs_rule_range_only check (comparator = 'range' or (target_max is null and target_min_inclusive and target_max_inclusive)),
  add constraint specs_rule_tolerance check (target_tolerance is null or (comparator = 'eq' and target_tolerance >= 0)),
  add constraint specs_rule_bool check ((comparator = 'bool' or target_bool is null) and (comparator <> 'bool' or (target is null and target_max is null))),
  add constraint specs_rule_range_order check (
    target is null or target_max is null or target < target_max
    or (target = target_max and target_min_inclusive and target_max_inclusive)),
  -- Internal targets: which parameters apply to which direction.
  add constraint specs_goal_kind check (
    (direction = 'boolean' and acceptable is null and goal is null and goal_max is null and goal_tolerance is null
       and ideal is null and plausible_min is null and plausible_max is null)
    or (direction <> 'boolean' and goal_bool is null)),
  add constraint specs_goal_shapes check (
    (direction in ('higher_better', 'lower_better') or (acceptable is null and ideal is null))
    and (direction = 'range' or goal_max is null)
    and (direction <> 'range' or (goal is null) = (goal_max is null))
    and (goal_tolerance is null or (direction = 'exact' and goal_tolerance >= 0))),
  -- Ordering, only where it means something.
  add constraint specs_goal_order check (
    case direction
      when 'higher_better' then
        (acceptable is null or goal is null or acceptable <= goal) and (goal is null or ideal is null or goal <= ideal)
        and (acceptable is null or ideal is null or acceptable <= ideal)
      when 'lower_better' then
        (acceptable is null or goal is null or acceptable >= goal) and (goal is null or ideal is null or goal >= ideal)
        and (acceptable is null or ideal is null or acceptable >= ideal)
      when 'range' then goal is null or goal_max is null or goal <= goal_max
      else true
    end),
  add constraint specs_plausible_order check (plausible_min is null or plausible_max is null or plausible_min <= plausible_max),
  -- The compatibility cache holds the kind of value the spec measures.
  add constraint specs_current_kind check ((direction = 'boolean' and measured is null) or (direction <> 'boolean' and measured_bool is null));

-- ----------------------------------------------- 3. spec_measurements (history)
create table if not exists spec_measurements (
  id                   uuid primary key default gen_random_uuid(),
  spec_id              uuid not null references specs(id) on delete restrict,
  season_id            uuid not null references seasons(id) on delete restrict,
  value_numeric        numeric,
  value_bool           boolean,
  -- When the value was measured. NULL only for a legacy import with no known time.
  measured_at          timestamptz,
  -- When the server accepted it. Never taken from the client.
  recorded_at          timestamptz not null default now(),
  -- The authenticated member who saved it. NULL only when unknown (legacy) or
  -- after that member row was deleted.
  measured_by          uuid references members(id) on delete set null,
  origin               text not null default 'entered' check (origin in ('entered', 'correction', 'legacy_import')),
  note                 text check (note is null or char_length(note) <= 1000),
  source               text check (source is null or char_length(source) <= 300),
  -- Client-generated retry identity; unique per member, so it is never authority.
  request_id           uuid not null default gen_random_uuid(),
  corrects_id          uuid references spec_measurements(id) on delete restrict,
  invalidated_at       timestamptz,
  invalidated_by       uuid references members(id) on delete set null,
  invalidation_reason  text check (invalidation_reason is null or char_length(invalidation_reason) <= 500),
  constraint spec_measurements_one_value check ((value_numeric is not null)::int + (value_bool is not null)::int = 1),
  constraint spec_measurements_finite check (value_numeric is null or is_finite_number(value_numeric)),
  constraint spec_measurements_time check (origin = 'legacy_import' or measured_at is not null),
  constraint spec_measurements_correction check ((origin = 'correction') = (corrects_id is not null)),
  constraint spec_measurements_invalidation check (
    (invalidated_at is null) = (invalidation_reason is null)
    and (invalidation_reason is null or btrim(invalidation_reason) <> ''))
);

comment on table spec_measurements is
  'Append-only engineering history: one row per accepted observation of a spec. Written only by record/correct/invalidate_spec_measurement. Distinct from activity, which records THAT it happened.';

create unique index if not exists spec_measurements_request_key on spec_measurements (measured_by, request_id) where measured_by is not null;
-- Current value pick and paginated history (keyset: measured_at, recorded_at, id).
create index if not exists spec_measurements_history_idx on spec_measurements (spec_id, measured_at desc nulls last, recorded_at desc, id desc);
create index if not exists spec_measurements_accepted_idx on spec_measurements (spec_id, measured_at desc nulls last, recorded_at desc, id desc) where invalidated_at is null;
create index if not exists spec_measurements_season_idx on spec_measurements (season_id, measured_at desc nulls last);
create index if not exists spec_measurements_corrects_idx on spec_measurements (corrects_id) where corrects_id is not null;

alter table specs add constraint specs_current_measurement_fkey
  foreign key (current_measurement_id) references spec_measurements(id) on delete restrict;
create index if not exists specs_current_measurement_idx on specs (current_measurement_id) where current_measurement_id is not null;

-- Every insert path is validated here, not only the command.
create or replace function validate_spec_measurement() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare sp specs;
begin
  select * into sp from specs where id = new.spec_id;
  if not found then
    raise exception 'specification not found' using errcode = 'P0002';
  end if;
  if new.season_id is distinct from sp.season_id then
    raise exception 'a measurement belongs to its specification''s season' using errcode = '23514';
  end if;
  if sp.direction = 'boolean' then
    if new.value_bool is null then
      raise exception 'this specification records a yes/no value' using errcode = '22023';
    end if;
  else
    if new.value_numeric is null then
      raise exception 'this specification records a number' using errcode = '22023';
    end if;
    if sp.plausible_min is not null and new.value_numeric < sp.plausible_min then
      raise exception 'value % is below the plausible minimum % for this specification', new.value_numeric, sp.plausible_min
        using errcode = '22003';
    end if;
    if sp.plausible_max is not null and new.value_numeric > sp.plausible_max then
      raise exception 'value % is above the plausible maximum % for this specification', new.value_numeric, sp.plausible_max
        using errcode = '22003';
    end if;
  end if;
  if new.origin <> 'legacy_import' and new.measured_at is not null and not isfinite(new.measured_at) then
    raise exception 'measured_at must be a real moment' using errcode = '22008';
  end if;
  if new.origin <> 'legacy_import' and new.measured_at > now() + interval '5 minutes' then
    raise exception 'measured_at cannot be in the future' using errcode = '22008';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_validate_spec_measurement on spec_measurements;
create trigger trg_validate_spec_measurement before insert on spec_measurements
  for each row execute function validate_spec_measurement();

-- Append-only. The only permitted UPDATE is the one-time invalidation; the
-- FK's ON DELETE SET NULL may blank a deleted member's id.
create or replace function guard_spec_measurement_rows() returns trigger
language plpgsql set search_path = public as $fn$
declare frozen text[] := array['invalidated_at', 'invalidated_by', 'invalidation_reason', 'measured_by'];
begin
  if TG_OP = 'DELETE' then
    raise exception 'measurement history is append-only' using errcode = '42501';
  end if;
  if (to_jsonb(new) - frozen) is distinct from (to_jsonb(old) - frozen) then
    raise exception 'measurement history is append-only' using errcode = '42501';
  end if;
  if old.invalidated_at is not null
     and (new.invalidated_at is distinct from old.invalidated_at
          or new.invalidation_reason is distinct from old.invalidation_reason) then
    raise exception 'an invalidated measurement cannot be changed' using errcode = '42501';
  end if;
  if new.measured_by is distinct from old.measured_by and new.measured_by is not null then
    raise exception 'the measurer cannot be rewritten' using errcode = '42501';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guard_spec_measurement_rows on spec_measurements;
create trigger trg_guard_spec_measurement_rows before update or delete on spec_measurements
  for each row execute function guard_spec_measurement_rows();

alter table spec_measurements enable row level security;
drop policy if exists member_read on spec_measurements;
create policy member_read on spec_measurements for select to authenticated using (is_member());
revoke all on spec_measurements from anon, authenticated;
grant select on spec_measurements to authenticated;

-- ----------------------------------------- 4. deterministic verdict functions
create or replace function spec_regulatory_verdict(
  p_comparator text, p_target numeric, p_target_max numeric,
  p_min_inclusive boolean, p_max_inclusive boolean, p_tolerance numeric,
  p_target_bool boolean, p_num numeric, p_bool boolean
) returns text language sql immutable as $fn$
  select case
    when p_num is null and p_bool is null then 'unmeasured'
    when p_comparator = 'bool' then
      case when p_bool is null or p_target_bool is null then 'unevaluable'
           when p_bool = p_target_bool then 'pass' else 'fail' end
    when p_num is null then 'unevaluable'
    when p_comparator = 'min' then
      case when p_target is null then 'unevaluable' when p_num >= p_target then 'pass' else 'fail' end
    when p_comparator = 'max' then
      case when p_target is null then 'unevaluable' when p_num <= p_target then 'pass' else 'fail' end
    when p_comparator = 'eq' then
      case when p_target is null then 'unevaluable'
           when abs(p_num - p_target) <= coalesce(p_tolerance, 0) then 'pass' else 'fail' end
    when p_comparator = 'range' then
      case when p_target is null or p_target_max is null then 'unevaluable'
           when (p_num > p_target or (coalesce(p_min_inclusive, true) and p_num = p_target))
            and (p_num < p_target_max or (coalesce(p_max_inclusive, true) and p_num = p_target_max)) then 'pass'
           else 'fail' end
    else 'unevaluable'
  end;
$fn$;

create or replace function spec_goal_status(
  p_direction text, p_goal numeric, p_goal_max numeric, p_goal_tolerance numeric, p_goal_bool boolean,
  p_acceptable numeric, p_num numeric, p_bool boolean
) returns text language sql immutable as $fn$
  select case
    when p_num is null and p_bool is null then 'unmeasured'
    when p_direction = 'boolean' then
      case when p_bool is null or p_goal_bool is null then 'not_set'
           when p_bool = p_goal_bool then 'met' else 'short' end
    when p_num is null then 'not_set'
    when p_direction = 'higher_better' then
      case when p_goal is not null and p_num >= p_goal then 'met'
           when p_acceptable is not null and p_num < p_acceptable then 'unacceptable'
           when p_goal is null then 'not_set'
           else 'short' end
    when p_direction = 'lower_better' then
      case when p_goal is not null and p_num <= p_goal then 'met'
           when p_acceptable is not null and p_num > p_acceptable then 'unacceptable'
           when p_goal is null then 'not_set'
           else 'short' end
    when p_direction = 'range' then
      case when p_goal is null or p_goal_max is null then 'not_set'
           when p_num between p_goal and p_goal_max then 'met' else 'short' end
    when p_direction = 'exact' then
      case when p_goal is null then 'not_set'
           when abs(p_num - p_goal) <= coalesce(p_goal_tolerance, 0) then 'met' else 'short' end
    else 'not_set'
  end;
$fn$;

-- red = regulatory failure; green = established pass AND goal met; amber = pass
-- but the goal is short/unacceptable; grey = anything unknown. Never green by default.
create or replace function spec_zone(p_verdict text, p_goal_status text) returns text
language sql immutable as $fn$
  select case
    when p_verdict = 'fail' then 'red'
    when p_verdict = 'pass' and p_goal_status = 'met' then 'green'
    when p_verdict = 'pass' and p_goal_status in ('short', 'unacceptable') then 'amber'
    else 'grey'
  end;
$fn$;

-- ------------------------------------------------------------ 5. the view
-- Dropped and recreated: s.* now has more columns, which CREATE OR REPLACE
-- VIEW cannot insert before the existing `verdict` column.
drop view if exists spec_verdicts;
create view spec_verdicts as
select s.*, rv.verdict, gs.goal_status, spec_zone(rv.verdict, gs.goal_status) as zone
from specs s
cross join lateral (select spec_regulatory_verdict(
  s.comparator, s.target, s.target_max, s.target_min_inclusive, s.target_max_inclusive,
  s.target_tolerance, s.target_bool, s.measured, s.measured_bool) as verdict) rv
cross join lateral (select spec_goal_status(
  s.direction, s.goal, s.goal_max, s.goal_tolerance, s.goal_bool, s.acceptable,
  s.measured, s.measured_bool) as goal_status) gs;
alter view spec_verdicts set (security_invoker = on);

-- ------------------------------------------------ 6. specs write protection
-- Defaults and season identity, on every path.
create or replace function spec_row_rules() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if TG_OP = 'INSERT' and new.direction is null then
    new.direction := case new.comparator
      when 'min' then 'higher_better' when 'max' then 'lower_better'
      when 'eq' then 'exact' when 'range' then 'range' when 'bool' then 'boolean' end;
  end if;
  if TG_OP = 'UPDATE' and new.season_id is distinct from old.season_id
     and exists (select 1 from spec_measurements where spec_id = old.id) then
    raise exception 'a specification with measurements cannot move to another season' using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_spec_row_rules on specs;
create trigger trg_spec_row_rules before insert or update on specs
  for each row execute function spec_row_rules();

-- The current-value cache is written by refresh_spec_current() only. That
-- function is SECURITY DEFINER, so inside it current_user is the owner; a
-- session running as authenticated/anon (PostgREST) is refused, whoever they are.
create or replace function guard_spec_current_cache() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if TG_OP = 'INSERT' then
    if new.measured is not null or new.measured_bool is not null or new.measured_by is not null
       or new.measured_at is not null or new.current_measurement_id is not null then
      raise exception 'measurements are recorded with record_spec_measurement' using errcode = '42501';
    end if;
  elsif new.measured is distinct from old.measured or new.measured_bool is distinct from old.measured_bool
     or new.measured_by is distinct from old.measured_by or new.measured_at is distinct from old.measured_at
     or new.current_measurement_id is distinct from old.current_measurement_id then
    raise exception 'measurements are recorded with record_spec_measurement' using errcode = '42501';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guard_spec_current_cache on specs;
create trigger trg_guard_spec_current_cache before insert or update on specs
  for each row execute function guard_spec_current_cache();

-- Target administration is separate from measuring.
drop policy if exists member_write on specs;
drop policy if exists spec_targets_insert on specs;
drop policy if exists spec_targets_update on specs;
drop policy if exists spec_targets_delete on specs;
create policy spec_targets_insert on specs for insert to authenticated with check (can_edit_spec_targets());
create policy spec_targets_update on specs for update to authenticated
  using (can_edit_spec_targets()) with check (can_edit_spec_targets());
create policy spec_targets_delete on specs for delete to authenticated using (can_edit_spec_targets());

-- Activity: a change to the rule or the targets (not the cache) is audited. The
-- old per-write measurement trigger is replaced by the commands' own events.
drop trigger if exists trg_log_spec_measurement on specs;
drop function if exists log_spec_measurement();

create or replace function log_spec_targets() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  skip text[] := array['measured', 'measured_bool', 'measured_at', 'measured_by', 'current_measurement_id'];
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

drop trigger if exists trg_log_spec_targets on specs;
create trigger trg_log_spec_targets after update on specs
  for each row execute function log_spec_targets();

-- --------------------------------------------------------- 7. the commands
-- Recomputes the cache from history. Internal: callers hold the spec's row lock.
create or replace function refresh_spec_current(p_spec_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare m spec_measurements;
begin
  select * into m from spec_measurements
   where spec_id = p_spec_id and invalidated_at is null
   order by measured_at desc nulls last, recorded_at desc, id desc
   limit 1;
  update specs set measured = m.value_numeric, measured_bool = m.value_bool,
                   measured_at = m.measured_at, measured_by = m.measured_by,
                   current_measurement_id = m.id
   where id = p_spec_id;
end $fn$;

create or replace function spec_measurement_json(m spec_measurements) returns jsonb
language sql immutable as $fn$
  select case when m.value_bool is null then to_jsonb(m.value_numeric) else to_jsonb(m.value_bool) end;
$fn$;

create or replace function record_spec_measurement(
  p_season_id uuid, p_spec_id uuid, p_request_id uuid,
  p_value_numeric numeric default null, p_value_bool boolean default null,
  p_measured_at timestamptz default null, p_note text default null, p_source text default null
) returns spec_measurements
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := auth.uid();
  sp specs;
  prev spec_measurements;
  prior spec_measurements;
  m spec_measurements;
  now_row specs;
begin
  if actor is null or not is_active_member() then
    raise exception 'only an active member can record a measurement' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'a request id is required' using errcode = '22004';
  end if;
  if p_value_numeric is null and p_value_bool is null then
    raise exception 'a value is required; an empty input does not clear or zero a measurement' using errcode = '22004';
  end if;
  if p_value_numeric is not null and p_value_bool is not null then
    raise exception 'give either a number or a yes/no value, not both' using errcode = '22023';
  end if;
  if p_value_numeric is not null and not is_finite_number(p_value_numeric) then
    raise exception 'the value must be a finite number' using errcode = '22003';
  end if;

  select * into sp from specs where id = p_spec_id for update;   -- serialises this spec
  if not found then
    raise exception 'specification not found' using errcode = 'P0002';
  end if;
  if sp.season_id is distinct from p_season_id then
    raise exception 'that specification belongs to another season' using errcode = '23514';
  end if;

  -- Retry of the same save: return the row it created, write nothing.
  select * into prior from spec_measurements where measured_by = actor and request_id = p_request_id;
  if found then
    if prior.spec_id <> p_spec_id or prior.value_numeric is distinct from p_value_numeric
       or prior.value_bool is distinct from p_value_bool then
      raise exception 'that request id was already used for a different measurement' using errcode = '23505';
    end if;
    return prior;
  end if;

  select * into prev from spec_measurements where id = sp.current_measurement_id;

  insert into spec_measurements (spec_id, season_id, value_numeric, value_bool, measured_at, measured_by,
                                 origin, note, source, request_id)
  values (p_spec_id, sp.season_id, p_value_numeric, p_value_bool, coalesce(p_measured_at, now()), actor,
          'entered', nullif(btrim(p_note), ''), nullif(btrim(p_source), ''), p_request_id)
  returning * into m;

  perform refresh_spec_current(p_spec_id);
  select * into now_row from specs where id = p_spec_id;

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (actor, sp.season_id, 'spec', sp.id::text, 'measurement_recorded',
    jsonb_build_object('parameter', sp.parameter, 'measurement_id', m.id,
      'value', spec_measurement_json(m), 'measured_at', m.measured_at,
      'becomes_current', now_row.current_measurement_id = m.id,
      'from', case when prev.id is null then null else spec_measurement_json(prev) end,
      'to', case when now_row.current_measurement_id is null then null
                 when now_row.measured_bool is not null then to_jsonb(now_row.measured_bool)
                 else to_jsonb(now_row.measured) end));
  return m;
end $fn$;

-- The corrected reading replaces an erroneous CONFIRMED one. The old row stays
-- (marked invalidated, with the reason); the new row is appended.
create or replace function correct_spec_measurement(
  p_measurement_id uuid, p_reason text, p_request_id uuid,
  p_value_numeric numeric default null, p_value_bool boolean default null,
  p_measured_at timestamptz default null
) returns spec_measurements
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := auth.uid();
  old_m spec_measurements;
  sp specs;
  prior spec_measurements;
  m spec_measurements;
  reason text := btrim(coalesce(p_reason, ''));
begin
  if actor is null or not is_active_member() then
    raise exception 'only an active member can correct a measurement' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'a request id is required' using errcode = '22004';
  end if;
  if reason = '' or char_length(reason) > 500 then
    raise exception 'a correction needs a reason of at most 500 characters' using errcode = '22023';
  end if;
  if p_value_numeric is null and p_value_bool is null then
    raise exception 'a corrected value is required; use invalidate_spec_measurement to withdraw one' using errcode = '22004';
  end if;
  if p_value_numeric is not null and p_value_bool is not null then
    raise exception 'give either a number or a yes/no value, not both' using errcode = '22023';
  end if;
  if p_value_numeric is not null and not is_finite_number(p_value_numeric) then
    raise exception 'the value must be a finite number' using errcode = '22003';
  end if;

  select spec_id into sp.id from spec_measurements where id = p_measurement_id;
  if sp.id is null then
    raise exception 'measurement not found' using errcode = 'P0002';
  end if;
  select * into sp from specs where id = sp.id for update;
  select * into old_m from spec_measurements where id = p_measurement_id;

  select * into prior from spec_measurements where measured_by = actor and request_id = p_request_id;
  if found then
    if prior.corrects_id is distinct from p_measurement_id then
      raise exception 'that request id was already used for a different measurement' using errcode = '23505';
    end if;
    return prior;
  end if;

  if not (old_m.measured_by = actor or can_edit_spec_targets()) then
    raise exception 'only the person who recorded a measurement, or a specification administrator, can correct it'
      using errcode = '42501';
  end if;
  if old_m.invalidated_at is not null then
    raise exception 'that measurement was already corrected or withdrawn' using errcode = '22023';
  end if;

  insert into spec_measurements (spec_id, season_id, value_numeric, value_bool, measured_at, measured_by,
                                 origin, corrects_id, note, source, request_id)
  values (old_m.spec_id, old_m.season_id, p_value_numeric, p_value_bool,
          coalesce(p_measured_at, old_m.measured_at, now()), actor,
          'correction', old_m.id, old_m.note, old_m.source, p_request_id)
  returning * into m;

  update spec_measurements set invalidated_at = now(), invalidated_by = actor, invalidation_reason = reason
   where id = old_m.id;

  perform refresh_spec_current(old_m.spec_id);

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (actor, sp.season_id, 'spec', sp.id::text, 'measurement_corrected',
    jsonb_build_object('parameter', sp.parameter, 'measurement_id', m.id, 'corrects', old_m.id,
      'from', spec_measurement_json(old_m), 'to', spec_measurement_json(m), 'reason', reason));
  return m;
end $fn$;

-- Withdraw an erroneous measurement without a replacement. The current value
-- falls back to the next accepted observation, or to "not measured" if none.
create or replace function invalidate_spec_measurement(p_measurement_id uuid, p_reason text)
returns spec_measurements
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := auth.uid();
  old_m spec_measurements;
  sp specs;
  reason text := btrim(coalesce(p_reason, ''));
begin
  if actor is null or not is_active_member() then
    raise exception 'only an active member can withdraw a measurement' using errcode = '42501';
  end if;
  if reason = '' or char_length(reason) > 500 then
    raise exception 'withdrawing a measurement needs a reason of at most 500 characters' using errcode = '22023';
  end if;
  select spec_id into sp.id from spec_measurements where id = p_measurement_id;
  if sp.id is null then
    raise exception 'measurement not found' using errcode = 'P0002';
  end if;
  select * into sp from specs where id = sp.id for update;
  select * into old_m from spec_measurements where id = p_measurement_id;

  if not (old_m.measured_by = actor or can_edit_spec_targets()) then
    raise exception 'only the person who recorded a measurement, or a specification administrator, can withdraw it'
      using errcode = '42501';
  end if;
  if old_m.invalidated_at is not null then
    if old_m.invalidated_by = actor and old_m.invalidation_reason = reason then
      return old_m;                       -- a retry of the same withdrawal
    end if;
    raise exception 'that measurement was already corrected or withdrawn' using errcode = '22023';
  end if;

  update spec_measurements set invalidated_at = now(), invalidated_by = actor, invalidation_reason = reason
   where id = old_m.id
  returning * into old_m;

  perform refresh_spec_current(old_m.spec_id);

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (actor, sp.season_id, 'spec', sp.id::text, 'measurement_invalidated',
    jsonb_build_object('parameter', sp.parameter, 'measurement_id', old_m.id,
      'value', spec_measurement_json(old_m), 'reason', reason));
  return old_m;
end $fn$;

revoke all on function refresh_spec_current(uuid) from public, anon, authenticated;
revoke all on function record_spec_measurement(uuid, uuid, uuid, numeric, boolean, timestamptz, text, text) from public, anon;
revoke all on function correct_spec_measurement(uuid, text, uuid, numeric, boolean, timestamptz) from public, anon;
revoke all on function invalidate_spec_measurement(uuid, text) from public, anon;
grant execute on function record_spec_measurement(uuid, uuid, uuid, numeric, boolean, timestamptz, text, text) to authenticated;
grant execute on function correct_spec_measurement(uuid, text, uuid, numeric, boolean, timestamptz) to authenticated;
grant execute on function invalidate_spec_measurement(uuid, text) to authenticated;

-- ------------------------------------------------- 8. legacy import (once)
-- At most one observation per spec that already holds a value. Actor and time
-- come from what was stored; nothing is attributed to the migration operator.
insert into spec_measurements (spec_id, season_id, value_numeric, measured_at, recorded_at, measured_by, origin, source)
select s.id, s.season_id, s.measured,
       coalesce(s.measured_at, a.at),
       coalesce(a.at, now()),
       coalesce(a.actor_id, s.measured_by),
       'legacy_import',
       'Imported by migration 20260122 from the value stored before measurement history existed'
from specs s
left join lateral (
  select ac.actor_id, ac.at from activity ac
  where ac.entity = 'spec' and ac.entity_id = s.id::text and ac.action = 'measurement_recorded'
    and jsonb_typeof(ac.detail -> 'to') = 'number' and (ac.detail ->> 'to')::numeric = s.measured
  order by ac.at desc limit 1
) a on true
where s.measured is not null
  and not exists (select 1 from spec_measurements x where x.spec_id = s.id);

do $$
declare r record;
begin
  for r in select id from specs where measured is not null or exists (select 1 from spec_measurements x where x.spec_id = specs.id) loop
    perform refresh_spec_current(r.id);
  end loop;
end $$;

-- ------------------------------------------------------ 9. realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'spec_measurements'
  ) then
    alter publication supabase_realtime add table public.spec_measurements;
  end if;
end $$;
