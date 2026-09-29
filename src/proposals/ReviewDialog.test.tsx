import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proposal } from '../data/useProposals.ts'
import { buildRequirementOptions } from './requirementOptions.ts'

// The hooks are replaced by fakes that behave like the database commands: they
// record the ORDER of calls, and they REFUSE (reject) exactly where the real
// command refuses. Nothing here pretends an unauthorized operation succeeded.
const calls: string[] = []
let failOn: string | null = null
const fake = (name: string) => async (args: unknown) => {
  calls.push(`${name} ${JSON.stringify(args)}`)
  // A real command takes time; a second click can arrive while it is running.
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (failOn === name) throw new Error(`${name} refused by the database`)
  return name === 'promote' ? { task: { id: 't1' }, created: true } : {}
}
vi.mock('../data/useProposals.ts', () => ({
  useUpdateProposal: () => ({ mutateAsync: fake('update'), isPending: false }),
  useReviewProposal: () => ({ mutateAsync: fake('review'), isPending: false }),
  usePromoteProposal: () => ({ mutateAsync: fake('promote'), isPending: false }),
  useSetProposalRequirements: () => ({ mutateAsync: fake('requirements'), isPending: false }),
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
    archived_at: null, archived_by: null, archive_reason: null, legacy_incomplete: false, ...over,
  }
}

function open(p: Proposal, over: Partial<Parameters<typeof ReviewDialog>[0]> = {}) {
  const onClose = vi.fn()
  const onDone = vi.fn()
  render(
    <ReviewDialog
      proposal={p}
      members={members}
      departments={[{ value: 'AERO', label: 'Aerodynamics' }, { value: 'BODY', label: 'Bodywork' }]}
      milestones={[{ value: 'MS1', label: 'MS1 — Plan' }, { value: 'MS2', label: 'MS2 — Build' }]}
      requirementOptions={options}
      requirementKeys={['A.1']}
      isDeveloper={false}
      hasTask={false}
      onClose={onClose}
      onDone={onDone}
      {...over}
    />,
  )
  return { onClose, onDone, dialog: within(screen.getByRole('dialog')) }
}

beforeEach(() => {
  calls.length = 0
  failOn = null
})

describe('ReviewDialog: approving', () => {
  it('approves a complete proposal with exactly one promote call and no other write', async () => {
    const user = userEvent.setup()
    const { dialog, onDone, onClose } = open(proposal())
    await user.click(dialog.getByTestId('review-approve'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls).toEqual([expect.stringMatching(/^promote /)])
    expect(onDone.mock.calls[0][0]).toContain('is on the Board')
    expect(onDone.mock.calls[0][1]).toEqual({ toBoard: true })
    expect(onClose).toHaveBeenCalled()
  })

  it('saves a changed deadline and owner BEFORE promoting, so the chosen deadline is never dropped', async () => {
    const user = userEvent.setup()
    const { dialog } = open(proposal())
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2027-02-01' } })
    await user.selectOptions(dialog.getByLabelText('Owner'), 'm2')
    await user.click(dialog.getByTestId('review-approve'))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]).toContain('update')
    expect(calls[0]).toContain('"dueDate":"2027-02-01"')
    expect(calls[0]).toContain('"ownerId":"m2"')
    expect(calls[1]).toMatch(/^promote /)
    expect(calls[1]).toContain('"ownerId":"m2"')
  })

  it('lists only active members as owners', () => {
    const { dialog } = open(proposal())
    const names = within(dialog.getByLabelText('Owner')).getAllByRole('option').map((o) => o.textContent)
    expect(names).toEqual(['Nobody yet', 'Ada Rider', 'Bo Wrench'])
  })

  it('stays open with its values and the reason when the save is refused, and never promotes', async () => {
    const user = userEvent.setup()
    failOn = 'update'
    const { dialog, onClose } = open(proposal())
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2027-02-01' } })
    await user.click(dialog.getByTestId('review-approve'))
    expect(await screen.findByText(/update refused by the database/)).toBeInTheDocument()
    expect(calls.some((c) => c.startsWith('promote'))).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.getByLabelText('Deadline')).toHaveValue('2027-02-01')
  })

  it('shows a refusal of the promotion itself and keeps the dialog', async () => {
    const user = userEvent.setup()
    failOn = 'promote'
    const { dialog, onDone } = open(proposal())
    await user.click(dialog.getByTestId('review-approve'))
    expect(await screen.findByText(/promote refused by the database/)).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
    expect(dialog.getByTestId('review-approve')).toBeEnabled()
  })

  it('disables Approve while working, so a second click cannot start a second call', async () => {
    const user = userEvent.setup()
    const { dialog } = open(proposal())
    await user.dblClick(dialog.getByTestId('review-approve'))
    await waitFor(() => expect(calls.filter((c) => c.startsWith('promote')).length).toBe(1))
  })
})

