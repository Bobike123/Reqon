import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake that behaves like the DATABASE, not like the component: `specs` holds
// the raw rows (with the current-value cache the server maintains),
// `spec_measurements` holds the history, and `spec_verdicts` derives `verdict`
// on read — the same division of labour as the real view. The component under
// test never sees a verdict it computed itself, and it can only change a
// measurement through the record command, which the fake honours the way the
// server does (one row per request id).

const SEASON = { id: 'season-a', label: '2026/27', is_current: true }
const MEMBER = { id: 'm1', full_name: 'Ada Rider', status: 'active' }
let signedInMember = MEMBER
let signedInRoles: string[] = []
const NOW = '2026-09-20T10:00:00Z'

// The real seeded rule: Fairing width, max 600 mm, clause B.2.1.9.
const FAIRING = {
  id: 'spec-fairing', season_id: 'season-a', parameter: 'Fairing width',
  comparator: 'max', direction: 'lower_better', measure_kind: 'numeric',
  target: 600, target_max: null, target_bool: null, target_min_inclusive: true, target_max_inclusive: true,
  target_text: null, target_tolerance: null, unit: 'mm', clause_key: 'B.2.1.9', condition: null,
  acceptable: null, goal: null, goal_max: null, goal_tolerance: null, goal_bool: null, ideal: null,
  plausible_min: null, plausible_max: null,
  measured: null, measured_bool: null, measured_by: null, measured_at: null, current_measurement_id: null,
  sort_order: 7,
}

let specs: Record<string, unknown>[]
let measurements: Record<string, unknown>[]
let rpcCalls: { fn: string; args: Record<string, unknown> }[]
// The next record call commits on the server but the response never arrives.
let dropResponseOnce = false
let rpcError: { message: string; code: string } | null = null
let recordGate: Promise<void> | null = null
// When set, the fake view returns this verdict regardless of the numbers —
// used to prove the component reports what SQL says rather than recomputing.
let forcedVerdict: string | null = null

// This mirrors spec_regulatory_verdict in the migration. It lives in the FAKE
// (standing in for the database), never in application code.
function deriveVerdict(s: Record<string, unknown>): string {
  if (forcedVerdict) return forcedVerdict
  const num = s.measured as number | null
  const bool = s.measured_bool as boolean | null
  if (num === null && bool === null) return 'unmeasured'
  const target = s.target as number | null
  switch (s.comparator) {
    case 'bool':
      return s.target_bool === null ? 'unevaluable' : bool === s.target_bool ? 'pass' : 'fail'
    case 'min': return target === null ? 'unevaluable' : (num as number) >= target ? 'pass' : 'fail'
    case 'max': return target === null ? 'unevaluable' : (num as number) <= target ? 'pass' : 'fail'
    case 'eq': return target === null ? 'unevaluable' : num === target ? 'pass' : 'fail'
    default: return 'unevaluable'
  }
}

function deriveGoalStatus(s: Record<string, unknown>): string {
  const num = s.measured as number | null
  const bool = s.measured_bool as boolean | null
  if (num === null && bool === null) return 'unmeasured'
  if (s.direction === 'boolean') {
    return s.goal_bool === null ? 'not_set' : bool === s.goal_bool ? 'met' : 'short'
  }
  const numeric = num as number
  const goal = s.goal as number | null
  const acceptable = s.acceptable as number | null
  if (s.direction === 'higher_better') {
    if (goal !== null && numeric >= goal) return 'met'
    if (acceptable !== null && numeric < acceptable) return 'unacceptable'
    return goal === null ? 'not_set' : 'short'
  }
  if (s.direction === 'lower_better') {
    if (goal !== null && numeric <= goal) return 'met'
    if (acceptable !== null && numeric > acceptable) return 'unacceptable'
    return goal === null ? 'not_set' : 'short'
  }
  if (s.direction === 'range') {
    if (goal === null || s.goal_max === null) return 'not_set'
    return numeric >= goal && numeric <= (s.goal_max as number) ? 'met' : 'short'
  }
  if (s.direction === 'exact') {
    if (goal === null) return 'not_set'
    return Math.abs(numeric - goal) <= ((s.goal_tolerance as number | null) ?? 0) ? 'met' : 'short'
  }
  return 'not_set'
}

// As spec_verdicts does (Phase 4): green needs a person's readiness confirmation; passing, even with the
// goal met, is amber; an unmeasured specification is grey.
function deriveZone(verdict: string, _goalStatus: string, readiness: string | null): string {
  if (verdict === 'fail') return 'red'
  if (verdict === 'pass' && readiness === 'ready') return 'green'
  if (verdict === 'pass') return 'amber'
  return 'grey'
}

function record(args: Record<string, unknown>) {
  const existing = measurements.find((m) => m.request_id === args.p_request_id && m.measured_by === MEMBER.id)
  const row = existing ?? {
    id: `meas-${measurements.length + 1}`,
    spec_id: args.p_spec_id, season_id: args.p_season_id,
    value_numeric: args.p_value_numeric ?? null, value_bool: args.p_value_bool ?? null,
    measured_at: args.p_measured_at ?? NOW, recorded_at: NOW, measured_by: MEMBER.id,
    request_id: args.p_request_id, origin: 'entered', note: args.p_note ?? null, source: args.p_source ?? null,
    corrects_id: null, invalidated_at: null, invalidated_by: null, invalidation_reason: null,
  }
  if (!existing) {
    measurements.unshift(row)
    specs = specs.map((s) =>
      s.id === args.p_spec_id
        ? {
            ...s, measured: row.value_numeric, measured_bool: row.value_bool, measured_by: MEMBER.id,
            measured_at: row.measured_at, current_measurement_id: row.id,
          }
        : s,
    )
  }
  return row
}

