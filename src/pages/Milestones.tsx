import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../ui/PageHeader.tsx'
import { formatDay } from '../lib/dates.ts'
import { mergeSearchParams, readSetParam, writeSetParam } from '../lib/searchParams.ts'
import { pageMain } from '../ui/layout.ts'
import { EmptyState, ErrorState } from '../ui/states.tsx'
import { useClauses } from '../data/useClauses.ts'
import { useMembers } from '../data/useMembers.ts'
import {
  useMilestones,
  useMilestoneSections,
  useSetSectionDrafted,
} from '../data/useMilestones.ts'
import { useRealtimeMilestoneSections } from '../data/useRealtimeMilestoneSections.ts'
import { useRealtimeMilestones } from '../data/useRealtimeMilestones.ts'
import { useSubteams } from '../data/useSubteams.ts'
import { useTasksForProgress, type ProgressTask } from '../data/useTaskHistory.ts'
import { TASK_STATE_LABEL } from '../tasks/taskState.ts'
import { milestoneProgress, progressLabel, tasksUnderSection, unsectionedFor } from './gantt/ganttProgress.ts'
import {
  draftedCount,
  sectionsFor,
  submissionWindow,
} from './milestones/milestoneModel.ts'
import { useUrlParams } from '../lib/useUrlParams.ts'

