-- =============================================================================
--  Title validation checks (20260112000000_title_validation.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates happens inside
--  one block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations. The
--  result arrives as an "error" message that begins with
--      TITLE VALIDATION CHECKS PASSED   or   TITLE VALIDATION CHECKS FAILED
--  That "error" is the rollback doing its job.
--
--  Deliberately goes straight at the tables, bypassing the RPCs and the UI's
--  own trimming — the point of a database CHECK constraint is that it holds
--  even when nothing upstream does.
-- =============================================================================

create or replace function pg_temp.note(
  inout lines text[], inout failures text[], label text, ok boolean, detail text default null
) returns record language plpgsql as $fn$
begin
  lines := lines || format('%s  %s%s', case when ok then 'ok  ' else 'FAIL' end, label,
    case when detail is null then '' else ' — ' || detail end);
  if not ok then
    failures := failures || format('%s%s', label, case when detail is null then '' else ': ' || detail end);
  end if;
end $fn$;

-- Attempts one INSERT and reports whether Postgres accepted or rejected it on
-- a CHECK violation specifically — any other error is a broken test, not a
-- pass or fail of the constraint.
create or replace function pg_temp.try_insert(stmt text) returns text
language plpgsql as $fn$
begin
  execute stmt;
  return 'ACCEPTED';
exception
  when check_violation then return 'REJECTED';
  when others then return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end $fn$;

do $test$
declare
  season uuid;
  mem    uuid := gen_random_uuid();
  lines    text[] := '{}';
  failures text[] := '{}';
  got text;
begin
  insert into auth.users (id, email) values (mem, 'title-mem@roles.test');
  insert into members (id, full_name, role) values (mem, 'Title Member', 'Chassis');
  insert into seasons (label, is_current) values ('TITLE-TEST', false) returning id into season;

  -- ================================================================ tasks
  got := pg_temp.try_insert(format(
    'insert into tasks (season_id, title) values (%L, %L)', season, '   '));
  select * into lines, failures from pg_temp.note(lines, failures, 'blank task title is rejected', got = 'REJECTED', got);

  got := pg_temp.try_insert(format(
    'insert into tasks (season_id, title) values (%L, %L)', season, repeat('x', 201)));
  select * into lines, failures from pg_temp.note(lines, failures, 'a 201-character task title is rejected', got = 'REJECTED', got);

  got := pg_temp.try_insert(format(
    'insert into tasks (season_id, title) values (%L, %L)', season, repeat('x', 200)));
  select * into lines, failures from pg_temp.note(lines, failures, 'a 200-character task title (the limit, not over it) is accepted', got = 'ACCEPTED', got);

  got := pg_temp.try_insert(format(
    'insert into tasks (season_id, title) values (%L, %L)', season, '  Padded but real  '));
  select * into lines, failures from pg_temp.note(lines, failures, 'a title that is only whitespace-padded is accepted (btrim is on LENGTH, not stored)', got = 'ACCEPTED', got);

  -- ========================================================= task_proposals
  got := pg_temp.try_insert(format(
    'insert into task_proposals (season_id, title, raised_by) values (%L, %L, %L)', season, '', mem));
  select * into lines, failures from pg_temp.note(lines, failures, 'blank proposal title is rejected', got = 'REJECTED', got);

  got := pg_temp.try_insert(format(
    'insert into task_proposals (season_id, title, raised_by) values (%L, %L, %L)', season, repeat('y', 201), mem));
  select * into lines, failures from pg_temp.note(lines, failures, 'a 201-character proposal title is rejected', got = 'REJECTED', got);

  got := pg_temp.try_insert(format(
    'insert into task_proposals (season_id, title, raised_by) values (%L, %L, %L)', season, repeat('y', 200), mem));
  select * into lines, failures from pg_temp.note(lines, failures, 'a 200-character proposal title is accepted', got = 'ACCEPTED', got);

  -- ------------------------------------------------------------------- verdict
  if array_length(failures, 1) > 0 then
    raise exception E'TITLE VALIDATION CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'TITLE VALIDATION CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
