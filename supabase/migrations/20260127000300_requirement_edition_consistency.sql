-- =============================================================================
--  Backend completion Phase 3, step 4 of 4: requirement links must belong to the
--  season's regulations edition. (phase-01.md F-08.)
--
--  WHAT WAS WRONG (phase-01-repro.sql R06). link_task_requirement(),
--  submit_proposal() and set_proposal_requirements() only checked that the clause
--  EXISTS. The season trigger checks the junction row's season, not the clause's
--  edition. Once a second regulations edition is loaded, a task or proposal of
--  the 2026/27 season could cite a rule of another edition, and Register /
--  progress figures would count work against rules that do not apply.
--
--  AFTER. A BEFORE INSERT / UPDATE OF clause_key trigger on task_requirements and
--  proposal_requirements refuses a clause whose regs_ref differs from the regs_ref
--  of the parent's season. It runs for every writer (commands, maintenance scripts).
--  Existing rows are NOT touched: the migration only reports how many already
--  disagree (NOTICE), so they can be reviewed; nothing is deleted or rewritten.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Edition consistency of requirement links.
--    Existing data  Counted and reported, never changed. On the hosted project both
--                   junction tables are empty (2026-09-29) and there is one edition.
--    Authorization  Trigger function is SECURITY DEFINER with a pinned search_path
--                   (it reads clauses / seasons / parents regardless of the caller's
--                   RLS) and is not executable by API roles.
--    Locking        CREATE TRIGGER: SHARE ROW EXCLUSIVE on two small tables.
--    Rollback       DROP TRIGGER x2 and the function.
--    Deploy order   Any time after 20260127000200; independent of the client.
-- =============================================================================

create or replace function enforce_requirement_edition() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_season uuid;
  v_clause_edition text;
  v_season_edition text;
begin
  if TG_TABLE_NAME = 'task_requirements' then
    select season_id into v_season from tasks where id = new.task_id;
  else
    select season_id into v_season from task_proposals where id = new.proposal_id;
  end if;
  if v_season is null then
    return new; -- the season trigger reports the missing parent
  end if;
  select regs_ref into v_clause_edition from clauses where clause_key = new.clause_key;
  select regs_ref into v_season_edition from seasons where id = v_season;
  if v_clause_edition is distinct from v_season_edition then
    raise exception 'Requirement % belongs to the regulations edition "%", but this season follows "%".',
      new.clause_key, coalesce(v_clause_edition, '?'), coalesce(v_season_edition, '?')
      using errcode = '23514';
  end if;
  return new;
end $fn$;
revoke all on function enforce_requirement_edition() from public, anon, authenticated;

drop trigger if exists trg_task_requirement_edition on task_requirements;
create trigger trg_task_requirement_edition before insert or update of clause_key, task_id on task_requirements
  for each row execute function enforce_requirement_edition();
drop trigger if exists trg_proposal_requirement_edition on proposal_requirements;
create trigger trg_proposal_requirement_edition before insert or update of clause_key, proposal_id on proposal_requirements
  for each row execute function enforce_requirement_edition();

do $report$
declare
  v_tasks int;
  v_proposals int;
begin
  select count(*) into v_tasks
    from task_requirements r join tasks t on t.id = r.task_id join seasons s on s.id = t.season_id
    join clauses c on c.clause_key = r.clause_key where c.regs_ref is distinct from s.regs_ref;
  select count(*) into v_proposals
    from proposal_requirements r join task_proposals p on p.id = r.proposal_id join seasons s on s.id = p.season_id
    join clauses c on c.clause_key = r.clause_key where c.regs_ref is distinct from s.regs_ref;
  raise notice 'requirement links citing another regulations edition: % task link(s), % proposal link(s) (left unchanged)',
    v_tasks, v_proposals;
end
$report$;
