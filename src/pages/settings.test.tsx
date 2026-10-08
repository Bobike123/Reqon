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
// Every call to an Edge Function, in order (create-member).
let functionCalls: { name: string; body: Record<string, unknown> }[] = []
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
    subteams: [
      {
        key: 'GEOM', name: 'Design Envelope', description: null, lead_id: null, is_parked: false,
        sort_order: 0, archived_at: null, archived_by: null, archive_reason: null,
      },
      {
        key: 'RACEOP', name: 'Race Operations', description: null, lead_id: null, is_parked: true,
        sort_order: 1, archived_at: null, archived_by: null, archive_reason: null,
      },
    ],
    seasons: [
      { id: 'sa', label: '2026/27', edition: null, regs_ref: 'ED1', is_current: true },
      { id: 'sb', label: '2027/28', edition: null, regs_ref: 'ED2', is_current: false },
    ],
    v_current_season: [],
    milestones: [{ key: 'MS1-1', season_id: 'sa', ordinal: 1, name: 'Team Plan', opens_on: '2026-11-01', due_on: '2026-11-30', max_points: 75, is_blocking: false, aim: null, article_ref: null, notes: null }],
    handover_notes: [],
    tasks: [], proposals: [], clause_status: [], clauses: [],
    // Reference data: any member reads, only administrators write (is_admin()).
    regulation_documents: [],
  }
  db.v_current_season = db.seasons.filter((s) => s.is_current)
  rpcCalls = []
  functionCalls = []
  emails.clear()
  writes = []
  caller = PRES
}

const rolesOf = (id: string) =>
  (db.member_roles as RoleRow[]).filter((r) => r.member_id === id).map((r) => r.role)
// is_admin() and can_manage_roles(), as the SQL defines them — the developer
// passes both since 20260107000000_developer_full_access.sql.
const isAdmin = (m: Member) =>
  rolesOf(m.id).some((r) => r === 'president' || r === 'vicepresident' || r === 'developer')
// can_manage_roles() / can_grant_role() / can_manage_seasons() as redefined by
// backend completion Phase 2 (20260126000100): the VP opens role management but
// only changes Treasurer and Documentation; only a Developer changes Developer;
// seasons belong to the President and a Developer.
const canManageRoles = (m: Member) =>
  rolesOf(m.id).some((r) => r === 'president' || r === 'vicepresident' || r === 'developer')
const canGrant = (m: Member, role: string) => {
  const has = (r: string) => rolesOf(m.id).includes(r)
  if (role === 'developer') return has('developer')
  if (role === 'president' || role === 'vicepresident') return has('president') || has('developer')
  return has('president') || has('vicepresident') || has('developer')
}
const canManageSeasons = (m: Member) => rolesOf(m.id).some((r) => r === 'president' || r === 'developer')

function policyAllows(table: string, op: string, filters: Record<string, unknown>): boolean {
  if (table === 'members' && op === 'insert') return isAdmin(caller)
  if (table === 'members' && op === 'update') return filters.id === caller.id || isAdmin(caller)
  if (table === 'members' && op === 'delete') return false
  if (table === 'seasons') return canManageSeasons(caller)
  if (['subteams', 'milestones', 'clauses', 'regulation_documents'].includes(table)) return isAdmin(caller)
  if (table === 'member_roles') return (op === 'insert' || op === 'delete') && canGrant(caller, String(filters.role))
  return true
}

function makeBuilder(table: string) {
  const ctx: {
    op: string
    payload?: Record<string, unknown>
    filters: Record<string, unknown>
    single: boolean
    selected: boolean
    count?: string
    head?: boolean
    range?: [number, number]
  } = { op: 'select', filters: {}, single: false, selected: false }
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
    if (ctx.op !== 'select' && ctx.op !== 'update' && !policyAllows(table, ctx.op, { ...ctx.filters, ...(ctx.payload ?? {}) })) {
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
          : table === 'regulation_documents'
            ? { ...ctx.payload } // keyed by regs_ref, no surrogate id
            : { id: `${table}-${db[table].length + 1}`, ...ctx.payload }
      const keyField = table === 'handover_notes' ? 'subteam_key' : table === 'regulation_documents' ? 'regs_ref' : 'id'
      const i = db[table].findIndex((r) => r[keyField] !== undefined && r[keyField] === row[keyField])
      if (ctx.op === 'upsert' && i >= 0) db[table][i] = { ...db[table][i], ...ctx.payload }
      else db[table].push(row)
      return { data: row, error: null }
    }
    if (ctx.op === 'update') {
      // As in real Postgres RLS: a policy's USING clause filters which rows
      // are visible to UPDATE, so a refused update touches no rows — it does
      // NOT raise an error (that only happens for WITH CHECK, i.e. INSERT).
      if (!policyAllows(table, 'update', ctx.filters)) return { data: ctx.selected ? [] : null, error: null }
      const hit = db[table].filter(matches)
      db[table] = db[table].map((r) => (matches(r) ? { ...r, ...ctx.payload } : r))
      // As in PostgREST: an UPDATE returns no data unless .select() is
      // chained, in which case it returns the rows it actually touched — the
      // shape useUpdateMember/useUpdateSubteam/useUpdateMilestone need to
      // tell "nothing matched" apart from "matched, and RLS didn't error".
      return { data: ctx.selected ? hit : null, error: null }
    }
    let rows = (db[table] ?? []).filter(matches)
    // `{ count: 'exact', head: true }`: mirrors PostgREST's own count contract
    // (export's independent-count check, Phase 4 §4.4) — head:true returns no
    // data body, only the count. Count reflects the FULL filtered set, taken
    // before range() narrows to one page, exactly like PostgREST's own
    // Content-Range count.
    if (ctx.count) return { data: ctx.head ? null : rows, count: rows.length, error: null }
    if (ctx.range) rows = rows.slice(ctx.range[0], ctx.range[1] + 1)
    return { data: ctx.single ? (rows[0] ?? null) : rows, error: null }
  }
  const b: Record<string, unknown> = {
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      ctx.selected = true
      ctx.count = opts?.count
      ctx.head = opts?.head
      return b
    },
    order: () => b, in: () => b,
    range: (from: number, to: number) => { ctx.range = [from, to]; return b },
    limit: () => b,
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

