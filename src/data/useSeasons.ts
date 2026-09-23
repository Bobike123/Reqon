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
  return useMutation<Season, Error, { label: string; edition: string | null }>({
    mutationFn: async ({ label, edition }) =>
      unwrap<Season>(
        'create a season',
        // Deliberately NOT current. Creating and switching are two separate,
        // reversible steps: a new season appearing does not silently move the
        // whole club onto it.
        await supabase
          .from('seasons')
          .insert({ label, edition: edition ?? undefined, is_current: false })
          .select()
          .single(),
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
