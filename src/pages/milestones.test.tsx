import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

// The Milestones screen shows the same linked-work figure as the Gantt, from the
// same shared function, and labels its own drafting checklist as a checklist.

const MILESTONES = [
  { key: 'M1', name: 'Team Plan', season_id: 's', ordinal: 1, opens_on: '2099-11-01', due_on: '2099-11-30', max_points: 75, is_blocking: false, aim: null, article_ref: null, notes: null },
  { key: 'M2', name: 'Empty one', season_id: 's', ordinal: 2, opens_on: null, due_on: null, max_points: 10, is_blocking: false, aim: null, article_ref: null, notes: null },
]
const SECTIONS = [{ id: 's1', milestone_key: 'M1', ordinal: 1, name: 'Cover', is_drafted: true, owner_id: null, updated_at: '' }]
const row = (id: string, over: Record<string, unknown>) => ({ id, state: 'todo', archived_at: null, section_id: null, milestone_key: 'M1', ...over })
const progress = { data: undefined as unknown[] | undefined }
const extra = vi.hoisted(() => ({
  clauses: [] as Record<string, unknown>[],
  loadError: null as Error | null,
  refetch: vi.fn(),
  drafted: vi.fn(),
}))

vi.mock('../data/useClauses.ts', () => ({ useClauses: () => ({ data: extra.clauses, isLoading: false, error: null }) }))
vi.mock('../data/useMilestones.ts', () => ({
  useMilestones: () => ({ data: MILESTONES, isLoading: false, error: extra.loadError, refetch: extra.refetch }),
  useMilestoneSections: () => ({ data: SECTIONS, isLoading: false, error: null, refetch: vi.fn() }),
  useSetSectionDrafted: () => ({ mutate: extra.drafted, isError: false, error: null }),
}))
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
    expect(screen.getByTestId('linked-M1')).toHaveTextContent('1 of 1 sections drafted (no tasks linked)')
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
    expect(screen.getByTestId('sections-M1')).toHaveTextContent('1/1')
    await userEvent.click(screen.getByRole('button', { name: /M1 Team Plan/ }))
    expect(screen.getByText(/Drafting checklist — sections drafted/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Cover/ })).toBeChecked()
    expect(screen.getByText(/a checklist tick, not task completion/)).toBeInTheDocument()
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
