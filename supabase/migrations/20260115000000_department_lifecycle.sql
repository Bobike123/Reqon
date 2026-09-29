-- =============================================================================
--  Departments: archive lifecycle, scoped Head authority, the 10-active cap,
--  and reconciliation of the 14 seeded subteams.
--
--  Reqon redesign Phase 1 (docs/redesign/adr/0001-departments-are-subteams.md,
--  0002-department-reconciliation.md, 0003-permission-model.md §"SQL helpers").
--
--  WHAT WAS WRONG (docs/redesign/BASELINE.md V1-V5):
--    * subteams has no archive concept: admin_write FOR ALL let a VP DELETE a
--      subteam outright, cascading its handover notes and un-classifying its
--      clauses (PROBE P7).
--    * book_section is NOT NULL, so a work division with no rulebook section
--      could not be created.
--    * lead_id ("Head of Department") could be set to anyone, including
--      alumni or a nonexistent id, with no check.
--    * There is no cap on how many departments exist, and the seed already
--      has 14 (BASELINE V1), 4 over the 10-active limit this migration
--      introduces.
--
--  AFTER:
--    * archived_at/archived_by/archive_reason replace physical deletion.
--      is_parked keeps its own, independent, competition meaning.
--    * book_section becomes nullable.
--    * A trigger refuses a lead_id that is not an active member.
--    * A trigger refuses archiving a department that still has active tasks
--      (the proposal half of this check is added in Phase 3, once
--      task_proposals gains a department column — see the comment on
--      guard_department_archive() below).
--    * A trigger, serialized by a session advisory lock, refuses creating or
--      restoring a department past 10 active — enforced for EVERY writer,
--      not only a client-side count or an RPC happy path.
--    * reconciliation_preflight()/reconciliation_apply() give the 14-to-10
--      cutover a reviewed, reversible, auditable path (ADR-0002). No key is
--      archived automatically; the manifest is supplied by the caller.
--    * subteams joins the realtime publication, so a Head/archive change
--      reaches every open client without a reload.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Department archive lifecycle, scoped Head authority
--                   helpers, the 10-active cap, and department reconciliation.
--    Existing data  All 14 seeded subteams keep their key/name/book_section/
--                   lead_id/is_parked/sort_order unchanged; they simply gain
--                   archived_at/archived_by/archive_reason = NULL, which is
--                   not over the cap by itself (the cap trigger only fires on
--                   INSERT or on archived_at going from non-null to null, so
--                   existing rows are never rewritten or rejected by it).
--                   handover_notes keeps every existing row; only its FK
--                   changes from CASCADE to RESTRICT going forward.
--    Authorization  can_manage_departments(): president, vicepresident or
--                   developer (mirrors is_admin()'s membership today, but
--                   kept as its own function per ADR-0001 so department
--                   authority does not silently follow future changes to
--                   is_admin()'s unrelated duties, and vice versa).
--                   reconciliation_preflight/apply and reorder_departments
--                   are SECURITY DEFINER, search_path pinned, EXECUTE revoked
--                   from public/anon, granted to authenticated only. The
--                   boolean helpers (is_active_member, is_department_head,
--                   can_manage_departments, is_developer) follow the existing
--                   is_member()/is_admin() convention of default PUBLIC
--                   EXECUTE — they read nothing sensitive and already return
--                   false for anon.
--    Locking        ADD COLUMN (nullable, no default computation) and DROP
--                   NOT NULL are metadata-only in PG11+: no table rewrite, a
--                   brief ACCESS EXCLUSIVE lock. CREATE TRIGGER takes a SHARE
--                   ROW EXCLUSIVE lock on subteams. The cap trigger takes a
--                   session advisory lock (pg_advisory_xact_lock) for the
--                   duration of the caller's transaction, not a table lock,
--                   so reads are never blocked by a pending create/restore.
--    Rollback       DROP TRIGGER/FUNCTION for each object; DROP COLUMN
--                   archived_at/archived_by/archive_reason (data loss for
--                   any real archive/restore already recorded); re-add
--                   book_section NOT NULL only if every row still has a
--                   value; revert handover_notes' FK to CASCADE. The RLS
--                   policy split (below) would need admin_write recreated.
--    Deploy order   Apply before deploying a frontend that calls
--                   reconciliation_preflight/apply, reorder_departments, or
--                   presents archived departments — this migration alone
--                   does not change what the CURRENT frontend does, since
--                   useUpdateSubteam() only ever sends name/description/
--                   lead_id, all still accepted.
-- =============================================================================

-- --------------------------------------------------------- 1. archive columns
alter table subteams add column if not exists archived_at   timestamptz null;
alter table subteams add column if not exists archived_by   uuid null references members(id) on delete set null;
alter table subteams add column if not exists archive_reason text null;
create index if not exists subteams_archived on subteams (archived_at);

comment on column subteams.archived_at is
  'NULL = active department, counted toward the 10-active cap. Set only by '
  'reconciliation_apply() or a manual archive command, never a generic edit.';
comment on column subteams.is_parked is
  'Competition meaning only ("these rules only bite at the Final Event") — '
  'independent of archived_at. A parked department still counts as active.';

-- A work department need not invent a rulebook section (§1 of the source
-- prompt). Existing rows keep their values; only the constraint relaxes.
alter table subteams alter column book_section drop not null;

-- --------------------------------------------------- 2. handover notes: RESTRICT
-- Deleting a department must never silently take its handover notes with it
-- (BASELINE V4). Departments are not deleted at all any more (see §5 below),
-- but the FK is tightened regardless: RESTRICT is the honest ON DELETE for a
-- cross-aggregate reference, and it stops a future DELETE path — however
-- added — from reintroducing the cascade.
alter table handover_notes drop constraint if exists handover_notes_subteam_key_fkey;
alter table handover_notes add constraint handover_notes_subteam_key_fkey
  foreign key (subteam_key) references subteams(key) on delete restrict;

-- ----------------------------------------------------- 3. scoped-authority helpers
-- Every write requires an ACTIVE roster row. is_member() (unchanged) stays
-- the read gate, so alumni keep reading history; this is the write gate that
-- closes the "alumni can act" path the department lifecycle must not reopen.
create or replace function is_active_member() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from members m where m.id = auth.uid() and m.status = 'active');
$fn$;

