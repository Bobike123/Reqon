-- =============================================================================
--  Book chapters that belong to one competition category.
--
--  MS2627 Rev.01 has a category-specific technical section for each category:
--  Section C (MotoStudent eFuel) and Section D (MotoStudent Electric). This
--  season the team races eFuel, so Section D does not apply to it: its rules
--  are deliberately not imported, and no task or requirement is created for
--  them. Until now the Now screen could only call that "not imported", i.e.
--  missing data. It is not missing — it is out of scope.
--
--  book_chapters.category records the category a chapter is specific to
--  (NULL = the whole competition). v_book_progress gains out_of_scope, true
--  when the chapter's category differs from the season's, so the screen can
--  show such a chapter with its page number and say why it has no rules,
--  instead of raising a missing-data flag. Sections I and J are unchanged:
--  the book has no numbered rules there (a confirmed zero).
--
--  Additive only: one nullable column, one appended view column, no rule,
--  status or department is changed.
-- =============================================================================

alter table book_chapters
  add column if not exists category text check (category is null or category in ('eFuel', 'Electric'));

comment on column book_chapters.category is
  'The competition category this chapter is specific to (eFuel, Electric); NULL = applies to every category. A chapter for another category than the season''s is out of scope, not missing data.';

update book_chapters set category = 'eFuel'    where regs_ref = 'MS2627 Rev.01' and code = 'C' and category is distinct from 'eFuel';
update book_chapters set category = 'Electric' where regs_ref = 'MS2627 Rev.01' and code = 'D' and category is distinct from 'Electric';

create or replace view v_book_progress with (security_invoker = on) as
with base as (
  with counts as (
    select s.id as season_id, c.section, c.article, grouping(c.article) as chapter_total,
           count(*)                                                                               as imported_rules,
           count(*) filter (where c.is_team_duty)                                                 as requirements,
           count(*) filter (where c.is_team_duty and cs.state in ('compliant', 'verified', 'na')) as resolved,
           count(*) filter (where c.is_team_duty and cs.state = 'na')                             as not_applicable,
           count(*) filter (where c.is_team_duty and cs.state = 'wip')                            as in_progress,
           count(*) filter (where c.is_team_duty and cs.state = 'blocked')                        as blocked
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
         coalesce(k.in_progress, 0) as in_progress, coalesce(k.blocked, 0) as blocked
  from seasons s
  join book_chapters ch on ch.regs_ref = s.regs_ref
  left join counts k on k.season_id = s.id and k.section = ch.code and k.chapter_total = 1
  union all
  select s.id, sc.regs_ref, 'subchapter',
         sc.chapter_code, sc.kind, sc.number,
         sc.label, sc.heading, sc.page, ch.sort_order, sc.sort_order, sc.has_numbered_rules,
         coalesce(k.imported_rules, 0), coalesce(k.requirements, 0),
         coalesce(k.resolved, 0), coalesce(k.not_applicable, 0),
         coalesce(k.in_progress, 0), coalesce(k.blocked, 0)
  from seasons s
  join book_subchapters sc on sc.regs_ref = s.regs_ref
  join book_chapters ch on ch.regs_ref = sc.regs_ref and ch.code = sc.chapter_code
  left join counts k on k.season_id = s.id and sc.kind = 'article'
                    and k.section = sc.chapter_code and k.article = sc.number and k.chapter_total = 0
)
select base.*,
       coalesce(ch.category is not null and lower(ch.category) <> lower(s.category), false) as out_of_scope
from base
join seasons s on s.id = base.season_id
join book_chapters ch on ch.regs_ref = base.regs_ref and ch.code = base.chapter_code;

comment on view v_book_progress is
  'Requirement progress per book chapter and subchapter, per season. Counted from the rules (section/article), never from departments or tasks. out_of_scope = the chapter is specific to a category other than the season''s (e.g. Section D for an eFuel season): not imported on purpose, not missing data.';

revoke all on v_book_progress from anon;
grant select on v_book_progress to authenticated;
