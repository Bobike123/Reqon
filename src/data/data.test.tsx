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
  inFilters?: Record<string, unknown[]>
  range?: [number, number]
}

const calls: Call[] = []
let currentSeasonRow: Record<string, unknown> | null = null
let failNextWrite = false
let failReads = false
// Fails only writes whose payload matches — used to make ONE of two
// concurrent mutations fail while the other succeeds, so overlapping-mutation
// tests can control which side loses without a global "next write" flag.
let failWriteWhen: ((payload: Record<string, unknown>) => boolean) | null = null
const tableRows = new Map<string, Record<string, unknown>[]>()

function resultFor(ctx: Call) {
  if (ctx.op !== 'select') {
    if (failNextWrite || failWriteWhen?.(ctx.payload ?? {})) {
      return { data: null, error: { message: 'write rejected', code: '42501' } }
    }
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
  for (const [col, vals] of Object.entries(ctx.inFilters ?? {})) {
    rows = rows.filter((r) => vals.includes(r[col]))
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
    in: (col: string, vals: unknown[]) => {
      ctx.inFilters = { ...ctx.inFilters, [col]: vals }
      return builder
    },
    limit: () => builder,
    eq: (col: string, val: unknown) => {
      ctx.filters[col] = val
      return builder
    },
    // A no-op filter, not a real one: fixture rows here don't carry every
    // real column (e.g. tasks.archived_at), and this suite tests season
    // scoping, not archive filtering.
    is: () => builder,
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
      calls.push({ ...ctx, filters: { ...ctx.filters }, inFilters: ctx.inFilters && { ...ctx.inFilters } })
      const result = resultFor(ctx)
      // A write picked out by failWriteWhen resolves a beat later than an
      // ordinary one, so a concurrent mutation's own optimistic apply — and
      // this test's assertion of it — has a window to land first, the way a
      // slower request genuinely overlapping a faster one would.
      if (ctx.op !== 'select' && failWriteWhen?.(ctx.payload ?? {})) {
        setTimeout(() => resolve(result), 150)
        return Promise.resolve()
      }
      resolve(result)
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
const { useMembers } = await import('./useMembers.ts')
const { useMilestoneSections, useMilestonesForSeason } = await import('./useMilestones.ts')
const { useSpecsForSeason } = await import('./useSpecs.ts')
const { useBookProgress } = await import('./useNowMetrics.ts')
const { useSeasonId: useSeasonIdForTest } = await import('../season/context.ts')
const { SeasonProvider } = await import('../season/SeasonProvider.tsx')

const SEASON_A = { id: 'season-a', label: '2026/27', is_current: true }
const SEASON_B = { id: 'season-b', label: '2027/28', is_current: true }

let queryClient: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SeasonProvider>{children}</SeasonProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  calls.length = 0
  currentSeasonRow = SEASON_A
  failNextWrite = false
  failReads = false
  failWriteWhen = null
  tableRows.clear()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

// --- Query keys ------------------------------------------------------------

describe('query keys', () => {
  it('puts the season id high in the key so a whole season can be invalidated', () => {
    expect(queryKeys.tasks('season-a')).toEqual(['season', 'season-a', 'tasks'])
    expect(queryKeys.season('season-a')).toEqual(['season', 'season-a'])
  })

  it('falls back to a shared "unknown" bucket when the season is not resolved yet', () => {
    expect(queryKeys.tasks(undefined)).toEqual(['season', 'unknown', 'tasks'])
  })

  it('keeps global reference data out of the season namespace', () => {
    expect(queryKeys.clauses).toEqual(['clauses'])
    expect(queryKeys.members).toEqual(['members'])
  })
})

// Phase 4 (season integrity): a season switch must never show the other season's specification
// verdicts, milestones or Book progress, and each season's entry stays cached under its own key.
describe('season isolation of the Phase 4 reads', () => {
  it('every season-scoped key factory is prefixed by the season and differs per season', () => {
    const factories = Object.entries(queryKeys).filter(
      ([, value]) => typeof value === 'function' && (value as (...a: unknown[]) => unknown).length >= 1,
    ) as [string, (...a: string[]) => readonly unknown[]][]
    let checked = 0
    for (const [name, factory] of factories) {
      const a = factory('season-a', 'x')
      if (a[0] !== 'season') continue // global factories (clauses by edition, etc.)
      const b = factory('season-b', 'x')
      expect(a[1], name).toBe('season-a')
      expect(b[1], name).toBe('season-b')
      expect(JSON.stringify(a), name).not.toBe(JSON.stringify(b))
      checked += 1
    }
    expect(checked).toBeGreaterThanOrEqual(12)
  })

  it.each([
    ['spec_verdicts', queryKeys.specVerdicts],
    ['milestones', queryKeys.milestones],
    ['v_book_progress', queryKeys.bookProgress],
  ])('%s: switching A to B shows only B and keeps A cached apart', async (table, keyFor) => {
    tableRows.set(table, [
      { id: 'a-row', key: 'a-row', season_id: 'season-a', sort_order: 1 },
      { id: 'b-row', key: 'b-row', season_id: 'season-b', sort_order: 1 },
    ])
    type Rows = { data?: { season_id?: string | null }[] }
    const useSpecsHere = (): Rows => useSpecsForSeason(useSeasonIdForTest())
    const useMilestonesHere = (): Rows => useMilestonesForSeason(useSeasonIdForTest())
    const useBookHere = (): Rows => useBookProgress()
    const hookFor = { spec_verdicts: useSpecsHere, milestones: useMilestonesHere, v_book_progress: useBookHere }[table] as () => Rows
    const { result } = renderHook(hookFor, { wrapper })
    await waitFor(() => expect(result.current.data?.[0]?.season_id).toBe('season-a'))

    currentSeasonRow = SEASON_B
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentSeason })
    })
    await waitFor(() => expect(result.current.data?.[0]?.season_id).toBe('season-b'))
    expect(result.current.data?.every((r) => r.season_id === 'season-b')).toBe(true)
    expect(queryClient.getQueryData<{ season_id: string }[]>(keyFor('season-a'))?.every((r) => r.season_id === 'season-a')).toBe(true)
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
    expect(queryClient.getQueryData(queryKeys.tasks('season-a'))).toHaveLength(1)
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

// --- Milestone sections (keys from the caller) ----------------------------
// The sections query used to re-select milestones.key itself before reading
// milestone_sections — a second request for data every caller already held.
// It now takes the keys from the caller's own useMilestones().

describe('milestone sections', () => {
  const SECTIONS = [
    { id: 's1', milestone_key: 'MS1-1', name: 'Frame', ordinal: 1, is_drafted: false },
    { id: 's2', milestone_key: 'MS1-2', name: 'Brakes', ordinal: 1, is_drafted: true },
    { id: 's3', milestone_key: 'MS9-9', name: 'Somebody else’s', ordinal: 1, is_drafted: false },
  ]

  function useSectionsAfterSeason(keys: string[] | undefined) {
    return { season: useCurrentSeason(), sections: useMilestoneSections(keys) }
  }

  it('waits for the caller’s keys, then reads only those sections — and never re-reads milestones', async () => {
    tableRows.set('milestone_sections', [...SECTIONS])
    const { result, rerender } = renderHook(({ keys }) => useSectionsAfterSeason(keys), {
      wrapper,
      initialProps: { keys: undefined as string[] | undefined },
    })
    // The season is known, so the only thing holding the query back is the keys.
    await waitFor(() => expect(result.current.season.data).toBeTruthy())
    expect(result.current.sections.fetchStatus).toBe('idle')
    expect(calls.some((c) => c.table === 'milestone_sections')).toBe(false)

    rerender({ keys: ['MS1-1', 'MS1-2'] })
    await waitFor(() => expect(result.current.sections.data).toHaveLength(2))
    expect(result.current.sections.data?.map((s) => s.id)).toEqual(['s1', 's2'])

    const sectionReads = calls.filter((c) => c.table === 'milestone_sections')
    expect(sectionReads).toHaveLength(1)
    expect(sectionReads[0].inFilters?.milestone_key).toEqual(['MS1-1', 'MS1-2'])
    expect(calls.some((c) => c.table === 'milestones')).toBe(false)
  })

  it('a season with no milestones resolves to no sections, without a request', async () => {
    tableRows.set('milestone_sections', [...SECTIONS])
    const { result } = renderHook(() => useSectionsAfterSeason([]), { wrapper })
    await waitFor(() => expect(result.current.sections.data).toEqual([]))
    expect(calls.some((c) => c.table === 'milestone_sections')).toBe(false)
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
  // proposals.raised_by is no longer stamped by the client: submit_proposal()
  // takes the author from the session (supabase/tests/proposal_commands_test.sql).
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
    const key = queryKeys.clauseStatus('season-a')
    const rows = queryClient.getQueryData<typeof EXISTING>(key)
    expect(rows?.[0].state).toBe('compliant')
  })

  it('rolls the cache back to the exact previous state when the write fails', async () => {
    tableRows.set('clause_status', [...EXISTING])
    const status = renderHook(() => useClauseStatus(), { wrapper })
    await waitFor(() => expect(status.result.current.data).toHaveLength(1))

    const key = queryKeys.clauseStatus('season-a')
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

  // Phase 7 §7.4: the whole-list rollback this used to do would restore the
  // entire array from before EITHER mutation started, wiping out whatever the
  // still-in-flight (or already-succeeded) sibling mutation had applied. These
  // model two mutations overlapping in time and check that a failure only
  // undoes its own row/field, never a concurrent one's newer optimistic write.
  describe('overlapping mutations', () => {
    const TWO_ROWS = [
      { id: 'cs1', season_id: 'season-a', clause_key: 'B.1.1.1', state: 'open', starred: false },
      { id: 'cs2', season_id: 'season-a', clause_key: 'B.1.1.2', state: 'open', starred: false },
    ]

    it('a failed write to one row leaves a concurrently-applied patch to a different row alone', async () => {
      tableRows.set('clause_status', [...TWO_ROWS])
      const status = renderHook(() => useClauseStatus(), { wrapper })
      await waitFor(() => expect(status.result.current.data).toHaveLength(2))
      const key = queryKeys.clauseStatus('season-a')

      failReads = true // isolate the rollback: no refetch masks it either way
      failWriteWhen = (payload) => payload.clause_key === 'B.1.1.1'

      const mutA = renderHook(() => useSetClauseStatus(), { wrapper })
      const mutB = renderHook(() => useSetClauseStatus(), { wrapper })

      const pA = mutA.result.current.mutateAsync({ clauseKey: 'B.1.1.1', state: 'verified' }).catch(() => {})
      // Let A's optimistic patch land before B starts, so B's own optimistic
      // apply runs on top of it — the exact ordering the old whole-list
      // rollback got wrong.
      await waitFor(() => {
        const rows = queryClient.getQueryData<typeof TWO_ROWS>(key)
        expect(rows?.find((r) => r.clause_key === 'B.1.1.1')?.state).toBe('verified')
      })
      const pB = mutB.result.current.mutateAsync({ clauseKey: 'B.1.1.2', state: 'verified' })
      await Promise.all([pA, pB])
      await waitFor(() => expect(mutA.result.current.isError).toBe(true))

      const rows = queryClient.getQueryData<typeof TWO_ROWS>(key)
      expect(rows?.find((r) => r.clause_key === 'B.1.1.1')?.state).toBe('open') // rolled back
      expect(rows?.find((r) => r.clause_key === 'B.1.1.2')?.state).toBe('verified') // untouched by A's failure
    })

    it('a failed write to one field leaves a concurrent write to another field of the same row alone', async () => {
      tableRows.set('clause_status', [{ ...TWO_ROWS[0] }])
      const status = renderHook(() => useClauseStatus(), { wrapper })
      await waitFor(() => expect(status.result.current.data).toHaveLength(1))
      const key = queryKeys.clauseStatus('season-a')

      failReads = true
      failWriteWhen = (payload) => payload.state === 'verified'

      const mutA = renderHook(() => useSetClauseStatus(), { wrapper })
      const mutB = renderHook(() => useSetClauseStatus(), { wrapper })

      const pA = mutA.result.current.mutateAsync({ clauseKey: 'B.1.1.1', state: 'verified' }).catch(() => {})
      await waitFor(() => {
        const rows = queryClient.getQueryData<typeof TWO_ROWS>(key)
        expect(rows?.[0]?.state).toBe('verified')
      })
      const pB = mutB.result.current.mutateAsync({ clauseKey: 'B.1.1.1', starred: true })
      await Promise.all([pA, pB])
      await waitFor(() => expect(mutA.result.current.isError).toBe(true))

      const row = queryClient.getQueryData<typeof TWO_ROWS>(key)?.[0]
      expect(row?.state).toBe('open') // A's own field rolled back
      expect(row?.starred).toBe(true) // B's field, untouched
    })

    it('preserves a newer optimistic value on the same field when an older mutation to it fails', async () => {
      tableRows.set('clause_status', [{ ...TWO_ROWS[0] }])
      const status = renderHook(() => useClauseStatus(), { wrapper })
      await waitFor(() => expect(status.result.current.data).toHaveLength(1))
      const key = queryKeys.clauseStatus('season-a')

      failReads = true
      // A sets 'verified' and fails; B sets 'compliant' on the same field
      // after A's optimistic value has already landed, and succeeds.
      failWriteWhen = (payload) => payload.state === 'verified'

      const mutA = renderHook(() => useSetClauseStatus(), { wrapper })
      const mutB = renderHook(() => useSetClauseStatus(), { wrapper })

      const pA = mutA.result.current.mutateAsync({ clauseKey: 'B.1.1.1', state: 'verified' }).catch(() => {})
      await waitFor(() => {
        const rows = queryClient.getQueryData<typeof TWO_ROWS>(key)
        expect(rows?.[0]?.state).toBe('verified')
      })
      const pB = mutB.result.current.mutateAsync({ clauseKey: 'B.1.1.1', state: 'compliant' })
      await waitFor(() => {
        const rows = queryClient.getQueryData<typeof TWO_ROWS>(key)
        expect(rows?.[0]?.state).toBe('compliant')
      })
      await Promise.all([pA, pB])
      await waitFor(() => expect(mutA.result.current.isError).toBe(true))

      // A's rollback must not stamp its own pre-mutation value ('open') over
      // B's newer, already-applied 'compliant' — B's write already succeeded.
      const row = queryClient.getQueryData<typeof TWO_ROWS>(key)?.[0]
      expect(row?.state).toBe('compliant')
    })
  })
})

describe('read errors', () => {
  it('become hook errors, not blank state', async () => {
    tableRows.set('members', [])
    const failing = { from: () => ({
      select: () => failing.from(),
      order: () => failing.from(),
      range: () => failing.from(),
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
