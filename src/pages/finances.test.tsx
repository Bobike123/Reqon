import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatEuros } from '../finance/money.ts'

// A fake that enforces the SAME rules as the finance_* policies in
// supabase/migrations/20260106000000_finance_ledger.sql (checked for real by
// supabase/tests/finance_rls_test.sql): every privileged role reads; the
// Treasurer writes, and so does the Developer (20260107, full access). Like PostgREST, a refused read returns no rows and a
// refused UPDATE/DELETE matches nothing — only a refused INSERT is an error.
type Row = {
  id: string
  season_id: string
  entry_date: string
  kind: 'income' | 'expense'
  description: string
  category: string | null
  amount_cents: number
  created_by: string | null
  created_at: string
  updated_at: string
}

const who = vi.hoisted(() => ({ roles: [] as string[] }))
let rows: Row[]
let requests: string[]
// Makes the "may I manage finances?" question itself fail, as on a network blip.
let rpcFails = false

const canView = () => who.roles.length > 0
const canManage = () => who.roles.includes('treasurer') || who.roles.includes('developer')

const row = (over: Partial<Row>): Row => ({
  id: 'x', season_id: 's1', entry_date: '2026-09-01', kind: 'expense', description: 'x', category: null,
  amount_cents: 100, created_by: null, created_at: '', updated_at: '', ...over,
})

function builder() {
  const ctx = { op: 'select', payload: {} as Partial<Row>, filters: {} as Record<string, unknown> }
  const matches = (r: Row) => Object.entries(ctx.filters).every(([k, v]) => r[k as keyof Row] === v)
  const run = () => {
    requests.push(ctx.op)
    if (ctx.op === 'select') return { data: canView() ? rows.filter(matches) : [], error: null }
    if (ctx.op === 'insert') {
      if (!canManage()) {
        return { data: null, error: { message: 'new row violates row-level security policy for table "finance_entries"', code: '42501' } }
      }
      rows.push(row({ id: `new${rows.length}`, ...ctx.payload }))
      return { data: null, error: null }
    }
    if (!canManage()) return { data: [], error: null }
    const hit = rows.filter(matches)
    if (ctx.op === 'update') rows = rows.map((r) => (matches(r) ? { ...r, ...ctx.payload } : r))
    if (ctx.op === 'delete') rows = rows.filter((r) => !matches(r))
    return { data: hit.map((r) => ({ id: r.id })), error: null }
  }
  const b: Record<string, unknown> = {
    select: () => b, order: () => b, range: () => b,
    eq: (k: string, v: unknown) => { ctx.filters[k] = v; return b },
    insert: (p: Partial<Row>) => { ctx.op = 'insert'; ctx.payload = p; return b },
    update: (p: Partial<Row>) => { ctx.op = 'update'; ctx.payload = p; return b },
    delete: () => { ctx.op = 'delete'; return b },
    then: (resolve: (v: unknown) => void) => { resolve(run()); return Promise.resolve() },
  }
  return b
}

const supabase = {
  from: () => builder(),
  rpc: async (fn: string) =>
    rpcFails
      ? { data: null, error: { message: 'network down', code: '' } }
      : { data: fn === 'can_manage_finances' ? canManage() : null, error: null },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'me' }, member: { id: 'me', full_name: 'Test Person' }, roles: who.roles }),
}))
vi.mock('../data/useCurrentSeason.ts', () => ({
  useCurrentSeason: () => ({ data: { id: 's1', label: '2026/27' } }),
}))

const { default: Finances } = await import('./Finances.tsx')

