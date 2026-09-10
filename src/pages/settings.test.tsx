import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake that enforces the SAME rules the database does, so a test can tell the
// difference between "the UI hid the button" and "the write was refused".
const BOARD = { id: 'm1', full_name: 'Ada Rider', role: 'President', is_board: true, status: 'active' }
const CREW = { id: 'm2', full_name: 'Bo Wrench', role: 'Chassis', is_board: false, status: 'active' }

let db: Record<string, Record<string, unknown>[]>
let rpcCalls: { fn: string; args: unknown }[]
let caller = BOARD

function reset() {
  db = {
    members: [{ ...BOARD }, { ...CREW }],
    subteams: [{ key: 'GEOM', name: 'Design Envelope', description: null, lead_id: null, is_parked: false, sort_order: 0 }],
    seasons: [
      { id: 'sa', label: '2026/27', edition: null, is_current: true },
      { id: 'sb', label: '2027/28', edition: null, is_current: false },
    ],
    v_current_season: [],
    milestones: [{ key: 'MS1-1', season_id: 'sa', ordinal: 1, name: 'Team Plan', opens_on: '2026-11-01', due_on: '2026-11-30', max_points: 75, is_blocking: false, aim: null, article_ref: null, notes: null }],
    handover_notes: [],
    tasks: [], topics: [], clause_status: [], clauses: [],
  }
  db.v_current_season = db.seasons.filter((s) => s.is_current)
  rpcCalls = []
  caller = BOARD
}

// Mirrors the real policies: members INSERT needs is_board(); subteams ALL
// needs is_board(); there is NO delete policy for members at all.
function policyAllows(table: string, op: string): boolean {
  if (table === 'members' && op === 'insert') return caller.is_board
  if (table === 'members' && op === 'delete') return false
  if (table === 'subteams') return caller.is_board
  return true
}

function makeBuilder(table: string) {
  const ctx: { op: string; payload?: Record<string, unknown>; filters: Record<string, unknown>; single: boolean } = {
    op: 'select', filters: {}, single: false,
  }
  const run = () => {
    if (ctx.op !== 'select' && !policyAllows(table, ctx.op)) {
      return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } }
    }
    if (ctx.op === 'insert' || ctx.op === 'upsert') {
      const row: Record<string, unknown> = {
        id: `${table}-${db[table].length + 1}`,
        ...ctx.payload,
      }
      const keyField = table === 'handover_notes' ? 'subteam_key' : 'id'
      const i = db[table].findIndex((r) => r[keyField] === row[keyField])
      if (ctx.op === 'upsert' && i >= 0) db[table][i] = { ...db[table][i], ...ctx.payload }
      else db[table].push(row)
      return { data: row, error: null }
    }
    if (ctx.op === 'update') {
      db[table] = db[table].map((r) =>
        Object.entries(ctx.filters).every(([k, v]) => r[k] === v) ? { ...r, ...ctx.payload } : r,
      )
      return { data: null, error: null }
    }
    let rows = [...(db[table] ?? [])]
    for (const [k, v] of Object.entries(ctx.filters)) rows = rows.filter((r) => r[k] === v)
    return { data: ctx.single ? (rows[0] ?? null) : rows, error: null }
  }
  const b: Record<string, unknown> = {
    select: () => b, order: () => b, in: () => b, range: () => b, limit: () => b,
    eq: (c: string, v: unknown) => { ctx.filters[c] = v; return b },
    insert: (p: Record<string, unknown>) => { ctx.op = 'insert'; ctx.payload = p; return b },
    update: (p: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = p; return b },
    upsert: (p: Record<string, unknown>) => { ctx.op = 'upsert'; ctx.payload = p; return b },
    delete: () => { ctx.op = 'delete'; return b },
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
    // The real function refuses non-board callers in SQL.
    if (!caller.is_board) {
      return { data: null, error: { message: 'Only board members may change the current season', code: '42501' } }
    }
    // One transaction: clear then set.
    db.seasons = db.seasons.map((s) => ({ ...s, is_current: s.id === args.p_season_id }))
    db.v_current_season = db.seasons.filter((s) => s.is_current)
    return { data: null, error: null }
  },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: caller.id }, member: caller }),
}))

