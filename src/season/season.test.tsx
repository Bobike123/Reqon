import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The season boundary, tested directly: SeasonProvider/useSeason/SeasonGate,
// and the guarantees the rest of the app builds on top of them — namespaced
// caches, no stale-season flash, no list-query instantiated just to read a
// season id. supabase/tests and the per-page suites prove the database side
// and the screens; this proves the boundary itself.

type SeasonRow = { id: string; label: string } | null

let currentSeason: SeasonRow = { id: 'season-a', label: '2026/27' }
let seasonFails = false
const tableRows = new Map<string, Record<string, unknown>[]>()

function builder(table: string) {
  const ctx = {
    op: 'select', payload: {} as Record<string, unknown>, filters: {} as Record<string, unknown>,
    range: undefined as [number, number] | undefined,
  }
  const matches = (row: Record<string, unknown>) =>
    Object.entries(ctx.filters).every(([k, v]) => row[k] === v)
  const run = () => {
    if (table === 'v_current_season') {
      if (seasonFails) return { data: null, error: { message: 'connection lost', code: '08006' } }
      return { data: currentSeason, error: null }
    }
    const rows = tableRows.get(table) ?? []
    if (ctx.op === 'select') {
      const hit = rows.filter(matches)
      return { data: ctx.range ? hit.slice(ctx.range[0], ctx.range[1] + 1) : hit, error: null }
    }
    if (ctx.op === 'update') {
      const hit = rows.filter(matches)
      tableRows.set(table, rows.map((r) => (matches(r) ? { ...r, ...ctx.payload } : r)))
      return { data: hit, error: null }
    }
    return { data: rows, error: null }
  }
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    range: (from: number, to: number) => { ctx.range = [from, to]; return b },
    eq: (col: string, val: unknown) => {
      ctx.filters[col] = val
      return b
    },
    update: (payload: Record<string, unknown>) => {
      ctx.op = 'update'
      ctx.payload = payload
      return b
    },
    maybeSingle: () => b,
    then: (resolve: (v: unknown) => void) => {
      resolve(run())
      return Promise.resolve()
    },
  }
  return b
}

const supabase = { from: (table: string) => builder(table) }
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))

const { useSeason } = await import('./context.ts')
const { SeasonProvider } = await import('./SeasonProvider.tsx')
const { SeasonGate } = await import('./SeasonGate.tsx')
const { useTasksForSeason, useTasks, useUpdateTask } = await import('../data/useTasks.ts')
const { queryKeys } = await import('../data/queryKeys.ts')

let queryClient: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SeasonProvider>{children}</SeasonProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  currentSeason = { id: 'season-a', label: '2026/27' }
  seasonFails = false
  tableRows.clear()
  tableRows.set('tasks', [
    { id: 't-a1', season_id: 'season-a', title: 'A task' },
    { id: 't-b1', season_id: 'season-b', title: 'B task' },
  ])
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

