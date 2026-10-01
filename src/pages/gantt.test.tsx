import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Gantt composed for real (lens, legend, milestone → section → task rows, the
// unsectioned group, the link tool) over mocked DATA hooks. Who may do what comes
// from the real permission mirrors and the mocked departments' Heads, never from
// a flag in the test. The clock is pinned so "today" and "overdue" are exact.

const TODAY = new Date(2026, 10, 15, 12, 0, 0) // 15 Nov 2026, local noon

const { updateTask, updateTaskAsync, who, state, deps } = vi.hoisted(() => ({
  updateTask: vi.fn(),
  updateTaskAsync: vi.fn(async () => {}),
  who: { id: 'm1', roles: [] as string[] },
  state: { loadError: null as Error | null },
  deps: { links: [] as { task_id: string; depends_on_task_id: string }[], extraSections: [] as Record<string, unknown>[] },
}))

const M = (over: Record<string, unknown>) => ({
  season_id: 's', ordinal: 1, aim: null, article_ref: null, max_points: 0, is_blocking: false, notes: null, ...over,
})
const MILESTONES = [
  M({ key: 'MS1-1', name: 'Team Plan', opens_on: '2026-11-01', due_on: '2026-11-30' }),
  M({ key: 'MS1-2', name: 'Product Definition', ordinal: 2, opens_on: null, due_on: '2027-02-28' }),
  M({ key: 'MS1-7', name: 'Final Event', ordinal: 7, opens_on: null, due_on: null }),
]
const SECTIONS = [
  { id: 'sec1', milestone_key: 'MS1-1', ordinal: 1, name: 'Cover sheet', is_drafted: false, owner_id: null, updated_at: '', parent_section_id: null },
  { id: 'sec2', milestone_key: 'MS1-1', ordinal: 2, name: 'Budget', is_drafted: false, owner_id: null, updated_at: '', parent_section_id: null },
  { id: 'secB', milestone_key: 'MS1-2', ordinal: 1, name: 'Loads', is_drafted: false, owner_id: null, updated_at: '', parent_section_id: null },
]
const DEPARTMENTS = [
  { key: 'AERO', name: 'Aerodynamics', lead_id: 'm2', archived_at: null, is_parked: false, sort_order: 0 },
  { key: 'BODY', name: 'Bodywork', lead_id: 'm3', archived_at: null, is_parked: false, sort_order: 1 },
]
const MEMBERS = [
  { id: 'm1', full_name: 'Ada Rider', status: 'active' },
  { id: 'm2', full_name: 'Bo Wrench', status: 'active' },
  { id: 'm3', full_name: 'Cy Frame', status: 'active' },
]

function task(id: string, over: Record<string, unknown> = {}) {
  return {
    id, season_id: 's', title: id, state: 'todo', priority: 'normal', section_id: null, milestone_key: null,
    starts_on: null, due_date: null, owner_id: 'm1', subteam_key: 'AERO', detail: null, starred: false,
    source_proposal: null, created_at: '', created_by: null, updated_at: '', links_required: false,
    completed_at: null, completion_source: null, archived_at: null, archived_by: null, archive_reason: null,
    blocked_reason: null, blocked_since: null, ...over,
  }
}

let tasks: ReturnType<typeof task>[]
let archived: ReturnType<typeof task>[]

vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: who.id }, member: { id: who.id, status: 'active' }, roles: who.roles }),
}))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => 's', useSeason: () => ({ status: 'ready', seasonId: 's' }) }))
vi.mock('../data/useMembers.ts', () => ({ useMembers: () => ({ data: MEMBERS, isLoading: false, error: null }) }))
vi.mock('../data/useSubteams.ts', () => ({ useSubteams: () => ({ data: DEPARTMENTS, isLoading: false, error: null }) }))
vi.mock('../data/useRealtimeTasks.ts', () => ({ useRealtimeTasks: () => 'live' }))
vi.mock('../data/useRealtimeTaskDependencies.ts', () => ({ useRealtimeTaskDependencies: () => 'live' }))
vi.mock('../data/useTaskDependencies.ts', () => ({ useTaskDependencies: () => ({ data: deps.links }) }))
vi.mock('../data/useRealtimeMilestones.ts', () => ({ useRealtimeMilestones: () => 'live' }))
vi.mock('../data/useRealtimeMilestoneSections.ts', () => ({ useRealtimeMilestoneSections: () => 'live' }))
vi.mock('../data/useMilestones.ts', () => ({
  useMilestones: () => ({ data: MILESTONES, isLoading: false, error: state.loadError, refetch: vi.fn() }),
  useMilestoneSections: () => ({ data: [...SECTIONS, ...deps.extraSections], isLoading: false, error: null, refetch: vi.fn() }),
  useSetSectionDrafted: () => ({ mutate: vi.fn(), isError: false, error: null }),
}))
vi.mock('../data/useTaskHistory.ts', () => ({
  // Active AND archived tasks, for progress only.
  useTasksForProgress: () => ({ data: [...tasks, ...archived], isLoading: false, error: null }),
}))
vi.mock('../data/useTasks.ts', () => ({
  useTasks: () => ({ data: tasks, isLoading: false, error: null, seasonId: 's', refetch: vi.fn() }),
  useUpdateTask: () => ({ mutate: updateTask, mutateAsync: updateTaskAsync, isPending: false, error: null }),
}))

