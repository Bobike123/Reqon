import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Board composed for real (filters, lanes, cards, details editor) over mocked
// DATA hooks. Who may do what is decided by the real permission functions from the
// mocked session and the mocked departments' Heads, never by a flag in the test.

const session = { id: 'me', status: 'active' as 'active' | 'alumni', roles: [] as string[] }
const state = {
  tasks: [] as Record<string, unknown>[],
  writes: [] as Record<string, unknown>[],
  archives: [] as Record<string, unknown>[],
  updateError: null as Error | null,
  loading: false,
  loadError: null as Error | null,
  links: [] as { task_id: string; depends_on_task_id: string }[],
  linkWrites: [] as Record<string, unknown>[],
  linkError: null as Error | null,
  moves: [] as Record<string, unknown>[],
}
type Dept = { key: string; name: string; lead_id: string | null; archived_at: string | null }
let departments: Dept[]

vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: session.id }, member: { id: session.id, status: session.status }, roles: session.roles }),
}))
vi.mock('../data/useMembers.ts', () => ({
  useMembers: () => ({
    data: [
      { id: 'me', full_name: 'Ada Rider', status: 'active' },
      { id: 'm2', full_name: 'Bo Wrench', status: 'active' },
      { id: 'gone', full_name: 'Old Timer', status: 'alumni' },
    ],
    isLoading: false, error: null, refetch: () => {},
  }),
}))
vi.mock('../data/useSubteams.ts', () => ({ useSubteams: () => ({ data: departments, isLoading: false, error: null, refetch: () => {} }) }))
vi.mock('../data/useMilestones.ts', () => ({ useMilestones: () => ({ data: [{ key: 'MS1', name: 'Plan' }], isLoading: false, error: null }) }))
vi.mock('../data/useClauses.ts', () => ({
  useClauses: () => ({ data: [{ clause_key: 'A.1', printed_ref: 'A.1', body: 'Rule', section: 'A', article: 1, article_title: null }], isLoading: false, error: null }),
}))
vi.mock('../data/useRealtimeTasks.ts', () => ({ useRealtimeTasks: () => 'live' }))
vi.mock('../data/useRealtimeTaskRequirements.ts', () => ({ useRealtimeTaskRequirements: () => 'live' }))
vi.mock('../data/useRealtimeTaskDependencies.ts', () => ({ useRealtimeTaskDependencies: () => 'live' }))
vi.mock('../data/useTaskDependencies.ts', () => ({
  useTaskDependencies: () => ({ data: state.links }),
  useAddTaskDependency: () => ({ mutate: (v: Record<string, unknown>, o?: { onSuccess?: () => void }) => { state.linkWrites.push({ add: v }); o?.onSuccess?.() }, isPending: false, error: state.linkError, reset: () => {} }),
  useRemoveTaskDependency: () => ({ mutate: (v: Record<string, unknown>) => state.linkWrites.push({ remove: v }), isPending: false, error: null, reset: () => {} }),
}))
vi.mock('../data/useTaskHistory.ts', () => ({
  useTaskRequirements: () => ({ data: [{ task_id: 'aero-mine', clause_key: 'A.1' }, { task_id: 'aero-mine', clause_key: 'A.2' }] }),
  // Archived tasks (for naming a finished prerequisite): one archived task that a link points at.
  useTasksForProgress: () => ({ data: [{ id: 'gone-task', title: 'Finished weeks ago', state: 'done', archived_at: '2026-09-01', subteam_key: 'MECH' }], isLoading: false, error: null }),
  useSourceProposals: () => ({ data: new Map([['prop-archived', { id: 'prop-archived', title: 'Old proposal', state: 'decided', outcome: 'approved', archived_at: '2026-09-01' }]]) }),
}))
vi.mock('../data/useTasks.ts', () => ({
  useTasks: () => ({ data: state.tasks, isLoading: state.loading, error: state.loadError, refetch: () => {}, seasonId: 's' }),
  useUpdateTask: () => ({
    mutate: (v: Record<string, unknown>) => state.writes.push(v),
    mutateAsync: async (v: Record<string, unknown>) => {
      if (state.updateError) throw state.updateError
      state.writes.push(v)
    },
    isPending: false,
    isError: Boolean(state.updateError),
    error: state.updateError,
  }),
  useArchiveTask: () => ({ mutateAsync: async (v: Record<string, unknown>) => state.archives.push(v), isPending: false }),
  useSetTaskDepartment: () => ({
    mutate: (v: Record<string, unknown>, o?: { onSuccess?: () => void }) => { state.moves.push(v); o?.onSuccess?.() },
    isPending: false,
    error: null,
  }),
  useLinkTaskRequirement: () => ({ mutateAsync: vi.fn() }),
  useUnlinkTaskRequirement: () => ({ mutateAsync: vi.fn() }),
}))

const { default: Board } = await import('./Board.tsx')

