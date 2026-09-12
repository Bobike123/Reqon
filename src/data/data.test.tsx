import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Fake Supabase ---------------------------------------------------------
// A chainable stand-in that records every call, so the tests can assert on the
// exact columns written (attribution) and the exact filters applied (season).

type Call = {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert'
  payload?: Record<string, unknown>
  filters: Record<string, unknown>
  range?: [number, number]
}

const calls: Call[] = []
let currentSeasonRow: Record<string, unknown> | null = null
let failNextWrite = false
let failReads = false
const tableRows = new Map<string, Record<string, unknown>[]>()

function resultFor(ctx: Call) {
  if (ctx.op !== 'select') {
    if (failNextWrite) return { data: null, error: { message: 'write rejected', code: '42501' } }
    // Persist the write so a refetch observes it, the way a real server would.
    const rows = tableRows.get(ctx.table) ?? []
    const payload = ctx.payload ?? {}
    if (ctx.op === 'upsert') {
      const i = rows.findIndex(
        (r) => r.season_id === payload.season_id && r.clause_key === payload.clause_key,
      )
      if (i === -1) rows.push({ id: 'new-id', ...payload })
      else rows[i] = { ...rows[i], ...payload }
    } else if (ctx.op === 'insert') {
      rows.push({ id: 'new-id', ...payload })
    } else if (ctx.op === 'update') {
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].id === ctx.filters.id) rows[i] = { ...rows[i], ...payload }
      }
    }
    tableRows.set(ctx.table, rows)
    return { data: { id: 'new-id', ...payload }, error: null }
  }
  if (ctx.table === 'v_current_season') return { data: currentSeasonRow, error: null }
  if (failReads) return { data: null, error: { message: 'refetch unavailable', code: '08006' } }

  let rows = tableRows.get(ctx.table) ?? []
  for (const [col, val] of Object.entries(ctx.filters)) {
    rows = rows.filter((r) => r[col] === val)
  }
  if (ctx.range) {
    const [from, to] = ctx.range
    return { data: rows.slice(from, to + 1), error: null }
  }
  return { data: rows, error: null }
}

function makeBuilder(table: string) {
  const ctx: Call = { table, op: 'select', filters: {} }
  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    in: () => builder,
    limit: () => builder,
    eq: (col: string, val: unknown) => {
      ctx.filters[col] = val
      return builder
    },
    range: (from: number, to: number) => {
      ctx.range = [from, to]
      return builder
    },
    insert: (p: Record<string, unknown>) => {
      ctx.op = 'insert'
      ctx.payload = p
      return builder
    },
    update: (p: Record<string, unknown>) => {
      ctx.op = 'update'
      ctx.payload = p
      return builder
    },
    upsert: (p: Record<string, unknown>) => {
      ctx.op = 'upsert'
      ctx.payload = p
      return builder
    },
    single: () => builder,
    maybeSingle: () => builder,
    then: (resolve: (v: unknown) => void) => {
      calls.push({ ...ctx, filters: { ...ctx.filters } })
      resolve(resultFor(ctx))
      return Promise.resolve()
    },
  }
  return builder
}

const supabase = { from: (table: string) => makeBuilder(table) }
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))

// Signed in as a real rostered member, which is what attribution depends on.
const MEMBER = { id: 'member-42', full_name: 'Ada Rider' }
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: MEMBER.id }, member: MEMBER, roles: [] }),
}))

const { queryKeys } = await import('./queryKeys.ts')
const { useCurrentSeason } = await import('./useCurrentSeason.ts')
const { useClauses } = await import('./useClauses.ts')
const { useClauseStatus, useSetClauseStatus } = await import('./useClauseStatus.ts')
const { useTasks } = await import('./useTasks.ts')
const { useSuggestProposal } = await import('./useProposals.ts')
const { useMembers } = await import('./useMembers.ts')

