import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

// The Milestones screen shows the same linked-work figure as the Gantt, from the
// same shared function, and labels its own drafting checklist as a checklist.

const MILESTONES = [
  { key: 'M1', code: 'M1', name: 'Team Plan', season_id: 's', ordinal: 1, opens_on: '2099-11-01', due_on: '2099-11-30', max_points: 75, is_blocking: false, aim: null, article_ref: null, notes: null, submitted_on: null, submitted_by: null, accepted_on: null, accepted_by: null },
  { key: 'M2', code: 'M2', name: 'Empty one', season_id: 's', ordinal: 2, opens_on: null, due_on: null, max_points: 10, is_blocking: false, aim: null, article_ref: null, notes: null, submitted_on: null, submitted_by: null, accepted_on: null, accepted_by: null },
]
const SECTIONS = [
  { id: 's1', milestone_key: 'M1', ordinal: 1, name: 'Cover', is_drafted: true, owner_id: null, updated_at: '', parent_section_id: null },
  { id: 's1a', milestone_key: 'M1', ordinal: 2, name: 'Artwork', is_drafted: false, owner_id: null, updated_at: '', parent_section_id: 's1' },
]
const row = (id: string, over: Record<string, unknown>) => ({ id, state: 'todo', archived_at: null, section_id: null, milestone_key: 'M1', ...over })
const progress = { data: undefined as unknown[] | undefined }
const extra = vi.hoisted(() => ({
  clauses: [] as Record<string, unknown>[],
  loadError: null as Error | null,
  refetch: vi.fn(),
  drafted: vi.fn(),
  submission: vi.fn(),
  canRecord: false,
  submissions: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('../data/useClauses.ts', () => ({ useClauses: () => ({ data: extra.clauses, isLoading: false, error: null }) }))
vi.mock('../data/useMilestones.ts', () => ({
  useMilestones: () => ({ data: MILESTONES.map((m) => ({ ...m, ...(extra.submissions[m.key] ?? {}) })), isLoading: false, error: extra.loadError, refetch: extra.refetch }),
  useMilestoneSections: () => ({ data: SECTIONS, isLoading: false, error: null, refetch: vi.fn() }),
  useSetSectionDrafted: () => ({ mutate: extra.drafted, isError: false, error: null }),
  useSetMilestoneSubmission: () => ({ mutate: extra.submission, isPending: false, error: null }),
}))
vi.mock('../auth/usePermissions.ts', () => ({ usePermissions: () => ({ canManageMilestoneStructure: extra.canRecord }) }))
vi.mock('../data/useMembers.ts', () => ({ useMembers: () => ({ data: [{ id: 'm1', full_name: 'Ada Rider', status: 'active' }], isLoading: false, error: null }) }))
vi.mock('../data/useSubteams.ts', () => ({ useSubteams: () => ({ data: [{ key: 'GEOM', name: 'Design Envelope', archived_at: null }], isLoading: false, error: null }) }))
vi.mock('../data/useRealtimeMilestoneSections.ts', () => ({ useRealtimeMilestoneSections: () => 'live' }))
vi.mock('../data/useRealtimeMilestones.ts', () => ({ useRealtimeMilestones: () => 'live' }))
vi.mock('../data/useTaskHistory.ts', () => ({ useTasksForProgress: () => ({ data: progress.data, isLoading: !progress.data, error: null }) }))

const { default: Milestones } = await import('./Milestones.tsx')

const renderPage = () => render(<MemoryRouter><Milestones /></MemoryRouter>)

describe('Milestones: linked work', () => {
  it('shows linked-task progress counting archived Done work, the same figure as the Gantt', () => {
    progress.data = [
      row('a', { state: 'done', archived_at: '2026-10-01T00:00:00Z', section_id: 's1' }),
      row('b', { state: 'done' }),
      row('c', {}),
    ]
    renderPage()
    expect(screen.getByTestId('linked-M1')).toHaveTextContent('Linked work: 2 of 3 tasks done, incl. 1 archived done')
  })

  it('does not call a submission with no tasks "0%": it falls back to the drafting checklist, labelled', () => {
    progress.data = []
    renderPage()
    expect(screen.getByTestId('linked-M1')).toHaveTextContent('1 of 2 sections drafted (no tasks linked)')
    expect(screen.getByTestId('linked-M2')).toHaveTextContent('No linked work')
  })

  it('says it is loading rather than "No linked work" while the progress list has not arrived', () => {
    progress.data = undefined
    renderPage()
    expect(screen.getByTestId('linked-M2')).toHaveTextContent('Linked work: loading…')
    expect(screen.queryByText('No linked work')).not.toBeInTheDocument()
  })

  it('names the checklist as a drafting checklist, not as task progress', async () => {
    progress.data = []
    renderPage()
    expect(screen.getByTestId('sections-M1')).toHaveTextContent('1/2')
    await userEvent.click(screen.getByRole('button', { name: /M1 Team Plan/ }))
    expect(screen.getByText(/Drafting checklist — sections drafted/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Cover/ })).toBeChecked()
    expect(screen.getAllByText(/a checklist tick, not task completion/).length).toBeGreaterThanOrEqual(1)
  })
})

describe('Milestones: ordered expandable rows', () => {
  it('lists the submissions in their published order, collapsed, with a TBC window when none is published', () => {
    progress.data = []
    renderPage()
    const buttons = screen.getAllByRole('button', { expanded: false })
    expect(buttons.map((b) => b.textContent)).toEqual(['▸M1 Team Plan', '▸M2 Empty one'])
    expect(screen.getByTestId('window-M2')).toHaveTextContent('Window: TBC')
  })

  it('opens into its sections and the tasks under each, with their state, and links to the Gantt group', async () => {
    progress.data = [
      row('a', { title: 'Cover drawing', state: 'done', section_id: 's1', owner_id: 'm1', subteam_key: 'GEOM' }),
      row('b', { title: 'Loose note', state: 'blocked', owner_id: null, subteam_key: null }),
      row('c', { title: 'Old unfinished', state: 'wip', archived_at: '2026-10-01T00:00:00Z', section_id: 's1' }),
    ]
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: /M1 Team Plan/ }))
    const panel = screen.getByTestId('milestone-M1')
    expect(within(panel).getByRole('link', { name: 'Cover drawing' })).toHaveAttribute('href', '/board?task=a')
    expect(panel).toHaveTextContent('Done · Ada Rider · Design Envelope')
    expect(panel).toHaveTextContent('Linked to M1 without a section')
    expect(panel).toHaveTextContent('Blocked · unassigned · no department')
    // Archived unfinished work stays visible, marked, and leads to the Archive.
    expect(within(panel).getByRole('link', { name: 'Old unfinished' })).toHaveAttribute('href', '/archive?tab=tasks&id=c')
    expect(panel).toHaveTextContent('archived, not finished')
    expect(within(panel).getByRole('link', { name: 'Open M1 on the Gantt' })).toHaveAttribute('href', '/gantt?open=M1')
  })

  it('never presents a full bar as a submission or a score', () => {
    progress.data = [row('b', { state: 'done' })]
    renderPage()
    expect(screen.getByTestId('linked-M1')).toHaveTextContent('1 of 1 tasks done')
    expect(screen.getByText(/does not mean a submission was sent or accepted/)).toBeInTheDocument()
  })
})

