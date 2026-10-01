import { describe, expect, it } from 'vitest'
import {
  NO_PERMISSIONS,
  ROLE_LABELS,
  canArchiveTask,
  canEditTask,
  canGrantRole,
  canRestoreTask,
  hasDepartmentAuthority,
  reviewsAnyProposal,
  canReassignTaskOwner,
  canReviewProposal,
  canSubmitProposal,
  describeRoles,
  describePublicAccess,
  permissionsFor,
  taskDepartmentTargets,
  type PrivilegedRole,
  type TaskActor,
} from './permissions.ts'

// The same matrix supabase/tests/roles_rls_test.sql proves against the
// database. This file only checks that the UI's mirror agrees with it.
// Backend completion Phase 2 (PERMISSIONS.md §2.1): the Vice President now
// manages roles (within canGrantRole), seasons are President/Developer only,
// finance visibility is an explicit allowlist, and Documentation edits meetings.
type Row = {
  canAdminister: boolean; canManageRoles: boolean; canManageSeasons: boolean; canViewFinances: boolean
  canManageFinances: boolean; canEditSpecTargets: boolean; canCreateMeeting: boolean; canDeleteMeeting: boolean
  canManageMilestoneStructure: boolean
}
const MATRIX: Record<PrivilegedRole | 'member', Row> = {
  developer:     { canAdminister: true,  canManageRoles: true,  canManageSeasons: true,  canViewFinances: true,  canManageFinances: true,  canEditSpecTargets: true,  canCreateMeeting: true,  canDeleteMeeting: true,  canManageMilestoneStructure: true  },
  treasurer:     { canAdminister: false, canManageRoles: false, canManageSeasons: false, canViewFinances: true,  canManageFinances: true,  canEditSpecTargets: false, canCreateMeeting: false, canDeleteMeeting: false, canManageMilestoneStructure: false },
  president:     { canAdminister: true,  canManageRoles: true,  canManageSeasons: true,  canViewFinances: true,  canManageFinances: false, canEditSpecTargets: true,  canCreateMeeting: true,  canDeleteMeeting: true,  canManageMilestoneStructure: true  },
  vicepresident: { canAdminister: true,  canManageRoles: true,  canManageSeasons: false, canViewFinances: true,  canManageFinances: false, canEditSpecTargets: true,  canCreateMeeting: true,  canDeleteMeeting: false, canManageMilestoneStructure: true  },
  documentation: { canAdminister: false, canManageRoles: false, canManageSeasons: false, canViewFinances: false, canManageFinances: false, canEditSpecTargets: false, canCreateMeeting: true,  canDeleteMeeting: false, canManageMilestoneStructure: true  },
  member:        { canAdminister: false, canManageRoles: false, canManageSeasons: false, canViewFinances: false, canManageFinances: false, canEditSpecTargets: false, canCreateMeeting: false, canDeleteMeeting: false, canManageMilestoneStructure: false },
}

