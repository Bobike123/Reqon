import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { queryKeys } from '../data/queryKeys.ts'
import { useClauses } from '../data/useClauses.ts'
import { useCurrentSeason } from '../data/useCurrentSeason.ts'
import { useTasks } from '../data/useTasks.ts'

// A deliberately plain list used to measure the Phase 3 performance gate before
// the real Register exists. No grouping, no filters, no styling beyond what is
// needed to make it scroll — this is a measuring stick, not a screen.
export default function Diagnostics() {
  const { data, isLoading, error, dataUpdatedAt } = useClauses()
  const season = useCurrentSeason()
  const tasks = useTasks()
  const queryClient = useQueryClient()
  const startedAt = useRef<number | null>(null)
  const [loadMs, setLoadMs] = useState<number | null>(null)

  // Clock starts when the screen mounts, not during render — reading
  // performance.now() in the render body is an impure call.
  useEffect(() => {
    startedAt.current ??= performance.now()
  }, [])

  useEffect(() => {
    if (data && loadMs === null && startedAt.current !== null) {
      setLoadMs(Math.round(performance.now() - startedAt.current))
    }
  }, [data, loadMs])

  // Lets the benchmark harness re-run a cold load from the browser console.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__reloadClauses = async () => {
      queryClient.removeQueries({ queryKey: queryKeys.clauses })
      const t0 = performance.now()
      await queryClient.fetchQuery({ queryKey: queryKeys.clauses })
      return Math.round(performance.now() - t0)
    }
    return () => {
      delete w.__reloadClauses
    }
  }, [queryClient])

  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className="p-8">
        <p role="alert" className="text-red-700">
          Could not load the rulebook: {error.message}
        </p>
      </main>
    )
  }

  return (
    <main id="main-content" tabIndex={-1} className="p-6">
      <h1 className="text-xl font-semibold text-slate-900">Diagnostics</h1>
      <p className="mt-1 text-sm text-slate-600" data-testid="summary">
        {isLoading
          ? 'Loading the rulebook…'
          : `${data?.length ?? 0} clauses loaded in ${loadMs ?? '?'} ms`}
      </p>
      <p className="mt-1 text-sm text-slate-700" data-testid="season">
        season: {season.data?.label ?? '?'} | season-scoped tasks:{' '}
        <span data-testid="task-titles">
          {(tasks.data ?? []).map((task) => task.title).join(', ') || 'none'}
        </span>
      </p>
      <ul id="clause-list" className="mt-4 h-[70vh] overflow-y-auto border border-slate-200">
        {data?.map((clause) => (
          <li key={clause.clause_key} className="border-b border-slate-100 px-3 py-2 text-sm">
            <span className="font-mono text-slate-500">{clause.printed_ref}</span>{' '}
            <span className="text-slate-900">{clause.body.slice(0, 160)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-600">updated {dataUpdatedAt}</p>
    </main>
  )
}
