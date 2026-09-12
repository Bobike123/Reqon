import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake that enforces the SAME rules the database does, so a test can tell the
// difference between "the UI hid the button" and "the write was refused".
// The rules are those of supabase/migrations/20260105000000_privileged_roles.sql;
// the real database is checked by supabase/tests/roles_rls_test.sql.
type Member = { id: string; full_name: string; role: string; status: string }
type RoleRow = { member_id: string; role: string; assigned_by?: string | null }

// Job titles deliberately differ from the privileged roles: a title is a label.
const PRES: Member = { id: 'm1', full_name: 'Ada Rider', role: 'Team lead', status: 'active' }
const CREW: Member = { id: 'm2', full_name: 'Bo Wrench', role: 'Chassis', status: 'active' }
const VP: Member = { id: 'm3', full_name: 'Cy Deputy', role: 'Operations', status: 'active' }
const DEV: Member = { id: 'm4', full_name: 'Di Coder', role: 'Software', status: 'active' }
const TREAS: Member = { id: 'm5', full_name: 'Eve Ledger', role: 'Finance', status: 'active' }

const LAST_PRESIDENT =
  'The club must always have a president. Give the role to someone else first, then remove it here.'

let db: Record<string, Record<string, unknown>[]>
let rpcCalls: { fn: string; args: unknown }[]
// Every role write the fake accepted, in order.
let writes: string[] = []
let caller: Member = PRES

function reset() {
  db = {
    members: [PRES, CREW, VP, DEV, TREAS].map((m) => ({ ...m })),
    member_roles: [
      { member_id: 'm1', role: 'president' },
      { member_id: 'm3', role: 'vicepresident' },
      { member_id: 'm4', role: 'developer' },
      { member_id: 'm5', role: 'treasurer' },
    ],
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
  writes = []
  caller = PRES
}

const rolesOf = (id: string) =>
  (db.member_roles as RoleRow[]).filter((r) => r.member_id === id).map((r) => r.role)
// is_admin() and can_manage_roles(), as the SQL defines them — the developer
// passes both since 20260107000000_developer_full_access.sql.
const isAdmin = (m: Member) =>
  rolesOf(m.id).some((r) => r === 'president' || r === 'vicepresident' || r === 'developer')
const canManageRoles = (m: Member) => rolesOf(m.id).some((r) => r === 'president' || r === 'developer')

function policyAllows(table: string, op: string, filters: Record<string, unknown>): boolean {
  if (table === 'members' && op === 'insert') return isAdmin(caller)
  if (table === 'members' && op === 'update') return filters.id === caller.id || isAdmin(caller)
  if (table === 'members' && op === 'delete') return false
  if (['subteams', 'seasons', 'milestones', 'clauses'].includes(table)) return isAdmin(caller)
  if (table === 'member_roles') return (op === 'insert' || op === 'delete') && canManageRoles(caller)
  return true
}

function makeBuilder(table: string) {
  const ctx: { op: string; payload?: Record<string, unknown>; filters: Record<string, unknown>; single: boolean } = {
    op: 'select', filters: {}, single: false,
  }
  const matches = (r: Record<string, unknown>) =>
    Object.entries(ctx.filters).every(([k, v]) => r[k] === v)
  const run = () => {
    if (ctx.op === 'delete') {
      // As in PostgREST: a delete RLS refuses is not an error. It matches no rows.
      if (!policyAllows(table, 'delete', ctx.filters)) return { data: [], error: null }
      const doomed = db[table].filter(matches)
      // The guard_last_president() trigger.
      const presidents = db[table].filter((r) => table === 'member_roles' && r.role === 'president')
      if (presidents.length > 0 && presidents.every((r) => doomed.includes(r))) {
        return { data: null, error: { message: LAST_PRESIDENT, code: '42501' } }
      }
      db[table] = db[table].filter((r) => !matches(r))
      if (table === 'member_roles') for (const r of doomed) writes.push(`delete member_roles ${r.member_id} ${r.role}`)
      return { data: doomed, error: null }
    }
    if (ctx.op !== 'select' && !policyAllows(table, ctx.op, ctx.filters)) {
      return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } }
    }
    if (table === 'member_roles' && ctx.op === 'insert') {
      // The primary key (member_id, role).
      const { member_id, role } = ctx.payload as RoleRow
      if ((db.member_roles as RoleRow[]).some((r) => r.member_id === member_id && r.role === role)) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint "member_roles_pkey"', code: '23505' } }
      }
      writes.push(`insert member_roles ${member_id} ${role}`)
    }
    if (ctx.op === 'insert' || ctx.op === 'upsert') {
      const row: Record<string, unknown> =
        table === 'member_roles'
          ? { assigned_by: caller.id, ...ctx.payload } // the column default: auth.uid()
          : { id: `${table}-${db[table].length + 1}`, ...ctx.payload }
      const keyField = table === 'handover_notes' ? 'subteam_key' : 'id'
      const i = db[table].findIndex((r) => r[keyField] !== undefined && r[keyField] === row[keyField])
      if (ctx.op === 'upsert' && i >= 0) db[table][i] = { ...db[table][i], ...ctx.payload }
      else db[table].push(row)
      return { data: row, error: null }
    }
    if (ctx.op === 'update') {
      db[table] = db[table].map((r) => (matches(r) ? { ...r, ...ctx.payload } : r))
      return { data: null, error: null }
    }
    const rows = (db[table] ?? []).filter(matches)
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
    // What the app asks to explain a delete that matched nothing.
    if (fn === 'can_manage_roles') return { data: canManageRoles(caller), error: null }
    if (fn === 'can_manage_finances')
      return { data: rolesOf(caller.id).some((r) => r === 'treasurer' || r === 'developer'), error: null }
    rpcCalls.push({ fn, args })
    // The real function refuses anyone but the president or vice-president in SQL.
    if (!isAdmin(caller)) {
      return {
        data: null,
        error: { message: 'Only the president or vice-president may change the current season', code: '42501' },
      }
    }
    // One transaction: clear then set.
    db.seasons = db.seasons.map((s) => ({ ...s, is_current: s.id === args.p_season_id }))
    db.v_current_season = db.seasons.filter((s) => s.is_current)
    return { data: null, error: null }
  },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