describe('Milestones: work, submission and acceptance are three facts', () => {
  it('reads "Not recorded" for both submitted and accepted even when every task is done', () => {
    progress.data = [row('b', { state: 'done' })]
    renderPage()
    expect(screen.getByTestId('work-M1')).toHaveTextContent('1 of 1 tasks done')
    expect(screen.getByTestId('submitted-M1')).toHaveTextContent('Not recorded')
    expect(screen.getByTestId('accepted-M1')).toHaveTextContent('Not recorded')
  })

  it('shows a recorded submission and acceptance with their dates and who recorded them, apart from the bar', () => {
    progress.data = []
    extra.submissions = { M1: { submitted_on: '2099-11-20', submitted_by: 'm1', accepted_on: '2099-11-25', accepted_by: 'm1' } }
    renderPage()
    expect(screen.getByTestId('submitted-M1')).toHaveTextContent('20 Nov 2099 · Ada Rider')
    expect(screen.getByTestId('accepted-M1')).toHaveTextContent('25 Nov 2099 · Ada Rider')
    expect(screen.getByTestId('submitted-M2')).toHaveTextContent('Not recorded')
    extra.submissions = {}
  })

  it('offers no control to record them to someone who may not, and a form to someone who may', async () => {
    progress.data = []
    const { unmount } = renderPage()
    expect(screen.queryByTestId('submission-edit-M1')).not.toBeInTheDocument()
    unmount()
    extra.canRecord = true
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId('submission-edit-M1'))
    await user.type(screen.getByLabelText('Submitted on'), '2020-01-10')
    await user.type(screen.getByLabelText('Accepted on'), '2020-01-12')
    await user.click(screen.getByRole('button', { name: /Save record for M1/ }))
    expect(extra.submission).toHaveBeenCalledWith({ key: 'M1', submittedOn: '2020-01-10', acceptedOn: '2020-01-12' }, expect.anything())
    extra.canRecord = false
  })

  it('refuses an acceptance before the submission, or without one, before anything is sent', async () => {
    progress.data = []
    extra.canRecord = true
    extra.submission.mockClear()
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId('submission-edit-M1'))
    await user.type(screen.getByLabelText('Accepted on'), '2020-01-12')
    expect(screen.getByTestId('submission-problem-M1')).toHaveTextContent('before it was submitted')
    expect(screen.getByRole('button', { name: /Save record for M1/ })).toBeDisabled()
    await user.type(screen.getByLabelText('Submitted on'), '2020-01-14')
    expect(screen.getByTestId('submission-problem-M1')).toHaveTextContent('cannot be before the submission date')
    expect(extra.submission).not.toHaveBeenCalled()
    extra.canRecord = false
  })

  it('nests a subsection under its parent section, with its own tick', async () => {
    progress.data = []
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: /M1 Team Plan/ }))
    const sub = screen.getByTestId('milestone-section-s1a')
    expect(sub).toHaveTextContent('subsection')
    expect(screen.getByTestId('milestone-section-s1')).toBeInTheDocument()
  })
})