function makeBuilder(table: string) {
  const ctx: { filters: Record<string, unknown>; range?: [number, number]; single: boolean } = { filters: {}, single: false }
  const run = () => {
    let rows: Record<string, unknown>[] =
      table === 'v_current_season' ? [SEASON]
      : table === 'members' ? [MEMBER]
      : table === 'spec_verdicts' ? specs.map((s) => {
          const verdict = deriveVerdict(s)
          const goal_status = deriveGoalStatus(s)
          return {
            readiness: 'not_confirmed', readiness_reason: null, readiness_confirmed_at: null, readiness_confirmed_by: null,
            readiness_note: null, readiness_measurement_id: null, readiness_revoked_at: null,
            competition_measurement_id: null, competition_value: null, competition_value_bool: null,
            competition_measured_at: null, competition_verdict: null,
            direction_needs_review: false, direction_reviewed_at: null, direction_reviewed_by: null, direction_note: null,
            ...s, verdict, goal_status, zone: deriveZone(verdict, goal_status, (s.readiness as string | undefined) ?? null),
          }
        })
      : table === 'spec_measurements' ? measurements
      : []
    for (const [k, v] of Object.entries(ctx.filters)) rows = rows.filter((r) => r[k] === v)
    if (ctx.range) rows = rows.slice(ctx.range[0], ctx.range[1] + 1)
    return { data: ctx.single ? (rows[0] ?? null) : rows, error: null }
  }
  const b: Record<string, unknown> = {
    select: () => b, order: () => b, in: () => b, limit: () => b,
    range: (from: number, to: number) => { ctx.range = [from, to]; return b },
    eq: (c: string, v: unknown) => { ctx.filters[c] = v; return b },
    single: () => { ctx.single = true; return b },
    maybeSingle: () => { ctx.single = true; return b },
    then: (resolve: (v: unknown) => void) => { resolve(run()); return Promise.resolve() },
  }
  return b
}

const supabase = {
  from: (t: string) => makeBuilder(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    if (rpcError) return { data: null, error: rpcError }
    if (fn === 'invalidate_spec_measurement') {
      const row = measurements.find((measurement) => measurement.id === args.p_measurement_id)
      if (!row) return { data: null, error: { message: 'observation not found', code: 'P0002' } }
      Object.assign(row, { invalidated_at: NOW, invalidated_by: MEMBER.id, invalidation_reason: args.p_reason })
      return { data: row, error: null }
    }
    if (fn === 'correct_spec_measurement') {
      const old = measurements.find((measurement) => measurement.id === args.p_measurement_id)
      if (!old) return { data: null, error: { message: 'observation not found', code: 'P0002' } }
      Object.assign(old, { invalidated_at: NOW, invalidated_by: MEMBER.id, invalidation_reason: args.p_reason })
      const row = {
        id: `meas-${measurements.length + 1}`, spec_id: old.spec_id, season_id: old.season_id,
        value_numeric: args.p_value_numeric ?? null, value_bool: args.p_value_bool ?? null,
        measured_at: old.measured_at, recorded_at: NOW, measured_by: MEMBER.id,
        request_id: args.p_request_id, origin: 'correction', note: null, source: null,
        corrects_id: old.id, invalidated_at: null, invalidated_by: null, invalidation_reason: null,
      }
      measurements.unshift(row)
      specs = specs.map((spec) => spec.id === row.spec_id ? {
        ...spec, measured: row.value_numeric, measured_bool: row.value_bool,
        measured_by: MEMBER.id, measured_at: row.measured_at, current_measurement_id: row.id,
      } : spec)
      return { data: row, error: null }
    }
    if (fn === 'confirm_spec_readiness' || fn === 'review_spec_direction') return { data: { id: 'ok' }, error: null }
    if (fn === 'revoke_spec_readiness') return { data: true, error: null }
    if (fn !== 'record_spec_measurement') return { data: null, error: { message: `unexpected rpc ${fn}`, code: 'XX000' } }
    if (recordGate) await recordGate
    const row = record(args)
    if (dropResponseOnce) {
      dropResponseOnce = false
      return { data: null, error: { message: 'network connection lost', code: '08006' } }
    }
    return { data: row, error: null }
  },
  // useRealtimeSpecs subscribes on mount; a no-op stub is enough here since
  // this suite never emits a change through it.
  channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  removeChannel: () => {},
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: signedInMember, roles: signedInRoles }),
}))

const { default: SpecSheet } = await import('./SpecSheet.tsx')
const { SeasonProvider } = await import('../season/SeasonProvider.tsx')

// Rows open through the address (?open=…), as a link to a spec does; by default
// every spec of the test is open so its editor and history are reachable.
function renderSheet(url = `/specs?open=${specs.map((spec) => spec.id).join(',')}`) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const rendered = render(
    <QueryClientProvider client={qc}>
      <SeasonProvider>
        <MemoryRouter initialEntries={[url]}><SpecSheet /></MemoryRouter>
      </SeasonProvider>
    </QueryClientProvider>,
  )
  return { ...rendered, queryClient: qc }
}

async function fairingRow() {
  return screen.findByTestId('spec-spec-fairing')
}

async function typeAndReview(row: HTMLElement, text: string, user = userEvent.setup()) {
  await user.type(within(row).getByLabelText(/^New measurement/), text)
  await user.click(within(row).getByRole('button', { name: 'Review' }))
}

beforeEach(() => {
  signedInMember = MEMBER
  signedInRoles = []
  specs = [{ ...FAIRING }]
  measurements = []
  rpcCalls = []
  dropResponseOnce = false
  rpcError = null
  recordGate = null
  forcedVerdict = null
})

// --- Nothing persists until the person confirms ---------------------------------

