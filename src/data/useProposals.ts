import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { ReviewAction } from '../proposals/proposalStates.ts'
import { submissionProblems, PROBLEM_LABEL, type NewProposal } from '../proposals/submission.ts'
import type { Proposal } from '../proposals/types.ts'
import { useSeasonId } from '../season/context.ts'
import { DataError } from '../core/errors.ts'
import { todayIso } from '../lib/dates.ts'
import type { Database, Json } from '../lib/database.types.ts'
import { fetchAllRows, unwrap } from './errors.ts'
import type { Task } from './useTasks.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type { Proposal, ProposalState } from '../proposals/types.ts'
export type { NewProposal } from '../proposals/submission.ts'
export type ProposalComment = Database['public']['Tables']['proposal_comments']['Row']

export function useProposalsForSeason(seasonId: string | undefined): UseQueryResult<Proposal[], Error> {
  return useSeasonScopedQuery<Proposal[]>(queryKeys.proposals(seasonId), seasonId, (sid) =>
    fetchAllRows(
      'load proposals',
      (row) => row.id,
      (from, to) =>
        supabase
          .from('task_proposals')
          .select('*')
          .eq('season_id', sid)
          .order('raised_on', { ascending: false })
          .order('id')
          .range(from, to),
    ),
  )
}

export function useProposals(): UseQueryResult<Proposal[], Error> {
  return useProposalsForSeason(useSeasonId())
}

export function useProposalComments(): UseQueryResult<ProposalComment[], Error> {
  const seasonId = useSeasonId()
  return useSeasonScopedQuery<ProposalComment[]>(queryKeys.proposalComments(seasonId), seasonId, (sid) =>
    fetchAllRows(
      'load proposal discussion',
      (row) => row.id,
      (from, to) =>
        supabase
          .from('proposal_comments')
          .select('*')
          .eq('season_id', sid)
          .order('created_at')
          .order('id')
          .range(from, to),
    ),
  )
}

export type ProposalChanges = {
  title?: string
  description?: string | null
  ownerId?: string | null
  dueDate?: string | null
  priority?: 'normal' | 'urgent'
  milestoneKey?: string | null
  requirementKeys?: string[]
}

function changePayload(changes: ProposalChanges): Json {
  return {
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.description !== undefined ? { description: changes.description } : {}),
    ...(changes.ownerId !== undefined ? { owner_id: changes.ownerId } : {}),
    ...(changes.dueDate !== undefined ? { due_date: changes.dueDate } : {}),
    ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
    ...(changes.milestoneKey !== undefined ? { milestone_key: changes.milestoneKey } : {}),
    ...(changes.requirementKeys !== undefined ? { requirement_keys: changes.requirementKeys } : {}),
  }
}

// Every cache a proposal command can change: the proposals themselves, the
// requirement links they cite, and (a promotion creates one) the tasks.
function useRefreshProposalData() {
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()
  return (options: { tasks?: boolean } = {}) => {
    if (!seasonId) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.proposals(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.proposalRequirements(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.proposalComments(seasonId) })
    if (options.tasks) void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(seasonId) })
  }
}

export function useReviseProposal() {
  const refresh = useRefreshProposalData()
  return useMutation<Proposal, Error, { id: string; expectedRevision: number; changes: ProposalChanges; note?: string }>({
    mutationFn: async ({ id, expectedRevision, changes, note }) =>
      unwrap(
        'save that proposal revision',
        await supabase.rpc('revise_proposal', {
          p_proposal_id: id,
          p_expected_revision: expectedRevision,
          p_changes: changePayload(changes),
          ...(note?.trim() ? { p_note: note.trim() } : {}),
        }),
      ),
    onSuccess: () => refresh(),
  })
}

export function useSetProposalDepartment() {
  const refresh = useRefreshProposalData()
  return useMutation<Proposal, Error, { id: string; departmentKey: string; reason: string; expectedRevision: number }>({
    mutationFn: async ({ id, departmentKey, reason, expectedRevision }) =>
      unwrap(
        'move that proposal',
        await supabase.rpc('set_proposal_department', {
          p_proposal_id: id,
          p_subteam_key: departmentKey,
          p_reason: reason,
          p_expected_revision: expectedRevision,
        }),
      ),
    onSuccess: () => refresh(),
  })
}

export function useAddProposalComment() {
  const refresh = useRefreshProposalData()
  return useMutation<ProposalComment, Error, { id: string; body: string }>({
    mutationFn: async ({ id, body }) =>
      unwrap('add to the proposal discussion', await supabase.rpc('add_proposal_comment', {
        p_proposal_id: id,
        p_body: body,
      })),
    onSuccess: () => refresh(),
  })
}

export function useRequestProposalChanges() {
  const refresh = useRefreshProposalData()
  return useMutation<Proposal, Error, { id: string; expectedRevision: number; note: string }>({
    mutationFn: async ({ id, expectedRevision, note }) =>
      unwrap('request proposal changes', await supabase.rpc('request_proposal_changes', {
        p_proposal_id: id,
        p_expected_revision: expectedRevision,
        p_note: note,
      })),
    onSuccess: () => refresh(),
  })
}

export function useApproveProposal() {
  const refresh = useRefreshProposalData()
  return useMutation<Proposal, Error, { id: string; expectedRevision: number; note: string }>({
    mutationFn: async ({ id, expectedRevision, note }) =>
      unwrap('approve that proposal', await supabase.rpc('approve_proposal', {
        p_proposal_id: id,
        p_expected_revision: expectedRevision,
        p_note: note,
      })),
    onSuccess: () => refresh(),
  })
}

