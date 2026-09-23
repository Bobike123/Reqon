import { useQuery, type UseQueryResult } from '@tanstack/react-query'

// Every season-scoped read goes through here. It does two things so that no
// individual hook has to remember them:
//
//  * waits until the season is known before firing (`enabled`);
//  * hands the season id to the query so the caller cannot forget the filter.
//
// The caller supplies the concrete query key (queryKeys.tasks(seasonId) and
// friends) and the season id itself — this hook does not resolve the season,
// it only wires an already-resolved (or not yet resolved) id into a query
// correctly. Resolving the season is useSeason()'s job (src/season/context.ts).
//
// If you are adding a table that has a `season_id` column, use this. If you are
// adding one that does not (the rulebook, the roster), do not — see
// useClauses.ts and useMembers.ts.
export function useSeasonScopedQuery<TRow>(
  queryKey: readonly unknown[],
  seasonId: string | undefined,
  load: (seasonId: string) => Promise<TRow>,
  // false = do not ask at all (e.g. a screen this person may not read).
  options: { enabled?: boolean } = {},
): UseQueryResult<TRow, Error> {
  return useQuery({
    queryKey,
    enabled: Boolean(seasonId) && (options.enabled ?? true),
    queryFn: () => load(seasonId as string),
  })
}
