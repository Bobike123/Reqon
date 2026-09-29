-- =============================================================================
--  2026/27 organisation: the 14 legacy subsystem departments become five.
--
--    SWDATA  Software & Data Acquisition          (new key)
--    MECH    Mechanical Design & Testing          (new key)
--    ELEC    Electrical Systems & Integration     (existing key, reused in place)
--    BUILD   Manufacturing & Assembly             (new key)
--    OPS     Project Operations & Documentation   (new key)
--
--  Source: SMC_Data_Rebuild_Pack data/departments_proposed.json (sha256
--  fbfa5861…a12a9) and data/requirement_department_suggestions.json (sha256
--  7983335c…e8f71), adopted by the user on 2026-09-29.
--
--  What moves where (legacy_department_target below is the whole mapping):
--
--    ADMIN LIVERY DOCS                       -> OPS
--    GEOM CHASSIS BODY CONTROL BRAKES WHEELS
--    PWR_EF                                  -> MECH
--    ELEC                                    -> ELEC (same row, renamed)
--    RIDER SCRUT RACEOP                      -> no department (cross-cutting;
--                                               the work keeps no owner rather
--                                               than a guessed one)
--
--  That mapping applies to OPERATIONAL records (tasks, proposals, handover
--  notes). Requirements (clauses) are assigned clause by clause from the
--  reviewed suggestions instead: 757 get a department, 389 stay unassigned
--  and unchecked. Assigning a department never changes a clause_status.
--  The rulebook classification itself is kept in clauses.source_subject_key
--  (20260125000000) and regulation_subjects.
--
--  Heads: none is invented or carried across. A legacy department's Head is
--  recorded in its 'removed' activity row and returned as a hold; the five
--  new departments start without a Head (lead_id NULL) until appointed.
--  ELEC keeps whatever lead_id its own row already has.
--
--  Safety:
--    * one statement, one transaction: any failed assertion rolls back all;
--    * conflicts are refused before the first write, listed together
--      (unknown active department, a non-empty handover note with no target
--      or colliding with another, a target key already used differently,
--      a clause whose recorded subject disagrees with the reviewed data);
--    * no trigger is disabled; task/proposal changes use the documented
--      maintenance flags (reqon.task_lifecycle_write / reqon.proposal_write,
--      transaction-local), and every change is written to activity;
--    * legacy rows are archived through the normal archive guard, then
--      deleted only once nothing references them, so no ON DELETE SET NULL
--      or CASCADE ever fires;
--    * running it again is a no-op that reports the current state.
--
--  The functions live in the "maintenance" schema: no API role has USAGE on
--  it, and PostgREST does not expose it.
-- =============================================================================

create schema if not exists maintenance;
revoke all on schema maintenance from public;
comment on schema maintenance is
  'Server-side data maintenance for migrations and operators only. Never granted to anon or authenticated.';

-- Parses reviewed data only if its text still hashes to the digest recorded
-- beside it when it was generated.
create or replace function maintenance.checked_json(p_text text, p_md5 text)
returns jsonb language plpgsql immutable as $fn$
begin
  if md5(p_text) is distinct from p_md5 then
    raise exception 'reviewed data block does not match its recorded digest (got %, expected %); nothing applied',
      md5(p_text), p_md5 using errcode = '22023';
  end if;
  return p_text::jsonb;
end
$fn$;

create or replace function maintenance.legacy_department_target(p_key text)
returns text language sql immutable as $fn$
  select case p_key
    when 'ADMIN'   then 'OPS'
    when 'LIVERY'  then 'OPS'
    when 'DOCS'    then 'OPS'
    when 'GEOM'    then 'MECH'
    when 'CHASSIS' then 'MECH'
    when 'BODY'    then 'MECH'
    when 'CONTROL' then 'MECH'
    when 'BRAKES'  then 'MECH'
    when 'WHEELS'  then 'MECH'
    when 'PWR_EF'  then 'MECH'
    when 'ELEC'    then 'ELEC'
    else null      -- RIDER, SCRUT, RACEOP: no department
  end
$fn$;

create or replace function maintenance.reconcile_five_departments(p_clause_owners jsonb)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  c_source constant text := 'migration 20260125000100_five_department_structure';
  c_reason constant text := 'Replaced by the five-department structure for 2026/27 (migration 20260125000100)';
  c_removed constant text[] := array['ADMIN','GEOM','CHASSIS','BODY','CONTROL','BRAKES','WHEELS',
                                     'LIVERY','RIDER','PWR_EF','SCRUT','DOCS','RACEOP'];
  c_targets constant text[] := array['SWDATA','MECH','ELEC','BUILD','OPS'];
  v_conflicts text[] := '{}';
  v_holds jsonb := '[]'::jsonb;
  v_task_moves jsonb;
  v_proposal_moves jsonb;
  v_n int;
  v_clauses_assigned int := 0;
  v_clauses_unassigned int := 0;
  v_clauses_uncovered int := 0;
  v_handover_moved int := 0;
  v_handover_empty_removed int := 0;
  r record;
