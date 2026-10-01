#!/usr/bin/env bash
# Rehearses the hosted rollout (backend completion Phase 5) in DISPOSABLE containers and proves it preserves data.
#
#   bash scripts/backend-completion/rehearse-phase5.sh [export.json]
#
# The container is the Supabase Postgres image (same build family as the hosted project: it has the platform roles,
# default privileges and pg_cron), not plain postgres.
#
#  1. BASELINE  hosted state = every migration through 20260127000200 (proved by catalog fingerprint in
#               docs/backend-completion/DEPLOYMENT_RUNBOOK.md §2), loaded with the hosted rows of the local
#               read-only export (default: the 2026-09-29 export in supabase/.backups/, git-ignored).
#  2. BACKUP    supabase/maintenance/2026-10-01_backup_before_phase5.sql; the copies must equal the live tables.
#  3. APPLY     the 15 pending migrations (20260127000300, 20260128*, 20260129*), one transaction each, in order,
#               WHILE a background session keeps writing a task as an ordinary signed-in role.
#  4. PRESERVE  every preserved table is byte-identical (tables that gained columns are compared without them);
#               identities, roles, departments, links, history, ids; no orphan, no cross-season link.
#  5. FRESH     a second database gets all migrations from scratch; its catalog must equal the upgraded one.
#  6. TESTS     the SQL suites that cover the pending changes, on the hosted-shaped data (each rolls itself back).
#  7. RE-RUN    the pending chain again: nothing may change.
#  8. RECOVER   damage some rows, run supabase/maintenance/2026-10-01_restore_from_backup.sql, compare.
#  9. SCHEDULER install_archive_job.sql with the real pg_cron, wait for a real scheduled run, check exactly one job,
#               that only tasks Done for 24 h+ were archived, that a second run changes nothing, then an authorised
#               restore and the denial of an unauthorised one.
#
# Nothing here connects to a real project. The containers are removed on exit.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SNAPSHOT="${1:-supabase/.backups/hosted-zsmldveykmtmxuqqmddo-pre-reconciliation-2026-09-29.json}"
CONTAINER="reqon-rehearse-p5-$$"
IMAGE="${REHEARSE_DB_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.167}"
WORK="$(mktemp -d)"
WRITER_PID=""
cleanup() {
  [ -n "$WRITER_PID" ] && kill "$WRITER_PID" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" "$CONTAINER-fresh" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "!! REHEARSAL FAILED: $*"; exit 1; }

[ -f "$SNAPSHOT" ] || fail "no export at $SNAPSHOT"
command -v docker >/dev/null || fail "docker is required"

PENDING=(supabase/migrations/20260127000300*.sql supabase/migrations/20260128*.sql supabase/migrations/20260129*.sql)
echo "==> disposable $IMAGE ($CONTAINER)"
docker run --rm -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
psql_in()  { docker exec -i -e PGOPTIONS="${PGOPTIONS:-}" "$CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql_db()  { local db="$1"; shift; docker exec -i -e PGOPTIONS="${PGOPTIONS:-}" "$CONTAINER" psql -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }
quiet()    { PGOPTIONS='-c client_min_messages=warning' psql_in "$@"; }
ok=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); else ok=0; fi
  [ "$ok" -ge 3 ] && break
  sleep 1
done
[ "$ok" -ge 3 ] || fail "the database did not become ready"

prepare_db() { # $1 = database name
  PGOPTIONS='-c client_min_messages=warning' psql_db "$1" -q <<'SQL' >/dev/null
create extension if not exists pgcrypto;
create schema if not exists storage;
create table if not exists storage.objects (bucket_id text, name text);
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
SQL
}
apply_to() { # $1 db, rest = files ; one transaction per file, like a hosted apply_migration call
  local db="$1"; shift
  for f in "$@"; do
    PGOPTIONS='-c client_min_messages=warning' psql_db "$db" -q -1 -f - < "$f" >/dev/null || fail "$(basename "$f") failed on $db"
  done
}
upto() { # files whose version is <= $1
  for f in supabase/migrations/*.sql; do
    v="$(basename "$f" | cut -c1-14)"
    [ "$v" -le "$1" ] && echo "$f"
  done
}
prepare_db postgres

echo "==> hosted baseline: schema through 20260124, the hosted rows, then 20260125* .. 20260127000200"
mapfile -t UP_TO_0124 < <(upto 20260124000000)
apply_to postgres "${UP_TO_0124[@]}"
node scripts/data-rebuild/snapshot-to-sql.mjs "$SNAPSHOT" > "$WORK/load.sql"
quiet -q -f - < "$WORK/load.sql" >/dev/null
mapfile -t TO_BASELINE < <(for f in $(upto 20260127000200); do v="$(basename "$f" | cut -c1-14)"; [ "$v" -gt 20260124000000 ] && echo "$f"; done)
apply_to postgres "${TO_BASELINE[@]}"

ROWSUM_RAW() { # one md5 per preserved table over every row as jsonb, without the columns the pending chain adds
cat <<'SQL'
select t, n, h from (
  select 'auth.users' t, count(*) n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) h from auth.users x
  union all select 'members', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from members x
  union all select 'member_roles', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from member_roles x
  union all select 'subteams', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from subteams x
  union all select 'seasons', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from seasons x
  union all select 'tasks', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'blocked_reason' - 'blocked_since')::text, '|' order by (to_jsonb(x) - 'blocked_reason' - 'blocked_since')::text), '')) from tasks x where id <> '__TASK__'
  union all select 'tasks_writer_row', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'blocked_reason' - 'blocked_since' - 'updated_at')::text, '|'), '')) from tasks x where id = '__TASK__'
  union all select 'task_proposals', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from task_proposals x
  union all select 'proposal_comments', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from proposal_comments x
  union all select 'task_requirements', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from task_requirements x
  union all select 'proposal_requirements', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from proposal_requirements x
  union all select 'department_members', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from department_members x
  union all select 'clause_status', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from clause_status x
  union all select 'clauses', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from clauses x
  union all select 'milestones', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'code' - 'submitted_on' - 'submitted_by' - 'accepted_on' - 'accepted_by')::text, '|' order by (to_jsonb(x) - 'code' - 'submitted_on' - 'submitted_by' - 'accepted_on' - 'accepted_by')::text), '')) from milestones x
  union all select 'milestone_sections', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'parent_section_id')::text, '|' order by (to_jsonb(x) - 'parent_section_id')::text), '')) from milestone_sections x
  union all select 'specs', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'direction_reviewed_at' - 'direction_reviewed_by' - 'direction_note')::text, '|' order by (to_jsonb(x) - 'direction_reviewed_at' - 'direction_reviewed_by' - 'direction_note')::text), '')) from specs x
  union all select 'spec_measurements', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'context')::text, '|' order by (to_jsonb(x) - 'context')::text), '')) from spec_measurements x
  union all select 'meetings', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from meetings x
  union all select 'meeting_template', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from meeting_template x
  union all select 'handover_notes', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from handover_notes x
  union all select 'finance_entries', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from finance_entries x
  union all select 'regulation_documents', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from regulation_documents x
  union all select 'activity', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from activity x
) f order by t;
SQL
}
WRITER_UID=$(psql_in -tA -c "select member_id from member_roles where role = 'developer' order by member_id limit 1")
[ -n "$WRITER_UID" ] || fail "no developer in the hosted-shaped data"
TASK_ID=$(psql_in -tA -c "select id from tasks where state in ('todo','wip') and archived_at is null order by id limit 1")
ROWSUM() { ROWSUM_RAW | sed "s/__TASK__/$TASK_ID/g"; }
ROWSUM | psql_in -tA -F' ' -f - > "$WORK/before.txt"
echo "    $(wc -l < "$WORK/before.txt") tables fingerprinted: $(awk '{printf "%s=%s ", $1, $2}' "$WORK/before.txt")"
DONE_ELIGIBLE=$(psql_in -tA -c "select count(*) from tasks where state = 'done' and archived_at is null and completed_at <= now() - interval '24 hours'")
echo "    tasks: $(psql_in -tA -c "select count(*) from tasks"); Done for 24 h or more and not archived: $DONE_ELIGIBLE"

echo "==> backup (supabase/maintenance/2026-10-01_backup_before_phase5.sql)"
psql_in -q -f - < supabase/maintenance/2026-10-01_backup_before_phase5.sql >/dev/null
MISMATCH=$(psql_in -tA -c "
select count(*) from maintenance_backup.r20261001_manifest m
 where m.row_count is distinct from (xpath('/row/c/text()', query_to_xml(format('select count(*) c from public.%I', m.table_name), false, true, '')))[1]::text::bigint")
[ "$MISMATCH" = "0" ] || fail "the backup row counts differ from the live tables"
psql_in -tA -c "select count(*) || ' table copies in maintenance_backup' from maintenance_backup.r20261001_manifest"
psql_in -tA -c "select has_schema_privilege('anon','maintenance_backup','usage') or has_schema_privilege('authenticated','maintenance_backup','usage')" | grep -qx f || fail "an API role can read maintenance_backup"
AGAIN=$(psql_in -q -f - < supabase/maintenance/2026-10-01_backup_before_phase5.sql 2>&1 || true)
case "$AGAIN" in *"already exists"*) ;; *) fail "the backup file did not recognise an existing snapshot: $AGAIN";; esac
echo "    ok  every table copied, counts equal, unreachable by anon/authenticated; a second run is a no-op"

echo "==> concurrent traffic: one signed-in writer runs while the migrations apply"
cat > "$WORK/writer.sh" <<WRITER
#!/usr/bin/env bash
for i in \$(seq 1 400); do
  out=\$(docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -tA <<SQL 2>&1
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"$WRITER_UID","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '$WRITER_UID', true);
update tasks set title = title where id = '$TASK_ID';
select count(*) from v_subteam_progress;
commit;
SQL
)
  if echo "\$out" | grep -qi "error"; then echo "ERR \$(echo "\$out" | grep -i error | head -1)" >> "$WORK/traffic.log"; else echo OK >> "$WORK/traffic.log"; fi
  sleep 0.15
done
WRITER
chmod +x "$WORK/writer.sh"
: > "$WORK/traffic.log"
"$WORK/writer.sh" &
WRITER_PID=$!
sleep 2

echo "==> the pending migrations, one transaction each, in order"
for f in "${PENDING[@]}"; do
  t0=$(date +%s%3N)
  PGOPTIONS='-c client_min_messages=warning' psql_in -q -1 -f - < "$f" >/dev/null || fail "$(basename "$f") failed"
  printf '    %-58s %5d ms\n' "$(basename "$f")" "$(( $(date +%s%3N) - t0 ))"
done
sleep 2
kill "$WRITER_PID" >/dev/null 2>&1 || true; wait "$WRITER_PID" 2>/dev/null || true; WRITER_PID=""
W_OK=$(grep -c '^OK' "$WORK/traffic.log" || true); W_ERR=$(grep -c '^ERR' "$WORK/traffic.log" || true)
echo "    concurrent writer: $W_OK statements ok, $W_ERR errors"
if [ "$W_ERR" != "0" ]; then sort "$WORK/traffic.log" | uniq -c | head -5; fail "the concurrent writer saw errors during the migrations"; fi
[ "$W_OK" -ge 20 ] || fail "the concurrent writer barely ran ($W_OK)"
echo "    ok  no deadlock, lock failure or refused write while 15 migrations applied under traffic"

echo "==> preservation: the upgraded hosted-shaped data against the baseline"
ROWSUM | psql_in -tA -F' ' -f - > "$WORK/after.txt"
diff -u "$WORK/before.txt" "$WORK/after.txt" > "$WORK/diff.txt" || { cat "$WORK/diff.txt"; fail "the migrations changed preserved data"; }
echo "    ok  every preserved table is byte-identical (row counts and content hashes; tables that gained columns compared without them)"
CHECK=$(psql_in -tA -c "
select (select count(*) from member_roles r where r.role = 'developer' and (r.member_id::text like '46ddd380%' or r.member_id::text like '06e80f1d%'))
    || '|' || (select string_agg(key || '=' || name, ',' order by sort_order) from subteams where archived_at is null and parent_key is null)
    || '|' || (select count(*) from spec_readiness)
    || '|' || (select count(*) from milestones where submitted_on is not null or accepted_on is not null or submitted_by is not null or accepted_by is not null)
    || '|' || (select count(*) from milestones where code is distinct from key)
    || '|' || (select count(*) from specs where direction_reviewed_at is not null or direction_reviewed_by is not null or direction_note is not null)
    || '|' || (select count(*) from spec_measurements where context is distinct from 'team')
    || '|' || (select count(*) from task_dependencies)
    || '|' || (select count(*) from tasks where blocked_reason is not null or blocked_since is not null)
    || '|' || (select count(*) from milestone_sections where parent_section_id is not null)")
EXPECTED='2|SWDATA=Software & Data Acquisition,MECH=Mechanical Design & Testing,ELEC=Electrical Systems & Integration,BUILD=Manufacturing & Assembly,OPS=Project Operations & Documentation|0|0|0|0|0|0|0|0'
[ "$CHECK" = "$EXPECTED" ] || fail "expected $EXPECTED, got $CHECK"
echo "    ok  Claudiu and Máté keep Developer; the five departments unchanged; nothing invented for existing rows"
ORPHANS=$(psql_in -tA -c "
select (select count(*) from task_requirements r where not exists (select 1 from tasks t where t.id = r.task_id))
   + (select count(*) from task_requirements r where not exists (select 1 from clauses c where c.clause_key = r.clause_key))
   + (select count(*) from proposal_requirements r where not exists (select 1 from task_proposals p where p.id = r.proposal_id))
   + (select count(*) from tasks t where t.milestone_key is not null and not exists (select 1 from milestones m where m.key = t.milestone_key))
   + (select count(*) from tasks t where t.section_id is not null and not exists (select 1 from milestone_sections s where s.id = t.section_id))
   + (select count(*) from tasks t where t.subteam_key is not null and not exists (select 1 from subteams s where s.key = t.subteam_key))
   + (select count(*) from task_dependencies d where not exists (select 1 from tasks t where t.id = d.task_id) or not exists (select 1 from tasks t where t.id = d.depends_on_task_id))")
DUPES=$(psql_in -tA -c "select count(*) from (select season_id, lower(title) from tasks group by 1, 2 having count(*) > 1) d")
BASE_DUPES=$(psql_in -tA -c "select count(*) from (select season_id, lower(title) from maintenance_backup.r20261001_tasks group by 1, 2 having count(*) > 1) d")
CROSS=$(psql_in -tA -c "select count(*) from tasks t join milestones m on m.key = t.milestone_key where m.season_id <> t.season_id")
[ "$ORPHANS" = "0" ] && [ "$CROSS" = "0" ] || fail "orphaned links: $ORPHANS, cross-season links: $CROSS"
[ "$DUPES" = "$BASE_DUPES" ] || fail "duplicate task titles changed ($BASE_DUPES -> $DUPES)"
echo "    ok  zero orphaned links, zero cross-season links; duplicate task titles within a season unchanged ($DUPES)"

echo "==> a fresh installation of all migrations (second container) must equal the upgraded catalog"
FRESH="$CONTAINER-fresh"
docker run --rm -d --name "$FRESH" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
ok=0
for _ in $(seq 1 120); do
  if docker exec "$FRESH" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); else ok=0; fi
  [ "$ok" -ge 3 ] && break
  sleep 1
done
[ "$ok" -ge 3 ] || fail "the fresh database did not become ready"
CONTAINER_MAIN="$CONTAINER"; CONTAINER="$FRESH"
prepare_db postgres
mapfile -t ALL < <(ls supabase/migrations/*.sql)
apply_to postgres "${ALL[@]}"
FP=scripts/backend-completion/catalog-fingerprint.sql
psql_db postgres -tA -F'|' -f - < "$FP" > "$WORK/fp_fresh.txt"
CONTAINER="$CONTAINER_MAIN"
docker rm -f "$FRESH" >/dev/null 2>&1 || true
psql_db postgres -tA -F'|' -f - < "$FP" > "$WORK/fp_upgraded.txt"
diff -u "$WORK/fp_fresh.txt" "$WORK/fp_upgraded.txt" > "$WORK/fp_diff.txt" || { head -30 "$WORK/fp_diff.txt"; fail "the upgraded catalog differs from a fresh installation"; }
echo "    ok  $(wc -l < "$WORK/fp_fresh.txt") catalog objects (functions, columns, constraints, indexes, triggers, policies, views, enums, grants, EXECUTE rights, RLS flags, publication) identical"

echo "==> the SQL suites on the hosted-shaped data (each rolls itself back)"
for f in supabase/tests/progress_views_test.sql supabase/tests/milestone_submission_test.sql \
         supabase/tests/spec_evidence_test.sql supabase/tests/season_integrity_test.sql \
         supabase/tests/proposal_discussion_test.sql supabase/tests/task_workflow_test.sql \
         supabase/tests/proposal_commands_test.sql supabase/tests/proposal_promotion_test.sql \
         supabase/tests/task_archive_sweep_test.sql supabase/tests/permission_matrix_test.sql; do
  OUT=$(psql_in -f - < "$f" 2>&1 || true)
  VERDICT=$(echo "$OUT" | command grep -oE '[A-Z/ ]+ CHECKS PASSED — all [0-9]+ checks' || true)
  if [ -z "$VERDICT" ] || [ "$(echo "$OUT" | command grep -c 'ERROR:')" != "1" ]; then
    echo "$OUT" | tail -30; fail "$(basename "$f")"
  fi
  echo "    ok  $(basename "$f") —$VERDICT"
done
ROWSUM | psql_in -tA -F' ' -f - > "$WORK/after_tests.txt"
diff -q "$WORK/after.txt" "$WORK/after_tests.txt" >/dev/null || { diff -u "$WORK/after.txt" "$WORK/after_tests.txt"; fail "a test left data behind"; }
echo "    ok  the tests left nothing behind"

echo "==> the pending chain again (must change nothing)"
for f in "${PENDING[@]}"; do PGOPTIONS='-c client_min_messages=warning' psql_in -q -1 -f - < "$f" >/dev/null || fail "re-applying $(basename "$f") failed"; done
ROWSUM | psql_in -tA -F' ' -f - > "$WORK/rerun.txt"
diff -q "$WORK/after.txt" "$WORK/rerun.txt" >/dev/null || { diff -u "$WORK/after.txt" "$WORK/rerun.txt"; fail "a re-run changed data"; }
psql_db postgres -tA -F'|' -f - < "$FP" | diff -q - "$WORK/fp_upgraded.txt" >/dev/null || fail "a re-run changed the catalog"
echo "    ok  re-run is a no-op for data and catalog"

echo "==> tested recovery of ROW CONTENT from the snapshot"
ROWSUM_RAW | sed "s/__TASK__/$TASK_ID/g; s/to_jsonb(x)/(to_jsonb(x) - 'updated_at' - 'updated_by')/g" | psql_in -tA -F' ' -f - > "$WORK/before_damage.txt"
psql_in -q <<'SQL' >/dev/null
update milestones set name = name || ' (damaged)';
update tasks set title = 'damaged ' || title where state in ('todo', 'wip');
update subteams set name = 'damaged ' || name where key = 'MECH';
SQL
ROWSUM_RAW | sed "s/__TASK__/$TASK_ID/g; s/to_jsonb(x)/(to_jsonb(x) - 'updated_at' - 'updated_by')/g" | psql_in -tA -F' ' -f - > "$WORK/damaged.txt"
diff -q "$WORK/before_damage.txt" "$WORK/damaged.txt" >/dev/null && fail "the damage step changed nothing"
PGOPTIONS='-c client_min_messages=warning' psql_in -q -f - < supabase/maintenance/2026-10-01_restore_from_backup.sql >/dev/null || fail "the restore script failed"
ROWSUM_RAW | sed "s/__TASK__/$TASK_ID/g; s/to_jsonb(x)/(to_jsonb(x) - 'updated_at' - 'updated_by')/g" | psql_in -tA -F' ' -f - > "$WORK/restored.txt"
# updated_at/updated_by of restored rows say when they were restored; the audit trail (activity) gained the events of the
# damage and of its repair and is never deleted. Everything else must equal the state before the damage.
diff <(grep -v '^activity ' "$WORK/before_damage.txt") <(grep -v '^activity ' "$WORK/restored.txt") >/dev/null || { diff "$WORK/before_damage.txt" "$WORK/restored.txt"; fail "the restore did not return the rows to the snapshot"; }
UNTOUCHED=$(psql_in -tA -c "select count(*) from meetings m join maintenance_backup.r20261001_meetings b using (id) where m.updated_at is distinct from b.updated_at")
[ "$UNTOUCHED" = "0" ] || fail "the restore touched $UNTOUCHED undamaged meeting row(s)"
echo "    ok  damaged milestones, tasks and a department were restored exactly; the audit trail kept both events (history is not deleted)"

echo "==> the scheduler: one pg_cron job, a real scheduled run, only eligible tasks archived"
psql_in -q -c "create extension if not exists pg_cron" >/dev/null 2>&1 || fail "pg_cron could not be created in this image"
psql_in -q -f - < supabase/scheduler/install_archive_job.sql >/dev/null || fail "install_archive_job.sql failed"
psql_in -q -f - < supabase/scheduler/install_archive_job.sql >/dev/null || fail "the installer is not repeatable"
JOBS=$(psql_in -tA -c "select count(*) from cron.job where command ilike '%archive_stale_done_tasks%'")
[ "$JOBS" = "1" ] || fail "expected exactly one archive job, found $JOBS"
echo "    ok  installing twice leaves exactly one job: $(psql_in -tA -c "select jobname || ' ' || schedule || ' active=' || active from cron.job where command ilike '%archive_stale_done_tasks%'")"
ELIG=$(psql_in -tA -c "select count(*) from tasks where state = 'done' and archived_at is null and completed_at <= now() - interval '24 hours'")
FRESH_DONE=$(psql_in -tA -c "select count(*) from tasks where state = 'done' and archived_at is null and completed_at > now() - interval '24 hours'")
echo "    eligible now: $ELIG; Done under 24 h (must stay): $FRESH_DONE; waiting for the next 5-minute tick..."
RUN=""
for _ in $(seq 1 80); do
  RUN=$(psql_in -tA -c "select status || '|' || coalesce(return_message,'') from cron.job_run_details d join cron.job j using (jobid) where j.command ilike '%archive_stale_done_tasks%' order by d.start_time desc limit 1")
  [ -n "$RUN" ] && break
  sleep 5
done
case "$RUN" in succeeded*) ;; *) fail "no successful scheduled run observed (last: '$RUN')";; esac
ARCH=$(psql_in -tA -c "select count(*) from tasks where archived_at is not null and archive_reason = 'auto_done_24h'")
STILL=$(psql_in -tA -c "select count(*) from tasks where state = 'done' and archived_at is null")
[ "$ARCH" = "$ELIG" ] || fail "the run archived $ARCH task(s), expected exactly the $ELIG eligible ones"
[ "$STILL" = "$FRESH_DONE" ] || fail "$STILL Done task(s) stayed active, expected $FRESH_DONE"
echo "    ok  a real pg_cron run succeeded ($RUN): $ARCH eligible Done task(s) archived with reason auto_done_24h, $STILL recent Done task(s) untouched"
psql_in -q -c "select public.archive_stale_done_tasks()" >/dev/null
[ "$(psql_in -tA -c "select count(*) from tasks where archive_reason = 'auto_done_24h'")" = "$ARCH" ] || fail "a second sweep archived more"
echo "    ok  a second sweep changes nothing"
ARCHIVED_ID=$(psql_in -tA -c "select id from tasks where archive_reason = 'auto_done_24h' order by id limit 1")
AS() { printf "begin;\nselect set_config('role','authenticated',true);\nselect set_config('request.jwt.claims','{\"sub\":\"%s\",\"role\":\"authenticated\"}',true);\nselect set_config('request.jwt.claim.sub','%s',true);\n%s\nrollback;\n" "$1" "$1" "$2"; }
PLAIN_UID=$(psql_in -tA -c "select m.id from members m where m.status = 'active' and not exists (select 1 from member_roles r where r.member_id = m.id) order by m.id limit 1")
[ -n "$PLAIN_UID" ] || fail "no ordinary member in the hosted-shaped data"
DEV_OUT=$(AS "$WRITER_UID" "select id || ' restored to ' || state from restore_task('$ARCHIVED_ID');" | psql_in -tA 2>&1 || true)
case "$DEV_OUT" in *"restored to"*) ;; *) fail "an authorised Developer could not restore: $DEV_OUT";; esac
MEM_OUT=$(AS "$PLAIN_UID" "select id from restore_task('$ARCHIVED_ID');" | psql_in -tA 2>&1 || true)
case "$MEM_OUT" in *"may restore it"*|*"42501"*) ;; *) fail "an ordinary member was not refused: $MEM_OUT";; esac
echo "    ok  restore_task: a Developer may, an ordinary member is refused (RLS-evaluated as role authenticated, rolled back)"

echo "==> undoing the scheduler's archivals exactly with the restore script (tasks only)"
python3 - "$WORK/restore_tasks_only.sql" <<'PY'
import re, sys
src = open("supabase/maintenance/2026-10-01_restore_from_backup.sql").read()
out, n = re.subn(r"array\['milestones'.*?'clause_status'\]", "array['tasks']", src, flags=re.S)
assert n == 1, "could not narrow the restore list"
open(sys.argv[1], "w").write(out)
PY
ARCH_BEFORE=$(psql_in -tA -c "select count(*) from tasks where archived_at is not null")
[ "$ARCH_BEFORE" -gt 0 ] || fail "nothing is archived to undo"
PGOPTIONS='-c client_min_messages=warning' psql_in -q -f - < "$WORK/restore_tasks_only.sql" >/dev/null || fail "the tasks-only restore failed"
LEFT=$(psql_in -tA -c "select count(*) from tasks where archived_at is not null or archive_reason is not null")
SAME=$(psql_in -tA -c "select count(*) from tasks t join maintenance_backup.r20261001_tasks b using (id) where t.state = b.state and t.completed_at is not distinct from b.completed_at and t.archived_at is not distinct from b.archived_at and t.archive_reason is not distinct from b.archive_reason")
TOTAL=$(psql_in -tA -c "select count(*) from tasks")
[ "$LEFT" = "0" ] || fail "$LEFT task(s) are still archived after the restore"
[ "$SAME" = "$TOTAL" ] || fail "only $SAME of $TOTAL tasks match the snapshot (state, completed_at, archive columns) after the restore"
echo "    ok  $ARCH_BEFORE archived Done task(s) are back exactly as the snapshot had them (state, original completed_at, no archive columns)"

echo "==> REHEARSAL PASSED — Phase 5 on the hosted-baseline copy: data preserved under concurrent traffic, fresh install == upgrade, re-run is a no-op, recovery and scheduler exercised"
