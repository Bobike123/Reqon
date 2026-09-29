import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = { id: 'me', status: 'active' as 'active' | 'alumni', roles: [] as string[] }
type Dept = { key: string; name: string; lead_id: string | null; archived_at: string | null }
let departments: Dept[]
let taskRows: Record<string, unknown>[]
let proposalRows: Record<string, unknown>[]
let total = 0
let queries: { kind: string; q: Record<string, unknown> }[]
let restoreError: Error | null
const restored: Record<string, unknown>[] = []

vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: session.id }, member: { id: session.id, status: session.status }, roles: session.roles }),
}))
vi.mock('../data/useMembers.ts', () => ({
  useMembers: () => ({ data: [{ id: 'me', full_name: 'Ada Rider', status: 'active' }, { id: 'gone', full_name: 'Old Timer', status: 'alumni' }], isLoading: false, error: null }),
}))
vi.mock('../data/useSubteams.ts', () => ({ useSubteams: () => ({ data: departments, isLoading: false, error: null }) }))
vi.mock('../data/useTaskHistory.ts', () => ({
  NO_DEPARTMENT: 'none',
  ARCHIVE_PAGE_SIZE: 25,
  useArchivedTasks: (q: Record<string, unknown>) => {
    queries.push({ kind: 'tasks', q })
    return { data: { rows: taskRows, total }, isLoading: false, isFetching: false, error: null, refetch: () => {} }
  },
  useProposalHistory: (q: Record<string, unknown>) => {
    queries.push({ kind: 'proposals', q })
    return { data: { rows: proposalRows, total }, isLoading: false, isFetching: false, error: null, refetch: () => {} }
  },
  useSourceProposals: () => ({ data: new Map([['p-old', { id: 'p-old', title: 'The origin', state: 'decided', outcome: 'approved', archived_at: '2026-09-01' }]]) }),
  useTasksBySource: () => ({ data: new Map([['prop-1', { id: 'task-x', title: 'Resulting task', source_proposal: 'prop-1', archived_at: null }]]) }),
}))
vi.mock('../data/useTasks.ts', () => ({
  useRestoreTask: () => ({
    mutateAsync: async (v: Record<string, unknown>) => {
      if (restoreError) throw restoreError
      restored.push(v)
      return { state: 'todo' }
    },
    isPending: false,
    error: restoreError,
    reset: () => {},
  }),
}))
vi.mock('../data/useActivityHistory.ts', () => ({
  useActivityHistory: () => ({ data: { rows: [] }, isLoading: false, error: null, hasNextPage: false }),
}))
vi.mock('../data/useRealtimeTasks.ts', () => ({ useRealtimeTasks: () => 'live' }))
vi.mock('../data/useRealtimeProposals.ts', () => ({ useRealtimeProposals: () => 'live' }))

const { default: Archive } = await import('./Archive.tsx')

function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.pathname + l.search}</output>
}
function renderArchive(url = '/archive') {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Archive />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const archivedTask = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, state: 'done', priority: 'normal', owner_id: 'me', subteam_key: 'AERO', due_date: '2026-10-01',
  source_proposal: null, archived_at: '2026-09-20T10:00:00Z', archive_reason: 'auto_done_24h', archived_by: null,
  completed_at: '2026-09-19T09:00:00Z', completion_source: 'recorded', ...over,
})

beforeEach(() => {
  session.id = 'me'
  session.status = 'active'
  session.roles = []
  departments = [
    { key: 'AERO', name: 'Aerodynamics', lead_id: 'me', archived_at: null },
    { key: 'OLD', name: 'Retired dept', lead_id: null, archived_at: '2026-01-01' },
  ]
  taskRows = [archivedTask('a1'), archivedTask('a2', { subteam_key: 'OLD', owner_id: 'gone', state: 'cancelled', archive_reason: 'manual', completed_at: null })]
  proposalRows = [
    { id: 'prop-1', title: 'Approved idea', context: null, state: 'decided', outcome: 'approved', archived_at: '2026-09-10T10:00:00Z', archive_reason: 'promoted', decided_at: '2026-09-10T10:00:00Z', subteam_key: 'OLD', owner_id: null, due_date: null, decision: 'Go' },
    { id: 'prop-2', title: 'Rejected idea', context: 'why', state: 'decided', outcome: 'rejected', archived_at: '2026-09-11T10:00:00Z', archive_reason: 'rejected', decided_at: '2026-09-11T10:00:00Z', subteam_key: 'AERO', owner_id: 'me', due_date: '2026-12-01', decision: null },
  ]
  total = 2
  queries = []
  restoreError = null
  restored.length = 0
})

