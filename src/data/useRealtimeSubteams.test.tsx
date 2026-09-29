import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from './queryKeys.ts'

// useRealtimeSubteams is NOT built on useSeasonRealtimeChannel (departments
// are global, not season-scoped — see the hook's own comment), so it needs
// its own direct channel mock, following the same shape realtime.test.ts
// uses for the shared hook.

type Handler = (payload: unknown) => void

let handlers: Record<string, Handler>
let removed: string[]
let subscribeResult: string | 'never'

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

let authState: 'member' | 'signed-out' = 'member'
vi.mock('../auth/context.ts', () => ({
  useAuth: () => (authState === 'member' ? { status: 'member', user: { id: 'm1' } } : { status: 'signed-out' }),
}))

const { useRealtimeSubteams } = await import('./useRealtimeSubteams.ts')

function mount(queryClient: QueryClient) {
  return renderHook(() => useRealtimeSubteams(), {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  })
}

beforeEach(() => {
  handlers = {}
  removed = []
  subscribeResult = 'SUBSCRIBED'
  authState = 'member'
})

describe('useRealtimeSubteams', () => {
  it('is off when signed out', () => {
    authState = 'signed-out'
    const { result } = mount(new QueryClient())
    expect(result.current).toBe('off')
  })

  it('goes connecting, then live once the channel subscribes', async () => {
    subscribeResult = 'never'
    const qc = new QueryClient()
    const { result } = mount(qc)
    expect(result.current).toBe('connecting')
  })

  it('invalidates the subteams query on any change, without patching it', async () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.subteams, [{ key: 'GEOM', name: 'Design Envelope' }])
    mount(qc)
    await waitFor(() => expect(handlers['subteams-m1']).toBeDefined())

    handlers['subteams-m1']({ eventType: 'UPDATE', new: { key: 'GEOM', name: 'Renamed' }, old: null })

    await waitFor(() => expect(qc.getQueryState(queryKeys.subteams)?.isInvalidated).toBe(true))
    // Unlike the season-scoped entity hooks, this never rewrites the cached
    // rows itself — only a refetch (triggered by the invalidation) does.
    expect(qc.getQueryData(queryKeys.subteams)).toEqual([{ key: 'GEOM', name: 'Design Envelope' }])
  })

  it('tears down the channel on unmount', () => {
    const qc = new QueryClient()
    const { unmount } = mount(qc)
    unmount()
    expect(removed).toContain('subteams-m1')
  })
})
