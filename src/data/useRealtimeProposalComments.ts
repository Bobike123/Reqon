import { useQueryClient } from '@tanstack/react-query'
import type { ProposalComment } from './useProposals.ts'
import { queryKeys } from './queryKeys.ts'
import { type RealtimeState, useSeasonRealtimeChannel } from './realtime.ts'

// Discussion rows are append-only and do not touch task_proposals, so they
// need their own channel for another member's comment to reach an open dialog.
export function useRealtimeProposalComments(): RealtimeState {
  const queryClient = useQueryClient()
  const refresh = (seasonId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.proposalComments(seasonId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityAll(seasonId) })
  }
  return useSeasonRealtimeChannel<ProposalComment>(
    'proposal_comments',
    (_payload, seasonId) => refresh(seasonId),
    { onSubscribed: refresh },
  )
}
