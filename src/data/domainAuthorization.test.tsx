import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Authorization for proposals and meetings — who, at the data layer, never by
// looking at buttons.
//
// The fake enforces the rules of 20260108000000_proposals_and_meetings.sql
// (meetings) and 20260117000000_traceability_and_proposal_commands.sql
// (proposals: only the proposal's department Head or a Developer may review
// or promote; President/VP alone may not), and behaves like PostgREST does: a
// refused command is an error (42501), while a refused UPDATE or DELETE simply
// matches no rows. supabase/tests/roles_rls_test.sql proves the same matrix
// against a real Postgres; this file proves the app reacts correctly to it.

type Role = 'president' | 'vicepresident' | 'treasurer' | 'developer'

const caller = { id: 'me', roles: [] as Role[], headOf: [] as string[] }
const isAdmin = () =>
  caller.roles.some((r) => r === 'president' || r === 'vicepresident' || r === 'developer')
const canDeleteRecords = () => caller.roles.some((r) => r === 'president' || r === 'developer')
// can_review_proposal(): the proposal's department Head, or a Developer.
const canReviewProposal = (proposal?: Record<string, unknown>) =>
  caller.roles.includes('developer') ||
  (proposal !== undefined && typeof proposal.subteam_key === 'string' && caller.headOf.includes(proposal.subteam_key))

let db: Record<string, Record<string, unknown>[]>
// v_current_season returns one row (or none) in real PostgREST, never an
// array — every fixture below already lives under season_id 'season-a'.
const CURRENT_SEASON = { id: 'season-a', label: '2026/27' }

function allows(table: string, op: 'insert' | 'update' | 'delete', payload?: Record<string, unknown>) {
  if (table === 'task_proposals') {
    // No INSERT or DELETE policy exists any more: creation is submit_proposal(),
    // and nothing deletes a proposal. Only the reviewer may UPDATE one.
    if (op === 'insert' || op === 'delete') return false
    void payload
    return canReviewProposal(db.task_proposals[0])
  }
  if (table === 'meetings') {
    if (op === 'delete') return canDeleteRecords()
    return isAdmin()
  }
  if (table === 'meeting_template') return canDeleteRecords()
  return true
}

function builder(table: string) {
  const ctx = {
    op: 'select', payload: {} as Record<string, unknown>, filters: {} as Record<string, unknown>,
    range: undefined as [number, number] | undefined,
  }
  const matches = (row: Record<string, unknown>) =>
    Object.entries(ctx.filters).every(([k, v]) => row[k] === v)
  const run = () => {
    if (table === 'v_current_season') return { data: CURRENT_SEASON, error: null }
    const rows = db[table] ?? []
    if (ctx.op === 'select') {
      const hit = rows.filter(matches)
      return { data: ctx.range ? hit.slice(ctx.range[0], ctx.range[1] + 1) : hit, error: null }
    }
    if (ctx.op === 'insert') {
      if (!allows(table, 'insert', ctx.payload)) {
        return {
          data: null,
          error: { message: `new row violates row-level security policy for table "${table}"`, code: '42501' },
        }
      }
      const row = { id: `${table}-${rows.length + 1}`, ...ctx.payload }
      rows.push(row)
      return { data: row, error: null }
    }
    // As PostgREST: a refused UPDATE/DELETE is not an error, it touches nothing.
    if (!allows(table, ctx.op as 'update' | 'delete')) return { data: [], error: null }
    const hit = rows.filter(matches)
    if (ctx.op === 'update') db[table] = rows.map((r) => (matches(r) ? { ...r, ...ctx.payload } : r))
    if (ctx.op === 'delete') db[table] = rows.filter((r) => !matches(r))
    return { data: hit.map((r) => ({ id: r.id })), error: null }
  }
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    range: (from: number, to: number) => { ctx.range = [from, to]; return b },
    limit: () => b,
    returns: () => b,
    eq: (column: string, value: unknown) => {
      ctx.filters[column] = value
      return b
    },
    insert: (payload: Record<string, unknown>) => {
      ctx.op = 'insert'
      ctx.payload = payload
      return b
    },
    update: (payload: Record<string, unknown>) => {
      ctx.op = 'update'
      ctx.payload = payload
      return b
    },
    delete: () => {
      ctx.op = 'delete'
      return b
    },
    single: () => b,
    maybeSingle: () => b,
    then: (resolve: (value: unknown) => void) => {
      resolve(run())
      return Promise.resolve()
    },
  }
  return b
}

