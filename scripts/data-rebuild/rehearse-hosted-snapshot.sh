#!/usr/bin/env bash
# Rehearses the 2026-09-29 reconciliation against a DISPOSABLE copy of the
# hosted project's data, then proves the recovery script restores it.
#
#   bash scripts/data-rebuild/rehearse-hosted-snapshot.sh [export.json]
#
# 1. a throwaway postgres:17 container; the auth shim; every migration up to
#    and including 20260124 (the hosted baseline);
# 2. the hosted rows from the local export (default: the 2026-09-29 export in
#    supabase/.backups/), clause text proven identical by hash;
# 3. supabase/maintenance/2026-09-29_backup_before_reconciliation.sql;
# 4. the four 20260125* migrations, exactly as they will run on hosted;
# 5. supabase/maintenance/2026-09-29_verify_reconciliation.sql — every row
#    must be true;
# 6. the three data migrations again — nothing may change;
# 7. supabase/maintenance/2026-09-29_restore_from_backup.sql — the
#    pre-change state must come back.
#
# Nothing here connects to a real project; the container is removed on exit.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SNAPSHOT="${1:-supabase/.backups/hosted-zsmldveykmtmxuqqmddo-pre-reconciliation-2026-09-29.json}"
CONTAINER="reqon-rehearse-$$"
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
# Hosted has Supabase Storage; the verification looks objects up there.
psql_in -q -c "create schema if not exists storage; create table if not exists storage.objects (bucket_id text, name text);" >/dev/null

echo "==> schema up to the hosted baseline (20260124)"
for f in supabase/migrations/*.sql; do
  v="$(basename "$f" | cut -c1-14)"
  [ "$v" -le 20260124000000 ] || continue
  quiet -q -f - < "$f" >/dev/null
done

echo "==> loading the hosted export: $SNAPSHOT"
node scripts/data-rebuild/snapshot-to-sql.mjs "$SNAPSHOT" > "$WORK/load.sql"
quiet -q -f - < "$WORK/load.sql" >/dev/null
psql_in -tA -F' ' -c "select 'before:', (select count(*) from subteams) || ' departments,', (select count(*) from tasks) || ' tasks,',
  (select count(*) from task_proposals) || ' proposals,', (select count(*) from handover_notes) || ' handover notes,',
  (select count(*) from members) || ' members,', (select count(*) from member_roles) || ' role grants,',
  (select count(*) from clauses where source_page is not null) || ' paged clauses'"

echo "==> snapshot (maintenance/2026-09-29_backup_before_reconciliation.sql)"
psql_in -q -f - < supabase/maintenance/2026-09-29_backup_before_reconciliation.sql >/dev/null

echo "==> applying the reconciliation migrations"
for f in supabase/migrations/202601250*.sql; do
  echo "    $(basename "$f")"
  psql_in -f - < "$f" 2>&1 | command grep -o 'NOTICE:.*' | cut -c1-600 | sed 's/^/      /' || true
done

verify() {
  psql_in -tA -F' | ' -f - < supabase/maintenance/2026-09-29_verify_reconciliation.sql > "$WORK/verify.txt"
  sed 's/^/    /' "$WORK/verify.txt"
  command grep -q '^99 | ALL | t | 0 failing$' "$WORK/verify.txt"
}
echo "==> verification"
verify || { echo "!! REHEARSAL FAILED: verification"; exit 1; }

echo "==> second run of the three data migrations (must change nothing)"
BEFORE=$(psql_in -tA -c "select count(*) from activity")
for f in supabase/migrations/20260125000[123]00_*.sql; do psql_in -q -f - < "$f" >/dev/null 2>&1; done
AFTER=$(psql_in -tA -c "select count(*) from activity")
[ "$BEFORE" = "$AFTER" ] || { echo "!! REHEARSAL FAILED: a re-run wrote $((AFTER - BEFORE)) activity rows"; exit 1; }
verify >/dev/null || { echo "!! REHEARSAL FAILED: verification after re-run"; exit 1; }
echo "    ok  no change on re-run ($AFTER activity rows before and after)"

echo "==> recovery (maintenance/2026-09-29_restore_from_backup.sql)"
psql_in -q -f - < supabase/maintenance/2026-09-29_restore_from_backup.sql >/dev/null
psql_in -tA -F' ' -c "select 'restored:', (select count(*) from subteams where archived_at is null) || ' active departments,',
  (select count(*) from tasks) || ' tasks,', (select count(*) from handover_notes) || ' handover notes,',
  (select count(*) from clauses where source_page is not null) || ' paged clauses,',
  (select string_agg(state::text, ',' order by title) from tasks where title in (
     'Submit official SDU form for new student organization', 'Establish competition main tasks and deadlines',
     'Register organization as non-profit to get business CVR', 'Open organization bank account (Danske Bank)'))"
echo "==> REHEARSAL PASSED — reconciliation verified on the hosted data copy, re-run is a no-op, recovery restores the snapshot"
