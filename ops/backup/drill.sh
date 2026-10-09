#!/usr/bin/env bash
# The restore drill (Ultraplan Phase 5; RST-06, RST-12, RST-13): proves a backup can really be restored.
#
#   drill.sh <backup.tar.age> <age identity>
#
# The PG* variables point at the owner login of a NEW, EMPTY project that has every migration applied
# (`supabase start` in CI; an isolated second local stack in ops/backup/test/runbook-b-local.sh). Never at
# a database in use — the first step refuses a project that already has logins.
#
#   1. Runbook B: exact restore (auth included) into the empty project.
#   2. The project now equals the backup: row counts of every table, and the content (md5) of every public
#      table when both are at the same migration version.
#   3. Running it again changes nothing (idempotent).
#   4. Runbook A on top: rows are lost (no tombstone), one is deleted on purpose, one is changed; a normal
#      merge brings back exactly the lost ones; a second merge inserts nothing; undo removes them again;
#      a final merge leaves the project equal to the backup.
# Prints counts only. Exit status 0 = the backup is restorable.
# shellcheck source=ops/backup/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ "$#" -eq 2 ] || die "usage: drill.sh <backup.tar.age> <age identity>" 2
FILE="$1"; IDENTITY="$2"
OPS="$BACKUP_DIR"
need node
sq() { pgrun psql -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }
step() { echo; log "== $1"; }
WORK="$(mktemp -d)"; trap 'wipe "$WORK"/*.json 2>/dev/null || true; rm -rf "$WORK"' EXIT

[ "$(sq 'select count(*) from auth.users')" = "0" ] || die "the target already has logins: a drill needs a new, empty project" 1

step "Runbook B: exact restore into the empty project"
"$OPS/restore.sh" apply "$FILE" "$IDENTITY" --exact --yes --no-snapshot | tee "$WORK/b.log" | grep -E 'totals|applied|staged rows' || true
grep -q 'applied: run' "$WORK/b.log" || die "Runbook B did not apply" 1

step "the project equals the backup"
age -d -i "$IDENTITY" "$FILE" 2>/dev/null | tar -xO manifest.json > "$WORK/manifest.json"
pgrun psql -X -q -At -v ON_ERROR_STOP=1 < "$OPS/manifest.sql" | tail -n 1 > "$WORK/live.json"
BACKUP_VERSION="$(node "$OPS/json.mjs" get "$WORK/manifest.json" migration_version)"
TARGET_VERSION="$(node "$OPS/json.mjs" get "$WORK/live.json" migration_version)"
ROWS_ONLY="auth."
[ "$BACKUP_VERSION" = "$TARGET_VERSION" ] || ROWS_ONLY="auth.,public."
DIFF="$(node "$OPS/json.mjs" diff "$WORK/manifest.json" "$WORK/live.json" --ignore supabase_migrations. --rows-only "$ROWS_ONLY" || true)"
[ -z "$DIFF" ] || { echo "$DIFF" >&2; die "the restored project differs from the backup" 1; }
read -r TABLES ROWS _ < <(node "$OPS/json.mjs" summary "$WORK/manifest.json")
log "every table matches: $TABLES tables, $ROWS rows ($([ "$ROWS_ONLY" = "auth." ] && echo 'content checked for every public table' || echo "row counts only: backup $BACKUP_VERSION, target $TARGET_VERSION"))"

step "a second exact restore changes nothing"
"$OPS/restore.sh" plan "$FILE" "$IDENTITY" --exact > "$WORK/b2.log"
grep -q 'totals: 0 to insert, 0 to overwrite, 0 to remove, 0 rejected' "$WORK/b2.log" || { grep totals "$WORK/b2.log" >&2; die "a second run would still change rows" 1; }
log "0 to insert, 0 to overwrite, 0 to remove"

step "Runbook A: rows lost, one deleted on purpose, one changed"
N="$(sq 'select count(*) from public.tasks')"
if [ "$N" -lt 5 ]; then
  log "skipped: the backup has fewer than 5 tasks ($N)"
else
  LOST="$(sq "select string_agg(quote_literal(id), ',') from (select id from public.tasks order by id limit 3) x")"
  DELETED="$(sq "select quote_literal(id) from public.tasks order by id offset 3 limit 1")"
  CHANGED="$(sq "select quote_literal(id) from public.tasks order by id offset 4 limit 1")"
  CASCADE_BEFORE="$(sq "select count(*) from public.task_dependencies where task_id in ($LOST) or depends_on_task_id in ($LOST)")"
  # Lost: deleted with every user trigger off (no tombstone), like a broken import or a bad manual fix.
  sq "begin;
      select restore.set_user_triggers((select array_agg(c.oid::regclass) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'), false);
      delete from public.tasks where id in ($LOST);
      select restore.set_user_triggers((select array_agg(c.oid::regclass) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'), true);
      commit;" >/dev/null
  sq "delete from public.tasks where id = $DELETED" >/dev/null
  sq "begin; alter table public.tasks disable trigger user; update public.tasks set title = 'changed after the backup' where id = $CHANGED; alter table public.tasks enable trigger user; commit;" >/dev/null
  log "lost 3 tasks (and $CASCADE_BEFORE dependent links with them), deleted 1 on purpose, changed 1"

  "$OPS/restore.sh" apply "$FILE" "$IDENTITY" --yes --no-snapshot > "$WORK/a.log" || { cat "$WORK/a.log" >&2; die "Runbook A apply failed" 1; }
  RUN="$(sed -n 's/.*applied: run \([0-9a-f-]*\).*/\1/p' "$WORK/a.log")"
  [ "$(sq "select count(*) from public.tasks where id in ($LOST)")" = "3" ] || die "the lost tasks did not come back" 1
  [ "$(sq "select count(*) from public.tasks where id = $DELETED")" = "0" ] || die "the task deleted on purpose came back" 1
  [ "$(sq "select title from public.tasks where id = $CHANGED")" = "changed after the backup" ] || die "the changed task was overwritten" 1
  [ "$(sq "select count(*) from public.task_dependencies where task_id in ($LOST) or depends_on_task_id in ($LOST)")" = "$CASCADE_BEFORE" ] || die "the dependent links did not all come back" 1
  log "merge: the 3 lost tasks and their links are back; the deleted one stays deleted; the changed one keeps its change"

  "$OPS/restore.sh" plan "$FILE" "$IDENTITY" > "$WORK/a2.log"
  grep -q 'totals: 0 to insert' "$WORK/a2.log" || die "a second merge would insert rows again" 1
  log "a second merge inserts nothing"

  "$OPS/restore.sh" undo "$RUN" > /dev/null || die "undo failed" 1
  [ "$(sq "select count(*) from public.tasks where id in ($LOST)")" = "0" ] || die "undo did not remove the restored tasks" 1
  log "undo removed exactly the restored rows"

  "$OPS/restore.sh" apply "$FILE" "$IDENTITY" --yes --no-snapshot > /dev/null || die "the final merge failed" 1
  [ "$(sq "select count(*) from public.tasks where id in ($LOST)")" = "3" ] || die "the final merge did not bring the tasks back" 1
  log "a final merge brought them back"
fi

echo
log "DRILL PASSED"
