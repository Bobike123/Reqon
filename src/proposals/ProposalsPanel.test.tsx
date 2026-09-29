import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proposal } from '../data/useProposals.ts'

// The panel composed for real (form, filters, cards, dialog) over mocked DATA
// hooks. Authorization is decided by the real permission functions from the
// mocked session and the mocked departments' Heads, never by a flag in the test.

const session = { id: 'me', status: 'active' as 'active' | 'alumni', roles: [] as string[] }
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: session.id }, member: { id: session.id, status: session.status }, roles: session.roles }),
}))

type Dept = { key: string; name: string; lead_id: string | null; archived_at: string | null }
const DEPARTMENTS: Dept[] = [
  { key: 'AERO', name: 'Aerodynamics', lead_id: 'me', archived_at: null },
  { key: 'BODY', name: 'Bodywork', lead_id: 'other', archived_at: null },
  { key: 'OLD', name: 'Retired dept', lead_id: null, archived_at: '2026-01-01' },
]
let departments: Dept[] = DEPARTMENTS
vi.mock('../data/useSubteams.ts', () => ({ useSubteams: () => ({ data: departments, isLoading: false, error: null }) }))
let memberRows = [{ id: 'me', full_name: 'Me Myself', status: 'active' }, { id: 'other', full_name: 'Other Person', status: 'active' }]
vi.mock('../data/useMembers.ts', () => ({
  useMembers: () => ({ data: memberRows, isLoading: false, error: null }),
}))
vi.mock('../data/useMilestones.ts', () => ({
  useMilestones: () => ({ data: [{ key: 'MS1', name: 'Plan' }], isLoading: false, error: null }),
}))
vi.mock('../data/useClauses.ts', () => ({
  useClauses: () => ({ data: [{ clause_key: 'A.1', printed_ref: 'A.1', body: 'Rule', section: 'A', article: 1, article_title: null }], isLoading: false, error: null }),
}))
vi.mock('../data/useTasks.ts', () => ({ useTasks: () => ({ data: [], isLoading: false, error: null }) }))
vi.mock('../data/useProposals.ts', () => ({
  useProposalRequirements: () => ({ data: [], isLoading: false, error: null }),
  useProposalComments: () => ({ data: [], isLoading: false, error: null }),
  useSubmitProposal: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useReviseProposal: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetProposalDepartment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddProposalComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRequestProposalChanges: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useApproveProposal: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReviewProposal: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePromoteProposal: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetProposalRequirements: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const { ProposalsPanel } = await import('./ProposalsPanel.tsx')

function p(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id, season_id: 's', title: id, context: null, state: 'open', owner_id: null, decision: null, decided_at: null,
    meeting_id: null, starred: false, raised_by: 'other', raised_on: '2026-01-01', updated_at: '', subteam_key: 'AERO',
    due_date: '2026-12-01', priority: 'normal', milestone_key: 'MS1', outcome: null, archived_at: null,
    archived_by: null, archive_reason: null, legacy_incomplete: false,
    approved_as: null, approved_at: null, approved_by: null, approved_digest: null, approved_revision: null, revision: 1, ...over,
  }
}

let rows: Proposal[]
function renderPanel(mode: 'queue' | 'full' = 'full', url = '/proposals') {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <ProposalsPanel
          heading="Proposals"
          mode={mode}
          emptyHint="Nothing here."
          layout="wide"
          proposals={{ data: rows, isLoading: false, error: null, refetch: vi.fn() } as never}
          realtime="live"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const shownIds = () =>
  Array.from(document.querySelectorAll('[data-proposal-state]'))
    .map((el) => el.getAttribute('data-testid')!.replace('proposal-', ''))
    .sort()

beforeEach(() => {
  session.id = 'me'
  session.status = 'active'
  session.roles = []
  departments = DEPARTMENTS
  memberRows = [{ id: 'me', full_name: 'Me Myself', status: 'active' }, { id: 'other', full_name: 'Other Person', status: 'active' }]
  rows = [
    p('mine-aero', { raised_by: 'me' }),
    p('theirs-aero'),
    p('mine-body', { raised_by: 'me', subteam_key: 'BODY' }),
    p('owned-not-mine', { owner_id: 'me', subteam_key: 'BODY' }),
    p('rejected', { state: 'decided', outcome: 'rejected', archived_at: '2026-09-01', subteam_key: 'OLD' }),
  ]
})

describe('Scope x Department', () => {
  it('shows all four live proposals by default', () => {
    renderPanel()
    expect(shownIds()).toEqual(['mine-aero', 'mine-body', 'owned-not-mine', 'theirs-aero'])
  })

  it.each([
    ['My proposals', '', ['mine-aero', 'mine-body']],
    ['All proposals', 'AERO', ['mine-aero', 'theirs-aero']],
    ['My proposals', 'BODY', ['mine-body']],
    ['All proposals', 'BODY', ['mine-body', 'owned-not-mine']],
  ])('%s + department "%s"', async (scope, dept, expected) => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(within(screen.getByTestId('proposal-scope')).getByRole('button', { name: new RegExp(scope) }))
    if (dept) await user.selectOptions(screen.getByLabelText('Department'), dept)
    expect(shownIds()).toEqual([...expected])
  })

  it('"My proposals" means authored by me, not proposed to me', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: /My proposals/ }))
    expect(shownIds()).not.toContain('owned-not-mine')
  })

  it('says so when nothing matches, and Clear filters brings everything back', async () => {
    const user = userEvent.setup()
    rows = rows.filter((r) => r.raised_by !== 'me')
    renderPanel()
    await user.click(screen.getByRole('button', { name: /My proposals/ }))
    const empty = await screen.findByTestId('proposal-empty-list')
    expect(empty).toHaveTextContent('No proposals match these filters')
    expect(screen.getByTestId('proposal-filter-summary')).toHaveTextContent('Showing 0 · My proposals · All departments')
    await user.click(within(empty).getByRole('button', { name: 'Clear filters' }))
    expect(shownIds()).toEqual(['owned-not-mine', 'theirs-aero'])
  })

  it('lists at most the active departments in the queue', () => {
    renderPanel()
    const options = within(screen.getByLabelText('Department')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['All departments', 'Aerodynamics', 'Bodywork'])
  })
})

