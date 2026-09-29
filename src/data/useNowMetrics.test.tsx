import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// D2 (ADR-0007): the attention list must be judged against the READER's own day,
// passed in explicitly, never the database's current_date.
const rpc = vi.fn()
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return { rpc } } }))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => 'season-a' }))

const { useAttention } = await import('./useNowMetrics.ts')

function run() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => useAttention(), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
}

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ data: [], error: null })
})
afterEach(() => vi.useRealTimers())

describe('useAttention', () => {
  it('asks attention(p_season, p_today) with the reader\'s own local calendar day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 23:30 local on the 24th: a UTC-based "today" would already say the 25th
    // for anyone east of UTC, and the 24th for anyone west; the local day is fixed.
    vi.setSystemTime(new Date(2026, 8, 24, 23, 30))
    const { result } = run()
    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(rpc).toHaveBeenCalledWith('attention', { p_season: 'season-a', p_today: '2026-09-24' })
  })

  it('surfaces a failure instead of an empty list', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'nope', code: '42501' } })
    const { result } = run()
    await waitFor(() => expect(result.current.error).toBeTruthy())
  })
})
