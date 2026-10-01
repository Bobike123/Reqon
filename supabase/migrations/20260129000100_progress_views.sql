-- =============================================================================
--  Backend completion Phase 4, step 2 of 7: ONE definition of progress.
--  (PERMISSIONS.md §6; phase-01 findings F-10 and the "resolved counts N/A" gap.)
--
--  WORK PROGRESS (tasks) — new view v_task_progress, one row per (season, scope, key):
--     scope  season | department | department_rollup | unassigned | milestone | section | requirement
--     total                distinct tasks in the scope, EXCLUDING cancelled, INCLUDING archived
--     done                 distinct tasks with state 'done' (archived or not)
--     archived_done        of those, archived (they keep their contribution)
--     archived_unfinished  archived and neither done nor cancelled: stays in `total`, is
--                          never `done`, and is reported on its own
--     cancelled            cancelled tasks (out of the denominator, kept for history)
--     open_active          not archived and not done/cancelled (the active workload)
--     percent              round(100 * done / total), NULL when total = 0 ("no linked work",
--                          never 0 %)
--   Every count is `count(DISTINCT task id)`, so a task linked twice (two requirements, a
--   section and its subsection, a department and its parent) is never counted twice, and
--   every parent figure is taken from its unique descendant TASKS, never by averaging child
--   percentages. department_rollup = a department plus its subdepartments; section =
--   a section plus its subsections; milestone = tasks on the milestone directly or through
--   any of its sections.
--
--  REQUIREMENT COMPLIANCE — kept separate from task completion:
--   * v_book_progress (chapter / subchapter) gains applicable, complied, verified and
--     content_state; v_subteam_progress becomes season-correct (it joined only the CURRENT
--     season), leaves archived departments out and applies the team-duty filter to `blocked`,
--     and gains applicable / complied / verified / not_applicable.
--   * N/A ("does not apply") is excluded from BOTH the numerator and the denominator and shown
--     as its own count: applicable = requirements - not_applicable; complied = compliant +
--     verified. `resolved` (which counted N/A as progress) stays for one release, unchanged.
--   * content_state says what a chapter's zero MEANS: imported | no_numbered_rules (the book has
--     none: a confirmed zero) | out_of_scope (another competition category) | not_imported
--     (rules exist in the book but are not loaded: missing data, NEVER a confirmed zero).
--   * Department ownership never enters the book figures: v_book_progress counts rules by
--     section/article only, so reassigning a department changes no book classification.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        One authoritative progress definition in SQL, mirrored by tasks/progress.ts.
--    Existing data  Nothing is written; views only. v_book_progress and v_subteam_progress are
--                   dropped and re-created with their old columns first, in the same order.
--    Authorization  security_invoker views: the caller's RLS applies (members read tasks,
--                   clauses and statuses). SELECT for authenticated; none for anon.
--    Locking        DROP/CREATE VIEW only.
--    Rollback       Re-create v_book_progress (20260125000600) and v_subteam_progress
--                   (20260101000000 + 20260102000000); drop v_task_progress.
--    Deploy order   After 20260129000000. Old clients keep working (old columns unchanged).
-- =============================================================================

