import { PageHeader } from '../ui/PageHeader.tsx'
import { pageMain } from '../ui/layout.ts'
import { ErrorState } from '../ui/states.tsx'
import { Link } from 'react-router-dom'
import { mergeSearchParams } from '../lib/searchParams.ts'
import { useSetClauseStatus } from '../data/useClauseStatus.ts'
import { useMembers } from '../data/useMembers.ts'
import { useAttention, type Attention } from '../data/useNowMetrics.ts'
import { canEditTask, canReassignTaskOwner } from '../auth/permissions.ts'
import { useTaskActor } from '../data/useTaskActor.ts'
import { useTasks, useUpdateTask } from '../data/useTasks.ts'
import { useRealtimeTasks } from '../data/useRealtimeTasks.ts'
import { attentionFor } from './now/nowModel.ts'
import { useRealtimeClauseStatus } from '../data/useRealtimeClauseStatus.ts'
import { useUrlParams } from '../lib/useUrlParams.ts'

// What bites first. The list, the membership rules and the `reason` labels all
// come from attention(p_season, p_today) — the scoring is SQL's job and is not
// repeated here, and it never lists an archived task. p_today is the reader's
// own day (see useNowMetrics.ts). See docs/now-metrics.sql, final block.

// Presentation order only. This does not decide WHICH rows appear or WHY they
// appear (the view does both); it decides what a human should read first.
const REASON_ORDER: Record<string, number> = {
  blocked: 0,
  'score-killer': 1,
  overdue: 2,
  urgent: 3,
  penalty: 4,
  starred: 5,
}

const REASON_STYLE: Record<string, string> = {
  blocked: 'bg-red-700 text-white',
  'score-killer': 'bg-red-700 text-white',
  overdue: 'bg-red-100 text-red-900',
  urgent: 'bg-red-100 text-red-900',
  penalty: 'bg-amber-500 text-amber-950',
  starred: 'bg-slate-200 text-slate-800',
}

const REASON_HELP: Record<string, string> = {
  blocked: 'Waiting on something or someone',
  'score-killer': 'Non-compliance scores NC',
  overdue: 'Past its due date',
  urgent: 'Marked as urgent priority',
  penalty: 'Risks MP / SP / NP penalty points',
  starred: 'Flagged by the team',
}

// The reasons a row can be listed for, in reading order — also the filter
// chips (?reason=…), which is where the Now screen's Overdue and Blocked tiles land.
const REASONS = Object.keys(REASON_ORDER).sort((a, b) => REASON_ORDER[a] - REASON_ORDER[b])

