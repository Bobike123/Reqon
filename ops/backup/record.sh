#!/usr/bin/env bash
# Tells the app what happened, through the backup-record Edge Function (Ultraplan Phase 4; BAK-09):
#
#   record.sh <r2|github|drive> <ok|fail> [detail]
#
#   SUPABASE_URL           https://<project>.supabase.co  (a local http://127.0.0.1:54321 works)
#   BACKUP_RECORD_SECRET   shared secret of the function (never the service-role key, D-22)
#   BACKUP_OUT_DIR         where backup.sh wrote (default ./backup-out)
#   BACKUP_R2_FOLDER       folder of the object for the r2 record (default daily)
#
# A failure after backup.sh failed uses its failure-code file as the detail. The secret travels in a
# header read from stdin, never on a command line.
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ "$#" -ge 2 ] || die "usage: record.sh <r2|github|drive> <ok|fail> [detail]" 2
DEST="$1"; STATUS="$2"; DETAIL="${3:-}"
URL="${SUPABASE_URL:?SUPABASE_URL is not set}"
: "${BACKUP_RECORD_SECRET:?BACKUP_RECORD_SECRET is not set}"
OUT="${BACKUP_OUT_DIR:-./backup-out}"
need curl; need node
[ -z "$DETAIL" ] && [ -r "$OUT/failure-code" ] && DETAIL="$(cat "$OUT/failure-code")"
shopt -s nullglob
metas=("$OUT"/reqon-backup-*.meta.json)
META="-"; [ "${#metas[@]}" -eq 1 ] && META="${metas[0]}"
[ "$STATUS" = "ok" ] && [ "$META" = "-" ] && die "an ok record needs the meta file" 2

BODY="$(node "$BACKUP_DIR/json.mjs" record "$META" "$DEST" "$STATUS" "$DETAIL")"
CODE="$(printf 'x-backup-secret: %s\n' "$BACKUP_RECORD_SECRET" | curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$URL/functions/v1/backup-record" -H @- -H 'content-type: application/json' --data "$BODY")" || die "could not reach the backup-record function" 5
[ "$CODE" = "200" ] || die "backup-record answered HTTP $CODE" 5
log "recorded $DEST/$STATUS"
