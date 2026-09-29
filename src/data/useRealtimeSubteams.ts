import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import { queryKeys } from './queryKeys.ts'
import type { RealtimeState } from './realtime.ts'

// Departments are global reference data, not season-scoped, so this does not
// reuse useSeasonRealtimeChannel (data/realtime.ts): that hook ties its
// whole subscription lifecycle to a resolved season id, which would make a
// Head/archive change invisible whenever the season is still loading, or
// tear the channel down on every season switch for data that has nothing to
// do with seasons. It otherwise follows the exact same shape — including
// deriving "connecting" at render time (below) rather than setting it
// synchronously inside the effect — so the two hooks stay obviously
// consistent to read side by side.
//
// Invalidate rather than patch: the department list is small (at most 10
// active plus however many archived), Settings and any future consumer
// already refetch it cheaply, and a patch would have to duplicate the
// server's own row shape for every possible change (archive, restore,
// rename, head, reorder) for no real benefit at this size.
export function useRealtimeSubteams(): RealtimeState {
  const queryClient = useQueryClient()
  const auth = useAuth()
  const userId = auth.status === 'member' ? auth.user.id : null
  // Tagged with the user it belongs to, mirroring useSeasonRealtimeChannel's
  // seasonId tag: a sign-out/sign-in swap reads as 'connecting' by
  // derivation below rather than an extra setState in the effect.
  const [channel, setChannel] = useState<{ userId: string; status: RealtimeState } | null>(null)

  useEffect(() => {
    if (!userId) return

    let active = true
    const realtimeChannel = supabase
      .channel(`subteams-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'subteams' },
        () => {
          if (active) void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
        },
      )
      .subscribe((status: string) => {
        if (!active) return
        setChannel({
          userId,
          status: status === 'SUBSCRIBED' ? 'live' : status === 'CLOSED' ? 'off' : 'connecting',
        })
        // SUBSCRIBED also follows reconnect, so close any gap while the socket
        // was unavailable instead of assuming no department/Head changed.
        if (status === 'SUBSCRIBED') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.subteams })
        }
      })

    return () => {
      active = false
      void supabase.removeChannel(realtimeChannel)
    }
  }, [userId, queryClient])

  if (!userId) return 'off'
  if (channel?.userId !== userId) return 'connecting'
  return channel.status
}
