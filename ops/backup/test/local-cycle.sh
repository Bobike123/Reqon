#!/usr/bin/env bash
# Full local proof of the backup chain (Ultraplan Phase 4): runs every script in ops/backup against the
# LOCAL Supabase stack with throw-away age keys, and checks what must hold — that a backup is complete,
# readable by every recipient and nobody else, tamper-evident, size-guarded, consistent, that no plaintext
# is left behind, and that each destination, the status record, the purge and the freshness check work.
#
#   npm run backup:test:local        (needs: Docker, age, rclone, node, a running `supabase start`;
#                                     for the status-record and purge checks also
#                                     `node scripts/attachments/functions-env-local.mjs` and
#                                     `npx supabase functions serve --env-file supabase/functions/.env.local`)
#
# Local only by construction: it refuses any database that is not 127.0.0.1/localhost. Everything it
# creates (a login password for backup_reader, a scratch table, bucket objects, status rows) is removed at
# the end, pass or fail. Exit status 0 = every check passed.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 2
ROOT="$PWD"
OPS="$ROOT/ops/backup"

PASS=0; FAIL=0; SKIP=0
ok() { PASS=$((PASS + 1)); echo "    ok    $1"; }
bad() { FAIL=$((FAIL + 1)); echo "    FAIL  $1"; }
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi; }
expect_exit() { local want="$1" label="$2"; shift 2; "$@" >/dev/null 2>&1; local got=$?; if [ "$got" = "$want" ]; then ok "$label"; else bad "$label (exit $got, wanted $want)"; fi; }
section() { echo; echo "==> $1"; }