describe('useSeason() states', () => {
  it('throws outside a SeasonProvider — there is no silent default', () => {
    expect(() => renderHook(() => useSeason())).toThrow(/SeasonProvider/)
  })

  it('is loading, then ready, with season and seasonId set', async () => {
    const { result } = renderHook(() => useSeason(), { wrapper })
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('unreachable')
    expect(result.current.seasonId).toBe('season-a')
    expect(result.current.season.label).toBe('2026/27')
  })

  it('is no-current-season when the query succeeds with no row — not the same as loading or failed', async () => {
    currentSeason = null
    const { result } = renderHook(() => useSeason(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('no-current-season'))
  })

  it('is failed, with the error, when the query itself fails — distinct from no-current-season', async () => {
    seasonFails = true
    const { result } = renderHook(() => useSeason(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('failed'))
    if (result.current.status !== 'failed') throw new Error('unreachable')
    expect(result.current.error.message).toContain('connection lost')
  })

  it('retry() re-asks the database and can recover a failed season', async () => {
    seasonFails = true
    const { result } = renderHook(() => useSeason(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('failed'))

    seasonFails = false
    await act(async () => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })
})

describe('SeasonGate', () => {
  it('renders a loading state, not the child, while the season is unresolved', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SeasonProvider>
          <SeasonGate>
            <div>the page</div>
          </SeasonGate>
        </SeasonProvider>
      </QueryClientProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i)
    expect(screen.queryByText('the page')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('the page')).toBeInTheDocument())
  })

  it('renders an empty state with a link to Settings when there is no current season — never the child', async () => {
    currentSeason = null
    render(
      <QueryClientProvider client={queryClient}>
        <SeasonProvider>
          <MemoryRouter>
            <SeasonGate>
              <div>the page</div>
            </SeasonGate>
          </MemoryRouter>
        </SeasonProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('No current season')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Go to Settings' })).toBeInTheDocument()
    expect(screen.queryByText('the page')).not.toBeInTheDocument()
  })

  it('renders an error state with retry when the season query fails — never the child', async () => {
    seasonFails = true
    render(
      <QueryClientProvider client={queryClient}>
        <SeasonProvider>
          <MemoryRouter>
            <SeasonGate>
              <div>the page</div>
            </SeasonGate>
          </MemoryRouter>
        </SeasonProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('Could not load the current season')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('connection lost')
    expect(screen.queryByText('the page')).not.toBeInTheDocument()
  })
})

describe('switching season A -> B, and the cache underneath it', () => {
  it('a season-scoped read for a SPECIFIC season never crosses with another season', async () => {
    const a = renderHook(() => useTasksForSeason('season-a'), { wrapper })
    const b = renderHook(() => useTasksForSeason('season-b'), { wrapper })
    await waitFor(() => expect(a.result.current.data).toHaveLength(1))
    await waitFor(() => expect(b.result.current.data).toHaveLength(1))
    expect(a.result.current.data?.[0].id).toBe('t-a1')
    expect(b.result.current.data?.[0].id).toBe('t-b1')
  })

  it('switching the current season shows B, never a flash of A, and A stays cached separately', async () => {
    const { result } = renderHook(() => useTasks(), { wrapper })
    await waitFor(() => expect(result.current.data?.[0]?.id).toBe('t-a1'))

    // The board switches season (set_current_season() in production; here,
    // simply what the next v_current_season read returns).
    currentSeason = { id: 'season-b', label: '2027/28' }
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['currentSeason'] })
    })

    await waitFor(() => expect(result.current.data?.[0]?.id).toBe('t-b1'))
    // Never season A's row under season B's read.
    expect(result.current.data?.some((t) => t.id === 't-a1')).toBe(false)
    // Season A's own cache entry was never touched, let alone dropped.
    expect(queryClient.getQueryData(queryKeys.tasks('season-a'))).toEqual([
      { id: 't-a1', season_id: 'season-a', title: 'A task' },
    ])
  })

  it('a mutation created while B is current targets B, not whatever A last was', async () => {
    currentSeason = { id: 'season-b', label: '2027/28' }
    const list = renderHook(() => useTasks(), { wrapper })
    await waitFor(() => expect(list.result.current.data?.[0]?.id).toBe('t-b1'))

    const update = renderHook(() => useUpdateTask(), { wrapper })
    await act(async () => {
      await update.result.current.mutateAsync({ id: 't-b1', title: 'Renamed under B' })
    })

    // The optimistic write landed on season B's cache entry specifically.
    const bRows = queryClient.getQueryData<{ id: string; title: string }[]>(queryKeys.tasks('season-b'))
    expect(bRows?.find((t) => t.id === 't-b1')?.title).toBe('Renamed under B')
    // Season A's entry (never fetched in this test) was never created or touched.
    expect(queryClient.getQueryData(queryKeys.tasks('season-a'))).toBeUndefined()
  })
})

describe('mutation hooks do not instantiate a list-query observer', () => {
  it('mounting useUpdateTask alone never fetches the tasks list', async () => {
    // Mount ONLY the mutation hook — no useTasks()/useTasksForSeason() in this
    // tree at all. Under the old pattern (useUpdateTask -> useTasks() -> read
    // .seasonId), this alone would have started a full tasks fetch.
    renderHook(() => useUpdateTask(), { wrapper })

    // Give the season query (which useSeasonId() legitimately needs) time to
    // resolve, then confirm no OTHER query — specifically the tasks list —
    // was ever registered in the cache.
    await waitFor(() => expect(queryClient.getQueryData(['currentSeason'])).toBeTruthy())
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.tasks('season-a') })).toBeUndefined()
    expect(queryClient.getQueryCache().findAll({ queryKey: ['season'] })).toHaveLength(0)
  })
})