describe('the History path', () => {
  it('holds rejected work, including work of an archived department, and lists that department', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(within(screen.getByTestId('proposal-views')).getByRole('button', { name: /History/ }))
    expect(shownIds()).toEqual(['rejected'])
    const options = within(screen.getByLabelText('Department')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toContain('Retired dept (archived)')
    await user.selectOptions(screen.getByLabelText('Department'), 'OLD')
    expect(shownIds()).toEqual(['rejected'])
  })

  it('the queue-only panel (Now) has no History switch, and never lists decided work', () => {
    renderPanel('queue')
    expect(screen.queryByTestId('proposal-views')).not.toBeInTheDocument()
    expect(shownIds()).not.toContain('rejected')
  })
})

describe('who sees review controls (resource-aware)', () => {
  const reviewable = () => screen.queryAllByTestId(/^review-open-/)
    .filter((element) => element.textContent === 'Review')
    .map((element) => element.getAttribute('data-testid')!.replace('review-open-', '')).sort()

  it('a Head reviews only their own department; everything else stays readable with an explanation', () => {
    renderPanel()
    expect(reviewable()).toEqual(['mine-aero', 'theirs-aero'])
    expect(screen.getByTestId('proposal-hint-mine-body')).toHaveTextContent('The Head of Bodywork, or a Developer')
  })

  it('the President and Vice President alone get no review or promotion control', () => {
    departments = DEPARTMENTS.map((d) => ({ ...d, lead_id: 'other' }))
    for (const role of ['president', 'vicepresident']) {
      session.roles = [role]
      const { unmount } = renderPanel()
      expect(reviewable()).toEqual([])
      unmount()
    }
  })

  it('the President becomes fallback when the assigned Head is no longer active', () => {
    departments = DEPARTMENTS.map((d) => ({ ...d, lead_id: d.archived_at ? null : 'other' }))
    memberRows = memberRows.map((member) => member.id === 'other' ? { ...member, status: 'alumni' } : member)
    session.roles = ['president']
    renderPanel()
    expect(reviewable()).toEqual(['mine-aero', 'mine-body', 'owned-not-mine', 'theirs-aero'])
    expect(screen.getByTestId('proposal-review-queue')).toHaveTextContent('governance fallback where no active Head exists')
  })

  it('a President who is ALSO the department Head gets the control for that department only', () => {
    session.roles = ['president']
    renderPanel()
    expect(reviewable()).toEqual(['mine-aero', 'theirs-aero'])
  })

  it('a Developer may review everything, including an older proposal with no department', () => {
    departments = DEPARTMENTS.map((d) => ({ ...d, lead_id: 'someone-else' }))
    session.roles = ['developer']
    rows.push(p('no-dept', { subteam_key: null, legacy_incomplete: true, due_date: null, milestone_key: null }))
    renderPanel()
    expect(reviewable()).toEqual(['mine-aero', 'mine-body', 'no-dept', 'owned-not-mine', 'theirs-aero'])
  })

  it('a retired Head or Developer gets nothing', () => {
    session.status = 'alumni'
    session.roles = ['developer']
    renderPanel()
    expect(reviewable()).toEqual([])
  })

  it('an older proposal without a department is a Developer matter for everyone else', () => {
    rows = [p('no-dept', { subteam_key: null, legacy_incomplete: true, due_date: null, milestone_key: null })]
    renderPanel()
    expect(screen.getByTestId('review-open-no-dept')).toHaveTextContent('Discussion')
    expect(screen.getByTestId('proposal-hint-no-dept')).toHaveTextContent('A Developer completes the details')
    expect(screen.getByTestId('proposal-legacy-no-dept')).toHaveTextContent(/needs a department, a deadline, a milestone and at least one requirement/)
  })

  it('opens the review dialog as a labelled modal (real focus behaviour is checked in a browser)', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByTestId('review-open-mine-aero'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName(/Proposal “mine-aero”/)
    expect((dialog as HTMLDialogElement).open).toBe(true)
  })
})

