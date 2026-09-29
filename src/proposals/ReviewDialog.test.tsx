import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proposal, ProposalComment } from '../data/useProposals.ts'
import { buildRequirementOptions } from './requirementOptions.ts'

const calls: string[] = []
let failOn: string | null = null
const fake = (name: string) => async (args: unknown) => {
  calls.push(`${name} ${JSON.stringify(args)}`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  if (failOn === name) throw new Error(`${name} refused by the database`)
  if (name === 'promote') return { task: { id: 't1' }, created: true }
  return { id: 'p1', revision: 3 }
}
vi.mock('../data/useProposals.ts', () => ({
  useReviseProposal: () => ({ mutateAsync: fake('revise') }),
  useSetProposalDepartment: () => ({ mutateAsync: fake('move') }),
  useAddProposalComment: () => ({ mutateAsync: fake('comment') }),
  useRequestProposalChanges: () => ({ mutateAsync: fake('request') }),
  useApproveProposal: () => ({ mutateAsync: fake('approve') }),
  useReviewProposal: () => ({ mutateAsync: fake('review') }),
  usePromoteProposal: () => ({ mutateAsync: fake('promote') }),
}))

const { ReviewDialog } = await import('./ReviewDialog.tsx')
const options = buildRequirementOptions([
  { clause_key: 'A.1', printed_ref: 'A.1', body: 'The vehicle must fit.', section: 'A', article: 1, article_title: null },
  { clause_key: 'B.2', printed_ref: 'B.2', body: 'Fairing width is limited.', section: 'B', article: 2, article_title: null },
])
const members = [
  { id: 'm1', full_name: 'Ada Rider', status: 'active' },
  { id: 'm2', full_name: 'Bo Wrench', status: 'active' },
  { id: 'm3', full_name: 'Old Timer', status: 'alumni' },
] as never

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1', season_id: 's', title: 'Mount the wing', context: 'why', state: 'open', owner_id: null, decision: null,
    decided_at: null, meeting_id: null, starred: false, raised_by: 'm2', raised_on: '2026-01-01', updated_at: '',
    subteam_key: 'AERO', due_date: '2026-12-01', priority: 'normal', milestone_key: 'MS1', outcome: null,
    archived_at: null, archived_by: null, archive_reason: null, legacy_incomplete: false, revision: 2,
    approved_revision: null, approved_by: null, approved_at: null, approved_as: null, approved_digest: null, ...over,
  }
}
const discussion: ProposalComment[] = [{
  id: 'c1', proposal_id: 'p1', season_id: 's', author_id: 'm2', kind: 'changes_requested', revision: 2,
  body: 'Please explain the deadline.', created_at: '2026-09-29T10:00:00Z',
}]

function open(p: Proposal, over: Partial<Parameters<typeof ReviewDialog>[0]> = {}) {
  const onClose = vi.fn()
  const onDone = vi.fn()
  render(<ReviewDialog
    proposal={p} comments={discussion} members={members}
    departments={[{ value: 'AERO', label: 'Aerodynamics' }, { value: 'BODY', label: 'Bodywork' }]}
    milestones={[{ value: 'MS1', label: 'MS1 — Plan' }, { value: 'MS2', label: 'MS2 — Build' }]}
    requirementOptions={options} requirementKeys={['A.1']} canReview isAuthor={false} isDeveloper={false}
    hasTask={false} onClose={onClose} onDone={onDone} {...over}
  />)
  return { onClose, onDone, dialog: within(screen.getByRole('dialog')) }
}

beforeEach(() => { calls.length = 0; failOn = null })

