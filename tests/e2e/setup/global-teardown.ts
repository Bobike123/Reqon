import { existsSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { MANIFEST_PATH, readManifest, runSql } from './db.ts'

function statusEnv(): { url: string; serviceKey: string } {
  const out = execSync('npx supabase status -o env', { encoding: 'utf8', cwd: process.cwd() })
  const get = (name: string) => out.match(new RegExp(`${name}="?([^"\\n]+)"?`))?.[1] ?? ''
  return { url: get('API_URL'), serviceKey: get('SERVICE_ROLE_KEY') }
}

// Removes everything global-setup.ts created, and restores what it borrowed
// (the two departments' original Head), leaving the local database exactly
// as this run found it. Runs even if a test failed (Playwright always calls
// globalTeardown).
export default async function globalTeardown() {
  if (!existsSync(MANIFEST_PATH)) return // setup never completed; nothing to undo
  const manifest = readManifest()

  // Spec-created rows first (measurements before their spec, FK restrict).
  // spec_measurements is append-only by design (trg_guard_spec_measurement_rows
  // blocks UPDATE/DELETE, R27.3) — the mass-measurement E2E scenario deliberately
  // records real rows here, so removing them needs the same superuser
  // trigger-pause pattern task-proposal-flow.spec.ts already uses for tasks.
  const specIds = [manifest.spec.id, ...Object.values(manifest.extraSpecs).map((s) => s.id)]
  runSql(`alter table spec_readiness disable trigger trg_guard_spec_readiness_rows`)
  runSql(`alter table spec_measurements disable trigger trg_guard_spec_measurement_rows`)
  runSql(`alter table specs disable trigger trg_guard_spec_current_cache`)
  try {
    for (const id of specIds) {
      runSql(`delete from spec_readiness where spec_id = '${id}'`)
      // specs.current_measurement_id (FK restrict) must be cleared before its
      // row can be deleted.
      runSql(`update specs set current_measurement_id = null where id = '${id}'`)
      runSql(`delete from spec_measurements where spec_id = '${id}'`)
      runSql(`delete from specs where id = '${id}'`)
    }
  } finally {
    runSql(`alter table specs enable trigger trg_guard_spec_current_cache`)
    runSql(`alter table spec_measurements enable trigger trg_guard_spec_measurement_rows`)
    runSql(`alter table spec_readiness enable trigger trg_guard_spec_readiness_rows`)
  }

  // The second season, if global-setup had to create one (it is empty: the
  // season-switch test only flips is_current, so the delete guard allows it).
  if (manifest.otherSeason.createdByFixture) {
    // Clear any other current season first: seasons_one_current allows one.
    runSql(`update seasons set is_current = false where is_current and id <> '${manifest.season.id}'`)
    runSql(`update seasons set is_current = true where id = '${manifest.season.id}'`)
    runSql(`delete from seasons where id = '${manifest.otherSeason.id}' and not is_current`)
  }

  // Restore each department's original Head (NULL if it had none).
  for (const dept of [manifest.departments.headA, manifest.departments.headB]) {
    runSql(
      dept.priorLeadId
        ? `update subteams set lead_id = '${dept.priorLeadId}' where key = '${dept.key}'`
        : `update subteams set lead_id = null where key = '${dept.key}'`,
    )
  }

  // Any task/proposal/link a spec file created is that spec's own
  // responsibility to remove in its afterAll (see tests/e2e/setup/cleanup.ts)
  // — global teardown only removes the fixtures it itself created above and
  // the accounts below.
  const { url, serviceKey } = statusEnv()
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  for (const user of Object.values(manifest.users)) {
    // members row cascades from auth.users on delete; member_roles cascades from members.
    const { error } = await admin.auth.admin.deleteUser(user.id)
    // eslint-disable-next-line no-console
    if (error) console.error(`[e2e global-teardown] FAILED to delete ${user.email} (${user.id}): ${error.message}`)
  }

  rmSync(MANIFEST_PATH, { force: true })
  // eslint-disable-next-line no-console
  console.log('[e2e global-teardown] fixtures removed, departments restored')
}