// Mirrors submit_proposal(): complete input only, author is the caller.
function submitProposal(args: Record<string, unknown>) {
  const keys = args.p_clause_keys as string[] | null
  if (!args.p_title || !args.p_subteam_key || !args.p_due_date || !args.p_milestone_key || !keys?.length) {
    return { data: null, error: { message: 'A proposal needs every required field.', code: '23514' } }
  }
  const row = {
    id: `task_proposals-${db.task_proposals.length + 1}`,
    season_id: args.p_season_id,
    title: args.p_title,
    context: args.p_description ?? null,
    subteam_key: args.p_subteam_key,
    due_date: args.p_due_date,
    milestone_key: args.p_milestone_key,
    priority: args.p_priority ?? 'normal',
    state: 'open',
    outcome: null,
    archived_at: null,
    legacy_incomplete: false,
    raised_by: caller.id,
  }
  db.task_proposals.push(row)
  return { data: row, error: null }
}

// Mirrors review_proposal(): reviewer only, from the states it allows.
function reviewProposal(args: Record<string, unknown>) {
  const proposal = db.task_proposals.find((p) => p.id === args.p_proposal_id)
  if (!proposal) return { data: null, error: { message: 'proposal not found', code: '23503' } }
  if (!canReviewProposal(proposal)) {
    return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } }
  }
  const next: Record<string, Record<string, unknown>> = {
    review: { state: 'agenda' },
    park: { state: 'parked' },
    reject: { state: 'decided', outcome: 'rejected', archived_at: 'now' },
    reopen: { state: 'open', outcome: null, archived_at: null },
  }
  const change = next[args.p_action as string]
  if (!change) return { data: null, error: { message: 'unknown action', code: '22023' } }
  Object.assign(proposal, change)
  return { data: proposal, error: null }
}

// Mirrors promote_proposal() (20260117): the proposal's Head or a Developer,
// idempotent on an already-promoted proposal, copies the proposal's own fields.
function promoteProposal(args: Record<string, unknown>) {
  const proposal = db.task_proposals.find((p) => p.id === args.p_proposal_id)
  if (!proposal) return { data: null, error: { message: 'proposal not found', code: '23503' } }
  if (!canReviewProposal(proposal)) {
    return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } }
  }
  const existing = db.tasks.find((t) => t.source_proposal === args.p_proposal_id)
  if (existing) return { data: [{ task: existing, created: false }], error: null }
  const task = {
    id: `tasks-${db.tasks.length + 1}`,
    season_id: args.p_season_id,
    title: proposal.title,
    detail: proposal.context ?? null,
    owner_id: args.p_owner_id ?? proposal.owner_id ?? null,
    due_date: proposal.due_date,
    subteam_key: proposal.subteam_key,
    milestone_key: proposal.milestone_key,
    state: 'todo',
    source_proposal: args.p_proposal_id,
    created_by: caller.id,
  }
  db.tasks.push(task)
  Object.assign(proposal, { state: 'decided', outcome: 'approved', archived_at: 'now' })
  return { data: [{ task, created: true }], error: null }
}

const supabase = {
  from: (table: string) => builder(table),
  rpc: async (fn: string, args?: Record<string, unknown>) => {
    if (fn === 'promote_proposal') return promoteProposal(args ?? {})
    if (fn === 'submit_proposal') return submitProposal(args ?? {})
    if (fn === 'review_proposal') return reviewProposal(args ?? {})
    if (fn === 'can_review_proposal') {
      const proposal = db.task_proposals.find((p) => p.id === args?.p_proposal_id)
      return { data: canReviewProposal(proposal), error: null }
    }
    return { data: fn === 'can_delete_records' ? canDeleteRecords() : isAdmin(), error: null }
  },
}
let signedIn = true
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () =>
    signedIn
      ? {
          status: 'member' as const,
          user: { id: caller.id },
          member: { id: caller.id, full_name: 'Test Person' },
          roles: caller.roles,
        }
      : { status: 'signedOut' as const },
}))
vi.mock('./useCurrentSeason.ts', () => ({
  useCurrentSeason: () => ({ data: { id: 'season-a', label: '2026/27' } }),
}))

