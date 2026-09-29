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
let capturedOptions: { filterBySeasonId?: boolean; onSubscribed?: (seasonId: string) => void } | undefined
// Every channel a hook opened (a hook may open more than one), and the state each table reports.
const channels: { table: string; onChange: (payload: unknown, seasonId: string) => void }[] = []
let stateFor: Record<string, string> = {}

vi.mock('./realtime.ts', () => ({
  useSeasonRealtimeChannel: (
    table: string,
    onChange: (payload: unknown, seasonId: string) => void,
    options?: { filterBySeasonId?: boolean; onSubscribed?: (seasonId: string) => void },
  ) => {
    capturedTable = table
    capturedOnChange = onChange
    capturedOptions = options
    channels.push({ table, onChange })
    return stateFor[table] ?? 'live'
  },
}))

const { QueryClientProvider } = await import('@tanstack/react-query')
const { useRealtimeTasks } = await import('./useRealtimeTasks.ts')
const { useRealtimeProposals } = await import('./useRealtimeProposals.ts')
const { useRealtimeProposalComments } = await import('./useRealtimeProposalComments.ts')
const { useRealtimeSpecs } = await import('./useRealtimeSpecs.ts')
const { useRealtimeTaskRequirements } = await import('./useRealtimeTaskRequirements.ts')
const { useRealtimeMilestoneSections } = await import('./useRealtimeMilestoneSections.ts')

function mount(hook: () => unknown, queryClient: QueryClient) {
  return renderHook(hook, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
}

describe('useRealtimeTasks', () => {
  const active = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, archived_at: null, ...extra })

  it('replaces a known active row, so a state, owner or department change is re-evaluated by whatever filter shows', () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.tasks('season-a'), [active('t1', 'Old title')])
    mount(() => useRealtimeTasks(), qc)

    expect(capturedTable).toBe('tasks')
    capturedOnChange?.({ eventType: 'UPDATE', new: active('t1', 'New title', { owner_id: 'm2' }), old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-a'))).toEqual([active('t1', 'New title', { owner_id: 'm2' })])
  })

  it('does NOT blindly insert a row the active list does not hold: it refetches the list instead', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    qc.setQueryData(queryKeys.tasks('season-a'), [active('t1', 'Known')])
    mount(() => useRealtimeTasks(), qc)

    capturedOnChange?.({ eventType: 'INSERT', new: active('t2', 'Unknown to this client'), old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-a'))).toEqual([active('t1', 'Known')])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks('season-a') })
  })

  it('removes a task that was archived, and refreshes the archive, progress and requirement views', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    qc.setQueryData(queryKeys.tasks('season-a'), [active('t1', 'A'), active('t2', 'B')])
    mount(() => useRealtimeTasks(), qc)

    capturedOnChange?.({ eventType: 'UPDATE', new: active('t1', 'A', { archived_at: '2026-09-24T00:00:00Z' }), old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-a'))).toEqual([active('t2', 'B')])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.archive('season-a') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.progressTasks('season-a') })
  })

  it('a restored task (active again, unknown to the list) is refetched into place', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    qc.setQueryData(queryKeys.tasks('season-a'), [])
    mount(() => useRealtimeTasks(), qc)
    capturedOnChange?.({ eventType: 'UPDATE', new: active('t1', 'Restored'), old: null }, 'season-a')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks('season-a') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.archive('season-a') })
  })

  it('drops a deleted row', () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.tasks('season-a'), [active('t1', 'A'), active('t2', 'B')])
    mount(() => useRealtimeTasks(), qc)
    capturedOnChange?.({ eventType: 'DELETE', new: null, old: { id: 't1' } }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-a'))).toEqual([active('t2', 'B')])
  })

  it('never touches another season\'s cache entry', () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.tasks('season-a'), [active('t1', 'A')])
    qc.setQueryData(queryKeys.tasks('season-b'), [active('t2', 'B')])
    mount(() => useRealtimeTasks(), qc)

    capturedOnChange?.({ eventType: 'UPDATE', new: active('t1', 'Changed'), old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.tasks('season-b'))).toEqual([active('t2', 'B')])
  })

  it('does nothing to a cache that has never been read', () => {
    const qc = new QueryClient()
    mount(() => useRealtimeTasks(), qc)
    capturedOnChange?.({ eventType: 'INSERT', new: active('t1', 'X'), old: null }, 'season-a')
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

describe('useRealtimeProposalComments', () => {
  it('invalidates the season discussion and activity when a comment arrives', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    mount(() => useRealtimeProposalComments(), qc)
    expect(capturedTable).toBe('proposal_comments')
    capturedOnChange?.({ eventType: 'INSERT', new: { id: 'c1', proposal_id: 'p1' }, old: null }, 'season-a')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.proposalComments('season-a') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.activityAll('season-a') })
  })
})

