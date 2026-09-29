import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Proves the WIRING in App.tsx itself: every season-scoped route (Board, Now,
// Priorities, Register, Milestones, Gantt, Proposals, Meetings, Specs,
// Finances) is actually behind SeasonGate, and /settings is deliberately not
// — it is how a club with no current season gets one. SeasonGate's own
// rendering logic (loading/failed/no-current-season/ready) is proven once,
// directly, in season.test.tsx; this only proves each route is wired to it.

let seasonFails = false
let hasCurrentSeason = true

const supabase = {
  from: (table: string) => ({
    select: () => ({
      maybeSingle: () => {
        if (table !== 'v_current_season') return Promise.resolve({ data: [], error: null })
        if (seasonFails) {
          return Promise.resolve({ data: null, error: { message: 'connection lost', code: '08006' } })
        }
        return Promise.resolve({
          data: hasCurrentSeason ? { id: 'season-a', label: '2026/27' } : null,
          error: null,
        })
      },
      order: () => Promise.resolve({ data: [], error: null }),
      eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
    }),
  }),
  auth: {
    getSession: () => Promise.resolve({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1', full_name: 'Ada' }, roles: [] }),
}))
// RequireAuth and TutorialProvider have their own real dependencies (a real
// Supabase auth session, localStorage) unrelated to season routing — stubbed
// as pass-throughs so this test is only about which route sits behind
// SeasonGate, not about signing in or the guided tour.
vi.mock('../auth/RequireAuth.tsx', () => ({ default: ({ children }: { children: unknown }) => children }))
vi.mock('../tutorial/TutorialProvider.tsx', () => ({
  TutorialProvider: ({ children }: { children: unknown }) => children,
}))
vi.mock('../ui/AppHeader.tsx', () => ({ AppHeader: () => null }))
// App.tsx subscribes to department/Head changes at the shell level, above
// every route; this test is only about route-to-SeasonGate wiring.
vi.mock('../data/useRealtimeSubteams.ts', () => ({ useRealtimeSubteams: () => 'off' }))

// Every page stubbed to one marker each — what renders (the page, or
// SeasonGate's fallback in front of it) is exactly what this test checks.
// vi.mock() calls are hoisted and must be static top-level calls (no loop).
vi.mock('../pages/Now.tsx', () => ({ default: () => 'NOW PAGE' }))
vi.mock('../pages/Priorities.tsx', () => ({ default: () => 'PRIORITIES PAGE' }))
vi.mock('../pages/Register.tsx', () => ({ default: () => 'REGISTER PAGE' }))
vi.mock('../pages/Milestones.tsx', () => ({ default: () => 'MILESTONES PAGE' }))
vi.mock('../pages/Gantt.tsx', () => ({ default: () => 'GANTT PAGE' }))
vi.mock('../pages/Board.tsx', () => ({ default: () => 'BOARD PAGE' }))
vi.mock('../pages/Proposals.tsx', () => ({ default: () => 'PROPOSALS PAGE' }))
vi.mock('../pages/Meetings.tsx', () => ({ default: () => 'MEETINGS PAGE' }))
vi.mock('../pages/SpecSheet.tsx', () => ({ default: () => 'SPECS PAGE' }))
vi.mock('../pages/Finances.tsx', () => ({ default: () => 'FINANCES PAGE' }))
vi.mock('../pages/Settings.tsx', () => ({ default: () => 'SETTINGS PAGE' }))

const { default: App } = await import('../App.tsx')

const SEASON_SCOPED_ROUTES: [string, string][] = [
  ['/', 'NOW PAGE'],
  ['/priorities', 'PRIORITIES PAGE'],
  ['/register', 'REGISTER PAGE'],
  ['/milestones', 'MILESTONES PAGE'],
  ['/gantt', 'GANTT PAGE'],
  ['/board', 'BOARD PAGE'],
  ['/proposals', 'PROPOSALS PAGE'],
  ['/meetings', 'MEETINGS PAGE'],
  ['/specs', 'SPECS PAGE'],
  ['/finances', 'FINANCES PAGE'],
]

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  seasonFails = false
  hasCurrentSeason = true
})

describe('every season-scoped route renders normally once the season is ready', () => {
  it.each(SEASON_SCOPED_ROUTES)('%s shows its page', async (path, marker) => {
    renderAt(path)
    await waitFor(() => expect(screen.getByText(marker)).toBeInTheDocument())
  })
})

describe('no current season: every season-scoped route shows the gate, never its page', () => {
  beforeEach(() => {
    hasCurrentSeason = false
  })

  it.each(SEASON_SCOPED_ROUTES)('%s shows "No current season", not its page', async (path, marker) => {
    renderAt(path)
    await waitFor(() => expect(screen.getByText('No current season')).toBeInTheDocument())
    expect(screen.queryByText(marker)).not.toBeInTheDocument()
  })

  // The one route this must NOT apply to: it is how the club gets a season
  // in the first place.
  it('/settings renders regardless — it is not season-scoped', async () => {
    renderAt('/settings')
    await waitFor(() => expect(screen.getByText('SETTINGS PAGE')).toBeInTheDocument())
    expect(screen.queryByText('No current season')).not.toBeInTheDocument()
  })
})

describe('a failed season query: every season-scoped route shows the error, never its page', () => {
  beforeEach(() => {
    seasonFails = true
  })

  it.each(SEASON_SCOPED_ROUTES)('%s shows the season error, not its page', async (path, marker) => {
    renderAt(path)
    await waitFor(() => expect(screen.getByText('Could not load the current season')).toBeInTheDocument())
    expect(screen.queryByText(marker)).not.toBeInTheDocument()
  })

  it('/settings renders regardless of a failed season query', async () => {
    renderAt('/settings')
    await waitFor(() => expect(screen.getByText('SETTINGS PAGE')).toBeInTheDocument())
  })
})