const { default: Gantt } = await import('./Gantt.tsx')

function renderGantt(url = '/gantt') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Gantt />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: TODAY })
  who.id = 'm1'
  // A role holder with no task authority of their own: they edit what they own.
  // Plain members (no role, no department) only view — see 'view only'.
  who.roles = ['treasurer']
  state.loadError = null
  deps.links = []
  deps.extraSections = []
  tasks = [
    task('t1', { title: 'Draft the cover', state: 'wip', section_id: 'sec1', milestone_key: 'MS1-1', starts_on: '2026-11-20', due_date: '2026-11-25' }),
    task('t2', { title: 'Bodywork budget line', section_id: 'sec1', milestone_key: 'MS1-1', due_date: '2026-11-27', owner_id: 'm3', subteam_key: 'BODY' }),
    task('t3', { title: 'Late unsectioned', milestone_key: 'MS1-1', due_date: '2026-11-01' }),
    task('t4', { title: 'Promoted no dates', milestone_key: 'MS1-1', links_required: true }),
    task('t5', { title: 'Loose mine', starts_on: '2025-03-01', due_date: '2025-03-05' }),
    task('t6', { title: 'Loose theirs', owner_id: 'm3', subteam_key: 'BODY' }),
    task('t7', { title: 'On the other submission', state: 'blocked', section_id: 'secB', milestone_key: 'MS1-2', due_date: '2027-02-01' }),
    task('t8', { title: 'Other season', season_id: 'other' }),
  ]
  archived = [
    task('a1', { title: 'Archived done', state: 'done', section_id: 'sec1', milestone_key: 'MS1-1', archived_at: '2026-10-20T00:00:00Z' }),
    task('a2', { title: 'Archived unfinished', state: 'wip', section_id: 'sec1', milestone_key: 'MS1-1', archived_at: '2026-10-20T00:00:00Z' }),
  ]
})

afterEach(() => {
  vi.useRealTimers()
})

async function open(user: ReturnType<typeof userEvent.setup>, ...names: RegExp[]) {
  for (const name of names) await user.click(screen.getByRole('button', { name }))
}

describe('the timeline structure', () => {
  it('shows the submissions first, with sections and subtasks folded away', () => {
    renderGantt()
    expect(screen.getByTestId('gantt-milestone-MS1-1')).toBeInTheDocument()
    expect(screen.queryByTestId('gantt-section-sec1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('gantt-task-t1')).not.toBeInTheDocument()
  })

  it('expands a submission into sections and its unsectioned work, then a section into its tasks', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/)
    expect(screen.getByTestId('gantt-section-sec1')).toBeInTheDocument()
    expect(screen.getByTestId('gantt-section-sec2')).toBeInTheDocument()
    expect(screen.getByTestId('gantt-unsectioned-MS1-1')).toBeInTheDocument()
    expect(screen.queryByTestId('gantt-task-t1')).not.toBeInTheDocument()
    await open(user, /Cover sheet/)
    expect(screen.getByTestId('gantt-task-t1')).toBeInTheDocument()
    expect(screen.getByTestId('gantt-task-t2')).toBeInTheDocument()
    // Only this section's tasks; a loose Board task is not swept in as a row.
    expect(screen.queryByTestId('gantt-task-t5')).not.toBeInTheDocument()
    // Archived work is not a planning row.
    expect(screen.queryByTestId('gantt-task-a1')).not.toBeInTheDocument()
  })

  it('shows tasks linked to a submission before any section as an explicit group, with no fake section record', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/)
    // Exactly the real sections; the unsectioned group is not one of them.
    expect(document.querySelectorAll('[data-testid^="gantt-section-sec"]')).toHaveLength(2)
    await open(user, /Unsectioned work/)
    const group = screen.getByTestId('gantt-unsectioned-MS1-1')
    expect(within(group).getByTestId('gantt-task-t3')).toBeInTheDocument()
    expect(within(group).getByTestId('gantt-task-t4')).toBeInTheDocument()
    // A task on a section is not repeated in the unsectioned group.
    expect(within(group).queryByTestId('gantt-task-t1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Unsectioned work \(2\)/ })).toBeInTheDocument()
  })

  it('each task is the Board task itself: its title opens the same Board card', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    expect(within(screen.getByTestId('gantt-task-t1')).getByRole('link', { name: 'Draft the cover' })).toHaveAttribute('href', '/board?task=t1')
  })
})

