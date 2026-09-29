import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The proposal command adapters in isolation: each hook's request shape and its
// error classification. supabase/tests/proposal_commands_test.sql proves the
// rules themselves against a real database.

type Result = { data: unknown; error: { message: string; code?: string } | null }
let rpcResults: Record<string, Result>
let calls: { fn: string; args: Record<string, unknown> }[]

const supabase = {
  from: (_table: string) => ({}),
  rpc: (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
    return Promise.resolve(rpcResults[fn] ?? { data: null, error: { message: `unmocked rpc ${fn}` } })
  },
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../season/context.ts', () => ({ useSeasonId: () => 'season-a' }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'me' }, member: { id: 'me', status: 'active' }, roles: [] }),
}))

const { useReviseProposal, useReviewProposal, useSubmitProposal, usePromoteProposal, useSetProposalRequirements,
  useApproveProposal, useRequestProposalChanges, useAddProposalComment, useSetProposalDepartment } =
  await import('./useProposals.ts')

function hook<T>(useHook: () => T) {
  const queryClient = new QueryClient()
  return renderHook(useHook, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  }).result
}

const complete = {
  title: 'Mount the wing',
  departmentKey: 'AERO',
  dueDate: '2026-12-01',
  milestoneKey: 'MS1-1',
  requirementKeys: ['A.1.1.1', 'A.1.1.2'],
}

beforeEach(() => {
  rpcResults = {}
  calls = []
})

describe('useSubmitProposal', () => {
  it('sends every required field to submit_proposal and never an author', async () => {
    rpcResults.submit_proposal = { data: { id: 'p1' }, error: null }
    const submit = hook(() => useSubmitProposal())
    await submit.current.mutateAsync({ ...complete, description: 'why', priority: 'urgent', ownerId: 'm2' })
    expect(calls).toEqual([
      {
        fn: 'submit_proposal',
        args: {
          p_season_id: 'season-a',
          p_title: 'Mount the wing',
          p_subteam_key: 'AERO',
          p_due_date: '2026-12-01',
          p_milestone_key: 'MS1-1',
          p_clause_keys: ['A.1.1.1', 'A.1.1.2'],
          p_description: 'why',
          p_priority: 'urgent',
          p_owner_id: 'm2',
        },
      },
    ])
  })

  it('defaults priority to normal and leaves the owner out when there is none', async () => {
    rpcResults.submit_proposal = { data: { id: 'p1' }, error: null }
    const submit = hook(() => useSubmitProposal())
    await submit.current.mutateAsync(complete)
    expect(calls[0].args).toMatchObject({ p_priority: 'normal' })
    expect(calls[0].args).not.toHaveProperty('p_owner_id')
  })

  it('refuses a visibly incomplete proposal without sending anything', async () => {
    const submit = hook(() => useSubmitProposal())
    await expect(submit.current.mutateAsync({ ...complete, requirementKeys: [], dueDate: '' })).rejects.toThrow(
      /a deadline, at least one requirement/,
    )
    expect(calls).toEqual([])
  })

  it('surfaces the database\'s own refusal', async () => {
    rpcResults.submit_proposal = { data: null, error: { message: 'A proposal can only be raised to an active department.', code: '23514' } }
    const submit = hook(() => useSubmitProposal())
    await expect(submit.current.mutateAsync(complete)).rejects.toThrow(/active department/)
  })
})

describe('useReviewProposal', () => {
  it.each(['review', 'park', 'reject', 'reopen'] as const)('calls review_proposal with %s', async (action) => {
    rpcResults.review_proposal = { data: { id: 'p1' }, error: null }
    const review = hook(() => useReviewProposal())
    await review.current.mutateAsync({ id: 'p1', action, expectedRevision: 4, note: 'because' })
    expect(calls).toEqual([{ fn: 'review_proposal', args: { p_proposal_id: 'p1', p_action: action, p_expected_revision: 4, p_note: 'because' } }])
  })

  it('surfaces a refusal as raised', async () => {
    rpcResults.review_proposal = { data: null, error: { message: 'Only the Head may review it.', code: '42501' } }
    const review = hook(() => useReviewProposal())
    await expect(review.current.mutateAsync({ id: 'p1', action: 'reject', expectedRevision: 4 })).rejects.toThrow()
  })
})

