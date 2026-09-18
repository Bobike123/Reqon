import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The one thing this screen must get right: a subtask is a Board task, so the
// same mutation the Board uses is the one the Gantt calls.
const { updateTask, addTask, who } = vi.hoisted(() => ({
  updateTask: vi.fn(),
  addTask: vi.fn(),
  who: { roles: [] as string[] },
}))

const MILESTONES = [
  { key: 'MS1-1', name: 'Team Plan', season_id: 's', ordinal: 1, opens_on: '2026-11-01', due_on: '2026-11-30', max_points: 75, is_blocking: false, aim: null, article_ref: null, notes: null },
  { key: 'MS1-7', name: 'Final Event', season_id: 's', ordinal: 7, opens_on: null, due_on: null, max_points: 60, is_blocking: false, aim: null, article_ref: null, notes: null },
]
const SECTIONS = [
  { id: 'sec1', milestone_key: 'MS1-1', ordinal: 1, name: 'Cover sheet', is_drafted: false, owner_id: null, updated_at: '' },
]
const TASKS = [
  { id: 't1', season_id: 's', title: 'Draft the cover', state: 'wip', section_id: 'sec1', due_date: '2026-11-10', owner_id: null, detail: null, starred: false, subteam_key: null, source_proposal: null, created_at: '', created_by: null, updated_at: '' },
  { id: 't2', season_id: 's', title: 'Loose board task', state: 'todo', section_id: null, due_date: null, owner_id: null, detail: null, starred: false, subteam_key: null, source_proposal: null, created_at: '', created_by: null, updated_at: '' },
]

vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1' }, roles: who.roles }),
}))
vi.mock('../data/useMembers.ts', () => ({
  useMembers: () => ({ data: [{ id: 'm1', full_name: 'Ada Rider' }], isLoading: false, error: null }),
}))
vi.mock('../data/useMilestones.ts', () => ({
  useMilestones: () => ({ data: MILESTONES, isLoading: false, error: null, refetch: vi.fn() }),
  useMilestoneSections: () => ({ data: SECTIONS, isLoading: false, error: null, refetch: vi.fn() }),
  useSetSectionDrafted: () => ({ mutate: vi.fn(), isError: false, error: null }),
}))
vi.mock('../data/useTasks.ts', () => ({
  useTasks: () => ({ data: TASKS, isLoading: false, error: null, seasonId: 's', refetch: vi.fn() }),
  useUpdateTask: () => ({ mutate: updateTask, isPending: false, error: null }),
  useAddSectionTask: () => ({ mutate: addTask, isPending: false, error: null }),
}))

const { default: Gantt } = await import('./Gantt.tsx')

beforeEach(() => {
  vi.clearAllMocks()
  who.roles = []
})

async function openToSubtasks(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /MS1-1/ }))
  await user.click(screen.getByRole('button', { name: /Cover sheet/ }))
}

describe('Gantt', () => {
  it('shows the submissions first, with their sections and subtasks folded away', () => {
    render(<Gantt />)
    expect(screen.getByTestId('gantt-milestone-MS1-1')).toBeInTheDocument()
    expect(screen.queryByTestId('gantt-section-sec1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('gantt-task-t1')).not.toBeInTheDocument()
    // A milestone with no published window is never given an invented bar.
    expect(screen.queryByTitle(/^MS1-7:/)).not.toBeInTheDocument()
  })

  it('expands a submission into sections, then a section into subtasks', async () => {
    const user = userEvent.setup()
    render(<Gantt />)
    await user.click(screen.getByRole('button', { name: /MS1-1/ }))
    expect(screen.getByTestId('gantt-section-sec1')).toBeInTheDocument()
    expect(screen.queryByTestId('gantt-task-t1')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Cover sheet/ }))
    expect(screen.getByTestId('gantt-task-t1')).toBeInTheDocument()
    // Only this section's subtasks: a board task under no section is not
    // swept in as a row (it is only offered in the "link an existing" list).
    expect(screen.queryByTestId('gantt-task-t2')).not.toBeInTheDocument()
  })

  it('moves a subtask by writing to the Board task itself, not a copy', async () => {
    const user = userEvent.setup()
    render(<Gantt />)
    await openToSubtasks(user)
    await user.selectOptions(screen.getByLabelText('Move Draft the cover to another lane'), 'done')
    expect(updateTask).toHaveBeenCalledWith({ id: 't1', state: 'done' })
    await user.selectOptions(screen.getByLabelText('Owner for Draft the cover'), 'm1')
    expect(updateTask).toHaveBeenCalledWith({ id: 't1', ownerId: 'm1' })
  })

  it('adopts an existing board task instead of creating a second one', async () => {
    const user = userEvent.setup()
    render(<Gantt />)
    await openToSubtasks(user)
    await user.selectOptions(
      screen.getByLabelText('Link an existing board task to Cover sheet'),
      't2',
    )
    expect(updateTask).toHaveBeenCalledWith({ id: 't2', sectionId: 'sec1' })
    expect(addTask).not.toHaveBeenCalled()
  })

  // task_insert is is_admin() in the database, so a member is not offered a
  // button the database would refuse.
  it('does not offer a member the create form', async () => {
    const user = userEvent.setup()
    render(<Gantt />)
    await openToSubtasks(user)
    expect(screen.queryByLabelText(/New subtask for/)).not.toBeInTheDocument()
  })

  it('creates a missing subtask as a real board task', async () => {
    who.roles = ['president']
    const user = userEvent.setup()
    render(<Gantt />)
    await openToSubtasks(user)
    await user.type(screen.getByLabelText('New subtask for Cover sheet'), '  Write the intro  ')
    await user.click(screen.getByRole('button', { name: 'Add to Board' }))
    expect(addTask).toHaveBeenCalledWith({ sectionId: 'sec1', title: 'Write the intro' })
  })

  it('unlinks a subtask without deleting the task', async () => {
    const user = userEvent.setup()
    render(<Gantt />)
    await openToSubtasks(user)
    await user.click(screen.getByRole('button', { name: 'Unlink Draft the cover from Cover sheet' }))
    expect(updateTask).toHaveBeenCalledWith({ id: 't1', sectionId: null })
  })
})