begin
  -- Quiesce: nobody writes to these while the structure changes underneath.
  lock table subteams, tasks, task_proposals, handover_notes, clauses in share row exclusive mode;

  -- ------------------------------------------------------------ already done?
  if not exists (select 1 from subteams where key = any(c_removed)) then
    return jsonb_build_object(
      'applied', false,
      'reason', 'no legacy department remains; nothing to do',
      'active_departments', (select jsonb_agg(key order by sort_order, key) from subteams where archived_at is null));
  end if;

  -- ------------------------------------------------------ input validation
  if p_clause_owners is null or jsonb_typeof(p_clause_owners) <> 'array' then
    raise exception 'reconcile_five_departments: p_clause_owners must be a JSON array' using errcode = '22023';
  end if;

  with owners as (
    select e->>0 as clause_key, e->>1 as subject, e->>2 as owner
    from jsonb_array_elements(p_clause_owners) e
  )
  select array_agg(problem order by problem) into v_conflicts from (
    select format('clause %s listed %s times', clause_key, count(*)) as problem
      from owners group by clause_key having count(*) > 1
    union all
    select format('clause %s does not exist', o.clause_key)
      from owners o where not exists (select 1 from clauses c where c.clause_key = o.clause_key)
    union all
    select format('clause %s: reviewed data says subject %s, database records %s',
                  o.clause_key, o.subject, coalesce(c.source_subject_key, 'nothing'))
      from owners o join clauses c using (clause_key)
      where c.source_subject_key is distinct from o.subject
    union all
    select format('clause %s: owner %s is not one of the five departments', o.clause_key, o.owner)
      from owners o where o.owner is not null and not (o.owner = any(c_targets))
  ) p;
  v_conflicts := coalesce(v_conflicts, '{}');

  -- ------------------------------------------------------ structural conflicts
  select v_conflicts || coalesce(array_agg(format(
           'active department %s (%s) is neither legacy nor one of the five; decide its future first', key, name)), '{}')
    into v_conflicts
  from subteams
  where archived_at is null and not (key = any(c_removed)) and not (key = any(c_targets));

  select v_conflicts || coalesce(array_agg(format(
           'department key %s already exists as "%s"; refusing to overwrite it', key, name)), '{}')
    into v_conflicts
  from subteams
  where key = any(array['SWDATA','MECH','BUILD','OPS'])
    and name is distinct from case key
      when 'SWDATA' then 'Software & Data Acquisition'
      when 'MECH'   then 'Mechanical Design & Testing'
      when 'BUILD'  then 'Manufacturing & Assembly'
      when 'OPS'    then 'Project Operations & Documentation' end;

  -- A handover note is the only operational record that cannot simply become
  -- "no department" (subteam_key is NOT NULL), so a non-empty one needs a home.
  select v_conflicts || coalesce(array_agg(format(
           'handover note %s (%s) has text but %s has no target department', h.id, h.subteam_key, h.subteam_key)), '{}')
    into v_conflicts
  from handover_notes h
  where h.subteam_key = any(c_removed)
    and maintenance.legacy_department_target(h.subteam_key) is null
    and btrim(h.body) <> '';

  select v_conflicts || coalesce(array_agg(format(
           'season %s: %s non-empty handover notes would merge into %s; merge them by hand first',
           season_id, n, target)), '{}')
    into v_conflicts
  from (
    select h.season_id, coalesce(maintenance.legacy_department_target(h.subteam_key), h.subteam_key) as target,
           count(*) as n
    from handover_notes h
    where (h.subteam_key = any(c_removed) or h.subteam_key = any(c_targets))
      and btrim(h.body) <> ''
    group by 1, 2
    having count(*) > 1
  ) x;

  if cardinality(v_conflicts) > 0 then
    raise exception E'Department reconciliation refused, nothing changed:\n%', array_to_string(v_conflicts, E'\n')
      using errcode = '23514';
  end if;

  perform set_config('reqon.task_lifecycle_write', 'on', true);
  perform set_config('reqon.proposal_write', 'on', true);

  -- ------------------------------------------ 1. remember every reference
  select coalesce(jsonb_agg(jsonb_build_array(id, subteam_key, state::text) order by id), '[]')
    into v_task_moves from tasks where subteam_key = any(c_removed);
  select coalesce(jsonb_agg(jsonb_build_array(id, subteam_key) order by id), '[]')
    into v_proposal_moves from task_proposals where subteam_key = any(c_removed);

  -- ------------- 2. release the legacy rows so the archive guard accepts them
  -- Only live work blocks an archive; finished work is re-pointed in step 5.
  update tasks set subteam_key = null
  where subteam_key = any(c_removed) and state not in ('done', 'cancelled');
  update task_proposals set subteam_key = null
  where subteam_key = any(c_removed) and archived_at is null and state <> 'decided';

  -- --------------------------------------- 3. archive the legacy departments
  -- Through the ordinary guard and audit trigger, never around them.
  update subteams
  set archived_at = now(), archived_by = null, archive_reason = c_reason
  where key = any(c_removed) and archived_at is null;

  -- -------------------------------------------- 4. the five departments
  update subteams
  set name = 'Electrical Systems & Integration',
      description = 'Wiring, power distribution, ECU interfaces, sensors, dashboard, safety circuits and electrical integration.',
      book_section = null,
      is_parked = false
  where key = 'ELEC';

  insert into subteams (key, name, description, book_section, is_parked, sort_order)
  values
    ('SWDATA', 'Software & Data Acquisition',
     'Embedded software, logging, telemetry, sensor data processing, analysis tools and the project platform.', null, false, 0),
    ('MECH', 'Mechanical Design & Testing',
     'Vehicle architecture, chassis, suspension, brakes, ergonomics, powertrain packaging, simulation, vehicle dynamics and test planning.', null, false, 1),
    ('ELEC', 'Electrical Systems & Integration',
     'Wiring, power distribution, ECU interfaces, sensors, dashboard, safety circuits and electrical integration.', null, false, 2),
    ('BUILD', 'Manufacturing & Assembly',
     'Manufacturing planning, machining, welding, tooling, assembly, workshop quality and build readiness.', null, false, 3),
    ('OPS', 'Project Operations & Documentation',
     'Project coordination, milestone submissions, requirements evidence, meeting records, finance, sponsorship, registration and event logistics.', null, false, 4)
  on conflict (key) do nothing;

  -- ELEC may have been archived in some environment; the five must be active.
  update subteams set archived_at = null, archived_by = null, archive_reason = null
  where key = any(c_targets) and archived_at is not null;

  update subteams
  set sort_order = array_position(c_targets, key) - 1
  where key = any(c_targets) and sort_order is distinct from array_position(c_targets, key) - 1;

  -- ---------------------------------------- 5. re-point tasks and proposals
  update tasks t
  set subteam_key = maintenance.legacy_department_target(m->>1)
  from jsonb_array_elements(v_task_moves) m
  where t.id = (m->>0)::uuid
    and t.subteam_key is distinct from maintenance.legacy_department_target(m->>1);

  update task_proposals p
  set subteam_key = maintenance.legacy_department_target(m->>1)
  from jsonb_array_elements(v_proposal_moves) m
  where p.id = (m->>0)::uuid
    and p.subteam_key is distinct from maintenance.legacy_department_target(m->>1);

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  select null, t.season_id, 'task', t.id::text, 'department_remapped',
         jsonb_build_object('title', t.title, 'from', m->>1,
                            'to', maintenance.legacy_department_target(m->>1), 'source', c_source)
  from jsonb_array_elements(v_task_moves) m join tasks t on t.id = (m->>0)::uuid;

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  select null, p.season_id, 'proposal', p.id::text, 'department_remapped',
         jsonb_build_object('title', p.title, 'from', m->>1,
                            'to', maintenance.legacy_department_target(m->>1), 'source', c_source)
  from jsonb_array_elements(v_proposal_moves) m join task_proposals p on p.id = (m->>0)::uuid;

  -- ------------------------------------------------------ 6. handover notes
  for r in
    select h.* from handover_notes h where h.subteam_key = any(c_removed) order by h.season_id, h.subteam_key
  loop
    if btrim(r.body) = '' then
      delete from handover_notes where id = r.id;
      v_handover_empty_removed := v_handover_empty_removed + 1;
    else
      -- The pre-check guarantees any row already at the target is empty.
      delete from handover_notes
      where season_id = r.season_id
        and subteam_key = maintenance.legacy_department_target(r.subteam_key)
        and btrim(body) = '';
      update handover_notes set subteam_key = maintenance.legacy_department_target(r.subteam_key)
      where id = r.id;
      insert into activity (actor_id, season_id, entity, entity_id, action, detail)
      values (null, r.season_id, 'handover_note', r.id::text, 'department_remapped',
              jsonb_build_object('from', r.subteam_key,
                                 'to', maintenance.legacy_department_target(r.subteam_key), 'source', c_source));
      v_handover_moved := v_handover_moved + 1;
    end if;
  end loop;

  -- ------------------------------------------- 7. requirement ownership
  -- Only clauses still owned by a legacy department: anything already
  -- reassigned in the app is newer information and is left alone.
  with owners as (
    select e->>0 as clause_key, e->>2 as owner
    from jsonb_array_elements(p_clause_owners) e
  )
  update clauses c set subteam_key = o.owner
  from owners o
  where c.clause_key = o.clause_key and c.subteam_key = any(c_removed);

  -- A legacy-owned clause the reviewed data does not cover becomes unassigned
  -- rather than silently keeping a key that is about to disappear.
  update clauses set subteam_key = null where subteam_key = any(c_removed);
  get diagnostics v_clauses_uncovered = row_count;

  select count(*) filter (where c.subteam_key is not null),
         count(*) filter (where c.subteam_key is null)
    into v_clauses_assigned, v_clauses_unassigned
  from clauses c
  where c.clause_key in (select e->>0 from jsonb_array_elements(p_clause_owners) e);

  -- -------------------------------- 8. record, then remove, the legacy rows
  for r in select s.* from subteams s where s.key = any(c_removed) order by s.sort_order loop
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (null, null, 'department', r.key, 'removed',
            jsonb_build_object('row', to_jsonb(r),
                               'operational_records_moved_to', maintenance.legacy_department_target(r.key),
                               'source', c_source));
    if r.lead_id is not null then
      v_holds := v_holds || jsonb_build_object(
        'hold', 'head_not_carried_over', 'legacy_department', r.key, 'lead_id', r.lead_id,
        'target', maintenance.legacy_department_target(r.key));
    end if;
  end loop;

  select count(*) into v_n from (
    select 1 from tasks where subteam_key = any(c_removed)
    union all select 1 from task_proposals where subteam_key = any(c_removed)
    union all select 1 from handover_notes where subteam_key = any(c_removed)
    union all select 1 from clauses where subteam_key = any(c_removed)
  ) refs;
  if v_n > 0 then
    raise exception 'reconcile_five_departments: % reference(s) to legacy departments remain; refusing to delete', v_n
      using errcode = '23514';
  end if;

  delete from subteams where key = any(c_removed);

  -- ----------------------------------------------------------- 9. assertions
  select count(*) into v_n from subteams where archived_at is null;
  if v_n <> 5 or exists (
       select 1 from unnest(c_targets) k
       where not exists (select 1 from subteams s where s.key = k and s.archived_at is null)) then
    raise exception 'reconcile_five_departments: expected exactly the five departments active, found %', v_n
      using errcode = '23514';
  end if;

  if exists (select 1 from tasks t where t.subteam_key is not null
               and not exists (select 1 from subteams s where s.key = t.subteam_key))
     or exists (select 1 from task_proposals p where p.subteam_key is not null
               and not exists (select 1 from subteams s where s.key = p.subteam_key))
     or exists (select 1 from clauses c where c.subteam_key is not null
               and not exists (select 1 from subteams s where s.key = c.subteam_key)) then
    raise exception 'reconcile_five_departments: orphaned department reference after remap' using errcode = '23514';
  end if;

  return jsonb_build_object(
    'applied', true,
    'departments', (select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'lead_id', lead_id) order by sort_order)
                    from subteams),
    'tasks_remapped', jsonb_array_length(v_task_moves),
    'proposals_remapped', jsonb_array_length(v_proposal_moves),
    'handover_notes_moved', v_handover_moved,
    'handover_notes_empty_removed', v_handover_empty_removed,
    'clauses_assigned', v_clauses_assigned,
    'clauses_unassigned', v_clauses_unassigned,
    'clauses_uncovered_set_unassigned', v_clauses_uncovered,
    'holds', v_holds);
end
$fn$;

revoke all on function maintenance.checked_json(text, text) from public;
revoke all on function maintenance.legacy_department_target(text) from public;
revoke all on function maintenance.reconcile_five_departments(jsonb) from public;

-- Per clause: [clause_key, recorded source subject, reviewed owner or null].
-- Generated by scripts/data-rebuild/gen-reconciliation-data.mjs from the pack;
-- do not edit by hand (npm run data:reconcile:check verifies it).
do $do$
declare
  v_result jsonb;
