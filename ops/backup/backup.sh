#!/usr/bin/env bash
# Dumps the database, builds the manifest, encrypts to every recipient (Ultraplan Phase 4;
# ARCHITECTURE.md section 7; requirements BAK-01, 02, 05, 06, 07).
#
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE [PGSSLMODE]   login of backup_reader
#   BACKUP_RECIPIENTS      age recipients file          (default: ops/backup/recipients.txt)
#   BACKUP_OUT_DIR         where the result is written  (default: ./backup-out)
#   BACKUP_MAX_DUMP_BYTES  fail if the dumps are bigger (default 100 MB)
#   BACKUP_MAX_DB_BYTES    fail if the database is bigger (default 400 MB; the free plan stops at 500 MB)
#   BACKUP_STAMP           UTC time stamp override, for tests (default: now)
#   BACKUP_RETRY_SLEEP     seconds between consistency retries (default 5)
#   BACKUP_PG_DOCKER_IMAGE run pg_dump/psql in this image (e.g. postgres:17) when the host has none
#
# Result in BACKUP_OUT_DIR:
#   reqon-backup-<stamp>.tar.age        public.dump + auth.dump + manifest.json, age-encrypted
#   reqon-backup-<stamp>.meta.json      NOT secret: stamp, migration version, sizes, sha256 of the encrypted
#                                       file, recipient fingerprints — what the status panel shows
#   failure-code                        only after a failure: one word for people (dump_too_big, …)
#
# The plaintext dump exists only in a private temporary directory, is overwritten and removed on exit.
# Exit status: 0 ok · 2 configuration · 3 size guard · 4 database kept changing · 5 a tool failed.
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

JSON="node $BACKUP_DIR/json.mjs"
OUT="${BACKUP_OUT_DIR:-./backup-out}"
RECIPIENTS_FILE="${BACKUP_RECIPIENTS:-$BACKUP_DIR/recipients.txt}"
MAX_DUMP="${BACKUP_MAX_DUMP_BYTES:-104857600}"
MAX_DB="${BACKUP_MAX_DB_BYTES:-419430400}"
STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "BACKUP_STAMP must look like 20261008T031700Z" 2

