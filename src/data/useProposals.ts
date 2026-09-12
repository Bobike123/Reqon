import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError, unwrap } from './errors.ts'
import type { Task, TaskState } from './useTasks.ts'
import { useOptimisticListMutation } from './optimistic.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type Proposal = Database['public']['Tables']['task_proposals']['Row']
export type ProposalState = Database['public']['Enums']['topic_state']

export function useProposals() {
  return useSeasonScopedQuery<Proposal[]>('task_proposals', async (seasonId) =>
    unwrap(
      'load proposals',
      await supabase
        .from('task_proposals')
        .select('*')
        .eq('season_id', seasonId)
        .order('raised_on', { ascending: false }),
    ),
  ) as UseQueryResult<Proposal[], Error> & { seasonId: string | undefined }
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
  const { seasonId } = useProposals()

  return useOptimisticListMutation<Proposal, ProposalEdit>({
    entity: 'task_proposals',
    seasonId,

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
  const { seasonId } = useProposals()

  return useMutation<{ task: Task; created: boolean }, Error, Promotion>({
    mutationFn: async ({ proposal, ownerId, dueDate, state }) => {
      if (auth.status !== 'member') {
        throw new DataError('convert proposal: not signed in as a member', null)
      }
      if (!seasonId) throw new DataError('convert proposal: no current season', null)

      const existing = unwrap<Task[]>(
        'check for an existing task from this proposal',
        await supabase.from('tasks').select('*').eq('source_proposal', proposal.id).limit(1),
      )
      if (existing.length > 0) return { task: existing[0], created: false }

      const task = unwrap<Task>(
        'convert proposal to task',
        await supabase
          .from('tasks')
          .insert({
            season_id: seasonId,
            title: proposal.title,
            detail: proposal.context,
            owner_id: ownerId ?? proposal.owner_id,
            due_date: dueDate ?? null,
            state: state ?? 'todo',
            source_proposal: proposal.id,
            created_by: auth.member.id,
          })
          .select()
          .single(),
      )

      // The proposal is now answered. Its own row records that, so the
      // suggester sees a status without having to find the task.
      const { error } = await supabase
        .from('task_proposals')
        .update({ state: 'decided', decided_at: new Date().toISOString() })
        .eq('id', proposal.id)
      if (error) throw new DataError('mark the proposal decided', error)

      return { task, created: true }
    },
    onSuccess: () => {
      if (!seasonId) return
      // Both caches move: a new task exists, and the proposal now shows as
      // converted. Invalidating only one leaves the other stale.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'tasks'),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'task_proposals'),
      })
    },
  })
}

export type NewProposal = { title: string; context?: string | null }

export function useSuggestProposal() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const { seasonId } = useProposals()

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
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'task_proposals'),
      })
    },
  })
}
