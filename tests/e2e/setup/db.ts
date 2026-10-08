import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Direct superuser access to the local Supabase Postgres container — the same
// mechanism scripts/verify_db.sh and the project's own docs describe for
// anything RLS would otherwise refuse an ordinary role (seeding a fixture
// that must look pre-existing, or cleaning up rows a real command created).
// Never touches anything but the local `supabase_db_reqon` container.
export function runSql(sql: string): string {
  return execFileSync('docker', ['exec', 'supabase_db_reqon', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], {
    encoding: 'utf8',
  })
}

export type FixtureManifest = {
  password: string
  // No `president` fixture: this local database has no pre-existing club
  // president, and `guard_last_president()` correctly refuses to let a
  // disposable fixture be the club's ONLY one, ever — a fixture user cannot
  // both hold the role and be safely removable. President's blanket lack of
  // task/proposal authority is verified at the DB layer instead
  // (phase4_adversarial_test.sql, roles_rls_test.sql), inside transactions
  // that always roll back. See docs/redesign/VERIFICATION.md.
  users: Record<
    'member' | 'headA' | 'headB' | 'vicepresident' | 'treasurer' | 'developer' | 'alumni' | 'nonmember',
    { id: string; email: string }
  >
  departments: {
    headA: { key: string; name: string; priorLeadId: string | null }
    headB: { key: string; name: string; priorLeadId: string | null }
  }
  season: { id: string; label: string }
  otherSeason: { id: string; label: string; createdByFixture: boolean }
  milestoneKey: string
  clauseKey: string
  spec: { id: string; parameter: string }
  // Real seeded specs cover min/max/eq/range comparators but none carry
  // acceptable/goal/ideal, and none is boolean — these four synthetic
  // fixtures close that gap for the mass-measurement E2E scenario without
  // touching real regulation rows (same convention as `spec` above).
  extraSpecs: {
    higher: { id: string; parameter: string; unit: string }
    exact: { id: string; parameter: string; unit: string }
    range: { id: string; parameter: string }
    boolean: { id: string; parameter: string }
  }
}

const MANIFEST_PATH = path.join(import.meta.dirname, '..', '.fixtures-manifest.json')

export function readManifest(): FixtureManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

export { MANIFEST_PATH }
