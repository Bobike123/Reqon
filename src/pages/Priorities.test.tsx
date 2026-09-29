import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  attention: [] as Record<string, unknown>[],
  clauseWrites: [] as Record<string, unknown>[],
  taskWrites: [] as Record<string, unknown>[],
}

vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1', status: 'active' }, roles: [] }),
}))
vi.mock('../data/useNowMetrics.ts', () => ({
  useAttention: () => ({ data: state.attention, isLoading: false, error: null }),
  useSubteamProgress: () => ({ data: [], isLoading: false, error: null }),
}))
vi.mock('../data/useMembers.ts', () => ({
  useMembers: () => ({
    data: [
      { id: 'm1', full_name: 'Ada Rider', status: 'active' },
      { id: 'm2', full_name: 'Bo Wrench', status: 'active' },
    ],
    isLoading: false,
    error: null,
  }),
}))
vi.mock('../data/useClauseStatus.ts', () => ({
  useSetClauseStatus: () => ({
    mutate: (v: Record<string, unknown>) => state.clauseWrites.push(v),
    error: null,
  }),
}))
vi.mock('../data/useRealtimeTasks.ts', () => ({ useRealtimeTasks: () => 'live' }))
vi.mock('../data/useRealtimeClauseStatus.ts', () => ({ useRealtimeClauseStatus: () => 'live' }))
// m1 heads Aerodynamics only. task-1 is in it; task-2 belongs to Bodywork (another
// Head's), so m1 may not reassign it however the row got onto this list.
vi.mock('../data/useSubteams.ts', () => ({
  useSubteams: () => ({
    data: [
      { key: 'AERO', name: 'Aerodynamics', lead_id: 'm1', archived_at: null },
      { key: 'BODY', name: 'Bodywork', lead_id: 'm3', archived_at: null },
    ],
    isLoading: false,
    error: null,
  }),
}))
vi.mock('../data/useTasks.ts', () => ({
  useTasks: () => ({
    data: [
      { id: 'task-1', owner_id: null, subteam_key: 'AERO', archived_at: null },
      { id: 'task-2', owner_id: 'm2', subteam_key: 'BODY', archived_at: null },
    ],
    isLoading: false,
    error: null,
    seasonId: 's',
  }),
  useUpdateTask: () => ({
    mutate: (v: Record<string, unknown>) => state.taskWrites.push(v),
    error: null,
  }),
}))

const { default: Priorities } = await import('./Priorities.tsx')

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Priorities />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.attention = []
  state.clauseWrites = []
  state.taskWrites = []
})

describe('empty state', () => {
  it('says what to do next rather than showing a blank list', () => {
    renderPage()
    expect(screen.getByText('Nothing is biting right now.')).toBeInTheDocument()
    expect(screen.getByText(/Star a rule in the/)).toBeInTheDocument()
  })
})

describe('the list', () => {
  beforeEach(() => {
    state.attention = [
      { kind: 'clause', ref: 'B.2.1.2', title: 'Fairing rule', owner_id: null, reason: 'blocked', starred: false, clause_key: 'B.2.1.2', season_id: 's' },
      { kind: 'task', ref: 'task-1', title: 'Order material', owner_id: null, reason: 'overdue', starred: false, clause_key: null, season_id: 's' },
      { kind: 'task', ref: 'task-2', title: 'Mould the fairing', owner_id: 'm2', reason: 'urgent', starred: false, clause_key: null, season_id: 's' },
      { kind: 'clause', ref: 'A.1.4.5', title: 'Penalty rule', owner_id: 'm2', reason: 'penalty', starred: true, clause_key: 'A.1.4.5', season_id: 's' },
    ]
  })

  it('shows the reason supplied by the view, not one computed here', () => {
    renderPage()
    expect(within(document.querySelector('[data-tutorial="priorities-list"]') as HTMLElement).getByText('blocked')).toBeInTheDocument()
    expect(within(document.querySelector('[data-tutorial="priorities-list"]') as HTMLElement).getByText('overdue')).toBeInTheDocument()
    expect(within(document.querySelector('[data-tutorial="priorities-list"]') as HTMLElement).getByText('urgent')).toBeInTheDocument()
    expect(within(document.querySelector('[data-tutorial="priorities-list"]') as HTMLElement).getByText('penalty')).toBeInTheDocument()
  })

  it('orders the most urgent reasons first', () => {
    renderPage()
    const badges = screen.getAllByTitle(/Waiting on|Past its due date|Marked as urgent|Risks MP/)
    expect(badges.map((b) => b.textContent)).toEqual(['blocked', 'overdue', 'urgent', 'penalty'])
  })

  it('assigns an owner on a clause row using clause_key', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('Owner', { selector: '#owner-B\\.2\\.1\\.2' }), 'm2')
    await waitFor(() => expect(state.clauseWrites).toHaveLength(1))
    expect(state.clauseWrites[0]).toEqual({ clauseKey: 'B.2.1.2', ownerId: 'm2' })
    expect(state.taskWrites).toHaveLength(0)
  })

  it('assigns an owner on a task row using the task id', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('Owner', { selector: '#owner-task-1' }), 'm1')
    await waitFor(() => expect(state.taskWrites).toHaveLength(1))
    expect(state.taskWrites[0]).toEqual({ id: 'task-1', ownerId: 'm1' })
    expect(state.clauseWrites).toHaveLength(0)
  })

  it('clears an owner back to unassigned', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('Owner', { selector: '#owner-A\\.1\\.4\\.5' }), '')
    await waitFor(() => expect(state.clauseWrites).toHaveLength(1))
    expect(state.clauseWrites[0]).toEqual({ clauseKey: 'A.1.4.5', ownerId: null })
  })

  it('gives every owner control an accessible name', () => {
    renderPage()
    // Three rows may be reassigned by this viewer; the fourth is read-only.
    expect(screen.getAllByLabelText('Owner')).toHaveLength(3)
  })

  it('offers no owner control for another department\'s task, and names the owner instead', () => {
    renderPage()
    expect(screen.queryByLabelText('Owner', { selector: '#owner-task-2' })).not.toBeInTheDocument()
    expect(screen.getByTestId('owner-readonly-task-2')).toHaveTextContent('Owner: Bo Wrench')
    expect(state.taskWrites).toHaveLength(0)
  })
})
