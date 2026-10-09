#!/usr/bin/env bash
# Restore from an encrypted backup into a live database, safely (Ultraplan Phase 5; ARCHITECTURE.md §9;
# RST-01…12). The database login is the TARGET's owner (`postgres`), given in the PG* variables.
#
#   restore.sh plan  <backup.tar.age> <age identity> [options]   verify, stage, dry run — writes nothing to public
#   restore.sh apply <backup.tar.age> <age identity> [options]   … then snapshot and restore (asks first)
#   restore.sh stage <backup.tar.age> <age identity>             verify and stage only (for restore.revert_rows in SQL)
#   restore.sh undo  <run id> [--force]                          delete exactly what that run inserted
#   restore.sh drop-staging                                      remove the staged rows
#
# Options for plan/apply:
#   --include-auth     also restore auth.users / auth.identities (a lost project: Runbook B)
#   --exact            Runbook B only: make a NEW project equal to the backup (implies --include-auth)
#   --exclude a,b      leave these tables (schema.table) out
#   --skip-rejected    accept that rows the plan rejects are not restored
#   --yes              do not ask (drills only)
#   --no-snapshot      skip the maintenance_backup copy (drills on throw-away databases only)
#   --keep-staging     leave the staged rows in place afterwards (default: dropped)
#   --show-keys        print the primary keys of rejected rows (never in CI: logs are public)
#
# A target that is not 127.0.0.1/localhost needs RESTORE_CONFIRM_HOST=<that host> — or the host typed when
# asked — so a production database is never touched by accident. Decrypted data exists only in a private
# temporary directory and in the restore_staging schema (no API access); both are removed at the end.
# Exit status: 0 ok · 1 refused or failed (nothing restored) · 2 usage.
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

usage() { die "usage: restore.sh plan|apply|stage <backup.tar.age> <identity> [options] · undo <run id> [--force] · drop-staging" 2; }
[ "$#" -ge 1 ] || usage
MODE="$1"; shift
case "$MODE" in plan|apply|stage|undo|drop-staging) ;; *) usage ;; esac

need node
if [ -z "${BACKUP_PG_DOCKER_IMAGE:-}" ]; then need psql; need pg_restore; else need docker; fi
for v in PGHOST PGUSER; do [ -n "${!v:-}" ] || die "$v is not set (the TARGET database's owner login)" 2; done
export PGDATABASE="${PGDATABASE:-postgres}"
psqlq() { pgrun psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }

confirm_target() {
  case "$PGHOST" in 127.0.0.1|localhost|::1) return 0 ;; esac
  if [ "${RESTORE_CONFIRM_HOST:-}" = "$PGHOST" ]; then return 0; fi
  [ -t 0 ] || die "the target $PGHOST is not local: set RESTORE_CONFIRM_HOST=$PGHOST to confirm" 1
  local typed
  read -r -p "The target is $PGHOST (not local). Type the host name to continue: " typed
  [ "$typed" = "$PGHOST" ] || die "not confirmed; nothing was done" 1
}

if [ "$MODE" = "drop-staging" ]; then
  confirm_target
  psqlq -c 'select restore.drop_staging()' >/dev/null
  log "staging dropped"
  exit 0
fi

if [ "$MODE" = "undo" ]; then
  [ "$#" -ge 1 ] || usage
  RUN="$1"; FORCE=false; [ "${2:-}" = "--force" ] && FORCE=true
  [[ "$RUN" =~ ^[0-9a-f-]{36}$ ]] || die "not a run id: $RUN" 2
  confirm_target
  log "undoing run $RUN"
  OUT="$(printf 'begin;\nselect table_name, deleted, reverted from restore.undo(%s, %s);\ncommit;\n' "'$RUN'" "$FORCE" | psqlq -F ' ')" \
    || die "undo refused or failed; nothing was changed" 1
  while read -r t d r; do [ -n "$t" ] && log "  $t: $d removed, $r put back"; done <<<"$OUT"
  log "undone"
  exit 0
fi

