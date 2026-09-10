import { PageHeader } from '../ui/PageHeader.tsx'
import { ErrorState } from '../ui/states.tsx'
import { Link } from 'react-router-dom'
import { useMilestones } from '../data/useMilestones.ts'
import { useAttention, useSubteamProgress } from '../data/useNowMetrics.ts'
import { useTopics } from '../data/useTopics.ts'
import { TopicsPanel } from '../topics/TopicsPanel.tsx'
import {
  blockedCount,
  liveObligations,
  ms1Points,
  nextDeadline,
  openTopicsCount,
  overdueCount,
  percent,
} from './now/nowModel.ts'

// The screen people keep open while working. Instruments, not decoration.
// Every number here is reproducible with a query in docs/now-metrics.sql.

function Tile({
  label,
  value,
  sub,
  tone = 'plain',
  testId,
  to,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'plain' | 'warn' | 'bad'
  testId: string
  to: string
}) {
  const toneClass =
    tone === 'bad'
      ? 'border-red-300 bg-red-50 hover:border-red-400'
      : tone === 'warn'
        ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
        : 'border-slate-200 bg-white hover:border-slate-400'
  // Every number is a way in: the tile opens the screen that explains it.
  return (
    <Link
      to={to}
      className={`group block rounded-lg border p-3 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 ${toneClass}`}
    >
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-600">
        {label}
        <span aria-hidden="true" className="text-slate-500 transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </div>
      <div className="mt-0.5 text-2xl font-semibold text-slate-900" data-testid={testId}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-600">{sub}</div>}
    </Link>
  )
}

export default function Now() {
  const milestones = useMilestones()
  const progress = useSubteamProgress()
  const attention = useAttention()
  const topics = useTopics()

  const error = milestones.error ?? progress.error ?? attention.error ?? topics.error
  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-3 py-4 sm:px-6 *:max-w-5xl">
        <h1 className="text-xl font-semibold text-slate-900">Now</h1>
        <div className="mt-4">
          <ErrorState
            title="Could not load the dashboard"
            error={error}
            onRetry={() => {
              void milestones.refetch()
              void progress.refetch()
              void attention.refetch()
              void topics.refetch()
            }}
          />
        </div>
      </main>
    )
  }

  const loading =
    milestones.isLoading || progress.isLoading || attention.isLoading || topics.isLoading

  const deadline = nextDeadline(milestones.data ?? [], new Date())
  const obligations = liveObligations(progress.data ?? [])
  const points = ms1Points(milestones.data ?? [])
  const overdue = overdueCount(attention.data ?? [])
  const openTopics = openTopicsCount(topics.data ?? [])
  const blocked = blockedCount(attention.data ?? [])

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-3 py-4 sm:px-6 *:max-w-5xl">
      <PageHeader
        title="Now"
        description="What needs attention today — the next deadline, open work and anything blocked."
      />

      {loading && (
        <p role="status" className="mb-2 text-xs text-slate-500">
          Refreshing…
        </p>
      )}

      {/* The content stays mounted while data loads. Unmounting it on every
          loading flip would throw away whatever someone was typing into the
          topic form below — the dashboard is the screen people keep open. */}
      <div>
          <section aria-label="Instruments" data-tutorial="now-instruments" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Tile
              testId="tile-deadline"
              to="/milestones"
              label="Next deadline"
              value={deadline.kind === 'tbc' ? 'TBC' : `${deadline.days} days`}
              sub={
                deadline.kind === 'tbc'
                  ? 'No published window yet'
                  : `${deadline.milestoneKey} · ${deadline.name} · ${deadline.dueOn}`
              }
              tone={deadline.kind === 'due' && deadline.days <= 14 ? 'warn' : 'plain'}
            />
            <Tile
              testId="tile-obligations"
              to="/register"
              label="Live obligations"
              value={`${obligations.resolved} / ${obligations.total}`}
              sub={`${percent(obligations.resolved, obligations.total)}% resolved · Race Operations parked`}
            />
            <Tile
              testId="tile-points"
              to="/milestones"
              label="MS1 points at stake"
              value={String(points)}
              sub="Across the MS1 deliverables"
            />
            <Tile
              testId="tile-overdue"
              to="/priorities"
              label="Overdue"
              value={String(overdue)}
              sub="Past their due date"
              tone={overdue > 0 ? 'bad' : 'plain'}
            />
            <Tile
              testId="tile-topics"
              to="/meetings"
              label="Open topics"
              value={String(openTopics)}
              sub="Raised, not yet on an agenda"
            />
            <Tile
              testId="tile-blocked"
              to="/priorities"
              label="Blocked"
              value={String(blocked)}
              sub="Rules and tasks waiting on something"
              tone={blocked > 0 ? 'bad' : 'plain'}
            />
          </section>

          <section className="mt-6" aria-labelledby="subteams-heading">
            <h2 id="subteams-heading" className="mb-2 text-sm font-semibold text-slate-900">
              Progress by subsystem
            </h2>
            {(progress.data ?? []).length === 0 ? (
              <p className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                No subsystems yet. The board sets these up in Settings.
              </p>
            ) : (
              <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                {(progress.data ?? []).map((row) => {
                  const duties = row.duties ?? 0
                  const resolved = row.resolved ?? 0
                  const pct = percent(resolved, duties)
                  return (
                    <li key={row.key} data-testid={`subteam-${row.key}`}>
                      {/* Straight through to the Register, already filtered to
                          this subsystem — the whole point of the grid. */}
                      <Link
                        to={`/register?subteam=${encodeURIComponent(row.key ?? '')}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500"
                      >
                        <span
                          className={`min-w-0 flex-1 truncate text-sm sm:w-40 sm:flex-none sm:shrink-0 ${
                            row.is_parked ? 'text-slate-600' : 'text-slate-900'
                          }`}
                        >
                          {row.name}
                          {row.is_parked && (
                            <span className="ml-1 text-[10px] uppercase">parked</span>
                          )}
                        </span>
                        {/* On a phone the bar drops to its own line; inline on
                            desktop. A fixed name + fixed count + bar + badge
                            does not fit in 375px. */}
                        <span className="order-last h-2 w-full overflow-hidden rounded bg-slate-200 sm:order-none sm:w-auto sm:flex-1">
                          <span
                            className={`block h-full ${row.is_parked ? 'bg-slate-400' : 'bg-slate-800'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className="shrink-0 text-right font-mono text-xs text-slate-600 sm:w-24">
                          {resolved}/{duties}
                        </span>
                        {(row.blocked ?? 0) > 0 && (
                          <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-800">
                            {row.blocked} blocked
                          </span>
                        )}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* The SAME component the Meetings screen renders. Topics are
              editable here so nobody has to go hunting for another screen
              mid-conversation. */}
          <div className="mt-6">
            <TopicsPanel
              heading="Topics needing attention"
              // Includes 'decided': a topic must stay reachable here after it
              // is decided, or it could never be converted to a task from Now.
              // Only 'parked' (the archive) is hidden.
              states={['open', 'agenda', 'decided']}
              emptyHint="Nothing waiting on a decision. Raise a topic above when something needs one."
            />
          </div>
      </div>
    </main>
  )
}
