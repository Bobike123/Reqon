#!/usr/bin/env bash
# Generates src/lib/database.types.ts from a migrated DISPOSABLE Postgres,
# never the hosted project — the Phase 1 prerequisite in
# docs/redesign/phases/00.md ("Add local type generation... Do not connect
# to production just to make local type generation work").
#
#   npm run types:gen:local
#
# Starts the same disposable postgres:17 container scripts/verify_db.sh
# uses, applies local_auth_shim.sql and every migration, points
# scripts/gen-types.mjs at it via LOCAL_DB_URL (which uses the CLI's own
# --db-url flag instead of --project-id), and always tears the container
# down on exit. gen-types.mjs keeps its own atomic write; this script does
# not touch src/lib/database.types.ts directly.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CONTAINER="reqon-gen-types-local-$$"
PORT="${GEN_TYPES_LOCAL_PORT:-55433}"
IMAGE="${VERIFY_DB_IMAGE:-postgres:17}"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting a disposable $IMAGE container ($CONTAINER, port $PORT)"
docker run --rm -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p "$PORT:5432" "$IMAGE" >/dev/null

psql_in() { docker exec -i "$CONTAINER" psql -U postgres -d postgres "$@"; }

echo -n "==> waiting for it to accept connections"
READY=0
for _ in $(seq 1 60); do
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

echo "==> generating types from the migrated disposable schema"
LOCAL_DB_URL="postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres" \
  node scripts/gen-types.mjs
