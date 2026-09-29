import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Requirements Book route over mocked data hooks: every state a reader can
// land in (configured, not configured, unreachable, unusable), how a page in the
// address is validated, which PDF page the shared reader is asked to DRAW (the
// pdf.js view is replaced by a stub that records it — a real browser run checks
// the drawing itself), and that a way to read the book in a new tab is always
// there, including when the page cannot be drawn.

type Doc = { regs_ref: string; page_offset: number; page_count: number | null; storage_path?: string | null; url?: string | null } | null
type FileState =
  | { data: { status: 'none' } | { status: 'invalid'; reason: string } | { status: 'ready'; url: string; external: boolean } | undefined; isLoading: boolean; error: Error | null }

const state = {
  regsRef: 'ED1' as string | null,
  seasonStatus: 'ready' as 'ready' | 'loading',
  doc: { data: { regs_ref: 'ED1', page_offset: 0, page_count: null } as Doc, isLoading: false, error: null as Error | null },
  file: { data: { status: 'ready', url: 'https://example.org/regs.pdf', external: true }, isLoading: false, error: null } as FileState,
  canAdminister: false,
  refetch: vi.fn(),
}

vi.mock('../season/context.ts', () => ({
  useSeason: () =>
    state.seasonStatus === 'ready'
      ? { status: 'ready', seasonId: 's1', season: { id: 's1', regs_ref: state.regsRef } }
      : { status: 'loading' },
}))
vi.mock('../auth/usePermissions.ts', () => ({ usePermissions: () => ({ canAdminister: state.canAdminister }) }))
const pdf = { error: null as string | null }
vi.mock('../book/PdfPageView.tsx', () => ({
  default: (p: { url: string; pageIndex: number; label: string; onDocument: (n: number) => void; onError: (m: string) => void }) => {
    if (pdf.error) queueMicrotask(() => p.onError(pdf.error as string))
    return <div data-testid="pdf-stub" data-url={p.url} data-page-index={p.pageIndex} role="img" aria-label={p.label} />
  },
}))
vi.mock('../data/useRegulationDocument.ts', () => ({
  useRegulationDocument: () => ({ ...state.doc, refetch: state.refetch }),
  useBookFile: () => state.file,
}))

const { default: Book } = await import('./Book.tsx')

function renderBook(url = '/book') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Book />
    </MemoryRouter>,
  )
}
// The page the reader asked pdf.js to draw (1-based index inside the PDF).
const drawn = async () => Number((await screen.findByTestId('pdf-stub')).getAttribute('data-page-index'))

beforeEach(() => {
  state.regsRef = 'ED1'
  state.seasonStatus = 'ready'
  state.doc = { data: { regs_ref: 'ED1', page_offset: 0, page_count: null }, isLoading: false, error: null }
  state.file = { data: { status: 'ready', url: 'https://example.org/regs.pdf', external: true }, isLoading: false, error: null }
  state.canAdminister = false
  state.refetch = vi.fn()
  pdf.error = null
})