describe('Milestones: reference text, errors and the drafting tick', () => {
  it('shows the F.14 format rules and penalties from the imported clauses, in book order', () => {
    extra.clauses = [
      { clause_key: 'F.14.2.2', printed_ref: 'F.14.2.2', body: 'Use A4.' },
      { clause_key: 'F.14.2.1', printed_ref: 'F.14.2.1', body: 'Use PDF.' },
      { clause_key: 'F.14.3.1', printed_ref: 'F.14.3.1', body: 'Late costs points.' },
      { clause_key: 'B.1.1.1', printed_ref: 'B.1.1.1', body: 'Unrelated.' },
    ]
    renderPage()
    expect(within(screen.getByTestId('format-table')).getAllByRole('rowheader').map((c) => c.textContent)).toEqual(['F.14.2.1', 'F.14.2.2'])
    expect(within(screen.getByTestId('penalty-table')).getByText('Late costs points.')).toBeInTheDocument()
    expect(screen.queryByText('Unrelated.')).not.toBeInTheDocument()
    extra.clauses = []
  })

  it('says it could not load, with a retry, instead of an empty list', async () => {
    extra.loadError = new Error('network down')
    renderPage()
    expect(screen.getByText('Could not load milestones')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(extra.refetch).toHaveBeenCalled()
    extra.loadError = null
  })

  it('ticks a section as drafted through its own command, and nothing else', async () => {
    progress.data = []
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: /M1 Team Plan/ }))
    await user.click(screen.getByRole('checkbox', { name: /Cover/ }))
    expect(extra.drafted).toHaveBeenCalledWith({ id: 's1', isDrafted: false })
  })
})
