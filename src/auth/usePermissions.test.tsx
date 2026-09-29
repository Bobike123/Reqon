import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

let auth: unknown
vi.mock('./context.ts', () => ({ useAuth: () => auth }))
const { usePermissions } = await import('./usePermissions.ts')

const member = (status: 'active' | 'alumni', roles: string[]) => ({
  status: 'member',
  user: { id: 'm1' },
  member: { id: 'm1', status },
  roles,
})

describe('usePermissions', () => {
  it('gives an active President the governance powers', () => {
    auth = member('active', ['president'])
    const { result } = renderHook(() => usePermissions())
    expect(result.current.canAdminister).toBe(true)
    expect(result.current.canManageDepartments).toBe(true)
  })

  it('gives a retired member nothing, even if they still hold a role (has_role() ignores it)', () => {
    auth = member('alumni', ['president', 'developer'])
    const { result } = renderHook(() => usePermissions())
    expect(result.current.canAdminister).toBe(false)
    expect(result.current.canManageDepartments).toBe(false)
    expect(result.current.canViewFinances).toBe(false)
    expect(result.current.canSuggestProposal).toBe(false)
  })

  it('gives someone signed out nothing', () => {
    auth = { status: 'signedOut' }
    const { result } = renderHook(() => usePermissions())
    expect(result.current.canAdminister).toBe(false)
  })
})
