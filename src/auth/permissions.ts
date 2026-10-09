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
  'documentation',
  'developer',
]

export const ROLE_LABELS: Record<PrivilegedRole, string> = {
  president: 'President',
  vicepresident: 'Vice President',
  treasurer: 'Treasurer',
  documentation: 'Documentation',
  developer: 'Developer',
}

// What each role may do, in one line — shown where roles are handed out.
export const ROLE_SUMMARIES: Record<PrivilegedRole, string> = {
  president: 'Runs Settings and seasons, and manages the roles available to the President.',
  vicepresident: 'Runs Settings and the Treasurer and Documentation roles; cannot switch seasons.',
  treasurer: 'Adds, edits and deletes financial entries.',
  documentation: 'Edits meetings, the default agenda and milestone sections. No access to finances.',
  developer: 'Full access, for maintenance: everything the other roles can do, roles included.',
}

// can_grant_role(role) (20260126000100): who may give or take away each role.
// Only a Developer may change the Developer role.
export function canGrantRole(roles: readonly PrivilegedRole[], role: PrivilegedRole): boolean {
  const has = (r: PrivilegedRole) => roles.includes(r)
  if (role === 'developer') return has('developer')
  if (role === 'president' || role === 'vicepresident') return has('president') || has('developer')
  return has('president') || has('vicepresident') || has('developer')
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

// Explanatory access notices should describe the club-facing roles without
// advertising the maintenance override. The real role still appears in the
// account badge and role editor, where an exact identity is required.
export function describePublicAccess(roles: readonly PrivilegedRole[]): string {
  const publicRoles = roles.filter((role) => role !== 'developer')
  if (publicRoles.length > 0) return describeRoles(publicRoles)
  return roles.includes('developer') ? 'Maintenance access' : describeRoles([])
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
  // is_admin(): rulebook, departments, roster, milestones
  canAdminister: boolean
  // can_add_members() (20260131000000): create a login and put a new person on
  // the roster (President, Vice President, Developer). Its own boolean, like
  // canManageDepartments, so it does not silently follow is_admin().
  canAddMembers: boolean
  // can_manage_roles(): open role management (President, Vice President,
  // Developer). Which roles may be changed is canGrantRole(roles, role).
  canManageRoles: boolean
  // can_manage_seasons(): create, edit and switch seasons (President, Developer)
  canManageSeasons: boolean
  // can_manage_milestone_structure(): create, rename and delete milestone
  // sections (President, Vice President, Developer, Documentation)
  canManageMilestoneStructure: boolean
  // can_view_finances(): see financial records — an explicit allowlist
  // (President, Vice President, Treasurer, Developer), not "any role"
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
  // can_edit_meetings(): call a meeting, write its agenda and minutes, edit
  // the default agenda (President, Vice President, Developer, Documentation).
  canCreateMeeting: boolean
  canDeleteMeeting: boolean
  canEditMeetingTemplate: boolean
}

export function permissionsFor(roles: readonly PrivilegedRole[]): Permissions {
  const held = new Set(roles)
  const hasRole = (role: PrivilegedRole) => held.has(role)
  // The sets the database uses: is_admin(), can_delete_records(),
  // can_edit_meetings() (20260126000100).
  const admin = hasRole('president') || hasRole('vicepresident') || hasRole('developer')
  const mayDelete = hasRole('president') || hasRole('developer')
  const editsMeetings = admin || hasRole('documentation')
  return {
    roles,
    hasRole,
    // The developer passes every check, for maintenance and security work:
    // supabase/migrations/20260107000000_developer_full_access.sql.
    canAdminister: admin,
    canAddMembers: hasRole('president') || hasRole('vicepresident') || hasRole('developer'),
    canManageRoles: admin,
    canManageSeasons: mayDelete,
    canManageMilestoneStructure: editsMeetings,
    canViewFinances: hasRole('president') || hasRole('vicepresident') || hasRole('treasurer') || hasRole('developer'),
    canManageFinances: hasRole('treasurer') || hasRole('developer'),
    // can_manage_departments() (20260115000000_department_lifecycle.sql).
    canManageDepartments: hasRole('president') || hasRole('vicepresident') || hasRole('developer'),
    // can_edit_spec_targets() (20260122000000_spec_targets_and_measurements.sql).
    canEditSpecTargets: hasRole('president') || hasRole('vicepresident') || hasRole('developer'),
    // Proposals (submit_proposal, 20260117), board tasks and meetings (20260108000000_proposals_and_meetings.sql).
    canSuggestProposal: true,
    canCreateMeeting: editsMeetings,
    canDeleteMeeting: mayDelete,
    canEditMeetingTemplate: editsMeetings,
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
  // Department keys this member heads, directly or as the Head of the parent
  // department (department_authority() 'head' / 'parent_head'), active only —
  // built by the caller from useSubteams() data, since this module owns no
  // data fetching of its own.
  headOf: readonly string[]
  // Active President or Vice President. They rank above every Head (role
  // hierarchy, 20260130000000): Head authority over every active department
  // and over unassigned work, and they restore any archived task.
  isGovernance?: boolean
  // The active departments where they act ('president' / 'vicepresident' in
  // department_authority()): for an active President or VP, all of them.
  governs?: readonly string[]
}

// department_authority(key) is not null (20260130000000): the Head (directly
// or through the parent), a Developer, or the President / Vice President for
// every active department and for unassigned work (key null).
export function hasDepartmentAuthority(actor: TaskActor, subteamKey: string | null): boolean {
  if (actor.status !== 'active') return false
  if (actor.isDeveloper) return true
  if (subteamKey === null) return actor.isGovernance === true
  return actor.headOf.includes(subteamKey) || (actor.governs ?? []).includes(subteamKey)
}

// can_edit_task(id): the active owner, or department authority over the
// task's department — and the task must not be archived.
export function canEditTask(
  actor: TaskActor,
  task: Pick<Task, 'owner_id' | 'subteam_key' | 'archived_at'>,
): boolean {
  if (actor.status !== 'active') return false
  if (task.archived_at !== null) return false
  if (task.owner_id === actor.id) return true
  return hasDepartmentAuthority(actor, task.subteam_key)
}

// guard_task_edit()'s owner-reassignment rule: department authority only —
// never the owner reassigning themselves away, which is why this is not
// folded into canEditTask above.
export function canReassignTaskOwner(
  actor: TaskActor,
  task: Pick<Task, 'subteam_key'>,
): boolean {
  return hasDepartmentAuthority(actor, task.subteam_key)
}

// archive_task(): department authority — deliberately NOT the plain owner.
export function canArchiveTask(
  actor: TaskActor,
  task: Pick<Task, 'subteam_key'>,
): boolean {
  return hasDepartmentAuthority(actor, task.subteam_key)
}

// restore_task(): department authority, or any active President / Vice
// President (the latest rule), never the plain owner.
export function canRestoreTask(
  actor: TaskActor,
  task: Pick<Task, 'subteam_key'>,
): boolean {
  if (actor.status !== 'active') return false
  return actor.isGovernance === true || hasDepartmentAuthority(actor, task.subteam_key)
}

// set_task_department() (20260126000400): an active President, Vice President or
// Developer may give any non-archived task any active department; a Head may move
// a task only between departments they head (directly or as the parent's Head),
// and never classifies unassigned work. Returns the departments this actor may
// move THIS task to (never its current one); empty = no control to show.
export function taskDepartmentTargets<D extends { key: string }>(
  actor: TaskActor,
  task: Pick<Task, 'subteam_key' | 'archived_at'>,
  activeDepartments: readonly D[],
): D[] {
  if (actor.status !== 'active' || task.archived_at !== null) return []
  const others = activeDepartments.filter((d) => d.key !== task.subteam_key)
  if (actor.isDeveloper || actor.isGovernance === true) return others
  if (task.subteam_key === null || !actor.headOf.includes(task.subteam_key)) return []
  return others.filter((d) => actor.headOf.includes(d.key))
}

// can_review_proposal(id): department authority over the proposal's
// department. Covers reviewing, parking, rejecting, reopening, editing and
// promoting. The President and VP act in every active department and for a
// proposal with no department yet (role hierarchy, 20260130000000).
export function canReviewProposal(actor: TaskActor, proposal: Pick<Proposal, 'subteam_key'>): boolean {
  return hasDepartmentAuthority(actor, proposal.subteam_key)
}

// Whether someone may review ANY proposal at all (for showing a review queue).
export function reviewsAnyProposal(actor: TaskActor): boolean {
  if (actor.status !== 'active') return false
  return actor.isDeveloper || actor.isGovernance === true || actor.headOf.length > 0 || (actor.governs ?? []).length > 0
}

// submit_proposal(): any active member, for any active department.
export function canSubmitProposal(actor: Pick<TaskActor, 'status'>): boolean {
  return actor.status === 'active'
}

// Task attachments (20260132000000_task_attachments.sql, docs/ultraplan Phase 3):
//   upload             request_attachment_upload(): can_edit_task(task) — owner or department authority,
//                      task not archived;
//   delete / caption   delete_attachment(), set_attachment_caption(): the active uploader, or department
//                      authority over the task's department (Head, parent Head, President, VP, Developer).
// Viewing is every member (is_member()), so it needs no flag here.
export type AttachmentPermissions = {
  canUpload: boolean
  // Department authority: may delete or caption ANY file of this task.
  canManageAll: boolean
  // The active actor's id, to recognise their own uploads; null for an alumnus (read-only).
  actorId: string | null
}

export function attachmentPermissions(
  actor: TaskActor,
  task: Pick<Task, 'owner_id' | 'subteam_key' | 'archived_at'>,
): AttachmentPermissions {
  const active = actor.status === 'active'
  return {
    canUpload: canEditTask(actor, task),
    canManageAll: hasDepartmentAuthority(actor, task.subteam_key),
    actorId: active ? actor.id : null,
  }
}

export function canManageAttachment(perms: AttachmentPermissions, uploadedBy: string | null): boolean {
  return perms.canManageAll || (perms.actorId !== null && uploadedBy === perms.actorId)
}
