import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A stateful fake Postgres. Writes persist, so this exercises the real hooks,
// the real mutations and the real cache invalidation — not mocked-out results.

const SEASON = { id: 'season-a', label: '2026/27', is_current: true }
const MEMBER = { id: 'm1', full_name: 'Ada Rider', status: 'active' }
const MEMBER2 = { id: 'm2', full_name: 'Bo Wrench', status: 'active' }
const CLAUSE = { clause_key: 'B.1.1.1', printed_ref: 'B.1.1.1', section: 'B', article: 1, article_title: null, group_title: null, subteam_key: null, body: 'Fairing width rule', obligation: 'constraint', criticality: 'required', phase: null, milestone_key: null, is_team_duty: false, specs: [] }

// A complete proposal, as submit_proposal() stores it.
function proposalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1', season_id: 'season-a', title: 'T', context: null, state: 'open', decision: null, owner_id: null,
    starred: false, raised_by: 'm1', raised_on: '2026-01-01', decided_at: null, meeting_id: null,
    updated_at: '2026-01-01', subteam_key: 'AERO', due_date: '2026-12-01', priority: 'normal',
    milestone_key: 'MS1-1', outcome: null, archived_at: null, archived_by: null, archive_reason: null,
    legacy_incomplete: false, revision: 1, approved_revision: null, approved_by: null,
    approved_at: null, approved_as: null, approved_digest: null, ...over,
  }
}

let db: Record<string, Record<string, unknown>[]>
let insertCount: Record<string, number>
let failNextSubmit = false
let denyNextPromote = false

function reset() {
  db = {
    v_current_season: [SEASON],
    seasons: [SEASON],
    members: [MEMBER, MEMBER2],
    task_proposals: [],
    proposal_comments: [],
    proposal_requirements: [],
    tasks: [],
    clauses: [CLAUSE],
    clause_status: [],
    // m1 heads Aerodynamics: the only person besides a Developer who may review
    // or promote a proposal in it (can_review_proposal).
    subteams: [{ key: 'AERO', name: 'Aerodynamics', description: null, lead_id: 'm1', is_parked: false, sort_order: 0, book_section: null, archived_at: null, archived_by: null, archive_reason: null },
      { key: 'BODY', name: 'Bodywork', description: null, lead_id: 'm2', is_parked: false, sort_order: 1, book_section: null, archived_at: null, archived_by: null, archive_reason: null }],
    milestones: [{ key: 'MS1-1', season_id: 'season-a', ordinal: 1, name: 'Team Plan', due_on: '2099-11-30', max_points: 75 }],
    v_subteam_progress: [],
    v_attention: [],
  }
  insertCount = {}
  failNextSubmit = false
  denyNextPromote = false
}

let nextId = 1
function makeBuilder(table: string) {
  const ctx: {
    op: string; payload?: Record<string, unknown>; filters: Record<string, unknown>; single: boolean
    range?: [number, number]
  } = {
    op: 'select', filters: {}, single: false,
  }
  const run = () => {
    let rows = [...(db[table] ?? [])]
    if (ctx.op === 'insert') {
      insertCount[table] = (insertCount[table] ?? 0) + 1
      // Column defaults come from the schema, so the fake supplies them too —
      // the app deliberately does not send `state` when raising a proposal.
      const defaults: Record<string, Record<string, unknown>> = {
        task_proposals: { state: 'open', starred: false, decision: null, owner_id: null, decided_at: null, meeting_id: null, raised_on: '2026-09-09' },
        tasks: { state: 'todo', starred: false, owner_id: null, due_date: null, detail: null, source_proposal: null, subteam_key: null },
      }
      const row: Record<string, unknown> = {
        id: `${table}-${nextId++}`,
        ...(defaults[table] ?? {}),
        ...ctx.payload,
      }
      // The stamp_decided trigger lives in the database, not in React.
      if (table === 'task_proposals' && row.state === 'decided') row.decided_at = new Date().toISOString()
      db[table].push(row)
      return { data: ctx.single ? row : [row], error: null }
    }
    if (ctx.op === 'update') {
      const updated: Record<string, unknown>[] = []
      db[table] = db[table].map((r) => {
        const match = Object.entries(ctx.filters).every(([k, v]) => r[k] === v)
        if (!match) return r
        const next = recomputeLegacy({ ...r, ...ctx.payload })
        if (table === 'task_proposals' && next.state === 'decided' && r.state !== 'decided') {
          next.decided_at = new Date().toISOString()
        }
        updated.push(next)
        return next
      })
      return { data: ctx.single ? (updated[0] ?? null) : updated, error: null }
    }
    // A filter on an embedded resource (e.g. 'task_proposals.season_id') is a
    // server-side join this fake does not model; the season is already scoped.
    for (const [k, v] of Object.entries(ctx.filters)) if (!k.includes('.')) rows = rows.filter((r) => r[k] === v)
    if (ctx.range) rows = rows.slice(ctx.range[0], ctx.range[1] + 1)
    return { data: ctx.single ? (rows[0] ?? null) : rows, error: null }
  }

  const b: Record<string, unknown> = {
    select: () => b, order: () => b, in: () => b,
    range: (from: number, to: number) => { ctx.range = [from, to]; return b },
    limit: () => b,
    eq: (c: string, v: unknown) => { ctx.filters[c] = v; return b },
    // A no-op filter: fixture rows here don't carry every real column (e.g.
    // tasks.archived_at), and this suite isn't testing archive filtering.
    is: () => b,
    insert: (p: Record<string, unknown>) => { ctx.op = 'insert'; ctx.payload = p; return b },
    update: (p: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = p; return b },
    upsert: (p: Record<string, unknown>) => { ctx.op = 'insert'; ctx.payload = p; return b },
    single: () => { ctx.single = true; return b },
    maybeSingle: () => { ctx.single = true; return b },
    then: (resolve: (v: unknown) => void) => { resolve(run()); return Promise.resolve() },
  }
  return b
}

