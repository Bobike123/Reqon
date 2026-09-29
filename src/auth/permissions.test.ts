import { describe, expect, it } from 'vitest'
import {
  NO_PERMISSIONS,
  ROLE_LABELS,
  canArchiveTask,
  canEditTask,
  canReassignTaskOwner,
  canReviewProposal,
  canSubmitProposal,
  describeRoles,
  permissionsFor,
  type PrivilegedRole,
  type TaskActor,
} from './permissions.ts'

// The same matrix supabase/tests/roles_rls_test.sql proves against the
// database. This file only checks that the UI's mirror agrees with it.
const MATRIX: Record<PrivilegedRole | 'member', {
  canAdminister: boolean; canManageRoles: boolean; canViewFinances: boolean; canManageFinances: boolean; canEditSpecTargets: boolean
}> = {
  developer:     { canAdminister: true,  canManageRoles: true,  canViewFinances: true,  canManageFinances: true,  canEditSpecTargets: true  },
  treasurer:     { canAdminister: false, canManageRoles: false, canViewFinances: true,  canManageFinances: true,  canEditSpecTargets: false },
  president:     { canAdminister: true,  canManageRoles: true,  canViewFinances: true,  canManageFinances: false, canEditSpecTargets: true  },
  vicepresident: { canAdminister: true,  canManageRoles: false, canViewFinances: true,  canManageFinances: false, canEditSpecTargets: true  },
  member:        { canAdminister: false, canManageRoles: false, canViewFinances: false, canManageFinances: false, canEditSpecTargets: false },
}

describe('the permission matrix', () => {
  for (const [who, expected] of Object.entries(MATRIX)) {
    it(`${who}`, () => {
      const p = permissionsFor(who === 'member' ? [] : [who as PrivilegedRole])
      expect({
        canAdminister: p.canAdminister,
        canManageRoles: p.canManageRoles,
        canViewFinances: p.canViewFinances,
        canManageFinances: p.canManageFinances,
        canEditSpecTargets: p.canEditSpecTargets,
      }).toEqual(expected)
    })
  }

  it('the president and the developer manage roles', () => {
    const managers = (['developer', 'treasurer', 'president', 'vicepresident'] as PrivilegedRole[])
      .filter((r) => permissionsFor([r]).canManageRoles)
    expect(managers).toEqual(['developer', 'president'])
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

  it('a task with no department can only be edited by its owner or the Developer', () => {
    const noDept = { ...task, subteam_key: null }
    expect(canEditTask(owner, noDept)).toBe(true)
    expect(canEditTask(developer, noDept)).toBe(true)
    expect(canEditTask(head, noDept)).toBe(false)
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

  it('the President or Vice President alone have no proposal power — a role is not a headship', () => {
    const president = permissionsFor(['president'])
    expect(president.canAdminister).toBe(true)
    expect(canReviewProposal(member, inGeom)).toBe(false)
  })

  it('a Developer may review any proposal', () => {
    expect(canReviewProposal(developer, inGeom)).toBe(true)
    expect(canReviewProposal(developer, { subteam_key: null })).toBe(true)
  })

  it('an older proposal with no department is a Developer matter only', () => {
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
    expect(describeRoles(['developer', 'treasurer'])).toBe('Treasurer and Developer')
    expect(describeRoles(['developer', 'president', 'vicepresident'])).toBe('President, Vice President and Developer')
  })
})
