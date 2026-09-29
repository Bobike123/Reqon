import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 4 (20260118): only an ACTIVE member may write compliance, handover,
// section and specification rows, and a refused write matches no rows. These
// hooks must say which of "not permitted" and "no longer exists" it was, never
// report a save that did not happen.

type Result = { data: unknown; error: { message: string; code?: string } | null }
let updateResult: Result
let activeResult: Result

const supabase = {
  from: () => ({
    update: () => ({ eq: () => ({ select: () => Promise.resolve(updateResult) }) }),
  }),
  rpc: (fn: string) => Promise.resolve(fn === 'is_active_member' ? activeResult : { data: null, error: { message: `unmocked ${fn}` } }),
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => 'season-a' }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'me' }, member: { id: 'me', status: 'active' }, roles: [] }),
}))

const { useSetSectionDrafted } = await import('./useMilestones.ts')

function hook<T>(useHook: () => T) {
  const queryClient = new QueryClient()
  return renderHook(useHook, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  }).result
}

beforeEach(() => {
  updateResult = { data: [{ id: 'x' }], error: null }
  activeResult = { data: true, error: null }
})

describe.each([
  ['a milestone section tick', () => useSetSectionDrafted(), { id: 'sec', isDrafted: true }],
] as const)('%s', (_label, useIt, input) => {
  it('succeeds when a row was written', async () => {
    const h = hook(useIt as () => { mutateAsync: (v: never) => Promise<unknown> })
    await expect(h.current.mutateAsync(input as never)).resolves.not.toThrow()
  })

  it('reports "no longer exists" when nothing matched but the caller is an active member', async () => {
    updateResult = { data: [], error: null }
    const h = hook(useIt as () => { mutateAsync: (v: never) => Promise<unknown> })
    await expect(h.current.mutateAsync(input as never)).rejects.toThrow(/no longer exists/)
  })

  it('reports a permission refusal, never a save, when nothing matched and the caller is retired', async () => {
    updateResult = { data: [], error: null }
    activeResult = { data: false, error: null }
    const h = hook(useIt as () => { mutateAsync: (v: never) => Promise<unknown> })
    await expect(h.current.mutateAsync(input as never)).rejects.toThrow(/permission|save|update/)
  })
})