// The server clears an older proposal's "needs details" flag once its
// department, deadline, milestone and at least one requirement all exist.
function recomputeLegacy(row: Record<string, unknown>): Record<string, unknown> {
  if (!row.legacy_incomplete) return row
  const hasReq = (db.proposal_requirements as Record<string, unknown>[]).some((r) => r.proposal_id === row.id)
  return row.subteam_key && row.due_date && row.milestone_key && hasReq ? { ...row, legacy_incomplete: false } : row
}

// Mirrors submit_proposal(): complete input only; the author is the session.
function submitProposal(args: Record<string, unknown>) {
  const keys = args.p_clause_keys as string[] | null
  if (failNextSubmit) {
    failNextSubmit = false
    return { data: null, error: { message: 'connection lost', code: '08006' } }
  }
  if (!args.p_title || !args.p_subteam_key || !args.p_due_date || !args.p_milestone_key || !keys?.length) {
    return { data: null, error: { message: 'A proposal needs every required field.', code: '23514' } }
  }
  insertCount.task_proposals = (insertCount.task_proposals ?? 0) + 1
  const row = proposalRow({
    id: `task_proposals-${nextId++}`,
    season_id: args.p_season_id,
    title: args.p_title,
    context: args.p_description ?? null,
    owner_id: args.p_owner_id ?? null,
    subteam_key: args.p_subteam_key,
    due_date: args.p_due_date,
    priority: args.p_priority ?? 'normal',
    milestone_key: args.p_milestone_key,
    raised_on: '2026-09-09',
  })
  db.task_proposals.push(row)
  for (const k of new Set(keys)) db.proposal_requirements.push({ proposal_id: row.id, clause_key: k })
  return { data: row, error: null }
}

function setProposalRequirements(args: Record<string, unknown>) {
  const keys = args.p_clause_keys as string[]
  if (!keys?.length) return { data: null, error: { message: 'A proposal needs at least one requirement.', code: '23514' } }
  db.proposal_requirements = (db.proposal_requirements as Record<string, unknown>[]).filter((r) => r.proposal_id !== args.p_proposal_id)
  for (const k of new Set(keys)) db.proposal_requirements.push({ proposal_id: args.p_proposal_id, clause_key: k })
  db.task_proposals = (db.task_proposals as Record<string, unknown>[]).map((p) => (p.id === args.p_proposal_id ? recomputeLegacy(p) : p))
  return { data: null, error: null }
}

function proposalError(message: string, code: string) {
  return { data: null, error: { message, code } }
}

function findProposal(args: Record<string, unknown>) {
  return (db.task_proposals as Record<string, unknown>[]).find((p) => p.id === args.p_proposal_id)
}

function checkRevision(proposal: Record<string, unknown>, args: Record<string, unknown>) {
  return proposal.revision === args.p_expected_revision
    ? null
    : proposalError('This proposal changed in another session. Reload it and try again.', '40001')
}

function addProposalComment(args: Record<string, unknown>, kind = 'comment', revision?: number) {
  const proposal = findProposal(args)
  if (!proposal) return proposalError('proposal not found', '23503')
  const body = String(args.p_body ?? args.p_note ?? '').trim()
  if (!body) return proposalError('A discussion entry cannot be empty.', '22023')
  const entry = {
    id: `proposal-comments-${nextId++}`,
    proposal_id: proposal.id,
    season_id: proposal.season_id,
    author_id: 'm1',
    revision: revision ?? proposal.revision,
    kind,
    body,
    created_at: new Date().toISOString(),
  }
  db.proposal_comments.push(entry)
  return { data: entry, error: null }
}

function clearApproval(proposal: Record<string, unknown>): Record<string, unknown> {
  return {
    ...proposal,
    approved_revision: null,
    approved_by: null,
    approved_at: null,
    approved_as: null,
    approved_digest: null,
  }
}