describe('ReviewDialog discussion and revision', () => {
  it('shows attributed discussion and lets a member add a comment', async () => {
    const user = userEvent.setup()
    const { dialog } = open(proposal(), { canReview: false, isAuthor: false })
    expect(dialog.getByTestId('proposal-discussion')).toHaveTextContent('Bo Wrench')
    expect(dialog.getByTestId('proposal-discussion')).toHaveTextContent('revision 2')
    await user.type(dialog.getByLabelText('Add a comment'), 'Here is the evidence')
    await user.click(dialog.getByTestId('review-comment'))
    await waitFor(() => expect(calls).toEqual(['comment {"id":"p1","body":"Here is the evidence"}']))
  })

  it('saves fields and requirements atomically against the revision the editor saw', async () => {
    const user = userEvent.setup()
    const { dialog, onDone } = open(proposal())
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2027-02-01' } })
    await user.click(dialog.getByRole('checkbox', { name: /B\.2/ }))
    await user.type(dialog.getByLabelText('Revision note (optional)'), 'Updated scope')
    await user.click(dialog.getByTestId('review-save'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls[0]).toContain('revise')
    expect(calls[0]).toContain('"expectedRevision":2')
    expect(calls[0]).toContain('"dueDate":"2027-02-01"')
    expect(calls[0]).toContain('"requirementKeys":["A.1","B.2"]')
  })

  it('keeps rejected values in the dialog and exposes the database error', async () => {
    const user = userEvent.setup()
    failOn = 'revise'
    const { dialog, onClose } = open(proposal())
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2027-02-01' } })
    await user.click(dialog.getByTestId('review-save'))
    expect(await screen.findByText(/revise refused by the database/)).toBeInTheDocument()
    expect(dialog.getByLabelText('Deadline')).toHaveValue('2027-02-01')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not partially save a department move together with other content', async () => {
    const user = userEvent.setup()
    const { dialog } = open(proposal())
    await user.selectOptions(dialog.getByLabelText('Department'), 'BODY')
    await user.selectOptions(dialog.getByLabelText('Priority'), 'urgent')
    await user.type(dialog.getByLabelText('Why this department changes'), 'Different scope')
    await user.click(dialog.getByTestId('review-save'))
    expect(await screen.findByText(/Save the department move separately/)).toBeInTheDocument()
    expect(calls).toEqual([])
  })
})

describe('ReviewDialog approval and promotion', () => {
  it('requires a review note, approves only, and does not create a task in the same click', async () => {
    const user = userEvent.setup()
    const { dialog, onDone } = open(proposal())
    expect(dialog.getByTestId('review-approve')).toBeDisabled()
    await user.type(dialog.getByLabelText('Review note'), 'Checked against the plan')
    await user.click(dialog.getByTestId('review-approve'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls).toEqual(['approve {"id":"p1","expectedRevision":2,"note":"Checked against the plan"}'])
    expect(calls.some((call) => call.startsWith('promote'))).toBe(false)
  })

  it('offers task creation only for the approved revision', async () => {
    const user = userEvent.setup()
    const { dialog, onDone } = open(proposal({ state: 'approved', approved_revision: 2, approved_by: 'm1',
      approved_at: '2026-09-29T10:00:00Z', approved_as: 'head', approved_digest: 'digest' }))
    expect(dialog.queryByTestId('review-approve')).not.toBeInTheDocument()
    await user.click(dialog.getByTestId('review-promote'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls).toEqual([expect.stringMatching(/^promote /)])
    expect(onDone.mock.calls[0][1]).toEqual({ toBoard: true })
  })

  it('records a change request separately from comments and edits', async () => {
    const user = userEvent.setup()
    const { dialog } = open(proposal({ state: 'agenda' }))
    await user.type(dialog.getByLabelText('Review note'), 'Add test evidence')
    await user.click(dialog.getByTestId('review-request-changes'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toBe('request {"id":"p1","expectedRevision":2,"note":"Add test evidence"}')
  })

  it('prevents a double click from starting two approvals', async () => {
    const user = userEvent.setup()
    const { dialog } = open(proposal())
    await user.type(dialog.getByLabelText('Review note'), 'Reviewed')
    await user.dblClick(dialog.getByTestId('review-approve'))
    await waitFor(() => expect(calls.filter((call) => call.startsWith('approve')).length).toBe(1))
  })
})

describe('ReviewDialog permissions and states', () => {
  it('lets the author revise but does not show review actions', async () => {
    const user = userEvent.setup()
    const { dialog } = open(proposal(), { canReview: false, isAuthor: true })
    await user.selectOptions(dialog.getByLabelText('Priority'), 'urgent')
    expect(dialog.getByTestId('review-save')).toBeEnabled()
    expect(dialog.queryByTestId('review-approve')).not.toBeInTheDocument()
  })

  it('parks and reopens with the same expected revision contract', async () => {
    const user = userEvent.setup()
    const first = open(proposal({ state: 'agenda' }))
    await user.click(first.dialog.getByTestId('review-park'))
    await waitFor(() => expect(calls[0]).toBe('review {"id":"p1","action":"park","expectedRevision":2,"note":""}'))
  })

  it('is labelled and closes without writing', async () => {
    const user = userEvent.setup()
    const { onClose } = open(proposal())
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Proposal “Mount the wing”')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
