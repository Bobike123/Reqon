import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake that behaves like the DATABASE, not like the component: `specs` holds
// the raw rows, and `spec_verdicts` derives `verdict` on read — the same
// division of labour as the real view. The component under test never sees a
// verdict it computed itself.

const SEASON = { id: 'season-a', label: '2026/27', is_current: true }
const MEMBER = { id: 'm1', full_name: 'Ada Rider' }

// The real seeded rule: Fairing width, max 600 mm, clause B.2.1.9.
const FAIRING = {
  id: 'spec-fairing', season_id: 'season-a', parameter: 'Fairing width',
  comparator: 'max', target: 600, target_text: null, unit: 'mm',
  clause_key: 'B.2.1.9', condition: null, measured: null,
  measured_by: null, measured_at: null, sort_order: 7,
}

let specs: Record<string, unknown>[]
let writes: Record<string, unknown>[]
// When set, the fake view returns this verdict regardless of the numbers —
// used to prove the component reports what SQL says rather than recomputing.
let forcedVerdict: string | null = null

// This mirrors the CASE expression in the spec_verdicts view. It lives in the
// FAKE (standing in for the database), never in application code.
function deriveVerdict(s: Record<string, unknown>): string {
  if (forcedVerdict) return forcedVerdict
  const measured = s.measured as number | null
  const comparator = s.comparator as string
  const target = s.target as number
  if (measured === null || measured === undefined || comparator === 'range') return 'unmeasured'
  if (comparator === 'min') return measured >= target ? 'pass' : 'fail'
  if (comparator === 'max') return measured <= target ? 'pass' : 'fail'
  if (comparator === 'eq') return measured === target ? 'pass' : 'fail'
  return 'fail'
}

function makeBuilder(table: string) {
  const ctx: { op: string; payload?: Record<string, unknown>; filters: Record<string, unknown>; single: boolean } = {
    op: 'select', filters: {}, single: false,
  }
  const run = () => {
    if (ctx.op === 'update') {
      writes.push({ table, payload: ctx.payload, filters: { ...ctx.filters } })
      specs = specs.map((s) =>
        Object.entries(ctx.filters).every(([k, v]) => s[k] === v) ? { ...s, ...ctx.payload } : s,
      )
      return { data: null, error: null }
    }
    let rows: Record<string, unknown>[] =
      table === 'v_current_season' ? [SEASON]
      : table === 'members' ? [MEMBER]
      : table === 'spec_verdicts' ? specs.map((s) => ({ ...s, verdict: deriveVerdict(s) }))
      : table === 'specs' ? specs
      : []
    for (const [k, v] of Object.entries(ctx.filters)) rows = rows.filter((r) => r[k] === v)
    return { data: ctx.single ? (rows[0] ?? null) : rows, error: null }
  }
  const b: Record<string, unknown> = {
    select: () => b, order: () => b, in: () => b, range: () => b, limit: () => b,
    eq: (c: string, v: unknown) => { ctx.filters[c] = v; return b },
    update: (p: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = p; return b },
    insert: (p: Record<string, unknown>) => { ctx.op = 'insert'; ctx.payload = p; return b },
    single: () => { ctx.single = true; return b },
    maybeSingle: () => { ctx.single = true; return b },
    then: (resolve: (v: unknown) => void) => { resolve(run()); return Promise.resolve() },
  }
  return b
}

const supabase = { from: (t: string) => makeBuilder(t) }
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: MEMBER, roles: [] }),
}))

const { default: SpecSheet } = await import('./SpecSheet.tsx')

function renderSheet() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><SpecSheet /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  specs = [{ ...FAIRING }]
  writes = []
  forcedVerdict = null
})

// --- The two acceptance cases ----------------------------------------------