describe('the permission matrix', () => {
  for (const [who, expected] of Object.entries(MATRIX)) {
    it(`${who}`, () => {
      const p = permissionsFor(who === 'member' ? [] : [who as PrivilegedRole])
      expect({
        canAdminister: p.canAdminister,
        canManageRoles: p.canManageRoles,
        canManageSeasons: p.canManageSeasons,
        canViewFinances: p.canViewFinances,
        canManageFinances: p.canManageFinances,
        canEditSpecTargets: p.canEditSpecTargets,
        canCreateMeeting: p.canCreateMeeting,
        canDeleteMeeting: p.canDeleteMeeting,
        canManageMilestoneStructure: p.canManageMilestoneStructure,
      }).toEqual(expected)
    })
  }

  it('the President, the Vice President and the Developer open role management', () => {
    const managers = (['developer', 'treasurer', 'president', 'vicepresident', 'documentation'] as PrivilegedRole[])
      .filter((r) => permissionsFor([r]).canManageRoles)
    expect(managers).toEqual(['developer', 'president', 'vicepresident'])
  })

  it('mirrors can_grant_role(): only a Developer changes the Developer role, the VP only Treasurer and Documentation', () => {
    const grantable = (holder: PrivilegedRole) =>
      (['president', 'vicepresident', 'treasurer', 'documentation', 'developer'] as PrivilegedRole[]).filter((r) => canGrantRole([holder], r))
    expect(grantable('developer')).toEqual(['president', 'vicepresident', 'treasurer', 'documentation', 'developer'])
    expect(grantable('president')).toEqual(['president', 'vicepresident', 'treasurer', 'documentation'])
    expect(grantable('vicepresident')).toEqual(['treasurer', 'documentation'])
    expect(grantable('treasurer')).toEqual([])
    expect(grantable('documentation')).toEqual([])
  })

  it('only the President and the Developer switch seasons', () => {
    const switchers = (['developer', 'treasurer', 'president', 'vicepresident', 'documentation'] as PrivilegedRole[])
      .filter((r) => permissionsFor([r]).canManageSeasons)
    expect(switchers).toEqual(['developer', 'president'])
  })

  it('holding the Documentation role alone shows no finances', () => {
    expect(permissionsFor(['documentation']).canViewFinances).toBe(false)
    expect(permissionsFor(['documentation', 'treasurer']).canViewFinances).toBe(true)
  })

  it('the treasurer and the developer manage money', () => {
    const managers = (['developer', 'treasurer', 'president', 'vicepresident'] as PrivilegedRole[])
      .filter((r) => permissionsFor([r]).canManageFinances)
    expect(managers).toEqual(['developer', 'treasurer'])
  })

  it('the developer alone has every power the club has', () => {
    const p = permissionsFor(['developer'])
    expect([p.canAdminister, p.canManageRoles, p.canViewFinances, p.canManageFinances, p.canEditSpecTargets]).toEqual([
      true, true, true, true, true,
    ])
  })

  it('combines roles: a treasurer who is also developer keeps full access', () => {
    const p = permissionsFor(['treasurer', 'developer'])
    expect(p.canManageFinances).toBe(true)
    expect(p.canAdminister).toBe(true)
    expect(p.hasRole('developer')).toBe(true)
  })

  it('grants nothing to someone with no role, or who is not signed in', () => {
    expect(NO_PERMISSIONS.canAdminister || NO_PERMISSIONS.canManageRoles ||
      NO_PERMISSIONS.canViewFinances || NO_PERMISSIONS.canManageFinances).toBe(false)
    expect(NO_PERMISSIONS.canEditSpecTargets).toBe(false)
  })
})

