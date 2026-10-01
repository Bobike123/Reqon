import { milestoneLabel } from '../milestones/label.ts'
import type { UseQueryResult } from '@tanstack/react-query'
import { useCallback, useId, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context.ts'
import { canReviewProposal, reviewsAnyProposal } from '../auth/permissions.ts'
import { usePermissions } from '../auth/usePermissions.ts'
import type { RealtimeState } from '../data/realtime.ts'
import { useClauses } from '../data/useClauses.ts'
import { useMembers } from '../data/useMembers.ts'
import { useMilestones } from '../data/useMilestones.ts'
import { useProposalComments, useProposalRequirements, useSubmitProposal, type NewProposal, type Proposal } from '../data/useProposals.ts'
import { useSubteams } from '../data/useSubteams.ts'
import { useTaskActor } from '../data/useTaskActor.ts'
import { useTasks } from '../data/useTasks.ts'
import { DepartmentNav } from '../departments/DepartmentNav.tsx'
import { resolveDepartmentParam } from '../departments/filter.ts'
import { formatDay } from '../lib/dates.ts'
import { mergeSearchParams } from '../lib/searchParams.ts'
import { buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ErrorState } from '../ui/states.tsx'
import {
  ALL_DEPARTMENTS,
  departmentChoices,
  filterProposals,
  isHistory,
  scopeCounts,
  type ProposalFilter,
} from './filters.ts'
import { ProposalCard } from './ProposalCard.tsx'
import { ProposalFilters } from './ProposalFilters.tsx'
import { ProposalForm, type Option } from './ProposalForm.tsx'
import { proposalStatusLabel } from './proposalStates.ts'
import { ReviewDialog } from './ReviewDialog.tsx'
import { buildRequirementOptions } from './requirementOptions.ts'
import { useUrlParams } from '../lib/useUrlParams.ts'

// The proposal workspace on the Proposals screen. It only COMPOSES: the
// department navigation, the reviewer's queue, the member's own status, the
// form, the filters, the card and the review dialog are separate, and every
// write goes through a Phase 3 database command via the data hooks
// (submit, comment, revise, request changes, approve and promote) — never
// several writes assembled here.
//
// Where you are (department, All/My, queue/history) lives in the address, so a
// refresh or a shared link keeps it. Who sees the review queue follows the
// existing authority exactly (canReviewProposal mirrors can_review_proposal():
// the department's Head, or a Developer); the database decides again.
export function ProposalsPanel({
  heading,
  mode = 'full',
  emptyHint,
  layout = 'stack',
  proposals,
  realtime,
}: {
  heading: string
  mode?: 'queue' | 'full'
  emptyHint: string
  layout?: 'stack' | 'wide'
  proposals: UseQueryResult<Proposal[], Error>
  realtime: RealtimeState
}) {
  const auth = useAuth()
  const can = usePermissions()
  const members = useMembers()
  const tasks = useTasks()
  const departments = useSubteams()
  const milestones = useMilestones()
  const clauses = useClauses()
  const links = useProposalRequirements()
  const comments = useProposalComments()
  const actor = useTaskActor()
  const submitProposal = useSubmitProposal()
  const wide = layout === 'wide'
  const viewerId = auth.status === 'member' ? auth.member.id : null
  const formId = useId()
  const [params, setParams] = useUrlParams()

  const all = useMemo(() => proposals.data ?? [], [proposals.data])
  const departmentList = useMemo(() => departments.data ?? [], [departments.data])

  // The filter, read from the address. An unknown department falls back to all
  // departments with a notice, like the Board.
  const { filter, notice } = useMemo(() => {
    const scope: ProposalFilter['scope'] = params.get('scope') === 'mine' ? 'mine' : 'all'
    const view: ProposalFilter['view'] = mode === 'queue' ? 'queue' : params.get('view') === 'history' ? 'history' : 'queue'
    const raw = params.get('dept')
    if (!departments.data) return { filter: { scope, view, department: raw ?? ALL_DEPARTMENTS }, notice: null }
    const { department, notice: deptNotice } = resolveDepartmentParam(raw, departments.data)
    return { filter: { scope, view, department }, notice: deptNotice }
  }, [params, mode, departments.data])
  const view = filter.view
  const setFilter = (next: ProposalFilter) =>
    setParams(
      (current) =>
        mergeSearchParams(current, {
          scope: next.scope === 'mine' ? 'mine' : null,
          dept: next.department !== ALL_DEPARTMENTS ? next.department : null,
          view: next.view === 'history' ? 'history' : null,
        }),
      { replace: true },
    )

  const [reviewing, setReviewing] = useState<Proposal | null>(null)
  const [message, setMessage] = useState<{ text: string; toBoard: boolean } | null>(null)
  // The form is folded away until someone wants it, but stays MOUNTED (hidden),
  // so a half-written proposal survives closing and reopening it.
  const [formOpen, setFormOpen] = useState(false)

  const tasksByProposal = useMemo(() => {
    const map = new Map<string, NonNullable<typeof tasks.data>[number]>()
    for (const task of tasks.data ?? []) if (task.source_proposal) map.set(task.source_proposal, task)
    return map
  }, [tasks.data])

  const keysByProposal = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const link of links.data ?? []) map.set(link.proposal_id, [...(map.get(link.proposal_id) ?? []), link.clause_key])
    return map
  }, [links.data])
  const commentsByProposal = useMemo(() => {
    const map = new Map<string, NonNullable<typeof comments.data>>()
    for (const entry of comments.data ?? []) map.set(entry.proposal_id, [...(map.get(entry.proposal_id) ?? []), entry])
    return map
  }, [comments.data])

  // New selections offer only what is valid now: active departments, active
  // members, and this season's milestones.
  const departmentOptions = useMemo<Option[]>(
    () => departmentList.filter((d) => d.archived_at === null).map((d) => ({ value: d.key, label: d.name })),
    [departmentList],
  )
  const ownerOptions = useMemo<Option[]>(
    () => (members.data ?? []).filter((m) => m.status === 'active').map((m) => ({ value: m.id, label: m.full_name })),
    [members.data],
  )
  const milestoneOptions = useMemo<Option[]>(
    () => (milestones.data ?? []).map((m) => ({ value: m.key, label: `${milestoneLabel(m)} — ${m.name}` })),
    [milestones.data],
  )
  const requirementOptions = useMemo(() => buildRequirementOptions(clauses.data ?? []), [clauses.data])

  const visible = useMemo(() => filterProposals(all, filter, viewerId), [all, filter.scope, filter.department, filter.view, viewerId]) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => scopeCounts(all, filter, viewerId), [all, filter.department, filter.view, viewerId]) // eslint-disable-line react-hooks/exhaustive-deps
  const viewCounts = useMemo(
    () => ({ queue: all.filter((p) => !isHistory(p)).length, history: all.filter(isHistory).length }),
    [all],
  )
  const choices = useMemo(() => departmentChoices(departmentList, all, view), [departmentList, all, view])

  const nameOfDepartment = useCallback((key: string | null) => (key ? departmentList.find((d) => d.key === key)?.name : undefined), [departmentList])
  const hasHead = useCallback((key: string | null) => {
    if (!key) return false
    const department = departmentList.find((item) => item.key === key)
    const parent = department?.parent_key ? departmentList.find((item) => item.key === department.parent_key) : undefined
    const activeIds = new Set((members.data ?? []).filter((member) => member.status === 'active').map((member) => member.id))
    return Boolean((department?.lead_id && activeIds.has(department.lead_id)) || (parent?.lead_id && activeIds.has(parent.lead_id)))
  }, [departmentList, members.data])
  const nameOfMilestone = useCallback((key: string | null) => (key ? milestones.data?.find((m) => m.key === key)?.name : undefined), [milestones.data])
  const nameOfMember = useCallback((id: string | null) => (id ? (members.data ?? []).find((m) => m.id === id)?.full_name : undefined), [members.data])

  // The reviewer's queue: unresolved proposals this person may decide, by the same
  // rule the Review button uses. A Head of several departments sees all of them.
  const reviewer = actor !== null && reviewsAnyProposal(actor)
  const reviewQueue = useMemo(
    () =>
      actor
        ? all
            .filter((p) => !isHistory(p) && ['open', 'agenda', 'changes_requested', 'approved'].includes(p.state) && canReviewProposal(actor, p))
            .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
        : [],
    [all, actor],
  )
  const queueByDepartment = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of reviewQueue) if (p.subteam_key) map.set(p.subteam_key, (map.get(p.subteam_key) ?? 0) + 1)
    return map
  }, [reviewQueue])

  // The member's own proposals, by where they stand.
  const mine = useMemo(() => (viewerId ? all.filter((p) => p.raised_by === viewerId) : []), [all, viewerId])

  const onRaise = useCallback(async (proposal: NewProposal) => {
    await submitProposal.mutateAsync(proposal)
  }, [submitProposal])

  const formLoading = departments.isLoading || milestones.isLoading || clauses.isLoading
  const formError = (departments.error ?? milestones.error ?? clauses.error)?.message ?? null
  const filtersActive = filter.scope !== 'all' || filter.department !== 'all'

  const list = (
    <div className={wide ? 'mt-3 space-y-2 lg:mt-0' : 'mt-2 space-y-2'}>
      {proposals.error && (
        <ErrorState title="Could not load proposals" error={proposals.error} onRetry={() => void proposals.refetch()} />
      )}

      {!proposals.error && !proposals.isLoading && visible.length === 0 && (
        <p className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600" data-testid="proposal-empty-list">
          {filtersActive ? (
            <>
              No proposals match these filters.{' '}
              <button
                type="button"
                onClick={() => setFilter({ scope: 'all', department: ALL_DEPARTMENTS, view: filter.view })}
                className="font-medium text-slate-900 underline underline-offset-2"
              >
                Clear filters
              </button>
            </>
          ) : view === 'history' ? (
            'Nothing has been decided yet. Approved and rejected proposals appear here.'
          ) : (
            emptyHint
          )}
        </p>
      )}

      <ul className={wide ? 'grid items-start gap-3 xl:grid-cols-2 min-[100rem]:grid-cols-3' : 'space-y-2'} data-testid="proposal-list">
        {visible.map((proposal, index) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            members={members.data ?? []}
            taskFromProposal={tasksByProposal.get(proposal.id)}
            departmentName={nameOfDepartment(proposal.subteam_key)}
            departmentHasHead={hasHead(proposal.subteam_key)}
            milestoneName={nameOfMilestone(proposal.milestone_key)}
            requirementCount={keysByProposal.get(proposal.id)?.length ?? 0}
            canReview={actor !== null && canReviewProposal(actor, proposal)}
            canDiscuss={actor?.status === 'active'}
            isAuthor={viewerId === proposal.raised_by}
            onReview={setReviewing}
            tutorial={index === 0}
          />
        ))}
      </ul>
    </div>
  )

  const reviewArea = reviewer && mode === 'full' && (
    <section aria-labelledby={`${formId}-review`} data-tutorial="proposal-review-queue" className="rounded-lg border border-slate-300 bg-white p-3" data-testid="proposal-review-queue">
      <h3 id={`${formId}-review`} className="text-sm font-semibold text-slate-900">
        Needs your review{' '}
        <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-medium text-white tabular-nums" data-testid="proposal-review-count">
          {reviewQueue.length}
        </span>
      </h3>
      <p className="mt-0.5 text-xs text-slate-600">
        {actor?.isDeveloper || actor?.isGovernance
          ? 'You may decide proposals in any department.'
          : `Proposals you may decide${actor?.headOf.length ? ` as Head for ${(actor.headOf).map((k) => nameOfDepartment(k) ?? k).join(', ')}` : ''}.`}
      </p>
      {queueByDepartment.size > 1 && (
        <ul className="mt-2 flex flex-wrap gap-1.5 text-xs" aria-label="Waiting per department">
          {[...queueByDepartment].map(([key, n]) => (
            <li key={key}>
              <button type="button" onClick={() => setFilter({ ...filter, department: key, view: 'queue' })} className="rounded-full border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-50">
                {nameOfDepartment(key) ?? key} <span className="tabular-nums text-slate-500">{n}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {reviewQueue.length === 0 ? (
        <p className="mt-2 text-sm text-slate-700">Nothing is waiting for your decision.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {reviewQueue.slice(0, 6).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm" data-testid={`review-queue-${p.id}`}>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-slate-900">{p.title}</span>
                <span className="block text-xs text-slate-600">
                  {nameOfDepartment(p.subteam_key) ?? 'No department'} · {proposalStatusLabel(p)}
                  {p.due_date ? ` · due ${formatDay(p.due_date)}` : ''} · suggested by {nameOfMember(p.raised_by) ?? 'someone'}
                </span>
              </span>
              <button type="button" className={buttonSecondary} onClick={() => setReviewing(p)}>
                Review<span className="sr-only"> {p.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {reviewQueue.length > 6 && <p className="mt-1 text-xs text-slate-600">{reviewQueue.length - 6} more in the list below.</p>}
    </section>
  )

  const myStatus = viewerId && mode === 'full' && (
    <section aria-labelledby={`${formId}-mine`} className="rounded-lg border border-slate-200 bg-white p-3" data-testid="proposal-mine">
      <h3 id={`${formId}-mine`} className="text-sm font-semibold text-slate-900">
        Your proposals
      </h3>
      {mine.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">You have not suggested anything this season.</p>
      ) : (
        <>
          <ul className="mt-1 space-y-1 text-sm">
            {mine.slice(0, 4).map((p) => {
              const task = tasksByProposal.get(p.id)
              return (
                <li key={p.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-slate-900">{p.title}</span>
                  <span className="text-xs text-slate-600">{proposalStatusLabel(p)}</span>
                  {task && (
                    <Link to={`/board?task=${encodeURIComponent(task.id)}`} className="text-xs underline underline-offset-2">
                      Open its task
                    </Link>
                  )}
                  {p.decision && <span className="block w-full text-xs text-slate-600">Reviewer note: {p.decision}</span>}
                </li>
              )
            })}
          </ul>
          {filter.scope !== 'mine' && (
            <button type="button" onClick={() => setFilter({ ...filter, scope: 'mine' })} className="mt-1 text-xs font-medium underline underline-offset-2">
              Show only mine ({mine.length})
            </button>
          )}
        </>
      )}
    </section>
  )

  const form = (
    <div className="rounded-lg border border-slate-200 bg-white p-3" data-tutorial="proposal-raise">
      <button
        type="button"
        className={formOpen ? buttonSecondary : buttonPrimary}
        aria-expanded={formOpen}
        aria-controls={`${formId}-form`}
        onClick={() => setFormOpen((open) => !open)}
        data-testid="proposal-form-toggle"
      >
        {formOpen ? 'Hide the proposal form' : 'Raise a proposal'}
      </button>
      <p className="mt-1 text-xs text-slate-600">Anyone on the roster may suggest work for any active department.</p>
      <div id={`${formId}-form`} hidden={!formOpen} className="mt-3">
        <ProposalForm
          departments={departmentOptions}
          milestones={milestoneOptions}
          owners={ownerOptions}
          requirements={requirementOptions}
          onRaise={onRaise}
          pending={submitProposal.isPending}
          canConfigure={can.canManageDepartments}
          loading={formLoading}
          loadError={formError}
        />
      </div>
    </div>
  )

  const filters = (
    <ProposalFilters
      filter={filter}
      onChange={setFilter}
      counts={counts}
      departments={choices}
      showViews={mode === 'full'}
      viewCounts={viewCounts}
      shown={visible.length}
      showDepartment={false}
    />
  )

  return (
    <section aria-labelledby="proposals-heading" data-tutorial="proposals-panel">
      <DepartmentNav choices={choices} value={filter.department} testId="proposal-departments" />
      {notice && (
        <p role="status" className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" data-testid="proposal-filter-notice">
          {notice}
        </p>
      )}

      <h2 id="proposals-heading" className="mb-2 text-sm font-semibold text-slate-900">
        {heading}
        <span className="ml-2 text-xs font-normal text-slate-500" data-testid="proposals-realtime-state" title="Live updates from other people editing">
          · live updates: {realtime}
        </span>
      </h2>

      {message && (
        <p role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded bg-emerald-50 p-2 text-sm text-emerald-900" data-testid="proposal-message">
          {message.text}
          {message.toBoard && (
            <Link to="/board" className="inline-flex min-h-11 items-center font-medium underline underline-offset-2 sm:min-h-0">
              Open the Board
            </Link>
          )}
        </p>
      )}

      {wide ? (
        <div className="lg:grid lg:grid-cols-[minmax(17rem,24rem)_minmax(0,1fr)] lg:items-start lg:gap-6">
          <div className="space-y-3">
            {reviewArea}
            {myStatus}
            {form}
            <ProposalTally proposals={all} promoted={tasksByProposal.size} />
          </div>
          <div className="space-y-3">
            {filters}
            {list}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {reviewArea}
          {myStatus}
          {form}
          {filters}
          {list}
        </div>
      )}

      <ReviewDialog
        proposal={reviewing}
        members={members.data ?? []}
        departments={departmentOptions}
        milestones={milestoneOptions}
        requirementOptions={requirementOptions}
        requirementKeys={reviewing ? (keysByProposal.get(reviewing.id) ?? []) : []}
        comments={reviewing ? (commentsByProposal.get(reviewing.id) ?? []) : []}
        canReview={reviewing !== null && actor !== null && canReviewProposal(actor, reviewing)}
        isAuthor={reviewing !== null && viewerId === reviewing.raised_by}
        isDeveloper={actor?.isDeveloper ?? false}
        hasTask={reviewing ? tasksByProposal.has(reviewing.id) : false}
        onClose={() => setReviewing(null)}
        onDone={(text, options) => setMessage({ text, toBoard: options?.toBoard ?? false })}
      />
    </section>
  )
}

// Where every proposal stands, as plain numbers. Deliberately not a set of
// filters: a card that vanished the moment someone changed its state would
// pull the discussion out from under the room.
function ProposalTally({ proposals, promoted }: { proposals: Proposal[]; promoted: number }) {
  const live = proposals.filter((p) => !isHistory(p))
  const count = (state: Proposal['state']) => live.filter((p) => p.state === state).length
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3" data-tutorial="proposal-flow">
      <h3 className="text-xs font-medium text-slate-600">How a proposal moves</h3>
      <ol className="mt-2 space-y-1 text-sm">
        {[
          ['Suggested', count('open')],
          ['Under review / changes requested', count('agenda') + count('changes_requested')],
          ['Approved, awaiting task', count('approved')],
          ['Board task created', promoted],
        ].map(([label, n], index) => (
          <li key={label as string} className="flex items-baseline justify-between gap-3">
            <span className="text-slate-800">
              <span className="text-slate-500">{index + 1}.</span> {label}
            </span>
            <span className="text-slate-700 tabular-nums">
              {n}
              <span className="sr-only"> proposals</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-pretty text-slate-600">
        The department&apos;s Head reviews these; where there is no active Head, the President or Vice President acts.{' '}
        Parked proposals (<span className="tabular-nums">{count('parked')}</span>) stay in the queue, marked; rejected and promoted proposals move to History.
      </p>
    </div>
  )
}