-- A department Head's authority is derived at call time from lead_id and the
-- caller's CURRENT roster status — never stored or cached. A member who
-- retires loses Head authority immediately without anyone editing lead_id
-- (ADR-0003 "make head authority follow the current active roster status").
create or replace function is_department_head(p_key text) returns boolean
language sql stable security definer set search_path = public as $fn$
  select is_active_member() and exists (
    select 1 from subteams s
    where s.key = p_key and s.lead_id = auth.uid() and s.archived_at is null
  );
$fn$;

-- Department CONFIGURATION (create/rename/describe/head/reorder/archive/
-- restore): president, vice-president or developer. Deliberately its own
-- function, not a reuse of is_admin() — see the migration header.
create or replace function can_manage_departments() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('vicepresident') or has_role('developer');
$fn$;

create or replace function is_developer() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('developer');
$fn$;

-- ------------------------------------------------- 4. lead_id must be a real Head
create or replace function enforce_valid_department_head() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.lead_id is null then
    return new;
  end if;
  if not exists (select 1 from members where id = new.lead_id and status = 'active') then
    raise exception 'The Head of a department must be an active member.'
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_department_head_valid on subteams;
create trigger trg_department_head_valid
  before insert or update of lead_id on subteams
  for each row execute function enforce_valid_department_head();

-- -------------------------------------------------------- 5. the 10-active cap
-- Fires whenever a row becomes active: an INSERT of a non-archived row, or an
-- UPDATE that clears archived_at (a restore). Archiving only ever LOWERS the
-- active count, so it is intentionally not in this trigger's WHEN condition
-- family (it still fires on that UPDATE, but returns immediately below).
--
-- pg_advisory_xact_lock serializes every create/restore across CONCURRENT
-- transactions for the lifetime of the caller's transaction: a second,
-- genuinely simultaneous call blocks here until the first commits or rolls
-- back, then re-counts and sees the first's own committed (or rolled-back)
-- outcome — so two callers racing at 9 active can never both land on 10. A
-- bare `select count(*)` with no lock (or a check performed only in an RPC
-- and not in a trigger) would let exactly that race through.
create or replace function enforce_department_cap() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  other_active int;
begin
  if new.archived_at is not null then
    -- Archiving (NULL -> NOT NULL), or created/updated already archived:
    -- never increases the active count.
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('reqon_department_cap'));

  select count(*) into other_active from subteams
    where archived_at is null and key <> new.key;

  if other_active + 1 > 10 then
    raise exception 'At most 10 active departments are allowed (% already active). '
      'Archive one before adding or restoring another.', other_active
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_department_cap on subteams;
create trigger trg_department_cap
  before insert or update of archived_at on subteams
  for each row execute function enforce_department_cap();

