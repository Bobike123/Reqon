import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The shared channel lifecycle every season-scoped live table depends on:
// subscribe, season-aware teardown, and status derivation. Tested once here,
// directly — the per-entity hooks (useRealtimeTasks etc.) only need to prove
// their OWN onChange logic, which they do by mocking this module away.

type Handler = (payload: unknown) => void

let handlers: Record<string, Handler>
let removed: string[]
let subscribeResult: string | 'never' // 'never' leaves the channel 'connecting'

function makeChannel(name: string) {
  const channel = {
    name,
    on: (_type: string, _filter: unknown, handler: Handler) => {
      handlers[name] = handler
      return channel
    },
    subscribe: (cb: (status: string) => void) => {
      if (subscribeResult !== 'never') cb(subscribeResult)
      return channel
    },
  }
  return channel
}

const supabase = {
  channel: (name: string) => makeChannel(name),
  removeChannel: (ch: { name: string }) => { removed.push(ch.name) },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))

let currentSeasonId: string | undefined = 'season-a'
vi.mock('../season/context.ts', () => ({
  useSeasonId: () => currentSeasonId,
}))

let authState: 'member' | 'signed-out' = 'member'
vi.mock('../auth/context.ts', () => ({
  useAuth: () => (authState === 'member' ? { status: 'member', user: { id: 'm1' } } : { status: 'signed-out' }),
}))

const { useSeasonRealtimeChannel } = await import('./realtime.ts')

beforeEach(() => {
  handlers = {}
  removed = []
  subscribeResult = 'SUBSCRIBED'
  currentSeasonId = 'season-a'
  authState = 'member'
})

describe('useSeasonRealtimeChannel', () => {
  it('is off with no current season', async () => {
    currentSeasonId = undefined
    const { result } = renderHook(() => useSeasonRealtimeChannel('tasks', () => {}))
    expect(result.current).toBe('off')
  })

  it('is off when signed out, even with a season', async () => {
    authState = 'signed-out'
    const { result } = renderHook(() => useSeasonRealtimeChannel('tasks', () => {}))
    expect(result.current).toBe('off')
  })

  it('goes connecting, then live once the channel subscribes', async () => {
    subscribeResult = 'never'
    const { result, rerender } = renderHook(() => useSeasonRealtimeChannel('tasks', () => {}))
    expect(result.current).toBe('connecting')

    subscribeResult = 'SUBSCRIBED'
    // Re-trigger the effect the only way available without touching internals:
    // a fresh channel is opened per season, so switching season re-subscribes.
    currentSeasonId = 'season-b'
    rerender()
    await waitFor(() => expect(result.current).toBe('live'))
  })

  it('reports off when the channel closes', async () => {
    subscribeResult = 'CLOSED'
    const { result } = renderHook(() => useSeasonRealtimeChannel('tasks', () => {}))
    await waitFor(() => expect(result.current).toBe('off'))
  })

  it('passes the event and the season id to onChange', async () => {
    const onChange = vi.fn()
    renderHook(() => useSeasonRealtimeChannel('tasks', onChange))
    await waitFor(() => expect(handlers['tasks-season-a']).toBeDefined())

    act(() => handlers['tasks-season-a']({ eventType: 'UPDATE', new: { id: 't1' }, old: null }))
    expect(onChange).toHaveBeenCalledWith({ eventType: 'UPDATE', new: { id: 't1' }, old: null }, 'season-a')
  })

  it('tears down the old channel and opens a new one when the season changes', async () => {
    const { rerender } = renderHook(() => useSeasonRealtimeChannel('tasks', () => {}))
    await waitFor(() => expect(handlers['tasks-season-a']).toBeDefined())

    currentSeasonId = 'season-b'
    rerender()
    await waitFor(() => expect(handlers['tasks-season-b']).toBeDefined())
    expect(removed).toContain('tasks-season-a')
  })

  it('tears down on unmount', async () => {
    const { unmount } = renderHook(() => useSeasonRealtimeChannel('tasks', () => {}))
    await waitFor(() => expect(handlers['tasks-season-a']).toBeDefined())
    unmount()
    expect(removed).toContain('tasks-season-a')
  })
})
