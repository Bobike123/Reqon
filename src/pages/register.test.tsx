import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Register composed for real — the real data hooks, joined by the real
// model — over a fake Supabase client that COUNTS every query. That is what
// proves linked work is loaded once for the whole season (not once per rule),
// and that finishing tasks never writes clause status on its own.

type Row = Record<string, unknown>
const fake = {
  tables: {} as Record<string, Row[]>,
  // Table names, one entry per FIRST page requested: one entry = one logical load.
  // (Every list load ends with one deliberate empty request; see fetchAllRows.)
  queries: [] as string[],
  upserts: [] as { table: string; row: Row }[],
  linkError: null as { message: string } | null,
  rpcs: [] as { name: string; args: Row }[],
  rpcError: null as { message: string; code?: string } | null,
}

function builder(table: string) {
  let from = 0
  const proxy: unknown = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') {
        // Every list is paged: the first page holds everything, later ones are empty.
        const error = table === 'task_requirements' ? fake.linkError : null
        const data = error ? null : from === 0 ? (fake.tables[table] ?? []) : []
        return (resolve: (value: unknown) => void) => resolve({ data, error })
      }
      return (...args: unknown[]) => {
        if (prop === 'range') {
          from = Number(args[0])
          if (from === 0) fake.queries.push(table)
        }
        if (prop === 'upsert') fake.upserts.push({ table, row: args[0] as Row })
        return proxy
      }
    },
  })
  return proxy
}

vi.mock('../lib/supabase.ts', () => ({
  supabase: {
    from: (table: string) => builder(table),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    // The link commands, as the database runs them: one row per pair (a
    // second link changes nothing and returns false), refusals as errors.
    rpc: (name: string, args: Row) => {
      fake.rpcs.push({ name, args })
      if (fake.rpcError) return Promise.resolve({ data: null, error: fake.rpcError })
      const links = fake.tables.task_requirements
      const same = (l: Row) => l.task_id === args.p_task_id && l.clause_key === args.p_clause_key
      if (name === 'link_task_requirement') {
        if (links.some(same)) return Promise.resolve({ data: false, error: null })
        links.push({ task_id: args.p_task_id, clause_key: args.p_clause_key })
        return Promise.resolve({ data: true, error: null })
      }
      if (name === 'unlink_task_requirement') {
        const before = links.length
        fake.tables.task_requirements = links.filter((l) => !same(l))
        return Promise.resolve({ data: fake.tables.task_requirements.length < before, error: null })
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } })
    },
    removeChannel: () => {},
  },
}))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1', status: 'active' }, roles: [] }),
}))
vi.mock('../season/context.ts', () => ({
  useSeason: () => ({ status: 'ready', seasonId: 's1', season: { id: 's1', regs_ref: 'ED1' } }),
  useSeasonId: () => 's1',
}))

// The reader itself is covered in book.test.tsx (and drawn by pdf.js in a real
// browser); here it only reports which rule and page the Register asked for.
vi.mock('../book/BookReader.tsx', () => ({
  BookReader: (p: { page: number | null; ruleRef?: string | null; note?: string | null; onPageChange: (n: number) => void }) => (
    <div data-testid="reader-stub" data-page={p.page ?? ''} data-rule={p.ruleRef ?? ''} data-note={p.note ?? ''}>
      <button type="button" onClick={() => p.onPageChange((p.page ?? 1) + 1)}>
        stub next page
      </button>
    </div>
  ),
}))

const { default: Register } = await import('./Register.tsx')

// Each row carries several controls, so a fully rendered Register is slow under
// user-event; give these tests room.
vi.setConfig({ testTimeout: 30_000 })

const clause = (key: string, over: Row = {}): Row => ({
  clause_key: key, printed_ref: key, subteam_key: 'GEOM', body: `Rule ${key}`, section: 'B', article: 2, article_title: null,
  group_title: null, obligation: 'constraint', criticality: 'required', phase: 'design', milestone_key: null,
  is_team_duty: true, specs: null, regs_ref: 'ED1', source_page: null, ...over,
})
const task = (id: string, over: Row = {}): Row => ({
  id, season_id: 's1', title: `Task ${id}`, state: 'todo', priority: 'normal', owner_id: null, subteam_key: 'GEOM',
  archived_at: null, section_id: null, milestone_key: null, ...over,
})

function renderRegister() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
// Scoped to the filter bar: a document-wide getByLabelText walks every label
// for every one of the ~400 row controls (quadratic in jsdom) and stalls the test.
const searchBox = () => within(document.querySelector<HTMLElement>('[role="search"]')!).getByLabelText('Search')
const rowOf = (key: string) => document.querySelector(`[data-clause-key="${CSS.escape(key)}"]`) as HTMLElement