function reviseProposal(args: Record<string, unknown>) {
  const proposal = findProposal(args)
  if (!proposal) return proposalError('proposal not found', '23503')
  const stale = checkRevision(proposal, args)
  if (stale) return stale
  const changes = (args.p_changes ?? {}) as Record<string, unknown>
  const requirementKeys = changes.requirement_keys as string[] | undefined
  if (requirementKeys) {
    if (requirementKeys.length === 0) return proposalError('A proposal needs at least one requirement.', '23514')
    db.proposal_requirements = db.proposal_requirements.filter((link) => link.proposal_id !== proposal.id)
    for (const key of new Set(requirementKeys)) db.proposal_requirements.push({ proposal_id: proposal.id, clause_key: key })
  }
  const columns: Record<string, string> = {
    title: 'title', description: 'context', owner_id: 'owner_id', due_date: 'due_date',
    priority: 'priority', milestone_key: 'milestone_key',
  }
  let updated = { ...proposal }
  for (const [input, column] of Object.entries(columns)) {
    if (Object.hasOwn(changes, input)) updated[column] = changes[input]
  }
  updated = recomputeLegacy(clearApproval({
    ...updated,
    revision: Number(proposal.revision) + 1,
    state: proposal.state === 'changes_requested' ? 'agenda' : proposal.state,
  }))
  db.task_proposals = db.task_proposals.map((row) => row.id === proposal.id ? updated : row)
  if (String(args.p_note ?? '').trim()) addProposalComment({ ...args, p_body: args.p_note }, 'revision', Number(updated.revision))
  return { data: updated, error: null }
}

function setProposalDepartment(args: Record<string, unknown>) {
  const proposal = findProposal(args)
  if (!proposal) return proposalError('proposal not found', '23503')
  const stale = checkRevision(proposal, args)
  if (stale) return stale
  const updated = clearApproval({
    ...proposal,
    subteam_key: args.p_subteam_key,
    revision: Number(proposal.revision) + 1,
    state: proposal.state === 'changes_requested' ? 'agenda' : proposal.state,
  })
  db.task_proposals = db.task_proposals.map((row) => row.id === proposal.id ? updated : row)
  addProposalComment({ ...args, p_body: args.p_reason }, 'department_change', Number(updated.revision))
  return { data: updated, error: null }
}

function requestProposalChanges(args: Record<string, unknown>) {
  const proposal = findProposal(args)
  if (!proposal) return proposalError('proposal not found', '23503')
  const stale = checkRevision(proposal, args)
  if (stale) return stale
  const updated = clearApproval({ ...proposal, state: 'changes_requested' })
  db.task_proposals = db.task_proposals.map((row) => row.id === proposal.id ? updated : row)
  addProposalComment({ ...args, p_body: args.p_note }, 'changes_requested')
  return { data: updated, error: null }
}

function approveProposal(args: Record<string, unknown>) {
  const proposal = findProposal(args)
  if (!proposal) return proposalError('proposal not found', '23503')
  const stale = checkRevision(proposal, args)
  if (stale) return stale
  if (proposal.legacy_incomplete) return proposalError('This older proposal is missing required details.', '22023')
  const updated = {
    ...proposal,
    state: 'approved',
    approved_revision: proposal.revision,
    approved_by: 'm1',
    approved_at: new Date().toISOString(),
    approved_as: 'department_head',
    approved_digest: `fixture-revision-${proposal.revision}`,
  }
  db.task_proposals = db.task_proposals.map((row) => row.id === proposal.id ? updated : row)
  addProposalComment({ ...args, p_body: args.p_note }, 'approval')
  return { data: updated, error: null }
}

// Mirrors review_proposal(): the transitions the database allows.
function reviewProposal(args: Record<string, unknown>) {
  const changes: Record<string, Record<string, unknown>> = {
    review: { state: 'agenda' },
    park: { state: 'parked' },
    reject: { state: 'decided', outcome: 'rejected', archived_at: 'now', archive_reason: 'rejected' },
    reopen: { state: 'open', outcome: null, archived_at: null, archive_reason: null },
  }
  const change = changes[args.p_action as string]
  const proposal = findProposal(args)
  if (!proposal) return proposalError('proposal not found', '23503')
  const stale = checkRevision(proposal, args)
  if (stale) return stale
  let updated: Record<string, unknown> | null = null
  db.task_proposals = (db.task_proposals as Record<string, unknown>[]).map((p) => {
    if (p.id !== args.p_proposal_id) return p
    updated = clearApproval({ ...p, ...change })
    return updated
  })
  return updated ? { data: updated, error: null } : { data: null, error: { message: 'proposal not found', code: '23503' } }
}

