import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { JobTitleSelect } from './JobTitleSelect.tsx'

function setup(props: Partial<Parameters<typeof JobTitleSelect>[0]> = {}) {
  const onChange = vi.fn()
  render(
    <JobTitleSelect
      id="t"
      label="Job title for Bo Wrench"
      titles={['Chassis', 'Member']}
      value="Chassis"
      onChange={onChange}
      {...props}
    />,
  )
  return { onChange }
}

describe('JobTitleSelect', () => {
  it('shows a saved title that is not on the list, rather than the first option', () => {
    setup({ value: 'chassis' })
    const select = screen.getByLabelText<HTMLSelectElement>('Job title for Bo Wrench')
    expect(select.value).toBe('chassis')
  })

  it('adds a title that does not exist yet', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.selectOptions(
      screen.getByLabelText('Job title for Bo Wrench'),
      screen.getByRole('option', { name: 'Add a new job title…' }),
    )
    await user.type(screen.getByLabelText('New job title for this person'), '  Powertrain  ')
    await user.click(screen.getByRole('button', { name: 'Use it' }))
    expect(onChange).toHaveBeenCalledWith('Powertrain')
  })

  it('will not save an empty title over a real one', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.selectOptions(
      screen.getByLabelText('Job title for Bo Wrench'),
      screen.getByRole('option', { name: 'Add a new job title…' }),
    )
    await user.click(screen.getByRole('button', { name: 'Use it' }))
    // members.role is NOT NULL: the schema default stands in for nothing typed.
    expect(onChange).toHaveBeenCalledWith('Member')
  })

  it('backs out with Cancel without changing anything', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.selectOptions(
      screen.getByLabelText('Job title for Bo Wrench'),
      screen.getByRole('option', { name: 'Add a new job title…' }),
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText<HTMLSelectElement>('Job title for Bo Wrench').value).toBe('Chassis')
  })
})