[ "$#" -ge 2 ] || usage
FILE="$1"; IDENTITY="$2"; shift 2
INCLUDE_AUTH=false; EXACT=false; EXCLUDE=""; SKIP=false; YES=false; SNAPSHOT=true; KEEP=false; SHOW_KEYS=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --include-auth) INCLUDE_AUTH=true ;;
    --exact) EXACT=true; INCLUDE_AUTH=true ;;
    --exclude) shift; EXCLUDE="${1:-}" ;;
    --skip-rejected) SKIP=true ;;
    --yes) YES=true ;;
    --no-snapshot) SNAPSHOT=false ;;
    --keep-staging) KEEP=true ;;
    --show-keys) SHOW_KEYS=true ;;
    *) die "unknown option: $1" 2 ;;
  esac
  shift
done
[[ -z "$EXCLUDE" || "$EXCLUDE" =~ ^[a-z_]+\.[a-z_]+(,[a-z_]+\.[a-z_]+)*$ ]] || die "--exclude takes schema.table[,schema.table…]" 2
EXCLUDE_SQL="array[$(sed -E "s/([a-z_]+\.[a-z_]+)/'\1'/g" <<<"$EXCLUDE")]::text[]"
[ -z "$EXCLUDE" ] && EXCLUDE_SQL="'{}'::text[]"
NAME="$(basename "$FILE")"
[[ "$NAME" =~ ^reqon-backup-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]] || die "not a Reqon backup file name: $NAME" 2
confirm_target

# 1. Checksums, decryption and manifest (RST-02) — before anything touches the target.
"$BACKUP_DIR/verify.sh" "$FILE" "$IDENTITY" || die "the backup failed verification; nothing was loaded" 1