const { useProposals, usePromoteProposal, useReviewProposal, useSubmitProposal } = await import(
  './useProposals.ts'
)
const { useCreateMeeting, useDeleteMeeting, useSaveMeetingTemplate, useUpdateMeeting } = await import(
  './useMeetings.ts'
)
const { SeasonProvider } = await import('../season/SeasonProvider.tsx')
const { isPermissionError } = await import('../core/errors.ts')

function hook<T>(use: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <SeasonProvider>{children}</SeasonProvider>
    </QueryClientProvider>
  )
  return renderHook(use, { wrapper }).result
}

const PROPOSAL = {
  id: 'p1',
  season_id: 'season-a',
  title: 'Order tyres',
  context: null,
  state: 'open',
  owner_id: null,
  decision: null,
  decided_at: null,
  meeting_id: null,
  starred: false,
  raised_by: 'someone-else',
  raised_on: '2026-09-01',
  updated_at: '2026-09-01',
  subteam_key: 'AERO',
  due_date: '2026-12-01',
  milestone_key: 'MS1-1',
  priority: 'normal',
  outcome: null,
  archived_at: null,
  legacy_incomplete: false,
}

beforeEach(() => {
  caller.id = 'me'
  caller.roles = []
  caller.headOf = []
  signedIn = true
  db = {
    task_proposals: [{ ...PROPOSAL }],
    tasks: [{ id: 't1', season_id: 'season-a', title: 'Fit tyres', source_proposal: null }],
    meetings: [{ id: 'm1', season_id: 'season-a', title: 'Weekly build', held_on: '2026-09-10' }],
    meeting_template: [{ id: true, body: '## Agenda' }],
  }
})

// Every capability, once per role. `true` = the database lets this role do it.
// Task-level edit/archive/delete authorization moved to its own dedicated
// suite (useTasks.test.tsx, mirroring supabase/tests/task_authorization_test.sql)
// once it became actor+resource scoped (ADR-0003) rather than role-only —
// this file stays focused on proposals and meetings, which are unchanged.
type Capability =
  | 'suggest'
  | 'review'
  | 'promote'
  | 'createMeeting'
  | 'deleteMeeting'
  | 'editTemplate'

// `head` is an ordinary member who is the Head of the proposal's department
// (AERO); it is not a role. The President and Vice President keep meeting
// powers but have NO proposal power of their own (ADR-0003).
const MATRIX: Record<string, Record<Capability, boolean>> = {
  member:        { suggest: true, review: false, promote: false, createMeeting: false, deleteMeeting: false, editTemplate: false },
  head:          { suggest: true, review: true,  promote: true,  createMeeting: false, deleteMeeting: false, editTemplate: false },
  treasurer:     { suggest: true, review: false, promote: false, createMeeting: false, deleteMeeting: false, editTemplate: false },
  vicepresident: { suggest: true, review: false, promote: false, createMeeting: true,  deleteMeeting: false, editTemplate: false },
  president:     { suggest: true, review: false, promote: false, createMeeting: true,  deleteMeeting: true,  editTemplate: true },
  developer:     { suggest: true, review: true,  promote: true,  createMeeting: true,  deleteMeeting: true,  editTemplate: true },
}

async function ready() {
  // usePromoteProposal refuses to guess a season; wait until one is resolved.
  const proposals = hook(() => useProposals())
  await waitFor(() => expect(proposals.current.data).toBeTruthy())
}

const refusal = /don't have permission/

