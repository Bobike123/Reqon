#!/usr/bin/env bash
# Copies the weekly backup to the Google Drive of the dedicated club account (Ultraplan Phase 4;
# BAK-03, BAK-04, D-15) and keeps only the newest N. The rclone remote uses the `drive.file` scope
# (it can only see files it created); it is configured through RCLONE_CONFIG_BKDRIVE_* variables.
#
#   BACKUP_OUT_DIR       where backup.sh wrote (default ./backup-out)
#   BACKUP_DRIVE_REMOTE  rclone remote:path, e.g. bkdrive:reqon-backups
#   BACKUP_DRIVE_KEEP    weekly dumps to keep (default 8)
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

OUT="${BACKUP_OUT_DIR:-./backup-out}"
REMOTE="${BACKUP_DRIVE_REMOTE:?BACKUP_DRIVE_REMOTE is not set}"
KEEP="${BACKUP_DRIVE_KEEP:-8}"
need rclone
shopt -s nullglob
files=("$OUT"/reqon-backup-*.tar.age)
[ "${#files[@]}" -eq 1 ] || die "expected exactly one backup file in $OUT, found ${#files[@]}" 2
FILE="${files[0]}"; NAME="$(basename "$FILE")"

rclone copyto "$FILE" "$REMOTE/weekly/$NAME" >/dev/null || die "upload to Drive failed" 5
SIZE="$(stat -c %s "$FILE")"
GOT="$(rclone size --json "$REMOTE/weekly/$NAME" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).bytes))')"
[ "$GOT" = "$SIZE" ] || die "Drive holds $GOT bytes for $NAME, expected $SIZE" 5

mapfile -t ALL < <(rclone lsf --files-only "$REMOTE/weekly" | grep -E '^reqon-backup-[0-9]{8}T[0-9]{6}Z\.tar\.age$' | sort)
if [ "${#ALL[@]}" -gt "$KEEP" ]; then
  for old in "${ALL[@]:0:${#ALL[@]}-KEEP}"; do rclone deletefile "$REMOTE/weekly/$old" >/dev/null; done
fi
log "uploaded weekly/$NAME to Drive (${SIZE} bytes, size verified); newest $KEEP kept"
