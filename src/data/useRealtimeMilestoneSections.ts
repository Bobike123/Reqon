import { useQueryClient } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import type { Milestone } from '../milestones/types.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

type MilestoneSectionRow = Database['public']['Tables']['milestone_sections']['Row']

// milestone_sections has no season_id of its own — it hangs off milestone_key
// (see useMilestoneSectionsForSeason, useMilestones.ts). The subscription is
// therefore unfiltered by season (options.filterBySeasonId: false). Phase 11
// gives DELETE payloads the old milestone_key through replica identity FULL.
// When the current season's milestone list is cached, use it to reject a late
// event from another season; without that parent cache, invalidating is the
// conservative choice and the query itself still applies the correct keys.
export function useRealtimeMilestoneSections(): RealtimeState {
  const queryClient = useQueryClient()

  const refresh = (seasonId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.milestoneSections(seasonId) })
  }

  return useSeasonRealtimeChannel<MilestoneSectionRow>(
    'milestone_sections',
    (payload, seasonId) => {
      const milestoneKey = payload.new?.milestone_key ?? payload.old?.milestone_key
      const milestones = queryClient.getQueryData<Milestone[]>(queryKeys.milestones(seasonId))
      if (milestoneKey && milestones && !milestones.some((row) => row.key === milestoneKey)) return
      refresh(seasonId)
    },
    { filterBySeasonId: false, onSubscribed: refresh },
  )
}