export default function Priorities() {
  useRealtimeTasks()
  useRealtimeClauseStatus()
  const attention = useAttention()
  const members = useMembers()
  const setClauseStatus = useSetClauseStatus()
  const updateTask = useUpdateTask()
  const tasks = useTasks()
  const actor = useTaskActor()
  const taskById = new Map((tasks.data ?? []).map((t) => [t.id, t]))
  const [params, setParams] = useUrlParams()
  // New owners are active members only — the database refuses anyone else for a
  // task, and a retired member is not a sensible owner for a rule either. A
  // current retired owner stays visible (see ownerChoices).
  const activeMembers = (members.data ?? []).filter((m) => m.status === 'active')
  const ownerChoices = (current: string | null) =>
    current && !activeMembers.some((m) => m.id === current)
      ? [...activeMembers, ...(members.data ?? []).filter((m) => m.id === current).map((m) => ({ ...m, full_name: `${m.full_name} (no longer active)` }))]
      : activeMembers

  // The same per-task rule the Board uses: only someone who may reassign THIS
  // task is offered the owner control. The database refuses everyone else too.
  const mayAssign = (row: Attention): boolean => {
    if (row.kind === 'clause') return actor !== null && actor.status === 'active'
    const task = row.ref ? taskById.get(row.ref) : undefined
    return actor !== null && task !== undefined && canEditTask(actor, task) && canReassignTaskOwner(actor, task)
  }

  const error = attention.error ?? members.error
  const writeError = setClauseStatus.error ?? updateTask.error

  function assignOwner(row: Attention, ownerId: string | null) {
    if (row.kind === 'clause') {
      // clause_key, not the printed reference — two different rules can print
      // the same reference (E.5.4.5, F.5.2.3).
      if (row.clause_key) setClauseStatus.mutate({ clauseKey: row.clause_key, ownerId })
      return
    }
    if (row.ref) updateTask.mutate({ id: row.ref, ownerId })
  }

  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
        <h1 className="text-xl font-semibold text-slate-900">Priorities</h1>
        <div className="mt-4">
          <ErrorState
            title="Could not load priorities"
            error={error}
            onRetry={() => {
              void attention.refetch()
              void members.refetch()
            }}
          />
        </div>
      </main>
    )
  }

  const rawReason = params.get('reason')
  const reason = rawReason && REASONS.includes(rawReason) ? rawReason : null
  const allRows = attention.data ?? []
  const rows = [...(reason === null ? allRows : attentionFor(allRows, reason))].sort(
    (a, b) =>
      (REASON_ORDER[a.reason ?? ''] ?? 99) - (REASON_ORDER[b.reason ?? ''] ?? 99),
  )

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <PageHeader
        title="Priorities"
        description="Everything that bites first: blocked rules, score-killers, overdue tasks, penalties and starred items."
      />

      <div role="group" aria-label="Show only one reason" className="mb-3 flex flex-wrap gap-1 rounded-md bg-slate-50 p-1" data-testid="priority-reasons">
        {[null, ...REASONS].map((r) => {
          const n = r === null ? allRows.length : attentionFor(allRows, r).length
          return (
            <button
              key={r ?? 'all'}
              type="button"
              aria-pressed={reason === r}
              onClick={() => setParams((current) => mergeSearchParams(current, { reason: r }), { replace: true })}
              className={`min-h-11 rounded px-3 py-1.5 text-xs font-medium capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 ${
                reason === r ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              {r ?? 'Everything'} <span className="font-normal opacity-80">({n})</span>
            </button>
          )
        })}
      </div>

      {writeError && (
        <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that change: {writeError.message}
        </p>
      )}

      {attention.isLoading && <p role="status" className="text-slate-600">Loading…</p>}

      {!attention.isLoading && rows.length === 0 && reason !== null && allRows.length > 0 && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700" data-testid="priority-reason-empty">
          Nothing is listed as “{reason}” right now.{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => setParams((current) => mergeSearchParams(current, { reason: null }), { replace: true })}>
            Show everything
          </button>
        </p>
      )}

      {!attention.isLoading && allRows.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center" data-tutorial="priorities-list">
          <p className="font-medium text-slate-800">Nothing is biting right now.</p>
          <p className="mt-1 text-sm text-slate-600">
            This list fills up as rules get blocked, tasks run past their due date, or
            anyone stars something. Star a rule in the{' '}
            <Link className="underline" to="/register">
              Register
            </Link>{' '}
            to put it here.
          </p>
        </div>
      )}

      {rows.length > 0 && (
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white" data-tutorial="priorities-list">
        {rows.map((row, index) => (
          <li
            key={`${row.kind}-${row.clause_key ?? row.ref}`}
            // On a wide screen the owner sits at the right-hand end of the row,
            // so the list reads like a table: what, why, whose.
            className="px-3 py-2.5 lg:flex lg:items-start lg:gap-6"
            data-testid={`priority-${row.clause_key ?? row.ref}`}
            data-tutorial={index === 0 ? 'priority-row' : undefined}
          >
            <div className="min-w-0 lg:flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                  REASON_STYLE[row.reason ?? ''] ?? 'bg-slate-200 text-slate-800'
                }`}
                title={REASON_HELP[row.reason ?? ''] ?? ''}
              >
                {row.reason}
              </span>
              <span className="text-[11px] uppercase tracking-wide text-slate-500">
                {row.kind}
              </span>
              {row.kind === 'clause' ? (
                <Link
                  to={`/register?search=${encodeURIComponent(row.clause_key ?? row.ref ?? '')}`}
                  className="inline-flex min-h-6 items-center rounded font-mono text-sm font-bold text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                  title="Open this rule in the Register"
                >
                  {row.ref}
                </Link>
              ) : (
                <Link
                  to={`/board?task=${encodeURIComponent(row.ref ?? '')}`}
                  className="rounded text-xs font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                >
                  Open on Board
                </Link>
              )}
              {row.starred && <span aria-label="Starred">★</span>}
            </div>

            <p className="mt-1 text-sm text-slate-800">{row.title}</p>
            </div>

            <div className="mt-1.5 flex items-center gap-2 lg:mt-0 lg:shrink-0">
              {mayAssign(row) ? (
                <>
                  <label className="text-xs text-slate-600" htmlFor={`owner-${row.clause_key ?? row.ref}`}>
                    Owner
                  </label>
                  <select
                    id={`owner-${row.clause_key ?? row.ref}`}
                    value={row.owner_id ?? ''}
                    onChange={(e) => assignOwner(row, e.target.value || null)}
                    className="min-h-11 w-full min-w-0 max-w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 sm:w-auto sm:max-w-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                  >
                    <option value="">Unassigned</option>
                    {ownerChoices(row.owner_id).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <p className="text-xs text-slate-600" data-testid={`owner-readonly-${row.clause_key ?? row.ref}`}>
                  Owner: {(members.data ?? []).find((m) => m.id === row.owner_id)?.full_name ?? 'Unassigned'}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      )}
    </main>
  )
}