const { default: Settings } = await import('./Settings.tsx')
const { buildSeasonExport } = await import('../data/exportSeason.ts')

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Settings /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(reset)

// --- Authorization -----------------------------------------------------------

describe('board vs non-board access', () => {
  it('a board member sees the roster, subsystem, milestone and season controls', async () => {
    renderSettings()
    expect(await screen.findByText('Add someone to the roster')).toBeInTheDocument()
    expect(screen.getByText('Subsystems')).toBeInTheDocument()
    expect(screen.getByText('Milestone dates and points')).toBeInTheDocument()
    expect(screen.getByText('Start a new season')).toBeInTheDocument()
  })

  it('a non-board member sees none of them, and is told why', async () => {
    caller = CREW
    renderSettings()
    expect(await screen.findByText(/reserved for the board/)).toBeInTheDocument()
    expect(screen.queryByText('Add someone to the roster')).not.toBeInTheDocument()
    expect(screen.queryByText('Subsystems')).not.toBeInTheDocument()
    expect(screen.queryByText('Start a new season')).not.toBeInTheDocument()
    // Handover notes stay open to everyone.
    expect(screen.getByText('Handover notes')).toBeInTheDocument()
  })

  it('the DATABASE refuses a non-board write even if the UI is bypassed', async () => {
    caller = CREW
    const { useAddMember } = await import('../data/useSettings.ts')
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const { renderHook } = await import('@testing-library/react')
    const { result } = renderHook(() => useAddMember(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    await expect(
      result.current.mutateAsync({ id: 'x', fullName: 'Sneaky', role: 'r', isBoard: true }),
    ).rejects.toThrow(/row-level security/)
    expect(db.members).toHaveLength(2)
  })

  it('the season switch is refused for a non-board caller by the database', async () => {
    caller = CREW
    const { useSetCurrentSeason } = await import('../data/useSettings.ts')
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const { renderHook } = await import('@testing-library/react')
    const { result } = renderHook(() => useSetCurrentSeason(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    await expect(result.current.mutateAsync('sb')).rejects.toThrow(/board members/)
    expect(db.seasons.find((s) => s.id === 'sa')?.is_current).toBe(true)
  })
})

// --- Roster ------------------------------------------------------------------

describe('roster', () => {
  it('retires a member to alumni instead of deleting them', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('member-m2')
    await user.selectOptions(within(row).getByLabelText('Status for Bo Wrench'), 'alumni')
    await waitFor(() => expect(db.members.find((m) => m.id === 'm2')?.status).toBe('alumni'))
    // Still present — historical owner references keep resolving.
    expect(db.members).toHaveLength(2)
    expect(db.members.find((m) => m.id === 'm2')?.full_name).toBe('Bo Wrench')
  })

  it('has no delete path at all', async () => {
    renderSettings()
    await screen.findByTestId('member-m2')
    expect(screen.queryByRole('button', { name: /delete|remove/i })).not.toBeInTheDocument()
    expect(policyAllows('members', 'delete')).toBe(false)
  })

  it('toggles the board flag', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('member-m2')
    await user.click(within(row).getByLabelText('Board'))
    await waitFor(() => expect(db.members.find((m) => m.id === 'm2')?.is_board).toBe(true))
  })

  it('links a member by pasting the Auth UUID — it never creates the login', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByText('Add someone to the roster')
    // The safe two-step process is spelled out on screen.
    expect(screen.getByText(/Authentication → Users → Add user/)).toBeInTheDocument()
    expect(screen.getByText(/service_role key in your browser/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Auth user UUID'), 'uuid-123')
    await user.type(screen.getByLabelText('Full name'), 'Cam Newbie')
    await user.click(screen.getByRole('button', { name: 'Link to roster' }))
    await waitFor(() => expect(db.members).toHaveLength(3))
    expect(db.members[2]).toMatchObject({ id: 'uuid-123', full_name: 'Cam Newbie' })
  })
})

// --- Subteams, milestones, notes ---------------------------------------------

describe('subsystems', () => {
  it('renames and assigns a lead without touching the key', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('subteam-row-GEOM')
    const name = within(row).getByLabelText('Name for GEOM')
    await user.clear(name)
    await user.type(name, 'Design Envelope & Geometry')
    await user.tab()
    await waitFor(() => expect(db.subteams[0].name).toBe('Design Envelope & Geometry'))

    await user.selectOptions(within(row).getByLabelText('Lead for GEOM'), 'm2')
    await waitFor(() => expect(db.subteams[0].lead_id).toBe('m2'))
    // The key is the join target for 1,146 clauses — it must not change.
    expect(db.subteams[0].key).toBe('GEOM')
  })
})

describe('milestone administration', () => {
  it('edits points, and accepts a blank due date as a real value', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('ms-row-MS1-1')

    const points = within(row).getByLabelText('Max points for MS1-1')
    await user.clear(points)
    await user.type(points, '90')
    await user.tab()
    await waitFor(() => expect(db.milestones[0].max_points).toBe(90))

    await user.clear(within(row).getByLabelText('Due on for MS1-1'))
    await user.tab()
    await waitFor(() => expect(db.milestones[0].due_on).toBeNull())
  })
})

describe('handover notes', () => {
  it('saves one note per subsystem into handover_notes', async () => {
    const user = userEvent.setup()
    renderSettings()
    const box = await screen.findByLabelText('Design Envelope')
    await user.type(box, 'Check the jig alignment first.')
    await user.tab()
    await waitFor(() => expect(db.handover_notes).toHaveLength(1))
    expect(db.handover_notes[0]).toMatchObject({
      subteam_key: 'GEOM',
      body: 'Check the jig alignment first.',
      updated_by: 'm1',
    })
  })
})

// --- Seasons -----------------------------------------------------------------

describe('seasons', () => {
  it('creates a new season that is NOT current', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.type(await screen.findByLabelText('Label'), '2028/29')
    await user.click(screen.getByRole('button', { name: 'Create season' }))
    await waitFor(() => expect(db.seasons).toHaveLength(3))
    expect(db.seasons[2]).toMatchObject({ label: '2028/29', is_current: false })
    expect(db.seasons.filter((s) => s.is_current)).toHaveLength(1)
  })

  it('switches through the atomic database function, not two client writes', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(await screen.findByTestId('make-current-sb'))
    await waitFor(() => expect(db.seasons.find((s) => s.id === 'sb')?.is_current).toBe(true))

    // Exactly one RPC, and no direct UPDATE on seasons from the client.
    expect(rpcCalls).toEqual([{ fn: 'set_current_season', args: { p_season_id: 'sb' } }])
    expect(db.seasons.filter((s) => s.is_current)).toHaveLength(1)
    expect(db.seasons.find((s) => s.id === 'sa')?.is_current).toBe(false)
  })
})

