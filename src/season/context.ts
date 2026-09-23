import { createContext, useContext } from 'react'
import type { Season } from '../data/useCurrentSeason.ts'

export type { Season }

// The current season, made explicit. Before this, every season-scoped hook
// asked useCurrentSeason() itself and treated anything that was not a row as
// the same blank moment — a slow network, an empty seasons table and a
// genuinely broken query all rendered as "no data yet". They are not the
// same thing, and a screen that cannot tell them apart shows 0 tasks when the
// real story is "the season query failed".
export type SeasonState =
  // The current-season query has not resolved yet. Never render a
  // season-scoped screen's own "0 tasks" here — show a loading state instead.
  | { status: 'loading' }
  // Resolved, and a season is current.
  | { status: 'ready'; season: Season; seasonId: string }
  // Resolved: the query succeeded and simply found no current season (a fresh
  // project, or one where nobody has picked a season yet). Not an error.
  | { status: 'no-current-season' }
  // The query itself failed — a network drop, a permission problem, anything
  // that is not "there is no current season". Distinct from no-current-season
  // on purpose: one is fixed in Settings, the other by trying again.
  | { status: 'failed'; error: Error }

export type SeasonContextValue = SeasonState & {
  // Safe to call in any state. Re-asks the database; a no-op while already
  // loading.
  retry: () => void
}

export const SeasonContext = createContext<SeasonContextValue | null>(null)

// The one place every season-scoped hook and every season-gated route reads
// from — see SeasonProvider.tsx for where the state comes from, and
// SeasonGate.tsx for the screen boundary built on it.
export function useSeason(): SeasonContextValue {
  const value = useContext(SeasonContext)
  if (!value) {
    throw new Error('useSeason must be used inside <SeasonProvider>.')
  }
  return value
}

// The common case for a season-scoped query or mutation: the id when the
// season is ready, undefined otherwise — exactly what an `enabled` guard or a
// "no current season" DataError already expects. Prefer this over
// destructuring `status`/`season` yourself unless a hook genuinely needs to
// tell loading apart from failed apart from no-current-season (SeasonGate,
// mostly).
export function useSeasonId(): string | undefined {
  const season = useSeason()
  return season.status === 'ready' ? season.seasonId : undefined
}