describe('honest dates', () => {
  it('a milestone with no published date is never given an invented bar', () => {
    renderGantt()
    expect(screen.queryByTitle(/^MS1-7/)).not.toBeInTheDocument()
    expect(within(screen.getByTestId('gantt-milestone-MS1-7')).queryByText('Deadline TBC')).not.toBeInTheDocument()
  })

  it('a milestone with a deadline but no opening date shows only the deadline, not a window', () => {
    renderGantt()
    const row = screen.getByTestId('gantt-milestone-MS1-2')
    // No window bar (its title starts with the key and a colon)...
    expect(within(row).queryByTitle(/^MS1-2:/)).not.toBeInTheDocument()
    // ...but the deadline is marked, and the text says why there is no window.
    expect(within(row).getByTitle(/MS1-2 deadline: 28 Feb 2027.*no opening date published/)).toBeInTheDocument()
    expect(row).toHaveTextContent('no opening date published')
  })

  it('a milestone with both dates draws its window and its deadline as different shapes', () => {
    renderGantt()
    const row = screen.getByTestId('gantt-milestone-MS1-1')
    expect(within(row).getByTitle(/^MS1-1: 1 Nov 2026 → 30 Nov 2026/)).toBeInTheDocument()
    expect(within(row).getByTitle(/MS1-1 deadline: 30 Nov 2026$/)).toBeInTheDocument()
  })

  it('draws a task with both dates as a period, and a deadline-only task as a marker with no invented start', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    const period = screen.getByTestId('gantt-task-t1')
    expect(within(period).getByTitle('Draft the cover: 20 Nov 2026 → 25 Nov 2026')).toBeInTheDocument()
    expect(period).toHaveTextContent('20 Nov 2026 to 25 Nov 2026')
    const deadline = screen.getByTestId('gantt-task-t2')
    expect(within(deadline).getByTitle('Bodywork budget line: due 27 Nov 2026')).toBeInTheDocument()
    expect(deadline).toHaveTextContent('deadline 27 Nov 2026 (no start date)')
  })

  it('marks overdue open work with "!" and text, and says undated work is undated', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Unsectioned work/)
    const late = screen.getByTestId('gantt-task-t3')
    expect(late).toHaveTextContent('deadline 1 Nov 2026 (no start date), To do, overdue')
    expect(within(late).getByTitle('Late unsectioned: due 1 Nov 2026 · overdue')).toHaveTextContent('!')
    const undated = screen.getByTestId('gantt-task-t4')
    expect(undated).toHaveTextContent('No dates set')
    expect(undated).toHaveTextContent('no dates set, To do')
  })

  it('marks finished work with a tick, and never calls it overdue', async () => {
    tasks = [task('d1', { title: 'Finished late', state: 'done', section_id: 'sec1', milestone_key: 'MS1-1', due_date: '2026-11-01' })]
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    const row = screen.getByTestId('gantt-task-d1')
    expect(within(row).getByTitle('Finished late: due 1 Nov 2026')).toHaveTextContent('✓')
    expect(row).not.toHaveTextContent('overdue')
  })

  it('fits task STARTS as well as ends into the timeline, but ignores a loose Board task\'s dates', () => {
    tasks = [
      ...tasks,
      task('early', { title: 'Starts early', section_id: 'sec1', milestone_key: 'MS1-1', starts_on: '2026-09-15', due_date: '2026-11-20' }),
    ]
    renderGantt()
    const months = screen.getByTestId('gantt-months').textContent
    // The early start pulls the ruler back to September...
    expect(months).toMatch(/Sep(t)? 26/)
    // ...while t5 (a loose task dated March 2025, linked to nothing) does not.
    expect(months).not.toContain('Mar 25')
  })

  it('writes the periods and deadlines on the chart, not only in tooltips', async () => {
    const user = userEvent.setup()
    renderGantt()
    expect(screen.getByTestId('gantt-milestone-MS1-1')).toHaveTextContent('1 Nov → Due 30 Nov')
    expect(screen.getByTestId('gantt-milestone-MS1-2')).toHaveTextContent('Due 28 Feb')
    await open(user, /MS1-1/, /Cover sheet/)
    expect(screen.getByTestId('gantt-task-t1')).toHaveTextContent('20 Nov → 25 Nov')
    expect(screen.getByTestId('gantt-task-t2')).toHaveTextContent('Due 27 Nov')
  })

  it('names today with a word on the ruler as well as a line', () => {
    renderGantt()
    expect(within(screen.getByTestId('gantt-today-label')).getByText('Today')).toBeInTheDocument()
  })
})