describe('ACCEPTANCE: the real 600 mm fairing rule', () => {
  it('612 produces FAILS RULE', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await screen.findByTestId('spec-spec-fairing')
    // Starts unmeasured.
    expect(within(row).getByTestId('verdict-unmeasured')).toBeInTheDocument()

    await user.type(within(row).getByLabelText('Measured (mm)'), '612')
    await user.tab()

    await waitFor(() => expect(specs[0].measured).toBe(612))
    await waitFor(() =>
      expect(
        within(screen.getByTestId('spec-spec-fairing')).getByTestId('verdict-fail'),
      ).toHaveTextContent('FAILS RULE'),
    )
    expect(screen.getByTestId('spec-spec-fairing')).toHaveAttribute('data-verdict', 'fail')
  })

  it('clearing the value goes back to not measured — never a pass', async () => {
    const user = userEvent.setup()
    specs = [{ ...FAIRING, measured: 612, measured_by: 'm1', measured_at: '2026-09-09T10:00:00Z' }]
    renderSheet()

    const row = await screen.findByTestId('spec-spec-fairing')
    expect(within(row).getByTestId('verdict-fail')).toBeInTheDocument()

    await user.clear(within(row).getByLabelText('Measured (mm)'))
    await user.tab()

    await waitFor(() => expect(specs[0].measured).toBeNull())
    await waitFor(() =>
      expect(
        within(screen.getByTestId('spec-spec-fairing')).getByTestId('verdict-unmeasured'),
      ).toHaveTextContent('not measured'),
    )
    expect(screen.queryByText('PASS')).not.toBeInTheDocument()
  })

  it('a value inside the limit passes — so the fail above is not just "any number fails"', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await screen.findByTestId('spec-spec-fairing')
    await user.type(within(row).getByLabelText('Measured (mm)'), '580')
    await user.tab()
    await waitFor(() =>
      expect(screen.getByTestId('spec-spec-fairing')).toHaveAttribute('data-verdict', 'pass'),
    )
  })
})

// --- The verdict source ------------------------------------------------------

describe('the verdict comes from SQL, not from React', () => {
  it('renders what the view says even when that contradicts the raw numbers', async () => {
    // 612 against a max of 600, but the view (here, forced) says 'pass'.
    // A component that duplicated `measured > target` would print FAILS RULE.
    // Obeying the view is the whole point: the database owns the rule.
    specs = [{ ...FAIRING, measured: 612 }]
    forcedVerdict = 'pass'
    renderSheet()
    const row = await screen.findByTestId('spec-spec-fairing')
    expect(row).toHaveAttribute('data-verdict', 'pass')
    expect(within(row).getByText('PASS')).toBeInTheDocument()
    expect(within(row).queryByTestId('verdict-fail')).not.toBeInTheDocument()
  })

  it('shows not measured for a rule the view cannot judge (range comparator)', async () => {
    specs = [{
      ...FAIRING, id: 'spec-number', parameter: 'Competition number',
      comparator: 'range', target: null, target_text: '1–99', unit: null,
      clause_key: 'A.3.1.6', measured: 42,
    }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-number')
    expect(within(row).getByTestId('verdict-unmeasured')).toBeInTheDocument()
    expect(within(row).getByText('1–99')).toBeInTheDocument()
  })
})

// --- Storage ----------------------------------------------------------------

describe('what gets written', () => {
  it('persists measured, measured_by and measured_at — and no verdict', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await screen.findByTestId('spec-spec-fairing')
    await user.type(within(row).getByLabelText('Measured (mm)'), '612')
    await user.tab()
    await waitFor(() => expect(writes).toHaveLength(1))

    const payload = writes[0].payload as Record<string, unknown>
    expect(writes[0].table).toBe('specs')
    expect(payload.measured).toBe(612)
    expect(payload.measured_by).toBe('m1')
    expect(typeof payload.measured_at).toBe('string')

    // A derived verdict must NEVER be stored — it would go stale the moment a
    // target changes.
    expect(payload).not.toHaveProperty('verdict')
    expect(payload).not.toHaveProperty('passed')
    expect(payload).not.toHaveProperty('result')
    expect(Object.keys(payload).sort()).toEqual(['measured', 'measured_at', 'measured_by'])
  })

  it('clears attribution when the measurement is cleared', async () => {
    const user = userEvent.setup()
    specs = [{ ...FAIRING, measured: 612, measured_by: 'm1', measured_at: '2026-09-09T10:00:00Z' }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-fairing')
    await user.clear(within(row).getByLabelText('Measured (mm)'))
    await user.tab()
    await waitFor(() => expect(writes).toHaveLength(1))

    const payload = writes[0].payload as Record<string, unknown>
    expect(payload.measured).toBeNull()
    expect(payload.measured_by).toBeNull()
    expect(payload.measured_at).toBeNull()
  })

  it('shows who measured it', async () => {
    specs = [{ ...FAIRING, measured: 580, measured_by: 'm1', measured_at: '2026-09-09T10:00:00Z' }]
    renderSheet()
    expect(await screen.findByTestId('measured-by-spec-fairing')).toHaveTextContent(
      'by Ada Rider on 9 Sept 2026',
    )
  })
})

describe('presentation', () => {
  it('names the rule a failing measurement breaks', async () => {
    specs = [{ ...FAIRING, measured: 612 }]
    renderSheet()
    expect(await screen.findByTestId('spec-rule-spec-fairing')).toHaveTextContent('B.2.1.9')
  })

  it('gives the measurement input an accessible name', async () => {
    renderSheet()
    expect(await screen.findByLabelText('Measured (mm)')).toBeInTheDocument()
  })
})
