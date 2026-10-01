import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { MANIFEST_PATH, runSql, type FixtureManifest } from './db.ts'

// Real fixtures for Phase 13's end-to-end scenarios, created against the
// LOCAL Supabase stack only (never the hosted project — see
// docs/redesign/EXECUTION_CONTRACT.md and Reqon_Phase_Prompts/handoff.md §1).
// Auth users go through GoTrue's real admin API (never a direct
// `auth.users` insert, which would need to reproduce GoTrue's own password
// hashing and bookkeeping); everything RLS would otherwise refuse to an
// ordinary role (a temporary Head assignment, a synthetic spec row) goes
// through the same superuser path scripts/verify_db.sh already uses.
const PASSWORD = 'Test1234!e2e'

function statusEnv(): { url: string; serviceKey: string } {
  const out = execSync('npx supabase status -o env', { encoding: 'utf8', cwd: process.cwd() })
  const get = (name: string) => {
    const m = out.match(new RegExp(`${name}="?([^"\\n]+)"?`))
    if (!m) throw new Error(`global-setup: ${name} not found in \`supabase status -o env\` — is the local stack running?`)
    return m[1]
  }
  return { url: get('API_URL'), serviceKey: get('SERVICE_ROLE_KEY') }
}

export default async function globalSetup() {
  const { url, serviceKey } = statusEnv()
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  async function createUser(email: string) {
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
    if (error || !data.user) throw new Error(`global-setup: creating ${email} failed: ${error?.message}`)
    return { id: data.user.id, email }
  }

  // No `president` fixture — see the note on FixtureManifest.users in db.ts.
  const [member, headA, headB, vicepresident, treasurer, developer, alumni, nonmember] = await Promise.all(
    ['e2e-member', 'e2e-head-a', 'e2e-head-b', 'e2e-vp', 'e2e-treasurer', 'e2e-developer', 'e2e-alumni', 'e2e-nonmember'].map((name) =>
      createUser(`${name}@test.local`),
    ),
  )

  // members rows — everyone except `nonmember`, who must reach the app with
  // a real login but no roster row (R4.1's "not on the club roster" state).
  for (const [u, status] of [
    [member, 'active'],
    [headA, 'active'],
    [headB, 'active'],
    [vicepresident, 'active'],
    [treasurer, 'active'],
    [developer, 'active'],
    [alumni, 'alumni'],
  ] as const) {
    runSql(`insert into members (id, full_name, status) values ('${u.id}', 'E2E ${u.email.split('@')[0]}', '${status}')`)
  }

  for (const [u, role] of [
    [vicepresident, 'vicepresident'],
    [treasurer, 'treasurer'],
    [developer, 'developer'],
  ] as const) {
    runSql(`insert into member_roles (member_id, role, assigned_by) values ('${u.id}', '${role}', '${u.id}')`)
  }

  // Two real, distinct departments, each temporarily headed by one fixture —
  // the two Heads are of DIFFERENT departments on purpose, so a cross-
  // department authorization negative (Head B on Head A's task) is real.
  const deptA = runSql(`select key, name, lead_id from subteams where key = 'MECH'`).trim().split('|')
  const deptB = runSql(`select key, name, lead_id from subteams where key = 'ELEC'`).trim().split('|')
  runSql(`update subteams set lead_id = '${headA.id}' where key = 'MECH'`)
  runSql(`update subteams set lead_id = '${headB.id}' where key = 'ELEC'`)

  const season = runSql(`select id, label from seasons where is_current`).trim().split('|')
  const otherSeason = runSql(`select id, label from seasons where not is_current limit 1`).trim().split('|')
  const milestoneKey = runSql(`select key from milestones where season_id = '${season[0]}' order by ordinal limit 1`).trim()
  const clauseKey = runSql(`select clause_key from clauses where printed_ref = 'F.13.3.1'`).trim()
  if (!clauseKey) throw new Error('global-setup: seed clause F.13.3.1 not found')

  // A synthetic spec, not the real seeded weight spec — Phase 9/10's own test
  // fixtures already used exactly these numbers (regulatory max 160,
  // acceptable upper bound 158, goal 145, ideal 138); reusing them keeps this
  // E2E run's expected verdicts traceable to the same documented scenario.
  const specId = runSql(
    `insert into specs (season_id, parameter, comparator, target, unit, direction, direction_reviewed_at, direction_note, acceptable, goal, ideal, plausible_min, plausible_max) ` +
      `values ('${season[0]}', 'E2E Vehicle Mass (Phase 13 fixture)', 'max', 160, 'kg', 'lower_better', now(), 'E2E fixture: reviewed', 158, 145, 138, 50, 300) returning id`,
  ).trim()

  // Four more synthetic specs so the mass-measurement E2E scenario also
  // covers higher-is-better, exact, range and boolean comparators through a
  // real browser — the real seeded regulation specs include these
  // comparators but none carries acceptable/goal/ideal, and none is boolean.
  const higherId = runSql(
    `insert into specs (season_id, parameter, comparator, target, unit, direction, direction_reviewed_at, direction_note, plausible_min, plausible_max) ` +
      `values ('${season[0]}', 'E2E Ground Clearance (Phase 13 fixture)', 'min', 100, 'mm', 'higher_better', now(), 'E2E fixture: reviewed', 0, 500) returning id`,
  ).trim()
  const exactId = runSql(
    `insert into specs (season_id, parameter, comparator, target, target_tolerance, unit, direction, plausible_min, plausible_max) ` +
      `values ('${season[0]}', 'E2E Drain Hole (Phase 13 fixture)', 'eq', 25, 0.5, 'mm', 'exact', 0, 100) returning id`,
  ).trim()
  const rangeId = runSql(
    `insert into specs (season_id, parameter, comparator, target, target_max, target_min_inclusive, target_max_inclusive, direction, plausible_min, plausible_max) ` +
      `values ('${season[0]}', 'E2E Number Range (Phase 13 fixture)', 'range', 1, 99, true, true, 'range', 0, 999) returning id`,
  ).trim()
  const booleanId = runSql(
    `insert into specs (season_id, parameter, comparator, target_bool, direction) ` +
      `values ('${season[0]}', 'E2E Kill Switch (Phase 13 fixture)', 'bool', true, 'boolean') returning id`,
  ).trim()

  const manifest: FixtureManifest = {
    password: PASSWORD,
    users: {
      member,
      headA,
      headB,
      vicepresident,
      treasurer,
      developer,
      alumni,
      nonmember,
    },
    departments: {
      headA: { key: deptA[0], name: deptA[1], priorLeadId: deptA[2] || null },
      headB: { key: deptB[0], name: deptB[1], priorLeadId: deptB[2] || null },
    },
    season: { id: season[0], label: season[1] },
    otherSeason: { id: otherSeason[0], label: otherSeason[1] },
    milestoneKey,
    clauseKey,
    spec: { id: specId, parameter: 'E2E Vehicle Mass (Phase 13 fixture)' },
    extraSpecs: {
      higher: { id: higherId, parameter: 'E2E Ground Clearance (Phase 13 fixture)', unit: 'mm' },
      exact: { id: exactId, parameter: 'E2E Drain Hole (Phase 13 fixture)', unit: 'mm' },
      range: { id: rangeId, parameter: 'E2E Number Range (Phase 13 fixture)' },
      boolean: { id: booleanId, parameter: 'E2E Kill Switch (Phase 13 fixture)' },
    },
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  // eslint-disable-next-line no-console
  console.log(`[e2e global-setup] fixtures ready: ${Object.keys(manifest.users).length} users, 5 specs (${specId})`)
}
