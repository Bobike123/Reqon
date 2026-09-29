import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Task mutations at the data layer, in isolation from any rendered screen —
// supabase/tests/task_authorization_test.sql already proves the RLS-shaped
// matrix (owner/Head/Developer) against a real database; this file proves
// each hook's own zero-row-vs-permission classification and error
// passthrough (ADR-0003), the same pattern useSubteams.test.tsx already
// established for departments in Phase 1.

let updateResult: { data: unknown; error: { message: string; code?: string } | null }
let rpcResults: Record<string, { data: unknown; error: { message: string; code?: string } | null }>
let lastRpc: { fn: string; args: unknown } | null
let lastUpdatePayload: Record<string, unknown> | undefined

const supabase = {
  from: (_table: string) => ({
    update: (payload: Record<string, unknown>) => {
      lastUpdatePayload = payload
      return {
        eq: (_col: string, _val: string) => ({
          select: (_cols: string) => Promise.resolve(updateResult),
        }),
      }
    },
  }),
  rpc: (fn: string, args: unknown) => {
    lastRpc = { fn, args }
    return Promise.resolve(rpcResults[fn] ?? { data: null, error: { message: `unmocked rpc ${fn}` } })
  },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => 'season-a' }))

const { useUpdateTask, useArchiveTask, useRestoreTask, useLinkTaskRequirement, useUnlinkTaskRequirement } =
  await import('./useTasks.ts')

function hook<T>(useHook: () => T) {
  const queryClient = new QueryClient()
  return renderHook(useHook, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  }).result
}

beforeEach(() => {
  updateResult = { data: [{ id: 't1' }], error: null }
  rpcResults = {}
  lastRpc = null
})

describe('useUpdateTask', () => {
  it('succeeds when the update matches a row', async () => {
    const update = hook(() => useUpdateTask())
    await update.current.mutateAsync({ id: 't1', title: 'New title' })
    await waitFor(() => expect(update.current.isSuccess).toBe(true))
  })

  it('reports "no longer exists" when zero rows match but the caller could edit it', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_edit_task = { data: true, error: null }
    const update = hook(() => useUpdateTask())
    await expect(update.current.mutateAsync({ id: 'ghost', title: 'x' })).rejects.toThrow(/no longer exists/)
  })

  it('reports a permission refusal when zero rows match and the caller could not edit it', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_edit_task = { data: false, error: null }
    const update = hook(() => useUpdateTask())
    await expect(update.current.mutateAsync({ id: 't1', title: 'x' })).rejects.toThrow(/permission|update task/)
  })

  it('asks can_edit_task with the SAME id it tried to edit — not a global check', async () => {
    updateResult = { data: [], error: null }
    rpcResults.can_edit_task = { data: false, error: null }
    const update = hook(() => useUpdateTask())
    await update.current.mutateAsync({ id: 't42', state: 'wip' }).catch(() => {})
    expect(lastRpc).toEqual({ fn: 'can_edit_task', args: { p_task_id: 't42' } })
  })

  it('surfaces a raised error (a protected-column attack, an invariant refusal) directly, not as a zero-row match', async () => {
    updateResult = {
      data: null,
      error: { message: "That field cannot be changed through an ordinary task edit.", code: '42501' },
    }
    const update = hook(() => useUpdateTask())
    await expect(update.current.mutateAsync({ id: 't1', ownerId: 'someone' })).rejects.toThrow(/ordinary task edit/)
  })

  it('sends only the fields that were actually set', async () => {
    const update = hook(() => useUpdateTask())
    await update.current.mutateAsync({ id: 't1', state: 'wip' })
    expect(lastUpdatePayload).toEqual({ state: 'wip' })
  })
})

describe('useArchiveTask', () => {
  it('archives via the RPC and returns the server row', async () => {
    rpcResults.archive_task = {
      data: { id: 't1', archived_at: '2026-09-23T00:00:00Z', archive_reason: 'manual' },
      error: null,
    }
    const archive = hook(() => useArchiveTask())
    const result = await archive.current.mutateAsync({ id: 't1' })
    expect(result).toMatchObject({ archive_reason: 'manual' })
    expect(lastRpc).toEqual({ fn: 'archive_task', args: { p_task_id: 't1', p_reason: 'manual' } })
  })

  it('surfaces a raised error (Head-only, already archived) directly', async () => {
    rpcResults.archive_task = {
      data: null,
      error: { message: "Only the Head of this task's department, or a Developer, may archive it", code: '42501' },
    }
    const archive = hook(() => useArchiveTask())
    await expect(archive.current.mutateAsync({ id: 't1' })).rejects.toThrow(/Head of this task/)
  })
})

describe('useRestoreTask', () => {
  it('restores via the RPC and returns the server row', async () => {
    rpcResults.restore_task = { data: { id: 't1', archived_at: null, state: 'todo' }, error: null }
    const restore = hook(() => useRestoreTask())
    const result = await restore.current.mutateAsync({ id: 't1' })
    expect(result).toMatchObject({ archived_at: null, state: 'todo' })
    expect(lastRpc).toEqual({ fn: 'restore_task', args: { p_task_id: 't1' } })
  })

  it('surfaces a raised error (not archived) directly', async () => {
    rpcResults.restore_task = { data: null, error: { message: 'This task is not archived', code: '22023' } }
    const restore = hook(() => useRestoreTask())
    await expect(restore.current.mutateAsync({ id: 't1' })).rejects.toThrow(/not archived/)
  })
})

describe('requirement links', () => {
  it('link_task_requirement reports whether anything changed', async () => {
    rpcResults.link_task_requirement = { data: true, error: null }
    const link = hook(() => useLinkTaskRequirement())
    await expect(link.current.mutateAsync({ taskId: 't1', clauseKey: 'A.1.1.1' })).resolves.toBe(true)
    expect(lastRpc).toEqual({ fn: 'link_task_requirement', args: { p_task_id: 't1', p_clause_key: 'A.1.1.1' } })
  })

  it('unlink surfaces the last-requirement refusal for work created from a proposal', async () => {
    rpcResults.unlink_task_requirement = {
      data: null,
      error: { message: 'A task created from a proposal must keep at least one requirement.', code: '23514' },
    }
    const unlink = hook(() => useUnlinkTaskRequirement())
    await expect(unlink.current.mutateAsync({ taskId: 't1', clauseKey: 'A.1.1.1' })).rejects.toThrow(/at least one requirement/)
  })

  it('a milestone edit is sent as milestone_key, alongside the section it must match', async () => {
    const update = hook(() => useUpdateTask())
    await update.current.mutateAsync({ id: 't1', milestoneKey: 'MS1-2', sectionId: null })
    expect(lastUpdatePayload).toEqual({ milestone_key: 'MS1-2', section_id: null })
  })
})
