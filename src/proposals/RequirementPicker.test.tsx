import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { RequirementPicker } from './RequirementPicker.tsx'
import { buildRequirementOptions } from './requirementOptions.ts'

const options = buildRequirementOptions([
  { clause_key: 'A.1', printed_ref: 'A.1', body: 'The vehicle must fit.', section: 'A', article: 1, article_title: 'General' },
  { clause_key: 'B.2#1', printed_ref: 'B.2', body: 'Fairing width is limited.', section: 'B', article: 2, article_title: 'Bodywork' },
  { clause_key: 'B.2#2', printed_ref: 'B.2', body: 'Another rule with the same printed reference.', section: 'B', article: 2, article_title: 'Bodywork' },
])

function Harness({ initial = [] as string[] }) {
  const [selected, setSelected] = useState(initial)
  return (
    <>
      <RequirementPicker id="r" options={options} selected={selected} onChange={setSelected} />
      <output data-testid="value">{selected.join(',')}</output>
    </>
  )
}

describe('RequirementPicker', () => {
  it('selects several requirements and keeps clause_key as the value', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('checkbox', { name: /A\.1 — The vehicle/ }))
    await user.click(screen.getByRole('checkbox', { name: /Fairing width/ }))
    expect(screen.getByTestId('value')).toHaveTextContent('A.1,B.2#1')
  })

  it('narrows the list as you type and says how many are shown', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    await user.type(screen.getByLabelText('Find a requirement'), 'fairing')
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.getByTestId('requirement-count')).toHaveTextContent('1 shown')
    await user.clear(screen.getByLabelText('Find a requirement'))
    await user.type(screen.getByLabelText('Find a requirement'), 'zzzz')
    expect(screen.getByTestId('requirement-count')).toHaveTextContent('No requirement matches')
  })

  it('tells two requirements with the same printed reference apart, and selects each on its own', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const first = screen.getByRole('checkbox', { name: /key B\.2#1/ })
    const second = screen.getByRole('checkbox', { name: /key B\.2#2/ })
    await user.click(second)
    expect(first).not.toBeChecked()
    expect(second).toBeChecked()
    // The chip carries the key too, so the two chips are distinguishable.
    expect(within(screen.getByTestId('chosen-requirements')).getByText('B.2 (key B.2#2)')).toBeInTheDocument()
  })

  it('removes a chosen requirement from its chip with a labelled button', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['A.1', 'B.2#1']} />)
    await user.click(screen.getByRole('button', { name: /Remove requirement A\.1$/ }))
    expect(screen.getByTestId('value')).toHaveTextContent('B.2#1')
  })

  it('can be operated from the keyboard alone', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    screen.getByLabelText('Find a requirement').focus()
    await user.keyboard('bodywork')
    await user.tab()
    expect(screen.getAllByRole('checkbox')[0]).toHaveFocus()
    await user.keyboard(' ')
    expect(screen.getByTestId('value')).toHaveTextContent('B.2#1')
  })
})
