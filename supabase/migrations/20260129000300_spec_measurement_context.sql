-- =============================================================================
--  Backend completion Phase 4, step 4 of 7: our measurements and the COMPETITION's
--  are different observations. (PERMISSIONS.md §8; requirement "separate current/team
--  and competition observations, with explicit ... permissions".)
--
--  WHAT WAS WRONG. Every observation of a specification went into one history and the
--  newest one became "current". A value read at the event (the organisers' scrutineering)
--  would have replaced the team's own latest measurement, or been indistinguishable from it.
--
--  AFTER.
--   * spec_measurements.context = 'team' | 'competition' (default 'team'; every existing row
--     is a team observation). Same append-only history, same retry identity, same audit.
--   * The current-value cache on `specs` (and the verdict, goal status, zone and readiness built
--     from it) reads TEAM observations only. Competition observations never become "current
--     (ours)"; v_spec_competition_current gives the latest accepted competition observation
--     per specification, ordered exactly like the team one (measured_at desc nulls last,
--     recorded_at desc, id desc).
--   * Recording, correcting or withdrawing a COMPETITION observation needs evidence authority
--     (can_manage_spec_evidence): President, Vice President, Developer, or the authority
--     (Head / parent Head / the fallback where none exists) of the department that owns the
--     specification's requirement. Team observations keep their rules (any active member
--     records; the recorder or a specification administrator corrects).
--   * The measurement carries the unit it was entered in when the caller sends one
--     (p_unit): a value typed for another unit than the specification's is refused.
--   * A correction keeps the context of the row it corrects and cannot change it.
--   * Whitespace-only notes and reasons no longer count as text (clean_text).
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Context separation for observations.
--    Existing data  Column added with default 'team': every existing observation stays a team observation.
--                   No row is rewritten or removed. The three commands are re-created (their
--                   signatures gain trailing defaulted parameters, so the previous overloads are
--                   dropped first to avoid ambiguity).
--    Authorization  Commands stay SECURITY DEFINER with pinned search_path; EXECUTE for
--                   authenticated and service_role only. spec_measurements keeps no write
--                   grant and its append-only guard.
--    Locking        ADD COLUMN with a constant default (no rewrite); each command locks one spec.
--    Rollback       Drop the column, the view and the helper; re-create the 20260122 definitions.
--    Deploy order   After 20260129000200. Old clients calling the commands without the new
--                   parameters keep working (team context).
-- =============================================================================

alter table spec_measurements
  add column if not exists context text not null default 'team';
do $c$ begin
  alter table spec_measurements add constraint spec_measurements_context_check check (context in ('team', 'competition'));
exception when duplicate_object then null; end $c$;

create index if not exists spec_measurements_context_idx
  on spec_measurements (spec_id, context, measured_at desc nulls last, recorded_at desc, id desc)
  where invalidated_at is null;

-- Who may record, correct or withdraw competition evidence, and confirm readiness.
create or replace function can_manage_spec_evidence(p_spec_id uuid) returns boolean
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_dept text;
begin
  if auth.uid() is null or not is_active_member() then
    return false;
  end if;
  if can_edit_spec_targets() then
    return true;
  end if;
  select c.subteam_key into v_dept
    from specs s join clauses c on c.clause_key = s.clause_key
   where s.id = p_spec_id;
  return v_dept is not null and coalesce(has_department_authority(v_dept), false);
end $fn$;
revoke all on function can_manage_spec_evidence(uuid) from public, anon;
grant execute on function can_manage_spec_evidence(uuid) to authenticated, service_role;

-- The current (ours) value is the newest accepted TEAM observation.
create or replace function refresh_spec_current(p_spec_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare m spec_measurements;
begin
  select * into m from spec_measurements
   where spec_id = p_spec_id and invalidated_at is null and context = 'team'
   order by measured_at desc nulls last, recorded_at desc, id desc
   limit 1;
  update specs set measured = m.value_numeric, measured_bool = m.value_bool,
                   measured_at = m.measured_at, measured_by = m.measured_by,
                   current_measurement_id = m.id
   where id = p_spec_id;
end $fn$;

drop function if exists record_spec_measurement(uuid, uuid, uuid, numeric, boolean, timestamptz, text, text);
create or replace function record_spec_measurement(
  p_season_id uuid, p_spec_id uuid, p_request_id uuid,
  p_value_numeric numeric default null, p_value_bool boolean default null,
  p_measured_at timestamptz default null, p_note text default null, p_source text default null,
  p_context text default 'team', p_unit text default null
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

  if p_context is null or p_context not in ('team', 'competition') then
    raise exception 'the context is team or competition' using errcode = '22023';
  end if;

  select * into sp from specs where id = p_spec_id for update;   -- serialises this spec
  if not found then
    raise exception 'specification not found' using errcode = 'P0002';
  end if;
  if sp.season_id is distinct from p_season_id then
    raise exception 'that specification belongs to another season' using errcode = '23514';
  end if;

  if p_context = 'competition' and not can_manage_spec_evidence(p_spec_id) then
    raise exception 'A competition result is recorded by the President, Vice President, a Developer or the authority of the requirement''s department.'
      using errcode = '42501';
  end if;
  -- The unit shown beside the input travels with the value, so a value typed for another unit is refused.
  if p_unit is not null and sp.unit is not null and lower(clean_text(p_unit)) <> lower(clean_text(sp.unit)) then
    raise exception 'This specification is measured in %, but the value was given in %.', sp.unit, p_unit using errcode = '22023';
  end if;

  -- Retry of the same save: return the row it created, write nothing.
  select * into prior from spec_measurements where measured_by = actor and request_id = p_request_id;
  if found then
    if prior.spec_id <> p_spec_id or prior.value_numeric is distinct from p_value_numeric
       or prior.value_bool is distinct from p_value_bool or prior.context <> p_context then
      raise exception 'that request id was already used for a different measurement' using errcode = '23505';
    end if;
    return prior;
  end if;

  select * into prev from spec_measurements where id = sp.current_measurement_id;

  insert into spec_measurements (spec_id, season_id, value_numeric, value_bool, measured_at, measured_by,
                                 origin, note, source, request_id, context)
  values (p_spec_id, sp.season_id, p_value_numeric, p_value_bool, coalesce(p_measured_at, now()), actor,
          'entered', nullif(clean_text(p_note), ''), nullif(clean_text(p_source), ''), p_request_id, p_context)
  returning * into m;

  perform refresh_spec_current(p_spec_id);
  select * into now_row from specs where id = p_spec_id;

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (actor, sp.season_id, 'spec', sp.id::text, 'measurement_recorded',
    jsonb_build_object('parameter', sp.parameter, 'measurement_id', m.id, 'context', m.context,
      'value', spec_measurement_json(m), 'measured_at', m.measured_at,
      'becomes_current', now_row.current_measurement_id = m.id,
      'from', case when prev.id is null then null else spec_measurement_json(prev) end,
      'to', case when now_row.current_measurement_id is null then null
                 when now_row.measured_bool is not null then to_jsonb(now_row.measured_bool)
                 else to_jsonb(now_row.measured) end));
  return m;
end $fn$;

drop function if exists correct_spec_measurement(uuid, text, uuid, numeric, boolean, timestamptz);
create or replace function correct_spec_measurement(
  p_measurement_id uuid, p_reason text, p_request_id uuid,
  p_value_numeric numeric default null, p_value_bool boolean default null,
  p_measured_at timestamptz default null, p_unit text default null
) returns spec_measurements
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := auth.uid();
  old_m spec_measurements;
  sp specs;
  prior spec_measurements;
  m spec_measurements;
  reason text := clean_text(coalesce(p_reason, ''));
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

  if old_m.context = 'competition' and not can_manage_spec_evidence(old_m.spec_id) then
    raise exception 'A competition result is corrected by the President, Vice President, a Developer or the authority of the requirement''s department.'
      using errcode = '42501';
  end if;
  if p_unit is not null and sp.unit is not null and lower(clean_text(p_unit)) <> lower(clean_text(sp.unit)) then
    raise exception 'This specification is measured in %, but the value was given in %.', sp.unit, p_unit using errcode = '22023';
  end if;
  if not (old_m.measured_by = actor or can_edit_spec_targets()
          or (old_m.context = 'competition' and can_manage_spec_evidence(old_m.spec_id))) then
    raise exception 'only the person who recorded a measurement, or a specification administrator, can correct it'
      using errcode = '42501';
  end if;
  if old_m.invalidated_at is not null then
    raise exception 'that measurement was already corrected or withdrawn' using errcode = '22023';
  end if;

  insert into spec_measurements (spec_id, season_id, value_numeric, value_bool, measured_at, measured_by,
                                 origin, corrects_id, note, source, request_id, context)
  values (old_m.spec_id, old_m.season_id, p_value_numeric, p_value_bool,
          coalesce(p_measured_at, old_m.measured_at, now()), actor,
          'correction', old_m.id, old_m.note, old_m.source, p_request_id, old_m.context)
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

create or replace function invalidate_spec_measurement(p_measurement_id uuid, p_reason text)
returns spec_measurements
language plpgsql security definer set search_path = public as $fn$
declare
  actor uuid := auth.uid();
  old_m spec_measurements;
  sp specs;
  reason text := clean_text(coalesce(p_reason, ''));
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

  if old_m.context = 'competition' and not can_manage_spec_evidence(old_m.spec_id) then
    raise exception 'A competition result is withdrawn by the President, Vice President, a Developer or the authority of the requirement''s department.'
      using errcode = '42501';
  end if;
  if not (old_m.measured_by = actor or can_edit_spec_targets()
          or (old_m.context = 'competition' and can_manage_spec_evidence(old_m.spec_id))) then
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

revoke all on function record_spec_measurement(uuid, uuid, uuid, numeric, boolean, timestamptz, text, text, text, text) from public, anon;
grant execute on function record_spec_measurement(uuid, uuid, uuid, numeric, boolean, timestamptz, text, text, text, text) to authenticated, service_role;
revoke all on function correct_spec_measurement(uuid, text, uuid, numeric, boolean, timestamptz, text) from public, anon;
grant execute on function correct_spec_measurement(uuid, text, uuid, numeric, boolean, timestamptz, text) to authenticated, service_role;

-- The latest accepted COMPETITION observation per specification (never the team's current value).
create or replace view v_spec_competition_current with (security_invoker = on) as
select distinct on (m.spec_id)
       m.spec_id, m.season_id, m.id as measurement_id, m.value_numeric, m.value_bool, m.measured_at, m.recorded_at, m.measured_by
  from spec_measurements m
 where m.context = 'competition' and m.invalidated_at is null
 order by m.spec_id, m.measured_at desc nulls last, m.recorded_at desc, m.id desc;

comment on view v_spec_competition_current is
  'The newest accepted competition observation of each specification. Team observations and the team current value are never mixed in.';
revoke all on v_spec_competition_current from anon;
grant select on v_spec_competition_current to authenticated;