for t in docker age age-keygen rclone node tar curl; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done
STATUS="$(npx supabase status -o env 2>/dev/null)" || { echo "the local stack is not running (npx supabase start)" >&2; exit 2; }
getenv() { sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" <<<"$STATUS" | head -1; }
API="$(getenv API_URL)"
case "$API" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: the stack is not local" >&2; exit 2 ;; esac
DBURL_PORT="$(getenv DB_URL | sed -E 's#.*:([0-9]+)/.*#\1#')"
SERVICE="$(getenv SERVICE_ROLE_KEY)"; S3KEY="$(getenv S3_PROTOCOL_ACCESS_KEY_ID)"; S3SECRET="$(getenv S3_PROTOCOL_ACCESS_KEY_SECRET)"
sql() { docker exec supabase_db_reqon psql -U postgres -qtA -v ON_ERROR_STOP=1 -c "$1"; }

T="$(mktemp -d)"
export TMPDIR="$T/tmp"; mkdir -p "$TMPDIR"
PW="local-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export PGHOST=127.0.0.1 PGPORT="$DBURL_PORT" PGUSER=backup_reader PGPASSWORD="$PW" PGDATABASE=postgres
export BACKUP_PG_DOCKER_IMAGE="${BACKUP_PG_DOCKER_IMAGE:-postgres:17}"

# rclone remotes: the local stack's S3 for "R2" and the attachments bucket; a plain folder for "Drive".
export RCLONE_CONFIG_BKR2_TYPE=s3 RCLONE_CONFIG_BKR2_PROVIDER=Other RCLONE_CONFIG_BKR2_ACCESS_KEY_ID="$S3KEY" RCLONE_CONFIG_BKR2_SECRET_ACCESS_KEY="$S3SECRET" RCLONE_CONFIG_BKR2_ENDPOINT="$API/storage/v1/s3" RCLONE_CONFIG_BKR2_REGION=local
export RCLONE_CONFIG_BKATT_TYPE=s3 RCLONE_CONFIG_BKATT_PROVIDER=Other RCLONE_CONFIG_BKATT_ACCESS_KEY_ID="$S3KEY" RCLONE_CONFIG_BKATT_SECRET_ACCESS_KEY="$S3SECRET" RCLONE_CONFIG_BKATT_ENDPOINT="$API/storage/v1/s3" RCLONE_CONFIG_BKATT_REGION=local
export RCLONE_CONFIG_BKDRIVE_TYPE=local
BUCKET=backups-local; ATT=attachments-local
env -u TMPDIR node "$ROOT/scripts/attachments/local-buckets.mjs" || { echo "could not create the local test buckets" >&2; exit 2; }
R2="bkr2:$BUCKET"

cleanup() {
  sql "drop table if exists public.zz_backup_probe" >/dev/null 2>&1
  sql "delete from backup_runs where detail like 'cycle-test%' or migration_version = '20260133000000' and recorded_at > now() - interval '1 hour' and size_bytes = 4242" >/dev/null 2>&1
  sql "delete from attachment_purge_queue where object_keys && array['tasks/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000aa.jpg']" >/dev/null 2>&1
  sql "alter role backup_reader password null" >/dev/null 2>&1
  rclone delete "$R2" >/dev/null 2>&1 || true
  rclone delete "bkatt:$ATT/tasks/00000000-0000-4000-8000-000000000001" >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT

section "setup (local only)"
sql "alter role backup_reader password '$PW'" >/dev/null && ok "backup_reader got a throw-away local password" || { bad "cannot set the local password (is migration 20260133000000 applied?)"; exit 1; }
curl -s -o /dev/null -X POST "$API/storage/v1/bucket" -H "Authorization: Bearer $SERVICE" -H 'content-type: application/json' -d "{\"id\":\"$BUCKET\",\"name\":\"$BUCKET\",\"public\":false}"
for n in a b drill other; do age-keygen -o "$T/$n.key" >/dev/null 2>&1; grep -o 'age1[0-9a-z]*' "$T/$n.key" | head -1 > "$T/$n.pub"; done
{ echo "# test recipients"; echo "$(cat "$T/a.pub")  # president"; cat "$T/b.pub"; echo; echo "$(cat "$T/drill.pub") # drill"; } > "$T/recipients.txt"
export BACKUP_RECIPIENTS="$T/recipients.txt"
OUT="$T/out"; export BACKUP_OUT_DIR="$OUT"
run_backup() { "$OPS/backup.sh"; }

section "configuration is refused, never guessed"
BACKUP_RECIPIENTS="$T/missing.txt" expect_exit 2 "a missing recipients file" run_backup
printf '# nobody here\n\n' > "$T/empty.txt"; BACKUP_RECIPIENTS="$T/empty.txt" expect_exit 2 "a recipients file listing nobody" run_backup
printf '%s\nnot-a-key\n' "$(cat "$T/a.pub")" > "$T/bad.txt"; BACKUP_RECIPIENTS="$T/bad.txt" expect_exit 2 "a line that is not an age key" run_backup
BACKUP_STAMP=yesterday expect_exit 2 "a malformed stamp" run_backup
PGPASSWORD=wrong expect_exit 5 "a wrong database password" run_backup
check "…reported as connection_failed" grep -qx connection_failed "$OUT/failure-code"
check "no encrypted file after a refused run" test -z "$(ls "$OUT"/*.tar.age 2>/dev/null)"

section "size guards (BAK-07)"
BACKUP_MAX_DB_BYTES=1000 expect_exit 3 "a database over its limit" run_backup
check "…reported as database_too_big" grep -qx database_too_big "$OUT/failure-code"
BACKUP_MAX_DUMP_BYTES=1000 expect_exit 3 "a dump over its limit" run_backup
check "…reported as dump_too_big" grep -qx dump_too_big "$OUT/failure-code"
check "…and nothing was written" test -z "$(ls "$OUT"/*.tar.age 2>/dev/null)"

section "a complete backup (BAK-01, 02, 05, 06)"
BACKUP_STAMP=20261007T031700Z run_backup > "$T/backup.log" 2>&1; echo "    (exit $?)"
FILE="$OUT/reqon-backup-20261007T031700Z.tar.age"; META="${FILE%.tar.age}.meta.json"
check "the encrypted file and its meta file exist" test -s "$FILE" -a -s "$META"
check "no failure code after success" test ! -e "$OUT/failure-code"
check "meta.sha256 is the real sha256 of the file" test "$(node "$OPS/json.mjs" get "$META" sha256)" = "$(sha256sum "$FILE" | cut -d' ' -f1)"
check "meta lists three recipient fingerprints" test "$(node "$OPS/json.mjs" get "$META" recipients | tr -cd ',' | wc -c)" = "2"
check "meta holds no key material" bash -c "! grep -q 'AGE-SECRET\|age1' '$META'"
check "the log shows counts only (no row, key or password)" bash -c "! grep -qiE 'AGE-SECRET|age1|$PW|insert|select |@' '$T/backup.log'"
check "the ciphertext shows no plaintext (no PGDMP header, no table names)" bash -c "! grep -qaE 'PGDMP|members|auth\.users' '$FILE'"
for k in a b drill; do check "recipient '$k' decrypts, checksums match and the live database equals the manifest" "$OPS/verify.sh" "$FILE" "$T/$k.key" --live; done
expect_exit 1 "a key that is not a recipient cannot decrypt" "$OPS/verify.sh" "$FILE" "$T/other.key"
check "no plaintext left in the temp directory" test -z "$(ls -A "$TMPDIR")"

section "the manifest equals independently counted rows"
age -d -i "$T/a.key" "$FILE" | tar -xO manifest.json > "$T/manifest.json"
for tbl in public.members public.tasks auth.users; do
  want="$(sql "select count(*) from $tbl")"; got="$(node "$OPS/json.mjs" get "$T/manifest.json" "tables/$tbl/rows")"
  [ "$want" = "$got" ] && ok "$tbl: $got rows" || bad "$tbl: manifest $got, database $want"
done
check "the manifest includes the migration history" test -n "$(node "$OPS/json.mjs" get "$T/manifest.json" "tables/supabase_migrations.schema_migrations/rows")"
check "the migration version equals the database's" test "$(node "$OPS/json.mjs" get "$T/manifest.json" migration_version)" = "$(sql 'select max(version) from supabase_migrations.schema_migrations')"

section "tampering is detected"
cp "$FILE" "$T/flip.tar.age"; cp "$META" "$T/flip.meta.json"; printf '\x00' | dd of="$T/flip.tar.age" bs=1 seek=300 conv=notrunc 2>/dev/null
expect_exit 1 "one flipped byte (against its meta file)" "$OPS/verify.sh" "$T/flip.tar.age" "$T/a.key"
rm "$T/flip.meta.json"; expect_exit 1 "one flipped byte (no meta file: the cipher itself refuses)" "$OPS/verify.sh" "$T/flip.tar.age" "$T/a.key"
head -c 5000 "$FILE" > "$T/cut.tar.age"; expect_exit 1 "a truncated file" "$OPS/verify.sh" "$T/cut.tar.age" "$T/a.key"
cp "$FILE" "$T/dbchange.tar.age"; cp "$META" "$T/dbchange.meta.json"
sql "create table public.zz_backup_probe (n bigserial primary key)" >/dev/null && sql "insert into public.zz_backup_probe default values" >/dev/null
expect_exit 1 "--live notices a table that appeared after the backup" "$OPS/verify.sh" "$FILE" "$T/a.key" --live
sql "drop table public.zz_backup_probe" >/dev/null
check "…and agrees again once it is gone" "$OPS/verify.sh" "$FILE" "$T/a.key" --live

section "a database that keeps changing is not backed up (consistency check)"
sql "create table public.zz_backup_probe (n bigserial primary key, at timestamptz default now())" >/dev/null
( while :; do sql "insert into public.zz_backup_probe default values" >/dev/null 2>&1; sleep 0.15; done ) & WRITER=$!
BACKUP_RETRY_SLEEP=1 BACKUP_STAMP=20261007T041700Z expect_exit 4 "writes during the dump fail the run" run_backup
kill $WRITER 2>/dev/null; wait $WRITER 2>/dev/null
check "…reported as database_busy" grep -qx database_busy "$OUT/failure-code"
sql "drop table public.zz_backup_probe" >/dev/null

section "R2 (BAK-03/04): daily, Sunday → weekly, the 1st → monthly"
cp "$FILE" "$OUT/keep.tar.age"; cp "$META" "$OUT/keep.meta.json"
mkdir -p "$T/pub"
publish_as() { # publish_as <stamp> → copies the verified backup under that stamp and publishes it
  local stamp="$1" d="$T/pub/$1"; mkdir -p "$d"
  cp "$FILE" "$d/reqon-backup-$stamp.tar.age"; sed "s/20261007T031700Z/$stamp/g" "$META" > "$d/reqon-backup-$stamp.meta.json"
  BACKUP_OUT_DIR="$d" BACKUP_R2_REMOTE="$R2" "$OPS/publish.sh"
}
publish_as 20261007T031700Z >/dev/null 2>&1 && ok "Wednesday 2026-10-07 is uploaded" || bad "Wednesday upload"
check "…only to daily/" test "$(cat "$T/pub/20261007T031700Z/published")" = "daily/reqon-backup-20261007T031700Z.tar.age"
publish_as 20261011T031700Z >/dev/null 2>&1; check "Sunday 2026-10-11 → daily/ and weekly/" test "$(tr '\n' ' ' < "$T/pub/20261011T031700Z/published")" = "daily/reqon-backup-20261011T031700Z.tar.age weekly/reqon-backup-20261011T031700Z.tar.age "
publish_as 20261101T031700Z >/dev/null 2>&1; check "Sunday 1 Nov 2026 → daily/, weekly/ and monthly/" test "$(wc -l < "$T/pub/20261101T031700Z/published")" = "3"
check "the bucket holds the encrypted bytes, identical to the local file" bash -c "rclone cat '$R2/daily/reqon-backup-20261007T031700Z.tar.age' | cmp - '$FILE'"
BACKUP_FOLDERS=bogus BACKUP_OUT_DIR="$T/pub/20261007T031700Z" BACKUP_R2_REMOTE="$R2" expect_exit 2 "an unknown folder is refused" "$OPS/publish.sh"
mkdir -p "$T/two"; cp "$FILE" "$FILE.copy" 2>/dev/null; cp "$FILE" "$T/two/reqon-backup-20261001T000000Z.tar.age"; cp "$FILE" "$T/two/reqon-backup-20261002T000000Z.tar.age"
BACKUP_OUT_DIR="$T/two" BACKUP_R2_REMOTE="$R2" expect_exit 2 "two backup files in one folder are refused (no guessing)" "$OPS/publish.sh"

section "freshness (BAK-08)"
BACKUP_R2_REMOTE="$R2" BACKUP_NOW=2026-11-01T13:17:00Z expect_exit 0 "10 hours after the newest backup: fresh" "$OPS/freshness.sh"
BACKUP_R2_REMOTE="$R2" BACKUP_NOW=2026-11-03T04:00:00Z expect_exit 1 "48.7 hours after: stale" "$OPS/freshness.sh"
BACKUP_R2_REMOTE="bkr2:$BUCKET/empty-area" expect_exit 1 "no backup at all: fails" "$OPS/freshness.sh"
BACKUP_R2_REMOTE="$R2" BACKUP_MAX_AGE_HOURS=1000 BACKUP_NOW=2026-11-03T04:00:00Z expect_exit 0 "the limit is configurable" "$OPS/freshness.sh"

section "private GitHub repository (BAK-03)"
git init --quiet --bare "$T/remote.git"
export BACKUP_GIT_URL="file://$T/remote.git" BACKUP_GIT_KEEP=2
for s in 20261004T031700Z 20261011T031700Z 20261018T031700Z; do
  d="$T/pub/$s"; [ -d "$d" ] || { mkdir -p "$d"; cp "$FILE" "$d/reqon-backup-$s.tar.age"; cp "$META" "$d/reqon-backup-$s.meta.json"; }
  BACKUP_OUT_DIR="$d" "$OPS/push-github.sh" >/dev/null 2>&1 && ok "pushed $s" || bad "push $s"
done
git clone --quiet --branch main "file://$T/remote.git" "$T/check" 2>/dev/null
check "only the newest 2 weekly files are kept" test "$(ls "$T/check/weekly"/*.tar.age | wc -l)" = "2"
check "the oldest was pruned, the newest kept" bash -c "test ! -e '$T/check/weekly/reqon-backup-20261004T031700Z.tar.age' && test -e '$T/check/weekly/reqon-backup-20261018T031700Z.tar.age'"
check "the repository holds the ciphertext byte for byte" cmp "$T/check/weekly/reqon-backup-20261018T031700Z.tar.age" "$FILE"
check "the repository holds nothing but weekly/ files" test "$(git -C "$T/check" ls-files | grep -vc '^weekly/')" = "0"
BACKUP_GIT_SSH_KEY=/nonexistent expect_exit 2 "a deploy key without a pinned known_hosts is refused" env BACKUP_OUT_DIR="$T/pub/20261018T031700Z" "$OPS/push-github.sh"
BACKUP_GIT_URL="file://$T/nope.git" expect_exit 5 "an unreachable repository fails the step" env BACKUP_OUT_DIR="$T/pub/20261018T031700Z" "$OPS/push-github.sh"
unset BACKUP_GIT_URL BACKUP_GIT_KEEP

section "Google Drive copy (BAK-03/04), a folder stands in for the Drive remote"
export BACKUP_DRIVE_REMOTE="bkdrive:$T/drive" BACKUP_DRIVE_KEEP=2
for s in 20261004T031700Z 20261011T031700Z 20261018T031700Z; do BACKUP_OUT_DIR="$T/pub/$s" "$OPS/push-drive.sh" >/dev/null 2>&1 && ok "copied $s" || bad "copy $s"; done
check "only the newest 2 weekly dumps are kept" test "$(ls "$T/drive/weekly" | wc -l)" = "2"
check "the copy equals the original" cmp "$T/drive/weekly/reqon-backup-20261018T031700Z.tar.age" "$FILE"
unset BACKUP_DRIVE_REMOTE BACKUP_DRIVE_KEEP

section "media mirror, every file encrypted (BAK-03)"
PHOTO="$T/photo.jpg"; head -c 20000 /dev/urandom > "$PHOTO"; echo "PLAINTEXT-MARKER-xyz" >> "$PHOTO"
K1=tasks/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000aa.jpg
K2=tasks/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000aa.thumb.webp
rclone copyto "$PHOTO" "bkatt:$ATT/$K1" >/dev/null 2>&1; head -c 900 /dev/urandom | rclone rcat "bkatt:$ATT/$K2" >/dev/null 2>&1
export BACKUP_MEDIA_SRC="bkatt:$ATT/tasks/00000000-0000-4000-8000-000000000001" BACKUP_MEDIA_DEST="bkdrive:$T/media"
"$OPS/media-mirror.sh" > "$T/mirror.log" 2>&1; check "the first run copies the two files" grep -q '2 new file' "$T/mirror.log"
"$OPS/media-mirror.sh" > "$T/mirror.log" 2>&1; check "a second run copies nothing new" grep -q '0 new file' "$T/mirror.log"
check "the mirror holds .age files" test -s "$T/media/00000000-0000-4000-8000-0000000000aa.jpg.age"
check "a recipient gets the original bytes back" bash -c "age -d -i '$T/b.key' '$T/media/00000000-0000-4000-8000-0000000000aa.jpg.age' | cmp - '$PHOTO'"
check "the mirror contains no plaintext" bash -c "! grep -raq PLAINTEXT-MARKER '$T/media'"
BACKUP_MEDIA_MAX=1 BACKUP_MEDIA_DEST="bkdrive:$T/media2" expect_exit 0 "BACKUP_MEDIA_MAX bounds one run" "$OPS/media-mirror.sh"
check "…leaving the rest for the next run" test "$(ls "$T/media2" | wc -l)" = "1"
unset BACKUP_MEDIA_SRC BACKUP_MEDIA_DEST

section "status record and purge through the Edge Functions (BAK-09, BAK-12)"
FN_ENV="$ROOT/supabase/functions/.env.local"
if [ -r "$FN_ENV" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$API/functions/v1/attachment-upload-url" || true)" = "200" ] && grep -q '^BACKUP_RECORD_SECRET=' "$FN_ENV"; then
  BACKUP_RECORD_SECRET="$(sed -n 's/^BACKUP_RECORD_SECRET=//p' "$FN_ENV")"; ATTACHMENTS_PURGE_SECRET="$(sed -n 's/^ATTACHMENTS_PURGE_SECRET=//p' "$FN_ENV")"
  export BACKUP_OUT_DIR="$OUT" SUPABASE_URL="$API" BACKUP_RECORD_SECRET ATTACHMENTS_PURGE_SECRET
  expect_exit 5 "backup-record refuses a wrong secret" env BACKUP_RECORD_SECRET=wrong-secret-wrong-secret-wrong-secret-xx "$OPS/record.sh" r2 ok
  "$OPS/record.sh" r2 ok > /dev/null 2>&1 && ok "an ok record is accepted" || bad "ok record"
  check "…and stored with the proof" test "$(sql "select count(*) from backup_runs where destination='r2' and ok and sha256 = '$(node "$OPS/json.mjs" get "$META" sha256)' and object_key = 'daily/reqon-backup-20261007T031700Z.tar.age' and cardinality(recipients) = 3")" = "1"
  "$OPS/record.sh" github fail cycle-test-upload_failed >/dev/null 2>&1 && ok "a failure record is accepted" || bad "failure record"
  check "…stored without proof" test "$(sql "select count(*) from backup_runs where destination='github' and not ok and detail = 'cycle-test-upload_failed' and sha256 is null")" = "1"
  echo "dump_too_big" > "$OUT/failure-code"; "$OPS/record.sh" drive fail > "$T/rec.log" 2>&1 || cat "$T/rec.log"; check "a failure without detail uses the failure-code file" test "$(sql "select count(*) from backup_runs where destination='drive' and detail = 'dump_too_big'")" = "1"
  sql "delete from backup_runs where destination in ('r2','github','drive') and recorded_at > now() - interval '1 hour'" >/dev/null
  sql "insert into attachment_purge_queue (attachment_id, task_id, kind, object_keys, size_bytes, reason, purge_after) values (gen_random_uuid(), null, 'photo', array['tasks/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000aa.jpg'], 100, 'deleted', now() - interval '1 day')" >/dev/null 2>&1 || sql "insert into attachment_purge_queue (kind, object_keys, size_bytes, reason, purge_after) values ('photo', array['tasks/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000aa.jpg'], 100, 'deleted', now() - interval '1 day')" >/dev/null
  "$OPS/purge.sh" > "$T/purge.log" 2>&1; check "purge.sh reports the due entry purged" grep -q '1 entr' "$T/purge.log"
  check "…and the object is gone from the bucket" test -z "$(rclone lsf "bkatt:$ATT/$K1" 2>/dev/null)"
  expect_exit 5 "purge refuses a wrong secret" env ATTACHMENTS_PURGE_SECRET=wrong-secret-wrong-secret-wrong-secret-xx "$OPS/purge.sh"
else
  SKIP=$((SKIP + 1)); echo "    SKIPPED  the Edge Functions are not served — run: node scripts/attachments/functions-env-local.mjs && npx supabase functions serve --env-file supabase/functions/.env.local"
fi

section "nothing left behind"
check "no plaintext in the temp directory" test -z "$(ls -A "$TMPDIR")"
rclone delete "$R2" >/dev/null 2>&1; rclone delete "bkatt:$ATT/tasks/00000000-0000-4000-8000-000000000001" >/dev/null 2>&1
check "the backups bucket is empty again" test -z "$(rclone lsf -R "$R2" 2>/dev/null)"
check "no test files remain in the attachments bucket" test -z "$(rclone lsf -R "bkatt:$ATT/tasks/00000000-0000-4000-8000-000000000001" 2>/dev/null)"
echo
echo "==> $PASS passed, $FAIL failed, $SKIP section(s) skipped"
[ "$FAIL" -eq 0 ] || exit 1