// Mirrors apply_role_plan() (20260111000000, redefined 20260126000100): one call,
// can_manage_roles() for the plan and can_grant_role() for every row, applied in order, ALL
// or NOTHING — a last-president removal partway through discards every
// change this SAME call made, not just that one step.
function applyRolePlan(args: Record<string, unknown>) {
  if (!canManageRoles(caller)) {
    return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } }
  }
  const changes = args.p_changes as { member_id: string; role: string; action: 'add' | 'remove' }[]
  const before = (db.member_roles as RoleRow[]).map((r) => ({ ...r }))
  const beforeWrites = writes.length
  for (const change of changes) {
    if (!canGrant(caller, change.role)) {
      db.member_roles = before
      writes.length = beforeWrites
      return { data: null, error: { message: `You may not grant or remove the ${change.role} role.`, code: '42501' } }
    }
    if (change.action === 'add') {
      const already = (db.member_roles as RoleRow[]).some(
        (r) => r.member_id === change.member_id && r.role === change.role,
      )
      if (!already) {
        db.member_roles.push({ member_id: change.member_id, role: change.role, assigned_by: caller.id })
        writes.push(`insert member_roles ${change.member_id} ${change.role}`)
      }
    } else {
      const doomed = (db.member_roles as RoleRow[]).filter(
        (r) => r.member_id === change.member_id && r.role === change.role,
      )
      const presidents = (db.member_roles as RoleRow[]).filter((r) => r.role === 'president')
      if (doomed.length > 0 && presidents.length > 0 && presidents.every((r) => doomed.includes(r))) {
        // trg_guard_last_president: undo every write THIS call made, matching
        // "one transaction" — the same reason settings.test.tsx's own writes
        // assertions never see a partial plan.
        db.member_roles = before
        writes.length = beforeWrites
        return { data: null, error: { message: LAST_PRESIDENT, code: '42501' } }
      }
      if (doomed.length > 0) {
        db.member_roles = (db.member_roles as RoleRow[]).filter(
          (r) => !(r.member_id === change.member_id && r.role === change.role),
        )
        writes.push(`delete member_roles ${change.member_id} ${change.role}`)
      }
    }
  }
  return { data: null, error: null }
}