const last = (kind: string) => queries.filter((x) => x.kind === kind).at(-1)!

describe('archived tasks', () => {
  it('lists them with department (archived ones still named), owner, state, reason and timestamps', () => {
    renderArchive()
    const row = screen.getByTestId('archived-task-a1')
    expect(row).toHaveTextContent('Aerodynamics')
    expect(row).toHaveTextContent('Ada Rider')
    expect(row).toHaveTextContent('Done when archived')
    expect(screen.getByTestId('archived-when-a1')).toHaveTextContent('Archived automatically (done for 24h+)')
    expect(screen.getByTestId('archived-when-a1')).toHaveTextContent('Completed')
    expect(screen.getByTestId('archived-task-a2')).toHaveTextContent('Retired dept')
    expect(screen.getByTestId('archived-when-a2')).toHaveTextContent('Archived manually')
  })

  it('links a promoted task to the proposal it came from', () => {
    taskRows = [archivedTask('a1', { source_proposal: 'p-old' })]
    renderArchive()
    const link = within(screen.getByTestId('archived-source-a1')).getByRole('link')
    expect(link).toHaveTextContent('The origin')
    expect(link).toHaveAttribute('href', '/archive?tab=proposals&id=p-old')
  })

  it('never lets an archived row be edited, and offers no delete', () => {
    renderArchive()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Move .* to another lane/)).not.toBeInTheDocument()
  })
})

describe('reading needs no write privilege; restoring needs the right one', () => {
  it('a plain member reads everything and sees no Restore button', () => {
    departments = departments.map((d) => ({ ...d, lead_id: null }))
    renderArchive()
    expect(screen.getByTestId('archived-task-a1')).toBeInTheDocument()
    expect(screen.queryByTestId('restore-a1')).not.toBeInTheDocument()
  })

  it('the department Head can restore their department\'s task, not another\'s', () => {
    renderArchive()
    expect(screen.getByTestId('restore-a1')).toBeInTheDocument() // AERO, headed by me
    expect(screen.queryByTestId('restore-a2')).not.toBeInTheDocument() // OLD, nobody's
  })

  it('a Developer can restore anything', () => {
    departments = departments.map((d) => ({ ...d, lead_id: null }))
    session.roles = ['developer']
    renderArchive()
    expect(screen.getByTestId('restore-a1')).toBeInTheDocument()
    expect(screen.getByTestId('restore-a2')).toBeInTheDocument()
  })

  it('a retired member can read but never restore', () => {
    session.status = 'alumni'
    session.roles = ['developer']
    renderArchive()
    expect(screen.getByTestId('archived-task-a1')).toBeInTheDocument()
    expect(screen.queryByTestId('restore-a1')).not.toBeInTheDocument()
  })

  it('explains that restoring a finished task reopens it and keeps its history, then restores', async () => {
    const user = userEvent.setup()
    renderArchive()
    await user.click(screen.getByTestId('restore-a1'))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/Restore “Task a1”\?/)).toBeInTheDocument()
    expect(dialog.getByText(/reopens it: it goes back to the Board in To do/)).toBeInTheDocument()
    expect(dialog.getByText(/Its history is kept/)).toBeInTheDocument()
    expect(restored).toEqual([])
    await user.click(dialog.getByTestId('restore-confirm'))
    await waitFor(() => expect(restored).toEqual([{ id: 'a1' }]))
    expect(await screen.findByTestId('archive-message')).toHaveTextContent('reopened')
  })

  it('shows a refusal from the database in the dialog and keeps it open', async () => {
    const user = userEvent.setup()
    restoreError = new Error("You don't have permission to restore that task.")
    renderArchive()
    await user.click(screen.getByTestId('restore-a1'))
    await user.click(await screen.findByTestId('restore-confirm'))
    expect(await screen.findByText(/permission to restore/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(restored).toEqual([])
  })
})

