#!/usr/bin/env bash
# Runbook B for real, locally (Ultraplan Phase 5; RST-12): "the whole project is lost".
#
#   npm run restore:drill:local
#
# 1. Backs up the local dev stack (read-only, with throw-away age keys and a throw-away password on
#    backup_reader that is removed again).
# 2. Starts a SECOND, isolated Supabase stack (project id reqon_runbook_b, ports 553xx) from a copy of
#    this repository's supabase/config.toml and migrations — a brand-new project with every migration
#    applied, exactly what `supabase db push` gives a replacement project.
# 3. Runs ops/backup/drill.sh against it: exact restore (auth included), equality with the backup,
#    idempotence, then Runbook A (lost / deleted / changed rows, merge, undo) on top.
# 4. Signs in through the new project's Auth with a restored account (if the dev account
#    dev@reqon.local exists): proves logins and password hashes survived.
# 5. Stops the second stack and deletes its data (`supabase stop --no-backup`), pass or fail.
#
# Needs Docker, age, node and a running dev stack (`npx supabase start`). Takes a few minutes.
# RUNBOOK_KEEP=1 keeps the second project (and the backup + key) for inspection.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 2
ROOT="$PWD"; OPS="$ROOT/ops/backup"
command -v age-keygen >/dev/null || { echo "age is not installed" >&2; exit 2; }

STATUS="$(npx supabase status -o env 2>/dev/null)" || { echo "the dev stack is not running (npx supabase start)" >&2; exit 2; }
getenv() { sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" <<<"$2" | head -1; }
case "$(getenv API_URL "$STATUS")" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: the dev stack is not local" >&2; exit 2 ;; esac
DEV_DB_PORT="$(getenv DB_URL "$STATUS" | sed -E 's#.*:([0-9]+)/.*#\1#')"

T="$(mktemp -d)"
export TMPDIR="$T/tmp"; mkdir -p "$TMPDIR"
STACK="$T/stack"
PW="local-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')"
cleanup() {
  docker exec supabase_db_reqon psql -U postgres -qc "alter role backup_reader password null" >/dev/null 2>&1
  if [ -n "${RUNBOOK_KEEP:-}" ]; then
    echo "RUNBOOK_KEEP: the second project is still running; files in $T. Remove with: npx supabase stop --workdir $STACK --no-backup && rm -rf $T"
    return
  fi
  if [ -d "$STACK/supabase" ]; then npx supabase stop --workdir "$STACK" --no-backup >/dev/null 2>&1; fi
  rm -rf "$T"
}
trap cleanup EXIT

echo "==> 1. back up the dev stack (throw-away keys)"
age-keygen -o "$T/drill.key" >/dev/null 2>&1
grep -o 'age1[0-9a-z]*' "$T/drill.key" | head -1 > "$T/recipients.txt"
docker exec supabase_db_reqon psql -U postgres -qc "alter role backup_reader password '$PW'" >/dev/null || { echo "is migration 20260133000000 applied to the dev stack?" >&2; exit 1; }
PGHOST=127.0.0.1 PGPORT="$DEV_DB_PORT" PGUSER=backup_reader PGPASSWORD="$PW" PGDATABASE=postgres \
  BACKUP_PG_DOCKER_IMAGE="${BACKUP_PG_DOCKER_IMAGE:-postgres:17}" BACKUP_RECIPIENTS="$T/recipients.txt" BACKUP_OUT_DIR="$T/out" \
  "$OPS/backup.sh" || exit 1
docker exec supabase_db_reqon psql -U postgres -qc "alter role backup_reader password null" >/dev/null
FILE="$(ls "$T"/out/reqon-backup-*.tar.age)"

echo
echo "==> 2. start a brand-new, isolated project (reqon_runbook_b, ports 553xx)"
mkdir -p "$STACK/supabase"
cp -r "$ROOT/supabase/migrations" "$STACK/supabase/"
sed -E -e 's/^project_id = .*/project_id = "reqon_runbook_b"/' \
       -e 's/\b543([0-9]{2})\b/553\1/g' -e 's/\b8083\b/9083/' \
       "$ROOT/supabase/config.toml" > "$STACK/supabase/config.toml"
# Only what a database restore needs: no Studio, mail, analytics, functions or realtime in the throw-away project.
node -e '
  const fs = require("fs"); const p = process.argv[1]; let s = fs.readFileSync(p, "utf8");
  for (const section of ["studio", "local_smtp", "inbucket", "analytics", "edge_runtime", "realtime"]) {
    s = s.replace(new RegExp(`(\\n\\[${section}\\]\\n(?:[^\\[][^\\n]*\\n)*?)enabled = true`), "$1enabled = false");
  }
  fs.writeFileSync(p, s);' "$STACK/supabase/config.toml"
grep -q 'project_id = "reqon_runbook_b"' "$STACK/supabase/config.toml" || { echo "could not prepare the second stack's config" >&2; exit 1; }
npx supabase start --workdir "$STACK" > "$T/start.log" 2>&1 || { tail -30 "$T/start.log" >&2; echo "the second stack did not start" >&2; exit 1; }
B="$(npx supabase status --workdir "$STACK" -o env 2>/dev/null)"
B_API="$(getenv API_URL "$B")"; B_ANON="$(getenv ANON_KEY "$B")"
B_DB_PORT="$(getenv DB_URL "$B" | sed -E 's#.*:([0-9]+)/.*#\1#')"
[ "$B_DB_PORT" != "$DEV_DB_PORT" ] || { echo "refusing: the second stack shares the dev database port" >&2; exit 1; }
echo "    second project up: API $B_API, database port $B_DB_PORT"

echo
echo "==> 3. the drill (Runbook B, then Runbook A) against the second project"
PGHOST=127.0.0.1 PGPORT="$B_DB_PORT" PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres \
  BACKUP_PG_DOCKER_IMAGE="${BACKUP_PG_DOCKER_IMAGE:-postgres:17}" \
  "$OPS/drill.sh" "$FILE" "$T/drill.key" || exit 1

echo
echo "==> 4. a restored account can sign in to the new project"
DEV_EMAIL="${RUNBOOK_LOGIN_EMAIL:-dev@reqon.local}"; DEV_PASSWORD="${RUNBOOK_LOGIN_PASSWORD:-devpassword123}"
if docker exec supabase_db_reqon psql -U postgres -qtA -c "select 1 from auth.users where email = '$DEV_EMAIL'" | grep -q 1; then
  CODE="$(curl -s -o "$T/login.json" -w '%{http_code}' -X POST "$B_API/auth/v1/token?grant_type=password" \
    -H "apikey: $B_ANON" -H 'content-type: application/json' --data "{\"email\":\"$DEV_EMAIL\",\"password\":\"$DEV_PASSWORD\"}")"
  if [ "$CODE" = "200" ] && grep -q access_token "$T/login.json"; then
    echo "    ok: $DEV_EMAIL signed in to the restored project with its old password"
  else
    echo "    FAIL: sign-in answered HTTP $CODE" >&2; exit 1
  fi
else
  echo "    skipped: no $DEV_EMAIL account in the dev stack"
fi

echo
echo "==> RUNBOOK B PASSED (the second project is being removed)"
