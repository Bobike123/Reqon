import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context.ts'
import { usePermissions } from '../auth/usePermissions.ts'
import { canReviewProposal } from '../auth/permissions.ts'
import { useMembers } from '../data/useMembers.ts'
import { useMilestones } from '../data/useMilestones.ts'
import { useAttention, useSubteamProgress } from '../data/useNowMetrics.ts'
import { useProposals } from '../data/useProposals.ts'
import { useRealtimeMilestones } from '../data/useRealtimeMilestones.ts'
import { useRealtimeProposalRequirements } from '../data/useRealtimeProposalRequirements.ts'
import { useRealtimeProposals } from '../data/useRealtimeProposals.ts'
import { useRealtimeTasks } from '../data/useRealtimeTasks.ts'
import { useSubteams } from '../data/useSubteams.ts'
import { useTaskActor } from '../data/useTaskActor.ts'
import { useTasksForProgress } from '../data/useTaskHistory.ts'
import { useTasks } from '../data/useTasks.ts'
import { formatDay, todayIso } from '../lib/dates.ts'
import { isHistory } from '../proposals/filters.ts'
import { proposalStatusLabel } from '../proposals/proposalStates.ts'
import { TASK_STATE_LABEL } from '../tasks/taskState.ts'
import { pageMain } from '../ui/layout.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import {
  attentionFor,
  departmentOverview,
  liveObligations,
  ms1Points,
  myOpenTasks,
  nextDeadline,
  openProposalsCount,
  percent,
  upcomingDeadlines,
  type DepartmentOverview,
} from './now/nowModel.ts'

// The screen people keep open while working: what needs doing next, and how
// each department stands. Every number is reproducible (docs/now-metrics.sql)
// and every one is a way in — it opens the list that explains it, already
// filtered. Loading, unavailable and genuinely empty are three different
// states and are shown as such: a failed query never reads as "0".

type Source = { isLoading: boolean; error: Error | null; refetch: () => unknown }

function valueOf(source: Source, value: () => string): string {
  if (source.error) return '—'
  if (source.isLoading) return '…'
  return value()
}

function Tile({
  label,
  value,
  sub,
  tone = 'plain',
  testId,
  to,
  source,
}: {
  label: string
  value: string
  sub: string
  tone?: 'plain' | 'warn' | 'bad'
  testId: string
  to: string
  source: Source
}) {
  const toneClass =
    tone === 'bad'
      ? 'border-red-300 bg-red-50 hover:border-red-400'
      : tone === 'warn'
        ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
        : 'border-slate-200 bg-white hover:border-slate-400'
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
      <div className="mt-0.5 text-2xl font-semibold text-slate-900" data-testid={testId} aria-busy={source.isLoading || undefined}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-slate-600">{source.error ? 'Could not load — open to retry' : source.isLoading ? 'Loading…' : sub}</div>
    </Link>
  )
}

// A short list with its three states. `more` links to the full, filtered list.
function ActionList({
  title,
  source,
  empty,
  more,
  children,
  count,
  testId,
}: {
  title: string
  source: Source
  empty: string
  more?: { to: string; label: string }
  children: ReactNode
  count: number
  testId: string
}) {
  return (
    <section aria-label={title} className="rounded-lg border border-slate-200 bg-white p-3" data-testid={testId}>
      <h2 className="flex items-baseline justify-between gap-2 text-sm font-semibold text-slate-900">
        <span>
          {title} {!source.isLoading && !source.error && <span className="font-normal text-slate-500 tabular-nums">({count})</span>}
        </span>
        {more && count > 0 && (
          <Link to={more.to} className="text-xs font-medium text-slate-700 underline underline-offset-2">
            {more.label}
          </Link>
        )}
      </h2>
      {source.error ? (
        <p role="alert" className="mt-1 text-sm text-red-800">
          Could not load this list.{' '}
          <button type="button" onClick={() => void source.refetch()} className="font-medium underline underline-offset-2">
            Try again
          </button>
        </p>
      ) : source.isLoading ? (
        <p role="status" className="mt-1 text-sm text-slate-600">
          Loading…
        </p>
      ) : count === 0 ? (
        <p className="mt-1 text-sm text-slate-600">{empty}</p>
      ) : (
        <ul className="mt-1 divide-y divide-slate-100">{children}</ul>
      )}
    </section>
  )
}

function Row({ to, title, meta, tone }: { to: string; title: string; meta: string; tone?: 'bad' | 'warn' }) {
  return (
    <li className="py-1.5">
      <Link to={to} className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900">
        {title}
      </Link>
      <span className={`block text-xs ${tone === 'bad' ? 'text-red-800' : tone === 'warn' ? 'text-amber-900' : 'text-slate-600'}`}>{meta}</span>
    </li>
  )
}

