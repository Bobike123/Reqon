import { useQueryClient } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

type MilestoneSectionRow = Database['public']['Tables']['milestone_sections']['Row']

// milestone_sections has no season_id of its own — it hangs off milestone_key
// (see useMilestoneSectionsForSeason, useMilestones.ts). The subscription is
// therefore unfiltered by season (options.filterBySeasonId: false) and every
// event invalidates the CURRENT season's milestoneSections cache entry only —
// the smallest safe query set available without a join back to milestones,
// per Phase 5 §5.3. An event from a different season invalidates a query
// nobody is reading right now, which costs one unread refetch, not a wrong
// screen.
export function useRealtimeMilestoneSections(): RealtimeState {
  const queryClient = useQueryClient()

  return useSeasonRealtimeChannel<MilestoneSectionRow>(
    'milestone_sections',
    (_payload, seasonId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.milestoneSections(seasonId) })
    },
    { filterBySeasonId: false },
  )
}