function task(id: string, over: Record<string, unknown> = {}) {
  return {
    id, season_id: 's', title: id, detail: null, state: 'todo', priority: 'normal', owner_id: null, subteam_key: 'AERO',
    due_date: '2026-12-01', starts_on: null, starred: false, source_proposal: null, created_by: null, created_at: '',
    updated_at: '2026-09-01T00:00:00Z', section_id: null, milestone_key: 'MS1', links_required: false,
    completed_at: null, completion_source: null, archived_at: null, archived_by: null, archive_reason: null,
    blocked_reason: null, blocked_since: null, ...over,
  }
}

function renderBoard(url = '/board') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Board />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const shown = () => Array.from(document.querySelectorAll('[data-task-state]')).map((el) => el.getAttribute('data-testid')!.replace('task-', '')).sort()

beforeEach(() => {
  session.id = 'me'
  session.status = 'active'
  session.roles = []
  departments = [
    { key: 'AERO', name: 'Aerodynamics', lead_id: 'me', archived_at: null },
    { key: 'BODY', name: 'Bodywork', lead_id: 'm2', archived_at: null },
    { key: 'OLD', name: 'Retired dept', lead_id: null, archived_at: '2026-01-01' },
  ]
  state.writes = []
  state.archives = []
  state.updateError = null
  state.loading = false
  state.loadError = null
  state.links = []
  state.linkWrites = []
  state.linkError = null
  state.moves = []
  state.tasks = [
    task('aero-mine', { owner_id: 'me', title: 'Aero mine' }),
    task('aero-theirs', { owner_id: 'm2', title: 'Aero theirs' }),
    task('body-mine', { owner_id: 'me', subteam_key: 'BODY', title: 'Body mine' }),
    task('body-theirs', { owner_id: 'm2', subteam_key: 'BODY', title: 'Body theirs' }),
  ]
})

describe('Scope x Department (independent filters, no tab per combination)', () => {
  it('shows every active task by default', () => {
    renderBoard()
    expect(shown()).toEqual(['aero-mine', 'aero-theirs', 'body-mine', 'body-theirs'])
    expect(screen.getByTestId('board-filter-summary')).toHaveTextContent('Showing 4 of 4 active tasks')
  })

  it.each([
    ['All tasks', '', ['aero-mine', 'aero-theirs', 'body-mine', 'body-theirs']],
    ['My tasks', '', ['aero-mine', 'body-mine']],
    ['All tasks', 'AERO', ['aero-mine', 'aero-theirs']],
    ['All tasks', 'BODY', ['body-mine', 'body-theirs']],
    ['My tasks', 'AERO', ['aero-mine']],
    ['My tasks', 'BODY', ['body-mine']],
  ])('%s + department "%s"', async (scope, dept, expected) => {
    const user = userEvent.setup()
    renderBoard()
    await user.click(within(screen.getByTestId('board-scope')).getByRole('button', { name: new RegExp(scope) }))
    if (dept) await user.selectOptions(screen.getByLabelText('Department'), dept)
    expect(shown()).toEqual([...expected])
  })

  it('counts each scope under the chosen department', async () => {
    const user = userEvent.setup()
    renderBoard()
    await user.selectOptions(screen.getByLabelText('Department'), 'BODY')
    const scope = screen.getByTestId('board-scope')
    expect(within(scope).getByRole('button', { name: /All tasks \(2\)/ })).toBeInTheDocument()
    expect(within(scope).getByRole('button', { name: /My tasks \(1\)/ })).toBeInTheDocument()
  })

  it('offers only active departments, and says so when nothing matches, with a way back', async () => {
    const user = userEvent.setup()
    state.tasks = [task('t1', { owner_id: 'm2' })]
    renderBoard()
    // The department navigation shows each entry's task count beside its name.
    expect(within(screen.getByLabelText('Department')).getAllByRole('option').map((o) => o.textContent?.replace(/ \(\d+\)$/, ''))).toEqual(['All departments', 'Aerodynamics', 'Bodywork'])
    await user.click(screen.getByRole('button', { name: /My tasks/ }))
    expect(screen.getByTestId('board-no-match')).toHaveTextContent('No tasks match these filters')
    await user.click(within(screen.getByTestId('board-no-match')).getByRole('button', { name: 'Clear filters' }))
    expect(shown()).toEqual(['t1'])
  })
})

describe('filters in the address', () => {
  it('reads scope and department from the URL', () => {
    renderBoard('/board?scope=mine&dept=AERO')
    expect(shown()).toEqual(['aero-mine'])
    expect(screen.getByLabelText('Department')).toHaveValue('AERO')
  })

  it('does not silently honour an unknown department: it shows everything and says so', () => {
    renderBoard('/board?dept=DELETED')
    expect(shown()).toHaveLength(4)
    expect(screen.getByTestId('board-filter-notice')).toHaveTextContent('There is no department “DELETED”')
  })

  it('does not silently honour an unknown scope either', () => {
    renderBoard('/board?scope=everyone')
    expect(shown()).toHaveLength(4)
    expect(screen.getByTestId('board-filter-notice')).toHaveTextContent('not a view of the Board')
  })

  it('keeps a selected department that has since been archived, marked, instead of dropping the filter', () => {
    state.tasks = [task('old-done', { subteam_key: 'OLD', state: 'done' })]
    renderBoard('/board?dept=OLD')
    expect(shown()).toEqual(['old-done'])
    expect(within(screen.getByLabelText('Department')).getByRole('option', { name: /^Retired dept \(archived\)/ })).toBeInTheDocument()
    expect(screen.queryByTestId('board-filter-notice')).not.toBeInTheDocument()
  })
})