describe('ReviewDialog: what blocks an older proposal', () => {
  const legacy = () => proposal({ legacy_incomplete: true, due_date: null, milestone_key: null })

  it('names exactly the missing fields and disables Approve until they exist', async () => {
    const user = userEvent.setup()
    const { dialog } = open(legacy(), { requirementKeys: [] })
    expect(dialog.getByTestId('review-legacy')).toHaveTextContent('still needs a deadline, a milestone and at least one requirement')
    expect(dialog.getByTestId('review-approve')).toBeDisabled()

    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2026-11-01' } })
    expect(dialog.getByTestId('review-legacy')).toHaveTextContent('still needs a milestone and at least one requirement')
    await user.selectOptions(dialog.getByLabelText('Milestone'), 'MS1')
    await user.click(dialog.getByRole('checkbox', { name: /A\.1/ }))
    expect(dialog.getByTestId('review-approve')).toBeEnabled()
  })

  it('saves fields, then requirements, then promotes — in that order', async () => {
    const user = userEvent.setup()
    const { dialog } = open(legacy(), { requirementKeys: [] })
    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2026-11-01' } })
    await user.selectOptions(dialog.getByLabelText('Milestone'), 'MS1')
    await user.click(dialog.getByRole('checkbox', { name: /A\.1/ }))
    await user.click(dialog.getByTestId('review-approve'))
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['update', 'requirements', 'promote'])
    expect(calls[1]).toContain('"clauseKeys":["A.1"]')
  })

  it('lets only a Developer choose a missing department, and tells everyone else', async () => {
    const noDept = () => proposal({ legacy_incomplete: true, subteam_key: null })
    const first = open(noDept())
    expect(first.dialog.queryByLabelText('Department')?.tagName).not.toBe('SELECT')
    expect(first.dialog.getByTestId('review-legacy')).toHaveTextContent('Only a Developer can choose its department')
    expect(first.dialog.getByTestId('review-approve')).toBeDisabled()
  })

  it('offers a Developer the department select and saves the choice', async () => {
    const user = userEvent.setup()
    const { dialog } = open(proposal({ legacy_incomplete: true, subteam_key: null }), { isDeveloper: true })
    await user.selectOptions(dialog.getByLabelText('Department'), 'BODY')
    await user.click(dialog.getByTestId('review-approve'))
    await waitFor(() => expect(calls.length).toBeGreaterThan(1))
    expect(calls[0]).toContain('"departmentKey":"BODY"')
  })
})

describe('ReviewDialog: park, reject and reopen', () => {
  it('parks in one step and says where the proposal went', async () => {
    const user = userEvent.setup()
    const { dialog, onDone } = open(proposal({ state: 'agenda' }))
    await user.click(dialog.getByTestId('review-park'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls).toEqual(['review {"id":"p1","action":"park"}'])
    expect(onDone.mock.calls[0][0]).toMatch(/parked.*Parked/)
  })

  it('asks before rejecting, and only rejects on the explicit confirmation', async () => {
    const user = userEvent.setup()
    const { dialog, onDone } = open(proposal())
    await user.click(dialog.getByTestId('review-reject'))
    expect(calls).toEqual([])
    expect(dialog.getByText('Reject this proposal?')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Keep it' }))
    expect(calls).toEqual([])
    await user.click(dialog.getByTestId('review-reject'))
    await user.click(dialog.getByRole('button', { name: 'Yes, reject it' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls).toEqual(['review {"id":"p1","action":"reject"}'])
    expect(onDone.mock.calls[0][0]).toContain('moved to History')
  })

  it('offers only Reopen for a parked proposal, and never Approve', () => {
    const { dialog } = open(proposal({ state: 'parked' }))
    expect(dialog.getByTestId('review-reopen')).toBeInTheDocument()
    expect(dialog.queryByTestId('review-approve')).not.toBeInTheDocument()
    expect(dialog.queryByTestId('review-reject')).not.toBeInTheDocument()
  })

  it('shows a rejected proposal read-only with its note, and offers Reopen', () => {
    const { dialog } = open(proposal({ state: 'decided', outcome: 'rejected', archived_at: '2026-09-01', decision: 'no budget' }))
    expect(dialog.getByTestId('review-status')).toHaveTextContent('Rejected')
    expect(dialog.getByText(/no budget/)).toBeInTheDocument()
    expect(dialog.queryByLabelText('Deadline')).not.toBeInTheDocument()
    expect(dialog.getByTestId('review-reopen')).toBeInTheDocument()
  })

  it('saves a change on its own with Save details, and is disabled when nothing changed', async () => {
    const user = userEvent.setup()
    const { dialog, onDone } = open(proposal())
    expect(dialog.getByTestId('review-save')).toBeDisabled()
    await user.selectOptions(dialog.getByLabelText('Priority'), 'urgent')
    await user.click(dialog.getByTestId('review-save'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls).toEqual(['update {"id":"p1","priority":"urgent"}'])
  })
})

describe('ReviewDialog: dialog behaviour', () => {
  it('is a labelled modal dialog and closes from its Close button', async () => {
    const user = userEvent.setup()
    const { onClose } = open(proposal())
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName('Review “Mount the wing”')
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})
