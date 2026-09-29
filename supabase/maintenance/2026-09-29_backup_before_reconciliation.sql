-- =============================================================================
--  In-database snapshot taken immediately before the 2026/27 reconciliation
--  migrations (20260125000000..20260125000300). Run once per environment, as
--  the database owner, BEFORE applying them:
--
--    hosted: Supabase SQL editor / MCP execute_sql, pasting this file
--    local : docker exec -i supabase_db_reqon psql -U postgres -f - < this file
--
--  Idempotent: an existing snapshot is never overwritten (create ... if not
--  exists), so a second run cannot replace the pre-change state with a
--  post-change one. The schema is private: no API role can see it.
--
--  It holds no secret: Auth rows are fingerprinted (md5 of the password hash,
--  never the hash itself) only to prove afterwards that nothing changed.
--  Drop it (drop schema maintenance_backup cascade) once the change is
--  accepted and a local export exists.
-- =============================================================================

create schema if not exists maintenance_backup;
revoke all on schema maintenance_backup from public;
comment on schema maintenance_backup is
  'Pre-change snapshots for recovery. Owner-only; never granted to anon or authenticated.';

create table if not exists maintenance_backup.r20260929_meta as
  select now() as taken_at, current_database() as db,
         (select max(id) from public.activity) as activity_max_id,
         (select count(*) from public.activity) as activity_count,
         (select md5(string_agg(concat_ws('|', clause_key, printed_ref, section, article, article_title, group_title,
                  subteam_key, body, obligation, criticality, phase, milestone_key, is_team_duty, specs::text, regs_ref),
                  E'\n' order by clause_key collate "C")) from public.clauses) as clauses_content_md5;

create table if not exists maintenance_backup.r20260929_auth_users as
  select id, email, md5(coalesce(encrypted_password, '')) as password_hash_md5,
         email_confirmed_at, created_at
  from auth.users;

create table if not exists maintenance_backup.r20260929_members as select * from public.members;
create table if not exists maintenance_backup.r20260929_member_roles as select * from public.member_roles;
create table if not exists maintenance_backup.r20260929_subteams as select * from public.subteams;
create table if not exists maintenance_backup.r20260929_handover_notes as select * from public.handover_notes;
create table if not exists maintenance_backup.r20260929_tasks as select * from public.tasks;
create table if not exists maintenance_backup.r20260929_task_proposals as select * from public.task_proposals;
create table if not exists maintenance_backup.r20260929_task_requirements as select * from public.task_requirements;
create table if not exists maintenance_backup.r20260929_proposal_requirements as select * from public.proposal_requirements;
create table if not exists maintenance_backup.r20260929_clause_status as select * from public.clause_status;
create table if not exists maintenance_backup.r20260929_clauses as
  select clause_key, subteam_key, source_page, regs_ref from public.clauses;
create table if not exists maintenance_backup.r20260929_regulation_documents as select * from public.regulation_documents;
create table if not exists maintenance_backup.r20260929_milestones as select * from public.milestones;
create table if not exists maintenance_backup.r20260929_milestone_sections as select * from public.milestone_sections;
create table if not exists maintenance_backup.r20260929_specs as select * from public.specs;
create table if not exists maintenance_backup.r20260929_spec_measurements as select * from public.spec_measurements;
create table if not exists maintenance_backup.r20260929_meetings as select * from public.meetings;

select (select taken_at from maintenance_backup.r20260929_meta) as snapshot_taken_at,
       (select count(*) from maintenance_backup.r20260929_subteams) as subteams,
       (select count(*) from maintenance_backup.r20260929_tasks) as tasks,
       (select count(*) from maintenance_backup.r20260929_clauses) as clauses,
       (select count(*) from maintenance_backup.r20260929_auth_users) as auth_users;