const supabase = {
  from: (t: string) => makeBuilder(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    // What the app asks to explain a delete that matched nothing.
    if (fn === 'can_manage_roles') return { data: canManageRoles(caller), error: null }
    if (fn === 'can_manage_finances')
      return { data: rolesOf(caller.id).some((r) => r === 'treasurer' || r === 'developer'), error: null }
    if (fn === 'apply_role_plan') return applyRolePlan(args)
    // useUpdateMember/useUpdateSubteam/useUpdateMilestone ask this to tell a
    // refused UPDATE apart from one that simply matched no (renamed/deleted) row.
    if (fn === 'is_admin') return { data: isAdmin(caller), error: null }
    // can_manage_departments() (20260115000000): same membership as is_admin()
    // today, kept as its own RPC per ADR-0001 so department authority does not
    // silently follow future, unrelated changes to is_admin().
    if (fn === 'can_manage_departments') return { data: isAdmin(caller), error: null }
    if (fn === 'start_season') {
      // The real command is President/Developer only (can_manage_seasons) and creates the season NOT current.
      if (!canManageSeasons(caller)) return { data: null, error: { message: 'Only the President or a Developer can start a season.', code: '42501' } }
      const row = { id: `s${db.seasons.length + 1}`, label: args.p_label, edition: args.p_edition ?? 'MotoStudent IX', is_current: false }
      db.seasons.push(row)
      rpcCalls.push({ fn, args })
      return { data: row, error: null }
    }
    rpcCalls.push({ fn, args })
    // Everything else here is set_current_season, which the real function
    // refuses to anyone but the President or a Developer (can_manage_seasons()).
    if (!canManageSeasons(caller)) {
      return {
        data: null,
        error: { message: 'Only the President or a Developer may change the current season', code: '42501' },
      }
    }
    // One transaction: clear then set.
    db.seasons = db.seasons.map((s) => ({ ...s, is_current: s.id === args.p_season_id }))
    db.v_current_season = db.seasons.filter((s) => s.is_current)
    return { data: null, error: null }
  },
}
// supabase/functions/create-member: asks can_add_members() as the caller, then
// creates the login and inserts the roster row as the caller. A refusal comes
// back the way supabase-js reports a non-2xx answer: an error whose `context`
// is the Response.
function functionError(status: number, message: string) {
  return {
    data: null,
    error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: new Response(JSON.stringify({ error: message }), { status }),
    }),
  }
}
const emails = new Set<string>()
;(supabase as Record<string, unknown>).functions = {
  invoke: async (name: string, { body }: { body: Record<string, unknown> }) => {
    functionCalls.push({ name, body })
    if (name !== 'create-member') return functionError(404, 'No such function.')
    if (!isAdmin(caller)) return functionError(403, 'Only an active President, Vice President or Developer may add people to the roster. Nothing was changed.')
    const email = String(body.email).toLowerCase()
    if (emails.has(email)) return functionError(409, `A login already exists for ${email}. If they are not on the roster yet, link it by UUID instead.`)
    emails.add(email)
    const id = `login-${emails.size}`
    db.members.push({ id, full_name: body.fullName, role: body.jobTitle, status: 'active' })
    return { data: { id }, error: null }
  },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
// Settings.tsx wires this for live department/Head updates (Phase 1). Real
// channel behaviour is exercised elsewhere (data/realtimeEntities.test.tsx);
// this suite only needs it to not crash on mount.
vi.mock('../data/useRealtimeSubteams.ts', () => ({ useRealtimeSubteams: () => 'off' }))
// The signed-in person's roles come from member_roles, exactly as AuthProvider
// loads them. usePermissions() reads this same mocked context.
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: caller.id }, member: caller, roles: rolesOf(caller.id) }),
}))

const { default: Settings } = await import('./Settings.tsx')
const { buildSeasonExport } = await import('../data/exportSeason.ts')
const { useAddMember, useCreateMember, useUpdateMember } = await import('../data/useMembers.ts')
const { useUpdateSubteam } = await import('../data/useSubteams.ts')
const { useUpdateMilestone } = await import('../data/useMilestones.ts')
const { useSetCurrentSeason } = await import('../data/useSeasons.ts')
const { useApplyRoleChanges } = await import('../roles/useMemberRoles.ts')
const { SeasonProvider } = await import('../season/SeasonProvider.tsx')

function renderSettings(url = '/settings') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SeasonProvider>
        <MemoryRouter initialEntries={[url]}><Settings /></MemoryRouter>
      </SeasonProvider>
    </QueryClientProvider>,
  )
}