describe('lanes, priority and card facts', () => {
  it('has exactly the five workflow lanes and no urgent lane', () => {
    renderBoard()
    for (const lane of ['todo', 'wip', 'blocked', 'done', 'cancelled']) expect(screen.getByTestId(`lane-${lane}`)).toBeInTheDocument()
    expect(screen.queryByTestId('lane-urgent')).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-testid^="lane-"]')).toHaveLength(5)
  })

  it('shows urgency as a badge in the task\'s own lane, so a task can be Blocked AND Urgent', () => {
    state.tasks = [task('hot', { state: 'blocked', priority: 'urgent' }), task('calm', { state: 'blocked' })]
    renderBoard()
    const lane = screen.getByTestId('lane-blocked')
    expect(within(within(lane).getByTestId('task-hot')).getByText('Urgent')).toBeInTheDocument()
    expect(within(within(lane).getByTestId('task-calm')).queryByText('Urgent')).not.toBeInTheDocument()
  })

  it('exposes department, owner, deadline, milestone, requirement count and state on the card', () => {
    renderBoard()
    const facts = screen.getByTestId('task-facts-aero-mine')
    expect(facts).toHaveTextContent('To do')
    expect(facts).toHaveTextContent('Aerodynamics')
    expect(facts).toHaveTextContent('Ada Rider')
    expect(facts).toHaveTextContent('Due 1 Dec 2026')
    expect(facts).toHaveTextContent('MS1 — Plan')
    expect(screen.getByTestId('task-reqs-aero-mine')).toHaveTextContent('2 requirements')
  })

  it('shows missing legacy values as missing, never invented', () => {
    state.tasks = [task('legacy', { subteam_key: null, owner_id: null, due_date: null, milestone_key: null })]
    renderBoard()
    const facts = screen.getByTestId('task-facts-legacy')
    for (const text of ['No department', 'Unassigned', 'No deadline', 'No milestone', 'No requirements linked']) expect(facts).toHaveTextContent(text)
  })

  it('marks an overdue open task, but not a finished one', () => {
    state.tasks = [task('late', { due_date: '2020-01-01' }), task('finished', { due_date: '2020-01-01', state: 'done' })]
    renderBoard()
    expect(screen.getByTestId('task-facts-late')).toHaveTextContent('overdue')
    expect(screen.getByTestId('task-facts-finished')).not.toHaveTextContent('overdue')
  })

  it('keeps provenance visible with a link, even when its proposal is archived', () => {
    state.tasks = [task('promoted', { source_proposal: 'prop-archived' })]
    renderBoard()
    const origin = screen.getByTestId('task-origin-promoted')
    expect(origin).toHaveTextContent('From proposal: “Old proposal”')
    expect(within(origin).getByRole('link')).toHaveAttribute('href', '/archive?tab=proposals&id=prop-archived')
    expect(screen.getByTestId('task-promoted')).toHaveAttribute('data-source-proposal', 'prop-archived')
  })
})

