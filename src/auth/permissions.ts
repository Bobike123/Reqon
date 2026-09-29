import type { Database } from '../lib/database.types.ts'
import type { Proposal } from '../proposals/types.ts'
import type { Task } from '../tasks/types.ts'

export type PrivilegedRole = Database['public']['Enums']['privileged_role']

// Display order and wording, used wherever roles are shown. People never see
// the raw database value ('vicepresident').
export const PRIVILEGED_ROLES: readonly PrivilegedRole[] = [
  'president',
  'vicepresident',
  'treasurer',
  'developer',
]

export const ROLE_LABELS: Record<PrivilegedRole, string> = {
  president: 'President',
  vicepresident: 'Vice President',
  treasurer: 'Treasurer',
  developer: 'Developer',
}

// What each role may do, in one line — shown where roles are handed out.
export const ROLE_SUMMARIES: Record<PrivilegedRole, string> = {
  president: 'Runs Settings, and can give or take away roles.',
  vicepresident: 'Runs Settings like the President, but cannot change roles.',
  treasurer: 'Adds, edits and deletes financial entries.',
  developer: 'Full access, for maintenance: everything the other three roles can do, roles included.',
}

// Someone on the roster who holds no privileged role.
export const NO_ROLE_LABEL = 'Member'

export function sortRoles(roles: readonly PrivilegedRole[]): PrivilegedRole[] {
  return PRIVILEGED_ROLES.filter((role) => roles.includes(role))
}

