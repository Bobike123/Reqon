import { PageHeader } from '../ui/PageHeader.tsx'
import { pageMain } from '../ui/layout.ts'
import { ErrorState } from '../ui/states.tsx'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context.ts'
import { useSetClauseStatus } from '../data/useClauseStatus.ts'
import { useMembers } from '../data/useMembers.ts'
import { useAttention, type Attention } from '../data/useNowMetrics.ts'
import { useUpdateTask } from '../data/useTasks.ts'

// What bites first. The list, the membership rules and the `reason` labels all
// come from v_attention — the scoring is SQL's job and is not repeated here.
// See docs/now-metrics.sql, final block.

// Presentation order only. This does not decide WHICH rows appear or WHY they
// appear (the view does both); it decides what a human should read first.
const REASON_ORDER: Record<string, number> = {
  blocked: 0,
  'score-killer': 1,
  overdue: 2,
  penalty: 3,
  starred: 4,
}

const REASON_STYLE: Record<string, string> = {
  blocked: 'bg-red-700 text-white',
  'score-killer': 'bg-red-700 text-white',
  overdue: 'bg-red-100 text-red-900',
  penalty: 'bg-amber-500 text-amber-950',
  starred: 'bg-slate-200 text-slate-800',
}

const REASON_HELP: Record<string, string> = {
  blocked: 'Waiting on something or someone',
  'score-killer': 'Non-compliance scores NC',
  overdue: 'Past its due date',
  penalty: 'Risks MP / SP / NP penalty points',
  starred: 'Flagged by the team',
}

export default function Priorities() {
  const attention = useAttention()
  const members = useMembers()
  const setClauseStatus = useSetClauseStatus()
  const updateTask = useUpdateTask()
  const auth = useAuth()

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

  const rows = [...(attention.data ?? [])].sort(
    (a, b) =>
      (REASON_ORDER[a.reason ?? ''] ?? 99) - (REASON_ORDER[b.reason ?? ''] ?? 99),
  )

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <PageHeader
        title="Priorities"
        description="Everything that bites first: blocked rules, score-killers, overdue tasks, penalties and starred items."
      />

      {writeError && (
        <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that change: {writeError.message}
        </p>
      )}

      {attention.isLoading && <p className="text-slate-600">Loading…</p>}

      {!attention.isLoading && rows.length === 0 && (
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
                  className="rounded font-mono text-sm font-bold text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                  title="Open this rule in the Register"
                >
                  {row.ref}
                </Link>
              ) : (
                <Link
                  to="/board"
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
              <label
                className="text-xs text-slate-600"
                htmlFor={`owner-${row.clause_key ?? row.ref}`}
              >
                Owner
              </label>
              <select
                id={`owner-${row.clause_key ?? row.ref}`}
                value={row.owner_id ?? ''}
                disabled={auth.status !== 'member'}
                onChange={(e) => assignOwner(row, e.target.value || null)}
                className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
              >
                <option value="">Unassigned</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name}
                  </option>
                ))}
              </select>
            </div>
          </li>
        ))}
      </ul>
      )}
    </main>
  )
}