describe('who may change what (one contextual permission model)', () => {
  const moveSelect = (id: string) => screen.queryByLabelText(`Move ${id} to another lane`)

  it('the owner moves their own task; everyone else\'s is read-only', () => {
    renderBoard('/board?dept=BODY') // "me" heads AERO only, so BODY is not theirs except what they own
    expect(moveSelect('Body mine')).toBeInTheDocument()
    expect(moveSelect('Body theirs')).not.toBeInTheDocument()
  })

  it('a Head moves any task of their department, including ones they do not own', () => {
    renderBoard('/board?dept=AERO')
    expect(moveSelect('Aero theirs')).toBeInTheDocument()
  })

  it('a Developer\'s override is explicit: they may edit everything', () => {
    departments = departments.map((d) => ({ ...d, lead_id: null }))
    session.roles = ['developer']
    renderBoard()
    for (const title of ['Aero mine', 'Aero theirs', 'Body mine', 'Body theirs']) expect(moveSelect(title)).toBeInTheDocument()
  })

  // Backend completion Phase 2 (PERMISSIONS.md §3.3): the President/VP act for a
  // department only when it has no Head. With a Head in place they edit nothing
  // they do not own.
  // Role hierarchy (20260130000000): the President and the Vice President rank above every Head, so they
  // edit every department's tasks even where a Head exists. The Treasurer alone still edits only their own.
  it('the President and the Vice President edit every department\'s tasks, even where a Head exists', () => {
    departments = departments.map((d) => ({ ...d, lead_id: 'm2' }))
    for (const role of ['president', 'vicepresident']) {
      session.roles = [role]
      const { unmount } = renderBoard()
      expect(moveSelect('Aero theirs'), role).toBeInTheDocument()
      expect(moveSelect('Body theirs'), role).toBeInTheDocument()
      unmount()
    }
  })

  it('the Treasurer alone edits nothing they do not own', () => {
    departments = departments.map((d) => ({ ...d, lead_id: 'm2' }))
    session.roles = ['treasurer']
    renderBoard()
    expect(moveSelect('Aero theirs')).not.toBeInTheDocument()
    expect(moveSelect('Aero mine')).toBeInTheDocument() // owner of it
  })

  it('the President acts for a department that has no Head (governance fallback)', () => {
    departments = departments.map((d) => ({ ...d, lead_id: null }))
    session.roles = ['president']
    renderBoard()
    expect(moveSelect('Aero theirs')).toBeInTheDocument()
  })

  it('a retired member gets no controls at all', () => {
    session.status = 'alumni'
    renderBoard()
    expect(document.querySelectorAll('select[id^="task-state-"]')).toHaveLength(0)
  })

  it('moves a task with the select, sending only the state', async () => {
    const user = userEvent.setup()
    renderBoard()
    await user.selectOptions(screen.getByLabelText('Move Aero theirs to another lane'), 'wip')
    expect(state.writes).toEqual([{ id: 'aero-theirs', state: 'wip' }])
  })

  it('shows a refusal from the server instead of pretending the move worked', () => {
    state.updateError = new Error("You don't have permission to change that task.")
    renderBoard()
    expect(screen.getByRole('alert')).toHaveTextContent("You don't have permission to change that task.")
  })

  it('never offers a delete control, anywhere', () => {
    renderBoard()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })
})

describe('the details editor', () => {
  async function open(id: string, user = userEvent.setup()) {
    await user.click(within(screen.getByTestId(`task-more-${id}`)).getByText(/^Details/))
    return { user, panel: within(await screen.findByTestId(`task-details-${id}`)) }
  }

  it('opens a native, focusable disclosure that holds the long description, links and editor', async () => {
    const user = userEvent.setup()
    state.tasks = [task('long', { owner_id: 'me', detail: 'A long description of the work.', source_proposal: 'prop-archived' })]
    renderBoard()
    // A native <summary> is in the tab order and opens on Enter/Space in a
    // browser (jsdom does not model that; it is checked in a real browser).
    const summary = within(screen.getByTestId('task-more-long')).getByText(/^Details/)
    expect(summary.tagName).toBe('SUMMARY')
    await user.click(summary)
    const panel = within(await screen.findByTestId('task-details-long'))
    expect(panel.getByLabelText('Description')).toHaveValue('A long description of the work.')
    expect(panel.getByTestId('task-source-long')).toHaveTextContent('Created from the proposal “Old proposal”')
  })

  it('lets a Head reassign the owner and saves ONLY the changed fields', async () => {
    const { user, panel } = await (async () => { renderBoard('/board?dept=AERO'); return open('aero-theirs') })()
    await user.selectOptions(panel.getByLabelText('Owner'), 'me')
    await user.click(panel.getByTestId('task-save-aero-theirs'))
    expect(state.writes).toEqual([{ id: 'aero-theirs', ownerId: 'me' }])
  })

  it('lets an owner edit their fields but not reassign, and says who can', async () => {
    renderBoard('/board?dept=BODY')
    const { panel } = await open('body-mine')
    expect(panel.getByLabelText('Deadline')).toBeInTheDocument()
    expect(panel.queryByRole('combobox', { name: 'Owner' })).not.toBeInTheDocument()
    expect(panel.getByText(/only the department Head can reassign/)).toBeInTheDocument()
  })

  it('shows the same facts read-only, with the reason, to someone who may not edit', async () => {
    renderBoard('/board?dept=BODY')
    const { panel } = await open('body-theirs')
    expect(panel.getByTestId('task-readonly-body-theirs')).toHaveTextContent('Read-only for you')
    expect(panel.queryByTestId('task-save-body-theirs')).not.toBeInTheDocument()
  })

  it('reports a server refusal inside the editor and keeps what was typed', async () => {
    state.updateError = new Error("You don't have permission to update task.")
    renderBoard('/board?dept=AERO')
    const { user, panel } = await open('aero-theirs')
    await user.selectOptions(panel.getByLabelText('Priority'), 'urgent')
    await user.click(panel.getByTestId('task-save-aero-theirs'))
    expect(await panel.findByText(/permission to update task/)).toBeInTheDocument()
    expect(panel.getByLabelText('Priority')).toHaveValue('urgent')
  })

  it('tells someone their access ended while the editor was open, and keeps their text', async () => {
    const user = userEvent.setup()
    const { rerender } = renderBoard('/board?dept=AERO')
    const { panel } = await open('aero-theirs', user)
    await user.type(panel.getByLabelText('Description'), 'half-typed note')
    // The Head of Aerodynamics changes; "me" no longer heads it and does not own the task.
    departments = departments.map((d) => (d.key === 'AERO' ? { ...d, lead_id: 'm2' } : d))
    const qc = new QueryClient()
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/board?dept=AERO']}>
          <Board />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByTestId('task-lost-access')).toHaveTextContent('You can no longer change this task')
    expect(screen.queryByTestId('task-save-aero-theirs')).not.toBeInTheDocument()
  })

  it('tells someone else changed the task while it was open', async () => {
    const user = userEvent.setup()
    const { rerender } = renderBoard('/board?dept=AERO')
    await open('aero-theirs', user)
    state.tasks = state.tasks.map((t) => (t.id === 'aero-theirs' ? { ...t, updated_at: '2026-09-24T12:00:00Z', title: 'Renamed by someone' } : t))
    const qc = new QueryClient()
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/board?dept=AERO']}>
          <Board />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByTestId('task-changed-elsewhere')).toHaveTextContent('Someone else changed this task')
  })

  // F6-06: a requirement-only save does not move the task's version, so marking it as "our own save"
  // left the flag set, and the next change by someone else silently replaced what the person was typing.
  it('after a requirements-only save, a later change by someone else still keeps the typing and says so', async () => {
    const user = userEvent.setup()
    const { rerender } = renderBoard('/board?dept=AERO')
    const { panel } = await open('aero-mine', user)
    await user.click(panel.getByRole('button', { name: 'Remove requirement A.2' }))
    await user.click(panel.getByTestId('task-save-aero-mine'))
    expect(state.writes).toEqual([]) // links only: no task write, so no new version
    await user.clear(panel.getByLabelText('Title'))
    await user.type(panel.getByLabelText('Title'), 'My unsaved title')
    state.tasks = state.tasks.map((t) => (t.id === 'aero-mine' ? { ...t, updated_at: '2026-09-24T12:00:00Z', title: 'Renamed by someone' } : t))
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/board?dept=AERO']}>
          <Board />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByTestId('task-changed-elsewhere')).toBeInTheDocument()
    expect(panel.getByLabelText('Title')).toHaveValue('My unsaved title')
  })
})

