import { useMemo, type ReactNode } from 'react'
import { useCurrentSeason } from '../data/useCurrentSeason.ts'
import { SeasonContext, type SeasonContextValue } from './context.ts'

// Turns the current-season query into the explicit SeasonState every
// season-scoped hook and every season-gated route reads (see context.ts).
// One useCurrentSeason() call here, not one per consumer — a season-scoped
// list hook used to instantiate its OWN query just to read a season id off
// it; a mutation hook reading useSeason() reads this same resolved value
// instead, which is what makes "receive season identity from the dedicated
// season boundary, not a list query" (see useTasks.ts and friends) possible.
export function SeasonProvider({ children }: { children: ReactNode }) {
  const query = useCurrentSeason()
  const refetch = query.refetch

  const value = useMemo<SeasonContextValue>(() => {
    const retry = () => void refetch()
    if (query.isError) return { status: 'failed', error: query.error, retry }
    if (query.isPending) return { status: 'loading', retry }
    // v_current_season's generated type marks every column nullable (it is a
    // view, so Postgres does not carry the base table's NOT NULL forward) —
    // a row with no id cannot really happen (seasons.id is a not-null
    // primary key), but the type does not know that, so it is treated the
    // same as "no current season" rather than asserted away.
    if (query.data?.id) return { status: 'ready', season: query.data, seasonId: query.data.id, retry }
    return { status: 'no-current-season', retry }
  }, [query.isPending, query.isError, query.error, query.data, refetch])

  return <SeasonContext.Provider value={value}>{children}</SeasonContext.Provider>
}