for (const [role, may] of Object.entries(MATRIX)) {
  describe(`a ${role}`, () => {
    beforeEach(() => {
      caller.roles = role === 'member' || role === 'head' ? [] : [role as Role]
      caller.headOf = role === 'head' ? ['AERO'] : []
    })

    it('may raise a complete proposal, in their own name only', async () => {
      await ready()
      const submit = hook(() => useSubmitProposal())
      await expect(
        submit.current.mutateAsync({
          title: 'New idea',
          departmentKey: 'AERO',
          dueDate: '2026-12-01',
          milestoneKey: 'MS1-1',
          requirementKeys: ['A.1.1.1'],
        }),
      ).resolves.toBeTruthy()
      // submit_proposal() takes the author from the session, so nobody can
      // raise one in someone else's name.
      expect(db.task_proposals.at(-1)).toMatchObject({ raised_by: 'me' })
    })

    it(`${may.review ? 'may' : 'may not'} reject a proposal`, async () => {
      await ready()
      const review = hook(() => useReviewProposal())
      const run = review.current.mutateAsync({ id: 'p1', action: 'reject', expectedRevision: 1 })
      if (may.review) {
        await expect(run).resolves.toBeTruthy()
        expect(db.task_proposals[0]).toMatchObject({ state: 'decided', outcome: 'rejected' })
      } else {
        await expect(run).rejects.toThrow(refusal)
        expect(db.task_proposals[0].state).toBe('open')
      }
    })

    it(`${may.promote ? 'may' : 'may not'} promote a proposal onto the Board`, async () => {
      await ready()
      const promote = hook(() => usePromoteProposal())
      const run = promote.current.mutateAsync({ proposal: PROPOSAL as never, ownerId: 'someone' })
      if (may.promote) {
        await expect(run).resolves.toBeTruthy()
        // The owner is the promoter's choice; department, deadline and
        // provenance come from the proposal itself.
        expect(db.tasks.at(-1)).toMatchObject({
          source_proposal: 'p1',
          owner_id: 'someone',
          due_date: '2026-12-01',
          subteam_key: 'AERO',
        })
      } else {
        await expect(run).rejects.toThrow(refusal)
        expect(db.tasks).toHaveLength(1)
      }
    })

    it(`${may.createMeeting ? 'may' : 'may not'} call a meeting`, async () => {
      const create = hook(() => useCreateMeeting())
      const run = create.current.mutateAsync({
        title: 'Design review',
        heldOn: '2026-09-20',
        startsAt: null,
        endsAt: null,
        location: null,
        agenda: null,
        notes: null,
        attendees: null,
      })
      if (may.createMeeting) {
        await expect(run).resolves.toBeTruthy()
        expect(db.meetings.at(-1)).toMatchObject({ title: 'Design review', created_by: 'me' })
      } else {
        await expect(run).rejects.toThrow(refusal)
        expect(db.meetings).toHaveLength(1)
      }
    })

    it(`${may.deleteMeeting ? 'may' : 'may not'} delete a meeting`, async () => {
      const remove = hook(() => useDeleteMeeting())
      const run = remove.current.mutateAsync('m1')
      if (may.deleteMeeting) {
        await expect(run).resolves.not.toThrow()
        expect(db.meetings).toHaveLength(0)
      } else {
        await expect(run).rejects.toThrow(refusal)
        expect(db.meetings).toHaveLength(1)
      }
    })

    it(`${may.editTemplate ? 'may' : 'may not'} change the global meeting template`, async () => {
      const save = hook(() => useSaveMeetingTemplate())
      const run = save.current.mutateAsync('## New agenda')
      if (may.editTemplate) {
        await expect(run).resolves.not.toThrow()
        expect(db.meeting_template[0].body).toBe('## New agenda')
      } else {
        await expect(run).rejects.toThrow(refusal)
        expect(db.meeting_template[0].body).toBe('## Agenda')
      }
    })
  })
}

describe('a vice-president, specifically', () => {
  beforeEach(() => {
    caller.roles = ['vicepresident']
  })

  it('writes a meeting’s own agenda and minutes, but not the global template', async () => {
    const update = hook(() => useUpdateMeeting())
    await expect(
      update.current.mutateAsync({
        id: 'm1',
        title: 'Weekly build',
        heldOn: '2026-09-10',
        startsAt: null,
        endsAt: null,
        location: null,
        agenda: '## Agenda\n- fairing',
        notes: 'Decided to order tyres.',
        attendees: null,
      }),
    ).resolves.not.toThrow()
    expect(db.meetings[0]).toMatchObject({ notes: 'Decided to order tyres.' })

    const save = hook(() => useSaveMeetingTemplate())
    await expect(save.current.mutateAsync('## Mine now')).rejects.toThrow(refusal)
    expect(db.meeting_template[0].body).toBe('## Agenda')
  })
})

