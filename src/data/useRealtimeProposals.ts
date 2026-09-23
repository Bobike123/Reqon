import { useQueryClient } from '@tanstack/react-query'
import type { Proposal } from './useProposals.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

// task_proposals IS the table useProposalsForSeason reads, so the incoming
// row patches the cache directly. See useRealtimeClauseStatus.ts for the
// same shape.
export function useRealtimeProposals(): RealtimeState {
  const queryClient = useQueryClient()

  return useSeasonRealtimeChannel<Proposal>('task_proposals', (payload, seasonId) => {
    const key = queryKeys.proposals(seasonId)
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
  })
}