describe('blockers and prerequisites', () => {
  async function open(id: string, user = userEvent.setup()) {
    await user.click(within(screen.getByTestId(`task-more-${id}`)).getByText(/^Details/))
    return { user, panel: within(await screen.findByTestId(`task-details-${id}`)) }
  }

  it('asks why before blocking a task with no prerequisite, and sends the reason with the state', async () => {
    const user = userEvent.setup()
    renderBoard('/board?dept=AERO')
    await user.selectOptions(screen.getByLabelText('Move Aero theirs to another lane'), 'blocked')
    expect(state.writes).toEqual([]) // nothing is sent until a reason is given
    const form = within(screen.getByTestId('task-block-form-aero-theirs'))
    expect(form.getByRole('button', { name: 'Block task' })).toBeDisabled()
    await user.type(form.getByLabelText(/Why is/), '  Waiting for the sponsor quote ')
    await user.click(form.getByRole('button', { name: 'Block task' }))
    expect(state.writes).toEqual([{ id: 'aero-theirs', state: 'blocked', blockedReason: 'Waiting for the sponsor quote' }])
  })

  it('cancelling the question sends nothing and leaves the card where it was', async () => {
    const user = userEvent.setup()
    renderBoard('/board?dept=AERO')
    await user.selectOptions(screen.getByLabelText('Move Aero theirs to another lane'), 'blocked')
    await user.click(within(screen.getByTestId('task-block-form-aero-theirs')).getByRole('button', { name: 'Cancel' }))
    expect(state.writes).toEqual([])
    expect(screen.queryByTestId('task-block-form-aero-theirs')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-aero-theirs')).toHaveAttribute('data-task-state', 'todo')
  })

  it('blocks straight away when a prerequisite already explains it', async () => {
    const user = userEvent.setup()
    state.links = [{ task_id: 'aero-theirs', depends_on_task_id: 'body-theirs' }]
    renderBoard('/board?dept=AERO')
    await user.selectOptions(screen.getByLabelText('Move Aero theirs to another lane'), 'blocked')
    expect(state.writes).toEqual([{ id: 'aero-theirs', state: 'blocked' }])
  })

  it('shows the written reason on a blocked card, or what it waits for, or says none was kept', () => {
    state.tasks = [
      task('with-reason', { state: 'blocked', blocked_reason: 'Waiting for the quote', subteam_key: 'AERO', owner_id: 'me' }),
      task('with-link', { state: 'blocked', subteam_key: 'AERO', owner_id: 'me' }),
      task('legacy', { state: 'blocked', subteam_key: 'AERO', owner_id: 'me' }),
      task('prereq', { subteam_key: 'BODY', owner_id: 'm2' }),
    ]
    state.links = [{ task_id: 'with-link', depends_on_task_id: 'prereq' }]
    renderBoard()
    expect(screen.getByTestId('task-blocked-with-reason')).toHaveTextContent('Waiting for the quote')
    expect(screen.getByTestId('task-blocked-with-link')).toHaveTextContent('waiting for 1 task')
    expect(screen.getByTestId('task-blocked-legacy')).toHaveTextContent('no reason recorded')
  })

  it('lists prerequisites across departments with their state, and flags a schedule conflict', async () => {
    state.tasks = [
      task('me-task', { owner_id: 'me', subteam_key: 'AERO', starts_on: '2026-10-01', due_date: '2026-10-20' }),
      task('other-dept', { owner_id: 'm2', subteam_key: 'BODY', title: 'Body panel', due_date: '2026-10-10' }),
    ]
    state.links = [{ task_id: 'me-task', depends_on_task_id: 'other-dept' }]
    renderBoard('/board?dept=AERO')
    const { panel } = await open('me-task')
    const row = panel.getByTestId('task-prereq-me-task-other-dept')
    expect(row).toHaveTextContent('Body panel')
    expect(row).toHaveTextContent('Bodywork')
    expect(panel.getByTestId('task-prereq-conflict-other-dept')).toBeInTheDocument()
  })

  it('removes and adds prerequisites through the commands, offering only sensible candidates', async () => {
    state.tasks = [
      task('me-task', { owner_id: 'me', subteam_key: 'AERO', title: 'Mine' }),
      task('cand', { owner_id: 'm2', subteam_key: 'BODY', title: 'Candidate' }),
      task('waiter', { owner_id: 'm2', subteam_key: 'BODY', title: 'Waits for mine' }),
    ]
    state.links = [{ task_id: 'waiter', depends_on_task_id: 'me-task' }]
    renderBoard('/board?dept=AERO')
    const { user, panel } = await open('me-task')
    const options = within(panel.getByLabelText(/Add a prerequisite/)).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Choose a task…', 'Candidate — Bodywork']) // not itself, not the task already waiting for it
    await user.selectOptions(panel.getByLabelText(/Add a prerequisite/), 'cand')
    await user.click(panel.getByRole('button', { name: 'Add prerequisite' }))
    expect(state.linkWrites).toEqual([{ add: { taskId: 'me-task', dependsOnTaskId: 'cand' } }])
  })

  it('shows what waits for the task, and offers no link controls to someone who may not edit it', async () => {
    state.tasks = [
      task('theirs', { owner_id: 'm2', subteam_key: 'BODY', title: 'Theirs' }),
      task('waiter', { owner_id: 'm2', subteam_key: 'BODY', title: 'Waiter' }),
    ]
    state.links = [{ task_id: 'waiter', depends_on_task_id: 'theirs' }]
    renderBoard('/board?dept=BODY')
    const { panel } = await open('theirs')
    expect(panel.getByTestId('task-dependents-theirs')).toHaveTextContent('Waiter')
    expect(panel.queryByLabelText(/Add a prerequisite/)).not.toBeInTheDocument()
    expect(panel.queryByRole('button', { name: /Add prerequisite/ })).not.toBeInTheDocument()
  })

  it('shows the real refusal when the database rejects a link', async () => {
    state.tasks = [task('me-task', { owner_id: 'me', subteam_key: 'AERO' }), task('cand', { owner_id: 'm2', subteam_key: 'BODY', title: 'Candidate' })]
    state.linkError = new Error('“Candidate” already waits, directly or through other tasks, for “me-task”. Linking them the other way round would make a circle.')
    renderBoard('/board?dept=AERO')
    const { panel } = await open('me-task')
    expect(await panel.findByText(/would make a circle/)).toBeInTheDocument()
  })

  it('edits a blocker reason in the details form, and refuses to empty it with no prerequisite', async () => {
    state.tasks = [task('blk', { owner_id: 'me', subteam_key: 'AERO', state: 'blocked', blocked_reason: 'Waiting for the quote' })]
    renderBoard('/board?dept=AERO')
    const { user, panel } = await open('blk')
    await user.clear(panel.getByLabelText('Why is it blocked?'))
    await user.click(panel.getByTestId('task-save-blk'))
    expect(await panel.findByText(/must say why/)).toBeInTheDocument()
    expect(state.writes).toEqual([])
    await user.type(panel.getByLabelText('Why is it blocked?'), 'Quote arrived, waiting for the invoice')
    await user.click(panel.getByTestId('task-save-blk'))
    expect(state.writes).toEqual([{ id: 'blk', blockedReason: 'Quote arrived, waiting for the invoice' }])
  })
})

describe('a save never reverts what someone else changed in a field you did not touch', () => {
  it('sends only the deadline when only the deadline was edited, although the title changed underneath', async () => {
    const user = userEvent.setup()
    state.tasks = [task('shared', { owner_id: 'me', subteam_key: 'AERO', title: 'Original title', due_date: '2026-12-01' })]
    const { rerender } = renderBoard('/board?dept=AERO')
    await user.click(within(screen.getByTestId('task-more-shared')).getByText(/^Details/))
    const panel = within(await screen.findByTestId('task-details-shared'))
    // Someone else renames the task while this editor is open (the row is refreshed under it).
    state.tasks = state.tasks.map((t) => ({ ...t, title: 'Renamed by someone else', updated_at: '2026-09-24T12:00:00Z' }))
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/board?dept=AERO']}>
          <Board />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByTestId('task-changed-elsewhere')
    await user.clear(panel.getByLabelText('Deadline'))
    await user.type(panel.getByLabelText('Deadline'), '2026-12-15')
    await user.click(panel.getByTestId('task-save-shared'))
    expect(state.writes).toEqual([{ id: 'shared', dueDate: '2026-12-15' }]) // no title: theirs stays
  })
})

describe('archiving from the Board', () => {
  it('is offered to the department Head, explains itself, and asks before archiving', async () => {
    const user = userEvent.setup()
    renderBoard('/board?dept=AERO')
    await user.click(within(screen.getByTestId('task-more-aero-theirs')).getByText(/^Details/))
    await user.click(await screen.findByTestId('task-archive-aero-theirs'))
    const confirm = screen.getByRole('alertdialog', { name: 'Archive this task' })
    expect(confirm).toHaveTextContent('moves to the Archive, where it and its history stay')
    expect(state.archives).toEqual([])
    await user.click(within(confirm).getByTestId('task-archive-confirm-aero-theirs'))
    expect(state.archives).toEqual([{ id: 'aero-theirs' }])
  })

  it('is not offered to a plain owner or to anyone else', async () => {
    const user = userEvent.setup()
    renderBoard('/board?dept=BODY')
    await user.click(within(screen.getByTestId('task-more-body-mine')).getByText(/^Details/))
    await screen.findByTestId('task-details-body-mine')
    expect(screen.queryByTestId('task-archive-body-mine')).not.toBeInTheDocument()
  })
})

describe('loading, error and empty states', () => {
  it('says it is loading', () => {
    state.loading = true
    state.tasks = []
    renderBoard()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByTestId('board-empty')).not.toBeInTheDocument()
  })

  it('offers a retry on a load error', () => {
    state.loadError = new Error('network down')
    renderBoard()
    expect(screen.getByText(/Could not load the board/)).toBeInTheDocument()
  })

  it('explains an empty season and where tasks come from', () => {
    state.tasks = []
    renderBoard()
    expect(screen.getByTestId('board-empty')).toHaveTextContent('A task is created when a proposal is approved')
  })
})

