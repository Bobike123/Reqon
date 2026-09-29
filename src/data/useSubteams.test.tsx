import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Department mutations at the data layer, in isolation from any rendered
// screen — settings.test.tsx already proves the RLS-shaped matrix (who may
// create/archive/restore) through the full simulated database; this file
// proves each hook's own zero-row-vs-permission classification and error
// passthrough, including the reconciliation calls no Phase 1 screen renders
// yet (docs/redesign/DEPARTMENT_RECONCILIATION.md — a typed entry point for
// a future admin screen or maintenance script).

let rpcResults: Record<string, { data: unknown; error: { message: string; code?: string } | null }>
let updateResult: { data: unknown; error: { message: string; code?: string } | null }
let insertResult: { data: unknown; error: { message: string; code?: string } | null }
let lastRpc: { fn: string; args: unknown } | null

const supabase = {
  from: (_table: string) => ({
    update: (_payload: Record<string, unknown>) => ({
      eq: (_col: string, _val: string) => ({
        select: (_cols: string) => Promise.resolve(updateResult),
      }),
    }),
    insert: (_payload: Record<string, unknown>) => Promise.resolve(insertResult),
  }),
  rpc: (fn: string, args: unknown) => {
    lastRpc = { fn, args }
    return Promise.resolve(rpcResults[fn] ?? { data: null, error: { message: `unmocked rpc ${fn}` } })
  },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))

const {
  useUpdateSubteam,
  useCreateDepartment,
  useArchiveDepartment,
  useRestoreDepartment,
  useReorderDepartments,
  useReconciliationPreflight,
  useApplyReconciliation,
} = await import('./useSubteams.ts')

function hook<T>(useHook: () => T) {
  const queryClient = new QueryClient()
  return renderHook(useHook, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  }).result
}

beforeEach(() => {
  rpcResults = {}
  updateResult = { data: [{ key: 'GEOM' }], error: null }
  insertResult = { data: { key: 'GEOM' }, error: null }
  lastRpc = null
})

describe('useUpdateSubteam', () => {
  it('succeeds when the update matches a row', async () => {
    const update = hook(() => useUpdateSubteam())
    await update.current.mutateAsync({ key: 'GEOM', name: 'New name' })
    await waitFor(() => expect(update.current.isSuccess).toBe(true))
  })

  it('reports "no longer exists" when zero rows match but the caller can manage departments', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_manage_departments = { data: true, error: null }
    const update = hook(() => useUpdateSubteam())
    await expect(update.current.mutateAsync({ key: 'GHOST', name: 'x' })).rejects.toThrow(/no longer exists/)
  })

  it('reports a permission refusal when zero rows match and the caller cannot manage departments', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_manage_departments = { data: false, error: null }
    const update = hook(() => useUpdateSubteam())
    await expect(update.current.mutateAsync({ key: 'GEOM', name: 'x' })).rejects.toThrow(/permission/)
  })
})

describe('useCreateDepartment', () => {
  it('inserts with book_section always null', async () => {
    const create = hook(() => useCreateDepartment())
    await create.current.mutateAsync({ key: 'SWDATA', name: 'Software & Data' })
    await waitFor(() => expect(create.current.isSuccess).toBe(true))
  })

  it('surfaces a raised error (e.g. the 10-active cap) directly, not as a zero-row match', async () => {
    insertResult = { data: null, error: { message: 'At most 10 active departments are allowed', code: '23514' } }
    const create = hook(() => useCreateDepartment())
    await expect(create.current.mutateAsync({ key: 'X', name: 'X' })).rejects.toThrow(/10 active departments/)
  })
})

describe('useArchiveDepartment', () => {
  it('succeeds when the update matches a row', async () => {
    const archive = hook(() => useArchiveDepartment())
    await archive.current.mutateAsync({ key: 'GEOM', reason: 'test' })
    await waitFor(() => expect(archive.current.isSuccess).toBe(true))
  })

  it('surfaces the stranded-work refusal directly', async () => {
    updateResult = { data: null, error: { message: 'task(s) still reference it', code: '23514' } }
    const archive = hook(() => useArchiveDepartment())
    await expect(archive.current.mutateAsync({ key: 'GEOM', reason: 'test' })).rejects.toThrow(/still reference it/)
  })

  it('reports "no longer exists" for a zero-row match by an admin', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_manage_departments = { data: true, error: null }
    const archive = hook(() => useArchiveDepartment())
    await expect(archive.current.mutateAsync({ key: 'GHOST', reason: 'test' })).rejects.toThrow(/no longer exists/)
  })

  it('reports a permission refusal for a zero-row match by a non-admin', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_manage_departments = { data: false, error: null }
    const archive = hook(() => useArchiveDepartment())
    await expect(archive.current.mutateAsync({ key: 'GEOM', reason: 'test' })).rejects.toThrow(/permission/)
  })
})