// The submissions, in their published order (Milestones 1–7 and Rider
// Eligibility), each an expandable row: a progress bar from its linked Board
// tasks (the one progress rule, the same figure as the Gantt), done/total, its
// window or TBC, and its status. Expanding shows its real sections and the
// tasks under each — what is complete, blocked or outstanding.
//
// Three different things are kept apart on purpose: task progress (from Board
// tasks), the drafting checklist (the sections' own ticks), and submission.
// Reqon records neither the sending nor the organisers' acceptance of a
// submission, so a full bar never claims either. Points are shown, small.
export default function Milestones() {
  const milestones = useMilestones()
  const sections = useMilestoneSections(milestones.data?.map((m) => m.key))
  const realtime = useRealtimeMilestoneSections()
  useRealtimeMilestones()
  const clauses = useClauses()
  const setDrafted = useSetSectionDrafted()
  const members = useMembers()
  const departments = useSubteams()
  // The same linked-work figure the Gantt shows (active AND archived tasks, one
  // shared rule), so the two screens cannot disagree about a submission.
  const progress = useTasksForProgress()
  const [params, setParams] = useUrlParams()
  const open = useMemo(() => readSetParam(params, 'open'), [params])
  const toggle = (key: string) => {
    const next = new Set(open)
    if (!next.delete(key)) next.add(key)
    setParams((current) => mergeSearchParams(current, { open: writeSetParam(next) }), { replace: true })
  }

  const memberName = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.full_name])), [members.data])
  const deptName = useMemo(() => new Map((departments.data ?? []).map((d) => [d.key, d.name])), [departments.data])

  // The Art. F.14 format rules are rendered straight from the clause rows that
  // were imported from the regulations PDF. They are NOT retyped here from
  // memory, so nothing can be silently "corrected" into being wrong.
  const formatClauses = (clauses.data ?? [])
    .filter((c) => c.printed_ref.startsWith('F.14.2'))
    .sort((a, b) => a.printed_ref.localeCompare(b.printed_ref))
  const penaltyClauses = (clauses.data ?? [])
    .filter((c) => c.printed_ref.startsWith('F.14.3') || c.printed_ref.startsWith('F.14.4'))
    .sort((a, b) => a.printed_ref.localeCompare(b.printed_ref))

  const error = milestones.error ?? sections.error
  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className={pageMain()}>
        <h1 className="text-xl font-semibold text-slate-900">Milestones</h1>
        <div className="mt-4">
          <ErrorState
            title="Could not load milestones"
            error={error}
            onRetry={() => {
              void milestones.refetch()
              void sections.refetch()
            }}
          />
        </div>
      </main>
    )
  }

  const ordered = [...(milestones.data ?? [])].sort((a, b) => a.ordinal - b.ordinal)
  const totalPoints = ordered.filter((m) => m.key.startsWith('MS1')).reduce((n, m) => n + (m.max_points ?? 0), 0)

  const taskLine = (task: ProgressTask) => (
    <li key={task.id} className="flex flex-wrap items-baseline gap-x-2 py-0.5" data-task-id={task.id}>
      <span aria-hidden="true" className={task.state === 'done' ? 'text-emerald-700' : task.state === 'blocked' ? 'text-amber-700' : 'text-slate-400'}>
        {task.state === 'done' ? '✓' : task.state === 'blocked' ? '⏸' : '○'}
      </span>
      {task.archived_at === null ? (
        <Link to={`/board?task=${encodeURIComponent(task.id)}`} className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900">
          {task.title}
        </Link>
      ) : (
        <Link to={`/archive?tab=tasks&id=${encodeURIComponent(task.id)}`} className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900">
          {task.title}
        </Link>
      )}
      <span className="text-xs text-slate-600">
        {TASK_STATE_LABEL[task.state]}
        {task.archived_at !== null ? (task.state === 'done' ? ' · archived, done' : ' · archived, not finished') : ''}
        {task.state === 'cancelled' ? ' · not counted' : ''} · {task.owner_id ? (memberName.get(task.owner_id) ?? 'someone') : 'unassigned'} ·{' '}
        {task.subteam_key ? (deptName.get(task.subteam_key) ?? task.subteam_key) : 'no department'}
      </span>
    </li>
  )

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <PageHeader
        title="Milestones"
        description="The submissions in order, how far their linked work has come, and each one's sections and tasks."
      >
        <p className="mt-1 text-xs text-slate-500">
          <span data-testid="milestones-realtime-state" title="Live updates from other people editing">
            Live updates: {realtime}
          </span>
        </p>
      </PageHeader>

      {milestones.isLoading && (
        <p role="status" className="mb-2 text-xs text-slate-500">Loading…</p>
      )}
      {setDrafted.isError && (
        <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that change: {setDrafted.error.message}
        </p>
      )}

      <p className="mb-3 text-xs text-slate-600">
        The bar counts linked Board tasks done (cancelled left out, archived Done kept). It is not the drafting checklist
        and it does not mean a submission was sent or accepted — Reqon does not record either. Unknown dates stay TBC.{' '}
        <span data-testid="ms1-total">Points: up to {totalPoints} across the MS1 deliverables, awarded by the organisers.</span>
      </p>

      {!milestones.isLoading && ordered.length === 0 && (
        <EmptyState title="No milestones for this season yet">
          The President or Vice President adds the submission windows and points in
          Settings → Milestone dates and points.
        </EmptyState>
      )}

      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {ordered.map((milestone, index) => {
          const window = submissionWindow(milestone, new Date())
          const mySections = sectionsFor(sections.data ?? [], milestone.key)
          const { drafted, total } = draftedCount(mySections)
          const view = progress.data ? milestoneProgress(mySections, progress.data, milestone.key) : null
          const isOpen = open.has(milestone.key)
          const panelId = `milestone-panel-${milestone.key}`
          const loose = progress.data ? unsectionedFor(progress.data, milestone.key) : []

          return (
            <li
              key={milestone.key}
              className="px-3 py-2"
              data-testid={`milestone-${milestone.key}`}
              data-tutorial={index === 0 ? 'milestone-card' : undefined}
            >
              <div className="grid gap-x-4 gap-y-1 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_auto] md:items-center">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => toggle(milestone.key)}
                  className="flex min-h-11 items-center gap-1.5 text-left text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                >
                  <span aria-hidden="true" className="w-3 text-slate-500">
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className="font-mono text-xs">{milestone.key}</span>{' '}
                  <span className="min-w-0">{milestone.name}</span>
                </button>

                <div className="min-w-0">
                  <span aria-hidden="true" className="block h-2 overflow-hidden rounded bg-slate-200">
                    <span
                      className={`block h-full ${view?.basis === 'drafted' ? 'bg-slate-400' : 'bg-slate-800'}`}
                      style={{ width: `${view?.percent ?? 0}%` }}
                    />
                  </span>
                  <p className="mt-0.5 text-xs text-slate-700" data-testid={`linked-${milestone.key}`}>
                    Linked work: {view ? progressLabel(view) : progress.error ? 'could not be loaded' : 'loading…'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs md:justify-end">
                  {window.kind === 'tbc' ? (
                    <span
                      className="rounded bg-slate-200 px-2 py-0.5 font-medium text-slate-700"
                      data-testid={`window-${milestone.key}`}
                      title="No submission window has been published for this milestone yet"
                    >
                      Window: TBC
                    </span>
                  ) : (
                    <>
                      <span className="text-slate-700" data-testid={`window-${milestone.key}`}>
                        {window.opensOn ? `${formatDay(window.opensOn)} → ` : 'Due '}
                        {formatDay(window.dueOn)}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 font-medium ${
                          window.passed
                            ? 'bg-red-100 text-red-800'
                            : window.daysRemaining <= 14
                              ? 'bg-amber-100 text-amber-900'
                              : 'bg-slate-100 text-slate-700'
                        }`}
                        data-testid={`days-${milestone.key}`}
                      >
                        {window.passed ? `deadline passed ${Math.abs(window.daysRemaining)} days ago` : `${window.daysRemaining} days remaining`}
                      </span>
                    </>
                  )}
                  {milestone.is_blocking && (
                    <span className="rounded bg-red-700 px-2 py-0.5 font-bold text-white" title="Missing this bars the team from on-track activity">
                      BLOCKING
                    </span>
                  )}
                </div>
              </div>

              <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                {total > 0 && (
                  <span>
                    Drafting checklist: <span data-testid={`sections-${milestone.key}`}>{drafted}/{total}</span> sections drafted
                  </span>
                )}
                <span data-testid={`points-${milestone.key}`}>{milestone.max_points} points</span>
                {milestone.article_ref && <span className="font-mono">{milestone.article_ref}</span>}
              </p>

              {isOpen && (
                <div id={panelId} className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-sm" data-tutorial={index === 0 ? 'milestone-sections' : undefined}>
                  {milestone.aim && <p className="mb-2 text-slate-700">{milestone.aim}</p>}
                  <p className="mb-2 text-xs">
                    <Link to={`/gantt?open=${encodeURIComponent(milestone.key)}`} className="font-medium underline underline-offset-2">
                      Open {milestone.key} on the Gantt
                    </Link>
                  </p>
                  {mySections.length === 0 && loose.length === 0 && (
                    <p className="text-xs text-slate-600">No sections and no linked tasks yet.</p>
                  )}
                  {mySections.length > 0 && (
                    <p className="text-xs font-medium text-slate-600">Drafting checklist — sections drafted {drafted}/{total}</p>
                  )}
                  <ul className="mt-1 space-y-2">
                    {mySections.map((section) => {
                      const under = progress.data ? tasksUnderSection(progress.data, section.id) : []
                      return (
                        <li key={section.id} className="rounded border border-slate-200 bg-white p-2">
                          <label className="flex min-h-11 items-center gap-2 font-medium text-slate-900 sm:min-h-0">
                            <input
                              type="checkbox"
                              checked={section.is_drafted}
                              onChange={(e) => setDrafted.mutate({ id: section.id, isDrafted: e.target.checked })}
                              className="h-5 w-5 accent-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                            />
                            {section.name}
                            <span className="text-xs font-normal text-slate-500">(drafted — a checklist tick, not task completion)</span>
                          </label>
                          {under.length === 0 ? (
                            <p className="ml-7 text-xs text-slate-500">No tasks linked to this section.</p>
                          ) : (
                            <ul className="ml-7 text-sm">{under.map(taskLine)}</ul>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                  {loose.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-slate-600">Linked to {milestone.key} without a section</p>
                      <ul className="text-sm">{loose.map(taskLine)}</ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {/* Static reference, read from the imported clause rows. */}
      <section className="mt-8 max-w-6xl" aria-labelledby="format-heading" data-tutorial="milestone-format">
        <h2 id="format-heading" className="mb-1 text-sm font-semibold text-slate-900">
          Deliverable format — Art. F.14
        </h2>
        <p className="mb-2 text-xs text-slate-500">
          Straight from the regulations import. If this disagrees with something you were
          told, the book wins.
        </p>
        <table className="w-full table-auto border-collapse text-sm">
          <caption className="sr-only">Art. F.14 deliverable format requirements</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="w-24 py-1 pr-2 font-medium text-slate-600">Rule</th>
              <th scope="col" className="py-1 font-medium text-slate-600">Requirement</th>
            </tr>
          </thead>
          <tbody data-testid="format-table">
            {formatClauses.map((c) => (
              <tr key={c.clause_key} className="border-b border-slate-100 align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-mono text-xs font-normal text-slate-500">
                  {c.printed_ref}
                </th>
                <td className="py-1.5 whitespace-pre-line text-slate-800">{c.body}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 className="mt-4 mb-1 text-sm font-semibold text-slate-900">
          What it costs you to get it wrong
        </h3>
        <table className="w-full table-auto border-collapse text-sm">
          <caption className="sr-only">Art. F.14 penalties</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="w-24 py-1 pr-2 font-medium text-slate-600">Rule</th>
              <th scope="col" className="py-1 font-medium text-slate-600">Consequence</th>
            </tr>
          </thead>
          <tbody data-testid="penalty-table">
            {penaltyClauses.map((c) => (
              <tr key={c.clause_key} className="border-b border-slate-100 align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-mono text-xs font-normal text-slate-500">
                  {c.printed_ref}
                </th>
                <td className="py-1.5 whitespace-pre-line text-slate-800">{c.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  )
}
