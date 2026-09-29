-- =============================================================================
--  Requirements Book (20260120000000_requirements_book.sql): document
--  configuration, source pages, edition isolation and the no-erase guards,
--  checked as REAL authenticated/anon sessions. SAFE TO RUN AGAINST THE REAL
--  PROJECT: everything happens in one block that ends by raising an exception,
--  so every row rolls back.
--      REQUIREMENTS BOOK CHECKS PASSED   or   REQUIREMENTS BOOK CHECKS FAILED
-- =============================================================================

create or replace function pg_temp.act(who uuid, stmt text) returns text
language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt;
    r := 'ok';
  exception when others then
    r := sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $fn$;

-- As `who` (null = anon), run a query returning one value; 'E:<sqlstate>' on error.
create or replace function pg_temp.val(who uuid, stmt text) returns text
language plpgsql as $fn$
declare r text;
begin
  if who is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', who::text, true);
  end if;
  begin
    execute stmt into r;
  exception when others then
    r := 'E:' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $fn$;

create temp table results (n serial, label text, ok boolean, detail text);
create or replace function pg_temp.chk(label text, ok boolean, detail text default null) returns void
language plpgsql as $fn$
begin
  insert into results (label, ok, detail) values (label, coalesce(ok, false), detail);
end $fn$;

do $test$
declare
  pre uuid := gen_random_uuid();   -- President
  vp  uuid := gen_random_uuid();   -- Vice President
  mem uuid := gen_random_uuid();   -- ordinary member
  alum uuid := gen_random_uuid();  -- alumnus
  s uuid; clause text; stat_clause text;
  q text;
  nfail int; ntotal int;
