-- =============================================================================
--  Read-only verification of the 2026/27 reconciliation against the snapshot
--  taken by 2026-09-29_backup_before_reconciliation.sql in the SAME database.
--  Changes nothing. One row per check; the last row, ALL, is true only if
--  every check is.
--
--  Auth rows are compared on identity, email, password-hash fingerprint,
--  confirmation and creation — not on last_sign_in_at/updated_at, which a
--  person signing in legitimately changes.
-- =============================================================================

with
five as (select unnest(array['SWDATA','MECH','ELEC','BUILD','OPS']) as key),
legacy as (select unnest(array['ADMIN','GEOM','CHASSIS','BODY','CONTROL','BRAKES','WHEELS',
                               'LIVERY','RIDER','PWR_EF','SCRUT','DOCS','RACEOP']) as key),
b_tasks as (select * from maintenance_backup.r20260929_tasks),
checks(n, name, ok, detail) as (
  -- ------------------------------------------------------ people and access
  select 1, 'Auth users unchanged (id, email, password hash, confirmation, created)',
    (select count(*) from auth.users) = (select count(*) from maintenance_backup.r20260929_auth_users)
    and not exists (
      select 1 from maintenance_backup.r20260929_auth_users b
      full join auth.users u using (id)
      where u.id is null or b.id is null
         or (b.email, b.password_hash_md5, b.email_confirmed_at, b.created_at)
            is distinct from (u.email, md5(coalesce(u.encrypted_password, '')), u.email_confirmed_at, u.created_at)),
    (select count(*) from auth.users)::text || ' users'
  union all
  select 2, 'Member profiles unchanged (every column)',
    not exists (
      select 1 from maintenance_backup.r20260929_members b full join public.members m using (id)
      where m.id is null or b.id is null or to_jsonb(b) is distinct from to_jsonb(m)),
    (select count(*) from public.members)::text || ' members'
  union all
  select 3, 'Role grants unchanged',
    not exists (
      select 1 from maintenance_backup.r20260929_member_roles b
      full join public.member_roles r using (member_id, role)
      where r.member_id is null or b.member_id is null),
    (select string_agg(m.full_name || '=' || r.role, ', ' order by r.role, m.full_name)
       from public.member_roles r join public.members m on m.id = r.member_id)
  union all
  select 4, 'Claudiu-Bogdan Ispas and Máté Berta-Somogyi hold Developer on their existing ids',
    (select count(*) from public.member_roles r join public.members m on m.id = r.member_id
      join maintenance_backup.r20260929_members b on b.id = m.id
      where r.role = 'developer' and m.full_name in ('Claudiu-Bogdan Ispas', 'Máté Berta-Somogyi')) = 2,
    null
  union all
  select 5, 'An active President still exists',
    exists (select 1 from public.member_roles r join public.members m on m.id = r.member_id
            where r.role = 'president' and m.status = 'active'),
    null
  -- ------------------------------------------------------------ departments
  union all
  select 6, 'Exactly the five departments, all active, in order',
    (select string_agg(key, ',' order by sort_order) from public.subteams) = 'SWDATA,MECH,ELEC,BUILD,OPS'
    and not exists (select 1 from public.subteams where archived_at is not null),
    (select string_agg(key || ':' || name, '; ' order by sort_order) from public.subteams)
  union all
  select 7, 'No Head invented: new departments have none, ELEC kept its own',
    not exists (select 1 from public.subteams where key in ('SWDATA','MECH','BUILD','OPS') and lead_id is not null)
    and (select lead_id from public.subteams where key = 'ELEC')
        is not distinct from (select lead_id from maintenance_backup.r20260929_subteams where key = 'ELEC'),
    (select coalesce(string_agg(key || '<-' || (lead_id)::text, ', '), 'no legacy Head to hold')
       from maintenance_backup.r20260929_subteams where lead_id is not null)
  union all
  select 8, 'Every legacy department removal is recorded in activity',
    (select count(*) from public.activity where entity = 'department' and action = 'removed'
       and entity_id in (select key from legacy)) =
    (select count(*) from maintenance_backup.r20260929_subteams where key in (select key from legacy) and key <> 'ELEC'),
    null
  union all
  select 9, 'No reference to a legacy department remains anywhere',
    not exists (select 1 from public.tasks where subteam_key in (select key from legacy where key <> 'ELEC'))
    and not exists (select 1 from public.task_proposals where subteam_key in (select key from legacy where key <> 'ELEC'))
    and not exists (select 1 from public.handover_notes where subteam_key in (select key from legacy where key <> 'ELEC'))
    and not exists (select 1 from public.clauses where subteam_key in (select key from legacy where key <> 'ELEC')),
    null
  union all
  select 10, 'No written handover note was lost',
    not exists (select 1 from maintenance_backup.r20260929_handover_notes b
                where btrim(b.body) <> '' and not exists (
                  select 1 from public.handover_notes h where h.id = b.id and h.body = b.body)),
    (select count(*)::text from public.handover_notes) || ' notes now'
  -- -------------------------------------------------------------- requirements
  union all
  select 11, 'Every clause keeps its original classification (source_subject_key = old department)',
    not exists (select 1 from maintenance_backup.r20260929_clauses b join public.clauses c using (clause_key)
                where c.source_subject_key is distinct from b.subteam_key)
    and (select count(*) from public.clauses) = (select count(*) from maintenance_backup.r20260929_clauses),
    null
  union all
  select 12, 'Requirement ownership: 757 assigned to the five, 389 unassigned',
    (select count(*) from public.clauses where subteam_key in (select key from five)) = 757
    and (select count(*) from public.clauses where subteam_key is null) = 389,
    (select string_agg(coalesce(subteam_key, 'unassigned') || '=' || n, ', ' order by subteam_key nulls last)
       from (select subteam_key, count(*) n from public.clauses group by 1) x)
  union all
  select 13, 'Requirement status untouched (no requirement checked by the remap)',
    not exists (select 1 from maintenance_backup.r20260929_clause_status b full join public.clause_status s using (id)
                where s.id is null or b.id is null or to_jsonb(b) is distinct from to_jsonb(s)),
    (select count(*)::text from public.clause_status) || ' status rows'
  union all
  select 14, 'Every MS2627 Rev.01 clause has a page in 1..234; book row 234 pages, offset 0',
    not exists (select 1 from public.clauses where regs_ref = 'MS2627 Rev.01'
                  and (source_page is null or source_page not between 1 and 234))
    and (select page_count = 234 and page_offset = 0 from public.regulation_documents where regs_ref = 'MS2627 Rev.01'),
    (select coalesce(storage_path, 'storage_path not set (upload pending)') from public.regulation_documents
      where regs_ref = 'MS2627 Rev.01')
  union all
  select 15, 'A configured book path points at an object that exists',
    (select storage_path is null
         or exists (select 1 from storage.objects o where o.bucket_id = 'regulations' and o.name = d.storage_path)
       from public.regulation_documents d where regs_ref = 'MS2627 Rev.01'),
    null
  -- --------------------------------------------------------------------- work
  union all
  select 16, 'Every task id survived; identity, owner, dates, links, completion unchanged; department = documented mapping',
    not exists (
      select 1 from b_tasks b left join public.tasks t using (id)
      where t.id is null
         or (b.season_id, b.title, b.detail, b.owner_id, b.due_date, b.starts_on, b.section_id, b.milestone_key,
             b.source_proposal, b.created_by, b.created_at, b.completed_at, b.completion_source, b.archived_at,
             b.priority, b.links_required)
            is distinct from
            (t.season_id, t.title, t.detail, t.owner_id, t.due_date, t.starts_on, t.section_id, t.milestone_key,
             t.source_proposal, t.created_by, t.created_at, t.completed_at, t.completion_source, t.archived_at,
             t.priority, t.links_required)
         or t.subteam_key is distinct from
            case when b.subteam_key in (select key from legacy)
                 then maintenance.legacy_department_target(b.subteam_key) else b.subteam_key end),
    (select count(*)::text from public.tasks) || ' tasks'
  union all
  select 17, 'Only source-backed state changes: todo -> wip, never a downgrade',
    not exists (select 1 from b_tasks b join public.tasks t using (id)
                where b.state is distinct from t.state and not (b.state = 'todo' and t.state = 'wip'))
    and not exists (select 1 from b_tasks b join public.tasks t using (id)
                where b.state is distinct from t.state and not exists (
                  select 1 from public.activity a where a.entity = 'task' and a.entity_id = t.id::text
                    and a.action = 'source_reconciled')),
    (select coalesce(string_agg(t.title || ': ' || b.state || ' -> ' || t.state, '; '), 'none')
       from b_tasks b join public.tasks t using (id) where b.state is distinct from t.state)
  union all
  select 18, 'New tasks are only the source-backed import, recorded with its sources',
    not exists (select 1 from public.tasks t where not exists (select 1 from b_tasks b where b.id = t.id)
                and not exists (select 1 from public.activity a where a.entity = 'task'
                                  and a.entity_id = t.id::text and a.action = 'imported')),
    (select coalesce(string_agg(t.title || ' (' || t.state || ')', '; '), 'none') from public.tasks t
      where not exists (select 1 from b_tasks b where b.id = t.id))
  union all
  select 19, 'Zero duplicate tasks (season + title)',
    not exists (select 1 from public.tasks group by season_id, lower(btrim(title)) having count(*) > 1),
    null
  union all
  select 20, 'Proposals unchanged except the documented department remap',
    not exists (select 1 from maintenance_backup.r20260929_task_proposals b full join public.task_proposals p using (id)
                where p.id is null or b.id is null
                   or (to_jsonb(b) - 'subteam_key' - 'updated_at') is distinct from (to_jsonb(p) - 'subteam_key' - 'updated_at')
                   or p.subteam_key is distinct from
                      case when b.subteam_key in (select key from legacy)
                           then maintenance.legacy_department_target(b.subteam_key) else b.subteam_key end),
    (select count(*)::text from public.task_proposals) || ' proposals'
  union all
  select 21, 'Task and proposal requirement links unchanged',
    not exists (select 1 from maintenance_backup.r20260929_task_requirements b
                full join public.task_requirements r using (task_id, clause_key)
                where r.task_id is null or b.task_id is null)
    and not exists (select 1 from maintenance_backup.r20260929_proposal_requirements b
                full join public.proposal_requirements r using (proposal_id, clause_key)
                where r.proposal_id is null or b.proposal_id is null),
    null
  union all
  select 22, 'Milestones, sections, specs, measurements and meetings unchanged',
    not exists (select 1 from maintenance_backup.r20260929_milestones b full join public.milestones x using (key)
                where x.key is null or b.key is null or to_jsonb(b) is distinct from to_jsonb(x))
    and not exists (select 1 from maintenance_backup.r20260929_milestone_sections b full join public.milestone_sections x using (id)
                where x.id is null or b.id is null or to_jsonb(b) is distinct from to_jsonb(x))
    and not exists (select 1 from maintenance_backup.r20260929_specs b full join public.specs x using (id)
                where x.id is null or b.id is null or to_jsonb(b) is distinct from to_jsonb(x))
    and not exists (select 1 from maintenance_backup.r20260929_spec_measurements b full join public.spec_measurements x using (id)
                where x.id is null or b.id is null or to_jsonb(b) is distinct from to_jsonb(x))
    and not exists (select 1 from maintenance_backup.r20260929_meetings b full join public.meetings x using (id)
                where x.id is null or b.id is null or to_jsonb(b) is distinct from to_jsonb(x)),
    null
  union all
  select 23, 'History only appended to (no activity row lost)',
    (select count(*) from public.activity where id <= (select activity_max_id from maintenance_backup.r20260929_meta))
      = (select activity_count from maintenance_backup.r20260929_meta),
    (select count(*)::text from public.activity where id > (select activity_max_id from maintenance_backup.r20260929_meta))
      || ' new activity rows'
)
select n, name, ok, detail from checks
union all
select 99, 'ALL', bool_and(ok), count(*) filter (where not ok) || ' failing' from checks
order by n;