describe('a configured book', () => {
  it('draws the document in the page and offers the same document in a new tab', async () => {
    renderBook()
    expect(await drawn()).toBe(1)
    expect(screen.getByTestId('pdf-stub')).toHaveAttribute('data-url', 'https://example.org/regs.pdf')
    const open = screen.getByTestId('book-open-external')
    expect(open).toHaveAttribute('href', 'https://example.org/regs.pdf')
    expect(open).toHaveAttribute('target', '_blank')
    expect(open).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.getByTestId('book-location')).toHaveTextContent('The start of the book')
    expect(screen.getByText('Hosted outside Reqon')).toBeInTheDocument()
  })

  it('opens at a known page, shifting the printed number by the edition offset', async () => {
    state.doc = { data: { regs_ref: 'ED1', page_offset: 4, page_count: 300 }, isLoading: false, error: null }
    renderBook('/book?page=12&ref=F.13.3.1')
    expect(await drawn()).toBe(16)
    expect(screen.getByTestId('book-open-external')).toHaveAttribute('href', 'https://example.org/regs.pdf#page=16')
    expect(screen.getByTestId('book-location')).toHaveTextContent('Rule F.13.3.1')
    expect(screen.getByTestId('book-location')).toHaveTextContent('Page 12 (PDF page 16)')
    expect(screen.getByRole('img')).toHaveAccessibleName('Requirements Book, ED1, page 12')
    expect(screen.queryByTestId('book-page-notice')).not.toBeInTheDocument()
  })

  it('turns to another page in the SAME open reader, and keeps it in the address', async () => {
    state.doc = { data: { regs_ref: 'ED1', page_offset: 0, page_count: 120 }, isLoading: false, error: null }
    const user = userEvent.setup()
    renderBook('/book?page=3')
    expect(await drawn()).toBe(3)
    await user.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(async () => expect(await drawn()).toBe(4))
    const box = screen.getByRole('textbox', { name: 'Page' })
    await user.clear(box)
    await user.type(box, '40{Enter}')
    await waitFor(async () => expect(await drawn()).toBe(40))
    expect(screen.getByTestId('book-open-external')).toHaveAttribute('href', 'https://example.org/regs.pdf#page=40')
    // A page past the end is not accepted; the reader stays where it was.
    await user.clear(box)
    await user.type(box, '500{Enter}')
    expect(await drawn()).toBe(40)
  })

  it('says the page is not recorded when a rule was named but no page came with it', async () => {
    renderBook('/book?ref=B.2.1.2')
    expect(await drawn()).toBe(1)
    expect(screen.getByTestId('book-location')).toHaveTextContent('Page not recorded for this rule')
  })

  it.each(['abc', '0', '-2', '1.5', '1e3', '99999'])('opens at the start with a notice for an invalid page %j', async (raw) => {
    renderBook(`/book?page=${raw}`)
    expect(await drawn()).toBe(1)
    expect(screen.getByTestId('book-page-notice')).toBeInTheDocument()
    expect(screen.getByTestId('book-location')).toHaveTextContent('The start of the book')
  })

  it('checks the page against the length of the edition when it is known', async () => {
    state.doc = { data: { regs_ref: 'ED1', page_offset: 0, page_count: 120 }, isLoading: false, error: null }
    renderBook('/book?page=121')
    expect(screen.getByTestId('book-page-notice')).toHaveTextContent('120 pages')
    expect(await drawn()).toBe(1)
  })

  it('accepts the last page of a known edition', async () => {
    state.doc = { data: { regs_ref: 'ED1', page_offset: 0, page_count: 120 }, isLoading: false, error: null }
    renderBook('/book?page=120')
    expect(await drawn()).toBe(120)
  })

  it('does not label a private file as hosted outside Reqon', () => {
    state.file = { data: { status: 'ready', url: 'https://project.supabase.co/sign/x?token=t', external: false }, isLoading: false, error: null }
    renderBook()
    expect(screen.queryByText('Hosted outside Reqon')).not.toBeInTheDocument()
  })

  it('keeps a usable way to read when the page cannot be drawn here', async () => {
    pdf.error = 'Failed to fetch'
    renderBook('/book?page=3')
    expect(await screen.findByTestId('book-read-error')).toHaveTextContent('could not be drawn here (Failed to fetch)')
    expect(screen.getByTestId('book-open-external')).toHaveAttribute('href', 'https://example.org/regs.pdf#page=3')
  })

  it('tries again with a fresh address after the page could not be drawn', async () => {
    const user = userEvent.setup()
    pdf.error = 'Failed to fetch'
    const view = renderBook('/book?page=3')
    await screen.findByTestId('book-read-error')
    pdf.error = null
    // The link was re-signed meanwhile (react-query re-renders the reader).
    state.file = { data: { status: 'ready', url: 'https://example.org/regs.pdf?fresh=1', external: true }, isLoading: false, error: null }
    view.rerender(<MemoryRouter initialEntries={['/book?page=3']}><Book /></MemoryRouter>)
    await user.click(screen.getByTestId('book-retry'))
    expect(await drawn()).toBe(3)
    expect(screen.getByTestId('pdf-stub')).toHaveAttribute('data-url', 'https://example.org/regs.pdf?fresh=1')
    expect(screen.queryByTestId('book-read-error')).not.toBeInTheDocument()
  })

  it('keeps the open document when its private link is re-signed, so the place is not lost', async () => {
    state.doc = { data: { regs_ref: 'ED1', page_offset: 0, page_count: 120, storage_path: 'editions/ed1/a.pdf' }, isLoading: false, error: null }
    state.file = { data: { status: 'ready', url: 'https://x.test/sign/a?token=1', external: false }, isLoading: false, error: null }
    const view = renderBook('/book?page=30')
    expect(await drawn()).toBe(30)
    state.file = { data: { status: 'ready', url: 'https://x.test/sign/a?token=2', external: false }, isLoading: false, error: null }
    view.rerender(<MemoryRouter initialEntries={['/book?page=30']}><Book /></MemoryRouter>)
    expect(screen.getByTestId('pdf-stub')).toHaveAttribute('data-url', 'https://x.test/sign/a?token=1')
    expect(await drawn()).toBe(30)
  })

  it('opens the NEW edition when the season changes edition, instead of drawing the old document (F14-13)', async () => {
    state.doc = { data: { regs_ref: 'ED1', page_offset: 0, page_count: 120, storage_path: 'editions/ed1/a.pdf' }, isLoading: false, error: null }
    state.file = { data: { status: 'ready', url: 'https://x.test/sign/ed1', external: false }, isLoading: false, error: null }
    const view = renderBook('/book')
    await drawn()
    expect(screen.getByTestId('pdf-stub')).toHaveAttribute('data-url', 'https://x.test/sign/ed1')
    state.regsRef = 'ED2'
    state.doc = { data: { regs_ref: 'ED2', page_offset: 0, page_count: 90, storage_path: 'editions/ed2/b.pdf' }, isLoading: false, error: null }
    state.file = { data: { status: 'ready', url: 'https://x.test/sign/ed2', external: false }, isLoading: false, error: null }
    view.rerender(<MemoryRouter initialEntries={['/book']}><Book /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('pdf-stub')).toHaveAttribute('data-url', 'https://x.test/sign/ed2'))
    expect(screen.getByTestId('book-location')).toHaveTextContent('ED2')
    expect(screen.getByRole('img')).toHaveAccessibleName('Requirements Book, ED2, page 1')
  })

  it('keeps the page controls large enough to use on a phone', async () => {
    renderBook('/book?page=3')
    await drawn()
    for (const control of [screen.getByRole('button', { name: /Previous/ }), screen.getByRole('button', { name: /Next/ }), screen.getByRole('textbox', { name: 'Page' }), screen.getByTestId('book-open-external')]) {
      expect(control.className).toMatch(/min-h-11/)
    }
  })

  it('truncates a very long rule reference instead of rendering it whole', () => {
    renderBook(`/book?ref=${'x'.repeat(500)}&page=2`)
    expect(screen.getByTestId('book-location').textContent!.length).toBeLessThan(200)
  })
})

