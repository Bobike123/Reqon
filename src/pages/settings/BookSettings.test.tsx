import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The administrator's Requirements Book form: it validates before it asks the
// database, sends only the configuration (never who or when), and shows a
// refusal instead of pretending the save worked.

const fake = {
  regsRef: 'ED1' as string | null,
  doc: null as Record<string, unknown> | null,
  upserts: [] as Record<string, unknown>[],
  upsertError: null as { code?: string; message: string } | null,
}

vi.mock('../../auth/context.ts', () => ({ useAuth: () => ({ status: 'member', user: { id: 'me' }, member: { id: 'me' } }) }))
vi.mock('../../season/context.ts', () => ({
  useSeason: () => ({ status: 'ready', seasonId: 's1', season: { id: 's1', regs_ref: fake.regsRef } }),
}))
vi.mock('../../lib/supabase.ts', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: fake.doc, error: null }) }) }),
      upsert: (row: Record<string, unknown>) => {
        fake.upserts.push(row)
        return {
          select: () => ({
            single: async () => (fake.upsertError ? { data: null, error: fake.upsertError } : { data: { ...row, updated_at: 'now' }, error: null }),
          }),
        }
      },
    }),
  },
}))

const { BookSettings } = await import('./BookSettings.tsx')

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BookSettings />
    </QueryClientProvider>,
  )
}
const field = (name: RegExp) => screen.findByLabelText(name)
const save = () => screen.getByRole('button', { name: /save requirements book source/i })

beforeEach(() => {
  fake.regsRef = 'ED1'
  fake.doc = null
  fake.upserts = []
  fake.upsertError = null
})

describe('configuring the Requirements Book', () => {
  it('says nothing is configured yet, for the season\'s edition', async () => {
    renderForm()
    expect(await screen.findByTestId('book-config-status')).toHaveTextContent('Edition ED1: no document is configured yet.')
  })

  it('shows what is stored, and reports it configured', async () => {
    fake.doc = { regs_ref: 'ED1', url: 'https://example.org/a.pdf', storage_path: null, page_offset: 3, page_count: 200, title: 'Regs', updated_at: 't1' }
    renderForm()
    expect(await screen.findByTestId('book-config-status')).toHaveTextContent('a document is configured')
    expect(await field(/^link/i)).toHaveValue('https://example.org/a.pdf')
    expect(screen.getByLabelText(/page offset/i)).toHaveValue('3')
    expect(screen.getByLabelText(/number of pages/i)).toHaveValue('200')
  })

  it('has nothing to configure when the season has no edition', async () => {
    fake.regsRef = null
    renderForm()
    expect(await screen.findByText(/no regulations edition set/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it.each([
    ['http://example.org/a.pdf', /https/],
    ['javascript:alert(1)', /https/],
    ['https://u:p@example.org/a.pdf', /user name or password/],
  ])('refuses the link %j without asking the database', async (value, message) => {
    const user = userEvent.setup()
    renderForm()
    await user.type(await field(/^link/i), value)
    await user.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(fake.upserts).toEqual([])
    expect(await field(/^link/i)).toHaveAttribute('aria-invalid', 'true')
  })

  it.each(['/etc/passwd', '../secret.pdf', 'C:/regs.pdf'])('refuses the storage path %j', async (value) => {
    const user = userEvent.setup()
    renderForm()
    await user.type(await field(/private bucket/i), value)
    await user.click(save())
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(fake.upserts).toEqual([])
  })

  it('refuses both a link and a stored file', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(await field(/^link/i), 'https://example.org/a.pdf')
    await user.type(screen.getByLabelText(/private bucket/i), 'a/b.pdf')
    await user.click(save())
    expect(await screen.findByText('Use a link or a stored file, not both.')).toBeInTheDocument()
    expect(fake.upserts).toEqual([])
  })

  it('refuses a page offset or count that is not a whole number in range', async () => {
    const user = userEvent.setup()
    renderForm()
    const offset = await field(/page offset/i)
    await user.clear(offset)
    await user.type(offset, 'abc')
    await user.type(screen.getByLabelText(/number of pages/i), '0')
    await user.click(save())
    expect(await screen.findByText(/whole number between -500 and 500/)).toBeInTheDocument()
    expect(screen.getByText(/whole number of pages/)).toBeInTheDocument()
    expect(fake.upserts).toEqual([])
  })

  it('saves a valid link with only the configuration, and says so', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(await field(/^link/i), '  https://example.org/regs.pdf ')
    const offset = screen.getByLabelText(/page offset/i)
    await user.clear(offset)
    await user.type(offset, '4')
    await user.type(screen.getByLabelText(/number of pages/i), '312')
    await user.click(save())
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    expect(fake.upserts).toEqual([
      { regs_ref: 'ED1', edition: null, title: null, url: 'https://example.org/regs.pdf', storage_path: null, page_offset: 4, page_count: 312 },
    ])
  })

  it('saves a private file path instead of a link', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(await field(/private bucket/i), 'ms2627/regs.pdf')
    await user.click(save())
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    expect(fake.upserts[0]).toMatchObject({ url: null, storage_path: 'ms2627/regs.pdf' })
  })

  it('shows the database refusal and keeps what was typed, never claiming it saved', async () => {
    fake.upsertError = { code: '42501', message: 'new row violates row-level security policy for table "regulation_documents"' }
    const user = userEvent.setup()
    renderForm()
    await user.type(await field(/^link/i), 'https://example.org/regs.pdf')
    await user.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent(/don't have permission/i)
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^link/i)).toHaveValue('https://example.org/regs.pdf')
  })
})
