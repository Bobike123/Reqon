import { useQueryClient } from '@tanstack/react-query'
import type { Proposal } from './useProposals.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

// task_proposals IS the table useProposalsForSeason reads, so the incoming
// row patches the cache directly. See useRealtimeClauseStatus.ts for the
// same shape.
export function useRealtimeProposals(): RealtimeState {
  const queryClient = useQueryClient()

  const refreshPromotionDependencies = (seasonId: string) => {
    for (const key of [
      queryKeys.tasks(seasonId),
      queryKeys.taskRequirements(seasonId),
      queryKeys.progressTasks(seasonId),
      queryKeys.attention(seasonId),
    ]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }

  return useSeasonRealtimeChannel<Proposal>('task_proposals', (payload, seasonId) => {
    const key = queryKeys.proposals(seasonId)
    // A change to a proposal can be a promotion or a repair: the requirement
    // links it cites and the task it produced live in other caches.
    void queryClient.invalidateQueries({ queryKey: queryKeys.proposalRequirements(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.archive(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
    if (payload.eventType === 'UPDATE' && payload.new?.outcome === 'approved') {
      refreshPromotionDependencies(seasonId)
    }
    queryClient.setQueryData<Proposal[]>(key, (rows) => {
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
  }, {
    onSubscribed: (seasonId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposals(seasonId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposalRequirements(seasonId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.archive(seasonId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
      refreshPromotionDependencies(seasonId)
    },
  })
}