// "President", "Treasurer and Developer", or "Member (no privileged role)".
export function describeRoles(roles: readonly PrivilegedRole[]): string {
  const labels = sortRoles(roles).map((role) => ROLE_LABELS[role])
  if (labels.length === 0) return `${NO_ROLE_LABEL} (no privileged role)`
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

// What the signed-in person may do — the ONE place the app decides it.
//
// This is a mirror of the SQL functions in
// supabase/migrations/20260105000000_privileged_roles.sql, and it is used only
// to decide what to SHOW. The database checks every one of these again on
// every request, so editing this file in the browser changes which buttons
// appear, never what is allowed. If you change a rule, change the SQL first.
export type Permissions = {
  roles: readonly PrivilegedRole[]
  hasRole: (role: PrivilegedRole) => boolean
  // is_admin(): rulebook, subsystems, roster, seasons, milestones
  canAdminister: boolean
  // can_manage_roles(): assign and remove privileged roles
  canManageRoles: boolean
  // can_view_finances(): see financial records
  canViewFinances: boolean
  // can_manage_finances(): create, edit and delete financial records
  canManageFinances: boolean
  // can_manage_departments(): create/rename/describe/appoint Head/reorder/
  // archive/restore a department. Deliberately its own boolean, not folded
  // into canAdminister — ADR-0003 keeps department configuration authority
  // separate from is_admin()'s other duties on purpose, even though today's
  // membership (president/vicepresident/developer) happens to be identical.
  canManageDepartments: boolean
  // can_edit_spec_targets(): edit specification rules and internal targets,
  // and administer another member's observation correction/withdrawal.
  // Measurement entry itself remains available to every active member.
  canEditSpecTargets: boolean
  // Any ACTIVE member may raise a proposal through submit_proposal(). Whether
  // someone may REVIEW or promote a given proposal depends on which proposal
  // it is (its department's Head, or a Developer) — see canReviewProposal
  // below, not a role-only boolean (ADR-0003, ADR-0005).
  canSuggestProposal: boolean
  // is_admin(): call a meeting and write its agenda and minutes.
  canCreateMeeting: boolean
  canDeleteMeeting: boolean
  canEditMeetingTemplate: boolean
}

export function permissionsFor(roles: readonly PrivilegedRole[]): Permissions {
  const held = new Set(roles)
  const hasRole = (role: PrivilegedRole) => held.has(role)
  // The two sets the database uses: is_admin() and can_delete_records().
  const admin = hasRole('president') || hasRole('vicepresident') || hasRole('developer')
  const mayDelete = hasRole('president') || hasRole('developer')
  return {
    roles,
    hasRole,
    // The developer passes every check, for maintenance and security work:
    // supabase/migrations/20260107000000_developer_full_access.sql.
    canAdminister: admin,
    canManageRoles: mayDelete,
    canViewFinances: held.size > 0,
    canManageFinances: hasRole('treasurer') || hasRole('developer'),
    // can_manage_departments() (20260115000000_department_lifecycle.sql).
    canManageDepartments: hasRole('president') || hasRole('vicepresident') || hasRole('developer'),
    // can_edit_spec_targets() (20260122000000_spec_targets_and_measurements.sql).
    canEditSpecTargets: hasRole('president') || hasRole('vicepresident') || hasRole('developer'),
    // Proposals (submit_proposal, 20260117), board tasks and meetings (20260108000000_proposals_and_meetings.sql).
    canSuggestProposal: true,
    canCreateMeeting: admin,
    canDeleteMeeting: mayDelete,
    canEditMeetingTemplate: mayDelete,
  }
}

export const NO_PERMISSIONS: Permissions = permissionsFor([])

// ---------------------------------------------------------------------------
// Task-level authorization (ADR-0003): a mirror of can_edit_task(id) /
// guard_task_edit()'s owner-reassignment rule / archive_task()'s authority
// check (20260116000000_task_lifecycle_and_authorization.sql), taking the
// ACTOR and the RESOURCE together — never a global "may edit tasks" boolean,
// because whether someone may edit a given task depends on which task it is.
//
// The database re-checks every one of these itself on every request; this
// is presentation only, used to decide what to show and to pre-empt an
// obviously-refused write, never trusted as the source of truth.
export type TaskActor = {
  id: string
  // member_state: an alumnus has read-only access to every task,
  // active/inactive gates ALL of the checks below (is_active_member()).
  status: 'active' | 'alumni'
  isDeveloper: boolean
  // Department keys this member currently heads (subteams.lead_id = id,
  // department not archived) — built by the caller from useSubteams() data,
  // since this module owns no data fetching of its own.
  headOf: readonly string[]
}

function isHeadOf(actor: TaskActor, subteamKey: string | null): boolean {
  return subteamKey !== null && actor.headOf.includes(subteamKey)
}

// can_edit_task(id): active owner, active Head of the task's department, or
// Developer — and the task must not be archived.
export function canEditTask(
  actor: TaskActor,
  task: Pick<Task, 'owner_id' | 'subteam_key' | 'archived_at'>,
): boolean {
  if (actor.status !== 'active') return false
  if (task.archived_at !== null) return false
  if (task.owner_id === actor.id) return true
  if (isHeadOf(actor, task.subteam_key)) return true
  return actor.isDeveloper
}

// guard_task_edit()'s owner-reassignment rule: Head of the task's department
// or Developer only — never the owner reassigning themselves away, which is
// why this is not folded into canEditTask above.
export function canReassignTaskOwner(
  actor: TaskActor,
  task: Pick<Task, 'subteam_key'>,
): boolean {
  if (actor.status !== 'active') return false
  if (isHeadOf(actor, task.subteam_key)) return true
  return actor.isDeveloper
}

// archive_task()/restore_task(): Head of the task's department or Developer
// only — deliberately NOT the plain owner, matching ADR-0003's matrix
// ("Archive/restore task" column has no "as owner" exception).
export function canArchiveTask(
  actor: TaskActor,
  task: Pick<Task, 'subteam_key'>,
): boolean {
  if (actor.status !== 'active') return false
  if (isHeadOf(actor, task.subteam_key)) return true
  return actor.isDeveloper
}

// can_review_proposal(id) (20260117000000_traceability_and_proposal_commands.sql):
// the active Head of the proposal's department, or a Developer. Governance
// roles alone (President/VP) grant nothing here. Covers reviewing, parking,
// rejecting, reopening, editing and promoting — one rule, one function,
// exactly as in SQL. A proposal with no department (legacy) can only be
// handled by a Developer.
export function canReviewProposal(actor: TaskActor, proposal: Pick<Proposal, 'subteam_key'>): boolean {
  if (actor.status !== 'active') return false
  if (isHeadOf(actor, proposal.subteam_key)) return true
  return actor.isDeveloper
}

// submit_proposal(): any active member, for any active department.
export function canSubmitProposal(actor: Pick<TaskActor, 'status'>): boolean {
  return actor.status === 'active'
}
