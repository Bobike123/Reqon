import { useQueryClient } from '@tanstack/react-query'
import type { Database } from '../lib/database.types.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

type ProposalRequirementRow = Database['public']['Tables']['proposal_requirements']['Row']

// Requirement edits do not necessarily update the proposal row. Listen to the
// season-stamped junction directly so another reviewer's add/remove reaches an
// open proposal dialog, including DELETE events.
export function useRealtimeProposalRequirements(): RealtimeState {
  const queryClient = useQueryClient()
  const refresh = (seasonId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.proposalRequirements(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
  }
  return useSeasonRealtimeChannel<ProposalRequirementRow>(
    'proposal_requirements',
    (_payload, seasonId) => refresh(seasonId),
    { onSubscribed: refresh },
  )
}