describe('proposal history', () => {
  it('shows outcome, reason, time and the task an approved proposal produced', async () => {
    const user = userEvent.setup()
    renderArchive()
    await user.click(screen.getByRole('button', { name: 'Proposal history' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/archive?tab=proposals')
    expect(screen.getByTestId('history-status-prop-1')).toHaveTextContent('Approved')
    expect(screen.getByTestId('history-status-prop-2')).toHaveTextContent('Rejected')
    expect(screen.getByTestId('history-proposal-prop-1')).toHaveTextContent('Retired dept')
    expect(screen.getByTestId('history-proposal-prop-1')).toHaveTextContent('Approved and turned into a task')
    const task = within(screen.getByTestId('history-task-prop-1')).getByRole('link')
    expect(task).toHaveAttribute('href', '/board')
    expect(screen.getByTestId('history-proposal-prop-2')).toHaveTextContent('Rejected')
  })
})

describe('filters and pages live in the address', () => {
  it('sends the address\'s filters to the query and shows them', () => {
    renderArchive('/archive?dept=AERO&owner=me&state=done&q=wing&page=2')
    expect(last('tasks')).toEqual({ kind: 'tasks', q: { department: 'AERO', owner: 'me', state: 'done', search: 'wing', id: '', page: 1 } })
    expect(screen.getByLabelText('Department')).toHaveValue('AERO')
    expect(screen.getByLabelText('Search titles')).toHaveValue('wing')
  })

  it('changing a filter updates the address and goes back to the first page', async () => {
    const user = userEvent.setup()
    renderArchive('/archive?page=3')
    await user.selectOptions(screen.getByLabelText('Department'), 'OLD')
    expect(screen.getByTestId('where')).toHaveTextContent('/archive?dept=OLD')
    expect(screen.getByTestId('where')).not.toHaveTextContent('page=')
  })

  it('searches on submit, not on every keystroke', async () => {
    const user = userEvent.setup()
    renderArchive()
    await user.type(screen.getByLabelText('Search titles'), 'fairing')
    // Typing changes only the box; the query the page asks for is unchanged.
    expect(queries.filter((x) => x.kind === 'tasks').every((x) => x.q.search === '')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getByTestId('where')).toHaveTextContent('q=fairing')
  })

  it('lists every department including archived ones, and a "no department" choice', () => {
    renderArchive()
    const options = within(screen.getByLabelText('Department')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['All departments', 'No department (older work)', 'Aerodynamics', 'Retired dept (archived)'])
  })

  it('pages through a long history and disables the ends', async () => {
    const user = userEvent.setup()
    total = 60
    renderArchive()
    expect(screen.getByTestId('archive-page')).toHaveTextContent('Page 1 of 3')
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('where')).toHaveTextContent('page=2')
    expect(screen.getByTestId('archive-summary')).toHaveTextContent('60 items · page 2 of 3')
  })

  it('does not trust a bad address: unknown tab, status and page fall back and say so', () => {
    renderArchive('/archive?tab=secrets&state=urgent&page=-1')
    expect(screen.getByTestId('archive-notice')).toBeInTheDocument()
    expect(last('tasks')).toMatchObject({ kind: 'tasks', q: { state: '', page: 0 } })
  })

  it('says nothing matches, and Clear filters resets them', async () => {
    const user = userEvent.setup()
    taskRows = []
    total = 0
    renderArchive('/archive?q=nothing')
    expect(screen.getByTestId('archive-empty')).toHaveTextContent('Nothing in the archive matches these filters')
    await user.click(within(screen.getByTestId('archive-summary')).getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/archive')
    expect(screen.getByTestId('where')).not.toHaveTextContent('q=')
  })

  it('shows one item for a provenance link (?id=) and says the list is filtered', () => {
    renderArchive('/archive?tab=proposals&id=prop-1')
    expect(last('proposals')).toMatchObject({ kind: 'proposals', q: { id: 'prop-1' } })
    expect(screen.getByTestId('archive-summary')).toHaveTextContent('match these filters')
  })
})
