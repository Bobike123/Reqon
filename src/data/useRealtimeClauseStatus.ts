import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import type { ClauseStatus } from './useClauseStatus.ts'
import { queryKeys } from './queryKeys.ts'
import { useCurrentSeason } from './useCurrentSeason.ts'

export type RealtimeState = 'connecting' | 'live' | 'off'

// Two people editing the same register should see each other. Rather than
// re-fetching 1,146 rows whenever anyone touches anything, the change itself is
// patched into the cache — the payload already contains the new row.
//
// One channel per season, torn down when the season changes, when the user
// signs out, or when the screen unmounts. The channel name is derived from the
// season so a re-render cannot open a second identical subscription.
export function useRealtimeClauseStatus(): RealtimeState {
  const queryClient = useQueryClient()
  const { data: season } = useCurrentSeason()
  const auth = useAuth()
  const seasonId = season?.id
  const userId = auth.status === 'member' ? auth.user.id : null
  // Tagged with the season it belongs to, so switching season reads as
  // 'connecting' by derivation rather than by resetting state in the effect.
  const [channel, setChannel] = useState<{ seasonId: string; status: RealtimeState } | null>(null)

  useEffect(() => {
    if (!seasonId || !userId) return

    const key = queryKeys.seasonScoped(seasonId, 'clause_status')

    const realtimeChannel = supabase
      .channel(`clause-status-${seasonId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'clause_status',
          filter: `season_id=eq.${seasonId}`,
        },
        (payload) => {
          queryClient.setQueryData<ClauseStatus[]>(key, (rows) => {
            if (!rows) return rows
            const incoming = payload.new as ClauseStatus | null
            const removed = payload.old as { id?: string } | null

            if (payload.eventType === 'DELETE') {
              return removed?.id ? rows.filter((row) => row.id !== removed.id) : rows
            }
            if (!incoming?.clause_key) return rows

            const index = rows.findIndex((row) => row.clause_key === incoming.clause_key)
            if (index === -1) return [...rows, incoming]
            // Keep the array order stable so the list does not jump under
            // someone who is reading it.
            return rows.map((row, i) => (i === index ? incoming : row))
          })
        },
      )
      .subscribe((status) => {
        setChannel({
          seasonId,
          status: status === 'SUBSCRIBED' ? 'live' : status === 'CLOSED' ? 'off' : 'connecting',
        })
      })

    return () => {
      void supabase.removeChannel(realtimeChannel)
    }
  }, [seasonId, userId, queryClient])

  if (!seasonId || !userId) return 'off'
  if (channel?.seasonId !== seasonId) return 'connecting'
  return channel.status
}
