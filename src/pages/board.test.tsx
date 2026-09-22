import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Your tasks" is a view filter over the same rows the board already loaded —
// no second query, and no task is hidden from anybody who switches back.

const state = {
  tasks: [] as Record<string, unknown>[],
  taskWrites: [] as Record<string, unknown>[],
}

vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1' }, roles: [] }),
}))
vi.mock('../auth/usePermissions.ts', () => ({
  usePermissions: () => ({ canDeleteTask: false }),
}))
vi.mock('../data/useMembers.ts', () => ({
  useMembers: () => ({
    data: [
      { id: 'm1', full_name: 'Ada Rider' },
      { id: 'm2', full_name: 'Bo Wrench' },
    ],
    isLoading: false,
    error: null,
    refetch: () => {},
  }),
}))
vi.mock('../data/useProposals.ts', () => ({
  useProposals: () => ({ data: [], isLoading: false, error: null }),
}))
vi.mock('../data/useTasks.ts', () => ({
  useTasks: () => ({ data: state.tasks, isLoading: false, error: null, refetch: () => {}, seasonId: 's' }),
  useUpdateTask: () => ({
    mutate: (v: Record<string, unknown>) => state.taskWrites.push(v),
    isPending: false,
    isError: false,
    error: null,
  }),
  useDeleteTask: () => ({ mutate: () => {}, mutateAsync: async () => {}, reset: () => {}, isPending: false, error: null }),
}))

const { default: Board } = await import('./Board.tsx')

function task(over: Record<string, unknown>) {
  return {
    id: 'x',
    title: 'A task',
    detail: null,
    state: 'todo',
    owner_id: null,
    due_date: null,
    source_proposal: null,
    ...over,
  }
}

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Board />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.tasks = [
    task({ id: 't1', title: 'Mine, to do', owner_id: 'm1' }),
    task({ id: 't2', title: 'Mine, in progress', owner_id: 'm1', state: 'wip' }),
    task({ id: 't3', title: 'Bo’s task', owner_id: 'm2' }),
    task({ id: 't4', title: 'Nobody’s task', owner_id: null }),
  ]
  state.taskWrites = []
})

describe('Board task scope', () => {
  it('starts on all tasks and counts both scopes', () => {
    renderBoard()
    const tabs = screen.getByTestId('board-scope')
    expect(within(tabs).getByRole('button', { name: /All tasks/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(tabs).getByRole('button', { name: /All tasks \(4\)/ })).toBeTruthy()
    expect(within(tabs).getByRole('button', { name: /Your tasks \(2\)/ })).toBeTruthy()
    expect(screen.getByTestId('task-t3')).toBeTruthy()
  })

  it('shows only the caller’s tasks once switched, across every lane', async () => {
    const user = userEvent.setup()
    renderBoard()
    await user.click(screen.getByRole('button', { name: /Your tasks/ }))

    expect(screen.getByTestId('task-t1')).toBeTruthy()
    expect(screen.getByTestId('task-t2')).toBeTruthy()
    // Someone else's, and the unassigned one, are out of view — not deleted.
    expect(screen.queryByTestId('task-t3')).toBeNull()
    expect(screen.queryByTestId('task-t4')).toBeNull()

    // Lane headings count what they actually show.
    expect(within(screen.getByTestId('lane-todo')).getByRole('heading').textContent).toContain('(1)')
    expect(within(screen.getByTestId('lane-wip')).getByRole('heading').textContent).toContain('(1)')

    await user.click(screen.getByRole('button', { name: /All tasks/ }))
    expect(screen.getByTestId('task-t3')).toBeTruthy()
  })

  it('explains an empty personal board instead of showing six empty lanes', async () => {
    state.tasks = [task({ id: 't3', title: 'Bo’s task', owner_id: 'm2' })]
    const user = userEvent.setup()
    renderBoard()
    await user.click(screen.getByRole('button', { name: /Your tasks/ }))

    expect(screen.getByText(/No tasks are assigned to you right now/)).toBeTruthy()
    // And the note offers the way back.
    await user.click(screen.getByRole('button', { name: 'all tasks' }))
    expect(screen.getByTestId('task-t3')).toBeTruthy()
  })
})
