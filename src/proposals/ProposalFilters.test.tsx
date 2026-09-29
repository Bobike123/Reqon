import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProposalFilters } from './ProposalFilters.tsx'
import { DEFAULT_FILTER, type ProposalFilter } from './filters.ts'

const departments = [
  { key: 'AERO', label: 'Aerodynamics' },
  { key: 'BODY', label: 'Bodywork' },
]

function setup(filter: ProposalFilter = DEFAULT_FILTER, over: Partial<Parameters<typeof ProposalFilters>[0]> = {}) {
  const onChange = vi.fn()
  render(
    <ProposalFilters
      filter={filter}
      onChange={onChange}
      counts={{ all: 7, mine: 2 }}
      departments={departments}
      showViews
      viewCounts={{ queue: 7, history: 3 }}
      shown={7}
      {...over}
    />,
  )
  return onChange
}

describe('ProposalFilters', () => {
  it('shows All/My with their counts and marks the current one pressed', () => {
    setup()
    const scope = screen.getByTestId('proposal-scope')
    expect(within(scope).getByRole('button', { name: /All proposals \(7\)/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(scope).getByRole('button', { name: /My proposals \(2\)/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('changes scope, department and view without losing the other two', async () => {
    const user = userEvent.setup()
    const onChange = setup({ scope: 'mine', department: 'AERO', view: 'queue' })
    await user.click(screen.getByRole('button', { name: /All proposals/ }))
    expect(onChange).toHaveBeenLastCalledWith({ scope: 'all', department: 'AERO', view: 'queue' })
    await user.selectOptions(screen.getByLabelText('Department'), 'BODY')
    expect(onChange).toHaveBeenLastCalledWith({ scope: 'mine', department: 'BODY', view: 'queue' })
    await user.click(screen.getByRole('button', { name: /History/ }))
    expect(onChange).toHaveBeenLastCalledWith({ scope: 'mine', department: 'AERO', view: 'history' })
  })

  it('uses a native select for the department, listing All plus each department', () => {
    setup()
    const select = screen.getByLabelText('Department')
    expect(select.tagName).toBe('SELECT')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All departments', 'Aerodynamics', 'Bodywork'])
  })

  it('says in words what is being shown and clears back to the default, keeping the view', async () => {
    const user = userEvent.setup()
    const onChange = setup({ scope: 'mine', department: 'AERO', view: 'history' }, { shown: 0 })
    expect(screen.getByTestId('proposal-filter-summary')).toHaveTextContent('Showing 0 · My proposals · Aerodynamics · History')
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onChange).toHaveBeenCalledWith({ scope: 'all', department: 'all', view: 'history' })
  })

  it('offers no Clear button when nothing is filtered, and no view switch when the screen has none', () => {
    setup(DEFAULT_FILTER, { showViews: false })
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('proposal-views')).not.toBeInTheDocument()
  })

  it('is built mobile-first: buttons wrap, the select is full width, touch targets are tall', () => {
    setup()
    expect(screen.getByTestId('proposal-scope').className).toMatch(/flex-wrap/)
    expect(screen.getByLabelText('Department').className).toMatch(/min-h-11.*w-full|w-full.*min-h-11/)
  })
})
