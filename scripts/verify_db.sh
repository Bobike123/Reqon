#!/usr/bin/env bash
# Applies the schema from a clean checkout — local_auth_shim.sql, then every
# migration in supabase/migrations, in order — to a disposable Postgres
# container, runs every supabase/tests/*.sql file against it, and proves
# promote_proposal() is safe under REAL concurrency (two actual psql
# processes racing, not just two statements in one session).
#
#   npm run test:db        (or: bash scripts/verify_db.sh)
#
# Exit status 0 = every check passed, 1 = anything failed. CI's database job
# runs exactly this.
#
# Needs Docker and network access to pull postgres:17 once. Nothing here
# touches a real Supabase project — the container is removed on exit, pass or
# fail (see the trap below), and every supabase/tests/*.sql file rolls back
# everything it does on its own.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CONTAINER="reqon-verify-db-$$"
PORT="${VERIFY_DB_PORT:-55432}"
# Same major version as the hosted project (supabase/config.toml
# [db] major_version) — testing on an older major than production proves less.
IMAGE="${VERIFY_DB_IMAGE:-postgres:17}"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> starting a disposable $IMAGE container ($CONTAINER, port $PORT)"
docker run --rm -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p "$PORT:5432" "$IMAGE" >/dev/null

psql_in() { docker exec -i "$CONTAINER" psql -U postgres -d postgres "$@"; }

echo -n "==> waiting for it to accept connections"
READY=0
for _ in $(seq 1 60); do
  # The image's first-boot init runs a temporary server on the Unix socket
  # only, then restarts. A socket probe can succeed against that temporary
  # server; a TCP probe only succeeds against the final one.
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    READY=1; echo " ready"; break
  fi
  echo -n "."
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo
  echo "!! the database never accepted connections"
  docker logs "$CONTAINER" 2>&1 | tail -20
  exit 1
fi

echo "==> applying scripts/local_auth_shim.sql"
psql_in -v ON_ERROR_STOP=1 -f - < scripts/local_auth_shim.sql >/dev/null

echo "==> applying migrations"
# The shared verify-fixture President, and the check that the upgrade leaves
# the 14 grandfathered departments active (over the cap: a create is refused,
# an ordinary edit is accepted, nothing is archived for us). That state only
# exists until the 2026/27 reconciliation (20260125000100) replaces the 14
# with five, so this runs at the same point as verify_upgrade_preservation.
verify_over_cap_upgrade_state() {
echo "==> creating a shared verify-fixture President for privileged operations"
PRESIDENT_SQL=$(cat <<'SQL'
do $$
declare pre uuid := '00000000-0000-4000-8000-0000000000aa';
begin
  insert into auth.users (id, email) values (pre, 'verify-pre@roles.test');
  insert into members (id, full_name, role) values (pre, 'Verify President', 'President');
  insert into member_roles (member_id, role) values (pre, 'president');
end $$;
SQL
)
psql_in -v ON_ERROR_STOP=1 -c "$PRESIDENT_SQL" >/dev/null

echo "==> the upgrade leaves 14 active departments: no new one may be created, ordinary edits still work, nothing is archived for us"
CAP_OUT=$(psql_in 2>&1 <<SQL
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000aa', true);
insert into subteams (key, name) values ('CAP_PROBE', 'Cap probe');
commit;
SQL
)
CAP_ROWS=$(psql_in -tA -c "select count(*) from subteams where key = 'CAP_PROBE'" | tr -d '[:space:]')
CAP_ACTIVE=$(psql_in -tA -c "select count(*) from subteams where archived_at is null" | tr -d '[:space:]')
RENAME_OUT=$(psql_in 2>&1 <<SQL
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000aa', true);
update subteams set description = 'edited while over the cap' where key = (select key from subteams order by sort_order, key limit 1);
commit;
SQL
)
if ! echo "$CAP_OUT" | command grep -q 'ERROR' || [ "$CAP_ROWS" != "0" ] || [ "$CAP_ACTIVE" != "14" ] || ! echo "$RENAME_OUT" | command grep -q 'UPDATE 1'; then
  echo "!! FAIL: the 14-active state is not handled as designed (create refused, edits allowed, none archived)"
  echo "$CAP_OUT"; echo "$RENAME_OUT"; exit 1
fi
echo "    ok  with 14 active: a create is refused by the cap, a description edit is accepted, 14 stay active (only a reviewed manifest archives)"
}

