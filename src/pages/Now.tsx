import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context.ts'
import { canReviewProposal, reviewsAnyProposal } from '../auth/permissions.ts'
import { useMembers } from '../data/useMembers.ts'
import { useMilestones } from '../data/useMilestones.ts'
import { useAttention, useBookProgress } from '../data/useNowMetrics.ts'
import { useProposals } from '../data/useProposals.ts'
import { useRealtimeMilestones } from '../data/useRealtimeMilestones.ts'
import { useRealtimeProposalRequirements } from '../data/useRealtimeProposalRequirements.ts'
import { useRealtimeProposalComments } from '../data/useRealtimeProposalComments.ts'
import { useRealtimeProposals } from '../data/useRealtimeProposals.ts'
import { useRealtimeTasks } from '../data/useRealtimeTasks.ts'
import { useSubteams } from '../data/useSubteams.ts'
import { useRealtimeClauseStatus } from '../data/useRealtimeClauseStatus.ts'
import { useTaskActor } from '../data/useTaskActor.ts'
import { useTasks } from '../data/useTasks.ts'
import { formatDay, todayIso } from '../lib/dates.ts'
import { isHistory } from '../proposals/filters.ts'
import { proposalStatusLabel } from '../proposals/proposalStates.ts'
import { TASK_STATE_LABEL } from '../tasks/taskState.ts'
import { pageMain } from '../ui/layout.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import {
  attentionFor,
  bookProgressTree,
  bookTotals,
  ms1Points,
  myOpenTasks,
  nextDeadline,
  openProposalsCount,
  percent,
  upcomingDeadlines,
  type BookChapter,
  type BookUnit,
} from './now/nowModel.ts'

// The screen people keep open while working: what needs doing next, and how
// the requirements stand, chapter by chapter of the Requirements Book. Every
// number is reproducible (docs/now-metrics.sql)
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

// What a chapter or article row says, in its four honest states.
function bookCountsText(unit: BookUnit): string {
  switch (unit.status) {
    case 'measured':
      return `${unit.counts.resolved}/${unit.counts.requirements} resolved`
    case 'no-requirements':
      return `no team requirements (${unit.counts.importedRules} rule${unit.counts.importedRules === 1 ? '' : 's'})`
    case 'not-imported':
      return 'not imported'
    case 'out-of-scope':
      return unit.page ? `not this category — p. ${unit.page}` : 'not this category'
    case 'no-rules-in-book':
      return 'no numbered rules in the book'
  }
}

const BOOK_STATUS_NOTE: Record<Exclude<BookUnit['status'], 'measured'>, string> = {
  'no-requirements': 'Its rules are in the Register, but none places a duty on the team.',
  'not-imported': 'The book numbers rules here, but none is in the Register — missing data, not zero.',
  'out-of-scope': 'Specific to another competition category than this season’s, so its rules are deliberately not imported — not missing data.',
  'no-rules-in-book': 'The book has no numbered rules here.',
}