begin
  insert into auth.users (id, email) select x.i, x.e from (values
    (pre,'rb-pre@t.test'),(vp,'rb-vp@t.test'),(mem,'rb-mem@t.test'),(alum,'rb-alum@t.test')) as x(i, e);
  insert into members (id, full_name, role, status) values
    (pre,'RB Pre','Lead','active'),(vp,'RB VP','Lead','active'),(mem,'RB Mem','Ch','active'),(alum,'RB Alum','Ch','alumni');
  insert into member_roles (member_id, role) values (pre,'president'),(vp,'vicepresident');
  insert into seasons (label, is_current) values ('RB-S', false) returning id into s;

  select clause_key into clause from clauses where regs_ref = 'MS2627 Rev.01' order by clause_key limit 1;
  select clause_key into stat_clause from clauses where regs_ref = 'MS2627 Rev.01' order by clause_key offset 1 limit 1;

  -- ------------------------------------------------- what the migration left behind
  perform pg_temp.chk('B1 the existing edition has a document row and no source configured',
    (select count(*) from regulation_documents where regs_ref = 'MS2627 Rev.01' and url is null and storage_path is null) = 1);
  perform pg_temp.chk('B2 every existing clause is tied to an edition',
    (select count(*) from clauses where regs_ref is null) = 0);
  -- Pages come only from the verified page map (20260125000200): every one
  -- lies inside its own edition's document, none is left out or guessed.
  perform pg_temp.chk('B3 every recorded page lies inside its edition (verified map, nothing invented)',
    not exists (select 1 from clauses c join regulation_documents d using (regs_ref)
                where c.source_page is null or d.page_count is null
                   or c.source_page not between 1 and d.page_count));

  -- ----------------------------------------------------------- who reads and writes
  q := pg_temp.val(mem, 'select count(*)::text from regulation_documents');
  perform pg_temp.chk('B4 an active member reads the document list', q not like 'E:%' and q::int >= 1, q);
  q := pg_temp.val(alum, 'select count(*)::text from regulation_documents');
  perform pg_temp.chk('B5 an alumnus can still read (reads follow the roster, as everywhere else)', q not like 'E:%' and q::int >= 1, q);
  q := pg_temp.act(alum, $$update regulation_documents set title = 'x' where regs_ref = 'MS2627 Rev.01'$$);
  perform pg_temp.chk('B5b but an alumnus cannot configure it (row unchanged)',
    (select title from regulation_documents where regs_ref = 'MS2627 Rev.01') is distinct from 'x', q);
  q := pg_temp.val(null, 'select count(*)::text from regulation_documents');
  perform pg_temp.chk('B6 a signed-out visitor cannot read the list', q like 'E:%' or q = '0', q);
  q := pg_temp.act(mem, $$update regulation_documents set url = 'https://example.org/x.pdf' where regs_ref = 'MS2627 Rev.01'$$);
  perform pg_temp.chk('B7 a member cannot configure the source (no row changes)',
    (select url from regulation_documents where regs_ref = 'MS2627 Rev.01') is null, q);
  q := pg_temp.act(mem, $$insert into regulation_documents (regs_ref) values ('RB-MEM')$$);
  perform pg_temp.chk('B8 a member cannot add an edition', q <> 'ok', q);

  -- ------------------------------------------------------ configuring the source
  q := pg_temp.act(vp, $$update regulation_documents set url = 'https://example.org/regs.pdf', page_count = 120 where regs_ref = 'MS2627 Rev.01'$$);
  perform pg_temp.chk('B9 an administrator configures an https URL',
    q = 'ok' and (select url from regulation_documents where regs_ref = 'MS2627 Rev.01') = 'https://example.org/regs.pdf', q);
  perform pg_temp.chk('B10 the editor is stamped from the session',
    (select updated_by from regulation_documents where regs_ref = 'MS2627 Rev.01') = vp);
  q := pg_temp.act(pre, format($$update regulation_documents set updated_by = %L where regs_ref = 'MS2627 Rev.01'$$, mem));
  perform pg_temp.chk('B11 a forged updated_by is overwritten by the session',
    (select updated_by from regulation_documents where regs_ref = 'MS2627 Rev.01') = pre, q);

  perform pg_temp.chk('B12 http:// is refused',
    pg_temp.act(vp, $$update regulation_documents set url = 'http://example.org/x.pdf' where regs_ref = 'MS2627 Rev.01'$$) = '23514');
  perform pg_temp.chk('B13 javascript: is refused',
    pg_temp.act(vp, $$update regulation_documents set url = 'javascript:alert(1)' where regs_ref = 'MS2627 Rev.01'$$) = '23514');
  perform pg_temp.chk('B14 file: is refused',
    pg_temp.act(vp, $$update regulation_documents set url = 'file:///home/u/regs.pdf' where regs_ref = 'MS2627 Rev.01'$$) = '23514');
  perform pg_temp.chk('B15 a URL with whitespace is refused',
    pg_temp.act(vp, $$update regulation_documents set url = 'https://example.org/a b.pdf' where regs_ref = 'MS2627 Rev.01'$$) = '23514');
  perform pg_temp.chk('B16 url and storage_path together are refused',
    pg_temp.act(vp, $$update regulation_documents set storage_path = 'ms2627/regs.pdf' where regs_ref = 'MS2627 Rev.01'$$) = '23514');
  perform pg_temp.chk('B17 a storage object path is accepted once the URL is cleared',
    pg_temp.act(vp, $$update regulation_documents set url = null, storage_path = 'ms2627/regs.pdf' where regs_ref = 'MS2627 Rev.01'$$) = 'ok');
  perform pg_temp.chk('B18 an absolute local path is refused',
    pg_temp.act(vp, $$update regulation_documents set storage_path = '/home/bob/regs.pdf' where regs_ref = 'MS2627 Rev.01'$$) = '23514');
  perform pg_temp.chk('B19 a parent-directory path is refused',
    pg_temp.act(vp, $$update regulation_documents set storage_path = 'a/../../b.pdf' where regs_ref = 'MS2627 Rev.01'$$) = '23514');
  perform pg_temp.chk('B20 a scheme-prefixed path is refused',
    pg_temp.act(vp, $$update regulation_documents set storage_path = 'C:/regs.pdf' where regs_ref = 'MS2627 Rev.01'$$) = '23514');
  perform pg_temp.chk('B21 a zero or negative page_count is refused',
    pg_temp.act(vp, $$update regulation_documents set page_count = 0 where regs_ref = 'MS2627 Rev.01'$$) = '23514');

  -- --------------------------------------------------------------- clause pages
  q := pg_temp.act(vp, format('update clauses set source_page = 12 where clause_key = %L', clause));
  perform pg_temp.chk('B22 an administrator records a source page',
    q = 'ok' and (select source_page from clauses where clause_key = clause) = 12, q);
  perform pg_temp.chk('B23 page 0 is refused',
    pg_temp.act(vp, format('update clauses set source_page = 0 where clause_key = %L', clause)) = '23514');
  perform pg_temp.chk('B24 a negative page is refused',
    pg_temp.act(vp, format('update clauses set source_page = -3 where clause_key = %L', clause)) = '23514');
  q := pg_temp.act(mem, format('update clauses set source_page = 99 where clause_key = %L', stat_clause));
  perform pg_temp.chk('B25 a member cannot record a page (row unchanged)',
    (select source_page from clauses where clause_key = stat_clause) is distinct from 99, q);

  -- ------------------------------------------------------- edition isolation
  insert into regulation_documents (regs_ref, edition) values ('RB-ED2', 'Edition two');
  q := pg_temp.act(vp, format($$update clauses set regs_ref = 'RB-ED2' where clause_key = %L$$, clause));
  perform pg_temp.chk('B26 a clause cannot be re-pointed at another edition', q = '23514', q);
  perform pg_temp.chk('B27 the page stays with its own edition',
    (select regs_ref || ':' || source_page from clauses where clause_key = clause) = 'MS2627 Rev.01:12');
  insert into clauses (clause_key, printed_ref, section, article, body, obligation, criticality, regs_ref, source_page)
  values ('RB-ED2-1', 'A.1', 'A', 1, 'edition two clause', 'required', 'normal', 'RB-ED2', 7);
  perform pg_temp.chk('B28 a second edition adds its own clause and page without touching the first',
    (select count(*) from clauses where regs_ref = 'MS2627 Rev.01' and source_page is not null)
      = (select count(*) from clauses where regs_ref = 'MS2627 Rev.01')
    and (select source_page from clauses where clause_key = clause) = 12
    and (select source_page from clauses where clause_key = 'RB-ED2-1') = 7);
  perform pg_temp.chk('B29 a page cannot exist without an edition',
    pg_temp.act(vp, $$insert into clauses (clause_key, printed_ref, section, article, body, obligation, criticality, source_page)
      values ('RB-NOED', 'A.2', 'A', 1, 'x', 'required', 'normal', 4)$$) = '23514');

  -- ------------------------------------------------------------ no silent erasure
  insert into clause_status (season_id, clause_key, state) values (s, stat_clause, 'wip');
  q := pg_temp.act(vp, format('delete from clauses where clause_key = %L', stat_clause));
  perform pg_temp.chk('B30 deleting a clause that has team status is refused (RESTRICT, not CASCADE)', q = '23503', q);
  perform pg_temp.chk('B31 the status row survived',
    (select count(*) from clause_status where season_id = s and clause_key = stat_clause) = 1);
  perform pg_temp.chk('B32 an edition that clauses reference cannot be deleted',
    pg_temp.act(pre, $$delete from regulation_documents where regs_ref = 'RB-ED2'$$) = '23503');

  -- ------------------------------------------------------------------- realtime
  perform pg_temp.chk('B33 task_requirements is in the realtime publication (when one exists)',
    not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    or exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'task_requirements'));

  select count(*) filter (where not ok), count(*) into nfail, ntotal from results;
  if nfail > 0 then
    raise exception E'REQUIREMENTS BOOK CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      nfail, ntotal,
      (select string_agg(label || coalesce(': ' || detail, ''), E'\n' order by n) from results where not ok),
      (select string_agg(case when ok then 'ok  ' else 'FAIL' end || '  ' || label, E'\n' order by n) from results);
  end if;
  raise exception E'REQUIREMENTS BOOK CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    ntotal, (select string_agg('ok    ' || label, E'\n' order by n) from results);
end
$test$;
