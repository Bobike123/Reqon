import { PageHeader } from '../ui/PageHeader.tsx'
import { pageMain } from '../ui/layout.ts'
import { ErrorState } from '../ui/states.tsx'
import { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ClauseState } from '../data/useClauseStatus.ts'
import { useClauseStatus, useSetClauseStatus } from '../data/useClauseStatus.ts'
import { useClauses } from '../data/useClauses.ts'
import { useMembers } from '../data/useMembers.ts'
import { useSubteams } from '../data/useMilestones.ts'
import { useRealtimeClauseStatus } from '../data/useRealtimeClauseStatus.ts'
import { ClauseRow } from './register/ClauseRow.tsx'
import {
  applyFilters,
  buildRows,
  DEFAULT_FILTERS,
  GROUPINGS,
  groupRows,
  type Filters,
  type GroupingId,
  type SubteamInfo,
} from './register/registerModel.ts'

export default function Register() {
  const clauses = useClauses()
  const statuses = useClauseStatus()
  const members = useMembers()
  const subteams = useSubteams()
  const setStatus = useSetClauseStatus()
  const realtime = useRealtimeClauseStatus()

  const [grouping, setGrouping] = useState<GroupingId>('subsystem')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  // The Now screen links here with ?subteam=GEOM. Read once into the search
  // box so the arriving view is obviously filtered and easy to clear.
  const [searchParams, setSearchParams] = useSearchParams()
  const subteamParam = searchParams.get('subteam')
  // The Spec sheet links here with ?search=B.2.1.9 so a failing measurement can
  // jump straight to the rule it breaks.
  const searchParam = searchParams.get('search')
  const [appliedSearch, setAppliedSearch] = useState<string | null>(null)
  if (searchParam && appliedSearch !== searchParam) {
    setAppliedSearch(searchParam)
    setFilters((f) => ({ ...f, search: searchParam, teamDutiesOnly: false }))
  }

  const subteamMap = useMemo(() => {
    const map = new Map<string, SubteamInfo>()
    for (const s of subteams.data ?? []) {
      map.set(s.key, { name: s.name, isParked: s.is_parked })
    }
    return map
  }, [subteams.data])

  const memberNames = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.id, m.full_name])),
    [members.data],
  )

  const rows = useMemo(
    () => buildRows(clauses.data ?? [], statuses.data ?? [], subteamMap),
    [clauses.data, statuses.data, subteamMap],
  )
  const scoped = useMemo(
    () => (subteamParam ? rows.filter((r) => r.clause.subteam_key === subteamParam) : rows),
    [rows, subteamParam],
  )
  // Re-filtering ~500 rows (each carrying two <select>s) blocked the first
  // keystroke for 133ms, measured in Chrome. The box keeps the typed value
  // immediately; the list re-renders at lower priority a frame later.
  const visibleFilters = useDeferredValue(filters)
  const filtered = useMemo(() => applyFilters(scoped, visibleFilters), [scoped, visibleFilters])
  // The tutorial points at one representative rule — one with a criticality
  // badge when there is one on screen, so the badges get explained too.
  const tutorialRowKey = useMemo(
    () =>
      (
        filtered.find((r) => r.clause.criticality === 'blocking' || r.clause.criticality === 'penalty') ??
        filtered[0]
      )?.clause.clause_key,
    [filtered],
  )
  const groups = useMemo(
    () => groupRows(filtered, grouping, { subteams: subteamMap, memberNames }),
    [filtered, grouping, subteamMap, memberNames],
  )

  const obligations = useMemo(
    () => [...new Set((clauses.data ?? []).map((c) => c.obligation))].sort(),
    [clauses.data],
  )

  // All four writes are the same upsert on (season_id, clause_key) — the real
  // unique key from the schema. Writes go to clause_status; `clauses` is the
  // rulebook and is never edited to record progress.
  const onSetState = useCallback(
    (clauseKey: string, state: ClauseState) => setStatus.mutate({ clauseKey, state }),
    [setStatus],
  )
  const onSetOwner = useCallback(
    (clauseKey: string, ownerId: string | null) => setStatus.mutate({ clauseKey, ownerId }),
    [setStatus],
  )
  const onSetEvidence = useCallback(
    (clauseKey: string, evidence: string) =>
      setStatus.mutate({ clauseKey, evidence: evidence || null }),
    [setStatus],
  )
  const onToggleStar = useCallback(
    (clauseKey: string, starred: boolean) => setStatus.mutate({ clauseKey, starred }),
    [setStatus],
  )

  const error = clauses.error ?? statuses.error ?? members.error ?? subteams.error
  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className={pageMain()}>
        <ErrorState
          title="Could not load the register"
          error={error}
          onRetry={() => {
            void clauses.refetch()
            void statuses.refetch()
            void members.refetch()
            void subteams.refetch()
          }}
        />
      </main>
    )
  }

  const loading = clauses.isLoading || statuses.isLoading
  const total = rows.length
  const shown = filtered.length

  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader
        title="Register"
        description="Every rule in the regulations, and what the team has done about each one."
      >
        <p className="mt-1 text-sm text-slate-600" data-testid="counts" data-tutorial="register-live">
          {loading ? 'Loading the rulebook…' : `${shown} of ${total} rules shown`}
          <span
            className="ml-2 text-xs"
            data-testid="realtime-state"
            title="Live updates from other people editing"
          >
            · live updates: {realtime}
          </span>
        </p>
      </PageHeader>

      {/* Grouping. The same rules, re-filed by the question being asked. */}
      <fieldset className="mb-3" data-tutorial="register-grouping">
        <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          Group by
        </legend>
        <div className="inline-flex flex-wrap gap-0.5 rounded-md border border-slate-300 bg-white p-0.5">
          {GROUPINGS.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={grouping === g.id}
              title={g.hint}
              onClick={() => setGrouping(g.id)}
              className={`min-h-11 rounded px-2.5 py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 ${
                grouping === g.id
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4" data-tutorial="register-filters">
        <div>
          <label htmlFor="search" className="block text-xs font-medium text-slate-600">
            Search
          </label>
          <input
            id="search"
            type="search"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Reference or wording…"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          />
        </div>

        <div>
          <label htmlFor="obligation" className="block text-xs font-medium text-slate-600">
            Kind of work
          </label>
          <select
            id="obligation"
            value={filters.obligation}
            onChange={(e) => setFilters((f) => ({ ...f, obligation: e.target.value }))}
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            <option value="all">All kinds</option>
            {obligations.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="owner" className="block text-xs font-medium text-slate-600">
            Owner
          </label>
          <select
            id="owner"
            value={filters.owner}
            onChange={(e) => setFilters((f) => ({ ...f, owner: e.target.value }))}
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            <option value="all">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {(members.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end gap-4 pb-1">
          {/* Visible, not hidden: this default is why the screen is usable. */}
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={filters.teamDutiesOnly}
              onChange={(e) =>
                setFilters((f) => ({ ...f, teamDutiesOnly: e.target.checked }))
              }
              className="h-5 w-5 accent-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            />
            Team duties only
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={filters.unresolvedOnly}
              onChange={(e) =>
                setFilters((f) => ({ ...f, unresolvedOnly: e.target.checked }))
              }
              className="h-5 w-5 accent-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            />
            Unresolved only
          </label>
        </div>
      </div>

      {subteamParam && (
        <p className="mb-3 flex items-center gap-2 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800">
          <span data-testid="subteam-scope">
            Showing <strong>{subteamMap.get(subteamParam)?.name ?? subteamParam}</strong> only
          </span>
          <button
            type="button"
            onClick={() => setSearchParams({}, { replace: true })}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            Clear
          </button>
        </p>
      )}

      {setStatus.isError && (
        <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that change: {setStatus.error.message}
        </p>
      )}

      {!loading && shown === 0 && (
        <p className="rounded border border-slate-200 bg-slate-50 p-6 text-center text-slate-600">
          No rules match these filters. Try clearing the search, or switch off
          “Team duties only” to see definitions and the Organization's own powers.
        </p>
      )}

      <div id="register-list">
        {groups.map((group) => (
          <section key={group.key} className="mb-5">
            <h2 className="sticky top-0 z-10 border-b border-slate-300 bg-white py-1.5 text-sm font-semibold text-slate-900">
              {group.label}{' '}
              <span className="font-normal text-slate-500">({group.rows.length})</span>
            </h2>
            <ul>
              {group.rows.map((row) => (
                <ClauseRow
                  key={row.clause.clause_key}
                  tutorialId={row.clause.clause_key === tutorialRowKey ? 'register-row' : undefined}
                  row={row}
                  members={members.data ?? []}
                  onSetState={onSetState}
                  onSetOwner={onSetOwner}
                  onSetEvidence={onSetEvidence}
                  onToggleStar={onToggleStar}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}