beforeEach(() => {
  fake.queries = []
  fake.upserts = []
  fake.linkError = null
  fake.rpcs = []
  fake.rpcError = null
  fake.tables = {
    clauses: [
      ...Array.from({ length: 80 }, (_, i) => clause(`K.${i}`)),
      clause('F.5.2.3'),
      clause('F.5.2.3#2', { printed_ref: 'F.5.2.3' }),
      clause('B.9', { source_page: 12 }),
      clause('B.10', { source_page: 40, regs_ref: 'OLD-ED' }),
    ],
    clause_status: [],
    members: [{ id: 'm1', full_name: 'Ada Rider', status: 'active' }],
    subteams: [{ key: 'GEOM', name: 'Design Envelope', is_parked: false, sort_order: 0, archived_at: null, lead_id: null }],
    tasks: [
      task('a', { state: 'done', owner_id: 'm1' }),
      task('b', { state: 'wip' }),
      task('c', { state: 'done' }),
      task('d', { state: 'done', archived_at: '2026-09-01T00:00:00Z', title: 'Archived done' }),
      task('e', { state: 'cancelled' }),
    ],
    task_requirements: [
      { task_id: 'a', clause_key: 'F.5.2.3' },
      { task_id: 'b', clause_key: 'F.5.2.3' },
      { task_id: 'a', clause_key: 'B.9' },
      { task_id: 'c', clause_key: 'F.5.2.3#2' },
      { task_id: 'd', clause_key: 'F.5.2.3#2' },
      { task_id: 'e', clause_key: 'F.5.2.3#2' },
    ],
  }
})

describe('Register linked work', () => {
  it('loads links and task summaries ONCE for the whole season, not once per rule', async () => {
    renderRegister()
    await waitFor(() => expect(rowOf('F.5.2.3')).toBeTruthy())
    await waitFor(() => expect(within(rowOf('F.5.2.3')).getByTestId('link-progress')).toHaveTextContent('1 / 2'))
    const counts = fake.queries.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {})
    // 84 rules on screen; each table is read a handful of times at most.
    expect(counts.task_requirements).toBe(1)
    // tasks: the active list and the archived-progress list; nothing is read per rule.
    expect(counts.tasks).toBeLessThanOrEqual(2)
    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(2)
    expect(document.querySelectorAll('[data-clause-key]').length).toBe(84)
  })

  it('shows one task under several requirements, and several tasks under one', async () => {
    renderRegister()
    await waitFor(() => expect(within(rowOf('B.9')).getByTestId('link-progress')).toHaveTextContent('1 / 1 linked task done'))
    // Task "a" serves both B.9 and F.5.2.3 and counts in each.
    expect(within(rowOf('F.5.2.3')).getByTestId('link-progress')).toHaveTextContent('1 / 2 linked tasks done')
  })

  it('keeps two rules that print the same reference apart, by clause_key', async () => {
    renderRegister()
    await waitFor(() => expect(within(rowOf('F.5.2.3#2')).getByTestId('link-progress')).toBeInTheDocument())
    const first = within(rowOf('F.5.2.3'))
    const second = within(rowOf('F.5.2.3#2'))
    expect(first.getByTestId('link-progress')).toHaveTextContent('1 / 2 linked tasks done')
    // Second: c (done) + d (archived, done) count; e (cancelled) does not.
    expect(second.getByTestId('link-progress')).toHaveTextContent('2 / 2 linked tasks done')
    expect(second.getByTestId('link-detail')).toHaveTextContent('1 cancelled, not counted')
  })

  it('says "No linked work" for a rule nothing is linked to', async () => {
    renderRegister()
    await waitFor(() => expect(within(rowOf('K.0')).getByTestId('link-progress')).toHaveTextContent('No linked work'))
  })

  it('does not claim "No linked work" while the links are still loading', () => {
    renderRegister()
    expect(screen.queryAllByText('No linked work')).toHaveLength(0)
  })

  it('says linked work could not be loaded when the links fail, and the rest of the Register still works', async () => {
    fake.linkError = { message: 'boom' }
    renderRegister()
    await waitFor(() => expect(within(rowOf('K.0')).getByText('Linked work could not be loaded.')).toBeInTheDocument())
    expect(within(rowOf('K.0')).getByLabelText('Status for K.0')).toBeEnabled()
  })

  it('expands to the linked tasks, which open the same Board card or Archive entry', async () => {
    renderRegister()
    await waitFor(() => expect(within(rowOf('F.5.2.3#2')).getByTestId('link-progress')).toBeInTheDocument())
    await userEvent.click(within(rowOf('F.5.2.3#2')).getByRole('button', { name: /show tasks \(3\)/i }))
    const list = within(rowOf('F.5.2.3#2')).getByTestId('linked-tasks')
    expect(within(list).getByRole('link', { name: 'Task c' })).toHaveAttribute('href', '/board?task=c')
    expect(within(list).getByRole('link', { name: 'Archived done' })).toHaveAttribute('href', '/archive?tab=tasks&id=d')
  })
})

