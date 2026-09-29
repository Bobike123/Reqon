import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { mergeSearchParams } from './searchParams.ts'
import { useUrlParams } from './useUrlParams.ts'

function Probe() {
  const [params, update] = useUrlParams()
  const location = useLocation()
  return (
    <>
      <output data-testid="search">{location.search}</output>
      <output data-testid="rule">{params.get('rule') ?? ''}</output>
      <button
        type="button"
        onClick={() => {
          // Close the reader, then type — before the first navigation commits.
          update((current) => mergeSearchParams(current, { rule: null }), { replace: true })
          update((current) => mergeSearchParams(current, { search: 'E.5.4.5' }), { replace: true })
        }}
      >
        two quick writes
      </button>
    </>
  )
}

describe('useUrlParams (F14-15)', () => {
  it('builds each write on the one before it, so a quick second write never brings back what the first removed', async () => {
    render(
      <MemoryRouter initialEntries={['/register?search=B.9&rule=B.9.1.2&group=owner']}>
        <Probe />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('rule')).toHaveTextContent('B.9.1.2')
    await userEvent.click(screen.getByRole('button', { name: 'two quick writes' }))
    expect(screen.getByTestId('search')).toHaveTextContent('?search=E.5.4.5&group=owner')
    expect(screen.getByTestId('rule')).toHaveTextContent('')
  })
})
