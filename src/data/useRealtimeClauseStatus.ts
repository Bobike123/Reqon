import { useQueryClient } from '@tanstack/react-query'
import type { ClauseStatus } from './useClauseStatus.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

export type { RealtimeState }

// Two people editing the same register should see each other. Rather than
// re-fetching 1,146 rows whenever anyone touches anything, the change itself is
// patched into the cache — the payload already contains the new row. See
// realtime.ts for the shared subscribe/teardown/status plumbing.
export function useRealtimeClauseStatus(): RealtimeState {
  const queryClient = useQueryClient()

  const refresh = (seasonId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.clauseStatus(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.attention(seasonId) })
  }

  return useSeasonRealtimeChannel<ClauseStatus>('clause_status', (payload, seasonId) => {
    const key = queryKeys.clauseStatus(seasonId)
    queryClient.setQueryData<ClauseStatus[]>(key, (rows) => {
      if (!rows) return rows
      if (payload.eventType === 'DELETE') {
        const removedId = payload.old?.id
        return removedId ? rows.filter((row) => row.id !== removedId) : rows
      }
      const incoming = payload.new
      if (!incoming?.clause_key) return rows

      const index = rows.findIndex((row) => row.clause_key === incoming.clause_key)
      if (index === -1) return [...rows, incoming]
      // Keep the array order stable so the list does not jump under someone
      // who is reading it.
      return rows.map((row, i) => (i === index ? incoming : row))
    })
    void queryClient.invalidateQueries({ queryKey: queryKeys.attention(seasonId) })
  }, { onSubscribed: refresh })
}