describe('Needs your review', () => {
  it('lists exactly the open proposals this Head may decide, and nothing from departments they do not head', () => {
    rows = [
      p('mine-open', { subteam_key: 'AERO' }),
      p('mine-agenda', { subteam_key: 'AERO', state: 'agenda' }),
      p('mine-accepted', { subteam_key: 'AERO', state: 'decided', outcome: 'approved' }),
      p('theirs', { subteam_key: 'BODY' }),
    ]
    renderPanel()
    const queue = within(screen.getByTestId('proposal-review-queue'))
    expect(queue.getByTestId('proposal-review-count')).toHaveTextContent('2')
    expect(queue.getByTestId('review-queue-mine-open')).toBeInTheDocument()
    expect(queue.getByTestId('review-queue-mine-agenda')).toBeInTheDocument()
    expect(queue.queryByTestId('review-queue-theirs')).not.toBeInTheDocument()
    expect(queue.queryByTestId('review-queue-mine-accepted')).not.toBeInTheDocument()
  })

  it('is not shown to a member who heads nothing', () => {
    departments = DEPARTMENTS.map((d) => ({ ...d, lead_id: d.lead_id === 'me' ? 'other' : d.lead_id }))
    rows = [p('x', { subteam_key: 'AERO' })]
    renderPanel()
    expect(screen.queryByTestId('proposal-review-queue')).not.toBeInTheDocument()
    departments = DEPARTMENTS
  })

  it("shows the member's own proposals with their status", () => {
    rows = [p('raised-by-me', { raised_by: 'me', state: 'decided', outcome: 'rejected', decision: 'Not this season' }), p('not-mine')]
    renderPanel()
    const mine = within(screen.getByTestId('proposal-mine'))
    expect(mine.getByText('raised-by-me')).toBeInTheDocument()
    expect(mine.queryByText('not-mine')).not.toBeInTheDocument()
  })

  it('reads its filter from the address, so a shared link or a refresh keeps it', () => {
    rows = [p('aero-1', { subteam_key: 'AERO' }), p('body-1', { subteam_key: 'BODY' })]
    renderPanel('full', '/proposals?dept=BODY&task=keep')
    expect(shownIds()).toEqual(['body-1'])
  })
})
