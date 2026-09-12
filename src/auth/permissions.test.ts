import { describe, expect, it } from 'vitest'
import { NO_PERMISSIONS, ROLE_LABELS, describeRoles, permissionsFor, type PrivilegedRole } from './permissions.ts'

// The same matrix supabase/tests/roles_rls_test.sql proves against the
// database. This file only checks that the UI's mirror agrees with it.
const MATRIX: Record<PrivilegedRole | 'member', {
  canAdminister: boolean; canManageRoles: boolean; canViewFinances: boolean; canManageFinances: boolean
}> = {
  developer:     { canAdminister: true,  canManageRoles: true,  canViewFinances: true,  canManageFinances: true  },
  treasurer:     { canAdminister: false, canManageRoles: false, canViewFinances: true,  canManageFinances: true  },
  president:     { canAdminister: true,  canManageRoles: true,  canViewFinances: true,  canManageFinances: false },
  vicepresident: { canAdminister: true,  canManageRoles: false, canViewFinances: true,  canManageFinances: false },
  member:        { canAdminister: false, canManageRoles: false, canViewFinances: false, canManageFinances: false },
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
    expect([p.canAdminister, p.canManageRoles, p.canViewFinances, p.canManageFinances]).toEqual([
      true, true, true, true,
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
