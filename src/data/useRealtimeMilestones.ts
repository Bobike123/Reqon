import { useQueryClient } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

type MilestoneRow = Database['public']['Tables']['milestones']['Row']

// Milestone dates feed the timeline, deadline summaries and Now. The raw row
// is not patched: every consumer shares the ordered season query, and a
// reconnect must close any gap while the channel was unavailable.
export function useRealtimeMilestones(): RealtimeState {
  const queryClient = useQueryClient()
  const refresh = (seasonId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.milestones(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.attention(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
  }
  return useSeasonRealtimeChannel<MilestoneRow>(
    'milestones',
    (_payload, seasonId) => refresh(seasonId),
    { onSubscribed: refresh },
  )
}