describe('progress', () => {
  it('counts archived Done work, so archiving a finished task does not lower a submission\'s progress', () => {
    renderGantt()
    // Linked to MS1-1: t1 wip, t2 todo, t3 todo, t4 todo, a1 done (archived), a2 wip (archived).
    const overall = screen.getByTestId('gantt-overall-MS1-1')
    expect(overall).toHaveTextContent('Overall 17%')
    expect(overall).toHaveAttribute('title', '1 of 6 tasks done, incl. 1 archived done, 1 archived unfinished')
  })

  it('a submission with no linked task says so, instead of a percentage', () => {
    tasks = tasks.filter((t) => t.milestone_key !== 'MS1-2')
    renderGantt()
    // MS1-2 keeps its one section (unticked): the section ticks stand in, and say so.
    expect(screen.getByTestId('gantt-overall-MS1-2')).toHaveTextContent('0/1 done')
    expect(screen.getByTestId('gantt-overall-MS1-7')).toHaveTextContent('No linked work')
  })

  it('a ticked section reads as done, not drafted', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/)
    const empty = screen.getByTestId('gantt-section-sec2')
    expect(empty).toHaveTextContent('Budget: Not done (no tasks linked)')
    expect(within(empty).getByRole('checkbox', { name: 'Budget done' })).toBeEnabled()
    expect(empty).not.toHaveTextContent(/drafted/i)
  })

  it('counts a task attached to a milestone once, whether or not it has a section', () => {
    renderGantt()
    // t3 and t4 are unsectioned, t1 and t2 sectioned: 4 live tasks + 2 archived = 6, not more.
    expect(screen.getByTestId('gantt-overall-MS1-1')).toHaveAttribute('title', expect.stringContaining('of 6 tasks'))
  })
})

describe('who may do what (the Board\'s permission rule, from the real mirrors)', () => {
  it('an owner may move their own task but not reassign it, and reads everyone else\'s', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    // t1: mine.
    expect(screen.getByLabelText('Move Draft the cover to another lane')).toBeInTheDocument()
    expect(screen.queryByLabelText('Owner for Draft the cover')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unlink Draft the cover from Cover sheet' })).toBeInTheDocument()
    // t2: Cy's, in another department — readable, never editable.
    expect(screen.queryByLabelText('Move Bodywork budget line to another lane')).not.toBeInTheDocument()
    expect(screen.getByTestId('gantt-state-text-t2')).toHaveTextContent('To do')
    expect(screen.queryByRole('button', { name: /Unlink Bodywork budget line/ })).not.toBeInTheDocument()
  })

  it('the Head of a department manages its work, including tasks they do not own', async () => {
    who.id = 'm2' // Bo, Head of AERO
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    expect(screen.getByLabelText('Move Draft the cover to another lane')).toBeInTheDocument()
    expect(screen.getByLabelText('Owner for Draft the cover')).toBeInTheDocument()
    // ...but not another department's.
    expect(screen.queryByLabelText('Move Bodywork budget line to another lane')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Unlink Bodywork budget line/ })).not.toBeInTheDocument()
  })

  it('a Developer\'s override is explicit: they may edit every task', async () => {
    who.id = 'm1'
    who.roles = ['developer']
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    expect(screen.getByLabelText('Move Bodywork budget line to another lane')).toBeInTheDocument()
    expect(screen.getByLabelText('Owner for Bodywork budget line')).toBeInTheDocument()
  })

  it('moving a task writes to the Board task itself, not a copy', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    await user.selectOptions(screen.getByLabelText('Move Draft the cover to another lane'), 'done')
    expect(updateTask).toHaveBeenCalledWith({ id: 't1', state: 'done' })
  })
})

