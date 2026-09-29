import { useQueryClient } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

type TaskRequirementRow = Database['public']['Tables']['task_requirements']['Row']

// Requirement links, live: someone linking or unlinking a task from the Board
// (or a promotion adding links) must reach an open Register without a reload.
//
// Phase 11 stores and checks season_id on the junction itself, so INSERT and
// DELETE can both be filtered server-side (replica identity is FULL). This is
// an invalidation, not a patch: the Register's aggregate needs task rows too.
export function useRealtimeTaskRequirements(): RealtimeState {
  const queryClient = useQueryClient()
  const refresh = (seasonId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskRequirements(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
  }
  return useSeasonRealtimeChannel<TaskRequirementRow>(
    'task_requirements',
    (_payload, seasonId) => refresh(seasonId),
    { onSubscribed: refresh },
  )
}