// Mirrors supabase/tests/task_authorization_test.sql's role matrix (ADR-0003):
// active owner, active Head of the task's department, or Developer.
describe('task-level authorization (ADR-0003)', () => {
  const owner: TaskActor = { id: 'owner', status: 'active', isDeveloper: false, headOf: [] }
  const head: TaskActor = { id: 'head', status: 'active', isDeveloper: false, headOf: ['GEOM'] }
  const otherHead: TaskActor = { id: 'other-head', status: 'active', isDeveloper: false, headOf: ['BODY'] }
  const treasurer: TaskActor = { id: 'tre', status: 'active', isDeveloper: false, headOf: [] }
  const developer: TaskActor = { id: 'dev', status: 'active', isDeveloper: true, headOf: [] }
  const retiredOwner: TaskActor = { id: 'owner', status: 'alumni', isDeveloper: false, headOf: [] }

  const task = { owner_id: 'owner', subteam_key: 'GEOM', archived_at: null as string | null }

  it('the owner may edit their own task', () => {
    expect(canEditTask(owner, task)).toBe(true)
  })

  it('the Head of the task department may edit, even though they do not own it', () => {
    expect(canEditTask(head, task)).toBe(true)
  })

  it('the Head of a DIFFERENT department may not edit', () => {
    expect(canEditTask(otherHead, task)).toBe(false)
  })

  it('a bystander with no stake in the task may not edit', () => {
    expect(canEditTask(treasurer, task)).toBe(false)
  })

  it('the Developer may edit any task', () => {
    expect(canEditTask(developer, task)).toBe(true)
  })

  it('a retired (alumni) owner may no longer edit their former task', () => {
    expect(canEditTask(retiredOwner, task)).toBe(false)
  })

  it('an archived task cannot be edited by anyone through this check', () => {
    expect(canEditTask(head, { ...task, archived_at: '2026-09-01T00:00:00Z' })).toBe(false)
  })

  it('a task with no department: its owner, the Developer, or the President/VP (unassigned work)', () => {
    const noDept = { ...task, subteam_key: null }
    const governance: TaskActor = { id: 'pres', status: 'active', isDeveloper: false, headOf: [], isGovernance: true, governs: [] }
    expect(canEditTask(owner, noDept)).toBe(true)
    expect(canEditTask(developer, noDept)).toBe(true)
    expect(canEditTask(governance, noDept)).toBe(true)
    expect(canEditTask(head, noDept)).toBe(false)
  })

  it('the President/VP act only where no Head exists (governs), and restore anywhere', () => {
    const governance: TaskActor = { id: 'pres', status: 'active', isDeveloper: false, headOf: [], isGovernance: true, governs: ['OPS'] }
    expect(canEditTask(governance, task)).toBe(false)
    expect(canArchiveTask(governance, task)).toBe(false)
    expect(canEditTask(governance, { ...task, subteam_key: 'OPS' })).toBe(true)
    expect(canArchiveTask(governance, { ...task, subteam_key: 'OPS' })).toBe(true)
    expect(canRestoreTask(governance, task)).toBe(true)
    expect(canRestoreTask({ ...governance, status: 'alumni' }, task)).toBe(false)
  })

  it('restoring: the Head, the President/VP or a Developer — never the plain owner', () => {
    expect(canRestoreTask(owner, task)).toBe(false)
    expect(canRestoreTask(head, task)).toBe(true)
    expect(canRestoreTask(otherHead, task)).toBe(false)
    expect(canRestoreTask(developer, task)).toBe(true)
  })

  it('a Head of the parent department holds the subdepartment too (headOf lists both)', () => {
    const parentHead: TaskActor = { id: 'ph', status: 'active', isDeveloper: false, headOf: ['MECH', 'MECH_CHASSIS'] }
    expect(hasDepartmentAuthority(parentHead, 'MECH_CHASSIS')).toBe(true)
    expect(hasDepartmentAuthority(parentHead, 'ELEC')).toBe(false)
  })

  it('the owner cannot reassign their own task away — only the Head or Developer can', () => {
    expect(canReassignTaskOwner(owner, task)).toBe(false)
    expect(canReassignTaskOwner(head, task)).toBe(true)
    expect(canReassignTaskOwner(developer, task)).toBe(true)
  })

  it('archiving is Head-of-department or Developer only — never the plain owner', () => {
    expect(canArchiveTask(owner, task)).toBe(false)
    expect(canArchiveTask(head, task)).toBe(true)
    expect(canArchiveTask(otherHead, task)).toBe(false)
    expect(canArchiveTask(developer, task)).toBe(true)
  })
})

// set_task_department (20260126000400), checked in the database by task_department_test.sql: President,
// Vice President and Developer move any task anywhere; a Head only between departments they head.
describe('moving a task to another department (F6-01)', () => {
  const active = [{ key: 'GEOM' }, { key: 'BODY' }, { key: 'ELEC' }]
  const keys = (ds: { key: string }[]) => ds.map((d) => d.key)
  const unassigned = { subteam_key: null, archived_at: null }
  const geomTask = { subteam_key: 'GEOM', archived_at: null }

  it('lets the President, the Vice President and a Developer classify unassigned work into any department', () => {
    const president: TaskActor = { id: 'p', status: 'active', isDeveloper: false, headOf: [], isGovernance: true }
    const developer: TaskActor = { id: 'd', status: 'active', isDeveloper: true, headOf: [] }
    expect(keys(taskDepartmentTargets(president, unassigned, active))).toEqual(['GEOM', 'BODY', 'ELEC'])
    expect(keys(taskDepartmentTargets(developer, geomTask, active))).toEqual(['BODY', 'ELEC'])
  })

  it('lets a Head move work only between departments they head, and never classify unassigned work', () => {
    const twoHats: TaskActor = { id: 'h', status: 'active', isDeveloper: false, headOf: ['GEOM', 'BODY'] }
    const oneHat: TaskActor = { id: 'h1', status: 'active', isDeveloper: false, headOf: ['GEOM'] }
    expect(keys(taskDepartmentTargets(twoHats, geomTask, active))).toEqual(['BODY'])
    expect(taskDepartmentTargets(oneHat, geomTask, active)).toEqual([])
    expect(taskDepartmentTargets(twoHats, unassigned, active)).toEqual([])
    expect(taskDepartmentTargets(twoHats, { subteam_key: 'ELEC', archived_at: null }, active)).toEqual([])
  })

  it('offers nothing to a member, an alumnus, or for an archived task', () => {
    const member: TaskActor = { id: 'm', status: 'active', isDeveloper: false, headOf: [] }
    const retired: TaskActor = { id: 'r', status: 'alumni', isDeveloper: true, headOf: [], isGovernance: true }
    const developer: TaskActor = { id: 'd', status: 'active', isDeveloper: true, headOf: [] }
    expect(taskDepartmentTargets(member, unassigned, active)).toEqual([])
    expect(taskDepartmentTargets(retired, unassigned, active)).toEqual([])
    expect(taskDepartmentTargets(developer, { subteam_key: 'GEOM', archived_at: '2026-09-01' }, active)).toEqual([])
  })
})