const SEASON_A = { id: 'season-a', label: '2026/27', is_current: true }
const SEASON_B = { id: 'season-b', label: '2027/28', is_current: true }

let queryClient: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  calls.length = 0
  currentSeasonRow = SEASON_A
  failNextWrite = false
  failReads = false
  tableRows.clear()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

// --- Query keys ------------------------------------------------------------

describe('query keys', () => {
  it('puts the season id high in the key so a whole season can be invalidated', () => {
    expect(queryKeys.seasonScoped('season-a', 'tasks')).toEqual(['season', 'season-a', 'tasks'])
    expect(queryKeys.season('season-a')).toEqual(['season', 'season-a'])
  })

  it('keeps global reference data out of the season namespace', () => {
    expect(queryKeys.clauses).toEqual(['clauses'])
    expect(queryKeys.members).toEqual(['members'])
  })
})

// --- Season scoping --------------------------------------------------------

describe('season scoping', () => {
  it('resolves the current season from v_current_season', async () => {
    const { result } = renderHook(() => useCurrentSeason(), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual(SEASON_A))
  })

  it('filters season-scoped reads by the resolved season id', async () => {
    tableRows.set('tasks', [
      { id: 't1', season_id: 'season-a', title: 'A task' },
      { id: 't2', season_id: 'season-b', title: 'B task' },
    ])
    const { result } = renderHook(() => useTasks(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data).toHaveLength(1)
    expect(result.current.data?.[0].id).toBe('t1')
    const taskRead = calls.find((c) => c.table === 'tasks' && c.op === 'select')
    expect(taskRead?.filters.season_id).toBe('season-a')
  })

  it('does NOT leak the previous season\'s rows when the season changes', async () => {
    tableRows.set('tasks', [
      { id: 't1', season_id: 'season-a', title: 'A task' },
      { id: 't2', season_id: 'season-b', title: 'B task' },
    ])
    const { result } = renderHook(() => useTasks(), { wrapper })
    await waitFor(() => expect(result.current.data?.[0].id).toBe('t1'))

    // The board switches season.
    currentSeasonRow = SEASON_B
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentSeason })
    })

    await waitFor(() => expect(result.current.data?.[0]?.id).toBe('t2'))
    expect(result.current.data).toHaveLength(1)
    // Season A's cache entry still exists separately — it was never overwritten.
    expect(queryClient.getQueryData(queryKeys.seasonScoped('season-a', 'tasks'))).toHaveLength(1)
  })

  it('waits for the season before firing season-scoped reads', async () => {
    currentSeasonRow = null
    const { result } = renderHook(() => useTasks(), { wrapper })
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(calls.some((c) => c.table === 'tasks')).toBe(false)
  })

  it('does not put a season filter on global reference data', async () => {
    tableRows.set('members', [{ id: 'm1', full_name: 'Ada' }])
    const { result } = renderHook(() => useMembers(), { wrapper })
    await waitFor(() => expect(result.current.data).toHaveLength(1))
    const read = calls.find((c) => c.table === 'members')
    expect(read?.filters.season_id).toBeUndefined()
  })
})

// --- Pagination ------------------------------------------------------------

describe('clause loading', () => {
  it('pages past the server row cap so all 1,146 clauses arrive', async () => {
    tableRows.set(
      'clauses',
      Array.from({ length: 1146 }, (_, i) => ({ clause_key: `C.${i}`, body: 'x' })),
    )
    const { result } = renderHook(() => useClauses(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 5000 })
    // A single un-paged select would have stopped at 1000.
    expect(result.current.data).toHaveLength(1146)
    expect(calls.filter((c) => c.table === 'clauses').length).toBeGreaterThan(1)
  })
})

// --- Mutations -------------------------------------------------------------

