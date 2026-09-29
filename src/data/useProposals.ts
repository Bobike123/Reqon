import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { ReviewAction } from '../proposals/proposalStates.ts'
import { submissionProblems, PROBLEM_LABEL, type NewProposal } from '../proposals/submission.ts'
import type { Proposal } from '../proposals/types.ts'
import { useSeasonId } from '../season/context.ts'
import { DataError } from '../core/errors.ts'
import { fetchAllRows, unwrap } from './errors.ts'
import type { Task } from './useTasks.ts'
import { useOptimisticListMutation } from './optimistic.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type { Proposal, ProposalState } from '../proposals/types.ts'
export type { NewProposal } from '../proposals/submission.ts'

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

export type ProposalEdit = {
  id: string
  // Editable in every unarchived state on purpose: a proposal must never become a
  // dead end because of the status it happens to be in. The stage itself is NOT
  // here — it moves only through useReviewProposal (review_proposal()).
  decision?: string | null
  ownerId?: string | null
  title?: string
  description?: string | null
  starred?: boolean
  // Reviewer edits (department Head or Developer): the database refuses to clear
  // a deadline or milestone and refuses a milestone from another season.
  dueDate?: string
  priority?: 'normal' | 'urgent'
  milestoneKey?: string
  // Developer only (guard_proposal_edit): supplies the department of an older
  // proposal that never had one.
  departmentKey?: string
}

function editColumns(edit: ProposalEdit) {
  return {
    ...(edit.decision !== undefined ? { decision: edit.decision } : {}),
    ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
    ...(edit.title !== undefined ? { title: edit.title } : {}),
    ...(edit.description !== undefined ? { context: edit.description } : {}),
    ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
    ...(edit.dueDate !== undefined ? { due_date: edit.dueDate } : {}),
    ...(edit.priority !== undefined ? { priority: edit.priority } : {}),
    ...(edit.milestoneKey !== undefined ? { milestone_key: edit.milestoneKey } : {}),
    ...(edit.departmentKey !== undefined ? { subteam_key: edit.departmentKey } : {}),
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
    if (options.tasks) void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(seasonId) })
  }
}

export function useUpdateProposal() {
  const seasonId = useSeasonId()

  return useOptimisticListMutation<Proposal, ProposalEdit>({
    queryKey: queryKeys.proposals(seasonId),
    identify: (row, edit) => row.id === edit.id,

    write: async (edit) => {
      // `decided_at` is stamped by a trigger, never sent from here.
      const { data, error } = await supabase
        .from('task_proposals')
        .update(editColumns(edit))
        .eq('id', edit.id)
        .select('id')
      // A protected-column attempt or an invariant refusal is a raised error
      // from guard_proposal_edit and surfaces exactly as thrown.
      if (error) throw new DataError('review proposals', error)
      if (data && data.length > 0) return
      // proposal_update's RLS refuses by matching no rows rather than failing.
      // Ask the database whether THIS proposal was editable by this caller, so
      // "you may not" and "it no longer exists" never read the same.
      const { data: allowed, error: askError } = await supabase.rpc('can_review_proposal', {
        p_proposal_id: edit.id,
      })
      if (askError) throw new DataError('check whether the change was saved', askError)
      if (allowed === true) {
        throw new DataError('save that change: the proposal is archived or no longer exists', null)
      }
      throw new DataError('review proposals', null, { permission: true })
    },

    apply: (rows, edit) =>
      rows.map((row) => (row.id === edit.id ? { ...row, ...editColumns(edit) } : row)),
  })
}

// review / park / reject / reopen: server-computed transitions (outcome, archive
// metadata and decided_at are stamped by the database), so the returned row is
// trusted over any local guess and the list is refetched, not patched.
export function useReviewProposal() {
  const refresh = useRefreshProposalData()
  return useMutation<Proposal, Error, { id: string; action: ReviewAction }>({
    mutationFn: async ({ id, action }) =>
      unwrap(
        'review that proposal',
        await supabase.rpc('review_proposal', { p_proposal_id: id, p_action: action }),
      ),
    onSuccess: () => refresh(),
  })
}

// Converting a proposal into a task, in one database transaction
// (promote_proposal(), 20260117): only the proposal's department Head or a
// Developer, from an open or under-review proposal, copying its department,
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
  return useMutation<void, Error, { id: string; clauseKeys: string[] }>({
    mutationFn: async ({ id, clauseKeys }) => {
      const { error } = await supabase.rpc('set_proposal_requirements', {
        p_proposal_id: id,
        p_clause_keys: clauseKeys,
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
