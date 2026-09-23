import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { Proposal, ProposalState } from '../proposals/types.ts'
import { useSeasonId } from '../season/context.ts'
import { DataError } from '../core/errors.ts'
import { fetchAllRows, unwrap } from './errors.ts'
import type { Task, TaskState } from './useTasks.ts'
import { useOptimisticListMutation } from './optimistic.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type { Proposal, ProposalState } from '../proposals/types.ts'

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
  state?: ProposalState
  // Editable in every state on purpose: a proposal must never become a dead end
  // because of the status it happens to be in.
  decision?: string | null
  ownerId?: string | null
  title?: string
  starred?: boolean
}

export function useUpdateProposal() {
  const seasonId = useSeasonId()

  return useOptimisticListMutation<Proposal, ProposalEdit>({
    queryKey: queryKeys.proposals(seasonId),
    identify: (row, edit) => row.id === edit.id,

    write: async (edit) => {
      // `decided_at` is stamped by the trg_proposal_decided trigger, not here.
      const { data, error } = await supabase
        .from('task_proposals')
        .update({
          ...(edit.state !== undefined ? { state: edit.state } : {}),
          ...(edit.decision !== undefined ? { decision: edit.decision } : {}),
          ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
          ...(edit.title !== undefined ? { title: edit.title } : {}),
          ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
        })
        .eq('id', edit.id)
        .select('id')
      if (error) throw new DataError('review proposals', error)
      if (data && data.length > 0) return
      // Since 20260108 only an administrator may change a proposal, and RLS
      // refuses by matching no rows rather than failing. Without this check a
      // member's edit would look saved, then reappear on the next read.
      const { data: admin, error: askError } = await supabase.rpc('is_admin')
      if (askError) throw new DataError('check whether the change was saved', askError)
      if (admin === true) {
        throw new DataError('save that change: the proposal no longer exists', null)
      }
      throw new DataError('review proposals', null, { permission: true })
    },

    apply: (rows, edit) =>
      rows.map((row) =>
        row.id === edit.id
          ? {
              ...row,
              ...(edit.state !== undefined ? { state: edit.state } : {}),
              ...(edit.decision !== undefined ? { decision: edit.decision } : {}),
              ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
              ...(edit.title !== undefined ? { title: edit.title } : {}),
              ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
            }
          : row,
      ),
  })
}

// Converting a proposal into a task. The task carries `source_proposal` so the board
// can always answer "where did this come from?" three months later.
//
// Idempotent on purpose: if a task already points at this proposal, the existing
// one is returned instead of creating a second. That makes a double-click, a
// double-submit, or a retry after a flaky response harmless. The UI also
// disables the button while the mutation is in flight, but that alone would not
// survive a reload-and-click-again.
// What the promoter decides at the moment of promotion. Everything is optional
// except the proposal: the club often does not yet know a date or an owner, and
// inventing one is worse than leaving it empty.
export type Promotion = {
  proposal: Proposal
  ownerId?: string | null
  dueDate?: string | null
  state?: TaskState
}

export function usePromoteProposal() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()

  return useMutation<{ task: Task; created: boolean }, Error, Promotion>({
    mutationFn: async ({ proposal, ownerId, dueDate, state }) => {
      if (auth.status !== 'member') {
        throw new DataError('convert proposal: not signed in as a member', null)
      }
      if (!seasonId) throw new DataError('convert proposal: no current season', null)

      // One transaction in the database (promote_proposal(),
      // 20260110000000_atomic_proposal_promotion.sql): the existence check,
      // the insert and marking the proposal decided used to be three separate
      // round trips from here, which could land a task with no matching
      // "decided" proposal if the connection dropped in between, or create
      // two tasks for one proposal under a genuine race. The function is
      // idempotent — promoting an already-promoted proposal again returns the
      // existing task with created = false rather than erroring.
      const rows = unwrap<{ task: Task; created: boolean }[]>(
        'convert proposal to task',
        await supabase.rpc('promote_proposal', {
          p_proposal_id: proposal.id,
          p_season_id: seasonId,
          p_owner_id: ownerId ?? proposal.owner_id ?? null,
          p_due_date: dueDate ?? null,
          p_state: state ?? 'todo',
        }),
      )
      const result = rows[0]
      if (!result) throw new DataError('convert proposal to task: no row returned', null)
      return result
    },
    onSuccess: () => {
      if (!seasonId) return
      // Both caches move: a new task exists, and the proposal now shows as
      // converted. Invalidating only one leaves the other stale.
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(seasonId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposals(seasonId) })
    },
  })
}

export type NewProposal = { title: string; context?: string | null }

export function useSuggestProposal() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()

  return useMutation<Proposal, Error, NewProposal>({
    mutationFn: async (proposal) => {
      if (auth.status !== 'member') {
        throw new DataError('raise proposal: not signed in as a member', null)
      }
      if (!seasonId) throw new DataError('raise proposal: no current season', null)

      return unwrap(
        'raise proposal',
        await supabase
          .from('task_proposals')
          .insert({
            season_id: seasonId,
            title: proposal.title,
            context: proposal.context ?? null,
            // proposals records its author in raised_by.
            raised_by: auth.member.id,
          })
          .select()
          .single(),
      )
    },
    onSuccess: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposals(seasonId) })
    },
  })
}
