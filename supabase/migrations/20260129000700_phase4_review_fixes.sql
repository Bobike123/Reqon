-- =============================================================================
--  Backend completion Phase 4, findings of the final /code-review pass. Nothing in an earlier
--  file is edited; the three functions below are re-created with the same signatures.
--
--   * guard_section_hierarchy took its two advisory locks from one `perform … from (select … order by)`.
--     PostgreSQL does not promise that a function in the select list is evaluated in the subquery's sort order,
--     so two opposite moves between milestones A and B could each take one lock and wait for the other.
--     The two locks are now taken by two separate statements, smaller key first.
--   * guard_spec_direction refused ANY update of a specification that held a goal while its direction was
--     unreviewed, even one that touched none of direction / acceptable / goal / ideal (an edit of the unit or the
--     plausible range failed with a message about goals). It now fires on insert, and on an update only when one of
--     those four columns changes.
--   * lapse_spec_readiness stamped revoked_at with now() (transaction start) while confirmed_at is clock_timestamp():
--     a confirmation and its lapse in one transaction could read "revoked before confirmed". Both use clock_timestamp().
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Close one lock-order gap, one over-broad guard, one timestamp inversion.
--    Existing data  Untouched (functions only).
--    Authorization  Unchanged: same pinned search_path, same ownership, same (absent) grants.
--    Locking        CREATE OR REPLACE FUNCTION only.
--    Rollback       Re-apply the definitions from 20260128000500 / 20260129000500 / 20260129000400.
--    Deploy order   After 20260129000600.
-- =============================================================================

create or replace function guard_section_hierarchy() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_parent milestone_sections%rowtype;
  v_first text;
  v_second text;
begin
  -- One lock per milestone: two re-parentings cannot both pass a check that reads the other's uncommitted change.
  -- The milestone a row is leaving and the one it lands in, always smaller key first, in two statements (the order
  -- of evaluation inside a single SELECT is not guaranteed), so two opposite moves cannot deadlock.
  v_first := least(new.milestone_key, case when TG_OP = 'UPDATE' then old.milestone_key end);
  v_second := greatest(new.milestone_key, case when TG_OP = 'UPDATE' then old.milestone_key end);
  perform pg_advisory_xact_lock(hashtextextended('milestone_sections:' || v_first, 0));
  if v_second is distinct from v_first then
    perform pg_advisory_xact_lock(hashtextextended('milestone_sections:' || v_second, 0));
  end if;
  if new.parent_section_id is not null then
    if TG_OP = 'UPDATE' and new.parent_section_id = new.id then
      raise exception 'A section cannot be its own parent.' using errcode = '23514';
    end if;
    select * into v_parent from milestone_sections where id = new.parent_section_id;
    if not found then
      raise exception 'The parent section does not exist.' using errcode = '23503';
    end if;
    if v_parent.parent_section_id is not null then
      raise exception 'Subsections go one level deep: “%” is already a subsection.', v_parent.name
        using errcode = '23514';
    end if;
    if v_parent.milestone_key is distinct from new.milestone_key then
      raise exception 'A subsection belongs to the same milestone as its parent section.' using errcode = '23514';
    end if;
    if TG_OP = 'UPDATE' and exists (select 1 from milestone_sections c where c.parent_section_id = new.id) then
      raise exception '“%” has subsections of its own, so it cannot become a subsection.', new.name
        using errcode = '23514';
    end if;
  end if;
  if TG_OP = 'UPDATE' and new.milestone_key is distinct from old.milestone_key
     and exists (select 1 from milestone_sections c where c.parent_section_id = new.id) then
    raise exception '“%” has subsections, so it cannot move to another milestone.', new.name
      using errcode = '23514';
  end if;
  return new;
end $fn$;

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
    -- Targets need a reviewed direction. Only when this write sets the direction or one of the targets: an edit of
    -- the unit, the plausible range or a note must not be refused because of a goal somebody else already holds.
    if new.direction in ('higher_better', 'lower_better') and new.direction_reviewed_at is null
       and (new.acceptable is not null or new.goal is not null or new.ideal is not null)
       and (TG_OP = 'INSERT'
            or (new.direction, new.acceptable, new.goal, new.ideal)
               is distinct from (old.direction, old.acceptable, old.goal, old.ideal)) then
      raise exception 'Review which way is better for "%" before setting an acceptable, goal or ideal value: its direction was derived from the rule and has not been confirmed.',
        new.parameter using errcode = '23514';
    end if;
  end if;
  return new;
end $fn$;

create or replace function lapse_spec_readiness(p_spec_id uuid, p_reason text, p_by uuid default null) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  r spec_readiness%rowtype;
  sp specs%rowtype;
begin
  -- clock_timestamp(), like confirmed_at: a confirmation and its lapse inside one transaction keep their order.
  update spec_readiness set revoked_at = clock_timestamp(), revoked_by = p_by, revoke_reason = p_reason
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
