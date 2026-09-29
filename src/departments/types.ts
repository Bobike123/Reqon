import type { Database } from '../lib/database.types.ts'

// The department domain's own type alias (Phase 1 §"Update src/data/
// useSubteams.ts through a typed Department domain boundary" — matching how
// tasks/types.ts and proposals/types.ts already do this for their tables).
// The database table stays `subteams` (ADR-0001: renaming it would break
// views, exports, generated types and 1,146 clause references for no
// functional gain) — this alias is the one place that fact is written down,
// so the rest of the app can say "Department" throughout.
export type Department = Database['public']['Tables']['subteams']['Row']

// Reconciliation preflight rows (docs/redesign/DEPARTMENT_RECONCILIATION.md).
export type ReconciliationPreflightRow =
  Database['public']['Functions']['reconciliation_preflight']['Returns'][number]

// At most this many departments may be active (archived_at IS NULL) at
// once — enforced in the database (enforce_department_cap(), migration
// 20260115000000); this constant is presentation only; it must never be
// trusted as the authorization boundary.
export const DEPARTMENT_CAP = 10

export function isActive(department: Pick<Department, 'archived_at'>): boolean {
  return department.archived_at === null
}

export function activeCount(departments: readonly Pick<Department, 'archived_at'>[]): number {
  return departments.filter(isActive).length
}

// "Department" and "Head of Department" everywhere a person reads this app
// (source §53) — the database's own "subteams"/"lead_id" naming never
// surfaces in the UI.
export const DEPARTMENT_LABEL = 'Department'
export const DEPARTMENT_HEAD_LABEL = 'Head of Department'

export function headshipLabel(department: Pick<Department, 'lead_id'>): string {
  return department.lead_id === null ? 'No Head appointed' : DEPARTMENT_HEAD_LABEL
}

// is_parked keeps its own competition meaning ("these rules only bite at
// the Final Event") and is independent of archived_at — a parked department
// still counts toward the cap until it is explicitly archived (ADR-0001).
// Callers needing "is this department's Head lead_id still an active
// member" should compare against a fresh members query themselves; that
// join does not belong in this domain-only module (ADR-0011: pure models
// never import hooks).