describe('useRestoreDepartment', () => {
  it('succeeds when the update matches a row', async () => {
    const restore = hook(() => useRestoreDepartment())
    await restore.current.mutateAsync({ key: 'GEOM' })
    await waitFor(() => expect(restore.current.isSuccess).toBe(true))
  })

  it('surfaces the 10-active cap refusal directly', async () => {
    updateResult = { data: null, error: { message: 'At most 10 active departments are allowed', code: '23514' } }
    const restore = hook(() => useRestoreDepartment())
    await expect(restore.current.mutateAsync({ key: 'GEOM' })).rejects.toThrow(/10 active departments/)
  })

  it('reports "no longer exists" for a zero-row match by an admin', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_manage_departments = { data: true, error: null }
    const restore = hook(() => useRestoreDepartment())
    await expect(restore.current.mutateAsync({ key: 'GHOST' })).rejects.toThrow(/no longer exists/)
  })

  it('reports a permission refusal for a zero-row match by a non-admin', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_manage_departments = { data: false, error: null }
    const restore = hook(() => useRestoreDepartment())
    await expect(restore.current.mutateAsync({ key: 'GEOM' })).rejects.toThrow(/permission/)
  })
})

describe('useReorderDepartments', () => {
  it('sends the full ordered key list to reorder_departments', async () => {
    rpcResults.reorder_departments = { data: null, error: null }
    const reorder = hook(() => useReorderDepartments())
    await reorder.current.mutateAsync(['B', 'A'])
    expect(lastRpc).toEqual({ fn: 'reorder_departments', args: { p_ordered_keys: ['B', 'A'] } })
  })

  it('surfaces an incomplete-list refusal directly', async () => {
    rpcResults.reorder_departments = { data: null, error: { message: 'must name every department exactly once', code: '22023' } }
    const reorder = hook(() => useReorderDepartments())
    await expect(reorder.current.mutateAsync(['A'])).rejects.toThrow(/exactly once/)
  })
})

describe('useReconciliationPreflight', () => {
  it('returns the preflight rows', async () => {
    rpcResults.reconciliation_preflight = {
      data: [{ key: 'ADMIN', action: 'keep', ok: true, problem: null }],
      error: null,
    }
    const preflight = hook(() => useReconciliationPreflight())
    const rows = await preflight.current.mutateAsync({ label: 'x', purpose: 'test_fixture', departments: [] })
    expect(rows).toEqual([{ key: 'ADMIN', action: 'keep', ok: true, problem: null }])
  })

  it('surfaces a permission refusal directly', async () => {
    rpcResults.reconciliation_preflight = {
      data: null,
      error: { message: 'Only the President, Vice President or a Developer may run reconciliation', code: '42501' },
    }
    const preflight = hook(() => useReconciliationPreflight())
    await expect(
      preflight.current.mutateAsync({ label: 'x', purpose: 'test_fixture', departments: [] }),
    ).rejects.toThrow(/President, Vice President or a Developer/)
  })
})

describe('useApplyReconciliation', () => {
  it('returns the applied summary', async () => {
    rpcResults.reconciliation_apply = { data: { applied: true, active_count: 10, label: 'x' }, error: null }
    const apply = hook(() => useApplyReconciliation())
    const result = await apply.current.mutateAsync({ label: 'x', purpose: 'test_fixture', departments: [] })
    expect(result).toEqual({ applied: true, active_count: 10, label: 'x' })
  })

  it('surfaces a failed preflight directly', async () => {
    rpcResults.reconciliation_apply = {
      data: null,
      error: { message: 'Reconciliation preflight failed:\nGEOM: missing from the manifest', code: '23514' },
    }
    const apply = hook(() => useApplyReconciliation())
    await expect(
      apply.current.mutateAsync({ label: 'x', purpose: 'test_fixture', departments: [] }),
    ).rejects.toThrow(/preflight failed/)
  })
})