describe('typing and leaving the field never record anything', () => {
  it('navigating away with an unsaved draft creates no observation', async () => {
    const user = userEvent.setup()
    const { unmount } = renderSheet()
    const row = await fairingRow()
    await user.type(within(row).getByLabelText('New measurement (mm)'), '580')
    unmount()
    expect(rpcCalls).toHaveLength(0)
    expect(measurements).toHaveLength(0)
  })

  it('typing and tabbing away sends nothing and leaves the current value alone', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()

    await user.type(within(row).getByLabelText('New measurement (mm)'), '612')
    await user.tab()
    await user.tab()

    expect(rpcCalls).toHaveLength(0)
    expect(measurements).toHaveLength(0)
    expect(within(row).getByTestId('regulatory-status-spec-fairing')).toHaveTextContent('Not measured')
    expect(within(row).queryByTestId('confirm-spec-fairing')).not.toBeInTheDocument()
  })

  it('Review asks for confirmation naming the value and unit, and still sends nothing', async () => {
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '612')

    const confirm = within(row).getByTestId('confirm-spec-fairing')
    expect(confirm).toHaveTextContent('Record 612 mm for Fairing width?')
    expect(confirm).toHaveTextContent('adds one history entry')
    expect(rpcCalls).toHaveLength(0)
  })

  it('Cancel discards the review: nothing is sent', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '612', user)
    await user.click(within(row).getByRole('button', { name: 'Cancel' }))

    expect(within(row).queryByTestId('confirm-spec-fairing')).not.toBeInTheDocument()
    expect(rpcCalls).toHaveLength(0)
    expect(measurements).toHaveLength(0)
  })

  it('an empty box cannot be reviewed, so it can never clear or zero a measurement', async () => {
    renderSheet()
    const row = await fairingRow()
    expect(within(row).getByRole('button', { name: 'Review' })).toBeDisabled()
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('Save measurement records exactly one observation', () => {
  it('612 against the 600 mm limit fails — and the verdict comes back from the view', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()
    expect(within(row).getByTestId('regulatory-status-spec-fairing')).toHaveTextContent('Not measured')

    await typeAndReview(row, '612', user)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))

    await waitFor(() =>
      expect(within(screen.getByTestId('spec-spec-fairing')).getByTestId('regulatory-status-spec-fairing')).toHaveTextContent('Fail'),
    )
    expect(rpcCalls).toHaveLength(1)
    expect(measurements).toHaveLength(1)
    expect(screen.getByTestId('spec-spec-fairing')).toHaveAttribute('data-verdict', 'fail')
    // The box is emptied: the next value is a new measurement, not an edit.
    expect(within(screen.getByTestId('spec-spec-fairing')).getByLabelText('New measurement (mm)')).toHaveValue(null)
  })

  it('a value inside the limit passes — so the fail above is not just "any number fails"', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '580', user)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))
    await waitFor(() => expect(screen.getByTestId('spec-spec-fairing')).toHaveAttribute('data-verdict', 'pass'))
  })

  it('sends the value and a retry identity — no actor, no recorded time, no verdict', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '612', user)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))
    await waitFor(() => expect(rpcCalls).toHaveLength(1))

    expect(rpcCalls[0].fn).toBe('record_spec_measurement')
    const args = rpcCalls[0].args
    expect(args).toMatchObject({ p_season_id: 'season-a', p_spec_id: 'spec-fairing', p_value_numeric: 612 })
    expect(args.p_request_id).toMatch(/^[0-9a-f-]{36}$/)
    // Who measured and when it was recorded belong to the server.
    expect(Object.keys(args).sort()).toEqual(['p_context', 'p_request_id', 'p_season_id', 'p_spec_id', 'p_unit', 'p_value_numeric'])
    expect(args.p_context).toBe('team')
    expect(measurements[0].measured_by).toBe('m1')
  })

  it('zero is a value, not an empty box', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '0', user)
    expect(within(row).getByTestId('confirm-spec-fairing')).toHaveTextContent('Record 0 mm')
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))
    await waitFor(() => expect(rpcCalls).toHaveLength(1))
    expect(rpcCalls[0].args.p_value_numeric).toBe(0)
  })

  it('a negative value is sent as it was typed', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '-20.5', user)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))
    await waitFor(() => expect(rpcCalls).toHaveLength(1))
    expect(rpcCalls[0].args.p_value_numeric).toBe(-20.5)
  })

  it('a number that overflows never becomes reviewable, so nothing is sent', async () => {
    // A number field sanitises 1e999 to an empty value (parseMeasurementInput
    // has its own "too large" refusal for anything that still reaches it).
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()
    await user.type(within(row).getByLabelText('New measurement (mm)'), '1e999')
    expect(within(row).getByRole('button', { name: 'Review' })).toBeDisabled()
    expect(within(row).queryByTestId('confirm-spec-fairing')).not.toBeInTheDocument()
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('retries and repeats', () => {
  it('ignores a second save click while the same confirmation is pending', async () => {
    const user = userEvent.setup()
    let release = () => {}
    recordGate = new Promise<void>((resolve) => { release = resolve })
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '580', user)
    const save = within(row).getByRole('button', { name: 'Save measurement' })
    fireEvent.click(save)
    fireEvent.click(save)
    await waitFor(() => expect(rpcCalls).toHaveLength(1))
    expect(save).toBeDisabled()
    release()
    await waitFor(() => expect(measurements).toHaveLength(1))
  })

  it('a save whose response was lost is retried with the SAME request id and creates one row', async () => {
    const user = userEvent.setup()
    dropResponseOnce = true
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '612', user)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))

    // The server kept it; the person saw an error and the review is still open.
    expect(await within(row).findByTestId('save-error-spec-fairing')).toHaveTextContent('network connection lost')
    expect(within(row).getByTestId('confirm-spec-fairing')).toBeInTheDocument()
    expect(measurements).toHaveLength(1)

    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))
    await waitFor(() => expect(rpcCalls).toHaveLength(2))

    expect(rpcCalls[1].args.p_request_id).toBe(rpcCalls[0].args.p_request_id)
    await waitFor(() => expect(within(screen.getByTestId('spec-spec-fairing')).queryByTestId('confirm-spec-fairing')).not.toBeInTheDocument())
    expect(measurements).toHaveLength(1)
  })

  it('measuring the same value again later is a new observation with a new request id', async () => {
    const user = userEvent.setup()
    renderSheet()
    const row = await fairingRow()

    await typeAndReview(row, '580', user)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))
    await waitFor(() => expect(measurements).toHaveLength(1))
    await waitFor(() => expect(within(screen.getByTestId('spec-spec-fairing')).getByRole('button', { name: 'Review' })).toBeInTheDocument())

    const again = screen.getByTestId('spec-spec-fairing')
    await typeAndReview(again, '580', user)
    await user.click(within(again).getByRole('button', { name: 'Save measurement' }))
    await waitFor(() => expect(measurements).toHaveLength(2))

    expect(rpcCalls[1].args.p_request_id).not.toBe(rpcCalls[0].args.p_request_id)
  })

  it('a refusal by the database is reported and nothing looks saved', async () => {
    const user = userEvent.setup()
    rpcError = { message: 'value -60 is below the plausible minimum -50 for this specification', code: '22003' }
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '-60', user)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))

    expect(await within(row).findByTestId('save-error-spec-fairing')).toHaveTextContent('plausible minimum -50')
    expect(within(row).getByTestId('confirm-spec-fairing')).toBeInTheDocument()
    expect(within(row).getByTestId('regulatory-status-spec-fairing')).toHaveTextContent('Not measured')
  })

  it('a permission refusal is worded for a person, not as raw SQL', async () => {
    const user = userEvent.setup()
    rpcError = { message: 'permission denied for function record_spec_measurement', code: '42501' }
    renderSheet()
    const row = await fairingRow()
    await typeAndReview(row, '580', user)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))
    expect(await within(row).findByTestId('save-error-spec-fairing')).toHaveTextContent(/don't have permission to record a measurement/)
  })
})

