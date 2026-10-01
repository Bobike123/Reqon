-- =============================================================================
--  RECOVERY ONLY. Puts the ROW CONTENT of chosen tables back to what
--  2026-10-01_backup_before_phase5.sql captured, inside ONE transaction. Run as the database
--  owner, only after deciding to recover, and only after editing the list below to the tables
--  that actually need it (the default is the small reference/work tables the rollout could touch).
--
--  What it does, per listed table: for every row of the snapshot, INSERT it or, when the primary key
--  exists and the row differs, UPDATE the columns that exist in BOTH the snapshot and the live table back
--  to their snapshot values (rows that already equal the snapshot are not touched). Columns added after the snapshot are left alone (a column cannot be "restored"
--  that the snapshot never had).
--
--  What it does NOT do (recovery limits, stated so nobody assumes otherwise):
--    * it does not remove rows created after the snapshot (history is never deleted);
--    * it does not undo schema changes (tables, columns, functions, triggers, policies): those are
--      fixed forward with a new migration, or by a platform backup/point-in-time restore;
--    * it skips the append-only tables (activity, spec_measurements, spec_readiness, proposal_comments)
--      and auth: their rows are never rewritten;
--    * it needs the snapshot to exist and stops otherwise.
--
--    hosted: SQL editor / MCP execute_sql with this file
--    local : docker exec -i supabase_db_reqon psql -U postgres -v ON_ERROR_STOP=1 -f - < this file
-- =============================================================================

begin;

do $restore$
declare
  -- EDIT THIS LIST before running.
  v_tables text[] := array['milestones', 'milestone_sections', 'tasks', 'task_proposals', 'specs',
                           'subteams', 'seasons', 'meetings', 'handover_notes', 'clause_status'];
  t text;
  v_pk text[];
  v_cols text[];
  v_set text;
  v_changed bigint;
begin
  if to_regclass('maintenance_backup.r20261001_manifest') is null then
    raise exception 'no 2026-10-01 snapshot in this database; nothing can be restored from here';
  end if;

  -- The command paths that normally guard direct writes recognise the owner's maintenance flag.
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  perform set_config('reqon.proposal_write', 'on', true);

  foreach t in array v_tables loop
    if t in ('activity', 'spec_measurements', 'spec_readiness', 'proposal_comments') then
      raise exception '% is append-only and is never restored from a snapshot', t;
    end if;
    if to_regclass(format('maintenance_backup.%I', 'r20261001_' || t)) is null then
      raise exception 'the snapshot has no copy of %', t;
    end if;

    select array_agg(a.attname order by a.attnum) into v_pk
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = format('public.%I', t)::regclass and i.indisprimary;
    if v_pk is null then
      raise exception '% has no primary key; restore it by hand', t;
    end if;

    select array_agg(c.column_name order by c.ordinal_position) into v_cols
      from information_schema.columns c
      join information_schema.columns b
        on b.table_schema = 'maintenance_backup' and b.table_name = 'r20261001_' || t and b.column_name = c.column_name
     where c.table_schema = 'public' and c.table_name = t
       and coalesce(c.is_generated, 'NEVER') = 'NEVER';

    select string_agg(format('%1$I = excluded.%1$I', c), ', ')
      into v_set from unnest(v_cols) c where c <> all (v_pk);

    -- Only rows that differ from the snapshot are written, so an untouched row keeps its own updated_at.
    -- (A restored row's updated_at / updated_by are stamped by the normal triggers: they say when it was restored.)
    execute format(
      'insert into public.%1$I as tgt (%2$s) select %2$s from maintenance_backup.%3$I %4$s',
      t,
      (select string_agg(format('%I', c), ', ') from unnest(v_cols) c),
      'r20261001_' || t,
      case when v_set is null then format('on conflict (%s) do nothing', (select string_agg(format('%I', c), ', ') from unnest(v_pk) c))
           else format('on conflict (%s) do update set %s where (%s) is distinct from (%s)',
                       (select string_agg(format('%I', c), ', ') from unnest(v_pk) c), v_set,
                       (select string_agg(format('tgt.%I', c), ', ') from unnest(v_cols) c),
                       (select string_agg(format('excluded.%I', c), ', ') from unnest(v_cols) c)) end);
    get diagnostics v_changed = row_count;
    raise notice 'restored %: % row(s) written from the snapshot', t, v_changed;
  end loop;
end
$restore$;

commit;
