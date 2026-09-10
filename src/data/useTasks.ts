import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError, unwrap } from './errors.ts'
import { useOptimisticListMutation } from './optimistic.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type Task = Database['public']['Tables']['tasks']['Row']
export type TaskState = Database['public']['Enums']['task_state']

export function useTasks() {
  return useSeasonScopedQuery<Task[]>('tasks', async (seasonId) =>
    unwrap(
      'load tasks',
      await supabase
        .from('tasks')
        .select('*')
        .eq('season_id', seasonId)
        .order('created_at', { ascending: false }),
    ),
  ) as UseQueryResult<Task[], Error> & { seasonId: string | undefined }
}

export type TaskEdit = {
  id: string
  state?: TaskState
  ownerId?: string | null
  title?: string
  dueDate?: string | null
  starred?: boolean
}

// Editing an existing task: optimistic, because the row is already in the cache
// and can be restored byte for byte if the write fails.
export function useUpdateTask() {
  const { seasonId } = useTasks()

  return useOptimisticListMutation<Task, TaskEdit>({
    entity: 'tasks',
    seasonId,

    write: async (edit) => {
      // `tasks` has no updated_by column, so there is nothing to stamp here.
      // Do not invent one — see useClauseStatus for a table that does.
      const { error } = await supabase
        .from('tasks')
        .update({
          ...(edit.state !== undefined ? { state: edit.state } : {}),
          ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
          ...(edit.title !== undefined ? { title: edit.title } : {}),
          ...(edit.dueDate !== undefined ? { due_date: edit.dueDate } : {}),
          ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
        })
        .eq('id', edit.id)
      if (error) throw new DataError('update task', error)
    },

    apply: (rows, edit) =>
      rows.map((row) =>
        row.id === edit.id
          ? {
              ...row,
              ...(edit.state !== undefined ? { state: edit.state } : {}),
              ...(edit.ownerId !== undefined ? { owner_id: edit.ownerId } : {}),
              ...(edit.title !== undefined ? { title: edit.title } : {}),
              ...(edit.dueDate !== undefined ? { due_date: edit.dueDate } : {}),
              ...(edit.starred !== undefined ? { starred: edit.starred } : {}),
            }
          : row,
      ),
  })
}

export type NewTask = {
  title: string
  detail?: string | null
  ownerId?: string | null
  subteamKey?: string | null
  dueDate?: string | null
  state?: TaskState
  sourceTopic?: string | null
}

// Creating a task is NOT optimistic. The server assigns the id, and inventing a
// placeholder one only to swap it out later is more machinery than a spinner is
// worth. Errors still surface through the mutation's `error`.
export function useCreateTask() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const { seasonId } = useTasks()

  return useMutation<Task, Error, NewTask>({
    mutationFn: async (task) => {
      if (auth.status !== 'member') {
        throw new DataError('create task: not signed in as a member', null)
      }
      if (!seasonId) throw new DataError('create task: no current season', null)

      return unwrap(
        'create task',
        await supabase
          .from('tasks')
          .insert({
            season_id: seasonId,
            title: task.title,
            detail: task.detail ?? null,
            owner_id: task.ownerId ?? null,
            subteam_key: task.subteamKey ?? null,
            due_date: task.dueDate ?? null,
            state: task.state ?? 'todo',
            source_topic: task.sourceTopic ?? null,
            // tasks records its author in created_by (there is no updated_by).
            created_by: auth.member.id,
          })
          .select()
          .single(),
      )
    },
    onSuccess: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({
        queryKey: queryKeys.seasonScoped(seasonId, 'tasks'),
      })
    },
  })
}
