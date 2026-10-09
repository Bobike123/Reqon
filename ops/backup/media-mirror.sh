#!/usr/bin/env bash
# Mirrors attachment files to the secondary store, each file encrypted with age (Ultraplan Phase 4;
# BAK-03, D-03). Additive: a file removed from R2 by the 30-day purge stays in the mirror until someone
# decides otherwise. Streams — no plaintext ever touches the disk.
#
#   BACKUP_MEDIA_SRC     rclone remote:bucket of the attachments bucket (read-only token is enough)
#   BACKUP_MEDIA_DEST    rclone remote:path of the mirror, e.g. bkdrive:reqon-backups/media
#   BACKUP_RECIPIENTS    age recipients file (default ops/backup/recipients.txt)
#   BACKUP_MEDIA_MAX     stop after copying this many new files in one run (default 200; the rest next run)
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SRC="${BACKUP_MEDIA_SRC:?BACKUP_MEDIA_SRC is not set}"
DEST="${BACKUP_MEDIA_DEST:?BACKUP_MEDIA_DEST is not set}"
RECIPIENTS_FILE="${BACKUP_RECIPIENTS:-$BACKUP_DIR/recipients.txt}"
MAX="${BACKUP_MEDIA_MAX:-200}"
need rclone; need age
RECIPIENT_LINES="$(read_recipients "$RECIPIENTS_FILE")" || exit 2
mapfile -t RECIPIENTS <<<"$RECIPIENT_LINES"
AGE_ARGS=(); for r in "${RECIPIENTS[@]}"; do AGE_ARGS+=(-r "$r"); done

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
rclone lsf -R --files-only "$SRC" | sort > "$WORK/src.txt"
rclone lsf -R --files-only "$DEST" 2>/dev/null | sed 's/\.age$//' | sort > "$WORK/dest.txt" || true
comm -23 "$WORK/src.txt" "$WORK/dest.txt" > "$WORK/todo.txt"

copied=0; failed=0
while IFS= read -r key && [ "$copied" -lt "$MAX" ]; do
  [ -n "$key" ] || continue
  if rclone cat "$SRC/$key" | age "${AGE_ARGS[@]}" | rclone rcat "$DEST/$key.age"; then copied=$((copied + 1)); else failed=$((failed + 1)); rclone deletefile "$DEST/$key.age" >/dev/null 2>&1 || true; fi
done < "$WORK/todo.txt"
log "media mirror: $copied new file(s) encrypted and copied, $failed failed, $(wc -l < "$WORK/src.txt") in the bucket"
[ "$failed" -eq 0 ] || die "$failed file(s) could not be mirrored" 5
