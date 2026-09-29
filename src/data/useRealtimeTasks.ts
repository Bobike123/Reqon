import { useQueryClient } from '@tanstack/react-query'
import type { Task } from './useTasks.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

// The Board, live across everyone working it during a session. The cache this
// patches is the ACTIVE task list (archived_at IS NULL), so an incoming row is
// judged against that rule rather than copied in:
//
//   * an archived row leaves the active list (and the archive, progress and
//     requirement views are refreshed);
//   * a row already in the list is replaced, so an owner, department or state
//     change is re-evaluated by whatever filter is showing;
//   * a row the list does not hold (a restore, a new promotion, one this client
//     never loaded) is NOT blindly inserted — the list is refetched instead, so
//     it can only ever contain what the active query itself returns.
export function useRealtimeTasks(): RealtimeState {
  const queryClient = useQueryClient()

  const refreshDerived = (seasonId: string) => {
    for (const key of [
      queryKeys.archive(seasonId),
      queryKeys.progressTasks(seasonId),
      queryKeys.taskRequirements(seasonId),
      queryKeys.attention(seasonId),
      queryKeys.activityAll(seasonId),
    ]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }

  return useSeasonRealtimeChannel<Task>('tasks', (payload, seasonId) => {
    const key = queryKeys.tasks(seasonId)

    if (payload.eventType === 'DELETE') {
      const removedId = payload.old?.id
      if (removedId) queryClient.setQueryData<Task[]>(key, (rows) => rows?.filter((row) => row.id !== removedId))
      refreshDerived(seasonId)
      return
    }
    const incoming = payload.new
    if (!incoming?.id) return

    if (incoming.archived_at) {
      queryClient.setQueryData<Task[]>(key, (rows) => rows?.filter((row) => row.id !== incoming.id))
      refreshDerived(seasonId)
      return
    }

    const known = queryClient.getQueryData<Task[]>(key)?.some((row) => row.id === incoming.id)
    if (known) {
      queryClient.setQueryData<Task[]>(key, (rows) => rows?.map((row) => (row.id === incoming.id ? incoming : row)))
    } else {
      void queryClient.invalidateQueries({ queryKey: key })
    }
    // A restore leaves the archive; a promotion adds requirement links.
    refreshDerived(seasonId)
  }, {
    onSubscribed: (seasonId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(seasonId) })
      refreshDerived(seasonId)
    },
  })
}
