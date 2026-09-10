import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { unwrapMaybe } from './errors.ts'
import { queryKeys } from './queryKeys.ts'

export type Season = Database['public']['Views']['v_current_season']['Row']

// The one place that decides which season the app is looking at. The database
// owns the answer (`seasons.is_current`, surfaced by v_current_season), so
// nothing in React has to agree about it.
//
// Do not read `season_id` from anywhere else and do not pass it down through
// props — use the season-scoped hooks, which take it from here.
export function useCurrentSeason(): UseQueryResult<Season | null, Error> {
  return useQuery({
    queryKey: queryKeys.currentSeason,
    queryFn: async () =>
      unwrapMaybe(
        'load current season',
        await supabase.from('v_current_season').select('*').maybeSingle(),
      ),
    // The current season changes roughly once a year. Re-fetching it on every
    // window focus is pure noise.
    staleTime: 5 * 60 * 1000,
  })
}
