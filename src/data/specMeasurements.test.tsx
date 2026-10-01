import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from './queryKeys.ts'

// The commands and the history reader, against a fake that records exactly what
// the client asks the database. The rules themselves (validation, ordering,
// idempotency, authorization) are proven in SQL by supabase/tests/
// spec_measurements_test.sql; this file proves the client asks the right
// question and reports the answer faithfully.

type Call = { fn: string; args: Record<string, unknown> }
let rpcCalls: Call[]
let rpcResult: { data: unknown; error: { message: string; code?: string } | null }
let season: string | undefined

type QueryCall = { table: string; eq: [string, unknown][]; order: [string, unknown][]; range: [number, number] | null }
let queryCalls: QueryCall[]
let pages: Record<string, unknown>[][]

function builder(table: string) {
  const call: QueryCall = { table, eq: [], order: [], range: null }
  queryCalls.push(call)
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => { call.eq.push([c, v]); return b },
    order: (c: string, o: unknown) => { call.order.push([c, o]); return b },
    range: (from: number, to: number) => { call.range = [from, to]; return b },
    then: (resolve: (v: unknown) => void) => {
      const index = call.range ? call.range[0] / (call.range[1] - call.range[0] + 1) : 0
      resolve({ data: pages[index] ?? [], error: null })
      return Promise.resolve()
    },
  }
  return b
}

const supabase = {
  from: (t: string) => builder(t),
  rpc: (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    return Promise.resolve(rpcResult)
  },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => season }))

const { useRecordMeasurement, useCorrectMeasurement, useInvalidateMeasurement, useSpecMeasurements } =
  await import('./useSpecs.ts')

const ROW = { id: 'meas-1', spec_id: 'spec-1', value_numeric: 612, value_bool: null }
const REQ = '11111111-1111-4111-8111-111111111111'

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
}
function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  rpcCalls = []
  queryCalls = []
  pages = []
  season = 'season-a'
  rpcResult = { data: ROW, error: null }
})

describe('useRecordMeasurement', () => {
  it('asks record_spec_measurement for one numeric value, naming the season and the retry identity only', async () => {
    const { result } = renderHook(() => useRecordMeasurement(), { wrapper: wrap(client()) })
    let returned: unknown
    await act(async () => { returned = await result.current.mutateAsync({ specId: 'spec-1', value: 612, requestId: REQ }) })

    expect(rpcCalls).toEqual([{
      fn: 'record_spec_measurement',
      args: { p_season_id: 'season-a', p_spec_id: 'spec-1', p_request_id: REQ, p_value_numeric: 612 },
    }])
    expect(returned).toEqual(ROW)
  })

  it('sends zero and negatives as values, and a boolean as a boolean — never both', async () => {
    const { result } = renderHook(() => useRecordMeasurement(), { wrapper: wrap(client()) })
    await act(async () => { await result.current.mutateAsync({ specId: 's', value: 0, requestId: REQ }) })
    await act(async () => { await result.current.mutateAsync({ specId: 's', value: -20.5, requestId: REQ }) })
    await act(async () => { await result.current.mutateAsync({ specId: 's', value: false, requestId: REQ }) })

    expect(rpcCalls[0].args).toMatchObject({ p_value_numeric: 0 })
    expect(rpcCalls[1].args).toMatchObject({ p_value_numeric: -20.5 })
    expect(rpcCalls[2].args).toMatchObject({ p_value_bool: false })
    expect(rpcCalls[2].args).not.toHaveProperty('p_value_numeric')
  })

  it('adds a measured time, note and source only when given', async () => {
    const { result } = renderHook(() => useRecordMeasurement(), { wrapper: wrap(client()) })
    await act(async () => {
      await result.current.mutateAsync({
        specId: 's', value: 1, requestId: REQ, measuredAt: '2026-09-01T08:00:00Z', note: 'scale 2', source: 'lab',
      })
    })
    expect(rpcCalls[0].args).toMatchObject({ p_measured_at: '2026-09-01T08:00:00Z', p_note: 'scale 2', p_source: 'lab' })
    // Whatever the caller passes, the payload has no field that names an actor.
    expect(Object.keys(rpcCalls[0].args).join(' ')).not.toMatch(/by|actor|user|recorded/)
  })

  it('refreshes the verdicts and every open history when it settles, success or failure', async () => {
    const qc = client()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useRecordMeasurement(), { wrapper: wrap(qc) })

    await act(async () => { await result.current.mutateAsync({ specId: 's', value: 1, requestId: REQ }) })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.specVerdicts('season-a') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.specMeasurementsAll('season-a') })

    invalidate.mockClear()
    rpcResult = { data: null, error: { message: 'boom', code: '22003' } }
    await act(async () => { await result.current.mutateAsync({ specId: 's', value: 1, requestId: REQ }).catch(() => {}) })
    // verdicts, every open history, and the audit trail (an observation is an audited event)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.activityAll('season-a') })
    expect(invalidate).toHaveBeenCalledTimes(3)
  })

  it('reports the database\'s own explanation of a refused value', async () => {
    rpcResult = { data: null, error: { message: 'value -60 is below the plausible minimum -50 for this specification', code: '22003' } }
    const { result } = renderHook(() => useRecordMeasurement(), { wrapper: wrap(client()) })
    await expect(result.current.mutateAsync({ specId: 's', value: -60, requestId: REQ })).rejects.toThrow(
      /record a measurement: value -60 is below the plausible minimum -50/,
    )
  })

  it('words a permission refusal for a person', async () => {
    rpcResult = { data: null, error: { message: 'only an active member can record a measurement', code: '42501' } }
    const { result } = renderHook(() => useRecordMeasurement(), { wrapper: wrap(client()) })
    await expect(result.current.mutateAsync({ specId: 's', value: 1, requestId: REQ })).rejects.toMatchObject({
      permission: true,
    })
  })

  it('does not call the database without a season (a save can never land in the wrong one)', async () => {
    season = undefined
    const { result } = renderHook(() => useRecordMeasurement(), { wrapper: wrap(client()) })
    await expect(result.current.mutateAsync({ specId: 's', value: 1, requestId: REQ })).rejects.toThrow(/no season/)
    expect(rpcCalls).toHaveLength(0)
  })

  it('refuses to report success when nothing came back', async () => {
    rpcResult = { data: null, error: null }
    const { result } = renderHook(() => useRecordMeasurement(), { wrapper: wrap(client()) })
    await expect(result.current.mutateAsync({ specId: 's', value: 1, requestId: REQ })).rejects.toThrow(/nothing was returned/)
  })
})