describe('arriving from a link that names a task (the Register\'s linked-task list)', () => {
  it('opens that card\'s details, brings it into focus, and leaves the others closed', () => {
    renderBoard('/board?task=aero-theirs')
    const card = screen.getByTestId('task-aero-theirs')
    expect(screen.getByTestId('task-more-aero-theirs')).toHaveAttribute('open')
    expect(card).toHaveFocus()
    expect(screen.getByTestId('task-more-aero-mine')).not.toHaveAttribute('open')
    expect(screen.queryByTestId('board-task-missing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('board-task-hidden')).not.toBeInTheDocument()
  })

  it('says so, with a way to the Archive, when the task is not on the Board', () => {
    renderBoard('/board?task=long-gone')
    expect(screen.getByTestId('board-task-missing')).toHaveTextContent('not on the Board')
    expect(within(screen.getByTestId('board-task-missing')).getByRole('link', { name: /archive/i })).toHaveAttribute(
      'href',
      '/archive?tab=tasks&id=long-gone',
    )
    // Nothing else is opened in its place.
    expect(document.querySelectorAll('details[open]')).toHaveLength(0)
  })

  it('does not report a missing task while tasks are still loading', () => {
    state.loading = true
    state.tasks = []
    renderBoard('/board?task=aero-mine')
    expect(screen.queryByTestId('board-task-missing')).not.toBeInTheDocument()
  })

  it('says when the current filters hide the task, and can show everything', async () => {
    const user = userEvent.setup()
    renderBoard('/board?task=body-theirs&scope=mine')
    expect(screen.getByTestId('board-task-hidden')).toHaveTextContent('hidden by the current filters')
    expect(screen.queryByTestId('task-body-theirs')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /show all tasks/i }))
    expect(screen.getByTestId('task-body-theirs')).toBeInTheDocument()
    expect(screen.getByTestId('task-more-body-theirs')).toHaveAttribute('open')
  })

  it('ignores a malformed task id rather than searching for it', () => {
    renderBoard('/board?task=%3Cscript%3E')
    expect(screen.queryByTestId('board-task-missing')).not.toBeInTheDocument()
    expect(document.querySelectorAll('details[open]')).toHaveLength(0)
  })
})

