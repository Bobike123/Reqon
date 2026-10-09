#!/usr/bin/env bash
# Uploads the encrypted backup to the R2 backups bucket (Ultraplan Phase 4; BAK-03, BAK-04).
#
#   BACKUP_OUT_DIR       where backup.sh wrote (default ./backup-out)
#   BACKUP_R2_REMOTE     rclone remote:bucket of the backups bucket, e.g. bkr2:reqon-backups
#                        (the remote itself is configured through RCLONE_CONFIG_BKR2_* variables)
#   BACKUP_FOLDERS       override for tests: comma list of daily,weekly,monthly (default: by date)
#
# Every run writes to daily/; Sundays also to weekly/; the 1st of the month also to monthly/. How long each
# folder is kept is an R2 lifecycle rule per prefix (docs/ultraplan/R2_SETUP.md), not code. Each upload is
# verified by asking the bucket for the object's size. Writes <out>/published (folder/name lines).
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

OUT="${BACKUP_OUT_DIR:-./backup-out}"
REMOTE="${BACKUP_R2_REMOTE:?BACKUP_R2_REMOTE is not set}"
need rclone; need node
shopt -s nullglob
files=("$OUT"/reqon-backup-*.tar.age)
[ "${#files[@]}" -eq 1 ] || die "expected exactly one backup file in $OUT, found ${#files[@]}" 2
FILE="${files[0]}"; NAME="$(basename "$FILE")"; META="${FILE%.tar.age}.meta.json"
[ -r "$META" ] || die "the meta file is missing next to the backup" 2

STAMP="$(sed -E 's/^reqon-backup-([0-9]{8}).*/\1/' <<<"$NAME")"
if [ -n "${BACKUP_FOLDERS:-}" ]; then
  IFS=, read -r -a FOLDERS <<<"$BACKUP_FOLDERS"
else
  FOLDERS=(daily)
  [ "$(date -u -d "$STAMP" +%u)" = "7" ] && FOLDERS+=(weekly)
  [ "$(date -u -d "$STAMP" +%d)" = "01" ] && FOLDERS+=(monthly)
fi

: > "$OUT/published"
SIZE="$(stat -c %s "$FILE")"
for folder in "${FOLDERS[@]}"; do
  [[ "$folder" =~ ^(daily|weekly|monthly)$ ]] || die "unknown folder: $folder" 2
  rclone copyto --s3-no-check-bucket "$FILE" "$REMOTE/$folder/$NAME" >/dev/null || die "upload to $folder/ failed" 5
  rclone copyto --s3-no-check-bucket "$META" "$REMOTE/$folder/${NAME%.tar.age}.meta.json" >/dev/null || die "upload of the meta file to $folder/ failed" 5
  GOT="$(rclone lsjson "$REMOTE/$folder/$NAME" | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(a[0]?.Size ?? "missing"))')"
  [ "$GOT" = "$SIZE" ] || die "$folder/$NAME is $GOT bytes in the bucket, expected $SIZE" 5
  echo "$folder/$NAME" >> "$OUT/published"
  log "uploaded $folder/$NAME ($SIZE bytes, size verified)"
done