-- ------------------------------------------------------------------ work
create or replace view v_task_progress with (security_invoker = on) as
with member as (
  select t.season_id, 'season'::text as scope, ''::text as scope_key, t.id, t.state, t.archived_at from tasks t
  union all
  select t.season_id, 'department', t.subteam_key, t.id, t.state, t.archived_at
    from tasks t where t.subteam_key is not null
  union all
  select t.season_id, 'department_rollup', k, t.id, t.state, t.archived_at
    from tasks t
    join subteams s on s.key = t.subteam_key
    cross join lateral unnest(array[s.key, s.parent_key]) k
   where k is not null
  union all
  select t.season_id, 'unassigned', '', t.id, t.state, t.archived_at
    from tasks t where t.subteam_key is null
  union all
  select t.season_id, 'milestone', coalesce(t.milestone_key, sec.milestone_key), t.id, t.state, t.archived_at
    from tasks t
    left join milestone_sections sec on sec.id = t.section_id
   where coalesce(t.milestone_key, sec.milestone_key) is not null
  union all
  select t.season_id, 'section', k::text, t.id, t.state, t.archived_at
    from tasks t
    join milestone_sections sec on sec.id = t.section_id
    cross join lateral unnest(array[sec.id, sec.parent_section_id]) k
   where k is not null
  union all
  select t.season_id, 'requirement', r.clause_key, t.id, t.state, t.archived_at
    from tasks t
    join task_requirements r on r.task_id = t.id
), counted as (
  select season_id, scope, scope_key,
         count(distinct id) filter (where state <> 'cancelled')                                  as total,
         count(distinct id) filter (where state = 'done')                                        as done,
         count(distinct id) filter (where state = 'done' and archived_at is not null)            as archived_done,
         count(distinct id) filter (where archived_at is not null and state not in ('done', 'cancelled')) as archived_unfinished,
         count(distinct id) filter (where state = 'cancelled')                                   as cancelled,
         count(distinct id) filter (where archived_at is null and state not in ('done', 'cancelled')) as open_active
    from member
   group by season_id, scope, scope_key
)
select season_id, scope, scope_key, total, done, archived_done, archived_unfinished, cancelled, open_active,
       case when total = 0 then null else round(100.0 * done / total)::int end as percent
  from counted;

comment on view v_task_progress is
  'Task progress per season and scope (season, department, department_rollup, unassigned, milestone, section, requirement). Distinct tasks; cancelled excluded from the denominator; archived done keeps its contribution; archived unfinished stays undone; percent NULL when there is no linked work. Mirrored by src/tasks/progress.ts.';

revoke all on v_task_progress from anon;
grant select on v_task_progress to authenticated;

-- --------------------------------------------- requirements: departments
drop view if exists v_subteam_progress;
create view v_subteam_progress with (security_invoker = on) as
select
  st.key, st.name, st.book_section, st.is_parked, st.lead_id,
  s.id as season_id,
  count(*) filter (where c.is_team_duty)                                              as duties,
  count(*) filter (where c.is_team_duty and cs.state in ('compliant', 'verified', 'na')) as resolved,
  count(*) filter (where c.is_team_duty and cs.state = 'wip')                         as in_progress,
  count(*) filter (where c.is_team_duty and cs.state = 'blocked')                     as blocked,
  count(c.clause_key)                                                                 as total_rules,
  count(*) filter (where c.is_team_duty and cs.state = 'na')                          as not_applicable,
  count(*) filter (where c.is_team_duty and coalesce(cs.state::text, 'open') <> 'na') as applicable,
  count(*) filter (where c.is_team_duty and cs.state in ('compliant', 'verified'))    as complied,
  count(*) filter (where c.is_team_duty and cs.state = 'verified')                    as verified
from seasons s
cross join subteams st
left join clauses c        on c.subteam_key = st.key and c.regs_ref = s.regs_ref
left join clause_status cs on cs.clause_key = c.clause_key and cs.season_id = s.id
where st.archived_at is null
group by st.key, st.name, st.book_section, st.is_parked, st.lead_id, s.id;

comment on view v_subteam_progress is
  'Requirement compliance per department (clause assignment) for EVERY season, active departments only. applicable = team duties minus N/A; complied = compliant + verified; blocked applies the team-duty filter. `resolved` (N/A counted as progress) is kept for one release.';

revoke all on v_subteam_progress from anon;
grant select on v_subteam_progress to authenticated;