describe('F14-04 and F14-05: saving what was changed, and filters that keep the link', () => {
  async function open(id: string, user = userEvent.setup()) {
    await user.click(within(screen.getByTestId(`task-more-${id}`)).getByText(/^Details/))
    return { user, panel: within(await screen.findByTestId(`task-details-${id}`)) }
  }
  it('clears a deadline for real, and says what was saved', async () => {
    renderBoard('/board?dept=AERO')
    const { user, panel } = await open('aero-theirs')
    await user.clear(panel.getByLabelText('Deadline'))
    await user.click(panel.getByTestId('task-save-aero-theirs'))
    expect(state.writes).toEqual([{ id: 'aero-theirs', dueDate: null }])
    expect(await panel.findByTestId('task-save-result-aero-theirs')).toHaveTextContent('Saved: deadline removed')
  })

  it('says nothing needed saving, and sends nothing, when no field changed', async () => {
    renderBoard('/board?dept=AERO')
    const { user, panel } = await open('aero-theirs')
    await user.click(panel.getByTestId('task-save-aero-theirs'))
    expect(state.writes).toEqual([])
    expect(panel.getByTestId('task-save-result-aero-theirs')).toHaveTextContent('Nothing to save — no field was changed.')
  })

  it('refuses a start after the deadline before anything is sent', async () => {
    renderBoard('/board?dept=AERO')
    const { user, panel } = await open('aero-theirs')
    await user.type(panel.getByLabelText('Start date'), '2027-01-05')
    await user.click(panel.getByTestId('task-save-aero-theirs'))
    expect(state.writes).toEqual([])
    expect(await panel.findByText(/The start date must be on or before the deadline/)).toBeInTheDocument()
    // What was typed stays.
    expect(panel.getByLabelText('Start date')).toHaveValue('2027-01-05')
  })

  it('keeps ?task= when the department is changed from the department row', async () => {
    const user = userEvent.setup()
    renderBoard('/board?task=aero-theirs')
    expect(screen.getByTestId('task-more-aero-theirs')).toHaveAttribute('open')
    const nav = within(screen.getByRole('navigation', { name: 'Department navigation' }))
    await user.click(nav.getByRole('link', { name: /Bodywork/ }))
    // The link is still there: the Board says the named task is hidden by the new filter.
    expect(screen.getByTestId('board-task-hidden')).toHaveTextContent('hidden by the current filters')
  })
})

