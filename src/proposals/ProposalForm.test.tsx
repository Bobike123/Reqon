import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ProposalForm } from './ProposalForm.tsx'
import { buildRequirementOptions } from './requirementOptions.ts'

const requirements = buildRequirementOptions([
  { clause_key: 'A.1', printed_ref: 'A.1', body: 'The vehicle must fit.', section: 'A', article: 1, article_title: null },
  { clause_key: 'B.2', printed_ref: 'B.2', body: 'Fairing width is limited.', section: 'B', article: 2, article_title: null },
])
const base = {
  departments: [{ value: 'AERO', label: 'Aerodynamics' }],
  milestones: [{ value: 'MS1', label: 'MS1 — Team plan' }],
  owners: [{ value: 'm2', label: 'Bo Wrench' }],
  requirements,
  pending: false,
  canConfigure: false,
}

function renderForm(over: Partial<Parameters<typeof ProposalForm>[0]> = {}, onRaise = vi.fn().mockResolvedValue(undefined)) {
  render(
    <MemoryRouter>
      <ProposalForm {...base} onRaise={onRaise} {...over} />
    </MemoryRouter>,
  )
  return onRaise
}

async function fillAll(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Title/), '  Mount the wing  ')
  await user.selectOptions(screen.getByLabelText(/^Department/), 'AERO')
  fireEvent.change(screen.getByLabelText(/^Deadline/), { target: { value: '2026-12-01' } })
  await user.selectOptions(screen.getByLabelText(/^Related milestone/), 'MS1')
  await user.click(screen.getByRole('checkbox', { name: /A\.1/ }))
}

describe('the proposal form fields', () => {
  it('defaults to normal priority, offers only Normal and Urgent, and never chooses a deadline', () => {
    renderForm()
    const priority = screen.getByLabelText('Priority') as HTMLSelectElement
    expect(priority.value).toBe('normal')
    expect(within(priority).getAllByRole('option').map((o) => o.textContent)).toEqual(['Normal', 'Urgent'])
    expect(screen.getByLabelText(/^Deadline/)).toHaveValue('')
  })

  it('marks the mandatory fields and leaves description and owner optional', () => {
    renderForm()
    for (const label of [/^Title/, /^Department/, /^Deadline/, /^Related milestone/]) {
      expect(screen.getByLabelText(label)).toBeRequired()
    }
    expect(screen.getByLabelText('Description (optional)')).not.toBeRequired()
    expect(screen.getByLabelText(/^Proposed owner/)).not.toBeRequired()
    expect(screen.getByLabelText(/^Proposed owner/)).toHaveValue('')
  })

  it('submits the trimmed values with the chosen requirement keys, description and owner optional', async () => {
    const user = userEvent.setup()
    const onRaise = renderForm()
    await fillAll(user)
    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))
    await waitFor(() => expect(onRaise).toHaveBeenCalledTimes(1))
    expect(onRaise).toHaveBeenCalledWith({
      title: 'Mount the wing',
      description: null,
      departmentKey: 'AERO',
      dueDate: '2026-12-01',
      milestoneKey: 'MS1',
      requirementKeys: ['A.1'],
      priority: 'normal',
      ownerId: null,
    })
  })
})

describe('each required field refuses on its own', () => {
  it.each(['title', 'department', 'dueDate', 'milestone', 'requirement'] as const)('missing %s', async (problem) => {
    const user = userEvent.setup()
    const onRaise = renderForm()
    await fillAll(user)
    // Undo just one field.
    if (problem === 'title') await user.clear(screen.getByLabelText(/^Title/))
    if (problem === 'department') await user.selectOptions(screen.getByLabelText(/^Department/), '')
    if (problem === 'dueDate') fireEvent.change(screen.getByLabelText(/^Deadline/), { target: { value: '' } })
    if (problem === 'milestone') await user.selectOptions(screen.getByLabelText(/^Related milestone/), '')
    if (problem === 'requirement') await user.click(screen.getByRole('checkbox', { name: /A\.1/ }))
    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))

    expect(onRaise).not.toHaveBeenCalled()
    expect(await screen.findByTestId(`error-${problem}`)).toBeInTheDocument()
    expect(screen.getByTestId('proposal-summary')).toHaveTextContent('One thing needs fixing')
    // The other four fields report nothing.
    expect(screen.getAllByTestId(/^error-/)).toHaveLength(1)
  })
})

describe('accessibility of errors', () => {
  it('moves focus to the summary, links each item to its field, and ties the message to the input', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))
    const summary = await screen.findByTestId('proposal-summary')
    expect(summary).toHaveFocus()
    expect(summary).toHaveAttribute('role', 'alert')
    expect(summary).toHaveTextContent('5 things need fixing')

    const title = screen.getByLabelText(/^Title/)
    expect(title).toHaveAttribute('aria-invalid', 'true')
    const describedBy = title.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)).toHaveTextContent(/Enter a title/)

    await user.click(within(summary).getByRole('link', { name: /Choose the department/ }))
    expect(screen.getByLabelText(/^Department/)).toHaveFocus()
  })
})

describe('failure and repeat submission', () => {
  it('keeps the entered values and shows the reason when the server refuses', async () => {
    const user = userEvent.setup()
    const onRaise = vi.fn().mockRejectedValueOnce(new Error('A proposal can only be raised to an active department.'))
    renderForm({}, onRaise)
    await fillAll(user)
    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))
    expect(await screen.findByTestId('proposal-server-error')).toHaveTextContent('active department')
    expect(screen.getByLabelText(/^Title/)).toHaveValue('  Mount the wing  ')
    expect(screen.getByLabelText(/^Deadline/)).toHaveValue('2026-12-01')
    expect(screen.getByRole('checkbox', { name: /A\.1/ })).toBeChecked()
  })

  it('does not submit again while one is pending', async () => {
    const user = userEvent.setup()
    const onRaise = renderForm({ pending: true })
    await user.click(screen.getByRole('button', { name: 'Raising…' }))
    expect(onRaise).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/^Title/)).toBeDisabled()
  })
})

describe('honest empty states', () => {
  it('says what is missing and points a governance user to Settings', () => {
    renderForm({ departments: [], milestones: [], canConfigure: true })
    expect(screen.getByTestId('proposal-empty')).toHaveTextContent('there is no active department and no milestone for this season yet')
    expect(screen.getByRole('link', { name: /Open Settings/ })).toHaveAttribute('href', '/settings')
    expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument()
  })

  it('offers everyone else no link, only who can fix it', () => {
    renderForm({ requirements: [], canConfigure: false })
    expect(screen.getByTestId('proposal-empty')).toHaveTextContent('requirements book')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByTestId('proposal-empty')).toHaveTextContent('President or Vice President')
  })

  it('does not call a still-loading list empty, and reports a load failure', () => {
    renderForm({ departments: [], loading: true })
    expect(screen.getByTestId('proposal-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('proposal-empty')).not.toBeInTheDocument()
  })

  it('reports a load failure instead of an empty form', () => {
    renderForm({ loadError: 'network down' })
    expect(screen.getByTestId('proposal-load-error')).toHaveTextContent('network down')
  })
})