# The 20260115..20260118 upgrade-preservation check. It describes the schema
# BEFORE the 2026/27 department reconciliation (20260125000100), which
# deliberately remaps departments, so it runs once, as soon as the last
# pre-reconciliation migration has applied. What the reconciliation then does
# to this same fixture is verified separately after the loop.
verify_upgrade_preservation() {
  echo "==> verifying nothing was lost or rewritten across 20260115..20260118 (upgrade from the original last migration)"
  PRES=$(psql_in -tA -F'|' -c "
  select
   (select count(*) from verify_snapshot.subteams a left join subteams b using (key)
     where b.key is null or (a.name, a.lead_id, a.book_section, a.sort_order, a.is_parked) is distinct from (b.name, b.lead_id, b.book_section, b.sort_order, b.is_parked)),
   (select count(*) from subteams where archived_at is not null),
   (select count(*) from verify_snapshot.clauses a left join clauses b using (clause_key)
     where b.clause_key is null or (a.subteam_key, a.printed_ref) is distinct from (b.subteam_key, b.printed_ref)),
   (select count(*) from verify_snapshot.members a left join members b using (id) where b.id is null or a.full_name is distinct from b.full_name),
   (select count(*) from verify_snapshot.member_roles a left join member_roles b using (member_id, role) where b.member_id is null),
   (select count(*) from verify_snapshot.tasks a left join tasks b using (id)
     where b.id is null or (a.title, a.detail, a.owner_id, a.subteam_key, a.section_id, a.source_proposal, a.season_id) is distinct from (b.title, b.detail, b.owner_id, b.subteam_key, b.section_id, b.source_proposal, b.season_id)),
   (select count(*) from verify_snapshot.task_proposals a left join task_proposals b using (id)
     where b.id is null or (a.title, a.context, a.raised_by, a.raised_on, a.season_id) is distinct from (b.title, b.context, b.raised_by, b.raised_on, b.season_id)),
   (select count(*) from verify_snapshot.handover_notes a left join handover_notes b using (id) where b.id is null or (a.subteam_key, a.body) is distinct from (b.subteam_key, b.body)),
   (select count(*) from verify_snapshot.milestones a left join milestones b using (key) where b.key is null or (a.season_id, a.name) is distinct from (b.season_id, b.name)),
   (select count(*) from verify_snapshot.milestone_sections a left join milestone_sections b using (id) where b.id is null or (a.milestone_key, a.name) is distinct from (b.milestone_key, b.name)),
   (select count(*) from subteams), (select count(*) from clauses)
  ")
  echo "    bad-row counts / totals: $PRES"
  PRES_OK=1
  [ "$(echo "$PRES" | cut -d'|' -f1-10)" = "0|0|0|0|0|0|0|0|0|0" ] || PRES_OK=0
  [ "$(echo "$PRES" | cut -d'|' -f11)" = "14" ] || PRES_OK=0
  [ "$(echo "$PRES" | cut -d'|' -f12)" = "1146" ] || PRES_OK=0
  PRES_ORIGIN=$(psql_in -tA -F'|' -c "
  select t.title, p.state, coalesce(p.outcome::text,''), coalesce(t.milestone_key,''), t.subteam_key is not null, t.links_required
  from tasks t join task_proposals p on p.id = t.source_proposal where t.title = 'Snap task'")
  echo "    promoted origin: $PRES_ORIGIN"
  [ "$PRES_ORIGIN" = "Snap task|decided|approved|SNAP-MS1|t|f" ] || PRES_OK=0
  PRES_NOTASK=$(psql_in -tA -F'|' -c "select state, coalesce(outcome::text,''), legacy_incomplete from task_proposals where title = 'Snap decided, no task'")
  echo "    decided without a task: $PRES_NOTASK"
  [ "$PRES_NOTASK" = "decided||t" ] || PRES_OK=0
  if [ "$PRES_OK" != "1" ]; then
    echo "!! FAIL: the upgrade lost, rewrote or mis-migrated legacy data — see the counts above"
    exit 1
  fi
  echo "    ok  every snapshotted id, owner, Head, section link, proposal origin, handover note, department (14, none archived) and clause (1146) survived unchanged"
  echo "    ok  the promoted proposal kept its task, department and (via its section) milestone; the undecided-outcome proposal stayed undecided and legacy_incomplete"
}

for f in supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  psql_in -v ON_ERROR_STOP=1 -f - < "$f" >/dev/null

  # Upgrade test with representative old data (execution contract: "Test both
  # a clean schema and an upgrade from the original migrations with
  # representative old data"). Seeded right after the last pre-Phase-2
  # migration and before 20260116 applies, so the priority/state backfill and
  # the completed_at backfill in that migration have real legacy-shaped rows
  # to act on, not an empty table — a clean run alone would exercise none of
  # that data-migration logic (the seed has no state='urgent' or 'done' task
  # rows of its own).
  if [ "$(basename "$f")" = "20260115000000_department_lifecycle.sql" ]; then
    echo "==> seeding representative pre-Phase-2 legacy task data (urgent state, done rows with/without a matching activity row)"
    LEGACY_SQL=$(cat <<'SQL'
do $$
declare
  mem uuid := '00000000-0000-4000-8000-0000000000bb';
  season uuid;
  t_urgent uuid;
  t_done_with_activity uuid;
  t_done_no_activity uuid;
begin
  insert into auth.users (id, email) values (mem, 'verify-legacy@roles.test');
  insert into members (id, full_name, role) values (mem, 'Verify Legacy Member', 'Chassis');
  insert into seasons (label, is_current) values ('VERIFY-LEGACY', false) returning id into season;

  insert into tasks (season_id, title, state, owner_id) values (season, 'Legacy urgent task', 'urgent', mem) returning id into t_urgent;
  insert into tasks (season_id, title, state, owner_id) values (season, 'Legacy done with activity', 'done', mem) returning id into t_done_with_activity;
  insert into tasks (season_id, title, state, owner_id) values (season, 'Legacy done no activity', 'done', mem) returning id into t_done_no_activity;

  insert into activity (actor_id, season_id, entity, entity_id, action, detail, at)
  values (mem, season, 'task', t_done_with_activity::text, 'state_changed',
    jsonb_build_object('title', 'Legacy done with activity', 'from', 'wip', 'to', 'done'),
    '2026-08-01T12:00:00Z'::timestamptz);

  raise notice 'LEGACY % % %', t_urgent, t_done_with_activity, t_done_no_activity;
end $$;
SQL
)
    LEGACY_OUT=$(psql_in -v ON_ERROR_STOP=1 -c "$LEGACY_SQL" 2>&1)
    LEGACY_LINE=$(echo "$LEGACY_OUT" | command grep -oE 'LEGACY [0-9a-f-]+ [0-9a-f-]+ [0-9a-f-]+')
    T_URGENT=$(echo "$LEGACY_LINE" | awk '{print $2}')
    T_DONE_A=$(echo "$LEGACY_LINE" | awk '{print $3}')
    T_DONE_B=$(echo "$LEGACY_LINE" | awk '{print $4}')
    if [ -z "$T_URGENT" ] || [ -z "$T_DONE_A" ] || [ -z "$T_DONE_B" ]; then
      echo "!! could not read the legacy fixture task ids from:"
      echo "$LEGACY_OUT"
      exit 1
    fi
    echo "    ok  legacy fixture seeded (3 tasks, 1 backing activity row) before 20260116 applies"
  fi

  # Phase 4 upgrade-preservation fixture: a legacy-shaped dataset at the ORIGINAL
  # last migration (before any redesign migration), snapshotted so every id, link,
  # Head and proposal origin can be compared after 20260115..20260118 have all run.
  if [ "$(basename "$f")" = "20260114000000_activity_audit_trail.sql" ]; then
    echo "==> snapshotting a legacy dataset at the original last migration (20260114)"
    SNAP_SQL=$(cat <<'SQL'
do $$
declare
  m1 uuid := '00000000-0000-4000-8000-0000000000f1';
  m2 uuid := '00000000-0000-4000-8000-0000000000f2';
  s1 uuid; sec uuid; p uuid; d1 text; d2 text;
begin
  insert into auth.users (id, email) values (m1, 'snap-1@roles.test'), (m2, 'snap-2@roles.test');
  insert into members (id, full_name, role) values (m1, 'Snap One', 'Chassis'), (m2, 'Snap Two', 'Aero');
  insert into member_roles (member_id, role) values (m2, 'treasurer');
  select key into d1 from subteams order by sort_order, key limit 1;
  select key into d2 from subteams order by sort_order desc, key limit 1;
  update subteams set lead_id = m1 where key = d1;
  insert into seasons (label, is_current) values ('SNAP', false) returning id into s1;
  insert into milestones (key, season_id, ordinal, name) values ('SNAP-MS1', s1, 1, 'Snap milestone');
  insert into milestone_sections (milestone_key, ordinal, name) values ('SNAP-MS1', 1, 'Snap section') returning id into sec;
  insert into task_proposals (season_id, title, context, raised_by) values (s1, 'Snap proposal', 'ctx', m1) returning id into p;
  insert into task_proposals (season_id, title, raised_by, state, decision) values (s1, 'Snap decided, no task', m1, 'decided', 'yes');
  insert into tasks (season_id, title, detail, owner_id, subteam_key, section_id, source_proposal, state)
    values (s1, 'Snap task', 'd', m2, d2, sec, p, 'wip');
  insert into tasks (season_id, title, owner_id, state) values (s1, 'Snap loose task', m1, 'blocked');
  insert into tasks (season_id, title, owner_id, subteam_key, state) values (s1, 'Snap unowned task', null, d1, 'todo');
  insert into handover_notes (season_id, subteam_key, body) values (s1, d1, 'Snap note');

  create schema verify_snapshot;
  create table verify_snapshot.subteams as select key, name, lead_id, book_section, sort_order, is_parked from subteams;
  create table verify_snapshot.clauses as select clause_key, subteam_key, printed_ref from clauses;
  create table verify_snapshot.members as select id, full_name, status from members;
  create table verify_snapshot.member_roles as select member_id, role from member_roles;
  create table verify_snapshot.tasks as select id, title, detail, owner_id, subteam_key, section_id, source_proposal, season_id from tasks;
  create table verify_snapshot.task_proposals as select id, title, context, raised_by, raised_on, season_id from task_proposals;
  create table verify_snapshot.handover_notes as select id, subteam_key, body from handover_notes;
  create table verify_snapshot.milestones as select key, season_id, name from milestones;
  create table verify_snapshot.milestone_sections as select id, milestone_key, name from milestone_sections;
end $$;
SQL
)
    psql_in -v ON_ERROR_STOP=1 -c "$SNAP_SQL" >/dev/null
    echo "    ok  snapshot taken (ids, owners, Heads, links, proposal origins, all 14 departments, all clauses)"
  fi

  # Phase 3 upgrade test: representative pre-20260117 proposals and tasks,
  # seeded right after the last migration that predates task_proposals'
  # department/outcome/archive columns, so 20260117's backfill has real
  # legacy-shaped rows to act on (promoted with and without a decided_at, a
  # decided proposal with no task, an open one, and a task whose section is
  # in another season's milestone).
  if [ "$(basename "$f")" = "20260116000000_task_lifecycle_and_authorization.sql" ]; then
    echo "==> seeding representative pre-Phase-3 legacy proposals and tasks"
    LEGACY3_SQL=$(cat <<'SQL'
do $$
declare
  mem uuid := '00000000-0000-4000-8000-0000000000ee';
  s1 uuid; s2 uuid; dept text; sec uuid; p1 uuid; p2 uuid;
begin
  insert into auth.users (id, email) values (mem, 'verify-legacy3@roles.test');
  insert into members (id, full_name, role) values (mem, 'Verify Legacy Three', 'Chassis');
  insert into seasons (label, is_current) values ('VERIFY-LEGACY-P3', false) returning id into s1;
  insert into seasons (label, is_current) values ('VERIFY-LEGACY-P3-OTHER', false) returning id into s2;
  insert into milestones (key, season_id, ordinal, name) values ('LP3-MS1', s1, 1, 'Legacy milestone');
  insert into milestone_sections (milestone_key, ordinal, name) values ('LP3-MS1', 1, 'Legacy section') returning id into sec;
  select key into dept from subteams order by sort_order, key limit 1;

  insert into task_proposals (season_id, title, raised_by, state, decided_at)
    values (s1, 'LP3 promoted with date', mem, 'decided', '2026-07-01T10:00:00Z') returning id into p1;
  insert into task_proposals (season_id, title, raised_by, state)
    values (s1, 'LP3 promoted without date', mem, 'agenda') returning id into p2;
  insert into task_proposals (season_id, title, raised_by, state, decided_at, decision)
    values (s1, 'LP3 decided no task', mem, 'decided', '2026-07-02T10:00:00Z', 'ok');
  insert into task_proposals (season_id, title, raised_by) values (s1, 'LP3 open', mem);

  insert into tasks (season_id, title, source_proposal, subteam_key, section_id) values (s1, 'LP3 task one', p1, dept, sec);
  insert into tasks (season_id, title, source_proposal, subteam_key) values (s1, 'LP3 task two', p2, dept);
  insert into tasks (season_id, title, section_id) values (s2, 'LP3 cross-season task', sec);
end $$;
SQL
)
    psql_in -v ON_ERROR_STOP=1 -c "$LEGACY3_SQL" >/dev/null
    echo "    ok  legacy proposals/tasks seeded before 20260117 applies"
  fi

  # Phase 9 upgrade fixture: measured values in the shape the old client wrote
  # them, seeded after the last pre-Phase-9 migration and before 20260122
  # (which turns each into at most one observation). One value is written by a
  # real authenticated session, so the audit trigger recorded a SERVER-side actor;
  # one has only the client-stored measured_by; one has nothing but the number.
  if [ "$(basename "$f")" = "20260121000000_gantt_link_audit.sql" ]; then
    echo "==> seeding legacy measured values (audited actor, stored actor only, value only, never measured) before 20260122 applies"
    psql_in -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000091', 'verify-l9a@roles.test'),
  ('00000000-0000-4000-8000-000000000092', 'verify-l9b@roles.test');
insert into members (id, full_name, role) values
  ('00000000-0000-4000-8000-000000000091', 'Verify L9 A', 'Chassis'),
  ('00000000-0000-4000-8000-000000000092', 'Verify L9 B', 'Chassis');
insert into seasons (id, label, is_current) values ('00000000-0000-4000-8000-000000000090', 'VERIFY-LEGACY9', false);
insert into specs (id, season_id, parameter, comparator, target, unit) values
  ('00000000-0000-4000-8000-000000000094', '00000000-0000-4000-8000-000000000090', 'L9 audited', 'min', 10, 'kg'),
  ('00000000-0000-4000-8000-000000000095', '00000000-0000-4000-8000-000000000090', 'L9 stored actor only', 'min', 10, 'kg'),
  ('00000000-0000-4000-8000-000000000096', '00000000-0000-4000-8000-000000000090', 'L9 nothing known', 'max', 10, 'kg'),
  ('00000000-0000-4000-8000-000000000097', '00000000-0000-4000-8000-000000000090', 'L9 never measured', 'max', 10, 'kg');
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000091","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000091', true);
update specs set measured = 12.5, measured_by = '00000000-0000-4000-8000-000000000091', measured_at = '2026-08-01T09:00:00Z'
  where id = '00000000-0000-4000-8000-000000000094';
commit;
alter table specs disable trigger trg_log_spec_measurement;
update specs set measured = 7, measured_by = '00000000-0000-4000-8000-000000000092', measured_at = '2026-08-02T09:00:00Z'
  where id = '00000000-0000-4000-8000-000000000095';
update specs set measured = 3 where id = '00000000-0000-4000-8000-000000000096';
alter table specs enable trigger trg_log_spec_measurement;
SQL
    L9_ACTIVITY_BEFORE=$(psql_in -tA -c "select count(*) from activity where entity = 'spec' and entity_id in (select id::text from specs where parameter like 'L9 %')" | tr -d '[:space:]')
    echo "    ok  legacy measurements seeded ($L9_ACTIVITY_BEFORE audit row before the migration)"
  fi

  if [ "$(basename "$f")" = "20260124000000_audit_hardening.sql" ]; then
    verify_upgrade_preservation
    verify_over_cap_upgrade_state
  fi
done

echo "==> verifying the 2026/27 reconciliation (20260125000000..300) on the legacy fixture"
RECON=$(psql_in -tA -F'|' -c "
select
 (select string_agg(key, ',' order by sort_order) from subteams where archived_at is null),
 (select count(*) from subteams),
 (select count(*) from regulation_subjects),
 (select count(*) from clauses where source_subject_key is null),
 (select count(*) from clauses where subteam_key is not null),
 (select count(*) from clauses where subteam_key is null),
 (select count(*) from clauses where source_page between 1 and 234),
 (select page_count from regulation_documents where regs_ref = 'MS2627 Rev.01'),
 (select coalesce(subteam_key, '-') from tasks where title = 'Snap task'),
 (select coalesce(subteam_key, '-') from tasks where title = 'Snap unowned task'),
 (select string_agg(coalesce(subteam_key, '-'), ',' order by title) from tasks where title like 'LP3 task %'),
 (select h.subteam_key from handover_notes h join verify_snapshot.handover_notes s using (id) where s.body = 'Snap note'),
 (select count(*) from activity where entity = 'department' and action = 'removed'),
 (select count(*) from activity where entity = 'department' and action = 'removed'
    and detail->'row'->>'lead_id' = '00000000-0000-4000-8000-0000000000f1'),
 (select count(*) from subteams where lead_id = '00000000-0000-4000-8000-0000000000f1'),
 (select count(*) from activity where action = 'department_remapped' and detail->>'title' = 'Snap task' and detail->>'from' = 'RACEOP' and detail->>'to' is null),
 (select count(*) from verify_snapshot.tasks a left join tasks b using (id) where b.id is null),
 (select count(*) from clause_status)
")
echo "    $RECON"
RECON_OK=1
[ "$(echo "$RECON" | cut -d'|' -f1-8)" = "SWDATA,MECH,ELEC,BUILD,OPS|5|14|0|757|389|1146|234" ] || RECON_OK=0
[ "$(echo "$RECON" | cut -d'|' -f9-12)" = "-|OPS|OPS,OPS|OPS" ] || RECON_OK=0
[ "$(echo "$RECON" | cut -d'|' -f13-17)" = "13|1|0|1|0" ] || RECON_OK=0
if [ "$RECON_OK" != "1" ]; then
  echo "!! FAIL: the 2026/27 reconciliation did not leave the expected state (fields above)"
  exit 1
fi
echo "    ok  exactly SWDATA, MECH, ELEC, BUILD, OPS; 14 subjects kept; 1146 clauses: subject recorded, 757 assigned / 389 unassigned, all paged 1..234"
echo "    ok  RACEOP work -> no department (logged), ADMIN work and its handover note -> OPS, no task lost"
echo "    ok  the legacy Head was recorded in the 'removed' row and NOT carried to a new department"

echo "==> re-running the three data migrations: must change nothing"
RERUN_BEFORE=$(psql_in -tA -c "select count(*) || '/' || (select md5(string_agg(key || coalesce(lead_id::text, ''), ',' order by key)) from subteams) || '/' || (select md5(string_agg(clause_key || coalesce(subteam_key, '') || coalesce(source_page::text, ''), ',' order by clause_key)) from clauses) from activity")
for f in supabase/migrations/20260125000100_five_department_structure.sql \
         supabase/migrations/20260125000200_requirements_book_page_map.sql \
         supabase/migrations/20260125000300_task_source_reconciliation.sql; do
  psql_in -v ON_ERROR_STOP=1 -f - < "$f" >/dev/null
done
RERUN_AFTER=$(psql_in -tA -c "select count(*) || '/' || (select md5(string_agg(key || coalesce(lead_id::text, ''), ',' order by key)) from subteams) || '/' || (select md5(string_agg(clause_key || coalesce(subteam_key, '') || coalesce(source_page::text, ''), ',' order by clause_key)) from clauses) from activity")
if [ "$RERUN_BEFORE" != "$RERUN_AFTER" ]; then
  echo "!! FAIL: a re-run changed data: $RERUN_BEFORE -> $RERUN_AFTER"
  exit 1
fi
echo "    ok  second run: activity, departments and clause ownership/pages unchanged"


echo "==> verifying the legacy task data migrated correctly (20260116)"
LEGACY_CHECK=$(psql_in -tA -F'|' -c "
select title, state, priority, completed_at is not null, completion_source
from tasks where id in ('$T_URGENT','$T_DONE_A','$T_DONE_B') order by title;
")
echo "$LEGACY_CHECK" | sed 's/^/    /'
LEGACY_OK=1
echo "$LEGACY_CHECK" | command grep -q "^Legacy urgent task|todo|urgent|f|$" || LEGACY_OK=0
echo "$LEGACY_CHECK" | command grep -q "^Legacy done with activity|done|normal|t|activity_backfill$" || LEGACY_OK=0
echo "$LEGACY_CHECK" | command grep -q "^Legacy done no activity|done|normal|t|migration_observed$" || LEGACY_OK=0
PRIORITY_MIGRATED_ROW=$(psql_in -tA -c "select count(*) from activity where action = 'priority_migrated' and entity_id = '$T_URGENT'")
[ "$(echo "$PRIORITY_MIGRATED_ROW" | tr -d '[:space:]')" = "1" ] || LEGACY_OK=0
if [ "$LEGACY_OK" != "1" ]; then
  echo "!! FAIL: legacy task data did not migrate as expected — see the row dump above"
  exit 1
fi
echo "    ok  state='urgent' -> todo+urgent with one priority_migrated activity row"
echo "    ok  legacy done-with-activity backfilled completed_at from that activity row (completion_source=activity_backfill)"
echo "    ok  legacy done-with-no-activity backfilled completed_at from the migration's own now() (completion_source=migration_observed)"

echo "==> verifying the legacy proposals and tasks migrated correctly (20260117)"
LP3=$(psql_in -tA -F'|' -c "
select title, state, coalesce(outcome::text,''), coalesce(archive_reason,''), archived_at is not null,
       legacy_incomplete, subteam_key is not null, coalesce(milestone_key,'')
from task_proposals where title like 'LP3 %' order by title;
")
echo "$LP3" | sed 's/^/    /'
LP3_OK=1
echo "$LP3" | command grep -q "^LP3 decided no task|decided|||f|t|f|$" || LP3_OK=0
echo "$LP3" | command grep -q "^LP3 open|open|||f|t|f|$" || LP3_OK=0
echo "$LP3" | command grep -q "^LP3 promoted with date|decided|approved|promoted_legacy|t|t|t|LP3-MS1$" || LP3_OK=0
echo "$LP3" | command grep -q "^LP3 promoted without date|decided|approved|promoted_legacy|t|t|t|$" || LP3_OK=0
LP3_DATE=$(psql_in -tA -c "select archived_at = decided_at from task_proposals where title = 'LP3 promoted with date'" | tr -d '[:space:]')
[ "$LP3_DATE" = "t" ] || LP3_OK=0
LP3_BASIS=$(psql_in -tA -c "select string_agg(detail->>'basis', ',' order by detail->>'title') from activity where action = 'legacy_archived' and detail->>'title' like 'LP3 %'" | tr -d '[:space:]')
[ "$LP3_BASIS" = "decided_at,migration_time" ] || { echo "    basis rows: $LP3_BASIS"; LP3_OK=0; }
LP3_TASKS=$(psql_in -tA -F'|' -c "select title, coalesce(milestone_key,''), links_required from tasks where title like 'LP3 %' order by title")
echo "$LP3_TASKS" | sed 's/^/    /'
echo "$LP3_TASKS" | command grep -q "^LP3 task one|LP3-MS1|f$" || LP3_OK=0
echo "$LP3_TASKS" | command grep -q "^LP3 cross-season task||f$" || LP3_OK=0
echo "$LP3_TASKS" | command grep -q "^LP3 task two||f$" || LP3_OK=0
LP3_LINKS=$(psql_in -tA -c "select (select count(*) from proposal_requirements pr join task_proposals p on p.id = pr.proposal_id where p.title like 'LP3 %') + (select count(*) from task_requirements)" | tr -d '[:space:]')
[ "$LP3_LINKS" = "0" ] || { echo "    invented links: $LP3_LINKS"; LP3_OK=0; }
if [ "$LP3_OK" != "1" ]; then
  echo "!! FAIL: legacy proposal/task data did not migrate as expected — see the row dump above"
  exit 1
fi
echo "    ok  promoted legacy proposals: decided, approved, archived (promoted_legacy) at decided_at or the migration time, basis recorded"
echo "    ok  department and milestone taken from the promoted task only; unpromoted proposals stay legacy_incomplete with nothing invented"
echo "    ok  a task whose section is in another season's milestone was left without a milestone; no requirement links were invented"

echo "==> verifying the legacy measurements became at most one observation each, attributed to nobody new (20260122)"
L9=$(psql_in -tA -F'|' -c "
select sp.parameter, (select count(*) from spec_measurements x where x.spec_id = sp.id), coalesce(m.origin, ''),
       coalesce(m.measured_by::text, ''), coalesce(m.measured_at::text, ''), coalesce(m.value_numeric::text, ''),
       coalesce((sp.current_measurement_id = m.id)::text, '')
from specs sp left join spec_measurements m on m.spec_id = sp.id
where sp.parameter like 'L9 %' order by 1")
echo "$L9" | sed 's/^/    /'
L9_OK=1
echo "$L9" | command grep -qx "L9 audited|1|legacy_import|00000000-0000-4000-8000-000000000091|2026-08-01 09:00:00+00|12.5|true" || L9_OK=0
echo "$L9" | command grep -qx "L9 stored actor only|1|legacy_import|00000000-0000-4000-8000-000000000092|2026-08-02 09:00:00+00|7|true" || L9_OK=0
echo "$L9" | command grep -qx "L9 nothing known|1|legacy_import|||3|true" || L9_OK=0
echo "$L9" | command grep -qx "L9 never measured|0|||||" || L9_OK=0
L9_TIME=$(psql_in -tA -c "select m.recorded_at = a.at from spec_measurements m join activity a on a.entity = 'spec' and a.entity_id = m.spec_id::text and a.action = 'measurement_recorded' where m.spec_id = '00000000-0000-4000-8000-000000000094'" | tr -d '[:space:]')
L9_ACTIVITY_AFTER=$(psql_in -tA -c "select count(*) from activity where entity = 'spec' and entity_id in (select id::text from specs where parameter like 'L9 %')" | tr -d '[:space:]')
L9_CACHE=$(psql_in -tA -c "select count(*) from specs where parameter like 'L9 %' and ((measured is null) <> (current_measurement_id is null))" | tr -d '[:space:]')
[ "$L9_TIME" = "t" ] || L9_OK=0
[ "$L9_ACTIVITY_AFTER" = "$L9_ACTIVITY_BEFORE" ] || L9_OK=0
[ "$L9_CACHE" = "0" ] || L9_OK=0
if [ "$L9_OK" != "1" ]; then
  echo "!! FAIL: legacy measurements did not migrate as designed (time $L9_TIME, activity $L9_ACTIVITY_BEFORE -> $L9_ACTIVITY_AFTER, cache mismatches $L9_CACHE)"
  exit 1
fi
echo "    ok  one observation per measured spec, none for the unmeasured one; the audited actor and the audit row's time were kept; an unknown actor or time stayed NULL"
echo "    ok  the migration wrote no activity rows and the current-value cache agrees with the history"

echo "==> applying the department reconciliation test fixture (5 -> 10 active)"
RECON_MANIFEST=$(cat supabase/reconciliation/test_seed_manifest.json)
RECON_OUT=$(psql_in -v ON_ERROR_STOP=1 <<SQL
-- is_local=false (session-scoped): these statements are not wrapped in an
-- explicit transaction, so a true (transaction-local) setting would be
-- discarded before the next statement even runs.
select set_config('role', 'authenticated', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000aa', false);
select reconciliation_apply('$RECON_MANIFEST'::jsonb);
SQL
)
echo "$RECON_OUT" | command grep -q '"applied": true' \
  || { echo "!! department reconciliation test fixture did not apply:"; echo "$RECON_OUT"; exit 1; }
echo "    ok  test_seed_manifest.json applied — 10 active departments"

# ---------------------------------------------------------------- department
# cap races: two REAL two-process races, mirroring the promote_proposal race
# below. Each needs exactly 9 active departments first (reconciliation just
# left 10); the department archived to get there has no tasks in a fresh
# disposable DB, so the archive-guard trigger never blocks it.
department_race() {
  local label="$1" stmt_a="$2" stmt_b="$3"
  local sql sql_b
  sql=$(cat <<SQL
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000aa', true);
select pg_sleep(0.3);
$stmt_a
commit;
SQL
)
  sql_b=$(cat <<SQL
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000aa', true);
select pg_sleep(0.3);
$stmt_b
commit;
SQL
)
  echo "==> racing two real psql processes at 9 active departments ($label)"
  psql_in -f - <<<"$sql"   > "$WORK/dept_race_${label}_a.txt" 2>&1 &
  local ra=$!
  psql_in -f - <<<"$sql_b" > "$WORK/dept_race_${label}_b.txt" 2>&1 &
  local rb=$!
  wait "$ra" "$rb"

  local successes active_now
  successes=$(cat "$WORK/dept_race_${label}_a.txt" "$WORK/dept_race_${label}_b.txt" | command grep -c '^INSERT\|^UPDATE 1' || true)
  active_now=$(psql_in -tA -c "select count(*) from subteams where archived_at is null")
  if [ "$successes" != "1" ] || [ "$(echo "$active_now" | tr -d '[:space:]')" != "10" ]; then
    echo "!! FAIL: department cap race ($label): expected exactly 1 success and 10 active after, got $successes success(es) and $active_now active"
    echo "--- session A ---"; cat "$WORK/dept_race_${label}_a.txt"
    echo "--- session B ---"; cat "$WORK/dept_race_${label}_b.txt"
    exit 1
  fi
  echo "    ok  $label: exactly one winner, 10 active departments after"
}

psql_in -v ON_ERROR_STOP=1 -c "update subteams set archived_at = now(), archived_by = '00000000-0000-4000-8000-0000000000aa', archive_reason = 'verify-db race setup' where key = 'VERIFY_FILL_5'" >/dev/null
department_race "create-vs-create" \
  "insert into subteams (key, name) values ('VERIFY_RACE_C1', 'Verify Race C1') returning key;" \
  "insert into subteams (key, name) values ('VERIFY_RACE_C2', 'Verify Race C2') returning key;"

psql_in -v ON_ERROR_STOP=1 -c "update subteams set archived_at = now(), archived_by = '00000000-0000-4000-8000-0000000000aa', archive_reason = 'verify-db race setup' where key = 'VERIFY_FILL_4'" >/dev/null
department_race "create-vs-restore" \
  "insert into subteams (key, name) values ('VERIFY_RACE_C3', 'Verify Race C3') returning key;" \
  "update subteams set archived_at = null, archived_by = null, archive_reason = null where key = 'VERIFY_FILL_5' returning key;"

echo "==> fixture for the promotion concurrency checks (Head, department, milestone, requirement, proposals)"
# Proposals are created with every mandatory field (Phase 3): a department
# with a Head, a same-season milestone, and a requirement. Direct INSERTs are
# fine here because this runs as the superuser, which bypasses RLS; the
# commands under test are exercised as the authenticated Head below.
FIXTURE_SQL=$(cat <<'SQL'
do $$
declare
  head  uuid := '00000000-0000-4000-8000-0000000000cc';
  other uuid := '00000000-0000-4000-8000-0000000000dd';
  season uuid;
  dept text;
  clause text;
  p_race uuid; p_a uuid; p_b uuid;
begin
  insert into auth.users (id, email) values (head, 'verify-head@roles.test'), (other, 'verify-other@roles.test');
  insert into members (id, full_name, role) values (head, 'Verify Head', 'Chassis'), (other, 'Verify Other', 'Chassis');
  -- Not is_current: promote_proposal() takes its season explicitly.
  insert into seasons (label, is_current) values ('VERIFY-CONCURRENCY', false) returning id into season;
  insert into milestones (key, season_id, ordinal, name) values ('VC-MS1', season, 1, 'Verify milestone');
  select key into dept from subteams where archived_at is null order by sort_order, key limit 1;
  update subteams set lead_id = head where key = dept;
  select clause_key into clause from clauses order by clause_key limit 1;
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key)
    values (season, 'Race me', other, dept, '2026-12-01', 'VC-MS1') returning id into p_race;
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key)
    values (season, 'Promote before head change', other, dept, '2026-12-01', 'VC-MS1') returning id into p_a;
  insert into task_proposals (season_id, title, raised_by, subteam_key, due_date, milestone_key)
    values (season, 'Promote after head change', other, dept, '2026-12-01', 'VC-MS1') returning id into p_b;
  insert into proposal_requirements (proposal_id, clause_key) values (p_race, clause), (p_a, clause), (p_b, clause);
  raise notice 'FIXTURE % % % % %', p_race, season, dept, p_a, p_b;
end $$;
SQL
)
FIXTURE_OUT=$(psql_in -v ON_ERROR_STOP=1 -c "$FIXTURE_SQL" 2>&1)
FIXTURE_LINE=$(echo "$FIXTURE_OUT" | command grep -oE 'FIXTURE [0-9a-f-]+ [0-9a-f-]+ [A-Za-z0-9_]+ [0-9a-f-]+ [0-9a-f-]+')
PROP_ID=$(echo "$FIXTURE_LINE" | awk '{print $2}')
SEASON_ID=$(echo "$FIXTURE_LINE" | awk '{print $3}')
DEPT_KEY=$(echo "$FIXTURE_LINE" | awk '{print $4}')
PROP_A=$(echo "$FIXTURE_LINE" | awk '{print $5}')
PROP_B=$(echo "$FIXTURE_LINE" | awk '{print $6}')
if [ -z "$PROP_ID" ] || [ -z "$SEASON_ID" ] || [ -z "$DEPT_KEY" ] || [ -z "$PROP_A" ] || [ -z "$PROP_B" ]; then
  echo "!! could not read the fixture ids from:"
  echo "$FIXTURE_OUT"
  exit 1
fi
HEAD_ID=00000000-0000-4000-8000-0000000000cc
OTHER_ID=00000000-0000-4000-8000-0000000000dd
PRESIDENT_ID=00000000-0000-4000-8000-0000000000aa

as_user_sql() {
  cat <<SQL
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '$1', true);
SQL
}

RACE_SQL="begin;
$(as_user_sql "$HEAD_ID")
select pg_sleep(0.3);
select (t.task).id as task_id, t.created
from promote_proposal('$PROP_ID', '$SEASON_ID') as t;
commit;"
echo "==> racing two real psql processes against promote_proposal() for the SAME proposal (both as the department Head)"
psql_in -f - <<<"$RACE_SQL" > "$WORK/race_a.txt" 2>&1 &
RACE_A=$!
psql_in -f - <<<"$RACE_SQL" > "$WORK/race_b.txt" 2>&1 &
RACE_B=$!
wait "$RACE_A" "$RACE_B" || true

TASK_A=$(command grep -A2 'task_id' "$WORK/race_a.txt" | tail -1 | awk '{print $1}')
TASK_B=$(command grep -A2 'task_id' "$WORK/race_b.txt" | tail -1 | awk '{print $1}')
CREATED_COUNT=$(cat "$WORK/race_a.txt" "$WORK/race_b.txt" | command grep -c ' t$' || true)
TASK_COUNT=$(psql_in -tA -c "select count(*) from tasks where source_proposal = '$PROP_ID'")
LINK_COUNT=$(psql_in -tA -c "select count(*) from task_requirements r join tasks t on t.id = r.task_id where t.source_proposal = '$PROP_ID'")

RACE_OK=1
if [ "$TASK_A" != "$TASK_B" ] || [ -z "$TASK_A" ]; then
  echo "!! FAIL: the two concurrent calls returned different task ids ($TASK_A vs $TASK_B)"
  RACE_OK=0
fi
if [ "$CREATED_COUNT" != "1" ]; then
  echo "!! FAIL: expected exactly one of the two concurrent calls to report created=true, got $CREATED_COUNT"
  RACE_OK=0
fi
if [ "$(echo "$TASK_COUNT" | tr -d '[:space:]')" != "1" ] || [ "$(echo "$LINK_COUNT" | tr -d '[:space:]')" != "1" ]; then
  echo "!! FAIL: expected exactly one task row and one requirement link for the raced proposal, found $TASK_COUNT task(s) and $LINK_COUNT link(s)"
  RACE_OK=0
fi
if [ "$RACE_OK" = "1" ]; then
  echo "    ok  two genuinely concurrent promote_proposal() calls on the same proposal"
  echo "        converged on task $TASK_A, exactly one created=true, one task row, one requirement link"
else
  echo "--- session A ---"; cat "$WORK/race_a.txt"
  echo "--- session B ---"; cat "$WORK/race_b.txt"
fi

# ------------------------------------------------ promotion vs Head replacement
# Department row locked FIRST by every command (ADR-0005), so a Head change and
# a promotion are strictly ordered. Two deterministic orderings, controlled by
# pg_sleep so the first session provably still holds its locks when the second
# one arrives:
#   1. promotion first: the Head replacement waits, the task is created, the
#      new Head is in place afterwards.
#   2. Head replacement first: the promotion waits, then finds the caller is no
#      longer Head and is refused; no task exists.
head_race() {
  local label="$1" proposal="$2" first="$3" expect_task="$4"
  local promote_sql change_sql promote_pre="" promote_post="" change_pre="" change_post=""
  if [ "$first" = "promote" ]; then
    promote_post="select pg_sleep(1.8);"
    change_pre="select pg_sleep(0.6);"
  else
    promote_pre="select pg_sleep(0.6);"
    change_post="select pg_sleep(1.8);"
  fi
  promote_sql="begin;
$(as_user_sql "$HEAD_ID")
$promote_pre
select (t.task).id as task_id, t.created from promote_proposal('$proposal', '$SEASON_ID') as t;
$promote_post
commit;"
  change_sql="begin;
$(as_user_sql "$PRESIDENT_ID")
$change_pre
update subteams set lead_id = '$OTHER_ID' where key = '$DEPT_KEY' returning key;
$change_post
commit;"
  echo "==> racing promotion against Head replacement ($label)"
  psql_in -f - <<<"$promote_sql" > "$WORK/head_race_${label}_promote.txt" 2>&1 &
  local rp=$!
  psql_in -f - <<<"$change_sql" > "$WORK/head_race_${label}_change.txt" 2>&1 &
  local rc=$!
  wait "$rp" "$rc" || true

  local tasks lead
  tasks=$(psql_in -tA -c "select count(*) from tasks where source_proposal = '$proposal'" | tr -d '[:space:]')
  lead=$(psql_in -tA -c "select lead_id from subteams where key = '$DEPT_KEY'" | tr -d '[:space:]')
  local ok=1
  [ "$tasks" = "$expect_task" ] || { echo "!! FAIL ($label): expected $expect_task task(s), found $tasks"; ok=0; }
  [ "$lead" = "$OTHER_ID" ] || { echo "!! FAIL ($label): the Head replacement did not land (lead is $lead)"; ok=0; }
  if [ "$first" = "change" ]; then
    command grep -q 'may promote it' "$WORK/head_race_${label}_promote.txt" \
      || { echo "!! FAIL ($label): the promotion was not refused for the replaced Head"; ok=0; }
  else
    command grep -q ' t$' "$WORK/head_race_${label}_promote.txt" \
      || { echo "!! FAIL ($label): the promotion did not report created=true"; ok=0; }
  fi
  if [ "$ok" != "1" ]; then
    echo "--- promotion ---"; cat "$WORK/head_race_${label}_promote.txt"
    echo "--- Head change ---"; cat "$WORK/head_race_${label}_change.txt"
    RACE_OK=0
  else
    echo "    ok  $label: $tasks task(s), Head replacement applied, ordering respected"
  fi
  psql_in -v ON_ERROR_STOP=1 -c "update subteams set lead_id = '$HEAD_ID' where key = '$DEPT_KEY'" >/dev/null
}
head_race "promotion-first" "$PROP_A" "promote" 1
head_race "head-change-first" "$PROP_B" "change" 0

# ---------------------------------------------- submit vs department archive
# submit_proposal() holds the department row (FOR SHARE) until it commits, and
# guard_department_archive() takes the same row FOR UPDATE before counting, so
# a proposal that is in flight can never be stranded in an archived department:
#   1. submit first: the archive waits, then is refused (an unresolved proposal
#      now exists) and the department stays active.
#   2. archive first: the submit waits, then is refused (the department is
#      archived) and no proposal exists.
FREE_DEPTS=$(psql_in -tA -c "
select key from subteams s
where archived_at is null and key <> '$DEPT_KEY'
  and not exists (select 1 from tasks t where t.subteam_key = s.key and t.state not in ('done','cancelled'))
  and not exists (select 1 from task_proposals p where p.subteam_key = s.key and p.archived_at is null and p.state <> 'decided')
order by sort_order, key limit 2")
ARCH_A=$(echo "$FREE_DEPTS" | sed -n 1p | tr -d '[:space:]')
ARCH_B=$(echo "$FREE_DEPTS" | sed -n 2p | tr -d '[:space:]')
CLAUSE_KEY=$(psql_in -tA -c "select clause_key from clauses order by clause_key limit 1" | tr -d '[:space:]')
if [ -z "$ARCH_A" ] || [ -z "$ARCH_B" ] || [ -z "$CLAUSE_KEY" ]; then
  echo "!! could not find two free departments and a clause for the archive races"; exit 1
fi

archive_race() {
  local label="$1" dept="$2" first="$3" expect_proposals="$4" expect_active="$5"
  local submit_pre="" submit_post="" archive_pre="" archive_post=""
  if [ "$first" = "submit" ]; then
    submit_post="select pg_sleep(1.8);"; archive_pre="select pg_sleep(0.6);"
  else
    submit_pre="select pg_sleep(0.6);"; archive_post="select pg_sleep(1.8);"
  fi
  local submit_sql archive_sql
  submit_sql="begin;
$(as_user_sql "$OTHER_ID")
$submit_pre
select (submit_proposal('$SEASON_ID', 'Race to archive ($label)', '$dept', '2026-12-01', 'VC-MS1', array['$CLAUSE_KEY'])).id;
$submit_post
commit;"
  archive_sql="begin;
$(as_user_sql "$PRESIDENT_ID")
$archive_pre
update subteams set archived_at = now(), archived_by = '$PRESIDENT_ID', archive_reason = 'verify-db race' where key = '$dept' returning key;
$archive_post
commit;"
  echo "==> racing submit_proposal() against a department archive ($label)"
  psql_in -f - <<<"$submit_sql" > "$WORK/arch_race_${label}_submit.txt" 2>&1 &
  local rs=$!
  psql_in -f - <<<"$archive_sql" > "$WORK/arch_race_${label}_archive.txt" 2>&1 &
  local ra=$!
  wait "$rs" "$ra" || true
  local props active ok=1
  props=$(psql_in -tA -c "select count(*) from task_proposals where subteam_key = '$dept'" | tr -d '[:space:]')
  active=$(psql_in -tA -c "select archived_at is null from subteams where key = '$dept'" | tr -d '[:space:]')
  [ "$props" = "$expect_proposals" ] || { echo "!! FAIL ($label): expected $expect_proposals proposal(s), found $props"; ok=0; }
  [ "$active" = "$expect_active" ] || { echo "!! FAIL ($label): expected department active=$expect_active, got $active"; ok=0; }
  if [ "$first" = "submit" ]; then
    command grep -q 'unresolved proposal' "$WORK/arch_race_${label}_archive.txt" || { echo "!! FAIL ($label): the archive was not refused for the unresolved proposal"; ok=0; }
  else
    command grep -q 'active department' "$WORK/arch_race_${label}_submit.txt" || { echo "!! FAIL ($label): the submission was not refused for the archived department"; ok=0; }
  fi
  if [ "$ok" != "1" ]; then
    echo "--- submit ---"; cat "$WORK/arch_race_${label}_submit.txt"
    echo "--- archive ---"; cat "$WORK/arch_race_${label}_archive.txt"
    RACE_OK=0
  else
    echo "    ok  $label: $props proposal(s), department active=$active, ordering respected"
  fi
}
archive_race "submit-first" "$ARCH_A" "submit" 1 "t"
archive_race "archive-first" "$ARCH_B" "archive" 0 "f"
# The proposal the first race left behind would (correctly) block the
# department-headroom step in department_lifecycle_test.sql, so remove it. This
# is the superuser cleaning up a fixture, not a product path.
psql_in -v ON_ERROR_STOP=1 -c "delete from task_proposals where title like 'Race to archive%'" >/dev/null

# ------------------------------------------------------ measurement races
# Real concurrency for record_spec_measurement(): each command takes the spec's
# row lock, so a retry of one save stays one row, and two saves for one spec
# leave the current value on the newest MEASURED time whichever commits first.
echo "==> fixture for the measurement races (two active members, a season, three specifications)"
MEAS_M1='00000000-0000-4000-8000-0000000000e1'
MEAS_M2='00000000-0000-4000-8000-0000000000e2'
MEAS_SEASON='00000000-0000-4000-8000-0000000000e5'
MEAS_SPEC_RETRY='00000000-0000-4000-8000-0000000000e6'
MEAS_SPEC_A='00000000-0000-4000-8000-0000000000e7'
MEAS_SPEC_B='00000000-0000-4000-8000-0000000000e8'
psql_in -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, email) values ('$MEAS_M1', 'verify-meas1@roles.test'), ('$MEAS_M2', 'verify-meas2@roles.test');
insert into members (id, full_name, role) values ('$MEAS_M1', 'Verify Meas 1', 'Chassis'), ('$MEAS_M2', 'Verify Meas 2', 'Chassis');
insert into seasons (id, label, is_current) values ('$MEAS_SEASON', 'VERIFY-MEAS-RACE', false);
insert into specs (id, season_id, parameter, comparator, direction, target, unit) values
  ('$MEAS_SPEC_RETRY', '$MEAS_SEASON', 'Race retry', 'min', 'higher_better', 1, 'kg'),
  ('$MEAS_SPEC_A', '$MEAS_SEASON', 'Race newer first', 'min', 'higher_better', 1, 'kg'),
  ('$MEAS_SPEC_B', '$MEAS_SEASON', 'Race older first', 'min', 'higher_better', 1, 'kg');
SQL

measure_session_sql() {
  local user="$1" spec="$2" value="$3" at="$4" req="$5"
  cat <<SQL
begin;
$(as_user_sql "$user")
select pg_sleep(0.3);
select (record_spec_measurement(p_season_id => '$MEAS_SEASON', p_spec_id => '$spec', p_value_numeric => $value, p_measured_at => '$at', p_request_id => '$req')).id as measurement_id;
commit;
SQL
}

measure_race() {
  local label="$1" sql_a="$2" sql_b="$3"
  echo "==> racing two real psql processes recording a measurement ($label)"
  psql_in -f - <<<"$sql_a" > "$WORK/meas_${label}_a.txt" 2>&1 &
  local ra=$!
  psql_in -f - <<<"$sql_b" > "$WORK/meas_${label}_b.txt" 2>&1 &
  local rb=$!
  wait "$ra" "$rb" || true
  if command grep -q 'ERROR' "$WORK/meas_${label}_a.txt" "$WORK/meas_${label}_b.txt"; then
    echo "!! FAIL: measurement race ($label): a session failed"
    echo "--- session A ---"; cat "$WORK/meas_${label}_a.txt"
    echo "--- session B ---"; cat "$WORK/meas_${label}_b.txt"
    RACE_OK=0
  fi
}

REQ_SAME='00000000-0000-4000-8000-0000000000c1'
measure_race "retry" \
  "$(measure_session_sql "$MEAS_M1" "$MEAS_SPEC_RETRY" 5 '2026-01-01T00:00:00Z' "$REQ_SAME")" \
  "$(measure_session_sql "$MEAS_M1" "$MEAS_SPEC_RETRY" 5 '2026-01-01T00:00:00Z' "$REQ_SAME")"
# The id is the row under the `measurement_id` header (the psql output also echoes the
# session's JWT claims, which hold a member id, so a bare uuid grep would read that).
ID_A=$(command grep -A2 'measurement_id' "$WORK/meas_retry_a.txt" | tail -1 | awk '{print $1}')
ID_B=$(command grep -A2 'measurement_id' "$WORK/meas_retry_b.txt" | tail -1 | awk '{print $1}')
ROW_ID=$(psql_in -tA -c "select id from spec_measurements where spec_id = '$MEAS_SPEC_RETRY'" | tr -d '[:space:]')
RETRY_ROWS=$(psql_in -tA -c "select count(*) from spec_measurements where spec_id = '$MEAS_SPEC_RETRY'" | tr -d '[:space:]')
RETRY_EVENTS=$(psql_in -tA -c "select count(*) from activity where entity = 'spec' and entity_id = '$MEAS_SPEC_RETRY' and action = 'measurement_recorded'" | tr -d '[:space:]')
if [ "$RETRY_ROWS" != "1" ] || [ "$RETRY_EVENTS" != "1" ] || [ -z "$ID_A" ] || [ "$ID_A" != "$ID_B" ] || [ "$ID_A" != "$ROW_ID" ]; then
  echo "!! FAIL: two concurrent saves with ONE request id: expected 1 row, 1 event and the stored row's id from both, got $RETRY_ROWS row(s), $RETRY_EVENTS event(s), $ID_A vs $ID_B"
  RACE_OK=0
else
  echo "    ok  retry: both sessions returned observation $ID_A; one row, one activity event"
fi

# Newer MEASURED time in session A, older in B, and the reverse: the current value
# must be the newer measurement either way, and the cache must point at it.
measure_race "newer-first" \
  "$(measure_session_sql "$MEAS_M1" "$MEAS_SPEC_A" 10 '2026-01-02T00:00:00Z' '00000000-0000-4000-8000-0000000000c2')" \
  "$(measure_session_sql "$MEAS_M2" "$MEAS_SPEC_A" 20 '2026-01-01T00:00:00Z' '00000000-0000-4000-8000-0000000000c3')"
measure_race "older-first" \
  "$(measure_session_sql "$MEAS_M1" "$MEAS_SPEC_B" 10 '2026-01-01T00:00:00Z' '00000000-0000-4000-8000-0000000000c4')" \
  "$(measure_session_sql "$MEAS_M2" "$MEAS_SPEC_B" 20 '2026-01-02T00:00:00Z' '00000000-0000-4000-8000-0000000000c5')"
for pair in "$MEAS_SPEC_A:10" "$MEAS_SPEC_B:20"; do
  spec="${pair%%:*}"; want="${pair##*:}"
  GOT=$(psql_in -tA -F'|' -c "select (select count(*) from spec_measurements where spec_id = s.id), s.measured, (s.current_measurement_id = (select id from spec_measurements where spec_id = s.id and value_numeric = $want)) from specs s where s.id = '$spec'")
  if [ "$GOT" != "2|$want|t" ]; then
    echo "!! FAIL: two concurrent saves for one specification: expected 2 rows, current $want and the pointer on it, got $GOT"
    RACE_OK=0
  else
    echo "    ok  two concurrent saves: 2 rows, current value $want (the newest measured time), cache pointer consistent"
  fi
done

# ------------------------------------------------------ archive race (Phase 14)
# archive_task() locks the task FOR UPDATE before checking it (finding F14-01),
# so two concurrent archives of one task by its Head give exactly one success;
# the other waits, sees the task already archived and is refused. Without the
# lock both succeeded and the second silently re-stamped the first.
echo "==> racing two real psql processes archiving the SAME task (both as its Head)"
ARCH_HEAD='00000000-0000-4000-8000-0000000000d1'
ARCH_TASK='00000000-0000-4000-8000-0000000000d2'
ARCH_PRIOR_LEAD=$(psql_in -tA -c "select coalesce(lead_id::text, '') from subteams where key = '$DEPT_KEY'" | tr -d '[:space:]')
psql_in -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, email) values ('$ARCH_HEAD', 'verify-archive-head@roles.test');
insert into members (id, full_name, role) values ('$ARCH_HEAD', 'Verify Archive Head', 'Chassis');
update subteams set lead_id = '$ARCH_HEAD' where key = '$DEPT_KEY';
insert into tasks (id, season_id, title, subteam_key, state) values ('$ARCH_TASK', '$SEASON_ID', 'Race to archive one task', '$DEPT_KEY', 'wip');
SQL
ARCHIVE_SQL="begin;
$(as_user_sql "$ARCH_HEAD")
select pg_sleep(0.3);
select archive_reason as archived_as from archive_task('$ARCH_TASK', 'manual');
select pg_sleep(0.5);
commit;"
psql_in -f - <<<"$ARCHIVE_SQL" > "$WORK/archive_race_a.txt" 2>&1 &
AR_A=$!
psql_in -f - <<<"$ARCHIVE_SQL" > "$WORK/archive_race_b.txt" 2>&1 &
AR_B=$!
wait "$AR_A" "$AR_B" || true
AR_WINS=$(cat "$WORK/archive_race_a.txt" "$WORK/archive_race_b.txt" | command grep -c '^ manual$' || true)
AR_REFUSED=$(cat "$WORK/archive_race_a.txt" "$WORK/archive_race_b.txt" | command grep -c 'already archived' || true)
AR_ROW=$(psql_in -tA -F'|' -c "select archive_reason, archived_by = '$ARCH_HEAD' from tasks where id = '$ARCH_TASK'")
AR_EVENTS=$(psql_in -tA -c "select count(*) from activity where entity = 'task' and entity_id = '$ARCH_TASK' and action = 'archived'" | tr -d '[:space:]')
if [ "$AR_WINS" != "1" ] || [ "$AR_REFUSED" != "1" ] || [ "$AR_ROW" != "manual|t" ] || [ "$AR_EVENTS" != "1" ]; then
  echo "!! FAIL: concurrent archive_task(): expected 1 success, 1 'already archived' refusal, one archived event; got $AR_WINS success(es), $AR_REFUSED refusal(s), row $AR_ROW, $AR_EVENTS event(s)"
  echo "--- session A ---"; cat "$WORK/archive_race_a.txt"
  echo "--- session B ---"; cat "$WORK/archive_race_b.txt"
  RACE_OK=0
else
  echo "    ok  two concurrent archives of one task: exactly one archived it (manual), the other was refused; one audit event"
fi
# Superuser fixture cleanup (not a product path): put the department's Head back.
psql_in -v ON_ERROR_STOP=1 -c "update subteams set lead_id = nullif('$ARCH_PRIOR_LEAD', '')::uuid where key = '$DEPT_KEY'" >/dev/null

echo "==> running supabase/tests/*.sql"
# Each test file reports its verdict by deliberately raising an exception —
# that is what rolls every fixture back, so it is kept. This loop turns that
# into a machine-checkable result. A file passes only if its output holds
# EXACTLY ONE `ERROR:` line and that line is its own "<NAME> CHECKS PASSED —
# all N checks" verdict. Any other error (a helper that failed to create, a
# syntax error, a FAILED verdict, a second exception) fails the file, so a
# broken setup step can never hide behind a later passing block.
shopt -s nullglob
TEST_FILES=(supabase/tests/*.sql)
if [ "${#TEST_FILES[@]}" -eq 0 ]; then
  echo "!! no supabase/tests/*.sql files found — refusing to report success on zero tests"
  exit 1
fi
OVERALL_OK=1
FILES_PASSED=0
CHECKS_PASSED=0
for f in "${TEST_FILES[@]}"; do
  name=$(basename "$f")
  OUT=$(psql_in -f - < "$f" 2>&1 || true)
  ERROR_LINES=$(echo "$OUT" | command grep -c 'ERROR:' || true)
  VERDICT=$(echo "$OUT" | command grep -oE 'ERROR:  [A-Z/ ]+ CHECKS PASSED — all [0-9]+ checks' || true)
  if [ "$ERROR_LINES" = "1" ] && [ -n "$VERDICT" ]; then
    N=$(echo "$VERDICT" | command grep -oE 'all [0-9]+' | awk '{print $2}')
    FILES_PASSED=$((FILES_PASSED + 1))
    CHECKS_PASSED=$((CHECKS_PASSED + N))
    echo "    ok    $name — ${VERDICT#ERROR:  }"
  else
    OVERALL_OK=0
    echo "    FAIL  $name ($ERROR_LINES error line(s); expected exactly one PASSED verdict)"
    echo "$OUT" | sed 's/^/          /'
  fi
done
echo "==> $FILES_PASSED/${#TEST_FILES[@]} SQL test files passed, $CHECKS_PASSED checks in total"

if [ "$RACE_OK" != "1" ] || [ "$OVERALL_OK" != "1" ]; then
  echo "==> VERIFY FAILED"
  exit 1
fi
echo "==> VERIFY PASSED — schema, RPCs and every supabase/tests/*.sql check are green from a clean checkout"