describe('linking an existing task (the only work-association command)', () => {
  const linkSelect = (name: string) => screen.getByLabelText(`Link an existing board task to ${name}`) as HTMLSelectElement
  const optionTexts = (select: HTMLSelectElement) => Array.from(select.options).map((o) => o.textContent)

  it('offers only tasks this person may link, in this season, that are not archived', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    const options = optionTexts(linkSelect('Cover sheet'))
    // Direct: mine, no milestone or already on this one (t3 and t4 are unsectioned on MS1-1).
    expect(options).toEqual(expect.arrayContaining(['Loose mine', 'Late unsectioned', 'Promoted no dates']))
    // Another submission's task is offered separately, as a move.
    expect(options).toContain('On the other submission (now on MS1-2 · Loads)')
    // Not mine, another season, or archived: never offered.
    expect(options.join('|')).not.toMatch(/Loose theirs|Other season|Archived/)
    // Already here: nothing to do.
    expect(options).not.toContain('Draft the cover')
  })

  it('links a task to a section with milestone and section together, in one write', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    await user.selectOptions(linkSelect('Cover sheet'), 't5')
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith({ id: 't5', sectionId: 'sec1', milestoneKey: 'MS1-1' })
  })

  it('links a task to a submission before any section, setting only the milestone', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Unsectioned work/)
    await user.selectOptions(linkSelect('MS1-1 (no section yet)'), 't5')
    expect(updateTask).toHaveBeenCalledWith({ id: 't5', sectionId: null, milestoneKey: 'MS1-1' })
  })

  it('a task on another submission is only moved after an explicit confirmation, and both fields change together', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    await user.selectOptions(linkSelect('Cover sheet'), 't7')
    // Nothing is written yet.
    expect(updateTask).not.toHaveBeenCalled()
    const confirm = screen.getByTestId('link-confirm')
    expect(confirm).toHaveTextContent('Move “On the other submission” from MS1-2 · Loads to Cover sheet?')
    expect(confirm).toHaveTextContent('submission and its section both change together')
    await user.click(within(confirm).getByRole('button', { name: 'Move task' }))
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith({ id: 't7', sectionId: 'sec1', milestoneKey: 'MS1-1' })
  })

  it('cancelling a move changes nothing', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    await user.selectOptions(linkSelect('Cover sheet'), 't7')
    await user.click(within(screen.getByTestId('link-confirm')).getByRole('button', { name: 'Cancel' }))
    expect(updateTask).not.toHaveBeenCalled()
    expect(screen.queryByTestId('link-confirm')).not.toBeInTheDocument()
  })

  it('a Head is offered the department\'s tasks, and only that department\'s', async () => {
    who.id = 'm3' // Cy, Head of BODY (also owns t2 and t6)
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    const options = optionTexts(linkSelect('Cover sheet'))
    expect(options).toContain('Loose theirs')
    expect(options.join('|')).not.toMatch(/Loose mine/)
  })

  it('a person with nothing they may link is told so', async () => {
    who.id = 'm4' // an active member who owns nothing and heads nothing
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    expect(screen.getAllByTestId('link-none').length).toBeGreaterThan(0)
  })

  it('unlinking a section keeps the task on its submission (it becomes unsectioned work)', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    await user.click(screen.getByRole('button', { name: 'Unlink Draft the cover from Cover sheet' }))
    expect(updateTask).toHaveBeenCalledWith({ id: 't1', sectionId: null })
  })

  it('unlinking from the submission itself is offered, and refused for work that came from a proposal', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Unsectioned work/)
    await user.click(screen.getByRole('button', { name: 'Unlink Late unsectioned from MS1-1' }))
    expect(updateTask).toHaveBeenCalledWith({ id: 't3', sectionId: null, milestoneKey: null })
    // The promoted task keeps its milestone: no button, and the reason in words.
    expect(screen.queryByRole('button', { name: /Unlink Promoted no dates/ })).not.toBeInTheDocument()
    expect(within(screen.getByTestId('gantt-task-t4')).getByText('Keeps its submission (made from a proposal)')).toBeInTheDocument()
  })

  it('a member who may not edit a task gets no link or unlink control for it', async () => {
    who.id = 'm4'
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/, /Unsectioned work/)
    expect(screen.queryByRole('button', { name: /^Unlink/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Move .* to another lane/)).not.toBeInTheDocument()
    expect(screen.getAllByTestId('link-none').length).toBeGreaterThan(0)
    // Everything is still readable.
    expect(screen.getByTestId('gantt-task-t1')).toBeInTheDocument()
  })
})

describe('view only for plain members', () => {
  it('a member with no role who heads nothing sees everything but changes nothing, even on their own task', async () => {
    who.roles = []
    const user = userEvent.setup()
    renderGantt()
    expect(screen.getByTestId('gantt-view-only')).toBeInTheDocument()
    await open(user, /MS1-1/, /Cover sheet/, /Unsectioned work/)
    // t1 is theirs: readable, not editable here.
    expect(screen.getByTestId('gantt-task-t1')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Move .* to another lane/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Owner for/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Unlink/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Link an existing board task/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('link-none')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Cover sheet done' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Show details of Draft the cover' }))
    expect(within(screen.getByTestId('gantt-task-more-t1')).queryByLabelText('Deadline')).not.toBeInTheDocument()
  })

  it('a Head with no role still manages their department', async () => {
    who.id = 'm2'
    who.roles = []
    const user = userEvent.setup()
    renderGantt()
    expect(screen.queryByTestId('gantt-view-only')).not.toBeInTheDocument()
    await open(user, /MS1-1/, /Cover sheet/)
    expect(screen.getByLabelText('Owner for Draft the cover')).toBeInTheDocument()
  })
})