describe('when the book cannot be shown', () => {
  it('says plainly that no source is configured, and points an administrator to Settings', () => {
    state.doc = { data: null, isLoading: false, error: null }
    state.file = { data: { status: 'none' }, isLoading: false, error: null }
    state.canAdminister = true
    renderBook('/book?page=12')
    expect(screen.getByTestId('book-not-configured')).toHaveTextContent('No Requirements Book is configured for ED1')
    expect(screen.getByRole('link', { name: /set it up in settings/i })).toHaveAttribute('href', '/settings')
    expect(screen.queryByTestId('pdf-stub')).not.toBeInTheDocument()
  })

  it('tells someone who cannot configure it who can, without a Settings link', () => {
    state.doc = { data: null, isLoading: false, error: null }
    state.file = { data: { status: 'none' }, isLoading: false, error: null }
    renderBook()
    expect(screen.getByTestId('book-not-configured')).toHaveTextContent('Ask the President or Vice President')
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument()
  })

  it('says so when the season has no regulations edition at all', () => {
    state.regsRef = null
    renderBook()
    expect(screen.getByTestId('book-not-configured')).toHaveTextContent('no regulations edition set')
  })

  it('shows a loading state, not "not configured", while the source is being read', () => {
    state.doc = { data: undefined as unknown as Doc, isLoading: true, error: null }
    state.file = { data: undefined, isLoading: true, error: null }
    renderBook()
    expect(screen.getByRole('status')).toHaveTextContent('Opening the Requirements Book')
    expect(screen.queryByTestId('book-not-configured')).not.toBeInTheDocument()
  })

  it('says the document is unavailable when the file cannot be reached, and lets the reader retry', async () => {
    state.file = { data: undefined, isLoading: false, error: new Error('open the Requirements Book file: Object not found') }
    renderBook()
    expect(screen.getByTestId('book-unavailable')).toHaveTextContent('could not be opened')
    expect(screen.getByRole('alert')).toHaveTextContent('Object not found')
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(state.refetch).toHaveBeenCalled()
  })

  it('reports a failure to read the configuration, with a retry', async () => {
    state.doc = { data: undefined as unknown as Doc, isLoading: false, error: new Error('load the Requirements Book source: boom') }
    renderBook()
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(state.refetch).toHaveBeenCalled()
  })

  it('refuses to open a configured value that is not safe, and says why', () => {
    state.file = { data: { status: 'invalid', reason: 'Only https:// links are accepted.' }, isLoading: false, error: null }
    renderBook()
    expect(screen.getByTestId('book-invalid')).toHaveTextContent('Only https:// links are accepted.')
    expect(screen.queryByTestId('pdf-stub')).not.toBeInTheDocument()
    expect(screen.queryByTestId('book-open-external')).not.toBeInTheDocument()
  })
})
