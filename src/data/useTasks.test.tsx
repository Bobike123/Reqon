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
let lastUpdateFilters: [string, string][]
let currentRow: { data: { id: string; updated_at: string; archived_at: string | null } | null; error: { message: string } | null }

const supabase = {
  from: (_table: string) => ({
    update: (payload: Record<string, unknown>) => {
      lastUpdatePayload = payload
      lastUpdateFilters = []
      const chain = {
        eq: (col: string, val: string) => {
          lastUpdateFilters.push([col, val])
          return chain
        },
        select: (_cols: string) => Promise.resolve(updateResult),
      }
      return chain
    },
    // The follow-up read after a zero-row write: what is the row now?
    select: (_cols: string) => ({
      eq: (_col: string, _val: string) => ({ maybeSingle: () => Promise.resolve(currentRow) }),
    }),
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

function hookWithClient<T>(useHook: () => T, seed?: unknown[]) {
  const queryClient = new QueryClient()
  if (seed) queryClient.setQueryData(['season', 'season-a', 'tasks'], seed)
  const result = renderHook(useHook, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  }).result
  return { result, queryClient }
}

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
  lastUpdateFilters = []
  currentRow = { data: { id: 't1', updated_at: '2026-09-01T00:00:00+00:00', archived_at: null }, error: null }
})

describe('useUpdateTask', () => {
  it('succeeds when the update matches a row', async () => {
    const update = hook(() => useUpdateTask())
    await update.current.mutateAsync({ id: 't1', title: 'New title' })
    await waitFor(() => expect(update.current.isSuccess).toBe(true))
  })

  it('reports "no longer exists" when zero rows match because the row is gone', async () => {
    updateResult = { data: [], error: null }
    currentRow = { data: null, error: null }
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

// Versioned writes (F-12): an edit carries the updated_at the person saw, and a
// mismatch is "changed elsewhere", never a permission error and never a silent
// overwrite.
describe('useUpdateTask is a versioned write', () => {
  const CACHED = [{ id: 't1', title: 'Old', updated_at: '2026-09-01T00:00:00+00:00', state: 'todo', blocked_reason: null, blocked_since: null }]

  it('sends the version of the row it holds as an extra filter', async () => {
    const { result } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: [{ id: 't1', updated_at: '2026-09-02T00:00:00+00:00', title: 'New' }], error: null }
    await result.current.mutateAsync({ id: 't1', title: 'New' })
    expect(lastUpdateFilters).toEqual([['id', 't1'], ['updated_at', '2026-09-01T00:00:00+00:00']])
  })

  it('merges the row the server returns, so a second edit carries the new version', async () => {
    const { result, queryClient } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: [{ id: 't1', updated_at: '2026-09-02T00:00:00+00:00', title: 'New' }], error: null }
    await result.current.mutateAsync({ id: 't1', title: 'New' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    updateResult = { data: [{ id: 't1', updated_at: '2026-09-03T00:00:00+00:00', title: 'Newer' }], error: null }
    await result.current.mutateAsync({ id: 't1', title: 'Newer' })
    expect(lastUpdateFilters[1]).toEqual(['updated_at', '2026-09-02T00:00:00+00:00'])
    expect(queryClient.getQueryData<{ updated_at: string }[]>(['season', 'season-a', 'tasks'])?.[0]?.updated_at).toBe('2026-09-03T00:00:00+00:00')
  })

  it('reports "changed by someone else" — not a permission error — when the version no longer matches', async () => {
    const { result } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: [], error: null }
    currentRow = { data: { id: 't1', updated_at: '2026-09-05T00:00:00+00:00', archived_at: null }, error: null }
    const error = await result.current.mutateAsync({ id: 't1', title: 'Mine' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ conflict: true, permission: false })
    expect((error as Error).message).toMatch(/changed by someone else/)
    expect(lastRpc).toBeNull() // no permission lookup was needed to explain it
  })

  it('restores the optimistic value when the write is refused, and exposes the real error', async () => {
    const { result, queryClient } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: null, error: { message: 'Say why this task is blocked: write the reason, or link the task it is waiting for.', code: '23514' } }
    await expect(result.current.mutateAsync({ id: 't1', state: 'blocked' })).rejects.toThrow(/Say why this task is blocked/)
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(queryClient.getQueryData<{ state: string }[]>(['season', 'season-a', 'tasks'])?.[0]?.state).toBe('todo')
  })

  it('says an archived row was archived, not that it was changed', async () => {
    const { result } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: [], error: null }
    currentRow = { data: { id: 't1', updated_at: '2026-09-01T00:00:00+00:00', archived_at: '2026-09-04T00:00:00+00:00' }, error: null }
    await expect(result.current.mutateAsync({ id: 't1', title: 'x' })).rejects.toThrow(/has been archived/)
  })

  it('sends a blocker reason with the state, and only that state', async () => {
    const { result } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: [{ id: 't1', updated_at: '2026-09-02T00:00:00+00:00', state: 'blocked', blocked_reason: 'Sponsor quote' }], error: null }
    await result.current.mutateAsync({ id: 't1', state: 'blocked', blockedReason: 'Sponsor quote' })
    expect(lastUpdatePayload).toEqual({ state: 'blocked', blocked_reason: 'Sponsor quote' })
  })

  it('queues two edits of one task so the second carries the version the first produced', async () => {
    const { result } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: [{ id: 't1', updated_at: '2026-09-02T00:00:00+00:00' }], error: null }
    const first = result.current.mutateAsync({ id: 't1', title: 'A' })
    const second = result.current.mutateAsync({ id: 't1', priority: 'urgent' })
    await Promise.all([first, second])
    // Both writes ran and the second did not carry the (now stale) original version.
    expect(lastUpdateFilters[1]).toEqual(['updated_at', '2026-09-02T00:00:00+00:00'])
  })

  it('does not carry an older version back after a stale refetch put one in the cache', async () => {
    const { result, queryClient } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: [{ id: 't1', updated_at: '2026-09-02T00:00:00+00:00' }], error: null }
    await result.current.mutateAsync({ id: 't1', title: 'First' })
    // A refetch that began before that write lands afterwards with the OLD row.
    queryClient.setQueryData(['season', 'season-a', 'tasks'], CACHED)
    updateResult = { data: [{ id: 't1', updated_at: '2026-09-03T00:00:00+00:00' }], error: null }
    await result.current.mutateAsync({ id: 't1', title: 'Second' })
    expect(lastUpdateFilters[1]).toEqual(['updated_at', '2026-09-02T00:00:00+00:00'])
  })

  it('keeps a later edit\'s optimistic value when an earlier edit\'s answer arrives', async () => {
    const { result, queryClient } = hookWithClient(() => useUpdateTask(), CACHED)
    updateResult = { data: [{ id: 't1', updated_at: '2026-09-02T00:00:00+00:00', title: 'Server title', completed_at: null, completion_source: null, blocked_since: null }], error: null }
    queryClient.setQueryData(['season', 'season-a', 'tasks'], [{ ...CACHED[0], title: 'Pending optimistic title' }])
    await result.current.mutateAsync({ id: 't1', priority: 'urgent' })
    const row = queryClient.getQueryData<{ title: string; updated_at: string }[]>(['season', 'season-a', 'tasks'])?.[0]
    expect(row?.updated_at).toBe('2026-09-02T00:00:00+00:00')
    expect(row?.title).toBe('Pending optimistic title')
  })
})