// Call a data hook directly — what someone bypassing the UI would do.
function hook<T>(use: () => T) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return renderHook(use, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <SeasonProvider>{children}</SeasonProvider>
      </QueryClientProvider>
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
    expect(screen.getByText('Departments')).toBeInTheDocument()
    expect(screen.getByText('Milestone dates and points')).toBeInTheDocument()
    expect(screen.getByText('Requirements Book')).toBeInTheDocument()
    expect(screen.getByText('Start a new season')).toBeInTheDocument()
    // The roster rows arrive with the members query, after the forms.
    expect(await screen.findByRole('button', { name: 'Change roles for Bo Wrench' })).toBeInTheDocument()
    expect(changeRolesButtons()).toHaveLength(db.members.length)
    expect(screen.getByText(/including the roles available to you/)).toBeInTheDocument()
  })

  // Backend completion Phase 2: the Vice President now manages the Treasurer and
  // Documentation roles, and no longer starts or switches seasons (F-03, F-04).
  it('the vice-president sees the admin controls and role management, but no season controls', async () => {
    caller = VP
    renderSettings()
    expect(await screen.findByText('Add someone to the roster')).toBeInTheDocument()
    expect(screen.getByText('Departments')).toBeInTheDocument()
    expect(screen.getByText('Milestone dates and points')).toBeInTheDocument()
    expect(screen.queryByText('Start a new season')).not.toBeInTheDocument()
    await screen.findByTestId('member-m2')
    expect(changeRolesButtons().length).toBeGreaterThan(0)
    expect(await within(screen.getByTestId('member-m1')).findByText('President')).toBeInTheDocument()
    expect(
      screen.getByText(/except seasons and the President and Vice President roles/),
    ).toBeInTheDocument()
    expect(screen.getByText(/You can give or take away the Treasurer and Documentation roles/)).toBeInTheDocument()
  })

  it('the vice-president may tick only Treasurer and Documentation', async () => {
    caller = VP
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    expect(dialog.getByRole('checkbox', { name: 'Treasurer' })).toBeEnabled()
    expect(dialog.getByRole('checkbox', { name: 'Documentation' })).toBeEnabled()
    expect(dialog.getByRole('checkbox', { name: 'President' })).toBeDisabled()
    expect(dialog.getByRole('checkbox', { name: 'Vice President' })).toBeDisabled()
    expect(dialog.getByRole('checkbox', { name: 'Developer' })).toBeDisabled()
  })

  for (const [label, who, shown] of [
    ['team member', CREW, 'Member (no privileged role)'],
    ['treasurer', TREAS, 'Treasurer'],
  ] as const) {
    it(`a ${label} sees no admin or role controls, and is told why in words`, async () => {
      caller = who
      renderSettings()
      expect(
        await screen.findByText(/reserved for the President and Vice President/),
      ).toBeInTheDocument()
      expect(screen.getByText(shown, { selector: 'strong' })).toBeInTheDocument()
      await screen.findByTestId('member-m2')
      expect(screen.queryByText('Add someone to the roster')).not.toBeInTheDocument()
      expect(screen.queryByText('Departments')).not.toBeInTheDocument()
      expect(screen.queryByText('Requirements Book')).not.toBeInTheDocument()
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
    expect(screen.getByText('Departments')).toBeInTheDocument()
    expect(screen.getByText('Milestone dates and points')).toBeInTheDocument()
    expect(screen.getByText('Start a new season')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Change roles for Bo Wrench' })).toBeInTheDocument()
    expect(changeRolesButtons()).toHaveLength(db.members.length)
    expect(screen.getByText(/including the roles available to you/)).toBeInTheDocument()
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

  // Only a Developer may grant Developer since backend completion Phase 2.
  it('granting Developer asks first, because it is full access', async () => {
    caller = DEV
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
    // A Developer (the only one who may grant Developer) loses the role on
    // another device while the dialog is open.
    caller = DEV
    const user = userEvent.setup()
    renderSettings()
    const dialog = await openRoles(user, 'Bo Wrench')
    db.member_roles = (db.member_roles as RoleRow[]).filter((r) => r.member_id !== 'm4')
    await user.click(dialog.getByRole('checkbox', { name: 'Developer' }))
    await user.click(dialog.getByRole('button', { name: 'Review change' }))
    await user.click(dialog.getByRole('button', { name: 'Confirm change' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(
      "Not permitted: You don't have permission to change privileged roles. Nothing was changed.",
    )
    expect(rolesOf('m2')).toEqual([])
    expect(dialog.getByRole('checkbox', { name: 'Developer' })).toBeChecked()
  })

  // Every role change goes through apply_role_plan() (useApplyRoleChanges).
  // These call that supported path directly, as a caller bypassing the dialog
  // would; the direct member_roles INSERT/DELETE rules themselves are proven
  // against real Postgres in supabase/tests/roles_rls_test.sql.

  it('a stale screen that re-adds a role someone already holds is not an error', async () => {
    const apply = hook(() => useApplyRoleChanges())
    await expect(
      apply.current.mutateAsync([{ memberId: 'm3', memberName: 'Someone', role: 'vicepresident', action: 'add' }]),
    ).resolves.toBeUndefined()
    expect(rolesOf('m3')).toEqual(['vicepresident'])
  })

  it('the DATABASE refuses a vice-president who bypasses the UI to assign a role', async () => {
    caller = VP
    const apply = hook(() => useApplyRoleChanges())
    await expect(
      apply.current.mutateAsync([{ memberId: 'm3', memberName: 'Someone', role: 'president', action: 'add' }]),
    ).rejects.toThrow(/may not grant or remove the president role/)
    expect(rolesOf('m3')).toEqual(['vicepresident'])
  })

  it('the DATABASE lets a developer assign a role, exactly like the president', async () => {
    caller = DEV
    const apply = hook(() => useApplyRoleChanges())
    await expect(
      apply.current.mutateAsync([{ memberId: 'm2', memberName: 'Someone', role: 'treasurer', action: 'add' }]),
    ).resolves.toBeUndefined()
    expect(rolesOf('m2')).toEqual(['treasurer'])
  })

  for (const [label, who] of [['treasurer', TREAS], ['team member', CREW]] as const) {
    it(`the DATABASE refuses a ${label} who makes themselves president`, async () => {
      caller = who
      const apply = hook(() => useApplyRoleChanges())
      await expect(
        apply.current.mutateAsync([{ memberId: who.id, memberName: 'Someone', role: 'president', action: 'add' }]),
      ).rejects.toThrow(/don't have permission/)
      expect(rolesOf(who.id)).not.toContain('president')
    })
  }

  it('a removal the database refuses is reported, not treated as done', async () => {
    caller = VP
    const apply = hook(() => useApplyRoleChanges())
    await expect(
      apply.current.mutateAsync([{ memberId: 'm1', memberName: 'Someone', role: 'president', action: 'remove' }]),
    ).rejects.toThrow(/may not grant or remove the president role/)
    expect(rolesOf('m1')).toEqual(['president'])
  })

  it('the database guard on the last President is shown in its own words', async () => {
    const apply = hook(() => useApplyRoleChanges())
    await expect(
      apply.current.mutateAsync([{ memberId: 'm1', memberName: 'Someone', role: 'president', action: 'remove' }]),
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
      await expect(setCurrent.current.mutateAsync('sb')).rejects.toThrow(/Only the President or a Developer/)
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

  it('lets the Vice President create a login and roster row in one step, with no privileged role', async () => {
    caller = VP
    const user = userEvent.setup()
    const before = db.members.length
    renderSettings()
    await screen.findByText('Add someone to the roster')

    await user.type(screen.getByLabelText('Full name'), 'Cam Newbie')
    await user.type(screen.getByLabelText('Email they sign in with'), 'Cam@Club.test')
    await user.type(screen.getByLabelText('First password'), 'first-pass-123')
    await user.click(screen.getByRole('button', { name: 'Add to roster' }))

    await waitFor(() => expect(db.members).toHaveLength(before + 1))
    // Only the Edge Function is asked; the browser never writes auth or roles.
    expect(functionCalls).toEqual([
      { name: 'create-member', body: { email: 'Cam@Club.test', password: 'first-pass-123', fullName: 'Cam Newbie', jobTitle: 'Member' } },
    ])
    const added = db.members.find((m) => m.full_name === 'Cam Newbie')!
    expect(rolesOf(String(added.id))).toEqual([])
    expect(writes).toEqual([])
    expect(await screen.findByText(/Cam Newbie is on the roster/)).toBeInTheDocument()
    // The password does not linger in the form after it was used.
    expect(screen.getByLabelText('First password')).toHaveValue('')
  })

  it('lets the President add someone too', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByText('Add someone to the roster')
    await user.type(screen.getByLabelText('Full name'), 'Dee New')
    await user.type(screen.getByLabelText('Email they sign in with'), 'dee@club.test')
    await user.type(screen.getByLabelText('First password'), 'first-pass-123')
    await user.click(screen.getByRole('button', { name: 'Add to roster' }))
    await waitFor(() => expect(db.members.some((m) => m.full_name === 'Dee New')).toBe(true))
  })

  it('shows the server\'s reason when the login already exists, and keeps what was typed', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByText('Add someone to the roster')
    for (const name of ['First Try', 'Second Try']) {
      await user.clear(screen.getByLabelText('Full name'))
      await user.type(screen.getByLabelText('Full name'), name)
      await user.clear(screen.getByLabelText('Email they sign in with'))
      await user.type(screen.getByLabelText('Email they sign in with'), 'same@club.test')
      await user.type(screen.getByLabelText('First password'), 'first-pass-123')
      await user.click(screen.getByRole('button', { name: 'Add to roster' }))
      await waitFor(() => expect(functionCalls.at(-1)?.body.fullName).toBe(name))
    }
    expect(await screen.findByText(/A login already exists for same@club.test/)).toBeInTheDocument()
    expect(screen.getByLabelText('Full name')).toHaveValue('Second Try')
    expect(db.members.filter((m) => m.full_name === 'Second Try')).toHaveLength(0)
  })

  for (const [label, who] of [['treasurer', TREAS], ['team member', CREW]] as const) {
    it(`does not offer adding people to a ${label}`, async () => {
      caller = who
      renderSettings()
      await screen.findByTestId('member-m2')
      expect(screen.queryByText('Add someone to the roster')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('First password')).not.toBeInTheDocument()
    })
  }

  it('refuses the create-member call for a treasurer even if the UI is bypassed', async () => {
    caller = TREAS
    const before = db.members.length
    const create = hook(() => useCreateMember())
    await expect(
      create.current.mutateAsync({ email: 'x@club.test', password: 'first-pass-123', fullName: 'Sneaky', jobTitle: 'Member' }),
    ).rejects.toThrow(/don't have permission to add people to the roster/)
    expect(db.members).toHaveLength(before)
  })

  it('still links an existing login by pasting its Auth UUID', async () => {
    const user = userEvent.setup()
    const before = db.members.length
    renderSettings()
    await screen.findByText('Add someone to the roster')
    await user.click(screen.getByText('Their login already exists? Link it by UUID'))

    await user.type(screen.getByLabelText('Auth user UUID'), 'uuid-123')
    await user.type(screen.getByLabelText('Full name of the linked person'), 'Cam Newbie')
    await user.click(screen.getByRole('button', { name: 'Link to roster' }))
    await waitFor(() => expect(db.members).toHaveLength(before + 1))
    expect(db.members.find((m) => m.id === 'uuid-123')).toMatchObject({ full_name: 'Cam Newbie' })
    // Linking someone gives them no privileged role, and calls no function.
    expect(rolesOf('uuid-123')).toEqual([])
    expect(functionCalls).toEqual([])
  })

  it('offers the job titles the club already uses instead of a blank text box', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('member-m2')
    const select = within(row).getByLabelText('Job title for Bo Wrench')
    // Every title on the roster, deduped and alphabetical, plus the way out.
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Chassis',
      'Finance',
      'Member',
      'Operations',
      'Software',
      'Team lead',
      'Add a new job title…',
    ])

    await user.selectOptions(select, 'Operations')
    await waitFor(() => expect(db.members.find((m) => m.id === 'm2')?.role).toBe('Operations'))
  })

  it('takes a job title nobody holds yet, and then offers it to everyone', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('member-m2')
    await user.selectOptions(
      within(row).getByLabelText('Job title for Bo Wrench'),
      within(row).getByRole('option', { name: 'Add a new job title…' }),
    )
    await user.type(within(row).getByLabelText('New job title for this person'), 'Powertrain')
    await user.click(within(row).getByRole('button', { name: 'Use it' }))

    await waitFor(() => expect(db.members.find((m) => m.id === 'm2')?.role).toBe('Powertrain'))
    // The roster IS the list of titles, so the next person picks it, never
    // retypes it — which is how "Chassis" and "chassis" stopped happening.
    const other = await screen.findByTestId('member-m3')
    await waitFor(() =>
      expect(
        within(within(other).getByLabelText('Job title for Cy Deputy')).queryByRole('option', {
          name: 'Powertrain',
        }),
      ).toBeInTheDocument(),
    )
  })

  it('keeps alumni in their own group instead of mixed among the team', async () => {
    db.members = db.members.map((m) => (m.id === 'm2' ? { ...m, status: 'alumni' } : m))
    renderSettings()
    await screen.findByTestId('member-m2')

    expect(screen.getByRole('heading', { name: /On the team \(4\)/ })).toBeInTheDocument()
    const alumniHeading = screen.getByRole('heading', { name: /Alumni \(1\)/ })
    const group = alumniHeading.parentElement as HTMLElement
    expect(within(group).getByTestId('member-m2')).toBeInTheDocument()
    expect(within(group).queryByTestId('member-m1')).not.toBeInTheDocument()
  })

  it('says which kind of role each thing on a row is', async () => {
    renderSettings()
    const row = await screen.findByTestId('member-m1')
    // "Team lead" (a job title) and "President" (a privileged role) sit on the
    // same line; only one of them grants anything.
    expect(within(row).getByText('Job title:').parentElement).toHaveTextContent('Team lead')
    expect(within(row).getByText('Roles:').parentElement).toHaveTextContent('President')
  })
})

// --- Subteams, milestones, notes ---------------------------------------------

describe('departments', () => {
  it('renames and assigns a Head in one explicit save, without touching the key', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('department-row-GEOM')
    // Read first: no editable box until Edit is chosen.
    expect(within(row).queryByLabelText('Name for GEOM')).not.toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Edit Design Envelope' }))
    const name = within(row).getByLabelText('Name for GEOM')
    expect(name).toHaveFocus()
    await user.clear(name)
    await user.type(name, 'Design Envelope & Geometry')
    await user.tab()
    // Leaving the field saves nothing.
    expect(db.subteams[0].name).toBe('Design Envelope')
    await user.selectOptions(within(row).getByLabelText('Head of Department for GEOM'), 'm2')
    await user.click(within(row).getByRole('button', { name: 'Save department' }))
    await waitFor(() => expect(db.subteams[0].name).toBe('Design Envelope & Geometry'))
    expect(db.subteams[0].lead_id).toBe('m2')
    expect(await within(screen.getByTestId('department-row-GEOM')).findByTestId('department-saved-GEOM')).toHaveTextContent('Saved: name, Head.')
    // The key is the join target for 1,146 clauses — it must not change.
    expect(db.subteams[0].key).toBe('GEOM')
  })

  it('says when there is nothing to save, and Cancel changes nothing', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('department-row-GEOM')
    await user.click(within(row).getByTestId('department-edit-GEOM'))
    await user.click(within(row).getByRole('button', { name: 'Save department' }))
    expect(within(row).getByTestId('department-note-GEOM')).toHaveTextContent('Nothing to save')
    await user.type(within(row).getByLabelText('Name for GEOM'), ' changed')
    await user.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect(db.subteams[0].name).toBe('Design Envelope')
    expect(within(row).queryByLabelText('Name for GEOM')).not.toBeInTheDocument()
  })

  it('parks and unparks a department through the same department command', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('department-row-GEOM')
    await user.click(within(row).getByTestId('department-edit-GEOM'))
    await user.click(within(row).getByRole('checkbox', { name: /Parked/ }))
    await user.click(within(row).getByRole('button', { name: 'Save department' }))
    await waitFor(() => expect(db.subteams[0].is_parked).toBe(true))
    expect(db.subteams[0].archived_at).toBeNull()
    expect(await within(screen.getByTestId('department-row-GEOM')).findByText('Parked')).toBeInTheDocument()
  })

  it('opens the exact editor from a link (?edit=department:KEY), and says so when that department is archived', async () => {
    renderSettings('/settings?edit=department:RACEOP&keep=1')
    const row = await screen.findByTestId('department-row-RACEOP')
    expect(await within(row).findByLabelText('Name for RACEOP')).toHaveFocus()
    expect(within(screen.getByTestId('department-row-GEOM')).queryByLabelText('Name for GEOM')).not.toBeInTheDocument()
  })

  it('says a linked department is archived instead of opening nothing', async () => {
    db.subteams[1] = { ...db.subteams[1], archived_at: '2026-09-01T00:00:00Z', archive_reason: 'merged' }
    renderSettings('/settings?edit=department:RACEOP')
    expect(await screen.findByTestId('department-edit-missing')).toHaveTextContent('RACEOP is archived. Restore it below to edit it.')
  })

  it('keeps job title, access role and department headship apart on the roster', async () => {
    db.subteams[0] = { ...db.subteams[0], lead_id: 'm2' }
    renderSettings()
    const row = await screen.findByTestId('member-m2')
    const headship = await within(row).findByTestId('headship-m2')
    expect(headship).toHaveTextContent('Head of Department: Design Envelope')
    // A contextual Edit link opens that department's own editor.
    expect(within(headship).getByRole('link', { name: 'Edit Design Envelope' })).toHaveAttribute('href', '/settings?edit=department%3AGEOM')
  })

  it('shows Edit on hover and keyboard focus, and always on touch screens', async () => {
    renderSettings()
    const edit = await screen.findByTestId('department-edit-GEOM')
    expect(edit.className).toMatch(/sm:opacity-0/)
    expect(edit.className).toMatch(/sm:group-hover:opacity-100/)
    expect(edit.className).toMatch(/sm:group-focus-within:opacity-100/)
    expect(edit.className).toMatch(/pointer-coarse:opacity-100/)
  })

  it('shows the active count against the 10-department cap', async () => {
    renderSettings()
    expect(await screen.findByText('2 active / 10')).toBeInTheDocument()
  })

  it('shows a Parked badge, independent of archived state', async () => {
    renderSettings()
    const row = await screen.findByTestId('department-row-RACEOP')
    expect(within(row).getByText('Parked')).toBeInTheDocument()
    // GEOM is not parked.
    expect(within(await screen.findByTestId('department-row-GEOM')).queryByText('Parked')).not.toBeInTheDocument()
  })

  it('reorders with the Move up/down controls, keyboard-reachable buttons', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByTestId('department-row-GEOM')
    await user.click(screen.getByRole('button', { name: 'Move Race Operations up' }))
    await waitFor(() => expect(rpcCalls.some((c) => c.fn === 'reorder_departments')).toBe(true))
    const call = rpcCalls.find((c) => c.fn === 'reorder_departments')
    expect((call?.args as { p_ordered_keys: string[] } | undefined)?.p_ordered_keys).toEqual(['RACEOP', 'GEOM'])
  })

  it('describes a department, saved by Save — never on blur', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('department-row-GEOM')
    await user.click(within(row).getByTestId('department-edit-GEOM'))
    const desc = within(row).getByLabelText('Description for GEOM')
    await user.type(desc, 'What this department covers')
    await user.tab()
    expect(db.subteams[0].description).toBeNull()
    await user.click(within(row).getByRole('button', { name: 'Save department' }))
    await waitFor(() => expect(db.subteams[0].description).toBe('What this department covers'))
  })

  it('cancelling the archive confirmation changes nothing', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('department-row-GEOM')
    await user.click(within(row).getByRole('button', { name: 'Archive…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    expect(db.subteams[0].archived_at).toBeNull()
  })

  it('disables creating and restoring once at the 10-active cap', async () => {
    db.subteams = Array.from({ length: 11 }, (_, i) => ({
      key: `D${i}`, name: `Dept ${i}`, description: null, lead_id: null, is_parked: false,
      sort_order: i, archived_at: i === 0 ? new Date().toISOString() : null, archived_by: null,
      archive_reason: i === 0 ? 'already archived' : null,
    }))
    renderSettings()
    expect(await screen.findByText('10 active / 10')).toBeInTheDocument()
    expect(screen.getByLabelText('Key')).toBeDisabled()
    await userEvent.setup().click(screen.getByText('Archived (1)'))
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
  })

  it('creates a new department with no book_section', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByTestId('department-row-GEOM')
    await user.type(screen.getByLabelText('Key'), 'swdata')
    await user.type(screen.getByLabelText('Name'), 'Software & Data')
    await user.click(screen.getByRole('button', { name: 'New department' }))
    await waitFor(() => expect(db.subteams.some((s) => s.key === 'SWDATA')).toBe(true))
    expect(db.subteams.find((s) => s.key === 'SWDATA')?.book_section).toBeNull()
  })

  it('archives a department with a reason, and it can be restored', async () => {
    const user = userEvent.setup()
    renderSettings()
    const row = await screen.findByTestId('department-row-GEOM')
    await user.click(within(row).getByRole('button', { name: 'Archive…' }))
    await user.type(screen.getByLabelText(/Reason/), 'test reason')
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(db.subteams[0].archived_at).not.toBeNull())
    expect(db.subteams[0].archive_reason).toBe('test reason')

    const restoreButton = await screen.findByRole('button', { name: 'Restore' })
    await user.click(restoreButton)
    await waitFor(() => expect(db.subteams[0].archived_at).toBeNull())
  })

  it('a non-admin does not see the Departments section at all', async () => {
    caller = CREW
    renderSettings()
    await screen.findByTestId('member-m2')
    expect(screen.queryByTestId('department-row-GEOM')).not.toBeInTheDocument()
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
  it('saves one note per department into handover_notes', async () => {
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

describe('Requirements Book source', () => {
  const saveButton = () => screen.findByRole('button', { name: /save requirements book source/i })

  it('lets an administrator point the current season\'s edition at an https document', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.type(await screen.findByLabelText(/^link/i), 'https://example.org/regs.pdf')
    await user.click(await saveButton())
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(db.regulation_documents).toEqual([
      expect.objectContaining({ regs_ref: 'ED1', url: 'https://example.org/regs.pdf', storage_path: null }),
    ])
  })

  it('refuses an unsafe link before it reaches the database', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.type(await screen.findByLabelText(/^link/i), 'javascript:alert(1)')
    await user.click(await saveButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(/https/)
    expect(db.regulation_documents).toEqual([])
  })

  it('is refused by the database for anyone who is not an administrator, even bypassing the screen', async () => {
    caller = CREW
    const { useSaveRegulationDocument } = await import('../data/useRegulationDocument.ts')
    const result = hook(() => useSaveRegulationDocument())
    await expect(
      result.current.mutateAsync({
        regsRef: 'ED1', edition: null, title: null, url: 'https://example.org/regs.pdf', storagePath: null, pageOffset: 0, pageCount: null,
      }),
    ).rejects.toMatchObject({ permission: true })
    expect(db.regulation_documents).toEqual([])
  })
})

describe('seasons', () => {
  it('creates a new season that is NOT current', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.type(await screen.findByLabelText('Label'), '2028/29')
    await user.click(screen.getByRole('button', { name: 'Create season' }))
    await waitFor(() => expect(db.seasons).toHaveLength(3))
    expect(db.seasons[2]).toMatchObject({ label: '2028/29', is_current: false })
    expect(db.seasons.filter((s) => s.is_current)).toHaveLength(1)
    // Through the command, never a direct INSERT; the structure is copied from the current season by default.
    expect(rpcCalls[0]).toMatchObject({ fn: 'start_season', args: { p_label: '2028/29', p_copy_from: 'sa' } })
  })

  it('can start a season without copying the structure', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.type(await screen.findByLabelText('Label'), '2029/30')
    await user.click(screen.getByTestId('copy-structure'))
    await user.click(screen.getByRole('button', { name: 'Create season' }))
    await waitFor(() => expect(rpcCalls.some((c) => c.fn === 'start_season')).toBe(true))
    expect(rpcCalls.find((c) => c.fn === 'start_season')?.args).not.toHaveProperty('p_copy_from')
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
    expect(out.exportVersion).toBe(7) // 7: + readiness confirmations and the shared progress block (Phase 4); 6: + prerequisite links (Phase 3); 5: + department memberships (Phase 2)
    expect(typeof out.exportedAt).toBe('string')
    expect(typeof out.consistency).toBe('string')
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

// --- Protected updates that match no row ------------------------------------
// An UPDATE that RLS refuses touches no rows and reports no error — the same
// shape as updating a row that was deleted or renamed a moment ago. These
// three (members, subteams, milestones) ask is_admin() to tell the two apart,
// the same pattern useFinances.ts / useMeetings.ts / useTasks.ts already use.
describe('protected updates distinguish forbidden from vanished', () => {
  it('a non-admin editing someone else is refused, not silently ignored', async () => {
    caller = CREW // no privileged role
    const update = hook(() => useUpdateMember())
    await expect(update.current.mutateAsync({ id: 'm3', fullName: 'Hacked' })).rejects.toThrow(
      /don't have permission/,
    )
    expect(db.members.find((m) => m.id === 'm3')?.full_name).toBe('Cy Deputy')
  })

  it('an admin editing a member who no longer exists is told so', async () => {
    caller = PRES
    const update = hook(() => useUpdateMember())
    await expect(update.current.mutateAsync({ id: 'nonexistent-member', fullName: 'Ghost' })).rejects.toThrow(
      /no longer exist/,
    )
  })

  it('a non-admin editing a subsystem is refused, not silently ignored', async () => {
    caller = CREW
    const update = hook(() => useUpdateSubteam())
    await expect(update.current.mutateAsync({ key: 'GEOM', description: 'Hacked' })).rejects.toThrow(
      /don't have permission/,
    )
    expect(db.subteams.find((s) => s.key === 'GEOM')?.description).toBeNull()
  })

  it('an admin editing a subsystem that no longer exists is told so', async () => {
    caller = PRES
    const update = hook(() => useUpdateSubteam())
    await expect(update.current.mutateAsync({ key: 'GHOST', description: 'x' })).rejects.toThrow(
      /no longer exists/,
    )
  })

  it('a non-admin editing a milestone is refused, not silently ignored', async () => {
    caller = CREW
    const update = hook(() => useUpdateMilestone())
    await expect(update.current.mutateAsync({ key: 'MS1-1', maxPoints: 999 })).rejects.toThrow(
      /don't have permission/,
    )
    expect(db.milestones.find((m) => m.key === 'MS1-1')?.max_points).toBe(75)
  })

  it('an admin editing a milestone that no longer exists is told so', async () => {
    caller = PRES
    const update = hook(() => useUpdateMilestone())
    await expect(update.current.mutateAsync({ key: 'GHOST-MS', maxPoints: 10 })).rejects.toThrow(
      /no longer exists/,
    )
  })
})