WORK="$(mktemp -d)"
STAGED=false
cleanup() {
  wipe "$WORK"/*.dump "$WORK"/*.json "$WORK"/*.tar 2>/dev/null || true
  rm -rf "$WORK"
  if [ "$STAGED" = true ] && [ "$KEEP" = false ]; then psqlq -c 'select restore.drop_staging()' >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
age -d -i "$IDENTITY" -o "$WORK/bundle.tar" "$FILE" 2>/dev/null || die "cannot decrypt with this identity" 1
tar -C "$WORK" -xf "$WORK/bundle.tar"
wipe "$WORK/bundle.tar"

# 2. Stage (RST-01): the dump's rows go into restore_staging, never straight into public.
STAGED=true
{ pgrun pg_restore --data-only -f - < "$WORK/public.dump"; pgrun pg_restore --data-only -f - < "$WORK/auth.dump"; } \
  | node "$BACKUP_DIR/stage.mjs" --name "$NAME" --manifest "$WORK/manifest.json" \
  | pgrun psql -X -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null \
  || die "staging failed (is migration 20260134000000 applied to the target?)" 1
wipe "$WORK"/*.dump

# 3. The staged rows must be exactly the manifest's (counts always, content where comparable).
BADROWS="$(psqlq -F ' ' -c "select table_name, manifest_rows, staged_rows from restore.verify_staging() where not rows_match")"
[ -z "$BADROWS" ] || { echo "$BADROWS" >&2; die "the staged rows differ from the manifest; nothing was restored" 1; }
log "staged rows match the manifest ($(psqlq -c 'select count(*) from restore.verify_staging()') tables; content checked for $(psqlq -c 'select count(*) from restore.verify_staging() where md5_match') of them)"

if [ "$MODE" = "stage" ]; then
  KEEP=true
  log "staged; use restore.revert_rows(…) in SQL, then: restore.sh drop-staging"
  exit 0
fi

# 4. Dry run (RST-05).
log "plan (nothing is written yet):"
printf '%-42s %8s %8s %8s %8s %8s %8s %8s\n' table staged live deleted insert overwr remove reject
psqlq -F '|' -c "select table_name, staged, exists_live, deleted_after_backup, would_insert, would_overwrite, would_remove, rejected, coalesce(notes, '')
                   from restore.plan(${EXCLUDE_SQL}, ${INCLUDE_AUTH}, ${EXACT})" > "$WORK/plan.txt" || die "the dry run failed (see the message above); nothing was restored" 1
while IFS='|' read -r t st li de ins ov rm rj notes; do
  printf '%-42s %8s %8s %8s %8s %8s %8s %8s %s\n' "$t" "$st" "$li" "$de" "$ins" "$ov" "$rm" "$rj" "${notes:+ ($notes)}"
done < "$WORK/plan.txt"
read -r INSERT REJECT OVERWRITE REMOVE < <(awk -F'|' '{i+=$5; r+=$8; o+=$6; d+=$7} END {print i+0, r+0, o+0, d+0}' "$WORK/plan.txt")
if [ "$REJECT" -gt 0 ]; then
  log "rejected rows, with the reason:"
  if [ "$SHOW_KEYS" = true ]; then
    psqlq -c "select '  ' || p.table_name || ' ' || (r ->> 'pk') || ': ' || (r ->> 'reason') from restore.plan(${EXCLUDE_SQL}, ${INCLUDE_AUTH}, ${EXACT}) p, jsonb_array_elements(p.rejections) r"
  else
    psqlq -c "select '  ' || p.table_name || ': ' || count(*) || ' × ' || (r ->> 'reason') from restore.plan(${EXCLUDE_SQL}, ${INCLUDE_AUTH}, ${EXACT}) p, jsonb_array_elements(p.rejections) r group by p.table_name, r ->> 'reason' order by 1"
  fi
fi
log "totals: $INSERT to insert, $OVERWRITE to overwrite, $REMOVE to remove, $REJECT rejected"
[ "$MODE" = "plan" ] && exit 0

# 5. Apply (RST-06/07/09).
if [ "$REJECT" -gt 0 ] && [ "$SKIP" = false ]; then
  die "$REJECT row(s) would be rejected. Exclude their tables (--exclude) or accept skipping them (--skip-rejected)." 1
fi
if [ "$INSERT" -eq 0 ] && [ "$OVERWRITE" -eq 0 ] && [ "$REMOVE" -eq 0 ]; then
  log "nothing to restore: every row of the backup is live (or was deleted on purpose)"
  exit 0
fi
if [ "$YES" = false ]; then
  [ -t 0 ] || die "apply needs a confirmation: run it in a terminal, or pass --yes" 1
  read -r -p "Restore $INSERT row(s)$([ "$EXACT" = true ] && echo ", overwrite $OVERWRITE, remove $REMOVE") into $PGHOST/$PGDATABASE? Type 'restore' to continue: " typed
  [ "$typed" = "restore" ] || die "not confirmed; nothing was restored" 1
fi
LABEL=null
if [ "$SNAPSHOT" = true ]; then
  LABEL="$(psqlq -c 'select restore.snapshot()')" || die "the safety snapshot failed; nothing was restored" 1
  log "safety snapshot: maintenance_backup.${LABEL}_*"
  LABEL="'$LABEL'"
fi
RUN="$(printf "begin;\nselect restore.apply(%s, %s, %s, %s, %s);\ncommit;\n" "$EXCLUDE_SQL" "$INCLUDE_AUTH" "$SKIP" "$LABEL" "$EXACT" | psqlq)" \
  || die "the restore failed and was rolled back; nothing was restored" 1
RUN="$(tail -n 1 <<<"$RUN")"
log "applied: run $RUN"
psqlq -F '|' -c "select key, value ->> 'inserted', value ->> 'overwritten', value ->> 'removed', value ->> 'rejected'
                   from restore.runs, jsonb_each(summary -> 'tables') where id = '$RUN'
                    and ((value ->> 'inserted')::int + (value ->> 'overwritten')::int + (value ->> 'removed')::int + (value ->> 'rejected')::int) > 0 order by 1" \
  | while IFS='|' read -r t i o r j; do log "  $t: $i inserted, $o overwritten, $r removed, $j skipped"; done
log "to take it back: ops/backup/restore.sh undo $RUN"