function Bar({ value, tone }: { value: number | null; tone: string }) {
  return (
    <span aria-hidden="true" className="block h-2 w-full overflow-hidden rounded bg-slate-200">
      <span className={`block h-full ${tone}`} style={{ width: `${value ?? 0}%` }} />
    </span>
  )
}

function DepartmentRow({ row, canEdit }: { row: DepartmentOverview; canEdit: boolean }) {
  const work = row.work
  const req = row.requirements
  const reqPct = req ? percent(req.resolved, req.duties) : null
  const enc = encodeURIComponent(row.key)
  return (
    <li data-testid={`department-${row.key}`}>
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-1 gap-x-4 gap-y-1 px-3 py-2 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 sm:grid-cols-[minmax(0,14rem)_1fr_1fr] sm:items-center">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900">
            <span aria-hidden="true" className="text-slate-500 group-open:rotate-90">
              ▸
            </span>
            <span className="truncate" title={row.name}>
              {row.name}
            </span>
            {row.parked && <span className="shrink-0 rounded bg-slate-100 px-1 text-[10px] font-medium uppercase text-slate-600">parked</span>}
          </span>
          <span className="min-w-0">
            <span className="flex justify-between text-[11px] text-slate-600">
              <span>Work</span>
              <span className="tabular-nums" data-testid={`department-work-${row.key}`}>
                {work.total === 0 ? 'no tasks yet' : `${work.done}/${work.total} done`}
              </span>
            </span>
            <Bar value={work.percent} tone="bg-slate-800" />
          </span>
          <span className="min-w-0">
            <span className="flex justify-between text-[11px] text-slate-600">
              <span>Requirements</span>
              <span className="tabular-nums" data-testid={`department-requirements-${row.key}`}>
                {req === null ? 'not available' : req.duties === 0 ? 'no duties' : `${req.resolved}/${req.duties} resolved`}
              </span>
            </span>
            <Bar value={reqPct} tone="bg-emerald-700" />
          </span>
        </summary>
        <div className="border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <p>
            Open work: {row.open.todo} to do · {row.open.wip} in progress · {row.open.blocked} blocked
            {row.overdue > 0 && <span className="font-semibold text-red-800"> · {row.overdue} overdue</span>}
            {work.archivedUnfinished > 0 && ` · ${work.archivedUnfinished} archived unfinished (still counted as not done)`}
          </p>
          {req && req.blockedRules > 0 && <p>{req.blockedRules} of its rules are marked blocked.</p>}
          {!row.hasHead && <p className="text-amber-900">No Head of Department appointed — only a Developer can review its proposals.</p>}
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            <Link className="underline underline-offset-2" to={`/board?dept=${enc}`}>Board</Link>
            <Link className="underline underline-offset-2" to={`/gantt?dept=${enc}`}>Gantt</Link>
            <Link className="underline underline-offset-2" to={`/register?subteam=${enc}`}>Register</Link>
            <Link className="underline underline-offset-2" to={`/proposals?dept=${enc}`}>Proposals</Link>
            {canEdit && (
              <Link className="underline underline-offset-2" to={`/settings?edit=${encodeURIComponent(`department:${row.key}`)}`} data-testid={`department-settings-${row.key}`}>
                Edit department{row.hasHead ? '' : ' (appoint a Head)'}
              </Link>
            )}
          </p>
        </div>
      </details>
    </li>
  )
}