describe('two people editing the same meeting', () => {
  beforeEach(() => {
    caller.roles = ['vicepresident']
  })

  it('refuses a save when the meeting changed after it was opened, and says so instead of overwriting', async () => {
    db.meetings[0] = { ...db.meetings[0], updated_at: '2026-09-10T10:05:00+00:00', notes: 'Theirs.' }
    const update = hook(() => useUpdateMeeting())
    const draft = { title: 'Weekly build', heldOn: '2026-09-10', startsAt: null, endsAt: null, location: null, agenda: null, notes: 'Mine.', attendees: null }
    await expect(update.current.mutateAsync({ id: 'm1', expectedUpdatedAt: '2026-09-10T10:00:00+00:00', ...draft })).rejects.toThrow(/someone else saved it after you opened it/)
    expect(db.meetings[0]).toMatchObject({ notes: 'Theirs.' })
    // Opened on the current version: it saves.
    await expect(update.current.mutateAsync({ id: 'm1', expectedUpdatedAt: '2026-09-10T10:05:00+00:00', ...draft })).resolves.not.toThrow()
    expect(db.meetings[0]).toMatchObject({ notes: 'Mine.' })
  })
})

// A zero-row UPDATE/DELETE is ambiguous on the wire: RLS refused it, OR the row
// was already gone. The hooks ask the database which one it was. These pin the
// second half of that mapping — a permitted caller racing someone else's
// delete must NOT be told "not permitted", and must not be told it saved.
describe('a row someone else already removed', () => {
  beforeEach(() => {
    caller.roles = ['developer']
  })

  it('editing a vanished meeting reports it is gone — not a permission refusal, not a save', async () => {
    db.meetings = []
    const update = hook(() => useUpdateMeeting())
    const error = await update.current
      .mutateAsync({
        id: 'm1',
        title: 'Weekly build',
        heldOn: '2026-09-10',
        startsAt: null,
        endsAt: null,
        location: null,
        agenda: null,
        notes: 'Too late',
        attendees: null,
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/no longer exists/)
    expect(isPermissionError(error as Error)).toBe(false)
  })

  it('deleting a meeting that is already gone succeeds — the wanted outcome already holds', async () => {
    db.meetings = []
    await expect(hook(() => useDeleteMeeting()).current.mutateAsync('m1')).resolves.not.toThrow()
  })
})

describe('signed out', () => {
  // Not a database rule — the UI never offers these actions signed out, so
  // this is defence in depth: the mutation itself refuses to guess who is
  // asking rather than send a request the database would have to refuse.
  beforeEach(() => {
    signedIn = false
  })

  it('refuses to promote a proposal', async () => {
    const promote = hook(() => usePromoteProposal())
    await expect(
      promote.current.mutateAsync({ proposal: PROPOSAL as never, ownerId: 'someone' }),
    ).rejects.toThrow('not signed in')
    expect(db.tasks).toHaveLength(1)
  })

  it('refuses to raise a proposal', async () => {
    const submit = hook(() => useSubmitProposal())
    await expect(
      submit.current.mutateAsync({
        title: 'New idea',
        departmentKey: 'AERO',
        dueDate: '2026-12-01',
        milestoneKey: 'MS1-1',
        requirementKeys: ['A.1.1.1'],
      }),
    ).rejects.toThrow('not signed in')
    expect(db.task_proposals).toHaveLength(1)
  })

  it('refuses to send an incomplete proposal at all, before any request', async () => {
    signedIn = true
    const submit = hook(() => useSubmitProposal())
    await expect(
      submit.current.mutateAsync({ title: 'No details', departmentKey: '', dueDate: '', milestoneKey: '', requirementKeys: [] }),
    ).rejects.toThrow(/needs a department, a deadline, a milestone, at least one requirement/)
    expect(db.task_proposals).toHaveLength(1)
  })
})