describe('attribution', () => {
  it('stamps clause_status.updated_by with the signed-in member', async () => {
    tableRows.set('clause_status', [])
    const season = renderHook(() => useCurrentSeason(), { wrapper })
    await waitFor(() => expect(season.result.current.data).toBeTruthy())
    const { result } = renderHook(() => useSetClauseStatus(), { wrapper })
    await waitFor(() => expect(result.current).toBeTruthy())
    await act(async () => {
      await result.current.mutateAsync({ clauseKey: 'B.1.1.1', state: 'compliant' })
    })
    const write = calls.find((c) => c.table === 'clause_status' && c.op === 'upsert')
    expect(write?.payload?.updated_by).toBe(MEMBER.id)
    expect(write?.payload?.season_id).toBe('season-a')
    expect(write?.payload?.state).toBe('compliant')
  })

  it('stamps proposals.raised_by', async () => {
    const season = renderHook(() => useCurrentSeason(), { wrapper })
    await waitFor(() => expect(season.result.current.data).toBeTruthy())
    const { result } = renderHook(() => useSuggestProposal(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ title: 'Fairing width' })
    })
    const write = calls.find((c) => c.table === 'task_proposals' && c.op === 'insert')
    expect(write?.payload?.raised_by).toBe(MEMBER.id)
  })
})

describe('optimistic writes', () => {
  const EXISTING = [
    { id: 'cs1', season_id: 'season-a', clause_key: 'B.1.1.1', state: 'open', starred: false },
  ]

  it('applies the change immediately and keeps it when the write succeeds', async () => {
    tableRows.set('clause_status', [...EXISTING])
    const status = renderHook(() => useClauseStatus(), { wrapper })
    await waitFor(() => expect(status.result.current.data).toHaveLength(1))

    const { result } = renderHook(() => useSetClauseStatus(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ clauseKey: 'B.1.1.1', state: 'compliant' })
    })
    const key = queryKeys.seasonScoped('season-a', 'clause_status')
    const rows = queryClient.getQueryData<typeof EXISTING>(key)
    expect(rows?.[0].state).toBe('compliant')
  })

  it('rolls the cache back to the exact previous state when the write fails', async () => {
    tableRows.set('clause_status', [...EXISTING])
    const status = renderHook(() => useClauseStatus(), { wrapper })
    await waitFor(() => expect(status.result.current.data).toHaveLength(1))

    const key = queryKeys.seasonScoped('season-a', 'clause_status')
    const before = queryClient.getQueryData(key)

    // Both the write AND the follow-up refetch fail. That isolates the
    // rollback: if onError did not restore the snapshot, the optimistic
    // 'verified' would still be sitting in the cache, because the refetch
    // that would otherwise have corrected it never lands.
    failNextWrite = true
    failReads = true
    const { result } = renderHook(() => useSetClauseStatus(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ clauseKey: 'B.1.1.1', state: 'verified' }).catch(() => {})
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    const after = queryClient.getQueryData<typeof EXISTING>(key)
    expect(after?.[0].state).toBe('open')
    expect(after).toEqual(before)
  })

  it('surfaces the failure instead of failing silently', async () => {
    tableRows.set('clause_status', [...EXISTING])
    failNextWrite = true
    const { result } = renderHook(() => useSetClauseStatus(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ clauseKey: 'B.1.1.1', state: 'verified' }).catch(() => {})
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toContain('save clause status')
  })
})

describe('read errors', () => {
  it('become hook errors, not blank state', async () => {
    tableRows.set('members', [])
    const failing = { from: () => ({
      select: () => failing.from(),
      order: () => failing.from(),
      then: (resolve: (v: unknown) => void) => {
        resolve({ data: null, error: { message: 'connection lost', code: '08006' } })
        return Promise.resolve()
      },
    }) }
    const original = supabase.from
    supabase.from = failing.from as typeof supabase.from
    try {
      const { result } = renderHook(() => useMembers(), { wrapper })
      await waitFor(() => expect(result.current.isError).toBe(true))
      expect(result.current.error?.message).toContain('load members')
      expect(result.current.error?.message).toContain('connection lost')
    } finally {
      supabase.from = original
    }
  })
})
