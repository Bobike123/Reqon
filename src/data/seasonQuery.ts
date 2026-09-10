import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.ts'
import { useCurrentSeason } from './useCurrentSeason.ts'

// Every season-scoped read goes through here. It does three things so that no
// individual hook has to remember them:
//
//  * puts the season id in the cache key, so two seasons can never share a
//    cache entry;
//  * waits until the season is known before firing (`enabled`);
//  * hands the season id to the query so the caller cannot forget the filter.
//
// If you are adding a table that has a `season_id` column, use this. If you are
// adding one that does not (the rulebook, the roster), do not — see
// useClauses.ts and useMembers.ts.
export function useSeasonScopedQuery<TRow>(
  entity: string,
  load: (seasonId: string) => Promise<TRow>,
): UseQueryResult<TRow, Error> & { seasonId: string | undefined } {
  const season = useCurrentSeason()
  const seasonId = season.data?.id

  const result = useQuery({
    queryKey: seasonId
      ? queryKeys.seasonScoped(seasonId, entity)
      : ['season', 'unknown', entity],
    enabled: Boolean(seasonId),
    queryFn: () => load(seasonId as string),
  })

  return { ...result, seasonId } as UseQueryResult<TRow, Error> & {
    seasonId: string | undefined
  }
}
