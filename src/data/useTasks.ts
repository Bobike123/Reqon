import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
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

// Deleting a board task: president or developer only (task_delete calls
// can_delete_records()). RLS makes a refused DELETE match no rows instead of
// failing, so when nothing was removed the database is asked whether this
// caller may delete at all — "not allowed" and "someone else already deleted
// it" must not read the same.
async function mayDeleteRecords(): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_delete_records')
  if (error) throw new DataError('check whether the task was deleted', error)
  return data === true
}

export function useDeleteTask() {
  const queryClient = useQueryClient()
  const { seasonId } = useTasks()

  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const { data, error } = await supabase.from('tasks').delete().eq('id', id).select('id')
      if (error) throw new DataError('delete tasks', error)
      if (data && data.length > 0) return
      // Already gone is the outcome that was wanted.
      if (await mayDeleteRecords()) return
      throw new DataError('delete tasks', null, { permission: true })
    },
    onSettled: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.seasonScoped(seasonId, 'tasks') })
    },
  })
}
