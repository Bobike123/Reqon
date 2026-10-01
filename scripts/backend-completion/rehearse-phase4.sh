#!/usr/bin/env bash
# Rehearses the backend-completion Phase 4 migrations (20260129*) against a
# DISPOSABLE copy of the hosted project's data, and proves they preserve it.
#
#   bash scripts/backend-completion/rehearse-phase4.sh [export.json]
#
# 1. a throwaway postgres:17 container, the auth shim, every migration up to and
#    including 20260124 (the hosted baseline before the 2026/27 reconciliation);
# 2. the hosted rows from the local read-only export (default: the 2026-09-29
#    export in supabase/.backups/, git-ignored);
# 3. every 20260125* .. 20260128* migration (Phases 2 and 3 are prerequisites; their own
#    rehearsals are rehearse-phase2.sh / rehearse-phase3.sh);
# 4. a fingerprint of every preserved table (auth users, profiles, role grants,
#    departments, tasks, proposals, links, requirement status, milestones, sections,
#    specs, measurements, meetings, seasons, Book metadata, activity);
# 5. the Phase 4 migrations; the fingerprint must be identical (tables that gain
#    columns are compared without them: milestones without code / submitted_* / accepted_*,
#    specs without the direction-review columns, spec_measurements without `context`), so no
#    row is gained, lost or rewritten, no submission or acceptance is invented, no direction is
#    marked reviewed and no readiness confirmed;
# 6. the Phase 4 SQL test files against this hosted-shaped data (each one rolls itself back);
# 7. the Phase 4 migrations a second time: nothing may change.
#
# Nothing here connects to a real project; the container is removed on exit.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SNAPSHOT="${1:-supabase/.backups/hosted-zsmldveykmtmxuqqmddo-pre-reconciliation-2026-09-29.json}"
CONTAINER="reqon-rehearse-p4-$$"
IMAGE="${REHEARSE_DB_IMAGE:-postgres:17}"
WORK="$(mktemp -d)"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

[ -f "$SNAPSHOT" ] || { echo "!! no export at $SNAPSHOT"; exit 1; }