export default function Now() {
  const auth = useAuth()
  const permissions = usePermissions()
  const actor = useTaskActor()
  const milestones = useMilestones()
  const compliance = useSubteamProgress()
  const attention = useAttention()
  const proposals = useProposals()
  const tasks = useTasks()
  const progressTasks = useTasksForProgress()
  const departments = useSubteams()
  const members = useMembers()
  useRealtimeProposals()
  useRealtimeProposalRequirements()
  useRealtimeMilestones()
  useRealtimeTasks()

  const today = todayIso()
  const myId = auth.status === 'member' ? auth.member.id : null
  const memberName = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.full_name])), [members.data])
  const deptName = useMemo(() => new Map((departments.data ?? []).map((d) => [d.key, d.name])), [departments.data])
  const taskById = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data])

  const overview = useMemo(
    () => departmentOverview(departments.data ?? [], progressTasks.data ?? [], tasks.data ?? [], compliance.data ?? [], today),
    [departments.data, progressTasks.data, tasks.data, compliance.data, today],
  )
  const overdue = attentionFor(attention.data ?? [], 'overdue')
  const blocked = attentionFor(attention.data ?? [], 'blocked')
  const upcoming = upcomingDeadlines(tasks.data ?? [], today, 14)
  const mine = myOpenTasks(tasks.data ?? [], myId)
  const deadline = nextDeadline(milestones.data ?? [], new Date())
  const points = ms1Points(milestones.data ?? [])
  const obligations = liveObligations((compliance.data ?? []).filter((row) => (departments.data ?? []).some((d) => d.key === row.key && d.archived_at === null)))
  const openProposals = openProposalsCount(proposals.data ?? [])
  const reviewQueue = actor
    ? (proposals.data ?? []).filter((p) => !isHistory(p) && (p.state === 'open' || p.state === 'agenda') && canReviewProposal(actor, p))
    : []
  const myProposals = myId ? (proposals.data ?? []).filter((p) => p.raised_by === myId && !isHistory(p)) : []
  const isReviewer = actor !== null && actor.status === 'active' && (actor.isDeveloper || actor.headOf.length > 0)

  const who = (ownerId: string | null) => (ownerId ? (memberName.get(ownerId) ?? 'someone no longer on the roster') : 'unassigned')
  const dept = (key: string | null) => (key ? (deptName.get(key) ?? key) : 'no department')
  const taskMeta = (id: string | null) => {
    const t = id ? taskById.get(id) : undefined
    if (!t) return ''
    return `${who(t.owner_id)} · ${dept(t.subteam_key)}${t.due_date ? ` · due ${formatDay(t.due_date)}` : ''}`
  }
  // The tile and the list count the same tasks (attention(), SQL-owned).
  const taskSource: Source = { isLoading: attention.isLoading || tasks.isLoading, error: attention.error ?? tasks.error, refetch: () => { void attention.refetch(); void tasks.refetch() } }
  const overviewSource: Source = {
    isLoading: departments.isLoading || progressTasks.isLoading || compliance.isLoading,
    error: departments.error ?? progressTasks.error ?? compliance.error,
    refetch: () => { void departments.refetch(); void tasks.refetch(); void compliance.refetch() },
  }

  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader title="Now" description="What needs attention today — overdue and blocked work, the next deadlines, your own tasks, and how each department stands." />

      <section aria-label="Instruments" data-tutorial="now-instruments" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <Tile testId="tile-overdue" to="/priorities?reason=overdue" label="Overdue" source={taskSource}
          value={valueOf(taskSource, () => String(overdue.length))} sub="Tasks past their deadline" tone={overdue.length > 0 ? 'bad' : 'plain'} />
        <Tile testId="tile-blocked" to="/priorities?reason=blocked" label="Blocked" source={attention}
          value={valueOf(attention, () => String(blocked.length))} sub="Rules and tasks marked blocked" tone={blocked.length > 0 ? 'bad' : 'plain'} />
        <Tile testId="tile-mine" to="/board?scope=mine" label="My open tasks" source={tasks}
          value={valueOf(tasks, () => String(mine.length))} sub={myId ? 'Assigned to you, not done' : 'Not on the roster'} />
        <Tile testId="tile-proposals" to="/proposals" label="Open proposals" source={proposals}
          value={valueOf(proposals, () => String(openProposals))} sub={isReviewer ? `${reviewQueue.length} wait for your review` : 'Suggested or under review'} />
        <Tile testId="tile-deadline" to="/milestones" label="Next submission" source={milestones}
          value={valueOf(milestones, () => (deadline.kind === 'tbc' ? 'TBC' : `${deadline.days} days`))}
          sub={deadline.kind === 'tbc' ? 'No published deadline' : `${deadline.milestoneKey} · ${deadline.name} · ${formatDay(deadline.dueOn)}`}
          tone={deadline.kind === 'due' && deadline.days <= 14 ? 'warn' : 'plain'} />
      </section>

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="departments-heading" data-tutorial="now-departments">
          <h2 id="departments-heading" className="text-sm font-semibold text-slate-900">
            Departments
          </h2>
          <p className="mb-2 text-xs text-slate-600">
            <strong className="font-medium">Work</strong> counts the department&apos;s Board tasks done (cancelled left out,
            archived Done kept). <strong className="font-medium">Requirements</strong> counts its rules marked compliant,
            verified or not applicable. They are separate measures: finishing tasks never marks a rule compliant.
          </p>
          <p className="mb-2 text-xs text-slate-700" data-testid="now-obligations">
            Across departments that are not parked:{' '}
            <strong className="font-semibold tabular-nums">
              {valueOf(compliance, () => `${obligations.resolved} / ${obligations.total}`)}
            </strong>{' '}
            requirements resolved{compliance.data ? ` (${percent(obligations.resolved, obligations.total)}%)` : ''}.
          </p>
          {overviewSource.error ? (
            <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              Department progress could not be loaded.{' '}
              <button type="button" className="font-medium underline underline-offset-2" onClick={() => void overviewSource.refetch()}>
                Try again
              </button>
            </p>
          ) : overviewSource.isLoading ? (
            <p role="status" className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              Loading department progress…
            </p>
          ) : overview.length === 0 ? (
            <p className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              No departments yet. The President or Vice President sets them up in Settings.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {overview.map((row) => (
                <DepartmentRow key={row.key} row={row} canEdit={permissions.canManageDepartments} />
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-3" data-tutorial="now-actions">
          <ActionList title="Overdue" testId="now-overdue" source={taskSource} count={overdue.length} empty="Nothing is past its deadline."
            more={{ to: '/priorities?reason=overdue', label: 'All overdue' }}>
            {overdue.slice(0, 5).map((a) => (
              <Row key={a.ref} to={`/board?task=${encodeURIComponent(a.ref ?? '')}`} title={a.title ?? 'Untitled task'} meta={taskMeta(a.ref)} tone="bad" />
            ))}
          </ActionList>

          <ActionList title="Blocked" testId="now-blocked" source={attention} count={blocked.length} empty="Nothing is marked blocked."
            more={{ to: '/priorities?reason=blocked', label: 'All blocked' }}>
            {blocked.slice(0, 5).map((a) =>
              a.kind === 'clause' ? (
                <Row key={`c-${a.clause_key}`} to={`/register?search=${encodeURIComponent(a.clause_key ?? a.ref ?? '')}`} title={`Rule ${a.ref}`} meta={`${who(a.owner_id)} · requirement`} tone="warn" />
              ) : (
                <Row key={`t-${a.ref}`} to={`/board?task=${encodeURIComponent(a.ref ?? '')}`} title={a.title ?? 'Untitled task'} meta={`${taskMeta(a.ref)} · no reason recorded`} tone="warn" />
              ),
            )}
          </ActionList>

          <ActionList title="Due in the next 14 days" testId="now-upcoming" source={tasks} count={upcoming.length} empty="No task deadline in the next two weeks.">
            {upcoming.slice(0, 5).map((t) => (
              <Row key={t.id} to={`/board?task=${encodeURIComponent(t.id)}`} title={t.title} meta={`${who(t.owner_id)} · ${dept(t.subteam_key)} · due ${formatDay(t.due_date ?? '')}`} />
            ))}
          </ActionList>

          {myId && (
            <ActionList title="My tasks" testId="now-mine" source={tasks} count={mine.length} empty="Nothing open is assigned to you."
              more={{ to: '/board?scope=mine', label: 'Open my tasks' }}>
              {mine.slice(0, 5).map((t) => (
                <Row key={t.id} to={`/board?task=${encodeURIComponent(t.id)}`} title={t.title}
                  meta={`${TASK_STATE_LABEL[t.state]} · ${dept(t.subteam_key)}${t.due_date ? ` · due ${formatDay(t.due_date)}` : ' · no deadline'}`} />
              ))}
            </ActionList>
          )}

          {isReviewer ? (
            <ActionList title="Proposals needing your review" testId="now-review" source={proposals} count={reviewQueue.length}
              empty="Nothing waits for your decision." more={{ to: '/proposals', label: 'Review on Proposals' }}>
              {reviewQueue.slice(0, 4).map((p) => (
                <Row key={p.id} to={`/proposals?dept=${encodeURIComponent(p.subteam_key ?? '')}`} title={p.title}
                  meta={`${dept(p.subteam_key)} · ${proposalStatusLabel(p)} · suggested by ${who(p.raised_by)}`} />
              ))}
            </ActionList>
          ) : (
            <ActionList title="My proposals" testId="now-my-proposals" source={proposals} count={myProposals.length}
              empty="You have no open proposals." more={{ to: '/proposals?scope=mine', label: 'See all mine' }}>
              {myProposals.slice(0, 4).map((p) => (
                <Row key={p.id} to={`/proposals?scope=mine`} title={p.title} meta={`${dept(p.subteam_key)} · ${proposalStatusLabel(p)}`} />
              ))}
            </ActionList>
          )}
          <p className="text-xs text-slate-600">
            Something needs deciding?{' '}
            <Link to="/proposals" className="font-medium underline underline-offset-2">
              Raise a proposal
            </Link>
            .
          </p>

          <section aria-label="Milestone scoring" className="rounded-lg border border-dashed border-slate-300 p-3 text-xs text-slate-600" data-testid="now-points">
            <p>
              <span className="font-medium text-slate-800">Milestone scoring:</span>{' '}
              {valueOf(milestones, () => String(points))} points are available across the MS1 deliverables. The organisers award
              them per submission; a full progress bar is not a score.{' '}
              <Link to="/milestones" className="font-medium underline underline-offset-2">
                See Milestones
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
