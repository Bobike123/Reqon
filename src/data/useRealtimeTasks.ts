import { useQueryClient } from '@tanstack/react-query'
import type { Task } from './useTasks.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

// The Board, live across everyone working it during a session. tasks IS the
// table useTasksForSeason reads, so the incoming row patches the cache
// directly — see useRealtimeClauseStatus.ts for the same shape, and
// useRealtimeSpecs.ts for the case where that is NOT true.
export function useRealtimeTasks(): RealtimeState {
  const queryClient = useQueryClient()

  return useSeasonRealtimeChannel<Task>('tasks', (payload, seasonId) => {
    const key = queryKeys.tasks(seasonId)
    queryClient.setQueryData<Task[]>(key, (rows) => {
      if (!rows) return rows
      if (payload.eventType === 'DELETE') {
        const removedId = payload.old?.id
        return removedId ? rows.filter((row) => row.id !== removedId) : rows
      }
      const incoming = payload.new
      if (!incoming?.id) return rows

      const index = rows.findIndex((row) => row.id === incoming.id)
      if (index === -1) return [...rows, incoming]
      return rows.map((row, i) => (i === index ? incoming : row))
    })
  })
}
