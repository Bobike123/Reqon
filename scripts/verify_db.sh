#!/usr/bin/env bash
# Applies the schema from a clean checkout — local_auth_shim.sql, then every
# migration in supabase/migrations, in order — to a disposable Postgres
# container, runs every supabase/tests/*.sql file against it, and proves
# promote_proposal() is safe under REAL concurrency (two actual psql
# processes racing, not just two statements in one session).
#
#   npm run test:db        (or: bash scripts/verify_db.sh)
#
# Exit status 0 = every check passed, 1 = anything failed. CI's database job
# runs exactly this.
#
# Needs Docker and network access to pull postgres:17 once. Nothing here
# touches a real Supabase project — the container is removed on exit, pass or
# fail (see the trap below), and every supabase/tests/*.sql file rolls back
# everything it does on its own.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CONTAINER="reqon-verify-db-$$"
PORT="${VERIFY_DB_PORT:-55432}"
# Same major version as the hosted project (supabase/config.toml
# [db] major_version) — testing on an older major than production proves less.
IMAGE="${VERIFY_DB_IMAGE:-postgres:17}"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> starting a disposable $IMAGE container ($CONTAINER, port $PORT)"
docker run --rm -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p "$PORT:5432" "$IMAGE" >/dev/null

psql_in() { docker exec -i "$CONTAINER" psql -U postgres -d postgres "$@"; }

echo -n "==> waiting for it to accept connections"
READY=0
for _ in $(seq 1 60); do
  # The image's first-boot init runs a temporary server on the Unix socket
  # only, then restarts. A socket probe can succeed against that temporary
  # server; a TCP probe only succeeds against the final one.
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    READY=1; echo " ready"; break
  fi
  echo -n "."
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo
  echo "!! the database never accepted connections"
  docker logs "$CONTAINER" 2>&1 | tail -20
  exit 1
fi

echo "==> applying scripts/local_auth_shim.sql"
psql_in -v ON_ERROR_STOP=1 -f - < scripts/local_auth_shim.sql >/dev/null

echo "==> applying migrations"
for f in supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  psql_in -v ON_ERROR_STOP=1 -f - < "$f" >/dev/null
done

echo "==> minimal fixture for the concurrency check"
FIXTURE_SQL=$(cat <<'SQL'
do $$
declare
  pre uuid := '00000000-0000-4000-8000-0000000000aa';
  prop uuid;
  season uuid;
begin
  insert into auth.users (id, email) values (pre, 'verify-pre@roles.test');
  insert into members (id, full_name, role) values (pre, 'Verify President', 'President');
  insert into member_roles (member_id, role) values (pre, 'president');
  -- Not is_current — 20260101000001's reference data already marks a season
  -- current, and promote_proposal() takes its season explicitly, so this one
  -- never needs to be.
  insert into seasons (label, is_current) values ('VERIFY-CONCURRENCY', false) returning id into season;
  insert into task_proposals (season_id, title, raised_by) values (season, 'Race me', pre) returning id into prop;
  raise notice 'FIXTURE % %', prop, season;
end $$;
SQL
)
FIXTURE_OUT=$(psql_in -v ON_ERROR_STOP=1 -c "$FIXTURE_SQL" 2>&1)
FIXTURE_LINE=$(echo "$FIXTURE_OUT" | command grep -oE 'FIXTURE [0-9a-f-]+ [0-9a-f-]+')
PROP_ID=$(echo "$FIXTURE_LINE" | awk '{print $2}')
SEASON_ID=$(echo "$FIXTURE_LINE" | awk '{print $3}')
if [ -z "$PROP_ID" ] || [ -z "$SEASON_ID" ]; then
  echo "!! could not read the fixture proposal/season id from:"
  echo "$FIXTURE_OUT"
  exit 1
fi

RACE_SQL=$(cat <<SQL
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000aa', true);
select pg_sleep(0.3);
select (t.task).id as task_id, t.created
from promote_proposal('$PROP_ID', '$SEASON_ID') as t;
commit;
SQL
)
echo "==> racing two real psql processes against promote_proposal() for the SAME proposal"
psql_in -f - <<<"$RACE_SQL" > "$WORK/race_a.txt" 2>&1 &
RACE_A=$!
psql_in -f - <<<"$RACE_SQL" > "$WORK/race_b.txt" 2>&1 &
RACE_B=$!
wait "$RACE_A" "$RACE_B"