// --- The verdict source ------------------------------------------------------

describe('the verdict comes from SQL, not from React', () => {
  it('renders what the view says even when that contradicts the raw numbers', async () => {
    // 612 against a max of 600, but the view (here, forced) says 'pass'.
    // A component that duplicated `measured > target` would print FAILS RULE.
    // Obeying the view is the whole point: the database owns the rule.
    specs = [{ ...FAIRING, measured: 612, current_measurement_id: 'meas-x' }]
    forcedVerdict = 'pass'
    renderSheet()
    const row = await fairingRow()
    expect(row).toHaveAttribute('data-verdict', 'pass')
    expect(within(row).getByTestId('regulatory-status-spec-fairing')).toHaveTextContent('Pass')
  })

  it('says a measured value cannot be judged when the rule is incomplete — never a pass', async () => {
    specs = [{ ...FAIRING, target: null, measured: 612, current_measurement_id: 'meas-x' }]
    renderSheet()
    const row = await fairingRow()
    expect(row).toHaveAttribute('data-verdict', 'unevaluable')
    expect(within(row).getByTestId('regulatory-status-spec-fairing')).toHaveTextContent('Cannot be judged')
    expect(screen.getByTestId('spec-summary')).toHaveTextContent('1 of 1 measured')
    expect(screen.getByTestId('spec-summary')).toHaveTextContent('1 with an incomplete rule')
  })

  it('shows the range rule with its own bounds and inclusivity', async () => {
    specs = [{
      ...FAIRING, id: 'spec-number', parameter: 'Competition number', comparator: 'range', direction: 'range',
      target: 1, target_max: 99, target_min_inclusive: false, target_max_inclusive: true, unit: null, clause_key: 'A.3.1.6',
    }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-number')
    expect(within(row).getByText('(1, 99]')).toBeInTheDocument()
  })

  it('uses the structured range bounds instead of an ambiguous legacy label', async () => {
    specs = [{ ...FAIRING, id: 'spec-number', comparator: 'range', direction: 'range', target: 1, target_max: 99, target_text: '1–99', unit: null }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-number')
    expect(within(row).getByTestId('comparison-regulatory-spec-number')).toHaveTextContent('[1, 99]')
  })
})

describe('a yes/no specification', () => {
  const FLAG = {
    ...FAIRING, id: 'spec-flag', parameter: 'Kill switch fitted', comparator: 'bool', direction: 'boolean',
    measure_kind: 'boolean', target: null, target_bool: true, unit: null, clause_key: null,
  }

  it('records an explicit yes or no, never a number', async () => {
    const user = userEvent.setup()
    specs = [{ ...FLAG }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-flag')
    await user.selectOptions(within(row).getByLabelText('New measurement'), 'false')
    await user.click(within(row).getByRole('button', { name: 'Review' }))
    expect(within(row).getByTestId('confirm-spec-flag')).toHaveTextContent('Record No for Kill switch fitted?')
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))

    await waitFor(() => expect(rpcCalls).toHaveLength(1))
    expect(rpcCalls[0].args.p_value_bool).toBe(false)
    expect(rpcCalls[0].args).not.toHaveProperty('p_value_numeric')
    await waitFor(() => expect(screen.getByTestId('spec-spec-flag')).toHaveAttribute('data-verdict', 'fail'))
    expect(screen.getByTestId('comparison-current-spec-flag')).toHaveTextContent('No')
  })

  it('cannot review with nothing chosen', async () => {
    specs = [{ ...FLAG }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-flag')
    expect(within(row).getByRole('button', { name: 'Review' })).toBeDisabled()
  })
})

// --- Presentation ---------------------------------------------------------------

describe('presentation', () => {
  it('keeps a former member read-only', async () => {
    signedInMember = { ...MEMBER, status: 'alumni' }
    renderSheet()
    const row = await fairingRow()
    expect(within(row).getByText('Read-only: only active members can record observations.')).toBeInTheDocument()
    expect(within(row).queryByLabelText('New measurement (mm)')).not.toBeInTheDocument()
  })

  it('shows who measured it and when, in the reader\'s day', async () => {
    specs = [{ ...FAIRING, measured: 580, measured_by: 'm1', measured_at: '2026-09-09T10:00:00Z', current_measurement_id: 'meas-x' }]
    renderSheet()
    expect(await screen.findByTestId('measured-by-spec-fairing')).toHaveTextContent('by Ada Rider')
    expect(screen.getByTestId('comparison-current-spec-fairing')).toHaveTextContent('580 mm')
  })

  it('names the rule a failing measurement breaks', async () => {
    specs = [{ ...FAIRING, measured: 612, current_measurement_id: 'meas-x' }]
    renderSheet()
    expect(await screen.findByTestId('spec-rule-spec-fairing')).toHaveTextContent('B.2.1.9')
  })

  it('gives the measurement input an accessible name', async () => {
    renderSheet()
    expect(await screen.findByLabelText('New measurement (mm)')).toBeInTheDocument()
  })

  it('counts a specification as measured once it has a current observation', async () => {
    specs = [{ ...FAIRING, measured: 0, current_measurement_id: 'meas-x' }]
    renderSheet()
    await fairingRow()
    // Zero is a measurement: it must count, and it is not "not measured".
    expect(screen.getByTestId('spec-summary')).toHaveTextContent('1 of 1 measured')
  })
})

function observation(
  id: string,
  value: number,
  measuredAt: string | null,
  patch: Record<string, unknown> = {},
) {
  return {
    id, spec_id: 'spec-mass', season_id: 'season-a', value_numeric: value, value_bool: null,
    measured_at: measuredAt, recorded_at: measuredAt ?? '2026-09-01T10:00:00Z', measured_by: 'm1',
    request_id: `request-${id}`, origin: 'entered', note: null, source: null, corrects_id: null,
    invalidated_at: null, invalidated_by: null, invalidation_reason: null, ...patch,
  }
}

describe('Phase 10 comparison and progression flow', () => {
  const MASS = {
    ...FAIRING,
    id: 'spec-mass', parameter: 'Vehicle mass', unit: 'kg', clause_key: 'T 1.2', sort_order: 1,
    comparator: 'max', direction: 'lower_better', target: 160,
    acceptable: 158, goal: 145, ideal: 138,
    measured: 159, measured_by: 'm1', measured_at: '2026-09-18T10:00:00Z', current_measurement_id: 'mass-159',
  }

  it('records 153.2 once, shows the server pass/amber statuses, and updates history and chart', async () => {
    const user = userEvent.setup()
    specs = [{ ...MASS }]
    measurements = [
      observation('mass-159', 159, '2026-09-18T10:00:00Z'),
      observation('mass-164', 164, '2026-09-11T10:00:00Z'),
      observation('mass-171', 171, '2026-09-05T10:00:00Z'),
    ]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-mass')

    expect(within(row).getByTestId('comparison-acceptable-spec-mass')).toHaveTextContent('158 kg')
    expect(within(row).getByText('Maximum acceptable')).toBeInTheDocument()
    expect(within(row).getByTestId('comparison-goal-spec-mass')).toHaveTextContent('145 kg')
    expect(within(row).getByTestId('comparison-ideal-spec-mass')).toHaveTextContent('138 kg')
    expect(within(row).getByTestId('comparison-regulatory-spec-mass')).toHaveTextContent('≤ 160 kg')

    await typeAndReview(row, '153.2', user)
    expect(measurements).toHaveLength(3)
    await user.click(within(row).getByRole('button', { name: 'Save measurement' }))

    await waitFor(() => expect(measurements).toHaveLength(4))
    const updated = screen.getByTestId('spec-spec-mass')
    expect(within(updated).getByTestId('comparison-current-spec-mass')).toHaveTextContent('153.2 kg')
    expect(within(updated).getByTestId('regulatory-status-spec-mass')).toHaveTextContent('Pass')
    expect(within(updated).getByTestId('goal-status-spec-mass')).toHaveTextContent('Not met')
    expect(within(updated).getByTestId('zone-spec-mass')).toHaveTextContent('Amber zone')
    expect(rpcCalls.filter((call) => call.fn === 'record_spec_measurement')).toHaveLength(1)

    await user.click(within(updated).getByRole('button', { name: 'Show history' }))
    expect(await within(updated).findByTestId('progression-spec-mass')).toHaveTextContent('171 → 164 → 159 → 153.2 kg')
    expect(within(updated).getByTestId('trend-spec-mass').querySelector('svg')).toHaveAttribute('data-values', '171,164,159,153.2')
    expect(within(updated).getByTestId('history-table-spec-mass')).toHaveTextContent('153.2 kg')
    expect(within(updated).getByTestId('history-table-spec-mass')).toHaveTextContent('Ada Rider')
  })

  it('typing 3, then 30, then 300 creates no history and 300 is reviewable without a per-spec bound', async () => {
    const user = userEvent.setup()
    specs = [{ ...MASS, measured: null, measured_by: null, measured_at: null, current_measurement_id: null }]
    measurements = []
    renderSheet()
    const row = await screen.findByTestId('spec-spec-mass')
    const input = within(row).getByLabelText('New measurement (kg)')
    await user.type(input, '3')
    await user.clear(input)
    await user.type(input, '30')
    await user.clear(input)
    await user.type(input, '300')
    expect(rpcCalls).toHaveLength(0)
    expect(measurements).toHaveLength(0)
    await user.click(within(row).getByRole('button', { name: 'Review' }))
    expect(within(row).getByTestId('confirm-spec-mass')).toHaveTextContent('Record 300 kg')
    expect(measurements).toHaveLength(0)
  })

  it('blocks a value outside this specification\'s declared plausibility bounds before history', async () => {
    const user = userEvent.setup()
    specs = [{ ...MASS, plausible_max: 250 }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-mass')
    await user.type(within(row).getByLabelText('New measurement (kg)'), '300')
    await user.click(within(row).getByRole('button', { name: 'Review' }))
    expect(within(row).getByRole('alert')).toHaveTextContent('plausible maximum is 250 kg')
    expect(rpcCalls).toHaveLength(0)
  })

  it('keeps an unsaved draft when realtime brings a newer Current and offers explicit choices', async () => {
    const user = userEvent.setup()
    specs = [{ ...MASS }]
    const { queryClient } = renderSheet()
    const row = await screen.findByTestId('spec-spec-mass')
    const input = within(row).getByLabelText('New measurement (kg)')
    await user.type(input, '153.2')

    specs = [{
      ...MASS, measured: 152.8, measured_by: 'm1', measured_at: '2026-09-20T09:00:00Z', current_measurement_id: 'mass-external',
    }]
    await act(async () => { await queryClient.invalidateQueries() })

    const updated = screen.getByTestId('spec-spec-mass')
    expect(await within(updated).findByTestId('realtime-conflict-spec-mass')).toHaveTextContent('Your draft is unchanged')
    expect(within(updated).getByLabelText('New measurement (kg)')).toHaveValue(153.2)
    expect(within(updated).getByTestId('comparison-current-spec-mass')).toHaveTextContent('152.8 kg')
    await user.click(within(updated).getByRole('button', { name: 'Keep my draft' }))
    expect(within(updated).queryByTestId('realtime-conflict-spec-mass')).not.toBeInTheDocument()
    expect(within(updated).getByLabelText('New measurement (kg)')).toHaveValue(153.2)
    expect(rpcCalls).toHaveLength(0)
  })

  it('shows danger and status meaning with text and a visible shape, not colour alone', async () => {
    specs = [{ ...MASS, measured: 165, current_measurement_id: 'mass-fail' }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-mass')
    const zone = within(row).getByTestId('zone-spec-mass')
    const regulatory = within(row).getByTestId('regulatory-status-spec-mass')
    expect(zone).toHaveTextContent('✕Red zone — regulatory failure')
    expect(regulatory).toHaveTextContent('✕Regulatory rule: Fail')
  })

  it('uses a wrapping thresholds grid and a scrollable history table for narrow layouts', async () => {
    const user = userEvent.setup()
    specs = [{ ...MASS }]
    measurements = [observation('mass-159', 159, '2026-09-18T10:00:00Z')]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-mass')
    expect(within(row).getByTestId('thresholds-spec-mass')).toHaveClass('grid-cols-1', 'sm:grid-cols-2')
    await user.click(within(row).getByRole('button', { name: 'Show history' }))
    const table = await within(row).findByTestId('history-table-spec-mass')
    expect(table.parentElement).toHaveClass('overflow-x-auto')
  })
})

describe('history correction and withdrawal', () => {
  const SPEC = {
    ...FAIRING,
    measured: 580, measured_by: 'm1', measured_at: '2026-09-20T10:00:00Z', current_measurement_id: 'meas-own',
  }

  it('requires a reason, appends a correction, and keeps the old observation marked', async () => {
    const user = userEvent.setup()
    specs = [{ ...SPEC }]
    measurements = [{ ...observation('meas-own', 580, '2026-09-20T10:00:00Z'), spec_id: 'spec-fairing' }]
    renderSheet()
    const row = await fairingRow()
    await user.click(within(row).getByRole('button', { name: 'Show history' }))
    const old = await within(row).findByTestId('measurement-meas-own')
    await user.click(within(old).getByRole('button', { name: 'Correct' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Save correction' })).toBeDisabled()
    await user.clear(within(dialog).getByLabelText('Corrected value (mm)'))
    await user.type(within(dialog).getByLabelText('Corrected value (mm)'), '575')
    await user.type(within(dialog).getByLabelText(/Reason/), 'Scale was not zeroed')
    await user.click(within(dialog).getByRole('button', { name: 'Save correction' }))

    await waitFor(() => expect(rpcCalls.some((call) => call.fn === 'correct_spec_measurement')).toBe(true))
    expect(measurements).toHaveLength(2)
    expect(measurements.find((measurement) => measurement.id === 'meas-own')?.invalidation_reason).toBe('Scale was not zeroed')
    expect(measurements[0]).toMatchObject({ origin: 'correction', corrects_id: 'meas-own', value_numeric: 575 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await within(row).findByText(/Replaced by a correction: Scale was not zeroed/)).toBeInTheDocument()
  })

  it('withdraws deliberately with a required reason and preserves the row', async () => {
    const user = userEvent.setup()
    specs = [{ ...SPEC }]
    measurements = [{ ...observation('meas-own', 580, '2026-09-20T10:00:00Z'), spec_id: 'spec-fairing' }]
    renderSheet()
    const row = await fairingRow()
    await user.click(within(row).getByRole('button', { name: 'Show history' }))
    const old = await within(row).findByTestId('measurement-meas-own')
    await user.click(within(old).getByRole('button', { name: 'Withdraw' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Withdraw observation' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText(/Reason/), 'Measured the wrong assembly')
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw observation' }))
    await waitFor(() => expect(rpcCalls.some((call) => call.fn === 'invalidate_spec_measurement')).toBe(true))
    expect(measurements).toHaveLength(1)
    expect(measurements[0]).toMatchObject({ invalidation_reason: 'Measured the wrong assembly' })
  })

  it('keeps competition results out of the team trend and its progression text', async () => {
    const user = userEvent.setup()
    specs = [{ ...SPEC, id: 'spec-mass', parameter: 'Vehicle mass', unit: 'kg', current_measurement_id: 'newest', measured: 153 }]
    measurements = [
      observation('newest', 153, '2026-09-22T10:00:00Z'),
      observation('competition-day', 120, '2026-09-21T10:00:00Z', { context: 'competition' }),
      observation('oldest', 171, '2026-09-05T10:00:00Z'),
    ]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-mass')
    await user.click(within(row).getByRole('button', { name: 'Show history' }))
    expect(await within(row).findByTestId('progression-spec-mass')).toHaveTextContent('171 → 153 kg')
    expect(within(row).getByTestId('trend-spec-mass').querySelector('svg')).toHaveAttribute('data-values', '171,153')
    // It is still listed in the history table, labelled.
    expect(within(within(row).getByTestId('history-table-spec-mass')).getAllByRole('row')).toHaveLength(4)
  })

  it('keeps backdated rows in database order and gives numeric chart values the reverse chronological progression', async () => {
    const user = userEvent.setup()
    specs = [{ ...SPEC, id: 'spec-mass', parameter: 'Vehicle mass', unit: 'kg', current_measurement_id: 'newest', measured: 153 }]
    measurements = [
      observation('newest', 153, '2026-09-22T10:00:00Z'),
      observation('middle', 159, '2026-09-18T10:00:00Z'),
      observation('oldest', 171, '2026-09-05T10:00:00Z'),
    ]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-mass')
    await user.click(within(row).getByRole('button', { name: 'Show history' }))
    const tableRows = within(await within(row).findByTestId('history-table-spec-mass')).getAllByRole('row').slice(1)
    expect(tableRows.map((tableRow) => within(tableRow).getAllByRole('cell')[1].textContent)).toEqual([
      expect.stringContaining('153 kg'), expect.stringContaining('159 kg'), expect.stringContaining('171 kg'),
    ])
    expect(within(row).getByTestId('progression-spec-mass')).toHaveTextContent('171 → 159 → 153 kg')
  })

  it('does not invent a numeric chart for boolean history', async () => {
    const user = userEvent.setup()
    specs = [{
      ...SPEC, id: 'spec-flag', parameter: 'Kill switch', comparator: 'bool', direction: 'boolean', measure_kind: 'boolean',
      target: null, target_bool: true, unit: null, measured: null, measured_bool: true,
    }]
    measurements = [{ ...observation('flag-1', 0, '2026-09-20T10:00:00Z'), spec_id: 'spec-flag', value_numeric: null, value_bool: true }]
    renderSheet()
    const row = await screen.findByTestId('spec-spec-flag')
    await user.click(within(row).getByRole('button', { name: 'Show history' }))
    expect(await within(row).findByTestId('history-table-spec-flag')).toHaveTextContent('Yes')
    expect(within(row).queryByTestId('trend-spec-flag')).not.toBeInTheDocument()
  })
})

describe('the compact table', () => {
  it('lists every spec collapsed, with Parameter/unit, Current (ours), Ideal, Regulatory limit and Competition', async () => {
    specs = [{ ...FAIRING }]
    renderSheet('/specs')
    const table = await screen.findByRole('table', { name: 'Specifications' })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Parameter / unit', 'Current (ours)', 'Ideal', 'Regulatory limit', 'Competition',
    ])
    const row = screen.getByTestId('spec-spec-fairing')
    expect(within(row).getByTestId('spec-toggle-spec-fairing')).toHaveAttribute('aria-expanded', 'false')
    // Collapsed: the editor is not on screen until the row is opened.
    expect(within(row).queryByLabelText('New measurement (mm)')).not.toBeInTheDocument()
    expect(within(row).getByTestId('comparison-current-spec-fairing')).toHaveTextContent('Not measured')
    expect(within(row).getByTestId('comparison-regulatory-spec-fairing')).toHaveTextContent('≤ 600 mm')
  })

  it('opens a row into the editor and history, and keeps that in the address with other parameters', async () => {
    const user = userEvent.setup()
    specs = [{ ...FAIRING }]
    renderSheet('/specs?keep=1')
    const row = await fairingRow()
    await user.click(within(row).getByTestId('spec-toggle-spec-fairing'))
    expect(within(row).getByTestId('spec-toggle-spec-fairing')).toHaveAttribute('aria-expanded', 'true')
    expect(within(row).getByLabelText('New measurement (mm)')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Show history' })).toBeInTheDocument()
    await user.click(within(row).getByTestId('spec-toggle-spec-fairing'))
    expect(within(row).queryByLabelText('New measurement (mm)')).not.toBeInTheDocument()
  })

  it('shows zero as a measurement and nothing as unknown', async () => {
    specs = [
      { ...FAIRING, measured: 0, current_measurement_id: 'meas-0' },
      { ...FAIRING, id: 'spec-empty', parameter: 'Empty one', sort_order: 2 },
    ]
    renderSheet('/specs')
    expect(await screen.findByTestId('comparison-current-spec-fairing')).toHaveTextContent('0 mm')
    expect(screen.getByTestId('comparison-current-spec-empty')).toHaveTextContent('Not measured')
    expect(screen.getByTestId('comparison-current-spec-empty')).not.toHaveTextContent('0')
  })

  it('marks each zone in words as well as colour, and leaves unknown neutral', async () => {
    specs = [
      // The fake view derives the zone from the numbers, as spec_verdicts does:
      // limit 600 mm (max), lower is better.
      { ...FAIRING, id: 'z-red', measured: 612, current_measurement_id: 'm-r', sort_order: 1 },
      { ...FAIRING, id: 'z-amber', measured: 580, goal: 550, current_measurement_id: 'm-a', sort_order: 2 },
      { ...FAIRING, id: 'z-green', measured: 540, goal: 550, current_measurement_id: 'm-g', sort_order: 3, readiness: 'ready' },
      { ...FAIRING, id: 'z-grey', sort_order: 4 },
    ]
    renderSheet('/specs')
    expect(await screen.findByTestId('zone-cue-z-red')).toHaveTextContent('Fails the rule')
    expect(screen.getByTestId('zone-cue-z-amber')).toHaveTextContent('Passes the rule · not confirmed ready')
    expect(screen.getByTestId('zone-cue-z-green')).toHaveTextContent('Passes the rule · confirmed ready')
    expect(screen.getByTestId('zone-cue-z-grey')).toHaveTextContent('Not judged yet')
    expect(screen.getByTestId('spec-z-red').className).toMatch(/shadow-\[/)
    expect(screen.getByTestId('spec-z-grey').className).not.toMatch(/shadow-\[/)
  })

  it('says competition data is unavailable instead of inventing it, even for a green row', async () => {
    specs = [{ ...FAIRING, measured: 540, goal: 550, current_measurement_id: 'meas-x', readiness: 'ready' }]
    renderSheet('/specs')
    await waitFor(() => expect(screen.getByTestId('spec-spec-fairing')).toHaveAttribute('data-zone', 'green'))
    expect(await screen.findByTestId('competition-spec-fairing')).toHaveTextContent('No competition data')
    expect(screen.getByTestId('competition-note')).toHaveTextContent(/never replaces/)
    expect(screen.queryByText(/approved/i)).not.toBeInTheDocument()
  })
})

// --- Phase 4: readiness, competition evidence and reviewed directions ---------------------------

describe('readiness, competition and direction', () => {
  const PASSING = () => ({ ...FAIRING, measured: 540, current_measurement_id: 'meas-current', measured_at: NOW })

  it('an ordinary member sees that nothing is confirmed, cannot confirm it, and cannot record a competition result', async () => {
    specs = [PASSING()]
    renderSheet()
    const panel = await screen.findByTestId('readiness-spec-fairing')
    expect(within(panel).getByTestId('readiness-state-spec-fairing')).toHaveTextContent('Not confirmed ready')
    expect(within(panel).queryByRole('button', { name: /Confirm ready/ })).not.toBeInTheDocument()
    expect(within(panel).getByTestId('readiness-why-not-spec-fairing')).toHaveTextContent(/confirms readiness/)
    expect(screen.getByTestId('competition-readonly-spec-fairing')).toBeInTheDocument()
    expect(screen.queryByTestId('measurement-editor-spec-fairing-competition')).not.toBeInTheDocument()
    expect(screen.getByTestId('spec-spec-fairing')).toHaveAttribute('data-zone', 'amber')
  })

  it('a Developer confirms the CURRENT measurement with a note; nothing is sent without the note', async () => {
    signedInRoles = ['developer']
    const user = userEvent.setup()
    specs = [PASSING()]
    renderSheet()
    const panel = await screen.findByTestId('readiness-spec-fairing')
    const button = within(panel).getByRole('button', { name: 'Confirm ready' })
    expect(button).toBeDisabled()
    await user.type(within(panel).getByLabelText('What was checked?'), 'Measured with the jig')
    await user.click(button)
    await waitFor(() => expect(rpcCalls.filter((c) => c.fn === 'confirm_spec_readiness')).toHaveLength(1))
    expect(rpcCalls.find((c) => c.fn === 'confirm_spec_readiness')?.args).toEqual({
      p_spec_id: 'spec-fairing', p_measurement_id: 'meas-current', p_note: 'Measured with the jig',
    })
  })

  it('shows a lapsed confirmation as "was ready", never as ready, with the reason', async () => {
    specs = [{ ...PASSING(), readiness: 'lapsed', readiness_reason: 'A newer measurement became the current one.', readiness_confirmed_at: '2026-09-01T10:00:00Z' }]
    renderSheet()
    const panel = await screen.findByTestId('readiness-spec-fairing')
    expect(within(panel).getByTestId('readiness-state-spec-fairing')).toHaveTextContent(/^Was ready on .* — no longer/)
    expect(within(panel).getByTestId('readiness-detail-spec-fairing')).toHaveTextContent('A newer measurement became the current one.')
    expect(screen.getByTestId('spec-spec-fairing')).toHaveAttribute('data-zone', 'amber')
  })

  it('a Developer records a competition result apart from ours, after an explicit review and save', async () => {
    signedInRoles = ['developer']
    const user = userEvent.setup()
    specs = [PASSING()]
    renderSheet()
    const editor = await screen.findByTestId('measurement-editor-spec-fairing-competition')
    await user.type(within(editor).getByLabelText(/^New measurement/), '590')
    await user.click(within(editor).getByRole('button', { name: 'Review' }))
    expect(rpcCalls).toHaveLength(0) // reviewing writes nothing
    await user.click(within(editor).getByRole('button', { name: 'Save competition result' }))
    await waitFor(() => expect(rpcCalls).toHaveLength(1))
    expect(rpcCalls[0].fn).toBe('record_spec_measurement')
    expect(rpcCalls[0].args).toMatchObject({ p_context: 'competition', p_unit: 'mm', p_value_numeric: 590 })
  })

  it('shows the competition value in its own column, with its own verdict, never as Current (ours)', async () => {
    specs = [{ ...PASSING(), competition_measurement_id: 'c1', competition_value: 612, competition_verdict: 'fail' }]
    renderSheet()
    const cell = await screen.findByTestId('competition-spec-fairing')
    expect(cell).toHaveTextContent('612 mm')
    expect(cell).toHaveTextContent('Fails the rule')
    expect(screen.getByTestId('comparison-current-spec-fairing')).toHaveTextContent('540 mm')
  })

  it('says a higher/lower direction is not reviewed, and lets a Developer confirm it with a reason', async () => {
    signedInRoles = ['developer']
    const user = userEvent.setup()
    specs = [{ ...PASSING(), direction_needs_review: true }]
    renderSheet()
    const panel = await screen.findByTestId('direction-review-spec-fairing')
    expect(within(panel).getByTestId('direction-unreviewed-spec-fairing')).toHaveTextContent(/Not reviewed/)
    const confirm = within(panel).getByRole('button', { name: 'Confirm direction' })
    expect(confirm).toBeDisabled()
    await user.type(within(panel).getByLabelText('The engineering reason'), 'Narrower is better for drag')
    // The derived direction is what is being questioned: nothing is preselected, so a reason alone is not enough.
    expect(confirm).toBeDisabled()
    await user.selectOptions(within(panel).getByLabelText('For the project, which is better?'), 'lower_better')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(rpcCalls.filter((c) => c.fn === 'review_spec_direction')).toHaveLength(1))
    expect(rpcCalls.find((c) => c.fn === 'review_spec_direction')?.args).toEqual({
      p_spec_id: 'spec-fairing', p_direction: 'lower_better', p_note: 'Narrower is better for drag',
    })
  })

  it('offers an ordinary member no direction control', async () => {
    specs = [{ ...PASSING(), direction_needs_review: true }]
    renderSheet()
    const panel = await screen.findByTestId('direction-review-spec-fairing')
    expect(within(panel).queryByRole('button', { name: 'Confirm direction' })).not.toBeInTheDocument()
    expect(panel).toHaveTextContent(/President or Vice President reviews it/)
  })
})
