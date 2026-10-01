import { useQueryClient } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

type TaskDependencyRow = Database['public']['Tables']['task_dependencies']['Row']

// Prerequisite links, live: someone linking or unlinking a task must reach an
// open Board or Gantt without a reload. Supabase Realtime does not reliably deliver DELETE
// events on a filtered subscription, and a removed link must reach the screen, so this listens
// to the table unfiltered and refreshes the current season's list on ANY event (the list is
// small; a patch could not tell a retry from a new link anyway).
export function useRealtimeTaskDependencies(): RealtimeState {
  const queryClient = useQueryClient()
  const refresh = (seasonId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskDependencies(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
  }
  return useSeasonRealtimeChannel<TaskDependencyRow>(
    'task_dependencies',
    (_payload, seasonId) => refresh(seasonId),
    { filterBySeasonId: false, onSubscribed: refresh },
  )
}
