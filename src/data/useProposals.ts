import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError, unwrap } from './errors.ts'
import type { Task } from './useTasks.ts'
import { useOptimisticListMutation } from './optimistic.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type Topic = Database['public']['Tables']['topics']['Row']
export type TopicState = Database['public']['Enums']['topic_state']

export function useTopics() {
  return useSeasonScopedQuery<Topic[]>('topics', async (seasonId) =>
    unwrap(
      'load topics',
      await supabase
        .from('topics')
        .select('*')
        .eq('season_id', seasonId)
        .order('raised_on', { ascending: false }),
    ),
  ) as UseQueryResult<Topic[], Error> & { seasonId: string | undefined }
}

export type TopicEdit = {
  id: string
  state?: TopicState
  // Editable in every state on purpose: a topic must never become a dead end
  // because of the status it happens to be in.
  decision?: string | null
  ownerId?: string | null
  title?: string
  starred?: boolean
}

export function useUpdateTopic() {
  const { seasonId } = useTopics()

  return useOptimisticListMutation<Topic, TopicEdit>({
    entity: 'topics',
    seasonId,

    write: async (edit) => {
      // `decided_at` is stamped by the trg_topic_decided trigger, not here.
      const { error } = await supabase
        .from('topics')
        .update({
          ...(edit.state !== undefined ? { state: edit.state } : {}),
          ...(edit.decision !== undefined ? { decision: edit.decision } : {}),
          ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
          ...(edit.title !== undefined ? { title: edit.title } : {}),
          ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
        })
        .eq('id', edit.id)
      if (error) throw new DataError('update topic', error)
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

// Converting a topic into a task. The task carries `source_topic` so the board
// can always answer "where did this come from?" three months later.
//
// Idempotent on purpose: if a task already points at this topic, the existing
// one is returned instead of creating a second. That makes a double-click, a
// double-submit, or a retry after a flaky response harmless. The UI also
// disables the button while the mutation is in flight, but that alone would not
// survive a reload-and-click-again.
export function useConvertTopicToTask() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const { seasonId } = useTopics()

  return useMutation<{ task: Task; created: boolean }, Error, Topic>({
    mutationFn: async (topic) => {
      if (auth.status !== 'member') {
        throw new DataError('convert topic: not signed in as a member', null)
      }
      if (!seasonId) throw new DataError('convert topic: no current season', null)

      const existing = unwrap<Task[]>(
        'check for an existing task from this topic',
        await supabase.from('tasks').select('*').eq('source_topic', topic.id).limit(1),
      )
      if (existing.length > 0) return { task: existing[0], created: false }

      const task = unwrap<Task>(
        'convert topic to task',
        await supabase
          .from('tasks')
          .insert({
            season_id: seasonId,
            title: topic.title,
            detail: topic.context,
            owner_id: topic.owner_id,
            state: 'todo',
            source_topic: topic.id,
            created_by: auth.member.id,
          })
          .select()
          .single(),
      )
      return { task, created: true }
    },
    onSuccess: () => {
      if (!seasonId) return
      // Both caches move: a new task exists, and the topic now shows as
      // converted. Invalidating only one leaves the other stale.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'tasks'),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'topics'),
      })
    },
  })
}

export type NewTopic = { title: string; context?: string | null }

export function useCreateTopic() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const { seasonId } = useTopics()

  return useMutation<Topic, Error, NewTopic>({
    mutationFn: async (topic) => {
      if (auth.status !== 'member') {
        throw new DataError('raise topic: not signed in as a member', null)
      }
      if (!seasonId) throw new DataError('raise topic: no current season', null)

      return unwrap(
        'raise topic',
        await supabase
          .from('topics')
          .insert({
            season_id: seasonId,
            title: topic.title,
            context: topic.context ?? null,
            // topics records its author in raised_by.
            raised_by: auth.member.id,
          })
          .select()
          .single(),
      )
    },
    onSuccess: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'topics'),
      })
    },
  })
}