TASK_A=$(command grep -A2 'task_id' "$WORK/race_a.txt" | tail -1 | awk '{print $1}')
TASK_B=$(command grep -A2 'task_id' "$WORK/race_b.txt" | tail -1 | awk '{print $1}')
CREATED_COUNT=$(cat "$WORK/race_a.txt" "$WORK/race_b.txt" | command grep -c ' t$' || true)
TASK_COUNT=$(psql_in -tA -c "select count(*) from tasks where season_id = (select id from seasons where label = 'VERIFY-CONCURRENCY')")

RACE_OK=1
if [ "$TASK_A" != "$TASK_B" ] || [ -z "$TASK_A" ]; then
  echo "!! FAIL: the two concurrent calls returned different task ids ($TASK_A vs $TASK_B)"
  RACE_OK=0
fi
if [ "$CREATED_COUNT" != "1" ]; then
  echo "!! FAIL: expected exactly one of the two concurrent calls to report created=true, got $CREATED_COUNT"
  RACE_OK=0
fi
if [ "$(echo "$TASK_COUNT" | tr -d '[:space:]')" != "1" ]; then
  echo "!! FAIL: expected exactly one task row for the raced proposal, found $TASK_COUNT"
  RACE_OK=0
fi
if [ "$RACE_OK" = "1" ]; then
  echo "    ok  two genuinely concurrent promote_proposal() calls on the same proposal"
  echo "        converged on task $TASK_A, exactly one created=true, exactly one task row"
else
  echo "--- session A ---"; cat "$WORK/race_a.txt"
  echo "--- session B ---"; cat "$WORK/race_b.txt"
fi

echo "==> running supabase/tests/*.sql"
# Each test file reports its verdict by deliberately raising an exception —
# that is what rolls every fixture back, so it is kept. This loop turns that
# into a machine-checkable result. A file passes only if its output holds
# EXACTLY ONE `ERROR:` line and that line is its own "<NAME> CHECKS PASSED —
# all N checks" verdict. Any other error (a helper that failed to create, a
# syntax error, a FAILED verdict, a second exception) fails the file, so a
# broken setup step can never hide behind a later passing block.
shopt -s nullglob
TEST_FILES=(supabase/tests/*.sql)
if [ "${#TEST_FILES[@]}" -eq 0 ]; then
  echo "!! no supabase/tests/*.sql files found — refusing to report success on zero tests"
  exit 1
fi
OVERALL_OK=1
FILES_PASSED=0
CHECKS_PASSED=0
for f in "${TEST_FILES[@]}"; do
  name=$(basename "$f")
  OUT=$(psql_in -f - < "$f" 2>&1 || true)
  ERROR_LINES=$(echo "$OUT" | command grep -c 'ERROR:' || true)
  VERDICT=$(echo "$OUT" | command grep -oE 'ERROR:  [A-Z/ ]+ CHECKS PASSED — all [0-9]+ checks' || true)
  if [ "$ERROR_LINES" = "1" ] && [ -n "$VERDICT" ]; then
    N=$(echo "$VERDICT" | command grep -oE 'all [0-9]+' | awk '{print $2}')
    FILES_PASSED=$((FILES_PASSED + 1))
    CHECKS_PASSED=$((CHECKS_PASSED + N))
    echo "    ok    $name — ${VERDICT#ERROR:  }"
  else
    OVERALL_OK=0
    echo "    FAIL  $name ($ERROR_LINES error line(s); expected exactly one PASSED verdict)"
    echo "$OUT" | sed 's/^/          /'
  fi
done
echo "==> $FILES_PASSED/${#TEST_FILES[@]} SQL test files passed, $CHECKS_PASSED checks in total"

if [ "$RACE_OK" != "1" ] || [ "$OVERALL_OK" != "1" ]; then
  echo "==> VERIFY FAILED"
  exit 1
fi
echo "==> VERIFY PASSED — schema, RPCs and every supabase/tests/*.sql check are green from a clean checkout"
