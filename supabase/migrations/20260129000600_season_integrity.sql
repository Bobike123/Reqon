-- =============================================================================
--  Backend completion Phase 4, step 7 of 7: seasons are separate, and a new season can
--  reuse the milestone labels. (PERMISSIONS.md §2.1; phase-01 findings F-11 and the
--  "cross-season" gaps; requirement "allow repeated milestone display labels without
--  primary-key collisions".)
--
--  WHAT WAS WRONG.
--   * `milestones.key` is the primary key AND the label people read ("MS1-1"). A second
--     season could not have its own MS1-1 without renaming it, so a new season had to be
--     built by hand with invented keys.
--   * Requirement status and specification links checked only that the clause EXISTS, not that
--     it belongs to the season's regulations edition (the same gap 20260127000300 closed for
--     task and proposal links).
--   * tasks.source_proposal could point at a proposal of another season.
--   * A season was created by a bare INSERT that left it with no milestones.
--
--  AFTER.
--   * milestones.code is the DISPLAY label (unique per season, default = key, every existing
--     milestone keeps its label). `key` stays the opaque, globally unique identifier every foreign
--     key already uses, so nothing that references a milestone changes. A new season's milestones get
--     keys like 'MS1-1~1a2b3c4d' (the label plus the first characters of the season id) and
--     the same code 'MS1-1'. The client shows `code` and links with `key`.
--     (The plan's uuid surrogate + foreign-key cutover was judged not worth its risk: `key` already
--     behaves as a surrogate once labels live in `code`. See phase-04.md decision D-9.)
--   * start_season(label, edition, regs_ref, category, copy_from) — President or Developer only
--     (can_manage_seasons), the same authority as switching. It creates the season NOT current and,
--     when copy_from is given, copies the milestone and section DEFINITIONS (names, order,
--     points, subsection structure, notes). It copies NO dates (window and deadline dates stay
--     TBC: none is invented), no submission or acceptance, no drafted tick, no owner, no task,
--     proposal, status, measurement or membership. The previous season is not touched.
--   * Requirement status and specification links must belong to the season's edition (triggers,
--     every writer); existing mismatches are counted and left unchanged.
--   * A task's source proposal must be in the task's season.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Repeatable milestone labels; a safe season rollover; remaining cross-season checks.
--    Existing data  milestones.code is filled from key for every row (same text, so nothing visible
--                   changes) before it is made NOT NULL and unique per season. The edition and source
--                   checks only govern new writes; mismatching rows, if any, are reported by NOTICE.
--    Authorization  start_season: can_manage_seasons() (President, Developer), SECURITY DEFINER, pinned
--                   search_path, EXECUTE for authenticated and service_role. Direct season INSERT keeps
--                   its policy (the same two roles). Trigger functions are not executable by API roles.
--    Locking        UPDATE of milestones (one small table), CREATE UNIQUE INDEX, CREATE TRIGGER; the
--                   command takes an advisory lock so two rollovers of one label serialise.
--    Rollback       Drop the command, triggers and the unique index; drop milestones.code.
--    Deploy order   After 20260129000500. The client shows `code` after this migration.
-- =============================================================================

-- ------------------------------------------------ 1. milestone display labels
alter table milestones add column if not exists code text;
update milestones set code = key where code is null;
alter table milestones alter column code set not null;
do $c$ begin
  alter table milestones add constraint milestones_code_not_blank check (length(clean_text(code)) between 1 and 40);
exception when duplicate_object then null; end $c$;
create unique index if not exists milestones_season_code_key on milestones (season_id, code);

create or replace function default_milestone_code() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if new.code is null or clean_text(new.code) = '' then
    new.code := new.key;
  end if;
  return new;
end $fn$;
revoke all on function default_milestone_code() from public, anon, authenticated;
drop trigger if exists trg_default_milestone_code on milestones;
create trigger trg_default_milestone_code before insert on milestones
  for each row execute function default_milestone_code();

comment on column milestones.code is
  'The label people read and type (MS1-1). Unique per season, so a new season can reuse it. `key` is the opaque unique identifier foreign keys use.';

-- --------------------------------------------------- 2. edition and source checks
create or replace function enforce_status_edition() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_clause_edition text;
  v_season_edition text;
begin
  if new.clause_key is null then
    return new;
  end if;
  select regs_ref into v_clause_edition from clauses where clause_key = new.clause_key;
  select regs_ref into v_season_edition from seasons where id = new.season_id;
  if v_clause_edition is distinct from v_season_edition then
    raise exception 'Requirement % belongs to the regulations edition "%", but this season follows "%".',
      new.clause_key, coalesce(v_clause_edition, '?'), coalesce(v_season_edition, '?') using errcode = '23514';
  end if;
  return new;
end $fn$;
revoke all on function enforce_status_edition() from public, anon, authenticated;

drop trigger if exists trg_clause_status_edition on clause_status;
create trigger trg_clause_status_edition before insert or update of clause_key, season_id on clause_status
  for each row execute function enforce_status_edition();
drop trigger if exists trg_spec_edition on specs;
create trigger trg_spec_edition before insert or update of clause_key, season_id on specs
  for each row execute function enforce_status_edition();