describe('useCorrectMeasurement and useInvalidateMeasurement', () => {
  it('a correction names the old observation, the reason and the corrected value', async () => {
    const { result } = renderHook(() => useCorrectMeasurement(), { wrapper: wrap(client()) })
    await act(async () => {
      await result.current.mutateAsync({ measurementId: 'meas-1', reason: 'misread the dial', value: 89, requestId: REQ })
    })
    expect(rpcCalls).toEqual([{
      fn: 'correct_spec_measurement',
      args: { p_measurement_id: 'meas-1', p_reason: 'misread the dial', p_request_id: REQ, p_value_numeric: 89 },
    }])
  })

  it('a withdrawal sends only the observation and the reason', async () => {
    const qc = client()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useInvalidateMeasurement(), { wrapper: wrap(qc) })
    await act(async () => { await result.current.mutateAsync({ measurementId: 'meas-1', reason: 'wrong specimen' }) })
    expect(rpcCalls).toEqual([{
      fn: 'invalidate_spec_measurement',
      args: { p_measurement_id: 'meas-1', p_reason: 'wrong specimen' },
    }])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.specVerdicts('season-a') })
  })

  it('report a refusal instead of a success', async () => {
    rpcResult = { data: null, error: { message: 'that measurement was already corrected or withdrawn', code: '22023' } }
    const c = renderHook(() => useCorrectMeasurement(), { wrapper: wrap(client()) })
    await expect(c.result.current.mutateAsync({ measurementId: 'm', reason: 'r', value: 1, requestId: REQ })).rejects.toThrow(/already corrected/)
    const i = renderHook(() => useInvalidateMeasurement(), { wrapper: wrap(client()) })
    await expect(i.result.current.mutateAsync({ measurementId: 'm', reason: 'r' })).rejects.toThrow(/already corrected/)
  })
})

describe('useSpecMeasurements', () => {
  const row = (id: string) => ({ id, spec_id: 'spec-1', season_id: 'season-a', value_numeric: 1 })

  it('reads one specification\'s history in the same order the database uses for the current value', async () => {
    pages = [[row('a'), row('b')]]
    const { result } = renderHook(() => useSpecMeasurements('spec-1', 25), { wrapper: wrap(client()) })
    await waitFor(() => expect(result.current.data?.rows).toHaveLength(2))

    const call = queryCalls[0]
    expect(call.table).toBe('spec_measurements')
    expect(call.eq).toEqual([['season_id', 'season-a'], ['spec_id', 'spec-1']])
    expect(call.order).toEqual([
      ['measured_at', { ascending: false, nullsFirst: false }],
      ['recorded_at', { ascending: false }],
      ['id', { ascending: false }],
    ])
    expect(call.range).toEqual([0, 24])
    expect(result.current.data?.hasMore).toBe(false)
  })

  it('pages, and drops a row that reappears when a new observation shifted the window', async () => {
    pages = [[row('a'), row('b')], [row('b'), row('c')]]
    const { result } = renderHook(() => useSpecMeasurements('spec-1', 2), { wrapper: wrap(client()) })
    await waitFor(() => expect(result.current.data?.rows).toHaveLength(2))
    expect(result.current.data?.hasMore).toBe(true)

    await act(async () => { await result.current.fetchNextPage() })
    await waitFor(() => expect(result.current.data?.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']))
    expect(queryCalls[1].range).toEqual([2, 3])
  })

  it('does not ask without a specification or a season', async () => {
    const none = renderHook(() => useSpecMeasurements(undefined), { wrapper: wrap(client()) })
    season = undefined
    const noSeason = renderHook(() => useSpecMeasurements('spec-1'), { wrapper: wrap(client()) })
    await act(async () => { await Promise.resolve() })
    expect(queryCalls).toHaveLength(0)
    expect(none.result.current.fetchStatus).toBe('idle')
    expect(noSeason.result.current.fetchStatus).toBe('idle')
  })

  it('keeps each specification\'s history under its own key, inside the season prefix', () => {
    expect(queryKeys.specMeasurements('season-a', 'spec-1')).toEqual(['season', 'season-a', 'spec_measurements', 'spec-1'])
    expect(queryKeys.specMeasurements('season-a', 'spec-1').slice(0, 3)).toEqual(queryKeys.specMeasurementsAll('season-a'))
    expect(queryKeys.specMeasurements('season-a', 'spec-1')).not.toEqual(queryKeys.specMeasurements('season-b', 'spec-1'))
  })
})
