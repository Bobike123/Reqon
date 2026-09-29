-- =============================================================================
--  RECOVERY ONLY. Reverts the data effects of 20260125000100..20260125000300
--  from the snapshot 2026-09-29_backup_before_reconciliation.sql took in the
--  SAME database. Run as the database owner, only after deciding to roll back:
--
--    hosted: SQL editor / MCP execute_sql with this file
--    local : docker exec -i supabase_db_reqon psql -U postgres -v ON_ERROR_STOP=1 -f - < this file
--
--  What it restores: the 14 legacy departments exactly as they were (names,
--  Heads, order), every task/proposal/handover/clause department reference,
--  the four source-reconciled task states, the handover rows that were
--  removed empty, clause pages and the book page count. It deletes only the
--  task the reconciliation imported (identified by its 'imported' activity
--  row). Activity is never deleted: the restore is appended as its own event.
--
--  What it deliberately keeps: the additive schema (regulation_subjects,
--  clauses.source_subject_key, the maintenance functions) and any uploaded
--  book file / regulation_documents.storage_path, which has its own step.
--  Migration history still lists 20260125000000..300 as applied; to apply the
--  reconciliation again later, call the maintenance functions directly.
--
--  The one protection it has to step around: the 14 legacy departments were
--  grandfathered above the 10-active cap, which no ordinary insert can
--  reproduce. trg_department_cap alone is disabled, inside this transaction,
--  and re-enabled before COMMIT; any error rolls everything back with it.
-- =============================================================================

begin;

do $$
begin
  if to_regclass('maintenance_backup.r20260929_subteams') is null then
    raise exception 'no 2026-09-29 snapshot in this database; nothing can be restored from here';
  end if;
end $$;

select set_config('reqon.task_lifecycle_write', 'on', true);
select set_config('reqon.proposal_write', 'on', true);
lock table subteams, tasks, task_proposals, handover_notes, clauses, regulation_documents in share row exclusive mode;

-- 1. the task the reconciliation imported (and nothing else the team added since)
delete from tasks t
where not exists (select 1 from maintenance_backup.r20260929_tasks b where b.id = t.id)
  and exists (select 1 from activity a where a.entity = 'task' and a.entity_id = t.id::text
                and a.action = 'imported' and a.detail->>'source' like 'migration 20260125000300%');

-- 2. the four source-reconciled states (only rows that migration changed)
update tasks t set state = b.state
from maintenance_backup.r20260929_tasks b
where t.id = b.id and t.state is distinct from b.state
  and exists (select 1 from activity a where a.entity = 'task' and a.entity_id = t.id::text
                and a.action = 'source_reconciled');

-- 3. the legacy departments, as they were
alter table subteams disable trigger trg_department_cap;

insert into subteams
select b.* from maintenance_backup.r20260929_subteams b
where not exists (select 1 from subteams s where s.key = b.key);

update subteams s
set name = b.name, description = b.description, book_section = b.book_section, is_parked = b.is_parked,
    sort_order = b.sort_order, lead_id = b.lead_id,
    archived_at = b.archived_at, archived_by = b.archived_by, archive_reason = b.archive_reason
from maintenance_backup.r20260929_subteams b
where s.key = b.key
  and (s.name, s.description, s.book_section, s.is_parked, s.sort_order, s.lead_id, s.archived_at, s.archive_reason)
      is distinct from
      (b.name, b.description, b.book_section, b.is_parked, b.sort_order, b.lead_id, b.archived_at, b.archive_reason);

-- 4. every reference back where it was
update tasks t set subteam_key = b.subteam_key
from maintenance_backup.r20260929_tasks b
where t.id = b.id and t.subteam_key is distinct from b.subteam_key;

update task_proposals p set subteam_key = b.subteam_key
from maintenance_backup.r20260929_task_proposals b
where p.id = b.id and p.subteam_key is distinct from b.subteam_key;

update handover_notes h set subteam_key = b.subteam_key
from maintenance_backup.r20260929_handover_notes b
where h.id = b.id and h.subteam_key is distinct from b.subteam_key;

insert into handover_notes
select b.* from maintenance_backup.r20260929_handover_notes b
where not exists (select 1 from handover_notes h where h.id = b.id)
on conflict do nothing;

update clauses c set subteam_key = b.subteam_key, source_page = b.source_page
from maintenance_backup.r20260929_clauses b
where c.clause_key = b.clause_key
  and (c.subteam_key, c.source_page) is distinct from (b.subteam_key, b.source_page);

update regulation_documents d set page_count = b.page_count, page_offset = b.page_offset
from maintenance_backup.r20260929_regulation_documents b
where d.regs_ref = b.regs_ref and (d.page_count, d.page_offset) is distinct from (b.page_count, b.page_offset);

-- 5. the departments the reconciliation created, now unreferenced
delete from subteams s
where not exists (select 1 from maintenance_backup.r20260929_subteams b where b.key = s.key)
  and s.key in ('SWDATA', 'MECH', 'BUILD', 'OPS')
  and not exists (select 1 from tasks where subteam_key = s.key)
  and not exists (select 1 from task_proposals where subteam_key = s.key)
  and not exists (select 1 from handover_notes where subteam_key = s.key)
  and not exists (select 1 from clauses where subteam_key = s.key);

alter table subteams enable trigger trg_department_cap;

-- 6. prove it before committing
do $$
begin
  if exists (select 1 from maintenance_backup.r20260929_subteams b full join subteams s using (key)
             where s.key is null or b.key is null
                or (b.name, b.lead_id, b.sort_order, b.archived_at) is distinct from (s.name, s.lead_id, s.sort_order, s.archived_at)) then
    raise exception 'restore: departments differ from the snapshot';
  end if;
  if exists (select 1 from maintenance_backup.r20260929_tasks b full join tasks t using (id)
             where (t.id is null) or (b.id is not null and (b.state, b.subteam_key) is distinct from (t.state, t.subteam_key))) then
    raise exception 'restore: tasks differ from the snapshot';
  end if;
  if exists (select 1 from maintenance_backup.r20260929_clauses b join clauses c using (clause_key)
             where (b.subteam_key, b.source_page) is distinct from (c.subteam_key, c.source_page)) then
    raise exception 'restore: clauses differ from the snapshot';
  end if;
  if exists (select 1 from maintenance_backup.r20260929_handover_notes b left join handover_notes h using (id)
             where h.id is null or h.subteam_key is distinct from b.subteam_key) then
    raise exception 'restore: handover notes differ from the snapshot';
  end if;
end $$;

insert into activity (actor_id, season_id, entity, entity_id, action, detail)
values (null, null, 'maintenance', 'r20260929', 'restored_from_backup',
        jsonb_build_object('reverted', 'migrations 20260125000100..20260125000300 (data only)',
                           'snapshot_taken_at', (select taken_at from maintenance_backup.r20260929_meta)));

commit;