-- ------------------------------------------------ 6. archiving must not strand work
create or replace function guard_department_archive() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  active_tasks int;
begin
  if new.archived_at is null or old.archived_at is not null then
    return new; -- not an archive transition (restore, or an ordinary edit)
  end if;

  select count(*) into active_tasks from tasks
    where subteam_key = old.key and state not in ('done', 'cancelled');
  if active_tasks > 0 then
    raise exception 'Cannot archive department "%": % task(s) still reference it. '
      'Reassign or finish them first.', old.key, active_tasks
      using errcode = '23514';
  end if;

  -- NOTE (tracked: docs/redesign/REQUIREMENTS.md R3.4/R6.5): the execution
  -- contract also asks that archiving refuse while "unresolved proposals"
  -- reference the department. task_proposals has no department column yet —
  -- it gains one in Phase 3 (ADR-0005). This function is CREATE OR REPLACE
  -- and will be extended there; it is not silently forgotten.
  return new;
end $fn$;

drop trigger if exists trg_guard_department_archive on subteams;
create trigger trg_guard_department_archive
  before update of archived_at on subteams
  for each row execute function guard_department_archive();

-- --------------------------------------------------------- 7. audit trail
-- One row per meaningfully changed dimension, mirroring log_task_lifecycle
-- and friends (20260114). Departments are global, so season_id is always
-- NULL here — never guessed at the currently-selected season.
create or replace function log_department_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if TG_OP = 'INSERT' then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), null, 'department', new.key, 'created',
      jsonb_build_object('name', new.name, 'book_section', new.book_section, 'is_parked', new.is_parked));
    return new;
  end if;

  if new.name is distinct from old.name then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), null, 'department', new.key, 'renamed',
      jsonb_build_object('from', old.name, 'to', new.name));
  end if;

  if new.lead_id is distinct from old.lead_id then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), null, 'department', new.key, 'head_changed',
      jsonb_build_object('from', old.lead_id, 'to', new.lead_id));
  end if;

  if new.sort_order is distinct from old.sort_order then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), null, 'department', new.key, 'reordered',
      jsonb_build_object('from', old.sort_order, 'to', new.sort_order));
  end if;

  if new.description is distinct from old.description then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (auth.uid(), null, 'department', new.key, 'described', '{}'::jsonb);
  end if;

  if new.archived_at is distinct from old.archived_at then
    if new.archived_at is not null then
      insert into activity (actor_id, season_id, entity, entity_id, action, detail)
      values (auth.uid(), null, 'department', new.key, 'archived',
        jsonb_build_object('reason', new.archive_reason));
    else
      insert into activity (actor_id, season_id, entity, entity_id, action, detail)
      values (auth.uid(), null, 'department', new.key, 'restored', '{}'::jsonb);
    end if;
  end if;

  return new;
end $fn$;

drop trigger if exists trg_log_department_change on subteams;
create trigger trg_log_department_change
  after insert or update on subteams
  for each row execute function log_department_change();

-- ------------------------------------------------------------- 8. RLS policies
-- admin_write (FOR ALL, 20260105) let an admin DELETE a department outright.
-- Split into per-command policies with NO delete policy at all: departments
-- are archived, never deleted, whatever the caller's role (§14, §54).
drop policy if exists admin_write on subteams;

create policy department_insert on subteams for insert to authenticated
  with check (can_manage_departments());

create policy department_update on subteams for update to authenticated
  using (can_manage_departments()) with check (can_manage_departments());

-- member_read (base schema) is untouched: every member, active or alumni,
-- keeps reading every department, active or archived.

-- -------------------------------------------------------------- 9. reorder RPC
-- Accessible reorder: a caller sends the FULL ordered key list (as "move up"/
-- "move down" controls would build from the list already on screen) and this
-- assigns sort_order = position, atomically, rather than requiring N
-- individually-racy updates from a drag-and-drop client.
create or replace function reorder_departments(p_ordered_keys text[]) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  k text;
  i int := 0;
  total int;
  distinct_count int;
begin
  if not can_manage_departments() then
    raise exception 'Only the President, Vice President or a Developer may reorder departments'
      using errcode = '42501';
  end if;

  select count(*) into total from subteams;
  select count(distinct u.k) into distinct_count from unnest(p_ordered_keys) as u(k);
  if p_ordered_keys is null or array_length(p_ordered_keys, 1) is distinct from total
     or distinct_count is distinct from total then
    raise exception 'The reorder list must name every department exactly once (got %, expected %).',
      coalesce(array_length(p_ordered_keys, 1), 0), total
      using errcode = '22023';
  end if;

  foreach k in array p_ordered_keys loop
    if not exists (select 1 from subteams where key = k) then
      raise exception 'Unknown department key: %', k using errcode = '23503';
    end if;
    update subteams set sort_order = i where key = k;
    i := i + 1;
  end loop;