begin
  v_result := maintenance.reconcile_five_departments(
-- <generated:clause-owners>
maintenance.checked_json($json$[
["A.1.1.1","ADMIN","OPS"],
["A.1.1.2","ADMIN","OPS"],
["A.1.2.1","ADMIN","OPS"],
["A.1.2.2","ADMIN","OPS"],
["A.1.2.3","ADMIN","OPS"],
["A.1.3.1","ADMIN","OPS"],
["A.1.3.2","ADMIN","OPS"],
["A.1.3.3","ADMIN","OPS"],
["A.1.3.4","ADMIN","OPS"],
["A.1.4.1","ADMIN","OPS"],
["A.1.4.2","ADMIN","OPS"],
["A.1.4.3","ADMIN","OPS"],
["A.1.4.4","ADMIN","OPS"],
["A.1.4.5","ADMIN","OPS"],
["A.1.4.6","ADMIN","OPS"],
["A.1.5.1","ADMIN","OPS"],
["A.1.5.2","ADMIN","OPS"],
["A.1.5.3","ADMIN","OPS"],
["A.1.5.4","ADMIN","OPS"],
["A.1.5.5","ADMIN","OPS"],
["A.1.5.6","ADMIN","OPS"],
["A.1.5.7","ADMIN","OPS"],
["A.1.6.1","ADMIN","OPS"],
["A.1.6.10","ADMIN","OPS"],
["A.1.6.11","ADMIN","OPS"],
["A.1.6.12","ADMIN","OPS"],
["A.1.6.13","ADMIN","OPS"],
["A.1.6.2","ADMIN","OPS"],
["A.1.6.3","ADMIN","OPS"],
["A.1.6.4","ADMIN","OPS"],
["A.1.6.5","ADMIN","OPS"],
["A.1.6.6","ADMIN","OPS"],
["A.1.6.7","ADMIN","OPS"],
["A.1.6.8","ADMIN","OPS"],
["A.1.6.9","ADMIN","OPS"],
["A.1.7.1","ADMIN","OPS"],
["A.1.7.2","ADMIN","OPS"],
["A.1.7.3","ADMIN","OPS"],
["A.1.7.4","ADMIN","OPS"],
["A.1.7.5","ADMIN","OPS"],
["A.1.8.1","ADMIN","OPS"],
["A.1.8.2","ADMIN","OPS"],
["A.1.8.3","ADMIN","OPS"],
["A.1.9.1","ADMIN","OPS"],
["A.2.1.1","ADMIN","OPS"],
["A.2.1.2","ADMIN","OPS"],
["A.2.2.1","ADMIN","OPS"],
["A.2.2.2","ADMIN","OPS"],
["A.2.2.3","ADMIN","OPS"],
["A.2.3.1","ADMIN","OPS"],
["A.2.3.2","ADMIN","OPS"],
["A.2.3.3","ADMIN","OPS"],
["A.2.3.4","ADMIN","OPS"],
["A.2.3.5","ADMIN","OPS"],
["A.2.3.6","ADMIN","OPS"],
["A.2.4.1","ADMIN","OPS"],
["A.2.4.10","ADMIN","OPS"],
["A.2.4.11","ADMIN","OPS"],
["A.2.4.2","ADMIN","OPS"],
["A.2.4.3","ADMIN","OPS"],
["A.2.4.4","ADMIN","OPS"],
["A.2.4.5","ADMIN","OPS"],
["A.2.4.6","ADMIN","OPS"],
["A.2.4.7","ADMIN","OPS"],
["A.2.4.8","ADMIN","OPS"],
["A.2.4.9","ADMIN","OPS"],
["A.2.5.1","ADMIN","OPS"],
["A.2.5.2","ADMIN","OPS"],
["A.2.5.3","ADMIN","OPS"],
["A.2.5.4","ADMIN","OPS"],
["A.2.5.5","ADMIN","OPS"],
["A.2.5.6","ADMIN","OPS"],
["A.2.5.7","ADMIN","OPS"],
["A.2.5.8","ADMIN","OPS"],
["A.2.5.9","ADMIN","OPS"],
["A.2.6.1","ADMIN","OPS"],
["A.2.6.2","ADMIN","OPS"],
["A.2.6.3","ADMIN","OPS"],
["A.2.7.1","ADMIN","OPS"],
["A.2.7.2","ADMIN","OPS"],
["A.3.1.1","ADMIN","OPS"],
["A.3.1.2","ADMIN","OPS"],
["A.3.1.3","ADMIN","OPS"],
["A.3.1.4","ADMIN","OPS"],
["A.3.1.5","ADMIN","OPS"],
["A.3.1.6","ADMIN","OPS"],
["A.3.2.1","ADMIN","OPS"],
["A.3.2.2","ADMIN","OPS"],
["A.3.2.3","ADMIN","OPS"],
["A.3.2.4","ADMIN","OPS"],
["A.3.2.5","ADMIN","OPS"],
["A.3.2.6","ADMIN","OPS"],
["A.3.3.1","ADMIN","OPS"],
["A.3.4.1","ADMIN","OPS"],
["A.3.4.2","ADMIN","OPS"],
["A.3.4.3","ADMIN","OPS"],
["A.3.4.4","ADMIN","OPS"],
["A.3.4.5","ADMIN","OPS"],
["A.3.4.6","ADMIN","OPS"],
["A.3.4.7","ADMIN","OPS"],
["A.3.5.1","ADMIN","OPS"],
["A.3.5.2","ADMIN","OPS"],
["A.3.5.3","ADMIN","OPS"],
["A.3.6.1","ADMIN","OPS"],
["A.3.6.2","ADMIN","OPS"],
["A.3.6.3","ADMIN","OPS"],
["A.3.7.1","ADMIN","OPS"],
["A.3.7.2","ADMIN","OPS"],
["A.3.7.3","ADMIN","OPS"],
["A.3.7.4","ADMIN","OPS"],
["A.3.7.5","ADMIN","OPS"],
["A.3.7.6","ADMIN","OPS"],
["A.3.7.7","ADMIN","OPS"],
["A.3.7.8","ADMIN","OPS"],
["A.3.8.1","ADMIN","OPS"],
["A.4.1.1","ADMIN","BUILD"],
["A.4.2.1","ADMIN","OPS"],
["A.4.2.10","ADMIN","OPS"],
["A.4.2.2","ADMIN","OPS"],
["A.4.2.3","ADMIN","OPS"],
["A.4.2.4","ADMIN","OPS"],
["A.4.2.5","ADMIN","OPS"],
["A.4.2.6","ADMIN","OPS"],
["A.4.2.7","ADMIN","OPS"],
["A.4.2.8","ADMIN","BUILD"],
["A.4.2.9","ADMIN","BUILD"],
["A.5.1.1","ADMIN","OPS"],
["A.5.1.10","ADMIN","OPS"],
["A.5.1.11","ADMIN","OPS"],
["A.5.1.2","ADMIN","OPS"],
["A.5.1.3","ADMIN","OPS"],
["A.5.1.4","ADMIN","OPS"],
["A.5.1.5","ADMIN","OPS"],
["A.5.1.6","ADMIN","OPS"],
["A.5.1.7","ADMIN","OPS"],
["A.5.1.8","ADMIN","OPS"],
["A.5.1.9","ADMIN","OPS"],
["A.5.2.1","ADMIN","OPS"],
["A.5.2.2","ADMIN","OPS"],
["A.6.1.1","ADMIN","OPS"],
["A.6.2.1","ADMIN","OPS"],
["A.6.3.1","ADMIN","OPS"],
["A.6.4.1","ADMIN","OPS"],
["A.6.4.2","ADMIN","OPS"],
["A.6.4.3","ADMIN","OPS"],
["A.6.4.4","ADMIN","OPS"],
["A.6.4.5","ADMIN","OPS"],
["A.6.4.6","ADMIN","OPS"],
["A.6.4.7","ADMIN","OPS"],
["A.6.5.1","ADMIN","OPS"],
["A.6.5.2","ADMIN","OPS"],
["A.6.6.1","ADMIN","OPS"],
["A.6.7.1","ADMIN","OPS"],
["A.7.1.1","ADMIN","OPS"],
["A.7.1.2","ADMIN","OPS"],
["A.7.1.3","ADMIN","OPS"],
["A.7.1.4","ADMIN","OPS"],
["A.7.1.5","ADMIN","OPS"],
["A.7.2.1","ADMIN","OPS"],
["A.7.2.2","ADMIN","OPS"],
["A.7.3.1","ADMIN","OPS"],
["A.7.3.2","ADMIN","OPS"],
["A.7.3.3","ADMIN","OPS"],
["A.7.3.4","ADMIN","OPS"],
["A.7.4.1","ADMIN","OPS"],
["A.8.1.1","ADMIN","OPS"],
["B.1.1.1","GEOM","MECH"],
["B.1.1.2","GEOM","MECH"],
["B.1.1.3","GEOM","MECH"],
["B.1.1.4","GEOM","MECH"],
["B.1.1.5","GEOM","MECH"],
["B.1.1.6","GEOM","MECH"],
["B.1.1.7","GEOM","MECH"],
["B.1.1.8","GEOM","MECH"],
["B.10.1.1","ELEC","ELEC"],
["B.10.1.2","ELEC","ELEC"],
["B.10.2.1","ELEC","ELEC"],
["B.10.3.1","ELEC","ELEC"],
["B.10.3.10","ELEC","ELEC"],
["B.10.3.2","ELEC","ELEC"],
["B.10.3.3","ELEC","ELEC"],
["B.10.3.4","ELEC","ELEC"],
["B.10.3.5","ELEC","ELEC"],
["B.10.3.6","ELEC","ELEC"],
["B.10.3.7","ELEC","ELEC"],
["B.10.3.8","ELEC","ELEC"],
["B.10.3.9","ELEC","ELEC"],
["B.10.4.1","ELEC","ELEC"],
["B.10.4.2","ELEC","ELEC"],
["B.10.4.3","ELEC","ELEC"],
["B.10.4.4","ELEC","ELEC"],
["B.10.4.5","ELEC","ELEC"],
["B.10.5.1","ELEC","ELEC"],
["B.10.5.2","ELEC","ELEC"],
["B.10.6.1","ELEC","ELEC"],
["B.11.1.1","LIVERY","OPS"],
["B.11.1.2","LIVERY","OPS"],
["B.11.1.3","LIVERY","OPS"],
["B.11.1.4","LIVERY","OPS"],
["B.11.1.5","LIVERY","OPS"],
["B.11.1.6","LIVERY","OPS"],
["B.11.1.7","LIVERY","OPS"],
["B.11.1.8","LIVERY","OPS"],
["B.11.2.1","LIVERY","OPS"],
["B.11.2.2","LIVERY","OPS"],
["B.11.2.3","LIVERY","OPS"],
["B.11.3.1","LIVERY","OPS"],
["B.11.3.2","LIVERY","OPS"],
["B.11.3.3","LIVERY","OPS"],
["B.11.3.4","LIVERY","OPS"],
["B.11.3.5","LIVERY","OPS"],
["B.11.3.6","LIVERY","OPS"],
["B.11.3.7","LIVERY","OPS"],
["B.11.3.8","LIVERY","OPS"],
["B.12.1.1","RIDER",null],
["B.12.1.2","RIDER",null],
["B.12.1.3","RIDER",null],
["B.12.1.4","RIDER",null],
["B.12.1.5","RIDER",null],
["B.12.2.1","RIDER",null],
["B.12.2.2","RIDER",null],
["B.12.2.3","RIDER",null],
["B.12.2.4","RIDER",null],
["B.12.2.5","RIDER",null],
["B.12.2.6","RIDER",null],
["B.12.2.7","RIDER",null],
["B.12.3.1","RIDER",null],
["B.2.1.1","GEOM","MECH"],
["B.2.1.10","GEOM","MECH"],
["B.2.1.2","GEOM","MECH"],
["B.2.1.3","GEOM","MECH"],
["B.2.1.4","GEOM","MECH"],
["B.2.1.5","GEOM","MECH"],
["B.2.1.6","GEOM","MECH"],
["B.2.1.7","GEOM","MECH"],
["B.2.1.8","GEOM","MECH"],
["B.2.1.9","GEOM","MECH"],
["B.2.2.1","GEOM","MECH"],
["B.2.2.2","GEOM","MECH"],
["B.2.2.3","GEOM","MECH"],
["B.2.2.4","GEOM","MECH"],
["B.3.1.1","CHASSIS","MECH"],
["B.3.1.2","CHASSIS","MECH"],
["B.3.1.3","CHASSIS","MECH"],
["B.3.1.4","CHASSIS","MECH"],
["B.3.1.5","CHASSIS","MECH"],
["B.3.1.6","CHASSIS","MECH"],
["B.3.2.1","CHASSIS","BUILD"],
["B.3.2.2","CHASSIS","BUILD"],
["B.3.3.1","CHASSIS","MECH"],
["B.3.3.2","CHASSIS","MECH"],
["B.3.3.3","CHASSIS","MECH"],
["B.4.1.1","BODY","MECH"],
["B.4.1.2","BODY","MECH"],
["B.4.1.3","BODY","MECH"],
["B.4.1.4","BODY","MECH"],
["B.4.1.5","BODY","MECH"],
["B.4.1.6","BODY","MECH"],
["B.4.1.7","BODY","MECH"],
["B.4.1.8","BODY","MECH"],
["B.4.2.1","BODY","MECH"],
["B.4.2.2","BODY","MECH"],
["B.4.2.3","BODY","MECH"],
["B.4.3.1","BODY","MECH"],
["B.4.3.2","BODY","MECH"],
["B.4.3.3","BODY","MECH"],
["B.4.3.4","BODY","MECH"],
["B.4.3.5","BODY","MECH"],
["B.4.4.1","BODY","MECH"],
["B.4.4.2","BODY","MECH"],
["B.4.4.3","BODY","MECH"],
["B.5.1.1","CONTROL","MECH"],
["B.5.1.2","CONTROL","MECH"],
["B.5.1.3","CONTROL","MECH"],
["B.5.1.4","CONTROL","MECH"],
["B.5.1.5","CONTROL","MECH"],
["B.5.1.6","CONTROL","MECH"],
["B.5.1.7","CONTROL","MECH"],
["B.5.2.1","CONTROL","MECH"],
["B.5.2.2","CONTROL","MECH"],
["B.5.2.3","CONTROL","MECH"],
["B.5.2.4","CONTROL","MECH"],
["B.5.2.5","CONTROL","MECH"],
["B.5.2.6","CONTROL","MECH"],
["B.5.2.7","CONTROL","MECH"],
["B.6.1.1","BRAKES","MECH"],
["B.6.1.2","BRAKES","MECH"],
["B.6.2.1","BRAKES","MECH"],
["B.6.2.2","BRAKES","MECH"],
["B.6.2.3","BRAKES","MECH"],
["B.6.3.1","BRAKES","MECH"],
["B.6.3.2","BRAKES","MECH"],
["B.6.3.3","BRAKES","MECH"],
["B.6.3.4","BRAKES","MECH"],
["B.6.3.5","BRAKES","MECH"],
["B.6.3.6","BRAKES","MECH"],
["B.6.4.1","BRAKES","MECH"],
["B.6.4.2","BRAKES","MECH"],
["B.6.4.3","BRAKES","MECH"],
["B.6.4.4","BRAKES","MECH"],
["B.6.4.5","BRAKES","MECH"],
["B.6.4.6","BRAKES","MECH"],
["B.6.5.1","BRAKES","MECH"],
["B.6.5.2","BRAKES","MECH"],
["B.6.5.3","BRAKES","MECH"],
["B.6.6.1","BRAKES","MECH"],
["B.6.6.2","BRAKES","MECH"],
["B.6.6.3","BRAKES","MECH"],
["B.6.6.4","BRAKES","MECH"],
["B.6.7.1","BRAKES","MECH"],
["B.6.8.1","BRAKES","MECH"],
["B.6.8.2","BRAKES","MECH"],
["B.7.1.1","CONTROL","MECH"],
["B.7.1.2","CONTROL","MECH"],
["B.7.1.3","CONTROL","MECH"],
["B.7.1.4","CONTROL","MECH"],
["B.7.1.5","CONTROL","MECH"],
["B.7.1.6","CONTROL","MECH"],
["B.7.2.1","CONTROL","MECH"],
["B.7.2.2","CONTROL","MECH"],
["B.7.3.1","CONTROL","MECH"],
["B.7.3.2","CONTROL","MECH"],
["B.8.1.1","CONTROL","MECH"],
["B.8.1.2","CONTROL","MECH"],
["B.8.1.3","CONTROL","MECH"],
["B.8.2.1","CONTROL","MECH"],
["B.8.2.2","CONTROL","MECH"],
["B.8.2.3","CONTROL","MECH"],
["B.9.1.1","WHEELS","MECH"],
["B.9.1.2","WHEELS","MECH"],
["B.9.1.3","WHEELS","MECH"],
["B.9.1.4","WHEELS","MECH"],
["B.9.1.5","WHEELS","MECH"],
["B.9.1.6","WHEELS","MECH"],
["B.9.2.1","WHEELS","MECH"],
["B.9.2.2","WHEELS","MECH"],
["B.9.2.3","WHEELS","MECH"],
["B.9.2.4","WHEELS","MECH"],
["B.9.2.5","WHEELS","MECH"],
["B.9.2.6","WHEELS","MECH"],
["B.9.2.7","WHEELS","MECH"],
["C.1.1.1","PWR_EF","MECH"],
["C.1.1.10","PWR_EF","MECH"],
["C.1.1.11","PWR_EF","MECH"],
["C.1.1.12","PWR_EF","MECH"],
["C.1.1.13","PWR_EF","MECH"],
["C.1.1.14","PWR_EF","MECH"],
["C.1.1.15","PWR_EF","MECH"],
["C.1.1.16","PWR_EF","MECH"],
["C.1.1.17","PWR_EF","MECH"],
["C.1.1.18","PWR_EF","MECH"],
["C.1.1.2","PWR_EF","MECH"],
["C.1.1.3","PWR_EF","MECH"],
["C.1.1.4","PWR_EF","MECH"],
["C.1.1.5","PWR_EF","MECH"],
["C.1.1.6","PWR_EF","MECH"],
["C.1.1.7","PWR_EF","MECH"],
["C.1.1.8","PWR_EF","MECH"],
["C.1.1.9","PWR_EF","MECH"],
["C.1.2.1","PWR_EF","MECH"],
["C.1.2.2","PWR_EF","MECH"],
["C.1.2.3","PWR_EF","MECH"],
["C.1.3.1","PWR_EF","MECH"],
["C.1.3.2","PWR_EF","MECH"],
["C.1.3.3","PWR_EF","MECH"],
["C.1.4.1","PWR_EF","MECH"],
["C.1.4.2","PWR_EF","MECH"],
["C.1.4.3","PWR_EF","MECH"],
["C.1.4.4","PWR_EF","MECH"],
["C.1.4.5","PWR_EF","MECH"],
["C.1.4.6","PWR_EF","MECH"],
["C.1.4.7","PWR_EF","MECH"],
["C.1.4.8","PWR_EF","MECH"],
["C.1.5.1","PWR_EF","MECH"],
["C.1.5.2","PWR_EF","MECH"],
["C.1.5.3","PWR_EF","MECH"],
["C.1.6.1","PWR_EF","MECH"],
["C.1.6.2","PWR_EF","MECH"],
["C.1.6.3","PWR_EF","MECH"],
["C.1.6.4","PWR_EF","MECH"],
["C.1.6.5","PWR_EF","MECH"],
["C.1.6.6","PWR_EF","MECH"],
["C.1.6.7","PWR_EF","MECH"],
["C.2.1.1","PWR_EF","MECH"],
["C.2.1.2","PWR_EF","MECH"],
["C.2.1.3","PWR_EF","MECH"],
["C.2.2.1","PWR_EF","MECH"],
["C.2.2.2","PWR_EF","MECH"],
["C.2.2.3","PWR_EF","MECH"],
["C.2.2.4","PWR_EF","MECH"],
["C.2.3.1","PWR_EF","MECH"],
["C.2.3.2","PWR_EF","MECH"],
["C.2.4.1","PWR_EF","MECH"],
["C.2.4.2","PWR_EF","MECH"],
["C.2.4.3","PWR_EF","MECH"],
["C.2.4.4","PWR_EF","MECH"],
["C.2.4.5","PWR_EF","MECH"],
["C.2.5.1","PWR_EF","MECH"],
["C.2.5.2","PWR_EF","MECH"],
["C.2.5.3","PWR_EF","MECH"],
["C.2.5.4","PWR_EF","MECH"],
["C.3.1.1","PWR_EF","MECH"],
["C.3.1.2","PWR_EF","MECH"],
["C.3.1.3","PWR_EF","MECH"],
["C.3.1.4","PWR_EF","MECH"],
["C.3.1.5","PWR_EF","MECH"],
["C.3.1.6","PWR_EF","MECH"],
["C.3.1.7","PWR_EF","MECH"],
["C.3.2.1","PWR_EF","MECH"],
["C.3.2.2","PWR_EF","MECH"],
["C.3.2.3","PWR_EF","MECH"],
["C.3.3.1","PWR_EF","MECH"],
["C.3.3.2","PWR_EF","MECH"],
["C.3.3.3","PWR_EF","MECH"],
["C.3.3.4","PWR_EF","MECH"],
["C.3.4.1","PWR_EF","MECH"],
["C.3.5.1","PWR_EF","MECH"],
["C.3.5.2","PWR_EF","MECH"],
["C.3.5.3","PWR_EF","MECH"],
["C.3.5.4","PWR_EF","MECH"],
["C.3.5.5","PWR_EF","MECH"],
["C.4.1.1","PWR_EF","MECH"],
["C.4.1.2","PWR_EF","MECH"],
["C.4.1.3","PWR_EF","MECH"],
["C.4.1.4","PWR_EF","MECH"],
["C.4.1.5","PWR_EF","MECH"],
["C.4.1.6","PWR_EF","MECH"],
["C.4.2.1","PWR_EF","MECH"],
["C.4.2.2","PWR_EF","MECH"],
["C.4.2.3","PWR_EF","MECH"],
["C.5.1.1","PWR_EF","MECH"],
["C.5.1.2","PWR_EF","MECH"],
["C.5.1.3","PWR_EF","MECH"],
["C.5.1.4","PWR_EF","MECH"],
["C.5.1.5","PWR_EF","MECH"],
["C.5.2.1","PWR_EF","MECH"],
["C.5.2.2","PWR_EF","MECH"],
["C.5.2.3","PWR_EF","MECH"],
["C.6.1.1","PWR_EF","MECH"],
["C.6.1.2","PWR_EF","MECH"],
["C.6.1.3","PWR_EF","MECH"],
["C.6.1.4","PWR_EF","MECH"],
["C.6.1.5","PWR_EF","MECH"],
["C.6.1.6","PWR_EF","MECH"],
["C.6.1.7","PWR_EF","MECH"],
["C.6.2.1","PWR_EF","MECH"],
["C.7.1.1","PWR_EF","MECH"],
["C.7.1.2","PWR_EF","MECH"],
["C.7.1.3","PWR_EF","MECH"],
["C.7.1.4","PWR_EF","MECH"],
["C.7.1.5","PWR_EF","MECH"],
["C.7.2.1","PWR_EF","MECH"],
["C.7.2.2","PWR_EF","MECH"],
["C.7.2.3","PWR_EF","MECH"],
["C.7.2.4","PWR_EF","MECH"],
["C.7.3.1","PWR_EF","MECH"],
["C.7.3.2","PWR_EF","MECH"],
["C.7.3.3","PWR_EF","MECH"],
["C.7.3.4","PWR_EF","MECH"],
["C.8.1.1","PWR_EF","MECH"],
["C.8.1.2","PWR_EF","MECH"],
["C.8.1.3","PWR_EF","MECH"],
["C.8.1.4","PWR_EF","MECH"],
["C.8.2.1","PWR_EF","MECH"],
["C.8.3.1","PWR_EF","MECH"],
["C.8.3.10","PWR_EF","MECH"],
["C.8.3.2","PWR_EF","MECH"],
["C.8.3.3","PWR_EF","MECH"],
["C.8.3.4","PWR_EF","MECH"],
["C.8.3.5","PWR_EF","MECH"],
["C.8.3.6","PWR_EF","MECH"],
["C.8.3.7","PWR_EF","MECH"],
["C.8.3.8","PWR_EF","MECH"],
["C.8.3.9","PWR_EF","MECH"],
["C.8.4.1","PWR_EF","MECH"],
["C.8.4.2","PWR_EF","MECH"],
["C.8.5.1","PWR_EF","MECH"],
["C.8.5.2","PWR_EF","MECH"],
["C.8.5.3","PWR_EF","MECH"],
["C.8.5.4","PWR_EF","MECH"],
["C.8.5.5","PWR_EF","MECH"],
["C.8.5.6","PWR_EF","MECH"],
["C.8.6.1","PWR_EF","MECH"],
["E.1.1.1","SCRUT",null],
["E.1.1.2","SCRUT",null],
["E.1.1.3","SCRUT",null],
["E.1.1.4","SCRUT",null],
["E.1.1.5","SCRUT",null],
["E.1.1.6","SCRUT",null],
["E.1.1.7","SCRUT",null],
["E.1.1.8","SCRUT",null],
["E.1.1.9","SCRUT",null],
["E.1.2.1","SCRUT",null],
["E.1.2.2","SCRUT",null],
["E.1.2.3","SCRUT",null],
["E.1.2.4","SCRUT",null],
["E.1.3.1","SCRUT",null],
["E.1.3.2","SCRUT",null],
["E.1.3.3","SCRUT",null],
["E.1.3.4","SCRUT",null],
["E.2.1.1","SCRUT",null],
["E.2.1.2","SCRUT",null],
["E.2.1.3","SCRUT",null],
["E.2.1.4","SCRUT",null],
["E.2.1.5","SCRUT",null],
["E.2.1.6","SCRUT",null],
["E.2.1.7","SCRUT",null],
["E.2.1.8","SCRUT",null],
["E.2.1.9","SCRUT",null],
["E.3.1.1","SCRUT",null],
["E.3.1.2","SCRUT",null],
["E.3.1.3","SCRUT",null],
["E.3.2.1","SCRUT",null],
["E.3.2.2","SCRUT",null],
["E.3.2.3","SCRUT",null],
["E.3.2.4","SCRUT",null],
["E.3.2.5","SCRUT",null],
["E.3.2.6","SCRUT",null],
["E.3.3.1","SCRUT",null],
["E.3.4.1","SCRUT",null],
["E.3.4.2","SCRUT",null],
["E.3.4.3","SCRUT",null],
["E.3.4.4","SCRUT",null],
["E.3.5.1","SCRUT",null],
["E.3.5.2","SCRUT",null],
["E.3.5.3","SCRUT",null],
["E.3.6.1","SCRUT",null],
["E.3.6.2","SCRUT",null],
["E.3.6.3","SCRUT",null],
["E.3.7.1","SCRUT",null],
["E.4.1.1","SCRUT",null],
["E.4.1.2","SCRUT",null],
["E.4.2.1","SCRUT",null],
["E.4.2.10","SCRUT",null],
["E.4.2.2","SCRUT",null],
["E.4.2.3","SCRUT",null],
["E.4.2.4","SCRUT",null],
["E.4.2.5","SCRUT",null],
["E.4.2.6","SCRUT",null],
["E.4.2.7","SCRUT",null],
["E.4.2.8","SCRUT",null],
["E.4.2.9","SCRUT",null],
["E.5.1.1","SCRUT",null],
["E.5.1.2","SCRUT",null],
["E.5.2.1","SCRUT",null],
["E.5.2.2","SCRUT",null],
["E.5.2.3","SCRUT",null],
["E.5.2.4","SCRUT",null],
["E.5.2.5","SCRUT",null],
["E.5.3.1","SCRUT",null],
["E.5.3.2","SCRUT",null],
["E.5.3.3","SCRUT",null],
["E.5.3.4","SCRUT",null],
["E.5.3.6","SCRUT",null],
["E.5.3.7","SCRUT",null],
["E.5.3.8","SCRUT",null],
["E.5.4.1","SCRUT",null],
["E.5.4.2","SCRUT",null],
["E.5.4.3","SCRUT",null],
["E.5.4.4","SCRUT",null],
["E.5.4.5","SCRUT",null],
["E.5.4.5#2","SCRUT",null],
["E.5.4.6","SCRUT",null],
["E.5.4.7","SCRUT",null],
["E.6.1.1","SCRUT",null],
["E.6.1.2","SCRUT",null],
["E.6.1.3","SCRUT",null],
["E.6.1.4","SCRUT",null],
["E.6.2.1","SCRUT",null],
["E.6.2.2","SCRUT",null],
["E.6.2.3","SCRUT",null],
["E.6.3.1","SCRUT",null],
["E.6.4.1","SCRUT",null],
["E.7.1.1","SCRUT",null],
["E.7.1.2","SCRUT",null],
["E.7.1.3","SCRUT",null],
["E.7.1.4","SCRUT",null],
["E.7.1.5","SCRUT",null],
["E.7.1.6","SCRUT",null],
["E.7.2.1","SCRUT",null],
["E.7.2.2","SCRUT",null],
["E.7.2.3","SCRUT",null],
["E.7.2.4","SCRUT",null],
["E.7.2.5","SCRUT",null],
["E.7.2.6","SCRUT",null],
["E.8.1.1","SCRUT",null],
["E.8.1.2","SCRUT",null],
["E.8.1.3","SCRUT",null],
["E.8.1.4","SCRUT",null],
["E.9.1.1","SCRUT",null],
["E.9.1.2","SCRUT",null],
["E.9.1.3","SCRUT",null],
["E.9.2.1","SCRUT",null],
["E.9.2.2","SCRUT",null],
["E.9.3.1","SCRUT",null],
["E.9.3.2","SCRUT",null],
["E.9.4.1","SCRUT",null],
["E.9.4.2","SCRUT",null],
["F.1.1.1","DOCS","OPS"],
["F.1.2.1","DOCS","OPS"],
["F.1.2.2","DOCS","OPS"],
["F.1.2.3","DOCS","OPS"],
["F.1.2.4","DOCS","OPS"],
["F.1.2.5","DOCS","OPS"],
["F.1.3.1","DOCS","OPS"],
["F.1.3.2","DOCS","OPS"],
["F.1.3.3","DOCS","OPS"],
["F.10.1.1","DOCS",null],
["F.10.1.2","DOCS",null],
["F.10.1.3","DOCS",null],
["F.10.1.4","DOCS",null],
["F.10.2.1","DOCS",null],
["F.10.2.2","DOCS",null],
["F.10.2.3","DOCS",null],
["F.10.2.4","DOCS",null],
["F.11.1.1","DOCS","OPS"],
["F.11.1.2","DOCS","OPS"],
["F.11.1.3","DOCS","OPS"],
["F.11.1.4","DOCS","OPS"],
["F.12.1.1","DOCS","MECH"],
["F.12.1.2","DOCS","MECH"],
["F.12.1.3","DOCS","MECH"],
["F.12.1.4","DOCS","MECH"],
["F.12.1.5","DOCS","MECH"],
["F.12.1.6","DOCS","MECH"],
["F.12.1.7","DOCS","MECH"],
["F.12.1.8","DOCS","MECH"],
["F.12.2.1","DOCS","MECH"],
["F.12.2.10","DOCS","MECH"],
["F.12.2.11","DOCS","MECH"],
["F.12.2.2","DOCS","MECH"],
["F.12.2.3","DOCS","MECH"],
["F.12.2.4","DOCS","MECH"],
["F.12.2.5","DOCS","MECH"],
["F.12.2.6","DOCS","MECH"],
["F.12.2.7","DOCS","MECH"],
["F.12.2.8","DOCS","MECH"],
["F.12.2.9","DOCS","MECH"],
["F.12.3.1","DOCS","MECH"],
["F.12.3.2","DOCS","MECH"],
["F.12.3.3","DOCS","MECH"],
["F.12.3.4","DOCS","MECH"],
["F.12.3.5","DOCS","MECH"],
["F.12.3.6","DOCS","MECH"],
["F.12.3.7","DOCS","MECH"],
["F.12.3.8","DOCS","MECH"],
["F.12.4.1","DOCS","MECH"],
["F.12.4.2","DOCS","MECH"],
["F.12.4.3","DOCS","MECH"],
["F.12.4.4","DOCS","MECH"],
["F.12.4.5","DOCS","MECH"],
["F.12.4.6","DOCS","MECH"],
["F.12.5.1","DOCS","MECH"],
["F.12.5.2","DOCS","MECH"],
["F.12.5.3","DOCS","MECH"],
["F.12.5.4","DOCS","MECH"],
["F.12.6.1","DOCS","MECH"],
["F.12.6.2","DOCS","MECH"],
["F.12.6.3","DOCS","MECH"],
["F.12.6.4","DOCS","MECH"],
["F.12.7.1","DOCS","MECH"],
["F.12.7.2","DOCS","MECH"],
["F.12.8.1","DOCS","MECH"],
["F.12.8.2","DOCS","MECH"],
["F.12.8.3","DOCS","MECH"],
["F.12.9.1","DOCS","MECH"],
["F.12.9.2","DOCS","MECH"],
["F.13.1.1","DOCS",null],
["F.13.2.1","DOCS",null],
["F.13.2.2","DOCS",null],
["F.13.2.3","DOCS",null],
["F.13.2.4","DOCS",null],
["F.13.2.5","DOCS",null],
["F.13.2.6","DOCS",null],
["F.13.3.1","DOCS",null],
["F.13.3.2","DOCS",null],
["F.13.3.3","DOCS",null],
["F.13.3.4","DOCS",null],
["F.13.3.5","DOCS",null],
["F.13.4.1","DOCS",null],
["F.13.4.2","DOCS",null],
["F.13.4.3","DOCS",null],
["F.13.5.1","DOCS",null],
["F.13.5.2","DOCS",null],
["F.13.6.1","DOCS",null],
["F.13.6.2","DOCS",null],
["F.13.6.3","DOCS",null],
["F.13.6.4","DOCS",null],
["F.14.1.1","DOCS","OPS"],
["F.14.1.2","DOCS","OPS"],
["F.14.1.3","DOCS","OPS"],
["F.14.1.4","DOCS","OPS"],
["F.14.1.5","DOCS","OPS"],
["F.14.1.6","DOCS","OPS"],
["F.14.1.7","DOCS","OPS"],
["F.14.1.8","DOCS","OPS"],
["F.14.2.1","DOCS","OPS"],
["F.14.2.2","DOCS","OPS"],
["F.14.2.3","DOCS","OPS"],
["F.14.2.4","DOCS","OPS"],
["F.14.2.5","DOCS","OPS"],
["F.14.2.6","DOCS","OPS"],
["F.14.3.1","DOCS","OPS"],
["F.14.3.2","DOCS","OPS"],
["F.14.3.3","DOCS","OPS"],
["F.14.3.4","DOCS","OPS"],
["F.14.3.5","DOCS","OPS"],
["F.14.4.1","DOCS","OPS"],
["F.14.4.2","DOCS","OPS"],
["F.14.4.3","DOCS","OPS"],
["F.14.4.4","DOCS","OPS"],
["F.2.1.1","DOCS","OPS"],
["F.2.1.2","DOCS","OPS"],
["F.2.2.1","DOCS","OPS"],
["F.3.1.1","DOCS","OPS"],
["F.3.1.2","DOCS","OPS"],
["F.3.1.3","DOCS","OPS"],
["F.3.1.4","DOCS","OPS"],
["F.3.1.5","DOCS","OPS"],
["F.3.1.6","DOCS","OPS"],
["F.3.2.1","DOCS","OPS"],
["F.3.2.2","DOCS","OPS"],
["F.3.2.3","DOCS","OPS"],
["F.3.2.4","DOCS","OPS"],
["F.3.3.1","DOCS","OPS"],
["F.3.3.2","DOCS","OPS"],
["F.3.3.3","DOCS","OPS"],
["F.3.3.4","DOCS","OPS"],
["F.3.3.5","DOCS","OPS"],
["F.3.4.1","DOCS","OPS"],
["F.3.4.2","DOCS","OPS"],
["F.3.4.3","DOCS","OPS"],
["F.3.4.4","DOCS","OPS"],
["F.3.5.1","DOCS","OPS"],
["F.3.5.2","DOCS","OPS"],
["F.3.5.3","DOCS","OPS"],
["F.3.5.4","DOCS","OPS"],
["F.3.5.5","DOCS","OPS"],
["F.3.5.6","DOCS","OPS"],
["F.4.1.1","DOCS","MECH"],
["F.4.1.2","DOCS","MECH"],
["F.4.1.3","DOCS","MECH"],
["F.4.1.4","DOCS","MECH"],
["F.4.2.1","DOCS","MECH"],
["F.4.2.2","DOCS","MECH"],
["F.4.2.3","DOCS","MECH"],
["F.4.2.4","DOCS","MECH"],
["F.4.2.5","DOCS","MECH"],
["F.4.2.6","DOCS","MECH"],
["F.4.3.1","DOCS","MECH"],
["F.4.3.2","DOCS","MECH"],
["F.4.3.3","DOCS","MECH"],
["F.4.3.4","DOCS","MECH"],
["F.4.4.1","DOCS","MECH"],
["F.4.4.2","DOCS","MECH"],
["F.4.4.3","DOCS","MECH"],
["F.4.5.1","DOCS","MECH"],
["F.4.5.2","DOCS","MECH"],
["F.4.5.3","DOCS","MECH"],
["F.4.5.4","DOCS","MECH"],
["F.4.5.5","DOCS","MECH"],
["F.4.5.6","DOCS","MECH"],
["F.4.6.1","DOCS","MECH"],
["F.4.6.2","DOCS","MECH"],
["F.4.6.3","DOCS","MECH"],
["F.4.6.4","DOCS","MECH"],
["F.4.6.5","DOCS","MECH"],
["F.4.6.6","DOCS","MECH"],
["F.4.7.1","DOCS","MECH"],
["F.4.7.2","DOCS","MECH"],
["F.4.7.3","DOCS","MECH"],
["F.4.7.4","DOCS","MECH"],
["F.4.8.1","DOCS","MECH"],
["F.4.8.2","DOCS","MECH"],
["F.4.8.3","DOCS","MECH"],
["F.4.8.4","DOCS","MECH"],
["F.4.8.5","DOCS","MECH"],
["F.4.8.6","DOCS","MECH"],
["F.4.9.1","DOCS","MECH"],
["F.4.9.2","DOCS","MECH"],
["F.4.9.3","DOCS","MECH"],
["F.4.9.4","DOCS","MECH"],
["F.4.9.5","DOCS","MECH"],
["F.4.9.6","DOCS","MECH"],
["F.5.1.1","DOCS",null],
["F.5.1.2","DOCS",null],
["F.5.1.3","DOCS",null],
["F.5.1.4","DOCS",null],
["F.5.1.5","DOCS",null],
["F.5.1.6","DOCS",null],
["F.5.1.7","DOCS",null],
["F.5.1.8","DOCS",null],
["F.5.2.1","DOCS",null],
["F.5.2.3","DOCS",null],
["F.5.2.3#2","DOCS",null],
["F.5.2.4","DOCS",null],
["F.5.2.5","DOCS",null],
["F.5.3.1","DOCS",null],
["F.5.3.2","DOCS",null],
["F.5.4.1","DOCS",null],
["F.5.4.2","DOCS",null],
["F.5.4.3","DOCS",null],
["F.5.4.4","DOCS",null],
["F.5.5.1","DOCS",null],
["F.5.5.2","DOCS",null],
["F.5.5.3","DOCS",null],
["F.5.6.1","DOCS",null],
["F.5.6.2","DOCS",null],
["F.5.6.3","DOCS",null],
["F.5.7.1","DOCS",null],
["F.5.7.2","DOCS",null],
["F.5.7.3","DOCS",null],
["F.5.7.4","DOCS",null],
["F.5.8.1","DOCS",null],
["F.5.8.2","DOCS",null],
["F.5.8.3","DOCS",null],
["F.5.8.5","DOCS",null],
["F.5.9.1","DOCS",null],
["F.5.9.2","DOCS",null],
["F.5.9.3","DOCS",null],
["F.5.9.4","DOCS",null],
["F.6.1.1","DOCS","MECH"],
["F.6.1.2","DOCS","MECH"],
["F.6.1.3","DOCS","MECH"],
["F.6.1.4","DOCS","MECH"],
["F.6.2.1","DOCS","MECH"],
["F.6.2.2","DOCS","MECH"],
["F.6.2.3","DOCS","MECH"],
["F.6.2.4","DOCS","MECH"],
["F.6.2.5","DOCS","MECH"],
["F.6.2.6","DOCS","MECH"],
["F.6.3.1","DOCS","MECH"],
["F.6.3.2","DOCS","MECH"],
["F.6.3.3","DOCS","MECH"],
["F.6.3.4","DOCS","MECH"],
["F.6.3.5","DOCS","MECH"],
["F.6.4.1","DOCS","MECH"],
["F.6.4.2","DOCS","MECH"],
["F.6.4.3","DOCS","MECH"],
["F.6.5.1","DOCS","MECH"],
["F.6.5.2","DOCS","MECH"],
["F.6.5.3","DOCS","MECH"],
["F.6.5.4","DOCS","MECH"],
["F.6.5.5","DOCS","MECH"],
["F.6.5.6","DOCS","MECH"],
["F.6.5.7","DOCS","MECH"],
["F.6.5.8","DOCS","MECH"],
["F.6.6.1","DOCS","MECH"],
["F.6.6.2","DOCS","MECH"],
["F.6.6.3","DOCS","MECH"],
["F.6.6.4","DOCS","MECH"],
["F.6.6.5","DOCS","MECH"],
["F.7.1.1","DOCS","OPS"],
["F.7.1.2","DOCS","OPS"],
["F.7.1.3","DOCS","OPS"],
["F.7.1.4","DOCS","OPS"],
["F.7.1.5","DOCS","OPS"],
["F.7.1.6","DOCS","OPS"],
["F.7.1.7","DOCS","OPS"],
["F.7.2.1","DOCS","OPS"],
["F.7.2.2","DOCS","OPS"],
["F.7.2.3","DOCS","OPS"],
["F.7.2.4","DOCS","OPS"],
["F.7.2.5","DOCS","OPS"],
["F.7.3.1","DOCS","OPS"],
["F.7.3.2","DOCS","OPS"],
["F.7.3.3","DOCS","OPS"],
["F.7.3.4","DOCS","OPS"],
["F.7.3.5","DOCS","OPS"],
["F.7.3.6","DOCS","OPS"],
["F.7.3.7","DOCS","OPS"],
["F.7.4.1","DOCS","OPS"],
["F.7.4.2","DOCS","OPS"],
["F.7.4.3","DOCS","OPS"],
["F.7.4.4","DOCS","OPS"],
["F.7.4.5","DOCS","OPS"],
["F.7.5.1","DOCS","OPS"],
["F.7.5.2","DOCS","OPS"],
["F.7.5.3","DOCS","OPS"],
["F.7.5.4","DOCS","OPS"],
["F.7.5.5","DOCS","OPS"],
["F.7.5.6","DOCS","OPS"],
["F.7.5.7","DOCS","OPS"],
["F.7.5.8","DOCS","OPS"],
["F.7.5.9","DOCS","OPS"],
["F.7.6.1","DOCS","OPS"],
["F.7.6.2","DOCS","OPS"],
["F.7.6.3","DOCS","OPS"],
["F.7.6.4","DOCS","OPS"],
["F.7.7.1","DOCS","OPS"],
["F.7.7.2","DOCS","OPS"],
["F.7.7.3","DOCS","OPS"],
["F.7.7.4","DOCS","OPS"],
["F.7.7.5","DOCS","OPS"],
["F.7.8.1","DOCS","OPS"],
["F.7.8.2","DOCS","OPS"],
["F.7.8.3","DOCS","OPS"],
["F.7.8.4","DOCS","OPS"],
["F.7.8.5","DOCS","OPS"],
["F.7.8.6","DOCS","OPS"],
["F.7.9.1","DOCS","OPS"],
["F.7.9.2","DOCS","OPS"],
["F.7.9.3","DOCS","OPS"],
["F.7.9.4","DOCS","OPS"],
["F.7.9.5","DOCS","OPS"],
["F.8.1.1","DOCS","OPS"],
["F.8.1.2","DOCS","OPS"],
["F.8.1.3","DOCS","OPS"],
["F.8.1.4","DOCS","OPS"],
["F.8.1.5","DOCS","OPS"],
["F.8.1.6","DOCS","OPS"],
["F.8.1.7","DOCS","OPS"],
["F.8.2.1","DOCS","OPS"],
["F.8.2.10","DOCS","OPS"],
["F.8.2.11","DOCS","OPS"],
["F.8.2.12","DOCS","OPS"],
["F.8.2.2","DOCS","OPS"],
["F.8.2.3","DOCS","OPS"],
["F.8.2.4","DOCS","OPS"],
["F.8.2.5","DOCS","OPS"],
["F.8.2.6","DOCS","OPS"],
["F.8.2.7","DOCS","OPS"],
["F.8.2.8","DOCS","OPS"],
["F.8.2.9","DOCS","OPS"],
["F.8.3.1","DOCS","OPS"],
["F.8.3.2","DOCS","OPS"],
["F.8.3.3","DOCS","OPS"],
["F.8.3.4","DOCS","OPS"],
["F.8.3.5","DOCS","OPS"],
["F.9.1.1","DOCS","OPS"],
["F.9.1.2","DOCS","OPS"],
["F.9.1.3","DOCS","OPS"],
["F.9.1.4","DOCS","OPS"],
["F.9.1.5","DOCS","OPS"],
["F.9.1.6","DOCS","OPS"],
["F.9.2.1","DOCS","OPS"],
["F.9.2.2","DOCS","OPS"],
["F.9.2.3","DOCS","OPS"],
["F.9.2.4","DOCS","OPS"],
["F.9.2.5","DOCS","OPS"],
["F.9.3.1","DOCS","OPS"],
["F.9.3.2","DOCS","OPS"],
["F.9.3.3","DOCS","OPS"],
["F.9.4.1","DOCS","OPS"],
["F.9.4.2","DOCS","OPS"],
["F.9.4.3","DOCS","OPS"],
["F.9.5.1","DOCS","OPS"],
["F.9.5.2","DOCS","OPS"],
["F.9.5.3","DOCS","OPS"],
["F.9.5.4","DOCS","OPS"],
["F.9.5.5","DOCS","OPS"],
["G.1.1.1","RACEOP",null],
["G.1.2.1","RACEOP",null],
["G.1.2.2","RACEOP",null],
["G.1.3.1","RACEOP",null],
["G.2.1.1","RACEOP",null],
["G.2.2.1","RACEOP",null],
["G.2.2.2","RACEOP",null],
["G.2.2.3","RACEOP",null],
["G.2.2.4","RACEOP",null],
["G.2.2.5","RACEOP",null],
["G.2.2.6","RACEOP",null],
["G.2.2.7","RACEOP",null],
["G.2.2.8","RACEOP",null],
["G.2.3.1","RACEOP",null],
["G.2.3.2","RACEOP",null],
["G.2.3.3","RACEOP",null],
["G.2.4.1","RACEOP",null],
["G.2.4.2","RACEOP",null],
["G.2.4.3","RACEOP",null],
["G.2.4.4","RACEOP",null],
["G.2.4.5","RACEOP",null],
["G.2.5.1","RACEOP",null],
["G.2.5.2","RACEOP",null],
["G.2.5.3","RACEOP",null],
["G.2.5.4","RACEOP",null],
["G.2.6.1","RACEOP",null],
["G.2.6.2","RACEOP",null],
["G.2.6.3","RACEOP",null],
["G.3.1.1","RACEOP",null],
["G.3.1.2","RACEOP",null],
["G.3.1.3","RACEOP",null],
["G.3.1.4","RACEOP",null],
["G.3.1.5","RACEOP",null],
["G.3.1.6","RACEOP",null],
["G.3.2.1","RACEOP",null],
["G.3.3.1","RACEOP",null],
["G.3.3.2","RACEOP",null],
["G.3.3.3","RACEOP",null],
["G.3.3.4","RACEOP",null],
["G.3.4.1","RACEOP",null],
["G.3.4.10","RACEOP",null],
["G.3.4.11","RACEOP",null],
["G.3.4.12","RACEOP",null],
["G.3.4.2","RACEOP",null],
["G.3.4.3","RACEOP",null],
["G.3.4.4","RACEOP",null],
["G.3.4.5","RACEOP",null],
["G.3.4.6","RACEOP",null],
["G.3.4.7","RACEOP",null],
["G.3.4.8","RACEOP",null],
["G.3.4.9","RACEOP",null],
["G.3.5.1","RACEOP",null],
["G.3.5.2","RACEOP",null],
["G.3.6.1","RACEOP",null],
["G.4.1.1","RACEOP",null],
["G.4.2.1","RACEOP",null],
["G.4.2.2","RACEOP",null],
["G.4.2.3","RACEOP",null],
["G.4.2.4","RACEOP",null],
["G.4.2.5","RACEOP",null],
["G.4.3.1","RACEOP",null],
["G.4.3.2","RACEOP",null],
["G.4.3.3","RACEOP",null],
["G.4.4.1","RACEOP",null],
["G.4.4.2","RACEOP",null],
["G.4.5.1","RACEOP",null],
["G.4.5.2","RACEOP",null],
["G.4.5.3","RACEOP",null],
["G.4.5.4","RACEOP",null],
["G.4.6.1","RACEOP",null],
["G.4.6.2","RACEOP",null],
["G.4.6.3","RACEOP",null],
["G.4.6.4","RACEOP",null],
["G.4.7.1","RACEOP",null],
["G.4.7.2","RACEOP",null],
["G.4.7.3","RACEOP",null],
["G.4.7.4","RACEOP",null],
["G.5.1.1","RACEOP",null],
["G.5.1.2","RACEOP",null],
["G.5.1.3","RACEOP",null],
["G.5.2.1","RACEOP",null],
["G.5.2.2","RACEOP",null],
["G.5.2.3","RACEOP",null],
["G.5.3.1","RACEOP",null],
["G.5.3.2","RACEOP",null],
["G.5.3.3","RACEOP",null],
["G.6.1.1","RACEOP",null],
["G.6.1.2","RACEOP",null],
["G.6.1.3","RACEOP",null],
["G.6.2.1","RACEOP",null],
["G.6.2.2","RACEOP",null],
["G.6.2.3","RACEOP",null],
["G.6.2.4","RACEOP",null],
["G.6.2.5","RACEOP",null],
["G.6.2.6","RACEOP",null],
["G.6.3.1","RACEOP",null],
["G.6.3.2","RACEOP",null],
["G.6.3.3","RACEOP",null],
["G.6.3.4","RACEOP",null],
["G.6.3.5","RACEOP",null],
["G.6.3.6","RACEOP",null],
["G.6.4.1","RACEOP",null],
["G.6.4.2","RACEOP",null],
["G.6.4.3","RACEOP",null],
["G.6.4.4","RACEOP",null],
["G.6.4.5","RACEOP",null],
["G.6.4.6","RACEOP",null],
["G.6.4.7","RACEOP",null],
["G.6.5.1","RACEOP",null],
["G.6.5.2","RACEOP",null],
["G.6.5.3","RACEOP",null],
["G.6.5.4","RACEOP",null],
["G.7.1.1","RACEOP",null],
["G.7.2.1","RACEOP",null],
["G.7.3.1","RACEOP",null],
["G.7.4.1","RACEOP",null],
["G.8.1.1","RACEOP",null],
["G.8.2.1","RACEOP",null],
["G.8.2.2","RACEOP",null],
["G.9.1.1","RACEOP",null],
["G.9.1.2","RACEOP",null],
["G.9.2.1","RACEOP",null],
["G.9.2.2","RACEOP",null],
["G.9.2.3","RACEOP",null],
["G.9.2.4","RACEOP",null],
["G.9.3.1","RACEOP",null],
["G.9.3.2","RACEOP",null],
["G.9.3.3","RACEOP",null],
["G.9.3.4","RACEOP",null],
["G.9.3.5","RACEOP",null],
["G.9.3.6","RACEOP",null],
["G.9.3.7","RACEOP",null],
["G.9.4.1","RACEOP",null],
["G.9.4.2","RACEOP",null],
["G.9.4.3","RACEOP",null],
["G.9.4.4","RACEOP",null],
["G.9.4.5","RACEOP",null],
["H.1.1.1","RACEOP",null],
["H.1.1.2","RACEOP",null],
["H.1.1.3","RACEOP",null],
["H.1.1.4","RACEOP",null],
["H.2.1.1","RACEOP",null],
["H.2.1.10","RACEOP",null],
["H.2.1.11","RACEOP",null],
["H.2.1.12","RACEOP",null],
["H.2.1.13","RACEOP",null],
["H.2.1.14","RACEOP",null],
["H.2.1.15","RACEOP",null],
["H.2.1.16","RACEOP",null],
["H.2.1.17","RACEOP",null],
["H.2.1.18","RACEOP",null],
["H.2.1.19","RACEOP",null],
["H.2.1.2","RACEOP",null],
["H.2.1.20","RACEOP",null],
["H.2.1.3","RACEOP",null],
["H.2.1.4","RACEOP",null],
["H.2.1.5","RACEOP",null],
["H.2.1.6","RACEOP",null],
["H.2.1.7","RACEOP",null],
["H.2.1.8","RACEOP",null],
["H.2.1.9","RACEOP",null],
["H.2.2.1","RACEOP",null],
["H.2.2.2","RACEOP",null],
["H.2.2.3","RACEOP",null],
["H.3.1.1","RACEOP",null],
["H.3.1.2","RACEOP",null],
["H.3.1.3","RACEOP",null],
["H.4.1.1","RACEOP",null],
["H.4.1.2","RACEOP",null],
["H.4.2.1","RACEOP",null],
["H.4.2.2","RACEOP",null],
["H.4.2.3","RACEOP",null],
["H.4.2.4","RACEOP",null],
["H.4.3.1","RACEOP",null],
["H.4.3.2","RACEOP",null],
["H.4.3.3","RACEOP",null],
["H.5.1.1","RACEOP",null],
["H.5.1.2","RACEOP",null],
["H.5.2.1","RACEOP",null],
["H.5.2.2","RACEOP",null],
["H.5.3.1","RACEOP",null],
["H.5.3.2","RACEOP",null],
["H.5.3.3","RACEOP",null],
["H.5.3.4","RACEOP",null],
["H.5.3.5","RACEOP",null],
["H.6.1.1","RACEOP",null],
["H.6.1.2","RACEOP",null],
["H.6.2.1","RACEOP",null],
["H.6.2.2","RACEOP",null],
["H.6.2.3","RACEOP",null],
["H.6.2.4","RACEOP",null],
["H.6.3.1","RACEOP",null],
["H.6.3.2","RACEOP",null],
["H.6.3.3","RACEOP",null],
["H.6.3.4","RACEOP",null]
]$json$, '7842c3e3b65262f48c8bc257185d54af')
-- </generated:clause-owners>
  );
  raise notice 'five-department reconciliation: %', v_result;
end
$do$;
