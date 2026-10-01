import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError } from '../core/errors.ts'
import { unwrap } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

export type Season = Database['public']['Tables']['seasons']['Row']

// The season LIST is not season-scoped — it is the list of seasons.
export function useSeasons(): UseQueryResult<Season[], Error> {
  return useQuery({
    queryKey: queryKeys.seasons,
    queryFn: async () =>
      unwrap('load seasons', await supabase.from('seasons').select('*').order('label')),
  })
}

export function useCreateSeason() {
  const queryClient = useQueryClient()
  return useMutation<Season, Error, { label: string; edition: string | null; copyFrom?: string | null }>({
    mutationFn: async ({ label, edition, copyFrom }) =>
      unwrap<Season>(
        'create a season',
        // start_season(): the President or a Developer only (checked by the database on this
        // path as on every other). The season is NOT current — creating and switching are two
        // separate, reversible steps — and, when copyFrom names a season, it gets that season's
        // milestone and section DEFINITIONS (no dates, tasks, statuses or measurements).
        await supabase.rpc('start_season', {
          p_label: label,
          p_edition: edition as string,
          p_regs_ref: null as unknown as string,
          p_category: null as unknown as string,
          ...(copyFrom ? { p_copy_from: copyFrom } : {}),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.seasons })
    },
  })
}

// Switching goes through the set_current_season() database function, which does
// both writes in ONE transaction and checks is_admin() itself. Doing the two
// updates from here could leave the club with no current season at all if the
// second one failed. See supabase/migrations/20260104000000_set_current_season.sql
export function useSetCurrentSeason() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (seasonId) => {
      const { error } = await supabase.rpc('set_current_season', { p_season_id: seasonId })
      if (error) throw new DataError('switch the current season', error)
    },
    onSuccess: () => {
      // Only the season list and the "which one is current" pointer need
      // refreshing. Season-scoped data does NOT need a blanket invalidation:
      // every query key already carries the season id (queryKeys.ts), so
      // switching season is switching which cache entries a component reads,
      // not a reason to mark every season's entries — including the one
      // being switched AWAY from — stale.
      void queryClient.invalidateQueries({ queryKey: queryKeys.seasons })
      void queryClient.invalidateQueries({ queryKey: queryKeys.currentSeason })
    },
  })
}