end $fn$;

revoke all on function reorder_departments(text[]) from public;
revoke all on function reorder_departments(text[]) from anon;
grant execute on function reorder_departments(text[]) to authenticated;

-- ------------------------------------------------- 10. reconciliation (ADR-0002)
do $$ begin
  create type department_reconciliation_entry as (
    key text, action text, name text, reason text, sort_order int
  );
exception when duplicate_object then null; end $$;

-- Read-only. Reports, per manifest entry, the dependent-row counts and
-- whether that entry would be accepted, plus one synthesized row (key/action
-- both NULL) carrying the resulting active-department count against the cap.
-- Callers (reconciliation_apply, or a maintenance script/UI) treat "any row
-- not ok" as a failed preflight.
create or replace function reconciliation_preflight(p_manifest jsonb)
returns table (
  key text, action text, clauses int, duties int, active_tasks int, archived_tasks int,
  unresolved_proposals int, handovers int, head_id uuid, head_status text,
  ok boolean, problem text
)
language plpgsql security definer set search_path = public as $fn$
declare
  entries department_reconciliation_entry[];
  resulting_active int;
begin
  if not can_manage_departments() then
    raise exception 'Only the President, Vice President or a Developer may run reconciliation'
      using errcode = '42501';
  end if;

  select coalesce(
    array_agg(row(e.key, e.action, e.name, e.reason, e.sort_order)::department_reconciliation_entry),
    '{}'
  ) into entries
  from jsonb_to_recordset(coalesce(p_manifest -> 'departments', '[]'::jsonb))
    as e(key text, action text, name text, reason text, sort_order int);

  -- Re-callable within the same session/transaction (reconciliation_apply
  -- calls this internally, and a caller may also call it directly to
  -- preview): drop any table a previous call in this transaction left behind
  -- rather than relying on ON COMMIT DROP, which only fires at commit.
  drop table if exists pg_temp.recon_rows;
  create temporary table pg_temp.recon_rows as
  with manifest as (
    select (x).key, (x).action from unnest(entries) as x
  ),
  -- Table-qualified even though "manifest" is not itself a PL/pgSQL
  -- variable: this function's RETURNS TABLE(key text, action text, ...)
  -- declares "key" and "action" as OUT-parameter variables in scope for the
  -- whole function body, so an unqualified `key`/`action` inside any nested
  -- SQL here is ambiguous between "the CTE column" and "the OUT parameter"
  -- (PL/pgSQL raises 42702 for exactly this). Every reference below is
  -- qualified for that reason, not merely style.
  dup as (
    select man.key, count(*) as n from manifest man group by man.key having count(*) > 1
  ),
  known as (
    select s.key, s.lead_id, m.status::text as head_status
    from subteams s left join members m on m.id = s.lead_id
  )
  select
    man.key,
    man.action,
    (select count(*)::int from clauses c where c.subteam_key = man.key) as clauses,
    (select count(*)::int from clauses c where c.subteam_key = man.key and c.is_team_duty) as duties,
    (select count(*)::int from tasks t where t.subteam_key = man.key and t.state not in ('done','cancelled')) as active_tasks,
    (select count(*)::int from tasks t where t.subteam_key = man.key and t.state in ('done','cancelled')) as archived_tasks,
    -- task_proposals has no department column until Phase 3 (ADR-0005); see
    -- guard_department_archive()'s comment above for the same limit.
    0 as unresolved_proposals,
    (select count(*)::int from handover_notes h where h.subteam_key = man.key) as handovers,
    k.lead_id as head_id,
    k.head_status,
    (case
      when d.key is not null then false
      when man.action = 'create' and k.key is not null then false
      when man.action in ('keep', 'rename', 'archive') and k.key is null then false
      when man.action = 'archive' and exists (
        select 1 from tasks t where t.subteam_key = man.key and t.state not in ('done', 'cancelled')
      ) then false
      when man.action not in ('keep', 'rename', 'archive', 'create') then false
      else true
    end) as ok,
    (case
      when d.key is not null then 'listed ' || d.n || ' times in the manifest'
      when man.action = 'create' and k.key is not null then 'action is create, but this key already exists'
      when man.action in ('keep', 'rename', 'archive') and k.key is null then 'unknown department key'
      when man.action = 'archive' and exists (
        select 1 from tasks t where t.subteam_key = man.key and t.state not in ('done', 'cancelled')
      ) then 'active tasks still reference this department; reassign or finish them first'
      when man.action not in ('keep', 'rename', 'archive', 'create') then 'action must be keep, rename, archive or create'
      else null
    end) as problem
  from manifest man
  left join dup d on d.key = man.key
  left join known k on k.key = man.key;

  -- 'keep'/'rename' do not themselves change active/archived state, so they
  -- count toward the result only when the department is CURRENTLY active —
  -- "keep" on an already-archived row must not be read as "make it active".
  -- 'create' always becomes active; 'archive' never does, whatever its
  -- current state (the common case: currently active, about to leave it).
  select
    coalesce((
      select count(*) from pg_temp.recon_rows r
      join subteams s on s.key = r.key
      where r.ok and r.action in ('keep', 'rename') and s.archived_at is null
    ), 0)
    + coalesce((
      select count(*) from pg_temp.recon_rows r where r.ok and r.action = 'create'
    ), 0)
  into resulting_active;

  return query
    select * from pg_temp.recon_rows
    union all
    select s.key, null::text, null::int, null::int, null::int, null::int, null::int, null::int,
      s.lead_id, m.status::text, false, 'missing from the manifest'
    from subteams s
    left join members m on m.id = s.lead_id
    where not exists (select 1 from pg_temp.recon_rows r where r.key = s.key)
    union all
    select null::text, null::text, null::int, null::int, null::int, null::int, null::int, null::int,
      null::uuid, null::text, resulting_active <= 10,
      'resulting active department count would be ' || resulting_active::text || ' (limit 10)';