// Mirrors promote_proposal(): one call, idempotent on an
// already-promoted proposal, refusing an older proposal that is still incomplete
// and any proposal without approval of its current revision, copying its own
// fields.
function promoteProposal(args: Record<string, unknown>) {
  const proposal = (db.task_proposals as Record<string, unknown>[]).find((p) => p.id === args.p_proposal_id)
  if (!proposal) return { data: null, error: { message: 'proposal not found', code: '23503' } }
  const existing = (db.tasks as Record<string, unknown>[]).find((t) => t.source_proposal === args.p_proposal_id)
  if (denyNextPromote) {
    denyNextPromote = false
    return { data: null, error: { message: "Only the Head of this proposal's department, or a Developer, may promote it.", code: '42501' } }
  }
  if (existing) return { data: [{ task: existing, created: false }], error: null }
  if (proposal.legacy_incomplete) {
    return { data: null, error: { message: 'This older proposal is missing required details. Complete them before promoting it.', code: '22023' } }
  }
  if (proposal.archived_at || proposal.state !== 'approved' || proposal.approved_revision !== proposal.revision) {
    return { data: null, error: { message: 'Approve the current proposal revision before promoting it.', code: '22023' } }
  }
  const task: Record<string, unknown> = {
    id: `tasks-${nextId++}`,
    season_id: args.p_season_id,
    title: proposal.title,
    detail: proposal.context ?? null,
    owner_id: args.p_owner_id ?? proposal.owner_id ?? null,
    due_date: proposal.due_date,
    starts_on: args.p_starts_on,
    subteam_key: proposal.subteam_key,
    milestone_key: proposal.milestone_key,
    state: 'todo',
    starred: false,
    source_proposal: args.p_proposal_id,
    created_by: 'm1',
  }
  insertCount.tasks = (insertCount.tasks ?? 0) + 1
  db.tasks.push(task)
  db.task_proposals = (db.task_proposals as Record<string, unknown>[]).map((p) =>
    p.id === args.p_proposal_id
      ? { ...p, state: 'decided', outcome: 'approved', decided_at: new Date().toISOString(), archived_at: 'now', archive_reason: 'promoted' }
      : p,
  )
  return { data: [{ task, created: true }], error: null }
}

const supabase = {
  from: (t: string) => makeBuilder(t),
  rpc: async (fn: string, args?: Record<string, unknown>) => {
    if (fn === 'promote_proposal') return promoteProposal(args ?? {})
    if (fn === 'submit_proposal') return submitProposal(args ?? {})
    if (fn === 'revise_proposal') return reviseProposal(args ?? {})
    if (fn === 'set_proposal_department') return setProposalDepartment(args ?? {})
    if (fn === 'add_proposal_comment') return addProposalComment(args ?? {})
    if (fn === 'request_proposal_changes') return requestProposalChanges(args ?? {})
    if (fn === 'approve_proposal') return approveProposal(args ?? {})
    if (fn === 'review_proposal') return reviewProposal(args ?? {})
    if (fn === 'set_proposal_requirements') return setProposalRequirements(args ?? {})
    if (fn === 'can_review_proposal') return { data: true, error: null }
    // attention(p_season, p_today) replaced v_attention (ADR-0007) — nothing
    // in this file asserts on its content, only that Now/Priorities render,
    // so an empty result is enough (mirrors the old v_attention: [] fixture).
    if (fn === 'attention') return { data: [], error: null }
    return { data: null, error: { message: `workflow.test.tsx fake: unhandled rpc "${fn}"`, code: 'P0001' } }
  },
  channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  removeChannel: () => {},
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: MEMBER, roles: ['president'] }),
}))
vi.mock('../data/useRealtimeClauseStatus.ts', () => ({ useRealtimeClauseStatus: () => 'live' }))

const { default: Now } = await import('./Now.tsx')
const { default: Board } = await import('./Board.tsx')
const { default: Proposals } = await import('./Proposals.tsx')
const { TutorialProvider } = await import('../tutorial/TutorialProvider.tsx')
const { AppHeader } = await import('../ui/AppHeader.tsx')
const { SeasonProvider } = await import('../season/SeasonProvider.tsx')

function renderApp(initial = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SeasonProvider>
        <MemoryRouter initialEntries={[initial]}>
          {/* The real app shell: navigation lives in the header now. */}
          <TutorialProvider>
          <AppHeader />
          <Routes>
            <Route path="/" element={<Now />} />
            <Route path="/board" element={<Board />} />
            {/* Proposals are raised and decided here; the Now screen only links
                to this screen (it no longer embeds the form — UI-02). */}
            <Route path="/proposals" element={<Proposals />} />
          </Routes>
          </TutorialProvider>
        </MemoryRouter>
      </SeasonProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => { reset(); vi.clearAllMocks() })

// The form sits behind "Raise a proposal" (kept mounted, so a draft survives
// closing it). Opens it if it is closed.
async function openProposalForm(user: ReturnType<typeof userEvent.setup>) {
  const toggle = await screen.findByTestId('proposal-form-toggle')
  if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle)
}