// review / park / reject / reopen: server-computed transitions (outcome, archive
// metadata and decided_at are stamped by the database), so the returned row is
// trusted over any local guess and the list is refetched, not patched.
export function useReviewProposal() {
  const refresh = useRefreshProposalData()
  return useMutation<Proposal, Error, { id: string; action: ReviewAction; expectedRevision: number; note?: string }>({
    mutationFn: async ({ id, action, expectedRevision, note }) =>
      unwrap(
        'review that proposal',
        await supabase.rpc('review_proposal', {
          p_proposal_id: id,
          p_action: action,
          p_expected_revision: expectedRevision,
          ...(note?.trim() ? { p_note: note.trim() } : {}),
        }),
      ),
    onSuccess: () => refresh(),
  })
}

// Converting an approved proposal into a task, in one database transaction:
// only current department authority may promote, and the database re-checks
// the approved revision and digest while locked before copying its department,
// owner, deadline, priority, milestone and requirements. The task carries
// `source_proposal` so the board can always answer "where did this come from?".
//
// Idempotent on purpose: if a task already points at this proposal, the existing
// one is returned unchanged with created = false, so a double click, a retry
// after a dropped response, or a reload-and-click-again is harmless. The
// promoter chooses at most the owner; everything else comes from the proposal.
export type Promotion = {
  proposal: Proposal
  ownerId?: string | null
}

export function usePromoteProposal() {
  const auth = useAuth()
  const refresh = useRefreshProposalData()
  const seasonId = useSeasonId()

  return useMutation<{ task: Task; created: boolean }, Error, Promotion>({
    mutationFn: async ({ proposal, ownerId }) => {
      if (auth.status !== 'member') {
        throw new DataError('convert proposal: not signed in as a member', null)
      }
      if (!seasonId) throw new DataError('convert proposal: no current season', null)

      // `undefined` means "keep the proposal's own owner"; `null` means the
      // reviewer cleared it (already saved on the proposal, which the server
      // reads), so nothing is sent and the old owner cannot come back.
      const owner = ownerId === undefined ? proposal.owner_id : ownerId
      const rows = unwrap<{ task: Task; created: boolean }[]>(
        'convert proposal to task',
        await supabase.rpc('promote_proposal', {
          p_proposal_id: proposal.id,
          p_season_id: seasonId,
          p_starts_on: todayIso(),
          ...(owner ? { p_owner_id: owner } : {}),
        }),
      )
      const result = rows[0]
      if (!result) throw new DataError('convert proposal to task: no row returned', null)
      return result
    },
    // Both caches move: a new task exists, and the proposal is now archived.
    onSuccess: () => refresh({ tasks: true }),
  })
}

// The ONLY way to create a proposal: submit_proposal() takes every required
// field and inserts the proposal with its requirement links in one transaction.
// A request that is visibly incomplete is refused here without a round trip;
// the database refuses it too, on every path.
export function useSubmitProposal() {
  const auth = useAuth()
  const refresh = useRefreshProposalData()
  const seasonId = useSeasonId()

  return useMutation<Proposal, Error, NewProposal>({
    mutationFn: async (proposal) => {
      if (auth.status !== 'member') {
        throw new DataError('raise proposal: not signed in as a member', null)
      }
      if (!seasonId) throw new DataError('raise proposal: no current season', null)
      const problems = submissionProblems(proposal)
      if (problems.length > 0) {
        throw new DataError(
          `raise proposal: it needs ${problems.map((p) => PROBLEM_LABEL[p]).join(', ')}`,
          null,
        )
      }

      return unwrap(
        'raise proposal',
        await supabase.rpc('submit_proposal', {
          p_season_id: seasonId,
          p_title: proposal.title,
          p_subteam_key: proposal.departmentKey,
          p_due_date: proposal.dueDate,
          p_milestone_key: proposal.milestoneKey,
          p_clause_keys: proposal.requirementKeys,
          p_description: proposal.description ?? undefined,
          p_priority: proposal.priority ?? 'normal',
          ...(proposal.ownerId ? { p_owner_id: proposal.ownerId } : {}),
        }),
      )
    },
    onSuccess: () => refresh(),
  })
}

// Replace a proposal's requirement set (the repair path for an older proposal,
// and an edit path for a Head). At least one requirement is always required.
export function useSetProposalRequirements() {
  const refresh = useRefreshProposalData()
  return useMutation<void, Error, { id: string; clauseKeys: string[]; expectedRevision: number }>({
    mutationFn: async ({ id, clauseKeys, expectedRevision }) => {
      const { error } = await supabase.rpc('set_proposal_requirements', {
        p_proposal_id: id,
        p_clause_keys: clauseKeys,
        p_expected_revision: expectedRevision,
      })
      if (error) throw new DataError('save the requirements', error)
    },
    onSuccess: () => refresh(),
  })
}

export type ProposalRequirementLink = { proposal_id: string; clause_key: string }

// Which requirements every proposal in the season cites, as flat links. Read
// once for the whole list (the review dialog and the legacy-repair explanation
// both need a proposal's count and keys) instead of once per card.
export function useProposalRequirements(): UseQueryResult<ProposalRequirementLink[], Error> {
  const seasonId = useSeasonId()
  return useSeasonScopedQuery<ProposalRequirementLink[]>(queryKeys.proposalRequirements(seasonId), seasonId, async (sid) => {
    const rows = await fetchAllRows(
      'load proposal requirements',
      (row: ProposalRequirementLink) => `${row.proposal_id}|${row.clause_key}`,
      (from, to) =>
        supabase
          .from('proposal_requirements')
          .select('proposal_id, clause_key, task_proposals!inner(season_id)')
          .eq('task_proposals.season_id', sid)
          .order('proposal_id')
          .order('clause_key')
          .range(from, to),
    )
    return rows.map((r) => ({ proposal_id: r.proposal_id, clause_key: r.clause_key }))
  })
}
