#!/usr/bin/env bash
# Checks one backup file the way a restore would trust it (Ultraplan Phase 4; RST-02 groundwork):
#
#   verify.sh <reqon-backup-….tar.age> <age identity file> [--live]
#
#   1. the sha256 of the encrypted file equals the one in its .meta.json (when that file is next to it);
#   2. the identity can decrypt it;
#   3. the archive holds exactly manifest.json, public.dump and auth.dump;
#   4. each dump's size and sha256 equal the manifest, and pg_restore can list it;
#   5. with --live: the manifest equals the live database (row counts and md5 per table). Only meaningful
#      right after a backup, when nothing has changed; the PG* variables point at the database.
#
# Prints counts and table names only. Exit status 0 = trustworthy, 1 = something does not match, 2 = usage.
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ "$#" -ge 2 ] || die "usage: verify.sh <backup.tar.age> <identity file> [--live]" 2
FILE="$1"; IDENTITY="$2"; LIVE="${3:-}"
[ -r "$FILE" ] || die "no such backup: $FILE" 2
[ -r "$IDENTITY" ] || die "no such identity file: $IDENTITY" 2
for tool in age node tar sha256sum; do need "$tool"; done
if [ -z "${BACKUP_PG_DOCKER_IMAGE:-}" ]; then need pg_restore; else need docker; fi

JSON="node $BACKUP_DIR/json.mjs"
WORK="$(mktemp -d)"
trap 'wipe "$WORK"/*.dump "$WORK"/*.json "$WORK"/*.tar 2>/dev/null || true; rm -rf "$WORK"' EXIT

META="${FILE%.tar.age}.meta.json"
ACTUAL="$(sha256sum "$FILE" | cut -d' ' -f1)"
if [ -r "$META" ]; then
  [ "$($JSON get "$META" sha256)" = "$ACTUAL" ] || die "the file's sha256 differs from its meta file — damaged or replaced" 1
  [ "$($JSON get "$META" size_bytes)" = "$(stat -c %s "$FILE")" ] || die "the file's size differs from its meta file" 1
  log "sha256 matches the meta file (${ACTUAL:0:12}…)"
else
  log "no meta file next to the backup; sha256 is ${ACTUAL:0:12}…"
fi

age -d -i "$IDENTITY" -o "$WORK/bundle.tar" "$FILE" 2>/dev/null || die "this identity cannot decrypt the backup" 1
LISTED="$(tar -tf "$WORK/bundle.tar" | sort | tr '\n' ' ')"
[ "$LISTED" = "auth.dump manifest.json public.dump " ] || die "the archive does not hold exactly manifest.json, public.dump and auth.dump" 1
tar -C "$WORK" -xf "$WORK/bundle.tar"

[ "$($JSON get "$WORK/manifest.json" format)" = "1" ] || die "unknown manifest format" 1
for f in public.dump auth.dump; do
  [ "$(sha256sum "$WORK/$f" | cut -d' ' -f1)" = "$($JSON get "$WORK/manifest.json" "files/$f/sha256")" ] || die "$f does not match the manifest's sha256" 1
  [ "$(stat -c %s "$WORK/$f")" = "$($JSON get "$WORK/manifest.json" "files/$f/bytes")" ] || die "$f does not match the manifest's size" 1
  ENTRIES="$(pgrun pg_restore --list < "$WORK/$f" | grep -c 'TABLE DATA' || true)"
  log "$f: checksum ok, readable, $ENTRIES table(s) with data"
done
read -r TABLES ROWS MIGRATION < <($JSON summary "$WORK/manifest.json")
log "manifest: $TABLES tables, $ROWS rows, migration $MIGRATION"

if [ "$LIVE" = "--live" ]; then
  : "${PGHOST:?PGHOST is needed for --live}"
  pgrun psql -X -q -At -v ON_ERROR_STOP=1 < "$BACKUP_DIR/manifest.sql" | tail -n 1 > "$WORK/live.json"
  DIFF="$($JSON diff "$WORK/manifest.json" "$WORK/live.json" || true)"
  [ -z "$DIFF" ] || { echo "$DIFF" >&2; die "the live database differs from the backup in the tables above" 1; }
  log "live database matches the manifest (every table, rows and md5)"
fi
log "OK"