function renderFinances(roles: string[]) {
  who.roles = roles
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Finances /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const dialogNamed = async (name: string) => within(await screen.findByRole('dialog', { name }))

beforeEach(() => {
  requests = []
  rpcFails = false
  rows = [
    row({ id: 'e1', entry_date: '2026-09-01', kind: 'expense', description: 'Entry fee', category: 'Registration', amount_cents: 455000 }),
    row({ id: 'e2', entry_date: '2026-09-05', kind: 'income', description: 'Sponsor payment', category: 'Sponsorship', amount_cents: 1000000 }),
    row({ id: 'e3', season_id: 's0', description: 'Last season', amount_cents: 999 }),
  ]
})

describe('the Treasurer', () => {
  it('adds an entry, and it appears with the totals updated', async () => {
    const user = userEvent.setup()
    renderFinances(['treasurer'])
    expect(await screen.findByTestId('finance-access')).toHaveTextContent('You are the Treasurer')
    await user.click(await screen.findByRole('button', { name: 'Add entry' }))
    const dialog = await dialogNamed('Add an entry')
    await user.type(dialog.getByLabelText('Description'), 'Brake pads')
    await user.type(dialog.getByLabelText('Amount (€)'), '45,50')
    await user.type(dialog.getByLabelText(/Category/), 'Parts')
    await user.click(dialog.getByRole('button', { name: 'Add entry' }))

    expect(await screen.findByText('Entry added.')).toBeInTheDocument()
    expect(rows.find((r) => r.description === 'Brake pads')).toMatchObject({
      kind: 'expense', amount_cents: 4550, category: 'Parts', season_id: 's1',
    })
    expect(await screen.findByText('Brake pads')).toBeInTheDocument()
    expect(screen.getByText(formatEuros(455000 + 4550))).toBeInTheDocument()
  })

  it('edits and deletes an entry, deleting only after confirming', async () => {
    const user = userEvent.setup()
    renderFinances(['treasurer'])
    await user.click(await screen.findByRole('button', { name: 'Edit Entry fee' }))
    const edit = await dialogNamed('Edit entry')
    const amount = edit.getByLabelText('Amount (€)')
    expect(amount).toHaveValue('4550.00')
    await user.clear(amount)
    await user.type(amount, '4600')
    await user.click(edit.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Entry updated.')).toBeInTheDocument()
    expect(rows.find((r) => r.id === 'e1')?.amount_cents).toBe(460000)

    await user.click(screen.getByRole('button', { name: 'Delete Entry fee' }))
    const confirm = await dialogNamed('Delete this entry?')
    expect(rows.some((r) => r.id === 'e1')).toBe(true)
    await user.click(confirm.getByRole('button', { name: 'Delete entry' }))
    expect(await screen.findByText('Entry deleted.')).toBeInTheDocument()
    expect(rows.some((r) => r.id === 'e1')).toBe(false)
  })

  it('catches a bad amount before anything is sent', async () => {
    const user = userEvent.setup()
    renderFinances(['treasurer'])
    await user.click(await screen.findByRole('button', { name: 'Add entry' }))
    const dialog = await dialogNamed('Add an entry')
    await user.type(dialog.getByLabelText('Description'), 'Tyres')
    await user.type(dialog.getByLabelText('Amount (€)'), '1.234,50')
    await user.click(dialog.getByRole('button', { name: 'Add entry' }))
    expect(dialog.getByText(/Enter an amount above zero/)).toBeInTheDocument()
    expect(dialog.getByLabelText('Amount (€)')).toHaveAttribute('aria-invalid', 'true')
    expect(dialog.getByLabelText('Amount (€)')).toHaveFocus()
    expect(requests).not.toContain('insert')
  })

  it('who lost the role mid-session is told so, and keeps what they typed', async () => {
    const user = userEvent.setup()
    renderFinances(['treasurer'])
    await user.click(await screen.findByRole('button', { name: 'Add entry' }))
    const dialog = await dialogNamed('Add an entry')
    await user.type(dialog.getByLabelText('Description'), 'Brake pads')
    await user.type(dialog.getByLabelText('Amount (€)'), '45')
    who.roles = ['president'] // the President moved Treasurer to someone else
    await user.click(dialog.getByRole('button', { name: 'Add entry' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(
      "Not permitted: You don't have permission to add financial entries. Nothing was changed.",
    )
    expect(dialog.getByLabelText('Description')).toHaveValue('Brake pads')
    expect(rows.some((r) => r.description === 'Brake pads')).toBe(false)
  })

  it('an edit the database silently refuses is reported, not shown as saved', async () => {
    const user = userEvent.setup()
    renderFinances(['treasurer'])
    await user.click(await screen.findByRole('button', { name: 'Edit Entry fee' }))
    const dialog = await dialogNamed('Edit entry')
    who.roles = ['president']
    await user.click(dialog.getByRole('button', { name: 'Save changes' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent("You don't have permission to edit financial entries")
    expect(screen.queryByText('Entry updated.')).not.toBeInTheDocument()
  })
})

for (const [label, role] of [['President', 'president'], ['Vice President', 'vicepresident']] as const) {
  describe(`the ${label}`, () => {
    it('sees every entry of this season and the totals, read-only, with the reason in words', async () => {
      renderFinances([role])
      expect(await screen.findByText('Entry fee')).toBeInTheDocument()
      expect(screen.getByText('Sponsor payment')).toBeInTheDocument()
      expect(screen.queryByText('Last season')).not.toBeInTheDocument()
      expect(screen.getByText(formatEuros(1000000))).toBeInTheDocument()
      expect(screen.getByText(formatEuros(1000000 - 455000))).toBeInTheDocument()
      expect(screen.getByTestId('finance-access')).toHaveTextContent(
        `Read-only for ${label}. Only the Treasurer and the Developer can change`,
      )
      expect(screen.queryByRole('button', { name: 'Add entry' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument()
    })
  })
}

describe('the Developer', () => {
  it('has full access: writes the ledger like the Treasurer', async () => {
    const user = userEvent.setup()
    renderFinances(['developer'])
    expect(await screen.findByTestId('finance-access')).toHaveTextContent('full access as Developer')
    await user.click(await screen.findByRole('button', { name: 'Add entry' }))
    const dialog = await dialogNamed('Add an entry')
    await user.type(dialog.getByLabelText('Description'), 'Server bill')
    await user.type(dialog.getByLabelText('Amount (€)'), '12')
    await user.click(dialog.getByRole('button', { name: 'Add entry' }))

    expect(await screen.findByText('Entry added.')).toBeInTheDocument()
    expect(rows.find((r) => r.description === 'Server bill')).toMatchObject({ amount_cents: 1200 })
    expect(screen.getByRole('button', { name: 'Edit Entry fee' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Entry fee' })).toBeInTheDocument()
  })
})

describe('an ordinary member', () => {
  it('is told who can see finances, and nothing is requested on their behalf', async () => {
    renderFinances([])
    expect(await screen.findByText(/visible to the President, Vice President, Treasurer and Developer/)).toBeInTheDocument()
    expect(screen.getByText(/Member \(no privileged role\)/)).toBeInTheDocument()
    expect(requests).toEqual([])
  })
})

describe('an empty ledger', () => {
  it('tells the Treasurer how to start, and everyone else who fills it in', async () => {
    rows = []
    const { unmount } = renderFinances(['treasurer'])
    expect(await screen.findByText(/Add the first income or expense/)).toBeInTheDocument()
    unmount()
    renderFinances(['president'])
    expect(await screen.findByText(/The Treasurer records the season’s income and expenses here/)).toBeInTheDocument()
  })
})

describe('loading', () => {
  it('says so while the ledger is on its way', async () => {
    renderFinances(['developer'])
    expect(screen.getByText('Loading finances…')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Loading finances…')).not.toBeInTheDocument())
  })
})

describe('losing access in the middle of an action', () => {
  it('keeps the refusal on screen after the page switches to "nothing to show you"', async () => {
    const user = userEvent.setup()
    renderFinances(['treasurer'])
    await user.click(await screen.findByRole('button', { name: 'Delete Entry fee' }))
    const confirm = await dialogNamed('Delete this entry?')
    who.roles = [] // every role taken away on another device
    await user.click(confirm.getByRole('button', { name: 'Delete entry' }))

    expect(await screen.findByText(/visible to the President, Vice President, Treasurer and Developer/)).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Not permitted: You don't have permission to delete financial entries. Nothing was changed.",
    )
    expect(rows.some((r) => r.id === 'e1')).toBe(true)
  })

  it('does the same for a refused new entry', async () => {
    const user = userEvent.setup()
    renderFinances(['treasurer'])
    await user.click(await screen.findByRole('button', { name: 'Add entry' }))
    const dialog = await dialogNamed('Add an entry')
    await user.type(dialog.getByLabelText('Description'), 'Tyres')
    await user.type(dialog.getByLabelText('Amount (€)'), '120')
    who.roles = []
    await user.click(dialog.getByRole('button', { name: 'Add entry' }))

    expect(await screen.findByText(/visible to the President, Vice President, Treasurer and Developer/)).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent("Not permitted: You don't have permission to add financial entries.")
  })
})

describe('a failure that is not a refusal', () => {
  it('is never shown as "Not permitted"', async () => {
    const user = userEvent.setup()
    renderFinances(['treasurer'])
    await user.click(await screen.findByRole('button', { name: 'Edit Entry fee' }))
    const dialog = await dialogNamed('Edit entry')
    who.roles = ['president'] // the update will match nothing…
    rpcFails = true // …and the follow-up question fails too
    await user.click(dialog.getByRole('button', { name: 'Save changes' }))
    const alert = await dialog.findByRole('alert')
    expect(alert).toHaveTextContent('check whether the change was saved: network down')
    expect(alert).not.toHaveTextContent('Not permitted')
  })
})
