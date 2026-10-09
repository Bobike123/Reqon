import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Files from './Files.tsx'

// The Files page over a fake Supabase client: the season query, the signed thumbnail links, the filters.
const h = vi.hoisted(() => ({ rows: [] as unknown[], error: null as unknown, invoke: vi.fn() }))

vi.mock('../lib/supabase.ts', () => ({
  supabase: {
    from: () => {
      let offset = 0
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        // The paging helper stops on an empty page, so only the first page has rows.
        range: (from: number) => {
          offset = from
          return q
        },
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
          Promise.resolve(h.error ? { data: null, error: h.error } : { data: offset === 0 ? h.rows : [], error: null }).then(ok, bad),
      }
      return q
    },
    functions: { invoke: (...a: unknown[]) => h.invoke(...a) },
    rpc: async () => ({ data: true, error: null }),
    channel: () => {
      const c = { on: () => c, subscribe: () => c }
      return c
    },
    removeChannel: async () => {},
  },
}))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => 'season-1' }))
vi.mock('../auth/context.ts', () => ({ useAuth: () => ({ status: 'member', user: { id: 'me' }, member: { id: 'me', status: 'active' }, roles: [] }) }))
vi.mock('../data/useMembers.ts', () => ({ useMembers: () => ({ data: [{ id: 'me', full_name: 'Ana Me' }] }) }))

const row = (id: string, over: Record<string, unknown>) => ({
  id, task_id: `task-${id}`, kind: 'photo', original_name: `${id}.webp`, mime_type: 'image/webp', size_bytes: 54_000, width: 100,
  height: 100, duration_ms: null, playable: true, caption: null, uploaded_by: 'me', created_at: '2026-10-09T09:00:00Z',
  tasks: { title: `Task of ${id}`, season_id: 'season-1' }, ...over,
})

function renderPage(path = '/files') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Files />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubEnv('VITE_ATTACHMENTS_ENABLED', 'true')
  h.error = null
  h.rows = [
    row('logo', { original_name: 'logo.webp', tasks: { title: 'Make Club logo', season_id: 'season-1' } }),
    row('poster', { original_name: 'poster.webp', tasks: { title: 'Make SDU recruitment poster', season_id: 'season-1' } }),
    row('bylaws', { kind: 'document', original_name: 'bylaws-v3.pdf', mime_type: 'application/pdf', size_bytes: 85_000, tasks: [{ title: 'Discuss and agree Bylaws', season_id: 'season-1' }] }),
  ]
  h.invoke.mockReset().mockImplementation(async (_name: string, { body }: { body: { attachmentIds: string[] } }) => ({
    data: { expiresIn: 3600, urls: Object.fromEntries(body.attachmentIds.map((id) => [id, `https://r2.test/${id}.thumb.webp`])) },
    error: null,
  }))
})
afterEach(() => vi.unstubAllEnvs())

describe('Files page', () => {
  it('says so when file attachments are not switched on', () => {
    vi.stubEnv('VITE_ATTACHMENTS_ENABLED', 'false')
    renderPage()
    expect(screen.getByText('Files are not switched on')).toBeInTheDocument()
  })

  it('lists every file with its task, size and date', async () => {
    renderPage()
    expect(await screen.findByTestId('file-card-logo')).toBeInTheDocument()
    expect(screen.getByTestId('files-count')).toHaveTextContent('3 files')
    const card = screen.getByTestId('file-card-poster')
    expect(within(card).getByText('poster.webp')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Make SDU recruitment poster' })).toHaveAttribute('href', '/board?task=task-poster')
    expect(within(card).getByText(/54 kB/)).toBeInTheDocument()
    expect(within(card).getByText(/Ana Me/)).toBeInTheDocument()
  })

  it('shows the preview image of a PDF that has one, and a PDF badge', async () => {
    renderPage()
    const card = await screen.findByTestId('file-card-bylaws')
    expect(within(card).getByText('PDF')).toBeInTheDocument()
    await waitFor(() => expect(card.querySelector('img')).toHaveAttribute('src', 'https://r2.test/bylaws.thumb.webp'))
    // Documents are asked for like any other file: a PDF without a preview is simply absent from the answer.
    expect(h.invoke).toHaveBeenCalled()
    expect((h.invoke.mock.calls[0][1] as { body: { attachmentIds: string[] } }).body.attachmentIds).toContain('bylaws')
  })

  it('filters by kind and counts each kind', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId('file-card-logo')
    expect(screen.getByRole('button', { name: /^PDFs/ })).toHaveTextContent('1')
    await user.click(screen.getByRole('button', { name: /^PDFs/ }))
    expect(screen.getByRole('button', { name: /^PDFs/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('file-card-logo')).not.toBeInTheDocument()
    expect(screen.getByTestId('file-card-bylaws')).toBeInTheDocument()
    expect(screen.getByTestId('files-count')).toHaveTextContent('1 of 3 files')
  })

  it('searches by file name or task title and explains an empty result', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId('file-card-logo')
    await user.type(screen.getByTestId('files-search'), 'recruitment')
    expect(screen.getByTestId('file-card-poster')).toBeInTheDocument()
    expect(screen.queryByTestId('file-card-logo')).not.toBeInTheDocument()
    await user.clear(screen.getByTestId('files-search'))
    await user.type(screen.getByTestId('files-search'), 'nothing like this')
    expect(screen.getByText(/No file matches/)).toBeInTheDocument()
  })

  it('opens the kind and search from the address', async () => {
    renderPage('/files?kind=photo&q=logo')
    expect(await screen.findByTestId('file-card-logo')).toBeInTheDocument()
    expect(screen.queryByTestId('file-card-poster')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Photos/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens a file in the viewer without any delete or caption control', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /Open photo: logo\.webp/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument()
  })

  it('says there are no files yet', async () => {
    h.rows = []
    renderPage()
    expect(await screen.findByText('No files yet')).toBeInTheDocument()
  })

  it('shows a way back from a loading error', async () => {
    h.error = { message: 'boom', code: 'XX000' }
    renderPage()
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument()
  })
})