describe('compliance stays a person\'s decision', () => {
  it('writes nothing to clause_status when every linked task is done', async () => {
    renderRegister()
    await waitFor(() => expect(within(rowOf('F.5.2.3#2')).getByTestId('link-progress')).toHaveTextContent('2 / 2'))
    expect(fake.upserts).toEqual([])
    expect(within(rowOf('F.5.2.3#2')).getByLabelText('Status for F.5.2.3')).toHaveValue('open')
  })

  it('offers "Mark compliant" for that rule only, and one click records compliant — not verified', async () => {
    renderRegister()
    await waitFor(() => expect(within(rowOf('F.5.2.3#2')).getByRole('button', { name: /mark compliant/i })).toBeInTheDocument())
    // Not offered where work is unfinished, or absent.
    expect(within(rowOf('F.5.2.3')).queryByRole('button', { name: /mark compliant/i })).not.toBeInTheDocument()
    expect(within(rowOf('K.0')).queryByRole('button', { name: /mark compliant/i })).not.toBeInTheDocument()

    await userEvent.click(within(rowOf('F.5.2.3#2')).getByRole('button', { name: /mark compliant/i }))
    await waitFor(() => expect(fake.upserts).toHaveLength(1))
    expect(fake.upserts[0].table).toBe('clause_status')
    expect(fake.upserts[0].row).toMatchObject({ clause_key: 'F.5.2.3#2', state: 'compliant', season_id: 's1' })
    expect(fake.upserts[0].row.state).not.toBe('verified')
  })
})

describe('Open in Requirements Book', () => {
  it('uses the recorded page for the season\'s edition and never a page from another edition', async () => {
    renderRegister()
    await waitFor(() => expect(rowOf('B.9')).toBeTruthy())
    expect(within(rowOf('B.9')).getByTestId('book-link-B.9')).toHaveAttribute('href', '/book?page=12&ref=B.9')
    const other = within(rowOf('B.10'))
    expect(other.getByTestId('book-link-B.10')).toHaveAttribute('href', '/book?ref=B.10')
    expect(other.getByTestId('book-note')).toHaveTextContent('different edition')
    expect(within(rowOf('K.0')).getByTestId('book-note')).toHaveTextContent('Page not recorded')
  })
})

describe('the Requirements Book inside the Register', () => {
  it('opens a rule at its own page beside the list, moves to another rule, and closes without losing the search', async () => {
    const user = userEvent.setup()
    renderRegister()
    await waitFor(() => expect(rowOf('B.9')).toBeTruthy())
    fireEvent.change(searchBox(), { target: { value: 'B.' } })
    await waitFor(() => expect(rowOf('K.0')).toBeFalsy())

    await user.click(within(rowOf('B.9')).getByTestId('book-link-B.9'))
    const reader = await screen.findByTestId('register-reader')

    expect(within(reader).getByTestId('reader-stub')).toHaveAttribute('data-page', '12')
    expect(within(reader).getByTestId('reader-stub')).toHaveAttribute('data-rule', 'B.9')
    // Paging inside the reader, then choosing another rule: that rule's own place.
    await user.click(within(reader).getByRole('button', { name: 'stub next page' }))
    expect(within(reader).getByTestId('reader-stub')).toHaveAttribute('data-page', '13')
    await user.click(within(rowOf('B.10')).getByTestId('book-link-B.10'))
    expect(screen.getByTestId('reader-stub')).toHaveAttribute('data-rule', 'B.10')
    expect(screen.getByTestId('reader-stub')).toHaveAttribute('data-page', '')
    expect(screen.getByTestId('reader-stub')).toHaveAttribute('data-note', 'Page recorded for a different edition')

    await user.click(screen.getByTestId('register-reader-close'))
    expect(screen.queryByTestId('register-reader')).not.toBeInTheDocument()
    expect(searchBox()).toHaveValue('B.')
    await waitFor(() => expect(within(rowOf('B.10')).getByTestId('book-link-B.10')).toHaveFocus())
  })
})

