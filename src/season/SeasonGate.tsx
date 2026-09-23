import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../ui/states.tsx'
import { useSeason } from './context.ts'

// Wraps every season-scoped route (see App.tsx). A page inside never has to
// ask "do I even have a season yet?" — if SeasonGate renders its children at
// all, the season is ready, so an empty task list genuinely means the season
// has zero tasks, not that the season itself never resolved. That is the
// whole gate this closes: a loading or failed season query used to render
// exactly like an empty one, in every season-scoped screen at once.
export function SeasonGate({ children }: { children: ReactNode }) {
  const season = useSeason()

  if (season.status === 'loading') {
    return <LoadingState label="Loading the current season…" />
  }

  if (season.status === 'failed') {
    return (
      <ErrorState title="Could not load the current season" error={season.error} onRetry={season.retry} />
    )
  }

  if (season.status === 'no-current-season') {
    return (
      <EmptyState title="No current season">
        The club has not started a season yet, or none is set as current.{' '}
        <Link to="/settings" className="font-medium text-slate-900 underline underline-offset-2">
          Go to Settings
        </Link>{' '}
        to start or switch one.
      </EmptyState>
    )
  }

  return <>{children}</>
}
