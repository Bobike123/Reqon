import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
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
  { key: 'GEOM', name: 'Design Envelope', is_parked: false, sort_order: 0, archived_at: null, lead_id: null },
  { key: 'DOCS', name: 'Documentation', is_parked: false, sort_order: 1, archived_at: null, lead_id: null },
  { key: 'RACEOP', name: 'Race Operations', is_parked: true, sort_order: 2, archived_at: null, lead_id: null },
  // Archived: v_subteam_progress still lists it, the live overview must not (F14-10).
  { key: 'OLD', name: 'Retired department', is_parked: false, sort_order: 3, archived_at: '2026-01-01T00:00:00Z', lead_id: null },
]

const PROGRESS = [
  { key: 'DOCS', name: 'Documentation', duties: 129, resolved: 4, in_progress: 0, blocked: 0, total_rules: 353, is_parked: false, season_id: 's' },
  { key: 'GEOM', name: 'Design Envelope', duties: 17, resolved: 1, in_progress: 0, blocked: 2, total_rules: 22, is_parked: false, season_id: 's' },
  { key: 'RACEOP', name: 'Race Operations', duties: 58, resolved: 0, in_progress: 0, blocked: 0, total_rules: 195, is_parked: true, season_id: 's' },
  { key: 'OLD', name: 'Retired department', duties: 9, resolved: 9, in_progress: 0, blocked: 0, total_rules: 9, is_parked: false, season_id: 's' },
]

// What the dashboard's sources return, changed per test.
const metrics: { attentionLoading: boolean; attentionError: Error | null } = { attentionLoading: false, attentionError: null }
const TASKS = [
  { id: 't-late', title: 'Late fairing drawing', state: 'wip', owner_id: 'm1', subteam_key: 'GEOM', due_date: '2020-01-01', archived_at: null, priority: 'normal', starts_on: null },
  { id: 't-done', title: 'Finished envelope', state: 'done', owner_id: 'm1', subteam_key: 'GEOM', due_date: null, archived_at: null, priority: 'normal', starts_on: null },
]

vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1', status: 'active' }, roles: [] }),
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
vi.mock('../data/useSubteams.ts', () => ({
  useSubteams: () => ({ data: SUBTEAMS, isLoading: false, error: null }),
}))
vi.mock('../data/useMilestones.ts', () => ({
  useMilestones: () => ({ data: [{ key: 'MS1-1', name: 'Team Plan', due_on: '2099-11-30', max_points: 75, season_id: 's', ordinal: 1 }], isLoading: false, error: null }),
}))
vi.mock('../data/useNowMetrics.ts', () => ({
  useSubteamProgress: () => ({ data: PROGRESS, isLoading: false, error: null }),
  useAttention: () => ({
    data: metrics.attentionLoading || metrics.attentionError ? undefined : [{ kind: 'task', ref: 't-late', title: 'Late fairing drawing', owner_id: 'm1', season_id: 's', reason: 'overdue', starred: false, clause_key: null }],
    isLoading: metrics.attentionLoading,
    error: metrics.attentionError,
    refetch: vi.fn(),
  }),
}))
vi.mock('../data/useProposals.ts', () => ({
  // Now renders the shared ProposalsPanel, which needs the whole proposal surface.
  useProposals: () => ({ data: [], isLoading: false, error: null, seasonId: 's' }),
  useSubmitProposal: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useReviewProposal: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null }),
  useProposalRequirements: () => ({ data: [], isLoading: false, error: null }),
  useSetProposalRequirements: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useUpdateProposal: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null }),
  usePromoteProposal: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null }),
}))
vi.mock('../data/useRealtimeProposals.ts', () => ({
  useRealtimeProposals: () => 'off',
}))
vi.mock('../data/useTasks.ts', () => ({
  useTasks: () => ({ data: TASKS, isLoading: false, error: null, seasonId: 's', refetch: vi.fn() }),
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}))
vi.mock('../data/useRealtimeClauseStatus.ts', () => ({
  useRealtimeClauseStatus: () => 'live',
}))
// The Register also reads linked work and the season's edition.
vi.mock('../data/useRealtimeTasks.ts', () => ({ useRealtimeTasks: () => 'live' }))
vi.mock('../data/useRealtimeTaskRequirements.ts', () => ({ useRealtimeTaskRequirements: () => 'live' }))
vi.mock('../data/useTaskHistory.ts', () => ({
  useTaskRequirements: () => ({ data: [], isLoading: false, error: null }),
  useTasksForProgress: () => ({ data: TASKS, isLoading: false, error: null }),
}))
vi.mock('../season/context.ts', () => ({
  useSeason: () => ({ status: 'ready', seasonId: 's', season: { id: 's', regs_ref: 'ED1' } }),
  useSeasonId: () => 's',
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

beforeEach(() => {
  vi.clearAllMocks()
  metrics.attentionLoading = false
  metrics.attentionError = null
})

describe('Now dashboard', () => {
  it('opens each metric on the list that explains it, already filtered', () => {
    renderApp()
    const href = (id: string) => screen.getByTestId(id).closest('a')?.getAttribute('href')
    expect(href('tile-overdue')).toBe('/priorities?reason=overdue')
    expect(href('tile-blocked')).toBe('/priorities?reason=blocked')
    expect(href('tile-mine')).toBe('/board?scope=mine')
    // Open proposals opens Proposals — never Meetings, a different thing (F14-06).
    expect(href('tile-proposals')).toBe('/proposals')
    expect(href('tile-deadline')).toBe('/milestones')
  })

  it('counts the same overdue tasks in the tile and the list, with owner, department, date and a link', () => {
    renderApp()
    expect(screen.getByTestId('tile-overdue')).toHaveTextContent('1')
    const list = screen.getByTestId('now-overdue')
    expect(list).toHaveTextContent('Late fairing drawing')
    expect(list).toHaveTextContent('Ada Rider · Design Envelope · due 1 Jan 2020')
    expect(within(list).getByRole('link', { name: 'Late fairing drawing' })).toHaveAttribute('href', '/board?task=t-late')
  })

  it('shows loading and unavailable as their own states, never as zero work', () => {
    metrics.attentionLoading = true
    const { unmount } = renderApp()
    expect(screen.getByTestId('tile-overdue')).toHaveTextContent('…')
    expect(screen.getByTestId('tile-blocked')).not.toHaveTextContent('0')
    unmount()
    metrics.attentionLoading = false
    metrics.attentionError = new Error('network down')
    renderApp()
    expect(screen.getByTestId('tile-overdue')).toHaveTextContent('—')
    expect(within(screen.getByTestId('now-blocked')).getByRole('alert')).toHaveTextContent('Could not load this list')
  })

  it('keeps work completion and requirement compliance apart for each department', () => {
    renderApp()
    // GEOM: one of its two tasks is done (work); 1 of 17 rules resolved (compliance).
    expect(screen.getByTestId('department-work-GEOM')).toHaveTextContent('1/2 done')
    expect(screen.getByTestId('department-requirements-GEOM')).toHaveTextContent('1/17 resolved')
    expect(screen.getByTestId('department-work-DOCS')).toHaveTextContent('no tasks yet')
  })

  it('leaves an archived department out of the live overview and totals', () => {
    renderApp()
    expect(screen.queryByTestId('department-OLD')).not.toBeInTheDocument()
    // DOCS 129 + GEOM 17 = 146; the parked RACEOP and the archived OLD are not counted.
    expect(screen.getByTestId('now-obligations')).toHaveTextContent('5 / 146')
  })

  it('has no proposal form on the dashboard, only a way to the Proposals screen', () => {
    renderApp()
    expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Raise a proposal' })).toHaveAttribute('href', '/proposals')
  })

  it('keeps milestone points secondary, with a way to Milestones', () => {
    renderApp()
    expect(screen.getByTestId('now-points')).toHaveTextContent('75 points are available')
    expect(within(screen.getByTestId('now-points')).getByRole('link', { name: 'See Milestones' })).toHaveAttribute('href', '/milestones')
  })
})

describe('department -> Register navigation', () => {
  it('lands on the Register scoped to that department only', async () => {
    renderApp()
    const row = screen.getByTestId('department-GEOM')
    await userEvent.click(within(row).getByText('Design Envelope'))
    await userEvent.click(within(row).getByRole('link', { name: 'Register' }))
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
