-- =============================================================================
--  Requirements Book outline and chapter progress (20260125000500, 20260125000600).
--  Everything happens in one block that ends by raising an exception, so every
--  row rolls back.
--      BOOK OUTLINE CHECKS PASSED   or   BOOK OUTLINE CHECKS FAILED
-- =============================================================================

create or replace function pg_temp.as_role(r text, stmt text) returns text
language plpgsql as $fn$
declare v text;
begin
  perform set_config('role', r, true);
  begin
    execute stmt into v;
  exception when others then
    v := 'E:' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  return v;
end $fn$;

create temp table results (n serial, label text, ok boolean, detail text);
create or replace function pg_temp.chk(label text, ok boolean, detail text default null) returns void
language plpgsql as $fn$
begin
  insert into results (label, ok, detail) values (label, coalesce(ok, false), detail);
end $fn$;

do $test$
declare
  s uuid;
  before_a int; before_b int; after_a int; after_b int;
  q text; res jsonb;
  nfail int; ntotal int;
begin
  select id into s from seasons where label = '2026/27';

  -- ================================================================ outline
  perform pg_temp.chk('the outline has the book''s 10 sections, A to J, in order',
    (select string_agg(code, '' order by sort_order) from book_chapters where regs_ref = 'MS2627 Rev.01') = 'ABCDEFGHIJ');
  perform pg_temp.chk('76 articles and 8 annexes, as the table of contents lists them',
    (select count(*) from book_subchapters where regs_ref = 'MS2627 Rev.01' and kind = 'article') = 76
    and (select count(*) from book_subchapters where regs_ref = 'MS2627 Rev.01' and kind = 'annex') = 8);
  perform pg_temp.chk('headings are the book''s own, verbatim',
    (select label || ': ' || heading from book_subchapters where regs_ref = 'MS2627 Rev.01'
       and chapter_code = 'F' and kind = 'article' and number = 3) = 'ARTICLE 3: MS1 1st MILESTONE, TEAM PLAN');
  perform pg_temp.chk('every imported rule sits under an article of the outline',
    not exists (select 1 from clauses c where c.regs_ref = 'MS2627 Rev.01' and not exists (
      select 1 from book_subchapters b where b.regs_ref = c.regs_ref and b.chapter_code = c.section
        and b.kind = 'article' and b.number = c.article)));

  -- =============================================================== progress
  perform pg_temp.chk('chapter totals equal the unique team requirements (nothing counted twice)',
    (select sum(requirements) from v_book_progress where season_id = s and level = 'chapter')
      = (select count(*) from clauses where regs_ref = 'MS2627 Rev.01' and is_team_duty)
    and (select sum(requirements) from v_book_progress where season_id = s and level = 'subchapter')
      = (select count(*) from clauses where regs_ref = 'MS2627 Rev.01' and is_team_duty));
  perform pg_temp.chk('every chapter is listed, rules or not',
    (select count(*) from v_book_progress where season_id = s and level = 'chapter') = 10);
  perform pg_temp.chk('Section D: the book numbers rules there, none is imported, and it is out of scope for an eFuel season (not missing data)',
    (select has_numbered_rules and imported_rules = 0 and out_of_scope and page = 82 from v_book_progress where season_id = s and level = 'chapter' and chapter_code = 'D')
    and (select bool_and(out_of_scope and imported_rules = 0) from v_book_progress where season_id = s and level = 'subchapter' and chapter_code = 'D'));
  perform pg_temp.chk('Section C (eFuel) and every other chapter stay in scope',
    (select bool_and(not out_of_scope) from v_book_progress where season_id = s and chapter_code <> 'D'));
  perform pg_temp.chk('Sections I and J: the book has no numbered rules (a confirmed zero)',
    (select bool_and(not has_numbered_rules and imported_rules = 0) from v_book_progress
      where season_id = s and level = 'chapter' and chapter_code in ('I', 'J')));

  -- A department change never moves a rule between chapters.
  select requirements into before_a from v_book_progress where season_id = s and level = 'chapter' and chapter_code = 'A';
  select requirements into before_b from v_book_progress where season_id = s and level = 'chapter' and chapter_code = 'B';
  update clauses set subteam_key = case when subteam_key = 'OPS' then 'MECH' else 'OPS' end
  where section = 'A' and is_team_duty;
  update clauses set subteam_key = null where section = 'B';
  select requirements into after_a from v_book_progress where season_id = s and level = 'chapter' and chapter_code = 'A';
  select requirements into after_b from v_book_progress where season_id = s and level = 'chapter' and chapter_code = 'B';
  perform pg_temp.chk('reassigning or unassigning departments leaves chapter counts unchanged',
    before_a = after_a and before_b = after_b, format('A %s->%s, B %s->%s', before_a, after_a, before_b, after_b));

  -- Status rules: compliant, verified and n/a resolve; n/a is also reported alone.
  insert into clause_status (season_id, clause_key, state)
  select s, clause_key, 'na' from clauses where section = 'A' and article = 1 and is_team_duty order by clause_key limit 1
  on conflict (season_id, clause_key) do update set state = 'na';
  perform pg_temp.chk('a not-applicable rule counts as resolved and is reported on its own, in its article and chapter',
    (select resolved >= 1 and not_applicable >= 1 from v_book_progress where season_id = s and level = 'subchapter'
       and chapter_code = 'A' and kind = 'article' and number = 1)
    and (select not_applicable >= 1 from v_book_progress where season_id = s and level = 'chapter' and chapter_code = 'A'));

  -- ============================================================ re-run / conflict
  res := maintenance.apply_book_outline('MS2627 Rev.01',
    (select jsonb_agg(jsonb_build_array(code, label, heading, page, sort_order, has_numbered_rules)) from book_chapters where regs_ref = 'MS2627 Rev.01'),
    (select jsonb_agg(jsonb_build_array(chapter_code, kind, number, label, heading, page, sort_order, has_numbered_rules)) from book_subchapters where regs_ref = 'MS2627 Rev.01'));
  perform pg_temp.chk('re-applying the outline adds nothing',
    (res->>'chapters_added')::int = 0 and (res->>'subchapters_added')::int = 0, res::text);
  begin
    perform maintenance.apply_book_outline('MS2627 Rev.01', '[["A","SECTION A","INVENTED HEADING",6,1,true]]'::jsonb, '[]'::jsonb);
    q := 'ALLOWED';
  exception when others then
    q := sqlstate;
  end;
  perform pg_temp.chk('a heading that differs from the recorded one is refused, not overwritten',
    q = '23514' and (select heading from book_chapters where regs_ref = 'MS2627 Rev.01' and code = 'A') = 'ADMINISTRATIVE REGULATIONS', q);

  -- ================================================================= access
  q := pg_temp.as_role('anon', 'select count(*)::text from book_chapters');
  perform pg_temp.chk('a signed-out visitor cannot read the outline', q like 'E:%', q);
  q := pg_temp.as_role('anon', 'select count(*)::text from v_book_progress');
  perform pg_temp.chk('a signed-out visitor cannot read the progress', q like 'E:%', q);
  q := pg_temp.as_role('authenticated', 'select count(*)::text from maintenance.apply_book_outline(''x'', ''[]'', ''[]'')');
  perform pg_temp.chk('a signed-in session cannot write the outline', q = 'E:42501', q);

  select count(*) filter (where not ok), count(*) into nfail, ntotal from results;
  if nfail > 0 then
    raise exception E'BOOK OUTLINE CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      nfail, ntotal,
      (select string_agg(label || coalesce(': ' || detail, ''), E'\n' order by n) from results where not ok),
      (select string_agg(case when ok then 'ok  ' else 'FAIL' end || '  ' || label, E'\n' order by n) from results);
  end if;
  raise exception E'BOOK OUTLINE CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    ntotal, (select string_agg('ok    ' || label, E'\n' order by n) from results);
end
$test$;