end $fn$;

-- Applies a manifest as one transaction: preflight (refused as a whole if
-- ANY row fails, with every failing row's diagnosis in the exception
-- message), then the keep/rename/archive/create actions, then one summary
-- activity row. purpose is caller-supplied documentation only ('production'
-- vs 'test_fixture') — the database enforces the SAME cap and checks either
-- way; the label distinguishes intent in the audit trail, not authorization.
create or replace function reconciliation_apply(p_manifest jsonb) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  problems text;
  r record;
  next_sort int;
  active_count int;
  m_label text := coalesce(p_manifest ->> 'label', 'unlabelled');
  m_purpose text := coalesce(p_manifest ->> 'purpose', 'production');
begin
  if not can_manage_departments() then
    raise exception 'Only the President, Vice President or a Developer may apply a reconciliation manifest'
      using errcode = '42501';
  end if;

  select string_agg(coalesce(key, '(cap check)') || ': ' || problem, E'\n' order by key nulls last)
    into problems
  from reconciliation_preflight(p_manifest)
  where not ok;

  if problems is not null then
    raise exception E'Reconciliation preflight failed:\n%', problems using errcode = '23514';
  end if;

  select coalesce(max(sort_order), -1) + 1 into next_sort from subteams;

  for r in
    select (e ->> 'key') as key, (e ->> 'action') as action, (e ->> 'name') as name,
           (e ->> 'reason') as reason, (e ->> 'sort_order') as sort_order_text
    from jsonb_array_elements(coalesce(p_manifest -> 'departments', '[]'::jsonb)) as e
  loop
    if r.action = 'rename' and r.name is not null then
      update subteams set name = r.name where key = r.key;
    elsif r.action = 'archive' then
      update subteams set archived_at = now(), archived_by = auth.uid(),
        archive_reason = coalesce(r.reason, 'reconciliation')
        where key = r.key;
    elsif r.action = 'create' then
      insert into subteams (key, name, book_section, sort_order)
      values (r.key, coalesce(r.name, r.key), null, coalesce(r.sort_order_text::int, next_sort));
      next_sort := next_sort + 1;
    end if;
    -- 'keep' (and a 'rename' with no name): nothing to do.
  end loop;

  select count(*) into active_count from subteams where archived_at is null;

  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (auth.uid(), null, 'department_reconciliation', m_label, 'reconciled',
    jsonb_build_object('purpose', m_purpose, 'active_count', active_count));

  return jsonb_build_object('applied', true, 'active_count', active_count, 'label', m_label);
end $fn$;

revoke all on function reconciliation_preflight(jsonb) from public;
revoke all on function reconciliation_preflight(jsonb) from anon;
grant execute on function reconciliation_preflight(jsonb) to authenticated;

revoke all on function reconciliation_apply(jsonb) from public;
revoke all on function reconciliation_apply(jsonb) from anon;
grant execute on function reconciliation_apply(jsonb) to authenticated;

-- --------------------------------------------------------------- 11. realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'subteams'
  ) then
    alter publication supabase_realtime add table public.subteams;
  end if;
end $$;