describe('no task creation anywhere on the Gantt', () => {
  it.each([['member', []], ['president', ['president']], ['developer', ['developer']]] as const)(
    'never offers a create form or "Add to Board", even to a %s',
    async (_label, roles) => {
      who.roles = [...roles]
      const user = userEvent.setup()
      renderGantt()
      await open(user, /MS1-1/, /Cover sheet/, /Unsectioned work/)
      expect(screen.queryByLabelText(/New subtask for/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /add to board/i })).not.toBeInTheDocument()
      expect(screen.queryByText(/add to board/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    },
  )
})

describe('the department lens', () => {
  it('uses the shared control and filters tasks while the milestone → section structure stays', async () => {
    const user = userEvent.setup()
    renderGantt('/gantt?dept=AERO')
    expect(screen.getByLabelText('Department')).toHaveValue('AERO')
    await open(user, /MS1-1/, /Cover sheet/)
    // The AERO task stays; the BODY task in the SAME section is filtered out, but the section remains.
    expect(screen.getByTestId('gantt-task-t1')).toBeInTheDocument()
    expect(screen.queryByTestId('gantt-task-t2')).not.toBeInTheDocument()
    expect(screen.getByTestId('gantt-section-sec1')).toBeInTheDocument()
  })

  it('shows the filtered figure beside the overall one and never changes the overall one', () => {
    const { unmount } = renderGantt()
    const before = screen.getByTestId('gantt-overall-MS1-1').textContent
    expect(screen.queryByTestId('gantt-lens-MS1-1')).not.toBeInTheDocument()
    unmount()
    renderGantt('/gantt?dept=AERO')
    expect(screen.getByTestId('gantt-overall-MS1-1').textContent).toBe(before)
    // AERO tasks linked to MS1-1: t1, t3, t4, a1, a2 (t2 is BODY) → 1 done of 5.
    expect(screen.getByTestId('gantt-lens-MS1-1')).toHaveTextContent('Aerodynamics: 1 of 5 done')
    expect(screen.getByTestId('gantt-lens-note')).toHaveTextContent('Each submission keeps its overall progress')
  })

  it('says so, deliberately, when a submission has no work for the chosen department', () => {
    renderGantt('/gantt?dept=BODY')
    expect(screen.getByTestId('gantt-lens-MS1-2')).toHaveTextContent('Bodywork: no linked work')
    expect(screen.getByTestId('gantt-lens-MS1-7')).toHaveTextContent('Bodywork: no linked work')
    // The submission itself is still there, with its overall figure.
    expect(screen.getByTestId('gantt-overall-MS1-2')).toBeInTheDocument()
  })

  it('keeps an empty section visible and says what the filter hid', async () => {
    const user = userEvent.setup()
    renderGantt('/gantt?dept=BODY')
    await open(user, /MS1-2/, /Loads/)
    expect(screen.getByTestId('gantt-section-empty-secB')).toHaveTextContent('Nothing for Bodywork in this section (1 task hidden by the filter)')
  })

  it('"My tasks" means tasks owned by the viewer', async () => {
    who.id = 'm3'
    const user = userEvent.setup()
    renderGantt('/gantt?scope=mine')
    await open(user, /MS1-1/, /Cover sheet/)
    expect(screen.getByTestId('gantt-task-t2')).toBeInTheDocument()
    expect(screen.queryByTestId('gantt-task-t1')).not.toBeInTheDocument()
    expect(screen.getByTestId('gantt-lens-MS1-1')).toHaveTextContent('My tasks: 0 of 1 done')
  })

  it('an unknown department in the address falls back to everything and says so', () => {
    renderGantt('/gantt?dept=NOPE')
    expect(screen.getByTestId('gantt-filter-notice')).toBeInTheDocument()
    expect(screen.getByLabelText('Department')).toHaveValue('all')
    expect(screen.queryByTestId('gantt-lens-MS1-1')).not.toBeInTheDocument()
  })

  it('changing the department applies the lens and leaves the overall figure alone', async () => {
    const user = userEvent.setup()
    renderGantt()
    const before = screen.getByTestId('gantt-overall-MS1-1').textContent
    await user.selectOptions(screen.getByLabelText('Department'), 'BODY')
    expect(screen.getByLabelText('Department')).toHaveValue('BODY')
    expect(screen.getByTestId('gantt-lens-MS1-1')).toHaveTextContent('Bodywork: 0 of 1 done')
    expect(screen.getByTestId('gantt-overall-MS1-1').textContent).toBe(before)
  })
})

describe('reading the chart without colour, and with a keyboard', () => {
  it('has a legend, behind a Legend disclosure, that explains every shape in words', async () => {
    const user = userEvent.setup()
    renderGantt()
    const toggle = screen.getByTestId('gantt-legend-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('gantt-legend')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const legend = screen.getByTestId('gantt-legend')
    expect(toggle).toHaveAttribute('aria-controls', legend.id)
    for (const text of [/Today/, /Submission window/, /Submission deadline/, /Task period/, /Task deadline, no start date/, /Task start, no deadline/, /Overdue, still open/, /Done/]) {
      expect(within(legend).getByText(text)).toBeInTheDocument()
    }
    expect(legend).toHaveTextContent('Nothing is estimated')
  })

  it('gives every bar and marker a sentence a screen reader can read', async () => {
    const user = userEvent.setup()
    renderGantt()
    expect(screen.getByTestId('gantt-milestone-MS1-1')).toHaveTextContent('MS1-1 Team Plan: submission window 1 Nov 2026 to 30 Nov 2026, deadline 30 Nov 2026')
    expect(screen.getByTestId('gantt-milestone-MS1-7')).toHaveTextContent('MS1-7 Final Event: deadline TBC (not yet published)')
    await open(user, /MS1-1/, /Cover sheet/)
    expect(screen.getByTestId('gantt-section-sec1')).toHaveTextContent('Cover sheet: 1 of 4 tasks done')
  })

  it('has a written summary of the whole chart', () => {
    renderGantt()
    const summary = screen.getByTestId('gantt-summary')
    expect(summary).toHaveTextContent('3 submissions.')
    expect(summary).toHaveTextContent('Next deadline: MS1-1 on 30 Nov 2026.')
    // Linked, live: t1 t2 t3 t4 t7 = 5; undated: t4; overdue: t3.
    expect(summary).toHaveTextContent('5 linked tasks (1 undated, 1 overdue)')
    expect(summary).toHaveTextContent('Progress counts archived done work')
  })

  it('scrolls sideways in a region a keyboard can reach', () => {
    renderGantt()
    const region = screen.getByRole('region', { name: 'Timeline, scrolls sideways' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toHaveClass('overflow-x-auto')
  })

  it('opens and closes submissions and sections from the keyboard, with aria-expanded', async () => {
    const user = userEvent.setup()
    renderGantt()
    const toggle = screen.getByRole('button', { name: /MS1-1/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    toggle.focus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const section = screen.getByRole('button', { name: /Cover sheet/ })
    section.focus()
    await user.keyboard(' ')
    expect(section).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(section).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps Expand all and the month/week scale', async () => {
    const user = userEvent.setup()
    renderGantt()
    const monthly = screen.getByTestId('gantt-months').children.length
    await user.selectOptions(screen.getByLabelText('Scale'), 'week')
    expect(screen.getByTestId('gantt-months').children.length).toBeGreaterThan(monthly)
    await user.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getByTestId('gantt-section-sec1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument()
  })
})

describe('loading and errors', () => {
  it('offers a retry when the submissions cannot be loaded', () => {
    state.loadError = new Error('boom')
    renderGantt()
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})

describe('keyboard alternatives to dragging (UI-06)', () => {
  const details = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
    await user.click(screen.getByRole('button', { name: `Show details of ${title}` }))
    return within(screen.getByTestId('gantt-task-more-t1'))
  }

  it('changes a deadline from the task\'s own date fields, sending only the dates', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    const panel = await details(user, 'Draft the cover')
    const due = panel.getByLabelText('Deadline')
    await user.clear(due)
    await user.type(due, '2026-11-28')
    await user.click(panel.getByRole('button', { name: 'Save dates' }))
    expect(updateTaskAsync).toHaveBeenCalledWith({ id: 't1', dueDate: '2026-11-28' })
    expect(await panel.findByTestId('gantt-date-result-t1')).toHaveTextContent('Saved: deadline.')
  })

  it('clears a deadline for real, and refuses a start after the deadline without sending anything', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    const panel = await details(user, 'Draft the cover')
    await user.clear(panel.getByLabelText('Start date'))
    await user.type(panel.getByLabelText('Start date'), '2026-12-01')
    await user.click(panel.getByRole('button', { name: 'Save dates' }))
    expect(updateTaskAsync).not.toHaveBeenCalled()
    expect(await panel.findByTestId('gantt-date-result-t1')).toHaveTextContent('The start date must be on or before the deadline.')

    await user.clear(panel.getByLabelText('Start date'))
    await user.clear(panel.getByLabelText('Deadline'))
    await user.click(panel.getByRole('button', { name: 'Save dates' }))
    expect(updateTaskAsync).toHaveBeenCalledWith({ id: 't1', dueDate: null, startsOn: null })
  })

  it('moves a task to a section of the same submission with "Move to" — the same write as dropping it there', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    const panel = await details(user, 'Draft the cover')
    await user.selectOptions(panel.getByLabelText('Move to'), 'MS1-1 · no section')
    expect(updateTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', sectionId: null }))
    expect(screen.queryByTestId('gantt-move-confirm')).not.toBeInTheDocument()
  })

  it('asks before moving a task to another submission, and writes nothing until confirmed', async () => {
    const user = userEvent.setup()
    renderGantt()
    await open(user, /MS1-1/, /Cover sheet/)
    const panel = await details(user, 'Draft the cover')
    const other = Array.from((panel.getByLabelText('Move to') as HTMLSelectElement).options).find((o) => o.textContent?.startsWith('MS1-2 ·') && !o.textContent.includes('no section'))!
    await user.selectOptions(panel.getByLabelText('Move to'), other.value)
    expect(updateTask).not.toHaveBeenCalled()
    const confirm = within(screen.getByTestId('gantt-move-confirm'))
    expect(confirm.getByText(/changes its milestone and section together/)).toBeInTheDocument()
    await user.click(confirm.getByRole('button', { name: 'Move it' }))
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', milestoneKey: 'MS1-2' }))
  })
})

describe('subsections, prerequisites and blockers', () => {
  const SUB = { id: 'sub1', milestone_key: 'MS1-1', ordinal: 3, name: 'Line items', is_drafted: false, owner_id: null, updated_at: '', parent_section_id: 'sec2' }

  it('draws a subsection under its parent section only, never as a top-level section', async () => {
    deps.extraSections = [SUB]
    tasks.push(task('t9', { title: 'Itemise the budget', section_id: 'sub1', milestone_key: 'MS1-1', due_date: '2026-11-20' }))
    const user = userEvent.setup()
    renderGantt('/gantt?open=MS1-1')
    const top = within(screen.getByTestId('gantt-milestone-MS1-1'))
    expect(top.getByTestId('gantt-section-sec2')).toBeInTheDocument()
    // Before the parent is opened its subsection is folded away, like a section's tasks.
    expect(top.queryByRole('button', { name: /Line items/ })).not.toBeInTheDocument()
    await user.click(top.getByRole('button', { name: /Budget/ }))
    await user.click(top.getByRole('button', { name: /Line items/ }))
    const sub = within(screen.getByTestId('gantt-section-sub1'))
    expect(sub.getByTestId('gantt-task-t9')).toBeInTheDocument()
    // The parent's own list does not show the subsection's task twice.
    expect(within(screen.getByTestId('gantt-section-sec2')).getAllByTestId('gantt-task-t9')).toHaveLength(1)
  })

  it('counts a subsection\'s tasks in its parent section\'s progress, once', async () => {
    deps.extraSections = [SUB]
    tasks.push(task('t9', { title: 'Itemise the budget', section_id: 'sub1', milestone_key: 'MS1-1', state: 'done' }))
    renderGantt('/gantt?open=MS1-1')
    const parentRow = screen.getByTestId('gantt-section-sec2')
    expect(within(parentRow).getByLabelText('Budget done').closest('label')).toHaveTextContent('1/1')
  })

  it('offers a subsection as a place to move a task, by name, from the keyboard-reachable select', async () => {
    deps.extraSections = [SUB]
    const user = userEvent.setup()
    renderGantt('/gantt?open=MS1-1&sections=sec1&task=t1')
    const select = within(screen.getByTestId('gantt-task-more-t1')).getByLabelText('Move to')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toContain('MS1-1 · Budget › Line items')
    await user.selectOptions(select, within(select).getByRole('option', { name: 'MS1-1 · Budget › Line items' }))
    expect(updateTask).toHaveBeenCalledWith({ id: 't1', sectionId: 'sub1', milestoneKey: 'MS1-1' })
  })

  it('shows what a task waits for, flags a schedule conflict, and never invents a link', async () => {
    tasks.push(task('t9', { title: 'Order the carbon', subteam_key: 'BODY', owner_id: 'm3', due_date: '2026-11-24', milestone_key: 'MS1-1', section_id: 'sec1' }))
    deps.links = [{ task_id: 't1', depends_on_task_id: 't9' }]
    renderGantt('/gantt?open=MS1-1&sections=sec1&task=t1')
    expect(screen.getByTestId('gantt-waits-t1')).toHaveTextContent('Waits for 1')
    const more = within(screen.getByTestId('gantt-task-more-t1'))
    expect(more.getByTestId('gantt-prereqs-t1')).toHaveTextContent('Order the carbon')
    // t1 starts 20 Nov, its prerequisite is due 24 Nov: advisory conflict.
    expect(more.getByTestId('gantt-conflict-t1-t9')).toBeInTheDocument()
    expect(screen.queryByTestId('gantt-waits-t2')).not.toBeInTheDocument()
  })

  it('asks for a reason before blocking a task with no prerequisite, then sends it with the state', async () => {
    const user = userEvent.setup()
    renderGantt('/gantt?open=MS1-1&sections=sec1')
    await user.selectOptions(screen.getByLabelText('Move Draft the cover to another lane'), 'blocked')
    expect(updateTask).not.toHaveBeenCalled()
    const form = within(screen.getByTestId('gantt-block-form-t1'))
    await user.type(form.getByLabelText(/Why is/), 'Waiting for the printer')
    await user.click(form.getByRole('button', { name: 'Block task' }))
    expect(updateTask).toHaveBeenCalledWith({ id: 't1', state: 'blocked', blockedReason: 'Waiting for the printer' })
  })

  it('shows a blocked task\'s written reason, or says none was kept', async () => {
    tasks.push(task('t10', { title: 'Blocked with reason', state: 'blocked', blocked_reason: 'Sponsor has not paid', section_id: 'sec1', milestone_key: 'MS1-1' }))
    renderGantt('/gantt?open=MS1-1&sections=sec1&task=t10')
    expect(screen.getByTestId('gantt-blocker-t10')).toHaveTextContent('Sponsor has not paid')
  })
})
