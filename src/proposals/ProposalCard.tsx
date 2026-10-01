import { Link } from 'react-router-dom'
import type { Member } from '../data/useMembers.ts'
import type { Task } from '../data/useTasks.ts'
import type { Proposal } from '../data/useProposals.ts'
import { formatDay } from '../lib/dates.ts'
import { TASK_PRIORITY_BADGE_TONE, TASK_PRIORITY_LABEL, isUrgent } from '../tasks/priority.ts'
import { describeBlockers, draftFrom, promotionBlockers } from './promotion.ts'
import { proposalStatusLabel, reviewActionsFor } from './proposalStates.ts'

// ONE proposal card, used by BOTH the Proposals screen and the Now screen. It
// only PRESENTS a proposal and opens one shared discussion/review dialog.
// Everyone active may discuss, the author may revise before approval, and
// review actions appear only for department authority. The database repeats
// every authority check.

type Props = {
  proposal: Proposal
  members: Member[]
  taskFromProposal?: Task
  departmentName?: string
  // Whether the proposal's department has a Head appointed. Without one only a
  // Developer can decide it (can_review_proposal), and the card says so.
  departmentHasHead?: boolean
  milestoneName?: string
  requirementCount: number
  canReview: boolean
  canDiscuss: boolean
  isAuthor: boolean
  onReview: (proposal: Proposal) => void
  // The one card the guided tour points at.
  tutorial?: boolean
}

export function ProposalCard({
  proposal,
  members,
  taskFromProposal,
  departmentName,
  departmentHasHead = true,
  milestoneName,
  requirementCount,
  canReview,
  canDiscuss,
  isAuthor,
  onReview,
  tutorial = false,
}: Props) {
  const nameOf = (id: string | null) =>
    id ? (members.find((m) => m.id === id)?.full_name ?? 'someone no longer on the roster') : null
  const promoted = Boolean(taskFromProposal)
  const owner = nameOf(proposal.owner_id)
  const suggester = nameOf(proposal.raised_by)
  const archived = proposal.archived_at !== null
  const blockers = promotionBlockers(draftFrom(proposal, requirementCount))
  const reviewable = canDiscuss && (!archived || reviewActionsFor(proposal, promoted).length > 0 || promoted)

  return (
    <li
      className="rounded-lg border border-slate-200 bg-white p-3"
      data-testid={`proposal-${proposal.id}`}
      data-proposal-state={proposal.state}
      data-tutorial={tutorial ? 'proposal-card' : undefined}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{proposal.title}</h3>
        {proposal.starred && <span aria-label="Starred">★</span>}
        {isUrgent(proposal.priority) && (
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${TASK_PRIORITY_BADGE_TONE.urgent}`}>
            {TASK_PRIORITY_LABEL.urgent}
          </span>
        )}
        {proposal.state === 'parked' && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900" data-testid={`proposal-parked-${proposal.id}`}>
            Parked
          </span>
        )}
      </div>
      {proposal.context && <p className="mt-0.5 text-sm text-slate-600">{proposal.context}</p>}
      <p className="mt-0.5 text-xs text-slate-500">
        Suggested{suggester ? ` by ${suggester}` : ''} on {proposal.raised_on}
      </p>
      <p className="mt-0.5 text-xs text-slate-600" data-testid={`proposal-facts-${proposal.id}`}>
        {departmentName ?? 'No department'}
        {proposal.due_date ? ` · due ${formatDay(proposal.due_date)}` : ' · no deadline'}
        {milestoneName ? ` · ${milestoneName}` : ''}
        {` · ${requirementCount} ${requirementCount === 1 ? 'requirement' : 'requirements'}`}
      </p>

      {proposal.legacy_incomplete && (
        <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900" data-testid={`proposal-legacy-${proposal.id}`}>
          Older proposal: it needs {describeBlockers(blockers) || 'its details confirmed'} before it can become a task.
        </p>
      )}

      <p className="mt-2 text-sm text-slate-700" data-testid={`proposal-status-${proposal.id}`}>
        <span className="font-medium">{proposalStatusLabel(proposal)}</span>
        {owner ? ` · with ${owner}` : ''}
      </p>
      {proposal.decision && (
        <p className="mt-1 rounded bg-slate-50 p-2 text-sm text-slate-700">
          <span className="font-medium">Reviewer note:</span> {proposal.decision}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2" data-tutorial={tutorial ? 'proposal-promote' : undefined}>
        {promoted ? (
          <>
            <span
              className="pc-fade-in inline-flex flex-wrap items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700"
              data-testid={`proposal-promoted-${proposal.id}`}
            >
              Created the task “{taskFromProposal?.title}”
              <Link
                to={`/board?task=${encodeURIComponent(taskFromProposal?.id ?? '')}`}
                className="inline-flex min-h-11 items-center rounded font-medium text-slate-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
              >
                Open on Board
              </Link>
            </span>
            {canDiscuss && <button type="button" className="text-xs font-medium underline underline-offset-2" onClick={() => onReview(proposal)}>View discussion</button>}
          </>
        ) : reviewable ? (
          <button
            type="button"
            onClick={() => onReview(proposal)}
            data-testid={`review-open-${proposal.id}`}
            data-tutorial={tutorial ? 'proposal-decision' : undefined}
            className="min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            {canReview ? 'Review' : isAuthor ? 'Discuss or revise' : 'Discussion'}
          </button>
        ) : null}
      </div>
      {!canReview && !archived && (
        <p className="mt-2 text-xs text-slate-500" data-testid={`proposal-hint-${proposal.id}`}>
          {!departmentName
            ? 'The missing details must be completed before this older proposal can become a board task.'
            : departmentHasHead
              ? `The Head of ${departmentName}, the President or the Vice President decides whether this becomes a board task.`
              : `${departmentName} has no active Head. The President or Vice President decides for it.`}
        </p>
      )}
    </li>
  )
}
