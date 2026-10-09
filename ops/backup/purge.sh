#!/usr/bin/env bash
# Deletes from the attachments bucket the objects whose 30-day grace is over (Ultraplan Phase 4; BAK-12),
# through the attachment-purge Edge Function and its own shared secret (D-22).
#
#   SUPABASE_URL  ATTACHMENTS_PURGE_SECRET
# Loops while the function says more is due (at most 20 rounds). Prints counts only.
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

URL="${SUPABASE_URL:?SUPABASE_URL is not set}"
: "${ATTACHMENTS_PURGE_SECRET:?ATTACHMENTS_PURGE_SECRET is not set}"
need curl; need node
total=0; failed=0
for _ in $(seq 1 20); do
  RESPONSE="$(printf 'x-purge-secret: %s\n' "$ATTACHMENTS_PURGE_SECRET" | curl -sS -f -X POST "$URL/functions/v1/attachment-purge" -H @- -H 'content-type: application/json' --data '{}')" || die "attachment-purge did not answer" 5
  read -r P F R < <(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.purged??0,r.failed??0,r.remaining?1:0)' "$RESPONSE")
  total=$((total + P)); failed=$((failed + F))
  [ "$R" = "1" ] || break
done
log "purge: $total entr(ies) purged, $failed failed"
[ "$failed" -eq 0 ] || die "$failed purge entr(ies) failed; the next run retries them" 5