describe('proposal authority (ADR-0003, ADR-0005)', () => {
  const head: TaskActor = { id: 'head', status: 'active', isDeveloper: false, headOf: ['GEOM'] }
  const otherHead: TaskActor = { id: 'other', status: 'active', isDeveloper: false, headOf: ['BODY'] }
  const member: TaskActor = { id: 'mem', status: 'active', isDeveloper: false, headOf: [] }
  const developer: TaskActor = { id: 'dev', status: 'active', isDeveloper: true, headOf: [] }
  const retiredHead: TaskActor = { ...head, status: 'alumni' }
  const inGeom = { subteam_key: 'GEOM' }

  it('the Head of the proposal\'s department may review and promote it', () => {
    expect(canReviewProposal(head, inGeom)).toBe(true)
  })

  it('the Head of another department may not', () => {
    expect(canReviewProposal(otherHead, inGeom)).toBe(false)
  })

  it('the President or Vice President have no proposal power where the department has a Head', () => {
    const president: TaskActor = { id: 'pres', status: 'active', isDeveloper: false, headOf: [], isGovernance: true, governs: [] }
    expect(canReviewProposal(president, inGeom)).toBe(false)
    expect(canReviewProposal(member, inGeom)).toBe(false)
  })

  it('... but decide for a department with no Head, and for a proposal with no department', () => {
    const president: TaskActor = { id: 'pres', status: 'active', isDeveloper: false, headOf: [], isGovernance: true, governs: ['GEOM'] }
    expect(canReviewProposal(president, inGeom)).toBe(true)
    expect(canReviewProposal(president, { subteam_key: null })).toBe(true)
    expect(reviewsAnyProposal(president)).toBe(true)
    expect(reviewsAnyProposal(member)).toBe(false)
  })

  it('a Developer may review any proposal', () => {
    expect(canReviewProposal(developer, inGeom)).toBe(true)
    expect(canReviewProposal(developer, { subteam_key: null })).toBe(true)
  })

  it('an older proposal with no department is not a Head\'s to decide', () => {
    expect(canReviewProposal(head, { subteam_key: null })).toBe(false)
  })

  it('a retired Head loses the authority at once', () => {
    expect(canReviewProposal(retiredHead, inGeom)).toBe(false)
  })

  it('any active member may raise a proposal; an alumnus may not', () => {
    expect(canSubmitProposal(member)).toBe(true)
    expect(canSubmitProposal({ status: 'alumni' })).toBe(false)
  })
})

describe('role names shown to people', () => {
  it('never shows a raw database value', () => {
    expect(ROLE_LABELS.vicepresident).toBe('Vice President')
    expect(Object.values(ROLE_LABELS)).not.toContain('vicepresident')
  })

  it('describes any set of roles in words, including none', () => {
    expect(describeRoles([])).toBe('Member (no privileged role)')
    // Exact: the account badge and the role editor must name every role a person holds.
    expect(describeRoles(['developer', 'treasurer'])).toBe('Treasurer and Developer')
    expect(describeRoles(['developer', 'president', 'vicepresident'])).toBe('President, Vice President and Developer')
  })

  // Access notices describe the club-facing roles and do not advertise the maintenance override.
  it('describes access for notices without naming the Developer role', () => {
    expect(describePublicAccess(['developer', 'treasurer'])).toBe('Treasurer')
    expect(describePublicAccess(['developer', 'president', 'vicepresident'])).toBe('President and Vice President')
    expect(describePublicAccess(['developer'])).toBe('Maintenance access')
    expect(describePublicAccess([])).toBe('Member (no privileged role)')
  })
})