mkdir -p "$OUT"
rm -f "$OUT/failure-code"
WORK="$(mktemp -d)"
cleanup() {
  wipe "$WORK"/*.dump "$WORK"/*.json "$WORK"/*.tar 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "$2" > "$OUT/failure-code"; die "$1" "$3"; }

for tool in age node tar sha256sum; do need "$tool"; done
if [ -z "${BACKUP_PG_DOCKER_IMAGE:-}" ]; then need pg_dump; need psql; else need docker; fi
for v in PGHOST PGUSER PGPASSWORD; do [ -n "${!v:-}" ] || die "$v is not set" 2; done
export PGDATABASE="${PGDATABASE:-postgres}"

# ---------------------------------------------------------------- recipients
# Validated in THIS shell (a failure inside process substitution would not stop the script).
RECIPIENT_LINES="$(read_recipients "$RECIPIENTS_FILE")" || exit 2
mapfile -t RECIPIENTS <<<"$RECIPIENT_LINES"
FINGERPRINTS=()
AGE_ARGS=()
for r in "${RECIPIENTS[@]}"; do FINGERPRINTS+=("$(fingerprint "$r")"); AGE_ARGS+=(-r "$r"); done
log "encrypting to ${#RECIPIENTS[@]} recipient(s)"

# ------------------------------------------------------------------ the guard
q() { pgrun psql -X -At -v ON_ERROR_STOP=1 -c "$1"; }
DB_BYTES="$(q 'select pg_database_size(current_database())')" || fail "cannot reach the database" connection_failed 5
[[ "$DB_BYTES" =~ ^[0-9]+$ ]] || fail "unexpected answer from the database" connection_failed 5
log "database size: $DB_BYTES bytes (limit $MAX_DB)"
[ "$DB_BYTES" -le "$MAX_DB" ] || fail "the database is over the $MAX_DB byte limit — raise it deliberately, or investigate the growth" database_too_big 3

# ---------------------------------------------- dump, with a before/after consistency check
manifest() { pgrun psql -X -q -At -v ON_ERROR_STOP=1 < "$BACKUP_DIR/manifest.sql" | tail -n 1; }
dump_public() {
  pgrun pg_dump --format=custom --compress=zstd:9 --no-owner --no-privileges \
    --schema=public --schema=supabase_migrations > "$WORK/public.dump"
}
dump_auth() {
  pgrun pg_dump --format=custom --compress=zstd:9 --no-owner --no-privileges \
    --table=auth.users --table=auth.identities > "$WORK/auth.dump"
}

CONSISTENT=0
for attempt in 1 2 3; do
  BEFORE="$(manifest)" || fail "the manifest query failed" dump_failed 5
  dump_public || fail "pg_dump failed for the public data" dump_failed 5
  dump_auth || fail "pg_dump failed for the auth tables" dump_failed 5
  AFTER="$(manifest)" || fail "the manifest query failed" dump_failed 5
  if [ "$BEFORE" = "$AFTER" ]; then CONSISTENT=1; break; fi
  log "the data changed while it was being dumped (attempt $attempt of 3)"
  sleep "${BACKUP_RETRY_SLEEP:-5}"
done
[ "$CONSISTENT" = 1 ] || fail "the database kept changing during the dump" database_busy 4

PUBLIC_BYTES="$(stat -c %s "$WORK/public.dump")"; AUTH_BYTES="$(stat -c %s "$WORK/auth.dump")"
DUMP_BYTES=$((PUBLIC_BYTES + AUTH_BYTES))
log "dump size: $DUMP_BYTES bytes (limit $MAX_DUMP)"
[ "$DUMP_BYTES" -le "$MAX_DUMP" ] || fail "the dump is over the $MAX_DUMP byte limit" dump_too_big 3

# A dump that pg_restore cannot even list is useless; find out now, not on the worst day.
for f in public auth; do
  pgrun pg_restore --list < "$WORK/$f.dump" > /dev/null || fail "the $f dump cannot be read back" dump_unreadable 5
done

# ------------------------------------------------------------------- manifest
printf '%s\n' "$BEFORE" > "$WORK/query.json"
$JSON manifest "$WORK/query.json" "$STAMP" "$DB_BYTES" \
  "public.dump=$PUBLIC_BYTES:$(sha256sum "$WORK/public.dump" | cut -d' ' -f1)" \
  "auth.dump=$AUTH_BYTES:$(sha256sum "$WORK/auth.dump" | cut -d' ' -f1)" > "$WORK/manifest.json"
wipe "$WORK/query.json"
read -r TABLES ROWS MIGRATION < <($JSON summary "$WORK/manifest.json")
[ -n "$MIGRATION" ] || fail "the database has no migration history" dump_failed 5
[ "$TABLES" -ge 1 ] || fail "the manifest lists no tables" dump_failed 5
log "manifest: $TABLES tables, $ROWS rows, migration $MIGRATION"

# ------------------------------------------------------------------- encrypt
tar -C "$WORK" -cf "$WORK/bundle.tar" manifest.json public.dump auth.dump
NAME="reqon-backup-$STAMP"
age "${AGE_ARGS[@]}" -o "$OUT/$NAME.tar.age.partial" "$WORK/bundle.tar" || fail "encryption failed" encrypt_failed 5
mv "$OUT/$NAME.tar.age.partial" "$OUT/$NAME.tar.age"
SIZE="$(stat -c %s "$OUT/$NAME.tar.age")"
SHA="$(sha256sum "$OUT/$NAME.tar.age" | cut -d' ' -f1)"

FP_LIST="$(IFS=,; echo "${FINGERPRINTS[*]}")"
$JSON meta "$WORK/manifest.json" "$STAMP" "$NAME.tar.age" "$SHA" "$SIZE" "$DB_BYTES" "$FP_LIST" > "$OUT/$NAME.meta.json"

log "wrote $NAME.tar.age ($SIZE bytes, sha256 ${SHA:0:12}…)"