describe('usePromoteProposal', () => {
  const proposal = { id: 'p1', owner_id: 'proposed-owner' } as never

  it('sends the proposal, season, owner and the browser-local start day', async () => {
    rpcResults.promote_proposal = { data: [{ task: { id: 't1' }, created: true }], error: null }
    const promote = hook(() => usePromoteProposal())
    const result = await promote.current.mutateAsync({ proposal, ownerId: 'chosen' })
    expect(result.created).toBe(true)
    expect(calls).toEqual([
      { fn: 'promote_proposal', args: { p_proposal_id: 'p1', p_season_id: 'season-a', p_owner_id: 'chosen', p_starts_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } },
    ])
  })

  it('falls back to the proposed owner, and omits the owner entirely when there is none', async () => {
    rpcResults.promote_proposal = { data: [{ task: { id: 't1' }, created: false }], error: null }
    const promote = hook(() => usePromoteProposal())
    await promote.current.mutateAsync({ proposal })
    await promote.current.mutateAsync({ proposal: { id: 'p2', owner_id: null } as never })
    expect(calls[0].args).toMatchObject({ p_owner_id: 'proposed-owner' })
    expect(calls[1].args).not.toHaveProperty('p_owner_id')
  })
})

describe('useReviseProposal', () => {
  it('sends material fields, requirements and the revision the editor saw', async () => {
    rpcResults.revise_proposal = { data: { id: 'p1', revision: 3 }, error: null }
    const revise = hook(() => useReviseProposal())
    await revise.current.mutateAsync({ id: 'p1', expectedRevision: 2,
      changes: { description: 'new text', dueDate: '2027-01-05', requirementKeys: ['A.1'] }, note: 'why' })
    expect(calls).toEqual([{ fn: 'revise_proposal', args: {
      p_proposal_id: 'p1', p_expected_revision: 2,
      p_changes: { description: 'new text', due_date: '2027-01-05', requirement_keys: ['A.1'] }, p_note: 'why',
    } }])
  })

  it('surfaces a stale-write refusal', async () => {
    rpcResults.revise_proposal = { data: null, error: { message: 'This proposal changed since you opened it.', code: '40001' } }
    const revise = hook(() => useReviseProposal())
    await expect(revise.current.mutateAsync({ id: 'p1', expectedRevision: 1, changes: { title: 'old' } })).rejects.toThrow(/changed since/)
  })
})

describe('discussion and approval commands', () => {
  it('passes attributable comments and evidence-bearing review commands', async () => {
    for (const fn of ['add_proposal_comment', 'request_proposal_changes', 'approve_proposal', 'set_proposal_department']) {
      rpcResults[fn] = { data: { id: 'p1' }, error: null }
    }
    await hook(() => useAddProposalComment()).current.mutateAsync({ id: 'p1', body: 'Question' })
    await hook(() => useRequestProposalChanges()).current.mutateAsync({ id: 'p1', expectedRevision: 2, note: 'Answer this' })
    await hook(() => useApproveProposal()).current.mutateAsync({ id: 'p1', expectedRevision: 2, note: 'Reviewed' })
    await hook(() => useSetProposalDepartment()).current.mutateAsync({ id: 'p1', departmentKey: 'BODY', reason: 'scope', expectedRevision: 2 })
    expect(calls).toEqual([
      { fn: 'add_proposal_comment', args: { p_proposal_id: 'p1', p_body: 'Question' } },
      { fn: 'request_proposal_changes', args: { p_proposal_id: 'p1', p_expected_revision: 2, p_note: 'Answer this' } },
      { fn: 'approve_proposal', args: { p_proposal_id: 'p1', p_expected_revision: 2, p_note: 'Reviewed' } },
      { fn: 'set_proposal_department', args: { p_proposal_id: 'p1', p_subteam_key: 'BODY', p_reason: 'scope', p_expected_revision: 2 } },
    ])
  })
})

describe('useSetProposalRequirements', () => {
  it('replaces the requirement set through the command', async () => {
    rpcResults.set_proposal_requirements = { data: null, error: null }
    const set = hook(() => useSetProposalRequirements())
    await set.current.mutateAsync({ id: 'p1', clauseKeys: ['A.1', 'B.2'], expectedRevision: 3 })
    await waitFor(() => expect(set.current.isSuccess).toBe(true))
    expect(calls).toEqual([{ fn: 'set_proposal_requirements', args: { p_proposal_id: 'p1', p_clause_keys: ['A.1', 'B.2'], p_expected_revision: 3 } }])
  })

  it('surfaces the database refusal', async () => {
    rpcResults.set_proposal_requirements = { data: null, error: { message: 'A proposal needs at least one requirement.', code: '23514' } }
    const set = hook(() => useSetProposalRequirements())
    await expect(set.current.mutateAsync({ id: 'p1', clauseKeys: [], expectedRevision: 3 })).rejects.toThrow(/at least one requirement/)
  })
})