function BookUnitRow({
  unit,
  testId,
  toggle,
}: {
  unit: BookUnit
  testId: string
  toggle?: { expanded: boolean; onToggle: () => void; controls: string }
}) {
  const heading = (
    <>
      <span className="font-medium">{unit.label}</span>
      <span className="block break-words text-xs font-normal text-slate-600">{unit.heading}</span>
    </>
  )
  return (
    <div
      className="grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] sm:items-center"
      data-testid={testId}
    >
      <span className="flex min-w-0 items-start gap-1.5 text-sm text-slate-900">
        {toggle ? (
          <button
            type="button"
            onClick={toggle.onToggle}
            aria-expanded={toggle.expanded}
            aria-controls={toggle.controls}
            aria-label={`${toggle.expanded ? 'Hide' : 'Show'} the parts of ${unit.label}`}
            className="mt-0.5 shrink-0 rounded px-0.5 text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            <span aria-hidden="true" className={`inline-block transition-transform ${toggle.expanded ? 'rotate-90' : ''}`}>
              ▸
            </span>
          </button>
        ) : (
          <span aria-hidden="true" className="w-3.5 shrink-0" />
        )}
        {unit.registerFilter ? (
          <Link
            to={`/register?chapter=${encodeURIComponent(unit.registerFilter)}&group=book`}
            className="min-w-0 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
            data-testid={`${testId}-link`}
          >
            {heading}
          </Link>
        ) : (
          <span className="min-w-0">{heading}</span>
        )}
      </span>
      <span className="min-w-0">
        <span className="flex justify-between gap-2 text-[11px] text-slate-600">
          <span className="tabular-nums" data-testid={`${testId}-counts`}>
            {bookCountsText(unit)}
          </span>
          {unit.percent !== null && <span className="tabular-nums">{unit.percent}%</span>}
        </span>
        {unit.status === 'measured' ? (
          <Bar value={unit.percent} tone="bg-emerald-700" />
        ) : (
          <span className={`block text-[11px] ${unit.status === 'not-imported' ? 'text-amber-900' : 'text-slate-500'}`}>
            {BOOK_STATUS_NOTE[unit.status]}
          </span>
        )}
        {unit.counts.notApplicable > 0 && (
          <span className="block text-[11px] text-slate-600" data-testid={`${testId}-na`}>
            {unit.counts.notApplicable} not applicable (counted as resolved)
          </span>
        )}
      </span>
    </div>
  )
}

