-- =============================================================================
--  Backend completion Phase 3, task side, step 4 of 4: subsections, so the Gantt
--  hierarchy is Milestone -> section -> subsection -> task. (Requirement
--  "Milestone -> section -> subsection -> task hierarchy, with persistent
--  authorised regrouping".)
--
--  A subsection is a milestone_sections row with parent_section_id set. Tasks
--  keep pointing at the ONE section_id that already exists (a section or a
--  subsection); regrouping a task is the ordinary task edit of section_id, so it
--  has the same authority (can_edit_task), the same audit (section_changed) and
--  no second copy of any task. Nothing about a task is duplicated for the Gantt.
--
--  Rules (guard_section_hierarchy, every writer):
--   * one level only: a subsection's parent is a top-level section;
--   * the parent is in the SAME milestone (a milestone_key change of either side is
--     checked too);
--   * a section that has subsections cannot itself become a subsection;
--   * no self-parent; deleting a parent that still has subsections is refused
--     (ON DELETE RESTRICT).
--  Who may create, rename, re-parent or delete sections and subsections is
--  unchanged from 20260126000500: President, Vice President, Documentation,
--  Developer (can_manage_milestone_structure); anyone active may still tick
--  "drafted". Heads and owners regroup TASKS, not the structure.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Subsections; persistent regrouping through the canonical task row.
--    Existing data  Every existing section stays top-level (parent NULL).
--    Authorization  Existing section policies + guard_section_edit; the new column
--                   is not the drafted flag, so changing it needs structure authority.
--    Locking        ADD COLUMN nullable + FK: brief.
--    Rollback       DROP COLUMN parent_section_id (cascade drops the trigger).
--    Deploy order   After 20260128000200. The client renders subsections after this.
-- =============================================================================

alter table milestone_sections
  add column if not exists parent_section_id uuid null references milestone_sections(id) on delete restrict;
create index if not exists milestone_sections_parent on milestone_sections (parent_section_id);
comment on column milestone_sections.parent_section_id is
  'Set on a subsection: its parent section, in the same milestone. NULL for a top-level section. One level only.';

create or replace function guard_section_hierarchy() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_parent milestone_sections%rowtype;
begin
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
revoke all on function guard_section_hierarchy() from public, anon, authenticated;

drop trigger if exists trg_guard_section_hierarchy on milestone_sections;
create trigger trg_guard_section_hierarchy before insert or update of parent_section_id, milestone_key on milestone_sections
  for each row execute function guard_section_hierarchy();