describe('Assign existing tasks', () => {
  it('links an existing task through the link command, and offers only tasks this person may edit', async () => {
    const user = userEvent.setup()
    renderRegister()
    await waitFor(() => expect(rowOf('K.0')).toBeTruthy())
    await user.click(within(rowOf('K.0')).getByTestId('assign-open-K.0'))
    const panel = within(await screen.findByTestId('assign-tasks-K.0'))
    // Task a is owned by the viewer; task b belongs to nobody and GEOM has no Head.
    expect(panel.getByTestId('assign-row-b')).toHaveTextContent('Not yours to link')
    await user.click(within(panel.getByTestId('assign-row-a')).getByRole('button', { name: /Link/ }))
    await waitFor(() => expect(fake.rpcs).toEqual([{ name: 'link_task_requirement', args: { p_task_id: 'a', p_clause_key: 'K.0' } }]))
    expect(await panel.findByText(/owner, department and status are unchanged/)).toBeInTheDocument()
    // No task was written, and the rule's own status was not touched.
    expect(fake.upserts).toEqual([])
  })
})

describe('Assign existing tasks: the saved state and its limits', () => {
  it('shows a linked task as linked after the list reloads, and unlinks it with the unlink command', async () => {
    const user = userEvent.setup()
    renderRegister()
    await waitFor(() => expect(rowOf('K.0')).toBeTruthy())
    await user.click(within(rowOf('K.0')).getByTestId('assign-open-K.0'))
    const panel = within(await screen.findByTestId('assign-tasks-K.0'))
    await user.click(within(panel.getByTestId('assign-row-a')).getByRole('button', { name: /^Link/ }))
    // The reloaded links now include it: the row says so and offers Unlink, never a second Link.
    await waitFor(() => expect(panel.getByTestId('assign-row-a')).toHaveTextContent('linked'))
    await waitFor(() => expect(within(rowOf('K.0')).getByTestId('link-progress')).toHaveTextContent('1 / 1'))
    const unlink = within(panel.getByTestId('assign-row-a')).getByRole('button', { name: /^Unlink/ })
    await user.click(unlink)
    await waitFor(() => expect(fake.rpcs.at(-1)).toEqual({ name: 'unlink_task_requirement', args: { p_task_id: 'a', p_clause_key: 'K.0' } }))
    expect(await panel.findByText(/is no longer linked to K\.0/)).toBeInTheDocument()
    await waitFor(() => expect(within(rowOf('K.0')).getByTestId('link-progress')).toHaveTextContent('No linked work'))
    expect(fake.upserts).toEqual([])
  })

  it('says so, instead of pretending, when someone else linked the same task first', async () => {
    const user = userEvent.setup()
    renderRegister()
    await waitFor(() => expect(rowOf('K.1')).toBeTruthy())
    await user.click(within(rowOf('K.1')).getByTestId('assign-open-K.1'))
    const panel = within(await screen.findByTestId('assign-tasks-K.1'))
    // Linked elsewhere after this screen loaded.
    fake.tables.task_requirements.push({ task_id: 'a', clause_key: 'K.1' })
    await user.click(within(panel.getByTestId('assign-row-a')).getByRole('button', { name: /^Link/ }))
    expect(await panel.findByText(/was already linked to K\.1 — nothing was added twice/)).toBeInTheDocument()
    expect(fake.tables.task_requirements.filter((l) => l.task_id === 'a' && l.clause_key === 'K.1')).toHaveLength(1)
  })

  it('shows a refusal from the database and changes nothing on screen', async () => {
    const user = userEvent.setup()
    fake.rpcError = { message: 'You cannot change the requirements of this task.', code: '42501' }
    renderRegister()
    await waitFor(() => expect(rowOf('K.2')).toBeTruthy())
    await user.click(within(rowOf('K.2')).getByTestId('assign-open-K.2'))
    const panel = within(await screen.findByTestId('assign-tasks-K.2'))
    await user.click(within(panel.getByTestId('assign-row-a')).getByRole('button', { name: /^Link/ }))
    expect(await panel.findByRole('alert')).toBeInTheDocument()
    expect(panel.getByTestId('assign-row-a')).not.toHaveTextContent('· linked')
  })

  it('offers no link or unlink for archived work, and says why', async () => {
    const user = userEvent.setup()
    renderRegister()
    await waitFor(() => expect(rowOf('F.5.2.3#2')).toBeTruthy())
    await user.click(within(rowOf('F.5.2.3#2')).getByTestId('assign-open-F.5.2.3#2'))
    const panel = within(await screen.findByTestId('assign-tasks-F.5.2.3#2'))
    const archived = panel.getByTestId('assign-row-d')
    expect(archived).toHaveTextContent('Archived — restore it to change links')
    expect(within(archived).queryByRole('button')).not.toBeInTheDocument()
  })
})