echo "==> disposable $IMAGE ($CONTAINER)"
docker run --rm -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
psql_in() { docker exec -i -e PGOPTIONS="${PGOPTIONS:-}" "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
quiet() { PGOPTIONS='-c client_min_messages=warning' psql_in "$@"; }
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
quiet -q -f - < scripts/local_auth_shim.sql >/dev/null
psql_in -q -c "create schema if not exists storage; create table if not exists storage.objects (bucket_id text, name text);" >/dev/null

echo "==> schema up to 20260124, then the hosted export"
for f in supabase/migrations/*.sql; do
  v="$(basename "$f" | cut -c1-14)"
  [ "$v" -le 20260124000000 ] || continue
  quiet -q -f - < "$f" >/dev/null
done
node scripts/data-rebuild/snapshot-to-sql.mjs "$SNAPSHOT" > "$WORK/load.sql"
quiet -q -f - < "$WORK/load.sql" >/dev/null

echo "==> every 20260125* .. 20260128* migration (the state after Phase 3)"
for f in supabase/migrations/20260125*.sql supabase/migrations/20260126*.sql supabase/migrations/20260127*.sql supabase/migrations/20260128*.sql; do quiet -q -f - < "$f" >/dev/null; done

# One md5 per table over every row (as jsonb, ordered by the row text), so any
# changed, added or lost row shows up. subteams drops only the new column.
FINGERPRINT_SQL=$(cat <<'SQL'
select t, n, h from (
  select 'auth.users' t, count(*) n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) h from auth.users x
  union all select 'members', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from members x
  union all select 'member_roles', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from member_roles x
  union all select 'subteams', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from subteams x
  union all select 'seasons', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from seasons x
  union all select 'tasks', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from tasks x
  union all select 'task_proposals', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from task_proposals x
  union all select 'task_requirements', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from task_requirements x
  union all select 'proposal_requirements', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from proposal_requirements x
  union all select 'clause_status', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from clause_status x
  union all select 'clauses', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from clauses x
  union all select 'milestones', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'code' - 'submitted_on' - 'submitted_by' - 'accepted_on' - 'accepted_by')::text, '|' order by (to_jsonb(x) - 'code' - 'submitted_on' - 'submitted_by' - 'accepted_on' - 'accepted_by')::text), '')) from milestones x
  union all select 'milestone_sections', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from milestone_sections x
  union all select 'specs', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'direction_reviewed_at' - 'direction_reviewed_by' - 'direction_note')::text, '|' order by (to_jsonb(x) - 'direction_reviewed_at' - 'direction_reviewed_by' - 'direction_note')::text), '')) from specs x
  union all select 'spec_measurements', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'context')::text, '|' order by (to_jsonb(x) - 'context')::text), '')) from spec_measurements x
  union all select 'meetings', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from meetings x
  union all select 'meeting_template', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from meeting_template x
  union all select 'handover_notes', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from handover_notes x
  union all select 'finance_entries', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from finance_entries x
  union all select 'regulation_documents', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from regulation_documents x
  union all select 'task_dependencies', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from task_dependencies x
  union all select 'proposal_comments', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from proposal_comments x
  union all select 'department_members', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from department_members x
  union all select 'activity', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from activity x
) f order by t;
SQL
)
psql_in -tA -F' ' -c "$FINGERPRINT_SQL" > "$WORK/before.txt"
echo "    $(wc -l < "$WORK/before.txt") tables fingerprinted: $(awk '{printf "%s=%s ", $1, $2}' "$WORK/before.txt")"

echo "==> the Phase 4 migrations"
for f in supabase/migrations/20260129*.sql; do
  echo "    $(basename "$f")"
  quiet -q -f - < "$f" >/dev/null
done

psql_in -tA -F' ' -c "$FINGERPRINT_SQL" > "$WORK/after.txt"
if ! diff -u "$WORK/before.txt" "$WORK/after.txt" > "$WORK/diff.txt"; then
  echo "!! REHEARSAL FAILED: the Phase 4 migrations changed preserved data"
  cat "$WORK/diff.txt"
  exit 1
fi
echo "    ok  every preserved table is byte-identical (row counts and content hashes)"

CHECK=$(psql_in -tA -c "
select (select count(*) from member_roles r where r.role = 'developer' and (r.member_id::text like '46ddd380%' or r.member_id::text like '06e80f1d%'))
    || '|' || (select string_agg(key || '=' || name, ',' order by sort_order) from subteams where archived_at is null and parent_key is null)
    || '|' || (select count(*) from spec_readiness)
    || '|' || (select count(*) from milestones where submitted_on is not null or accepted_on is not null or submitted_by is not null or accepted_by is not null)
    || '|' || (select count(*) from milestones where code is distinct from key)
    || '|' || (select count(*) from specs where direction_reviewed_at is not null or direction_reviewed_by is not null or direction_note is not null)
    || '|' || (select count(*) from spec_measurements where context is distinct from 'team')")
EXPECTED='2|SWDATA=Software & Data Acquisition,MECH=Mechanical Design & Testing,ELEC=Electrical Systems & Integration,BUILD=Manufacturing & Assembly,OPS=Project Operations & Documentation|0|0|0|0|0'
if [ "$CHECK" != "$EXPECTED" ]; then
  echo "!! REHEARSAL FAILED: expected $EXPECTED"
  echo "                     got      $CHECK"
  exit 1
fi
echo "    ok  Claudiu and Máté keep Developer; the five departments unchanged; every milestone code equals its key; no readiness, submission, acceptance, reviewed direction or competition observation invented"

# Progress is read, never stored: the new views must agree with the plain tables.
PROGRESS=$(psql_in -tA -c "
select (select count(*) from tasks where season_id = s.id and state <> 'cancelled') || '|' || coalesce((select total from v_task_progress where season_id = s.id and scope = 'season'), 0)
from seasons s where is_current limit 1")
case "$PROGRESS" in
  *"|"*) A="${PROGRESS%%|*}"; B="${PROGRESS##*|}"
    [ "$A" = "$B" ] || { echo "!! REHEARSAL FAILED: v_task_progress season total $B but $A countable tasks"; exit 1; }
    echo "    ok  v_task_progress agrees with the tasks table ($A countable tasks in the current season)" ;;
  *) echo "!! REHEARSAL FAILED: could not read progress ($PROGRESS)"; exit 1 ;;
esac

echo "==> the Phase 4 SQL tests against the hosted-shaped data"
for f in supabase/tests/progress_views_test.sql supabase/tests/milestone_submission_test.sql \
         supabase/tests/spec_evidence_test.sql supabase/tests/season_integrity_test.sql; do
  OUT=$(psql_in -f - < "$f" 2>&1 || true)
  VERDICT=$(echo "$OUT" | command grep -oE '[A-Z/ ]+ CHECKS PASSED — all [0-9]+ checks' || true)
  if [ -z "$VERDICT" ] || [ "$(echo "$OUT" | command grep -c 'ERROR:')" != "1" ]; then
    echo "!! REHEARSAL FAILED: $(basename "$f")"; echo "$OUT" | tail -30; exit 1
  fi
  echo "    ok  $(basename "$f") —$VERDICT"
done
psql_in -tA -F' ' -c "$FINGERPRINT_SQL" > "$WORK/after_tests.txt"
diff -q "$WORK/after.txt" "$WORK/after_tests.txt" >/dev/null || { echo "!! REHEARSAL FAILED: a test left data behind"; diff -u "$WORK/after.txt" "$WORK/after_tests.txt"; exit 1; }
echo "    ok  the tests left nothing behind"

echo "==> the Phase 4 migrations again (must change nothing)"
for f in supabase/migrations/20260129*.sql; do quiet -q -f - < "$f" >/dev/null; done
psql_in -tA -F' ' -c "$FINGERPRINT_SQL" > "$WORK/rerun.txt"
diff -q "$WORK/after.txt" "$WORK/rerun.txt" >/dev/null || { echo "!! REHEARSAL FAILED: a re-run changed data"; diff -u "$WORK/after.txt" "$WORK/rerun.txt"; exit 1; }
echo "    ok  re-run is a no-op"

echo "==> REHEARSAL PASSED — Phase 4 on the hosted data copy: data preserved, permissions verified, re-run is a no-op"