// The form asks for everything submit_proposal() requires.
async function fillProposalForm(user: ReturnType<typeof userEvent.setup>, title: string, description?: string) {
  await user.type(await screen.findByLabelText(/^Title/), title)
  if (description) await user.type(screen.getByLabelText('Description (optional)'), description)
  await user.selectOptions(screen.getByLabelText(/^Department \*/), 'AERO')
  fireEvent.change(screen.getByLabelText(/^Deadline/), { target: { value: '2026-12-01' } })
  await user.selectOptions(screen.getByLabelText(/^Related milestone/), 'MS1-1')
  await user.type(screen.getByLabelText('Find a requirement'), 'B.1')
  await user.click(screen.getByRole('checkbox', { name: /B\.1\.1\.1/ }))
}

// Opens the review dialog of one proposal card.
async function openReview(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(await screen.findByTestId(`review-open-${id}`))
  return within(await screen.findByRole('dialog'))
}

describe('ACCEPTANCE: Proposals -> raise -> review -> approve -> task -> Board', () => {
  // Longer timeout: this test alone drives a full multi-screen workflow.
  it('completes the whole workflow: Proposals -> review -> approve -> task on the Board', async () => {
    const user = userEvent.setup()
    renderApp('/proposals')

    // --- 1. Raise a proposal, from the Proposals screen ----------------------
    await openProposalForm(user)
    await fillProposalForm(user, 'Fairing width tolerance', 'B.2.1.2 is blocked')
    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))

    await waitFor(() => expect(db.task_proposals).toHaveLength(1))
    const proposalId = db.task_proposals[0].id as string
    expect(db.task_proposals[0]).toMatchObject({
      title: 'Fairing width tolerance', state: 'open', season_id: 'season-a', raised_by: 'm1',
      subteam_key: 'AERO', due_date: '2026-12-01', milestone_key: 'MS1-1', priority: 'normal',
    })
    expect(db.proposal_requirements).toEqual([{ proposal_id: proposalId, clause_key: 'B.1.1.1' }])
    await screen.findByTestId(`proposal-${proposalId}`)

    // --- 2. The Head of its department reviews it, adds a note, approves ------
    let dialog = await openReview(user, proposalId)
    await user.type(dialog.getByLabelText('Review note'), 'Keep 450 mm; ask the Organization to confirm.')
    await user.click(dialog.getByTestId('review-approve'))

    await waitFor(() => expect(db.task_proposals[0]).toMatchObject({ state: 'approved', approved_revision: 1, approved_by: 'm1' }))
    expect(db.tasks).toHaveLength(0)
    expect(db.proposal_comments).toEqual([expect.objectContaining({
      proposal_id: proposalId, author_id: 'm1', revision: 1, kind: 'approval',
      body: 'Keep 450 mm; ask the Organization to confirm.',
    })])

    // Approval records the exact revision; promotion is a separate, retry-safe act.
    dialog = await openReview(user, proposalId)
    await user.click(dialog.getByTestId('review-promote'))
    await waitFor(() => expect(db.tasks).toHaveLength(1))
    expect(db.tasks[0]).toMatchObject({
      title: 'Fairing width tolerance', state: 'todo', source_proposal: proposalId, created_by: 'm1',
      season_id: 'season-a', subteam_key: 'AERO', due_date: '2026-12-01',
    })
    // The approval evidence remains attributable after the proposal is promoted.
    expect(db.task_proposals[0]).toMatchObject({
      state: 'decided', outcome: 'approved', archive_reason: 'promoted',
      approved_revision: 1, approved_by: 'm1', approved_as: 'department_head',
    })

    // --- 3. The active proposal is gone from the queue, the task is discoverable
    await waitFor(() => expect(screen.queryByTestId(`proposal-${proposalId}`)).not.toBeInTheDocument())
    expect(screen.getByTestId('proposal-message')).toHaveTextContent('is on the Board')

    // --- 4. Open the Board -------------------------------------------------
    await user.click(screen.getByRole('link', { name: 'Board' }))
    await screen.findByRole('heading', { name: 'Board', level: 1 })
    const taskId = db.tasks[0].id as string
    const taskCard = await screen.findByTestId(`task-${taskId}`)
    expect(taskCard).toHaveAttribute('data-source-proposal', proposalId)
    expect(taskCard).toHaveAttribute('data-task-state', 'todo')
    expect(within(screen.getByTestId('lane-todo')).getByTestId(`task-${taskId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`task-origin-${taskId}`)).toHaveTextContent('Fairing width tolerance')
  }, 15000)
})

describe('a proposal is never a dead end', () => {
  it('keeps parked work in the queue, marked, and moves decided work to History', async () => {
    const user = userEvent.setup()
    db.task_proposals = [
      proposalRow({ id: 'a', title: 'Open one', state: 'open' }),
      proposalRow({ id: 'b', title: 'Agenda one', state: 'agenda' }),
      proposalRow({ id: 'c', title: 'Parked one', state: 'parked' }),
      proposalRow({ id: 'd', title: 'Rejected one', state: 'decided', outcome: 'rejected', archived_at: '2026-09-01', decision: 'no budget' }),
    ]
    renderApp('/proposals')
    await screen.findByTestId('proposal-a')
    expect(screen.getByTestId('proposal-c')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-parked-c')).toHaveTextContent('Parked')
    expect(screen.queryByTestId('proposal-d')).not.toBeInTheDocument()

    await user.click(within(screen.getByTestId('proposal-views')).getByRole('button', { name: /History/ }))
    expect(await screen.findByTestId('proposal-d')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-status-d')).toHaveTextContent('Rejected')
    expect(screen.getByTestId('proposal-d')).toHaveTextContent('no budget')
    expect(screen.queryByTestId('proposal-a')).not.toBeInTheDocument()
  })

  it('rejects with a confirmation, finds it in History, and reopens it', async () => {
    const user = userEvent.setup()
    db.task_proposals = [proposalRow({ id: 'a', title: 'Open one', state: 'open' })]
    renderApp('/proposals')
    let dialog = await openReview(user, 'a')
    await user.click(dialog.getByTestId('review-reject'))
    // Nothing happens until the second, explicit click.
    expect(db.task_proposals[0].state).toBe('open')
    await user.click(dialog.getByRole('button', { name: 'Yes, reject it' }))
    await waitFor(() => expect(db.task_proposals[0]).toMatchObject({ state: 'decided', outcome: 'rejected' }))
    await waitFor(() => expect(screen.queryByTestId('proposal-a')).not.toBeInTheDocument())

    await user.click(within(screen.getByTestId('proposal-views')).getByRole('button', { name: /History/ }))
    dialog = await openReview(user, 'a')
    await user.click(dialog.getByTestId('review-reopen'))
    await waitFor(() => expect(db.task_proposals[0]).toMatchObject({ state: 'open', outcome: null }))
  })

  it('parks from the dialog and keeps the parked proposal reachable and recoverable', async () => {
    const user = userEvent.setup()
    db.task_proposals = [proposalRow({ id: 'a', title: 'Open one', state: 'agenda' })]
    renderApp('/proposals')
    let dialog = await openReview(user, 'a')
    await user.click(dialog.getByTestId('review-park'))
    await waitFor(() => expect(db.task_proposals[0].state).toBe('parked'))
    expect(await screen.findByTestId('proposal-parked-a')).toBeInTheDocument()
    dialog = await openReview(user, 'a')
    await user.click(dialog.getByTestId('review-reopen'))
    await waitFor(() => expect(db.task_proposals[0].state).toBe('open'))
  })

  it('explains what blocks an older proposal, lets its Head complete it, then approves it', async () => {
    const user = userEvent.setup()
    db.task_proposals = [proposalRow({ id: 'l', title: 'Old one', legacy_incomplete: true, due_date: null, milestone_key: null })]
    renderApp('/proposals')
    expect(await screen.findByTestId('proposal-legacy-l')).toHaveTextContent(/needs a deadline, a milestone and at least one requirement/)

    const dialog = await openReview(user, 'l')
    expect(dialog.getByTestId('review-legacy')).toHaveTextContent(/still needs a deadline, a milestone and at least one requirement/)
    expect(dialog.getByTestId('review-approve')).toBeDisabled()

    fireEvent.change(dialog.getByLabelText('Deadline'), { target: { value: '2026-11-15' } })
    await user.selectOptions(dialog.getByLabelText('Milestone'), 'MS1-1')
    await user.type(dialog.getByLabelText('Find a requirement'), 'B.1')
    await user.click(dialog.getByRole('checkbox', { name: /B\.1\.1\.1/ }))
    expect(dialog.getByTestId('review-approve')).toBeDisabled()
    await user.click(dialog.getByTestId('review-save'))

    await waitFor(() => expect(db.task_proposals[0]).toMatchObject({ legacy_incomplete: false, revision: 2 }))
    let reopened = await openReview(user, 'l')
    await user.type(reopened.getByLabelText('Review note'), 'The required details are now complete.')
    await user.click(reopened.getByTestId('review-approve'))
    await waitFor(() => expect(db.task_proposals[0]).toMatchObject({ state: 'approved', approved_revision: 2 }))

    reopened = await openReview(user, 'l')
    await user.click(reopened.getByTestId('review-promote'))

    await waitFor(() => expect(db.tasks).toHaveLength(1))
    expect(db.tasks[0]).toMatchObject({ source_proposal: 'l', due_date: '2026-11-15', milestone_key: 'MS1-1' })
    expect(db.proposal_requirements).toEqual([{ proposal_id: 'l', clause_key: 'B.1.1.1' }])
  })

  it('offers discussion but no review authority for a department the viewer does not head, and says who decides', async () => {
    db.task_proposals = [proposalRow({ id: 'o', title: 'Bodywork idea', subteam_key: 'BODY' })]
    renderApp('/proposals')
    await screen.findByTestId('proposal-o')
    expect(screen.getByTestId('review-open-o')).toHaveTextContent('Discuss or revise')
    expect(screen.getByTestId('proposal-hint-o')).toHaveTextContent('The Head of Bodywork, or a Developer')
  })

  it('shows a promotion refusal from the database and preserves the approved proposal', async () => {
    const user = userEvent.setup()
    db.task_proposals = [proposalRow({ id: 'a', title: 'Refused one', state: 'open' })]
    db.proposal_requirements = [{ proposal_id: 'a', clause_key: 'B.1.1.1' }]
    renderApp('/proposals')
    let dialog = await openReview(user, 'a')
    await user.type(dialog.getByLabelText('Review note'), 'my note')
    await user.click(dialog.getByTestId('review-approve'))
    await waitFor(() => expect(db.task_proposals[0].state).toBe('approved'))

    dialog = await openReview(user, 'a')
    denyNextPromote = true
    await user.click(dialog.getByTestId('review-promote'))
    expect(await screen.findByText(/Only the Head of this proposal's department, or a Developer, may promote it/)).toBeInTheDocument()
    expect(db.tasks).toHaveLength(0)
    // A rejected write does not close the dialog or roll back the valid approval.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(dialog.getByTestId('review-approved')).toHaveTextContent('Revision 1 was approved')
    expect(db.task_proposals[0]).toMatchObject({ state: 'approved', approved_revision: 1 })
  })
})

describe('the proposal form', () => {
  it('refuses an incomplete proposal beside each field and in a summary, and creates nothing', async () => {
    const user = userEvent.setup()
    renderApp('/proposals')
    await openProposalForm(user)
    await user.type(await screen.findByLabelText(/^Title/), 'Just a title')
    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))

    const summary = await screen.findByTestId('proposal-summary')
    expect(summary).toHaveTextContent(/4 things need fixing/)
    expect(summary).toHaveFocus()
    for (const field of ['department', 'dueDate', 'milestone', 'requirement']) {
      expect(screen.getByTestId(`error-${field}`)).toBeInTheDocument()
    }
    // Each message is tied to its input for assistive technology.
    expect(screen.getByLabelText(/^Department \*/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText(/^Deadline/)).toHaveAttribute('aria-describedby', expect.stringContaining('error'))
    expect(db.task_proposals).toHaveLength(0)
    expect(db.proposal_requirements).toHaveLength(0)
    // The typed title survived.
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Just a title')
  })

  it('keeps everything typed when the server call fails, and recovers on retry', async () => {
    const user = userEvent.setup()
    renderApp('/proposals')
    await openProposalForm(user)
    await fillProposalForm(user, 'Flaky network', 'still here')
    failNextSubmit = true
    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))

    expect(await screen.findByTestId('proposal-server-error')).toHaveTextContent(/connection lost/i)
    expect(db.task_proposals).toHaveLength(0)
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Flaky network')
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('still here')
    expect(screen.getByLabelText(/^Department \*/)).toHaveValue('AERO')
    expect(screen.getByLabelText(/^Deadline/)).toHaveValue('2026-12-01')
    expect(within(screen.getByTestId('chosen-requirements')).getByText('B.1.1.1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))
    await waitFor(() => expect(db.task_proposals).toHaveLength(1))
    expect(db.task_proposals[0].title).toBe('Flaky network')
    // The form is empty again after success.
    expect(screen.getByLabelText(/^Title/)).toHaveValue('')
  })

  it('does not raise two proposals from a double submit', async () => {
    const user = userEvent.setup()
    renderApp('/proposals')
    await openProposalForm(user)
    await fillProposalForm(user, 'Only once')
    await user.tripleClick(screen.getByRole('button', { name: 'Raise proposal' }))
    await waitFor(() => expect(db.task_proposals.length).toBeGreaterThan(0))
    expect(db.task_proposals).toHaveLength(1)
    expect(insertCount.task_proposals).toBe(1)
  })

  it('stores an optional owner and an urgent priority when they are chosen', async () => {
    const user = userEvent.setup()
    renderApp('/proposals')
    await openProposalForm(user)
    await fillProposalForm(user, 'With owner')
    await user.selectOptions(screen.getByLabelText(/^Proposed owner/), 'm2')
    await user.selectOptions(screen.getByLabelText('Priority'), 'urgent')
    await user.click(screen.getByRole('button', { name: 'Raise proposal' }))
    await waitFor(() => expect(db.task_proposals).toHaveLength(1))
    expect(db.task_proposals[0]).toMatchObject({ owner_id: 'm2', priority: 'urgent' })
  })
})

describe('duplicate protection', () => {
  it('does not create a second task, and the approved proposal moves to History with its task linked', async () => {
    const user = userEvent.setup()
    db.task_proposals = [proposalRow({
      id: 't1', title: 'Order tyres', state: 'approved', decision: 'do it', approved_revision: 1,
      approved_by: 'm1', approved_at: '2026-09-01T00:00:00Z', approved_as: 'department_head',
      approved_digest: 'fixture-revision-1',
    })]
    db.proposal_requirements = [{ proposal_id: 't1', clause_key: 'B.1.1.1' }]
    renderApp('/proposals')
    const dialog = await openReview(user, 't1')
    await user.click(dialog.getByTestId('review-promote'))
    await waitFor(() => expect(db.tasks).toHaveLength(1))

    await waitFor(() => expect(screen.queryByTestId('proposal-t1')).not.toBeInTheDocument())
    await user.click(within(screen.getByTestId('proposal-views')).getByRole('button', { name: /History/ }))
    expect(await screen.findByTestId('proposal-promoted-t1')).toHaveTextContent('Created the task “Order tyres”')
    expect(screen.getByRole('button', { name: 'View discussion' })).toBeInTheDocument()
    expect(db.tasks).toHaveLength(1)
    expect(insertCount.tasks).toBe(1)
  })

  it('the conversion mutation itself is idempotent, not just the button', async () => {
    // A retry, a stale tab or a reload-and-click-again reaches the mutation
    // even when the screen no longer offers the button. Call it twice directly
    // and prove only one task is ever inserted.
    const proposal = proposalRow({
      id: 't9', title: 'Order tyres', state: 'approved', decision: 'do it', approved_revision: 1,
      approved_by: 'm1', approved_at: '2026-09-01T00:00:00Z', approved_as: 'department_head',
      approved_digest: 'fixture-revision-1',
    })
    db.task_proposals = [proposal]

    const { usePromoteProposal } = await import('../data/useProposals.ts')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <SeasonProvider>{children}</SeasonProvider>
      </QueryClientProvider>
    )
    const { useCurrentSeason } = await import('../data/useCurrentSeason.ts')
    const season = renderHook(() => useCurrentSeason(), { wrapper })
    await waitFor(() => expect(season.result.current.data).toBeTruthy())

    const { result } = renderHook(() => usePromoteProposal(), { wrapper })
    await waitFor(() => expect(result.current).toBeTruthy())

    const first = await result.current.mutateAsync({ proposal: proposal } as never)
    const second = await result.current.mutateAsync({ proposal: proposal } as never)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.task.id).toBe(first.task.id)
    expect(db.tasks).toHaveLength(1)
    expect(insertCount.tasks).toBe(1)
    expect(db.tasks[0]).toMatchObject({ created_by: 'm1', source_proposal: 't9', state: 'todo', subteam_key: 'AERO' })
  })
})

describe('task board', () => {
  beforeEach(() => {
    db.tasks = [
      // m1 heads Aerodynamics, so they may move and reassign this task.
      { id: 'k1', season_id: 'season-a', title: 'Order fairing material', detail: null, state: 'todo', priority: 'normal', owner_id: null, due_date: null, starred: false, source_proposal: null, created_by: 'm1', subteam_key: 'AERO', milestone_key: null, links_required: false, archived_at: null, created_at: '', updated_at: '2026-09-01T00:00:00Z' },
    ]
  })

  it('renders all five lanes', async () => {
    renderApp('/board')
    for (const lane of ['todo', 'wip', 'blocked', 'done', 'cancelled']) {
      expect(await screen.findByTestId(`lane-${lane}`)).toBeInTheDocument()
    }
  })

  it('moves a task between lanes and persists the new state', async () => {
    const user = userEvent.setup()
    renderApp('/board')
    const card = await screen.findByTestId('task-k1')
    await user.selectOptions(within(card).getByLabelText(/^Move /), 'wip')
    await waitFor(() => expect(db.tasks[0].state).toBe('wip'))
    await waitFor(() =>
      expect(within(screen.getByTestId('lane-wip')).getByTestId('task-k1')).toBeInTheDocument(),
    )
  })

  it('assigns an owner from the details editor, listing active members', async () => {
    const user = userEvent.setup()
    renderApp('/board')
    const card = await screen.findByTestId('task-k1')
    await user.click(within(card).getByText(/^Details/))
    const panel = within(await screen.findByTestId('task-details-k1'))
    const owner = panel.getByLabelText('Owner')
    expect([...(owner as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Unassigned', 'Ada Rider', 'Bo Wrench'])
    await user.selectOptions(owner, 'm2')
    await user.click(panel.getByTestId('task-save-k1'))
    await waitFor(() => expect(db.tasks[0].owner_id).toBe('m2'))
  })

  it('is keyboard operable — the movement control is a real select', async () => {
    renderApp('/board')
    const card = await screen.findByTestId('task-k1')
    const move = within(card).getByLabelText(/^Move /)
    expect(move.tagName).toBe('SELECT')
    move.focus()
    expect(document.activeElement).toBe(move)
  })
})
