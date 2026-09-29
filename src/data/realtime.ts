import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/context.ts'
import { supabase } from '../lib/supabase.ts'
import { useSeasonId } from '../season/context.ts'

export type RealtimeState = 'connecting' | 'live' | 'off'

export type RealtimeChangePayload<T> = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: T | null
  old: Partial<T> | null
}

// The channel lifecycle every season-scoped live table shares: one channel per
// (table, season), filtered server-side by season_id, torn down on season
// change, sign-out or unmount, so a re-render cannot open a second identical
// subscription and a season switch cannot leave a stale one listening.
// `onChange` decides what happens to the query cache — a direct patch where
// the realtime table IS the table the screen reads (tasks, proposals), or an
// invalidation where the screen reads a VIEW the raw table payload cannot
// reconstruct (specs reads spec_verdicts, which derives `verdict` in SQL).
//
// Extracted from the original clause_status-only implementation so every
// entity shares exactly one reviewed implementation of subscribe/teardown/
// status, rather than five drifting copies of the same effect.
export function useSeasonRealtimeChannel<T>(
  table: string,
  onChange: (payload: RealtimeChangePayload<T>, seasonId: string) => void,
  // false for a table with no season_id column of its own (milestone_sections
  // — it hangs off milestone_key, not a season directly). The subscription
  // then covers every season's rows unfiltered, and onChange is responsible
  // for invalidating the smallest safe query set rather than assuming the
  // event belongs to the currently-viewed season.
  options: { filterBySeasonId?: boolean; onSubscribed?: (seasonId: string) => void } = {},
): RealtimeState {
  const filterBySeasonId = options.filterBySeasonId ?? true
  const seasonId = useSeasonId()
  const auth = useAuth()
  const userId = auth.status === 'member' ? auth.user.id : null
  // Tagged with the season it belongs to, so switching season reads as
  // 'connecting' by derivation rather than by resetting state in the effect.
  const [channel, setChannel] = useState<{ seasonId: string; status: RealtimeState } | null>(null)
  // Always the latest onChange, read without being an effect dependency —
  // the effect resubscribes only on season/user change (below), never merely
  // because a caller re-rendered with a new closure identity. Synced in its
  // own effect, not during render: writing a ref while rendering is a React
  // purity violation even though this value never affects what is returned.
  const onChangeRef = useRef(onChange)
  const onSubscribedRef = useRef(options.onSubscribed)
  useEffect(() => {
    onChangeRef.current = onChange
    onSubscribedRef.current = options.onSubscribed
  })

  useEffect(() => {
    if (!seasonId || !userId) return

    let active = true
    const realtimeChannel = supabase
      .channel(`${table}-${seasonId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          ...(filterBySeasonId ? { filter: `season_id=eq.${seasonId}` } : {}),
        },
        // Left for the SDK's own overload to infer, then narrowed here —
        // annotating the callback's parameter directly defeats overload
        // resolution against supabase-js's postgres_changes signatures.
        (payload) => {
          // removeChannel is asynchronous. A payload already queued by the old
          // channel after a season switch/unmount must not touch its old cache.
          if (active) onChangeRef.current(payload as unknown as RealtimeChangePayload<T>, seasonId)
        },
      )
      .subscribe((status: string) => {
        if (!active) return
        setChannel({
          seasonId,
          status: status === 'SUBSCRIBED' ? 'live' : status === 'CLOSED' ? 'off' : 'connecting',
        })
        // SUBSCRIBED is delivered again after a reconnect. Refetching through
        // the entity hook closes the gap while the socket was unavailable.
        if (status === 'SUBSCRIBED') onSubscribedRef.current?.(seasonId)
      })

    return () => {
      active = false
      void supabase.removeChannel(realtimeChannel)
    }
  }, [table, seasonId, userId, filterBySeasonId])

  if (!seasonId || !userId) return 'off'
  if (channel?.seasonId !== seasonId) return 'connecting'
  return channel.status
}