create or replace function enforce_task_source_season() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.source_proposal is not null and not exists (
    select 1 from task_proposals p where p.id = new.source_proposal and p.season_id = new.season_id
  ) then
    raise exception 'A task and the proposal it came from belong to the same season.' using errcode = '23514';
  end if;
  return new;
end $fn$;
revoke all on function enforce_task_source_season() from public, anon, authenticated;
drop trigger if exists trg_task_source_season on tasks;
create trigger trg_task_source_season before insert or update of source_proposal, season_id on tasks
  for each row execute function enforce_task_source_season();

do $report$
declare
  v_status int; v_specs int; v_tasks int;
begin
  select count(*) into v_status from clause_status cs join clauses c on c.clause_key = cs.clause_key
    join seasons s on s.id = cs.season_id where c.regs_ref is distinct from s.regs_ref;
  select count(*) into v_specs from specs sp join clauses c on c.clause_key = sp.clause_key
    join seasons s on s.id = sp.season_id where c.regs_ref is distinct from s.regs_ref;
  select count(*) into v_tasks from tasks t join task_proposals p on p.id = t.source_proposal
   where p.season_id <> t.season_id;
  raise notice 'cross-season mismatches left unchanged: % requirement status row(s), % specification link(s), % task source(s)',
    v_status, v_specs, v_tasks;
end
$report$;

-- ------------------------------------------------------- 3. starting a season
create or replace function start_season(
  p_label text, p_edition text, p_regs_ref text, p_category text, p_copy_from uuid default null
) returns seasons
language plpgsql security definer set search_path = public as $fn$
declare
  v_label text := clean_text(coalesce(p_label, ''));
  s seasons%rowtype;
  src seasons%rowtype;
  m milestones%rowtype;
  sec milestone_sections%rowtype;
  v_key text;
  v_map jsonb := '{}'::jsonb;
  v_new_id uuid;
  v_copied_m int := 0;
  v_copied_s int := 0;
begin
  if auth.uid() is null or not can_manage_seasons() then
    raise exception 'Only the President or a Developer can start a season.' using errcode = '42501';
  end if;
  if v_label = '' or char_length(v_label) > 60 then
    raise exception 'A season needs a label of 1 to 60 characters.' using errcode = '23514';
  end if;
  if p_category is not null and p_category not in ('eFuel', 'Electric') then
    raise exception 'The category is eFuel or Electric.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('start_season:' || lower(v_label), 0));
  if exists (select 1 from seasons where lower(label) = lower(v_label)) then
    raise exception 'A season called "%" already exists.', v_label using errcode = '23505';
  end if;
  if p_regs_ref is not null and not exists (select 1 from regulation_documents where regs_ref = p_regs_ref) then
    raise exception 'Unknown regulations edition "%".', p_regs_ref using errcode = '23503';
  end if;
  if p_copy_from is not null then
    select * into src from seasons where id = p_copy_from;
    if not found then
      raise exception 'The season to copy from does not exist.' using errcode = 'P0002';
    end if;
  end if;

  -- Deliberately NOT current: creating and switching are two steps, and a new season appearing
  -- never moves the club onto it.
  insert into seasons (label, edition, regs_ref, category, is_current)
  values (v_label,
          coalesce(nullif(clean_text(p_edition), ''), src.edition, 'MotoStudent IX'),
          coalesce(p_regs_ref, src.regs_ref, 'MS2627 Rev.01'),
          coalesce(p_category, src.category, 'eFuel'),
          false)
  returning * into s;

  if p_copy_from is not null then
    for m in select * from milestones where season_id = p_copy_from order by ordinal loop
      v_key := m.code || '~' || left(s.id::text, 8);
      -- Definitions only: no dates (TBC), no submission/acceptance.
      insert into milestones (key, code, season_id, ordinal, name, aim, article_ref, max_points, is_blocking, notes)
      values (v_key, m.code, s.id, m.ordinal, m.name, m.aim, m.article_ref, m.max_points, m.is_blocking, m.notes);
      v_copied_m := v_copied_m + 1;
      -- Top-level sections first, then subsections (their parents exist by then).
      for sec in select * from milestone_sections where milestone_key = m.key order by (parent_section_id is not null), ordinal loop
        insert into milestone_sections (milestone_key, ordinal, name, parent_section_id)
        values (v_key, sec.ordinal, sec.name,
                case when sec.parent_section_id is null then null else (v_map ->> sec.parent_section_id::text)::uuid end)
        returning id into v_new_id;
        v_map := v_map || jsonb_build_object(sec.id::text, v_new_id);
        v_copied_s := v_copied_s + 1;
      end loop;
    end loop;
  end if;

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), s.id, 'season', s.id::text, 'season_started',
          jsonb_build_object('label', s.label, 'copied_from', p_copy_from,
                             'milestones', v_copied_m, 'sections', v_copied_s));
  return s;
end $fn$;

revoke all on function start_season(text, text, text, text, uuid) from public, anon;
grant execute on function start_season(text, text, text, text, uuid) to authenticated, service_role;
