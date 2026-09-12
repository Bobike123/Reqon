import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Authorization for proposals, board tasks and meetings — role by role, at the
// data layer, never by looking at buttons.
//
// The fake enforces the policies of
// 20260108000000_proposals_and_meetings.sql, and behaves like PostgREST does:
// a refused INSERT is an error (42501), while a refused UPDATE or DELETE simply
// matches no rows. supabase/tests/roles_rls_test.sql proves the same matrix
// against a real Postgres; this file proves the app reacts correctly to it.

type Role = 'president' | 'vicepresident' | 'treasurer' | 'developer'

const caller = { id: 'me', roles: [] as Role[] }
const isAdmin = () =>
  caller.roles.some((r) => r === 'president' || r === 'vicepresident' || r === 'developer')
const canDeleteRecords = () => caller.roles.some((r) => r === 'president' || r === 'developer')

let db: Record<string, Record<string, unknown>[]>

function allows(table: string, op: 'insert' | 'update' | 'delete', payload?: Record<string, unknown>) {
  if (table === 'task_proposals') {
    // is_member() is true for everyone in these tests; the interesting half of
    // proposal_insert is that raised_by must be the caller.
    if (op === 'insert') return payload?.raised_by === caller.id
    if (op === 'update') return isAdmin()
    return canDeleteRecords()
  }
  if (table === 'tasks') {
    if (op === 'insert') return isAdmin()
    if (op === 'update') return true
    return canDeleteRecords()
  }
  if (table === 'meetings') {
    if (op === 'delete') return canDeleteRecords()
    return isAdmin()
  }
  if (table === 'meeting_template') return canDeleteRecords()
  return true
}

function builder(table: string) {
  const ctx = { op: 'select', payload: {} as Record<string, unknown>, filters: {} as Record<string, unknown> }
  const matches = (row: Record<string, unknown>) =>
    Object.entries(ctx.filters).every(([k, v]) => row[k] === v)
  const run = () => {
    const rows = db[table] ?? []
    if (ctx.op === 'select') return { data: rows.filter(matches), error: null }
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
    range: () => b,
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

const supabase = {
  from: (table: string) => builder(table),
  rpc: async (fn: string) => ({
    data: fn === 'can_delete_records' ? canDeleteRecords() : isAdmin(),
    error: null,
  }),
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({
    status: 'member',
    user: { id: caller.id },
    member: { id: caller.id, full_name: 'Test Person' },
    roles: caller.roles,
  }),
}))
vi.mock('./useCurrentSeason.ts', () => ({
  useCurrentSeason: () => ({ data: { id: 'season-a', label: '2026/27' } }),
}))

const { useProposals, usePromoteProposal, useSuggestProposal, useUpdateProposal } = await import(
  './useProposals.ts'
)
const { useDeleteTask } = await import('./useTasks.ts')
const { useCreateMeeting, useDeleteMeeting, useSaveMeetingTemplate, useUpdateMeeting } = await import(
  './useMeetings.ts'
)

function hook<T>(use: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
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
}

beforeEach(() => {
  caller.id = 'me'
  caller.roles = []
  db = {
    task_proposals: [{ ...PROPOSAL }],
    tasks: [{ id: 't1', season_id: 'season-a', title: 'Fit tyres', source_proposal: null }],
    meetings: [{ id: 'm1', season_id: 'season-a', title: 'Weekly build', held_on: '2026-09-10' }],
    meeting_template: [{ id: true, body: '## Agenda' }],
  }
})

// Every capability, once per role. `true` = the database lets this role do it.
type Capability =
  | 'suggest'
  | 'review'
  | 'promote'
  | 'deleteTask'
  | 'createMeeting'
  | 'deleteMeeting'
  | 'editTemplate'

const MATRIX: Record<string, Record<Capability, boolean>> = {
  member:        { suggest: true, review: false, promote: false, deleteTask: false, createMeeting: false, deleteMeeting: false, editTemplate: false },
  treasurer:     { suggest: true, review: false, promote: false, deleteTask: false, createMeeting: false, deleteMeeting: false, editTemplate: false },
  vicepresident: { suggest: true, review: true,  promote: true,  deleteTask: false, createMeeting: true,  deleteMeeting: false, editTemplate: false },
  president:     { suggest: true, review: true,  promote: true,  deleteTask: true,  createMeeting: true,  deleteMeeting: true,  editTemplate: true },
  developer:     { suggest: true, review: true,  promote: true,  deleteTask: true,  createMeeting: true,  deleteMeeting: true,  editTemplate: true },
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
      caller.roles = role === 'member' ? [] : [role as Role]
    })

    it('may suggest a proposal, in their own name only', async () => {
      await ready()
      const suggest = hook(() => useSuggestProposal())
      await expect(suggest.current.mutateAsync({ title: 'New idea' })).resolves.toBeTruthy()
      // proposal_insert pins raised_by to the caller, so nobody can suggest in
      // someone else's name.
      expect(db.task_proposals.at(-1)).toMatchObject({ raised_by: 'me' })
    })

    it(`${may.review ? 'may' : 'may not'} change a proposal's stage or decision`, async () => {
      await ready()
      const update = hook(() => useUpdateProposal())
      const run = update.current.mutateAsync({ id: 'p1', state: 'decided' })
      if (may.review) {
        await expect(run).resolves.not.toThrow()
        expect(db.task_proposals[0].state).toBe('decided')
      } else {
        await expect(run).rejects.toThrow(refusal)
        expect(db.task_proposals[0].state).toBe('open')
      }
    })

    it(`${may.promote ? 'may' : 'may not'} promote a proposal onto the Board`, async () => {
      await ready()
      const promote = hook(() => usePromoteProposal())
      const run = promote.current.mutateAsync({
        proposal: PROPOSAL as never,
        ownerId: 'someone',
        dueDate: '2026-10-01',
      })
      if (may.promote) {
        await expect(run).resolves.toBeTruthy()
        // Assignment and dates are part of promotion, and provenance is kept.
        expect(db.tasks.at(-1)).toMatchObject({
          source_proposal: 'p1',
          owner_id: 'someone',
          due_date: '2026-10-01',
        })
      } else {
        await expect(run).rejects.toThrow(refusal)
        expect(db.tasks).toHaveLength(1)
      }
    })

    it(`${may.deleteTask ? 'may' : 'may not'} delete a board task`, async () => {
      const remove = hook(() => useDeleteTask())
      const run = remove.current.mutateAsync('t1')
      if (may.deleteTask) {
        await expect(run).resolves.not.toThrow()
        expect(db.tasks).toHaveLength(0)
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