// F6-01: set_task_department had no screen, so no task could be given a department from the app.
describe('the department of a task (its own command, with a reason)', () => {
  const openDetails = async (user: ReturnType<typeof userEvent.setup>, id: string) =>
    user.click(within(screen.getByTestId(`task-${id}`)).getByText(/^Details/))

  it('the President gives an unassigned task a department even where Heads exist; the reason is required and sent', async () => {
    const user = userEvent.setup()
    session.roles = ['president']
    state.tasks = [task('loose', { subteam_key: null, title: 'Loose task' })]
    renderBoard()
    await openDetails(user, 'loose')
    const panel = within(screen.getByTestId('task-department-loose'))
    expect(panel.getByText('No department yet.')).toBeInTheDocument()
    const select = panel.getByLabelText('Give it a department')
    // Archived departments are never offered.
    expect(within(select).queryByRole('option', { name: 'Retired dept' })).not.toBeInTheDocument()
    await user.selectOptions(select, 'BODY')
    const move = panel.getByRole('button', { name: 'Move task' })
    expect(move).toBeDisabled()
    await user.type(panel.getByLabelText('Why? (kept in the history)'), '  Bodywork owns the fairing  ')
    await user.click(move)
    expect(state.moves).toEqual([{ id: 'loose', departmentKey: 'BODY', reason: 'Bodywork owns the fairing' }])
    expect(panel.getByRole('status')).toHaveTextContent('Moved to Bodywork.')
  })

  it('a Head of one department gets no department control — moving work out is not theirs to do', async () => {
    const user = userEvent.setup()
    renderBoard()
    await openDetails(user, 'aero-theirs')
    expect(screen.queryByTestId('task-department-aero-theirs')).not.toBeInTheDocument()
  })

  it('a Head of two departments may move work only between them', async () => {
    const user = userEvent.setup()
    departments = departments.map((d) => (d.key === 'BODY' ? { ...d, lead_id: 'me' } : d))
    departments.push({ key: 'ELEC', name: 'Electrics', lead_id: 'm2', archived_at: null })
    renderBoard()
    await openDetails(user, 'aero-theirs')
    const options = within(screen.getByTestId('task-department-aero-theirs')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Choose a department…', 'Bodywork'])
  })

  it('an ordinary member who heads nothing sees no department control', async () => {
    const user = userEvent.setup()
    departments = departments.map((d) => ({ ...d, lead_id: 'm2' }))
    renderBoard()
    await openDetails(user, 'aero-mine')
    expect(screen.queryByTestId('task-department-aero-mine')).not.toBeInTheDocument()
  })
})
