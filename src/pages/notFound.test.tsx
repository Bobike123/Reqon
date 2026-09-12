import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Renders the REAL route table. The point is App.tsx's catch-all: without it an
// unmatched address rendered the header above an empty page, with no way out.
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({
    status: 'member',
    user: { id: 'm1' },
    member: { id: 'm1', full_name: 'Ada Rider' },
    roles: [],
    signOut: vi.fn(),
  }),
}))
vi.mock('../data/useCurrentSeason.ts', () => ({
  useCurrentSeason: () => ({ data: { id: 's1', label: '2026/27' } }),
}))

const { default: App } = await import('../App.tsx')

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => window.localStorage.setItem('reqon.tutorial.v2', 'completed'))

describe('an address that is not a screen', () => {
  it('says so and offers a way back, instead of a blank page', async () => {
    renderAt('/nonsense')
    expect(await screen.findByRole('heading', { name: 'That screen does not exist' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'go to Now' })).toHaveAttribute('href', '/')
  })

  it('covers the two placeholder routes that used to exist', async () => {
    renderAt('/hello')
    expect(await screen.findByRole('heading', { name: 'That screen does not exist' })).toBeInTheDocument()
  })
})
