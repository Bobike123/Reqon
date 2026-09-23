import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { useSeasonId } from '../season/context.ts'
import { DataError } from '../core/errors.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'
import { useSeasonScopedQuery } from './seasonQuery.ts'

export type HandoverNote = Database['public']['Tables']['handover_notes']['Row']

// One row per (season, subteam) — the schema's own unique key, so writes are an
// upsert on that pair. This is the only notes store; do not add another.
export function useHandoverNotesForSeason(seasonId: string | undefined): UseQueryResult<HandoverNote[], Error> {
  return useSeasonScopedQuery<HandoverNote[]>(queryKeys.handoverNotes(seasonId), seasonId, async (sid) =>
    unwrap('load handover notes', await supabase.from('handover_notes').select('*').eq('season_id', sid)),
  )
}

export function useHandoverNotes(): UseQueryResult<HandoverNote[], Error> {
  return useHandoverNotesForSeason(useSeasonId())
}

export function useSetHandoverNote() {
  const queryClient = useQueryClient()
  const seasonId = useSeasonId()
  return useMutation<void, Error, { subteamKey: string; body: string; memberId: string }>({
    mutationFn: async ({ subteamKey, body, memberId }) => {
      if (!seasonId) throw new DataError('save handover note: no current season', null)
      const { error } = await supabase.from('handover_notes').upsert(
        { season_id: seasonId, subteam_key: subteamKey, body, updated_by: memberId },
        { onConflict: 'season_id,subteam_key' },
      )
      if (error) throw new DataError('save that handover note', error)
    },
    onSettled: () => {
      if (!seasonId) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.handoverNotes(seasonId) })
    },
  })
}