// The signed-in person's roles come from member_roles, exactly as AuthProvider
// loads them. usePermissions() reads this same mocked context.
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: caller.id }, member: caller, roles: rolesOf(caller.id) }),
}))

const { default: Settings } = await import('./Settings.tsx')
const { buildSeasonExport } = await import('../data/exportSeason.ts')
const { useAddMember, useAssignRole, useRemoveRole, useSetCurrentSeason } = await import(
  '../data/useSettings.ts'
)

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Settings /></MemoryRouter>
    </QueryClientProvider>,
  )
}

// Call a data hook directly — what someone bypassing the UI would do.
function hook<T>(use: () => T) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return renderHook(use, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  }).result
}

beforeEach(reset)

// --- Who sees what -----------------------------------------------------------

const changeRolesButtons = () => screen.queryAllByRole('button', { name: /^Change roles for/ })

describe('who sees what', () => {
  it('the president sees every admin control, and a role button for each member', async () => {
    renderSettings()
    expect(await screen.findByText('Add someone to the roster')).toBeInTheDocument()
    expect(screen.getByText('Subsystems')).toBeInTheDocument()
    expect(screen.getByText('Milestone dates and points')).toBeInTheDocument()
    expect(screen.getByText('Start a new season')).toBeInTheDocument()
    // The roster rows arrive with the members query, after the forms.
    expect(await screen.findByRole('button', { name: 'Change roles for Bo Wrench' })).toBeInTheDocument()
    expect(changeRolesButtons()).toHaveLength(db.members.length)
    expect(screen.getByText(/including who holds which role/)).toBeInTheDocument()
  })

  it('the vice-president sees the same admin controls and every role, but no way to change roles', async () => {
    caller = VP
    renderSettings()
    expect(await screen.findByText('Add someone to the roster')).toBeInTheDocument()
    expect(screen.getByText('Subsystems')).toBeInTheDocument()
    expect(screen.getByText('Milestone dates and points')).toBeInTheDocument()
    expect(screen.getByText('Start a new season')).toBeInTheDocument()
    // Wait for the roster rows, or the absence checks below prove nothing.
    await screen.findByTestId('member-m2')
    expect(changeRolesButtons()).toHaveLength(0)
    expect(await within(screen.getByTestId('member-m1')).findByText('President')).toBeInTheDocument()
    expect(
      screen.getByText(/except roles, which only the President or a Developer can give or take away/),
    ).toBeInTheDocument()
    expect(screen.getByText(/Roles are given and taken away by the President/)).toBeInTheDocument()
  })

  for (const [label, who, shown] of [
    ['team member', CREW, 'Member (no privileged role)'],
    ['treasurer', TREAS, 'Treasurer'],
  ] as const) {
    it(`a ${label} sees no admin or role controls, and is told why in words`, async () => {
      caller = who
      renderSettings()
      expect(await screen.findByText(/reserved for the President and Vice President/)).toBeInTheDocument()
      expect(screen.getByText(shown, { selector: 'strong' })).toBeInTheDocument()
      await screen.findByTestId('member-m2')
      expect(screen.queryByText('Add someone to the roster')).not.toBeInTheDocument()
      expect(screen.queryByText('Subsystems')).not.toBeInTheDocument()
      expect(screen.queryByText('Start a new season')).not.toBeInTheDocument()
      expect(screen.queryByTestId('make-current-sb')).not.toBeInTheDocument()
      expect(changeRolesButtons()).toHaveLength(0)
      // Handover notes stay open to everyone.
      expect(screen.getByText('Handover notes')).toBeInTheDocument()
    })
  }

  it('the developer has full access: every admin control, and role buttons too', async () => {
    caller = DEV
    renderSettings()
    expect(await screen.findByText('Add someone to the roster')).toBeInTheDocument()
    expect(screen.getByText('Subsystems')).toBeInTheDocument()
    expect(screen.getByText('Milestone dates and points')).toBeInTheDocument()
    expect(screen.getByText('Start a new season')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Change roles for Bo Wrench' })).toBeInTheDocument()
    expect(changeRolesButtons()).toHaveLength(db.members.length)
    expect(screen.getByText(/including who holds which role/)).toBeInTheDocument()
  })

  it('a job title of "President" grants nothing', async () => {
    caller = { ...CREW, role: 'President' }
    db.members[1].role = 'President'
    renderSettings()
    expect(await screen.findByText(/reserved for the President/)).toBeInTheDocument()
    expect(screen.queryByText('Add someone to the roster')).not.toBeInTheDocument()
  })

  it('everyone can see who holds which role, by name', async () => {
    caller = CREW
    renderSettings()
    expect(await within(await screen.findByTestId('member-m1')).findByText('President')).toBeInTheDocument()
    expect(within(screen.getByTestId('member-m3')).getByText('Vice President')).toBeInTheDocument()
    expect(within(screen.getByTestId('member-m4')).getByText('Developer')).toBeInTheDocument()
    expect(within(screen.getByTestId('member-m5')).getByText('Treasurer')).toBeInTheDocument()
    expect(within(screen.getByTestId('member-m2')).queryByText(/President|Treasurer|Developer/)).toBeNull()
  })
})

// --- Role management ---------------------------------------------------------

async function openRoles(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Change roles for ${name}` }))
  return within(await screen.findByRole('dialog', { name: new RegExp(`^Roles for ${name}`) }))
}

describe('role management', () => {
  it('a harmless change saves straight away and shows up in the roster', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    expect(dialog.getByText('Member (no privileged role)')).toBeInTheDocument()
    await user.click(dialog.getByRole('checkbox', { name: 'Vice President' }))
    await user.click(dialog.getByRole('button', { name: 'Save roles' }))

    expect(await screen.findByText('Roles updated for Bo Wrench.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save roles' })).not.toBeInTheDocument()
    expect(db.member_roles).toContainEqual({ member_id: 'm2', role: 'vicepresident', assigned_by: 'm1' })
    expect(await within(screen.getByTestId('member-m2')).findByText('Vice President')).toBeInTheDocument()
  })

  it('granting Developer asks first, because it is full access', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    await user.click(dialog.getByRole('checkbox', { name: 'Developer' }))
    await user.click(dialog.getByRole('button', { name: 'Review change' }))
    expect(dialog.getByText(/Bo Wrench becomes Developer and can do everything in the club/)).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.click(dialog.getByRole('button', { name: 'Confirm change' }))
    await waitFor(() => expect(rolesOf('m2')).toEqual(['developer']))
  })

  it('making someone President asks first, says what it means, and writes nothing until confirmed', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    await user.click(dialog.getByRole('checkbox', { name: 'President' }))
    await user.click(dialog.getByRole('button', { name: 'Review change' }))

    expect(dialog.getByRole('heading', { name: 'Check before you confirm' })).toHaveFocus()
    expect(dialog.getByText(/Bo Wrench becomes President.*including yours/)).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.click(dialog.getByRole('button', { name: 'Confirm change' }))
    await waitFor(() => expect(rolesOf('m2')).toEqual(['president']))
    // Not a hand-over unless asked for.
    expect(rolesOf('m1')).toEqual(['president'])
  })

  it('Back and Cancel leave everything as it was', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    await user.click(dialog.getByRole('checkbox', { name: 'President' }))
    await user.click(dialog.getByRole('button', { name: 'Review change' }))
    await user.click(dialog.getByRole('button', { name: 'Back' }))
    expect(dialog.getByRole('checkbox', { name: 'President' })).toBeChecked()
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Review change' })).not.toBeInTheDocument()
    expect(writes).toEqual([])
    // Focus goes back to the button that opened the dialog.
    expect(screen.getByRole('button', { name: 'Change roles for Bo Wrench' })).toHaveFocus()
  })

  it('replacing the Treasurer gives the role first, then takes it from the old one', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    await user.click(dialog.getByRole('checkbox', { name: 'Treasurer' }))
    expect(dialog.getByText('Eve Ledger is Treasurer now.')).toBeInTheDocument()
    expect(dialog.getByRole('radio', { name: /^Replace/ })).toBeChecked()
    await user.click(dialog.getByRole('button', { name: 'Review change' }))
    expect(dialog.getByText(/Eve Ledger is no longer Treasurer/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Confirm change' }))

    await waitFor(() => expect(rolesOf('m5')).toEqual([]))
    expect(rolesOf('m2')).toEqual(['treasurer'])
    expect(writes).toEqual(['insert member_roles m2 treasurer', 'delete member_roles m5 treasurer'])
  })

  it('keeping both Treasurers takes the role from nobody', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    await user.click(dialog.getByRole('checkbox', { name: 'Treasurer' }))
    await user.click(dialog.getByRole('radio', { name: /^Keep both/ }))
    await user.click(dialog.getByRole('button', { name: 'Review change' }))
    await user.click(dialog.getByRole('button', { name: 'Confirm change' }))
    await waitFor(() => expect(rolesOf('m2')).toEqual(['treasurer']))
    expect(rolesOf('m5')).toEqual(['treasurer'])
  })

  it('the only President cannot remove their own presidency, and the database is never asked', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Ada Rider')
    expect(dialog.getByRole('heading', { name: 'Roles for Ada Rider (you)' })).toBeInTheDocument()
    await user.click(dialog.getByRole('checkbox', { name: 'President' }))
    expect(dialog.getByRole('alert')).toHaveTextContent('You are the only President')
    expect(dialog.getByRole('button', { name: 'Review change' })).toBeDisabled()
    expect(writes).toEqual([])
  })

  it('handing over adds the new President before the old one steps down, and the old one loses the controls', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    await user.click(dialog.getByRole('checkbox', { name: 'President' }))
    await user.click(dialog.getByRole('checkbox', { name: /Hand over/ }))
    await user.click(dialog.getByRole('button', { name: 'Review change' }))
    expect(dialog.getByText(/You stop being President/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Confirm change' }))

    await waitFor(() => expect(rolesOf('m1')).toEqual([]))
    expect(rolesOf('m2')).toEqual(['president'])
    expect(writes).toEqual(['insert member_roles m2 president', 'delete member_roles m1 president'])
    // Ada is no longer President, so the role buttons go away without a reload.
    await waitFor(() => expect(changeRolesButtons()).toHaveLength(0))
  })

  it('a refusal is shown as a permission error, and the dialog keeps what was chosen', async () => {
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    // Meanwhile, on another device, the presidency moves to Cy.
    db.member_roles = [
      ...(db.member_roles as RoleRow[]).filter((r) => r.member_id !== 'm1'),
      { member_id: 'm3', role: 'president' },
    ]
    await user.click(dialog.getByRole('checkbox', { name: 'Developer' }))
    await user.click(dialog.getByRole('button', { name: 'Review change' }))
    await user.click(dialog.getByRole('button', { name: 'Confirm change' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(
      "Not permitted: You don't have permission to give the Developer role. Nothing was changed.",
    )
    expect(rolesOf('m2')).toEqual([])
    expect(dialog.getByRole('checkbox', { name: 'Developer' })).toBeChecked()
  })

  it('a stale screen that re-adds a role someone already holds is not an error', async () => {
    const assign = hook(() => useAssignRole())
    await expect(assign.current.mutateAsync({ memberId: 'm3', role: 'vicepresident' })).resolves.toBeUndefined()
    expect(rolesOf('m3')).toEqual(['vicepresident'])
  })

  it('the DATABASE refuses a vice-president who bypasses the UI to assign a role', async () => {
    caller = VP
    const assign = hook(() => useAssignRole())
    await expect(
      assign.current.mutateAsync({ memberId: 'm3', role: 'president' }),
    ).rejects.toThrow(/don't have permission to give the President role/)
    expect(rolesOf('m3')).toEqual(['vicepresident'])
  })

  it('the DATABASE lets a developer assign a role, exactly like the president', async () => {
    caller = DEV
    const assign = hook(() => useAssignRole())
    await expect(assign.current.mutateAsync({ memberId: 'm2', role: 'treasurer' })).resolves.toBeUndefined()
    expect(rolesOf('m2')).toEqual(['treasurer'])
  })

  for (const [label, who] of [['treasurer', TREAS], ['team member', CREW]] as const) {
    it(`the DATABASE refuses a ${label} who makes themselves president`, async () => {
      caller = who
      const assign = hook(() => useAssignRole())
      await expect(
        assign.current.mutateAsync({ memberId: who.id, role: 'president' }),
      ).rejects.toThrow(/don't have permission/)
      expect(rolesOf(who.id)).not.toContain('president')
    })
  }

  it('a removal the database silently refuses is reported, not treated as done', async () => {
    caller = VP
    const remove = hook(() => useRemoveRole())
    // RLS makes this delete match nothing, with no error — the hook must notice.
    await expect(
      remove.current.mutateAsync({ memberId: 'm1', role: 'president' }),
    ).rejects.toThrow(/don't have permission to take away the President role/)
    expect(rolesOf('m1')).toEqual(['president'])
  })

  it('the database guard on the last President is shown in its own words', async () => {
    const remove = hook(() => useRemoveRole())
    await expect(
      remove.current.mutateAsync({ memberId: 'm1', role: 'president' }),
    ).rejects.toThrow(/must always have a president/)
    expect(rolesOf('m1')).toEqual(['president'])
  })
})

// --- Database backstops for administration -----------------------------------

describe('administration is enforced by the database', () => {
  it('refuses a roster write from a non-admin even if the UI is bypassed', async () => {
    caller = CREW
    const before = db.members.length
    const add = hook(() => useAddMember())
    await expect(
      add.current.mutateAsync({ id: 'x', fullName: 'Sneaky', role: 'r' }),
    ).rejects.toThrow(/don't have permission to add people to the roster/)
    expect(db.members).toHaveLength(before)
  })

  it('allows the season switch for a developer', async () => {
    caller = DEV
    const setCurrent = hook(() => useSetCurrentSeason())
    await expect(setCurrent.current.mutateAsync('sb')).resolves.toBeUndefined()
    expect(db.seasons.find((s) => s.id === 'sb')?.is_current).toBe(true)
  })

  for (const [label, who] of [['team member', CREW], ['treasurer', TREAS]] as const) {
    it(`refuses the season switch for a ${label}`, async () => {
      caller = who
      const setCurrent = hook(() => useSetCurrentSeason())
      await expect(setCurrent.current.mutateAsync('sb')).rejects.toThrow(/president or vice-president/)
      expect(db.seasons.find((s) => s.id === 'sa')?.is_current).toBe(true)
    })
  }
})

// --- Roster ------------------------------------------------------------------

describe('roster', () => {
  it('retires a member to alumni instead of deleting them', async () => {
    const user = userEvent.setup()
    const before = db.members.length
    renderSettings()
    const row = await screen.findByTestId('member-m2')
    await user.selectOptions(within(row).getByLabelText('Status for Bo Wrench'), 'alumni')
    await waitFor(() => expect(db.members.find((m) => m.id === 'm2')?.status).toBe('alumni'))
    // Still present — historical owner references keep resolving.
    expect(db.members).toHaveLength(before)
    expect(db.members.find((m) => m.id === 'm2')?.full_name).toBe('Bo Wrench')
  })

  it('has no delete path at all', async () => {
    renderSettings()
    await screen.findByTestId('member-m2')
    expect(screen.queryByRole('button', { name: /delete|remove/i })).not.toBeInTheDocument()
    expect(policyAllows('members', 'delete', {})).toBe(false)
  })

  it('links a member by pasting the Auth UUID — it never creates the login', async () => {
    const user = userEvent.setup()
    const before = db.members.length
    renderSettings()
    await screen.findByText('Add someone to the roster')
    // The safe two-step process is spelled out on screen.
    expect(screen.getByText(/Authentication → Users → Add user/)).toBeInTheDocument()
    expect(screen.getByText(/service_role key in your browser/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Auth user UUID'), 'uuid-123')
    await user.type(screen.getByLabelText('Full name'), 'Cam Newbie')
    await user.click(screen.getByRole('button', { name: 'Link to roster' }))
    await waitFor(() => expect(db.members).toHaveLength(before + 1))
    expect(db.members.find((m) => m.id === 'uuid-123')).toMatchObject({ full_name: 'Cam Newbie' })
    // Linking someone gives them no privileged role.
    expect(rolesOf('uuid-123')).toEqual([])
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
    expect(out.members).toHaveLength(db.members.length)
    expect(JSON.stringify(out.members)).toContain('Ada Rider')
  })

  it('does not export the 1,146-row rulebook', async () => {
    const out = await buildSeasonExport('sa')
    expect(out).not.toHaveProperty('clauses')
  })
})
