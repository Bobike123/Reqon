import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clause } from '../data/useClauses.ts'

// Enough of the data layer to render both screens for real.
const CLAUSES = [
  { clause_key: 'B.1', printed_ref: 'B.1', subteam_key: 'GEOM', body: 'Geometry rule', section: 'B', article: 1, obligation: 'constraint', criticality: 'required', is_team_duty: true, milestone_key: null, article_title: null, group_title: null, phase: 'design', specs: null },
  { clause_key: 'F.1', printed_ref: 'F.1', subteam_key: 'DOCS', body: 'Docs rule', section: 'F', article: 1, obligation: 'deliverable', criticality: 'required', is_team_duty: true, milestone_key: null, article_title: null, group_title: null, phase: 'ms1', specs: null },
] as Clause[]

const SUBTEAMS = [
  { key: 'GEOM', name: 'Design Envelope', is_parked: false, sort_order: 0 },
  { key: 'DOCS', name: 'Documentation', is_parked: false, sort_order: 1 },
]

const PROGRESS = [
  { key: 'DOCS', name: 'Documentation', duties: 129, resolved: 4, in_progress: 0, blocked: 0, total_rules: 353, is_parked: false, season_id: 's' },
  { key: 'GEOM', name: 'Design Envelope', duties: 17, resolved: 1, in_progress: 0, blocked: 2, total_rules: 22, is_parked: false, season_id: 's' },
  { key: 'RACEOP', name: 'Race Operations', duties: 58, resolved: 0, in_progress: 0, blocked: 0, total_rules: 195, is_parked: true, season_id: 's' },
]

vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1' }, roles: [] }),
}))
vi.mock('../data/useClauses.ts', () => ({
  useClauses: () => ({ data: CLAUSES, isLoading: false, error: null }),
}))
vi.mock('../data/useClauseStatus.ts', () => ({
  useClauseStatus: () => ({ data: [], isLoading: false, error: null, seasonId: 's' }),
  useSetClauseStatus: () => ({ mutate: vi.fn(), isError: false, error: null }),
}))
vi.mock('../data/useMembers.ts', () => ({
  useMembers: () => ({ data: [{ id: 'm1', full_name: 'Ada Rider' }], isLoading: false, error: null }),
}))
vi.mock('../data/useMilestones.ts', () => ({
  useSubteams: () => ({ data: SUBTEAMS, isLoading: false, error: null }),
  useMilestones: () => ({ data: [{ key: 'MS1-1', name: 'Team Plan', due_on: '2099-11-30', max_points: 75, season_id: 's', ordinal: 1 }], isLoading: false, error: null }),
}))
vi.mock('../data/useNowMetrics.ts', () => ({
  useSubteamProgress: () => ({ data: PROGRESS, isLoading: false, error: null }),
  useAttention: () => ({ data: [], isLoading: false, error: null }),
}))
vi.mock('../data/useTopics.ts', () => ({
  // Now renders the shared TopicsPanel, which needs the whole topic surface.
  useTopics: () => ({ data: [], isLoading: false, error: null, seasonId: 's' }),
  useCreateTopic: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useUpdateTopic: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useConvertTopicToTask: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))
vi.mock('../data/useTasks.ts', () => ({
  useTasks: () => ({ data: [], isLoading: false, error: null, seasonId: 's' }),
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}))
vi.mock('../data/useRealtimeClauseStatus.ts', () => ({
  useRealtimeClauseStatus: () => 'live',
}))

const { default: Now } = await import('./Now.tsx')
const { default: Register } = await import('./Register.tsx')

function renderApp(initial = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/" element={<Now />} />
          <Route path="/register" element={<Register />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('Now dashboard', () => {
  it('shows every instrument', () => {
    renderApp()
    expect(screen.getByTestId('tile-deadline')).toBeInTheDocument()
    expect(screen.getByTestId('tile-obligations')).toHaveTextContent('5 / 146')
    expect(screen.getByTestId('tile-points')).toHaveTextContent('75')
    expect(screen.getByTestId('tile-overdue')).toHaveTextContent('0')
    expect(screen.getByTestId('tile-topics')).toHaveTextContent('0')
    expect(screen.getByTestId('tile-blocked')).toHaveTextContent('0')
  })

  it('excludes parked subteams from the live obligations total', () => {
    renderApp()
    // DOCS 129 + GEOM 17 = 146; RACEOP's 58 are parked and must not be counted.
    expect(screen.getByTestId('tile-obligations')).toHaveTextContent('5 / 146')
  })

  it('links each subsystem into the Register with its filter applied', () => {
    renderApp()
    const link = screen.getByTestId('subteam-GEOM').querySelector('a')
    expect(link).toHaveAttribute('href', '/register?subteam=GEOM')
  })

  it('surfaces a blocked badge on the subsystem that has one', () => {
    renderApp()
    expect(screen.getByTestId('subteam-GEOM')).toHaveTextContent('2 blocked')
  })
})

describe('subsystem -> Register navigation', () => {
  it('lands on the Register scoped to that subsystem only', async () => {
    renderApp()
    await userEvent.click(screen.getByTestId('subteam-GEOM').querySelector('a') as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('subteam-scope')).toBeInTheDocument())
    expect(screen.getByTestId('subteam-scope')).toHaveTextContent('Design Envelope')
    // Only the GEOM rule is listed.
    expect(screen.getByText('Geometry rule')).toBeInTheDocument()
    expect(screen.queryByText('Docs rule')).not.toBeInTheDocument()
  })

  it('can clear the scope back to the whole register', async () => {
    renderApp('/register?subteam=GEOM')
    await waitFor(() => expect(screen.getByTestId('subteam-scope')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(screen.queryByTestId('subteam-scope')).not.toBeInTheDocument())
    expect(screen.getByText('Docs rule')).toBeInTheDocument()
  })
})
