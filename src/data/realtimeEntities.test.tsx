import { QueryClient } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from './queryKeys.ts'

// Each entity hook's own onChange logic, in isolation: useSeasonRealtimeChannel
// itself is fully covered by realtime.test.ts, so here it is mocked away and
// invoked directly with synthetic payloads to prove each hook does the right
// thing to the query cache — a direct patch where the realtime table IS what
// the screen reads, an invalidation where it reads a derived view instead.

let capturedTable: string | undefined
let capturedOnChange: ((payload: unknown, seasonId: string) => void) | undefined
let capturedOptions: { filterBySeasonId?: boolean } | undefined

vi.mock('./realtime.ts', () => ({
  useSeasonRealtimeChannel: (
    table: string,
    onChange: (payload: unknown, seasonId: string) => void,
    options?: { filterBySeasonId?: boolean },
  ) => {
    capturedTable = table
    capturedOnChange = onChange
    capturedOptions = options
    return 'live'
  },
}))

const { QueryClientProvider } = await import('@tanstack/react-query')
const { useRealtimeTasks } = await import('./useRealtimeTasks.ts')
const { useRealtimeProposals } = await import('./useRealtimeProposals.ts')
const { useRealtimeSpecs } = await import('./useRealtimeSpecs.ts')
const { useRealtimeMilestoneSections } = await import('./useRealtimeMilestoneSections.ts')

function mount(hook: () => unknown, queryClient: QueryClient) {
  return renderHook(hook, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
}

describe('useRealtimeTasks', () => {
  it('patches the tasks cache in place, inserts a new row, and drops a deleted one', () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.tasks('season-a'), [{ id: 't1', title: 'Old title' }])
    mount(() => useRealtimeTasks(), qc)

    expect(capturedTable).toBe('tasks')
    capturedOnChange?.({ eventType: 'UPDATE', new: { id: 't1', title: 'New title' }, old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-a'))).toEqual([{ id: 't1', title: 'New title' }])

    capturedOnChange?.({ eventType: 'INSERT', new: { id: 't2', title: 'Added elsewhere' }, old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-a'))).toEqual([
      { id: 't1', title: 'New title' },
      { id: 't2', title: 'Added elsewhere' },
    ])

    capturedOnChange?.({ eventType: 'DELETE', new: null, old: { id: 't1' } }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-a'))).toEqual([{ id: 't2', title: 'Added elsewhere' }])
  })

  it('never touches another season\'s cache entry', () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.tasks('season-a'), [{ id: 't1', title: 'A' }])
    qc.setQueryData(queryKeys.tasks('season-b'), [{ id: 't2', title: 'B' }])
    mount(() => useRealtimeTasks(), qc)

    capturedOnChange?.({ eventType: 'UPDATE', new: { id: 't1', title: 'Changed' }, old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-b'))).toEqual([{ id: 't2', title: 'B' }])
  })

  it('does nothing to a cache that has never been read', () => {
    const qc = new QueryClient()
    mount(() => useRealtimeTasks(), qc)
    capturedOnChange?.({ eventType: 'INSERT', new: { id: 't1', title: 'X' }, old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-a'))).toBeUndefined()
  })
})

describe('useRealtimeProposals', () => {
  it('subscribes to task_proposals and patches its own cache entry', () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.proposals('season-a'), [{ id: 'p1', title: 'Old' }])
    mount(() => useRealtimeProposals(), qc)

    expect(capturedTable).toBe('task_proposals')
    capturedOnChange?.({ eventType: 'UPDATE', new: { id: 'p1', title: 'New' }, old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.proposals('season-a'))).toEqual([{ id: 'p1', title: 'New' }])
  })
})

describe('useRealtimeSpecs', () => {
  it('subscribes to specs but invalidates spec_verdicts rather than patching', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    mount(() => useRealtimeSpecs(), qc)

    expect(capturedTable).toBe('specs')
    capturedOnChange?.({ eventType: 'UPDATE', new: { id: 'sp1', measured: 612 }, old: null }, 'season-a')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.specVerdicts('season-a') })
  })
})

describe('useRealtimeMilestoneSections', () => {
  it('subscribes unfiltered by season, since the table has no season_id', () => {
    const qc = new QueryClient()
    mount(() => useRealtimeMilestoneSections(), qc)
    expect(capturedTable).toBe('milestone_sections')
    expect(capturedOptions).toEqual({ filterBySeasonId: false })
  })

  it('invalidates the current season\'s milestoneSections cache entry only', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    mount(() => useRealtimeMilestoneSections(), qc)

    capturedOnChange?.({ eventType: 'UPDATE', new: { id: 'sec1' }, old: null }, 'season-a')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.milestoneSections('season-a') })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.milestoneSections('season-b') })
  })
})