-- ------------------------------------------------ requirements: the book
drop view if exists v_book_progress;
create view v_book_progress with (security_invoker = on) as
with base as (
  with counts as (
    select s.id as season_id, c.section, c.article, grouping(c.article) as chapter_total,
           count(*)                                                                               as imported_rules,
           count(*) filter (where c.is_team_duty)                                                 as requirements,
           count(*) filter (where c.is_team_duty and cs.state in ('compliant', 'verified', 'na')) as resolved,
           count(*) filter (where c.is_team_duty and cs.state = 'na')                             as not_applicable,
           count(*) filter (where c.is_team_duty and cs.state = 'wip')                            as in_progress,
           count(*) filter (where c.is_team_duty and cs.state = 'blocked')                        as blocked,
           count(*) filter (where c.is_team_duty and cs.state in ('compliant', 'verified'))       as complied,
           count(*) filter (where c.is_team_duty and cs.state = 'verified')                       as verified
    from seasons s
    join clauses c on c.regs_ref = s.regs_ref
    left join clause_status cs on cs.clause_key = c.clause_key and cs.season_id = s.id
    group by grouping sets ((s.id, c.section), (s.id, c.section, c.article))
  )
  select s.id as season_id, ch.regs_ref, 'chapter'::text as level,
         ch.code as chapter_code, null::text as kind, null::int as number,
         ch.label, ch.heading, ch.page, ch.sort_order as chapter_sort, 0 as sort_order, ch.has_numbered_rules,
         coalesce(k.imported_rules, 0) as imported_rules, coalesce(k.requirements, 0) as requirements,
         coalesce(k.resolved, 0) as resolved, coalesce(k.not_applicable, 0) as not_applicable,
         coalesce(k.in_progress, 0) as in_progress, coalesce(k.blocked, 0) as blocked,
         coalesce(k.complied, 0) as complied, coalesce(k.verified, 0) as verified
  from seasons s
  join book_chapters ch on ch.regs_ref = s.regs_ref
  left join counts k on k.season_id = s.id and k.section = ch.code and k.chapter_total = 1
  union all
  select s.id, sc.regs_ref, 'subchapter',
         sc.chapter_code, sc.kind, sc.number,
         sc.label, sc.heading, sc.page, ch.sort_order, sc.sort_order, sc.has_numbered_rules,
         coalesce(k.imported_rules, 0), coalesce(k.requirements, 0),
         coalesce(k.resolved, 0), coalesce(k.not_applicable, 0),
         coalesce(k.in_progress, 0), coalesce(k.blocked, 0),
         coalesce(k.complied, 0), coalesce(k.verified, 0)
  from seasons s
  join book_subchapters sc on sc.regs_ref = s.regs_ref
  join book_chapters ch on ch.regs_ref = sc.regs_ref and ch.code = sc.chapter_code
  left join counts k on k.season_id = s.id and sc.kind = 'article'
                    and k.section = sc.chapter_code and k.article = sc.number and k.chapter_total = 0
)
select base.season_id, base.regs_ref, base.level, base.chapter_code, base.kind, base.number,
       base.label, base.heading, base.page, base.chapter_sort, base.sort_order, base.has_numbered_rules,
       base.imported_rules, base.requirements, base.resolved, base.not_applicable, base.in_progress, base.blocked,
       coalesce(ch.category is not null and lower(ch.category) <> lower(s.category), false) as out_of_scope,
       base.requirements - base.not_applicable as applicable,
       base.complied,
       base.verified,
       case
         when coalesce(ch.category is not null and lower(ch.category) <> lower(s.category), false) then 'out_of_scope'
         when base.imported_rules > 0 then 'imported'
         when not base.has_numbered_rules then 'no_numbered_rules'
         else 'not_imported'
       end as content_state
from base
join seasons s on s.id = base.season_id
join book_chapters ch on ch.regs_ref = base.regs_ref and ch.code = base.chapter_code;

comment on view v_book_progress is
  'Requirement progress per book chapter and subchapter, per season, counted from the rules (section/article) only — never from departments or tasks. applicable = requirements - N/A; complied = compliant + verified (verified also shown alone). content_state: imported | no_numbered_rules (confirmed zero) | out_of_scope (another category) | not_imported (missing data, not a zero). `resolved` counts N/A and is kept for one release.';

revoke all on v_book_progress from anon;
grant select on v_book_progress to authenticated;
