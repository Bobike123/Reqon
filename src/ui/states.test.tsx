import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EmptyState, ErrorState, LoadingState } from './states.tsx'

describe('the three states', () => {
  it('announces loading to assistive tech', () => {
    render(<LoadingState label="Loading the rulebook…" />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading the rulebook…')
  })

  it('announces an error and offers the way out', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(<ErrorState title="Could not load the board" error={new Error('connection lost')} onRetry={onRetry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('connection lost')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('tells the reader what would fill an empty screen', () => {
    render(<EmptyState title="Nothing is biting">Star a rule to put it here.</EmptyState>)
    expect(screen.getByText('Nothing is biting')).toBeInTheDocument()
    expect(screen.getByText('Star a rule to put it here.')).toBeInTheDocument()
  })
})

// --- The recovery path, end to end on a real screen --------------------------

let failReads = true
let attempts = 0

const supabase = {
  from: () => {
    const ctx: { single: boolean } = { single: false }
    const b: Record<string, unknown> = {
      select: () => b, order: () => b, eq: () => b, in: () => b, range: () => b, limit: () => b,
      single: () => { ctx.single = true; return b },
      maybeSingle: () => { ctx.single = true; return b },
      then: (resolve: (v: unknown) => void) => {
        attempts += 1
        if (failReads) resolve({ data: null, error: { message: 'connection lost', code: '08006' } })
        else resolve({ data: ctx.single ? { id: 's1', label: '2026/27' } : [], error: null })
        return Promise.resolve()
      },
    }
    return b
  },
  channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  removeChannel: () => {},
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1', full_name: 'Ada', is_board: true } }),
}))

const { default: Board } = await import('../pages/Board.tsx')

beforeEach(() => { failReads = true; attempts = 0 })

describe('a screen that fails to load', () => {
  function renderBoard() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><Board /></MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('never shows a blank page — it explains and offers Try again', async () => {
    renderBoard()
    expect(await screen.findByText('Could not load the board')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('connection lost')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(document.body.textContent?.trim().length).toBeGreaterThan(30)
  })

  it('actually recovers when the cause clears', async () => {
    const user = userEvent.setup()
    renderBoard()
    await screen.findByRole('button', { name: 'Try again' })

    failReads = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    // The lanes come back — the retry refetches rather than just clearing the message.
    await waitFor(() => expect(screen.getByTestId('lane-todo')).toBeInTheDocument())
    expect(screen.queryByText('Could not load the board')).not.toBeInTheDocument()
  })

  it('retrying issues a fresh request', async () => {
    const user = userEvent.setup()
    renderBoard()
    await screen.findByRole('button', { name: 'Try again' })
    const before = attempts
    failReads = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(attempts).toBeGreaterThan(before))
  })
})
