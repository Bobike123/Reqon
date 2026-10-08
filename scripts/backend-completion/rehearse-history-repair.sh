#!/usr/bin/env bash
# Rehearses the hosted migration-history repair (README §6a) with the real Supabase CLI against a DISPOSABLE
# container: the schema is all repository migrations, the history table holds the same 22 platform-timestamp rows
# hosted had on 2026-10-02. It runs `migration list`, `db push --dry-run`, both `migration repair` commands, then
# list and dry-run again, and checks the catalog fingerprint did not change.
#
#   bash scripts/backend-completion/rehearse-history-repair.sh
#
# Expected: BEFORE matched=0 local_only=59 remote_only=22 and the dry-run refuses; AFTER matched=59, "Remote
# database is up to date.", 59 history rows, fingerprint unchanged. Nothing here connects to a real project.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
S="$(mktemp -d)"
C="reqon-repair-rehearsal-$$"; PORT=55439
IMAGE=public.ecr.aws/supabase/postgres:17.6.1.167
trap 'docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$S"' EXIT
docker run --rm -d --name "$C" -p 127.0.0.1:$PORT:5432 -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
ok=0
for _ in $(seq 1 120); do
  if docker exec "$C" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); else ok=0; fi
  [ "$ok" -ge 3 ] && break; sleep 1
done
q() { docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$C" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 "$@"; }
q -q <<'SQL' >/dev/null
create extension if not exists pgcrypto;
create schema if not exists storage;
create table if not exists storage.objects (bucket_id text, name text);
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
SQL
for f in supabase/migrations/*.sql; do q -q -1 -f - < "$f" >/dev/null; done
# history table shaped like hosted, with hosted's 22 rows (version, name)
q -q <<'SQL'
create schema supabase_migrations authorization postgres;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text, created_by text, idempotency_key text, rollback text[]);
alter table supabase_migrations.schema_migrations owner to postgres;
insert into supabase_migrations.schema_migrations (version, name) values
('20260924124502','department_lifecycle'),('20260929090632','requirement_source_subjects_20260125000000'),
('20260929091048','five_department_structure_20260125000100'),('20260929091309','requirements_book_page_map_20260125000200'),
('20260929091406','task_source_reconciliation_20260125000300'),('20260929091509','maintenance_search_path_20260125000400'),
('20260929095225','book_outline_20260125000500'),('20260930230849','requirement_edition_consistency_20260127000300'),
('20260930230918','task_dependencies_20260128000000'),('20260930230944','task_blockers_20260128000100'),
('20260930231006','task_start_date_default_20260128000200'),('20260930231007','section_subsections_20260128000300'),
('20260930231142','phase3_review_fixes_20260128000400'),('20261001100141','phase3_code_review_fixes_20260128000500'),
('20261001100158','attention_v2_20260129000000'),('20261001100232','progress_views_20260129000100'),
('20261001100256','milestone_submission_state_20260129000200'),('20261001100331','spec_measurement_context_20260129000300'),
('20261001100408','spec_readiness_20260129000400'),('20261001100439','spec_direction_and_verdicts_20260129000500'),
('20261001100504','season_integrity_20260129000600'),('20261001100523','phase4_review_fixes_20260129000700');
SQL
DB="postgresql://postgres:postgres@127.0.0.1:$PORT/postgres?sslmode=disable"
SB() { npx --no-install supabase "$@" --db-url "$DB" 2>&1 | grep -v -e 'new version of Supabase CLI' -e 'recommend updating' -e '^$' || true; }
FP() { { echo 'set search_path = "$user", public, extensions;'; cat scripts/backend-completion/catalog-fingerprint.sql; } | q -tA -F'|' -f - | grep -v '^SET$' | md5sum | cut -c1-12; }

REVERT=$(q -tA -c "select string_agg(version, ' ' order by version) from supabase_migrations.schema_migrations")
APPLY=$(ls supabase/migrations/*.sql | xargs -n1 basename | cut -c1-14 | tr '\n' ' ')
echo "fingerprint before: $(FP)"
SUMMARY() { python3 -c 'import sys,json
t=sys.stdin.read(); j=json.loads(t[t.index("{"):])
m=j["migrations"]; b=sum(1 for x in m if x["local"] and x["remote"]); l=sum(1 for x in m if x["local"] and not x["remote"]); r=sum(1 for x in m if x["remote"] and not x["local"])
print(f"    matched={b} local_only={l} remote_only={r}")'; }
echo "==> BEFORE: migration list"; SB migration list | SUMMARY
echo "==> BEFORE: db push --dry-run (head)"; SB db push --dry-run | head -8
echo "==> repair reverted ($(wc -w <<<"$REVERT") versions)"; SB migration repair --status reverted $REVERT | tail -2
echo "==> repair applied ($(wc -w <<<"$APPLY") versions)"; SB migration repair --status applied $APPLY | tail -2
echo "==> AFTER: migration list"; SB migration list > "$S/rehearsal_list_after.txt"; SUMMARY < "$S/rehearsal_list_after.txt"
echo "==> AFTER: db push --dry-run"; SB db push --dry-run
echo "history rows: $(q -tA -c 'select count(*) from supabase_migrations.schema_migrations')"
echo "fingerprint after:  $(FP)"
echo "rows with statements stored: $(q -tA -c "select count(*) filter (where statements is not null) from supabase_migrations.schema_migrations")"