function BookChapterRow({ chapter }: { chapter: BookChapter }) {
  const [expanded, setExpanded] = useState(false)
  const listId = `book-chapter-${chapter.id}-parts`
  return (
    <li>
      <BookUnitRow
        unit={chapter}
        testId={`book-chapter-${chapter.id}`}
        toggle={chapter.subchapters.length > 0 ? { expanded, onToggle: () => setExpanded((v) => !v), controls: listId } : undefined}
      />
      {chapter.subchapters.length > 0 && (
        <ul id={listId} hidden={!expanded} className="divide-y divide-slate-100 border-t border-slate-100 bg-slate-50 pl-5">
          {chapter.subchapters.map((sub) => (
            <li key={sub.id}>
              <BookUnitRow unit={sub} testId={`book-sub-${sub.id}`} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export default function Now() {
  const auth = useAuth()
  const actor = useTaskActor()
  const milestones = useMilestones()
  const bookProgress = useBookProgress()
  const attention = useAttention()
  const proposals = useProposals()
  const tasks = useTasks()
  const departments = useSubteams()
  const members = useMembers()
  useRealtimeProposals()
  useRealtimeProposalRequirements()
  useRealtimeProposalComments()
  useRealtimeMilestones()
  useRealtimeTasks()
  // A rule marked compliant elsewhere moves its chapter's bar here.
  useRealtimeClauseStatus()

  const today = todayIso()
  const myId = auth.status === 'member' ? auth.member.id : null
  const memberName = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.full_name])), [members.data])
  const deptName = useMemo(() => new Map((departments.data ?? []).map((d) => [d.key, d.name])), [departments.data])
  const taskById = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data])

  const chapters = useMemo(() => bookProgressTree(bookProgress.data ?? []), [bookProgress.data])
  const bookTotal = bookTotals(chapters)
  // Chapters with no rules of their own are listed apart from the ones being tracked.
  const isRuleless = (c: BookChapter) => c.status === 'out-of-scope' || c.status === 'no-rules-in-book'
  const trackedChapters = chapters.filter((c) => !isRuleless(c))
  const rulelessChapters = chapters.filter(isRuleless)
  const notImported = chapters.filter((c) => c.status === 'not-imported')
  const overdue = attentionFor(attention.data ?? [], 'overdue')
  const blocked = attentionFor(attention.data ?? [], 'blocked')
  const upcoming = upcomingDeadlines(tasks.data ?? [], today, 14)
  const mine = myOpenTasks(tasks.data ?? [], myId)
  const deadline = nextDeadline(milestones.data ?? [], new Date())
  const points = ms1Points(milestones.data ?? [])
  const openProposals = openProposalsCount(proposals.data ?? [])
  const reviewQueue = actor
    ? (proposals.data ?? []).filter((p) => !isHistory(p) && (p.state === 'open' || p.state === 'agenda') && canReviewProposal(actor, p))
    : []
  const myProposals = myId ? (proposals.data ?? []).filter((p) => p.raised_by === myId && !isHistory(p)) : []
  const isReviewer = actor !== null && reviewsAnyProposal(actor)

  const who = (ownerId: string | null) => (ownerId ? (memberName.get(ownerId) ?? 'someone no longer on the roster') : 'unassigned')
  const dept = (key: string | null) => (key ? (deptName.get(key) ?? key) : 'no department')
  const taskMeta = (id: string | null) => {
    const t = id ? taskById.get(id) : undefined
    if (!t) return ''
    return `${who(t.owner_id)} · ${dept(t.subteam_key)}${t.due_date ? ` · due ${formatDay(t.due_date)}` : ''}`
  }
  // The tile and the list count the same tasks (attention(), SQL-owned).
  const taskSource: Source = { isLoading: attention.isLoading || tasks.isLoading, error: attention.error ?? tasks.error, refetch: () => { void attention.refetch(); void tasks.refetch() } }

  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader title="Now" description="What needs attention today — overdue and blocked work, the next deadlines, your own tasks, and how the requirements stand, chapter by chapter." />

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
        <section aria-labelledby="requirements-heading" data-tutorial="now-requirements">
          <h2 id="requirements-heading" className="text-sm font-semibold text-slate-900">
            Requirements progress
          </h2>
          <p className="mb-2 text-xs text-slate-600">
            The rules that place a duty on the team, in the Requirements Book&apos;s own chapters. Resolved means marked
            compliant, verified or not applicable in the Register. Finishing tasks never marks a rule compliant, and a
            rule&apos;s department does not change where it is counted.
          </p>
          <p className="mb-2 text-xs text-slate-700" data-testid="now-requirements-total">
            Across the book:{' '}
            <strong className="font-semibold tabular-nums">
              {valueOf(bookProgress, () => `${bookTotal.resolved} / ${bookTotal.requirements}`)}
            </strong>{' '}
            requirements resolved
            {bookProgress.data ? ` (${percent(bookTotal.resolved, bookTotal.requirements)}%)` : ''}
            {bookProgress.data && bookTotal.notApplicable > 0 ? ` · ${bookTotal.notApplicable} not applicable` : ''}.
            {bookProgress.data && notImported.length > 0 && (
              <span className="block text-amber-900">
                Not imported, so not counted: {notImported.map((c) => c.label).join(', ')}.
              </span>
            )}
          </p>
          {bookProgress.error ? (
            <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              Requirements progress could not be loaded.{' '}
              <button type="button" className="font-medium underline underline-offset-2" onClick={() => void bookProgress.refetch()}>
                Try again
              </button>
            </p>
          ) : bookProgress.isLoading ? (
            <p role="status" className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              Loading requirements progress…
            </p>
          ) : chapters.length === 0 ? (
            <p className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              This season&apos;s regulations edition has no chapter outline recorded, so progress cannot be shown by chapter.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white" data-testid="now-book-chapters">
              {trackedChapters.map((chapter) => (
                <BookChapterRow key={chapter.id} chapter={chapter} />
              ))}
            </ul>
          )}
          {rulelessChapters.length > 0 && !bookProgress.isLoading && !bookProgress.error && (
            <>
              <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-600">
                No requirements to track
              </h3>
              <ul className="divide-y divide-slate-200 rounded-lg border border-dashed border-slate-300 bg-slate-50" data-testid="now-book-chapters-untracked">
                {rulelessChapters.map((chapter) => (
                  <BookChapterRow key={chapter.id} chapter={chapter} />
                ))}
              </ul>
            </>
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