describe('useRealtimeSpecs', () => {
  function open(qc: QueryClient) {
    channels.length = 0
    stateFor = {}
    const view = mount(() => useRealtimeSpecs(), qc)
    const on = (table: string) => channels.find((c) => c.table === table)?.onChange
    return { view, on }
  }

  it('listens to the specs table AND the measurement history', () => {
    open(new QueryClient())
    expect(channels.map((c) => c.table).sort()).toEqual(['spec_measurements', 'specs'])
  })

  it('a specs change invalidates spec_verdicts rather than patching (the view derives verdict, goal status and zone)', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { on } = open(qc)

    on('specs')?.({ eventType: 'UPDATE', new: { id: 'sp1', measured: 612 }, old: null }, 'season-a')
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.specVerdicts('season-a') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.activityAll('season-a') })
  })

  it('a history change refreshes every open history and the verdicts (a correction changes the current value)', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { on } = open(qc)

    // A backdated observation touches no specs row, so this channel is the only signal.
    on('spec_measurements')?.({ eventType: 'INSERT', new: { id: 'm1', spec_id: 'sp1' }, old: null }, 'season-a')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.specMeasurementsAll('season-a') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.specVerdicts('season-a') })
  })

  it('never writes payload rows into a cache', () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.specVerdicts('season-a'), [{ id: 'sp1', verdict: 'pass' }])
    const { on } = open(qc)
    on('specs')?.({ eventType: 'UPDATE', new: { id: 'sp1', measured: 1 }, old: null }, 'season-a')
    on('spec_measurements')?.({ eventType: 'INSERT', new: { id: 'm1' }, old: null }, 'season-a')
    expect(qc.getQueryData(queryKeys.specVerdicts('season-a'))).toEqual([{ id: 'sp1', verdict: 'pass' }])
  })

  it('reports live only when both channels are, and off if either is', () => {
    const qc = new QueryClient()
    channels.length = 0
    stateFor = { specs: 'live', spec_measurements: 'connecting' }
    expect(mount(() => useRealtimeSpecs(), qc).result.current).toBe('connecting')
    stateFor = { specs: 'live', spec_measurements: 'off' }
    expect(mount(() => useRealtimeSpecs(), qc).result.current).toBe('off')
    stateFor = {}
    expect(mount(() => useRealtimeSpecs(), qc).result.current).toBe('live')
  })
})

describe('useRealtimeMilestoneSections', () => {
  it('subscribes unfiltered by season, since the table has no season_id', () => {
    const qc = new QueryClient()
    mount(() => useRealtimeMilestoneSections(), qc)
    expect(capturedTable).toBe('milestone_sections')
    expect(capturedOptions?.filterBySeasonId).toBe(false)
    expect(typeof capturedOptions?.onSubscribed).toBe('function')
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

describe('useRealtimeTaskRequirements', () => {
  it('watches only its own season\'s links, now that the junction carries season_id, and refreshes the current season\'s link list', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    mount(() => useRealtimeTaskRequirements(), qc)

    expect(capturedTable).toBe('task_requirements')
    expect(capturedOptions?.filterBySeasonId).not.toBe(false)
    expect(typeof capturedOptions?.onSubscribed).toBe('function')

    capturedOnChange?.({ eventType: 'INSERT', new: { task_id: 't1', clause_key: 'B.1' }, old: null }, 'season-a')
    capturedOnChange?.({ eventType: 'DELETE', new: null, old: { task_id: 't1', clause_key: 'B.1' } }, 'season-a')
    expect(invalidate).toHaveBeenCalledTimes(4)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.taskRequirements('season-a') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.activityAll('season-a') })
  })
})