// --- Export ------------------------------------------------------------------

describe('export', () => {
  beforeEach(() => {
    db.clause_status = [{ id: 'cs1', season_id: 'sa', clause_key: 'B.2.1.2', state: 'compliant' }]
    db.tasks = [
      { id: 't1', season_id: 'sa', title: 'Season A task' },
      { id: 't2', season_id: 'sb', title: 'Season B task' },
    ]
  })

  it('is scoped to one season and carries identifying metadata', async () => {
    const out = await buildSeasonExport('sa')
    expect(out.exportVersion).toBe(1)
    expect(typeof out.exportedAt).toBe('string')
    expect(out.season).toMatchObject({ id: 'sa', label: '2026/27' })
    expect(out.tasks).toHaveLength(1)
    expect((out.tasks[0] as { title: string }).title).toBe('Season A task')
    expect(out.clauseStatus).toHaveLength(1)
    expect(out.counts.tasks).toBe(1)
  })

  it('contains no secrets, tokens or auth data', async () => {
    const json = JSON.stringify(await buildSeasonExport('sa')).toLowerCase()
    for (const forbidden of [
      'service_role', 'anon_key', 'apikey', 'password', 'access_token',
      'refresh_token', 'jwt', 'secret', 'bearer', 'eyj',
    ]) {
      expect(json, `export must not contain "${forbidden}"`).not.toContain(forbidden)
    }
  })

  it('includes the roster so owner ids resolve to names', async () => {
    const out = await buildSeasonExport('sa')
    expect(out.members).toHaveLength(2)
    expect(JSON.stringify(out.members)).toContain('Ada Rider')
  })

  it('does not export the 1,146-row rulebook', async () => {
    const out = await buildSeasonExport('sa')
    expect(out).not.toHaveProperty('clauses')
  })
})
