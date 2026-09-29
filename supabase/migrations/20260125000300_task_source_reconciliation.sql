-- =============================================================================
--  2026/27 task reconciliation against the club's own source files.
--
--  Matches existing tasks (season 2026/27, exact title) and updates them in
--  place — task ids, links, owners, dates and history are kept; nothing is
--  duplicated. Two kinds of change, both source-backed:
--
--  1. Status the live row has never recorded. "TO DO LIST.xlsx" (sha256
--     b86688d1…dbad9d14, last saved 2026-09-13T13:14:38Z) marks four tasks
--     In progress that the live database still holds at the seed's default
--     'todo'. The status is applied ONLY when all of this holds:
--       * the live state is still 'todo' (never a downgrade: a live 'done'
--         stays 'done' even where the sheet says otherwise — those are
--         reported as holds, see docs/data-rebuild/RECONCILIATION_REPORT.md);
--       * the row was last written before the sheet was last saved, so the
--         sheet is the newer information;
--       * the task is not archived.
--     Moving todo -> wip sets no completion time (guard_task_edit clears it).
--
--  2. One source-backed task with no live counterpart:
--     "Develop the requirements and project database" — in progress since
--     2026-09-08, owner Claudiu-Bogdan Ispas (Book_TIMELINE.xlsx Gantt!E22:L22,
--     sha256 1cb06916…4d82f55; SMC_Detailed Project Description.docx "Project
--     Current Status", sha256 b531fb78…67ce8a). Inserted only if no task with
--     that title exists in the season and the owner resolves to exactly one
--     active member. No proposal, approver, deadline, department or
--     requirement link is invented; the original author is unknown
--     (created_by NULL) and the import is recorded in activity.
--
--  Every change writes an activity row naming its source file, location and
--  hash. Re-running is a no-op. On a database without the 2026/27 season or
--  these tasks it does nothing.
-- =============================================================================

create or replace function maintenance.reconcile_source_tasks()
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  c_source constant text := 'migration 20260125000300_task_source_reconciliation';
  c_sheet_saved constant timestamptz := '2026-09-13T13:14:38Z';
  c_todo_sha constant text := 'b86688d1249dc5fd829378d9b9fb1d16339ceadc3a65518b1ae1cd14dbad9d14';
  v_season uuid;
  v_owner uuid;
  v_owner_matches int;
  v_task uuid;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  r record;
begin
  select id into v_season from seasons where label = '2026/27';
  if v_season is null then
    return jsonb_build_object('applied', false, 'reason', 'season 2026/27 not present');
  end if;

  perform set_config('reqon.task_lifecycle_write', 'on', true);
  lock table tasks in share row exclusive mode;

  -- ------------------------------------------------ 1. todo -> wip from sheet
  for r in
    select * from (values
      ('Submit official SDU form for new student organization', 'Sheet1!B12:F12; E12 fill and E2:E7 legend'),
      ('Establish competition main tasks and deadlines',        'Sheet1!B18:F18; E18 fill and E2:E7 legend'),
      ('Register organization as non-profit to get business CVR', 'Sheet1!B21:F21; E21 fill and E2:E7 legend'),
      ('Open organization bank account (Danske Bank)',          'Sheet1!B22:F22; E22 fill and E2:E7 legend')
    ) as s(title, location)
  loop
    select id into v_task from tasks
    where season_id = v_season and title = r.title and archived_at is null
      and state = 'todo' and updated_at < c_sheet_saved;

    if v_task is null then
      v_skipped := v_skipped || jsonb_build_object('title', r.title,
        'reason', 'not present, not todo, archived, or edited after the sheet was saved');
      continue;
    end if;

    update tasks set state = 'wip' where id = v_task;

    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (null, v_season, 'task', v_task::text, 'source_reconciled',
      jsonb_build_object('title', r.title, 'field', 'state', 'from', 'todo', 'to', 'wip',
        'source_file', 'TO DO LIST.xlsx', 'source_location', r.location, 'source_sha256', c_todo_sha,
        'source_saved_at', c_sheet_saved, 'source', c_source));

    v_applied := v_applied || jsonb_build_object('task', v_task, 'title', r.title, 'state', 'todo -> wip');
  end loop;

  -- --------------------------------- 2. the requirements/project database task
  if exists (select 1 from tasks where season_id = v_season
               and lower(title) = lower('Develop the requirements and project database')) then
    v_skipped := v_skipped || jsonb_build_object('title', 'Develop the requirements and project database',
      'reason', 'already present');
  else
    select count(*), min(id::text)::uuid into v_owner_matches, v_owner
    from members where full_name = 'Claudiu-Bogdan Ispas' and status = 'active';

    if v_owner_matches <> 1 then
      v_skipped := v_skipped || jsonb_build_object('title', 'Develop the requirements and project database',
        'reason', format('owner Claudiu-Bogdan Ispas matched %s active members; held', v_owner_matches));
    else
      insert into tasks (season_id, title, detail, owner_id, state, starts_on, created_by)
      values (v_season, 'Develop the requirements and project database',
              'Build the software platform for project coordination, requirements and engineering documentation.',
              v_owner, 'wip', '2026-09-08', null)
      returning id into v_task;

      insert into activity (actor_id, season_id, entity, entity_id, action, detail)
      values (null, v_season, 'task', v_task::text, 'imported',
        jsonb_build_object('title', 'Develop the requirements and project database', 'state', 'wip',
          'starts_on', '2026-09-08', 'original_author', null,
          'sources', jsonb_build_array(
            jsonb_build_object('file', 'Book_TIMELINE.xlsx', 'location', 'Gantt!E22:L22',
              'sha256', '1cb069161e0fad6178d13a973ae629b21845dc7c5ddeb1ddef1553f2b4d82f55'),
            jsonb_build_object('file', 'Economics & Fund Applications/SMC_Detailed Project Description.docx',
              'location', 'Project Current Status paragraph',
              'sha256', 'b531fb786b648e3d70159c642f2738d72c95a810cad6686fbb6d43b5f167ce8a')),
          'source', c_source));

      v_applied := v_applied || jsonb_build_object('task', v_task,
        'title', 'Develop the requirements and project database', 'state', 'inserted (wip)');
    end if;
  end if;

  return jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
end
$fn$;

revoke all on function maintenance.reconcile_source_tasks() from public;

do $do$
begin
  raise notice 'task source reconciliation: %', maintenance.reconcile_source_tasks();
end
$do$;
