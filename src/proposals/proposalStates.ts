import type { Proposal, ProposalState } from './types.ts'

// A proposal's stages, in the order it moves through them, with the words
// people see. The stored values are the original topic_state enum, so no row
// had to change when the concept was renamed
// (20260108000000_proposals_and_meetings.sql documents the mapping).
export const PROPOSAL_STATES: { value: ProposalState; label: string }[] = [
  { value: 'open', label: 'Suggested' },
  { value: 'agenda', label: 'Under review' },
  { value: 'changes_requested', label: 'Changes requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'decided', label: 'Decided' },
  { value: 'parked', label: 'Parked' },
]

export function proposalStateLabel(state: ProposalState): string {
  return PROPOSAL_STATES.find((s) => s.value === state)?.label ?? state
}

// The four review commands review_proposal() accepts (ADR-0005). A stage is
// never written directly any more: the database refuses a direct UPDATE of
// state, outcome or archive fields.
export type ReviewAction = 'review' | 'park' | 'reject' | 'reopen'

export const REVIEW_ACTION_LABEL: Record<ReviewAction, string> = {
  review: 'Take under review',
  park: 'Park',
  reject: 'Reject',
  reopen: 'Reopen',
}

type Stage = Pick<Proposal, 'state' | 'outcome' | 'archived_at'>

// Mirrors review_proposal()'s transition table exactly, so a control is only
// offered when the database would accept it. `hasTask` is whether a task
// already points at this proposal (an approved proposal cannot be reopened).
export function reviewActionsFor(proposal: Stage, hasTask: boolean): ReviewAction[] {
  if (hasTask || proposal.outcome === 'approved') return []
  if (proposal.archived_at !== null && proposal.state !== 'decided') return []
  switch (proposal.state) {
    case 'open':
      return ['review', 'park', 'reject']
    case 'agenda':
    case 'changes_requested':
    case 'approved':
      return ['park', 'reject']
    case 'parked':
      return ['reopen']
    case 'decided':
      return ['reopen']
  }
}

// One status line for a card: the stage, or — once decided — what was decided.
export function proposalStatusLabel(proposal: Pick<Proposal, 'state' | 'outcome'>): string {
  if (proposal.state === 'decided') {
    if (proposal.outcome === 'approved') return 'Approved'
    if (proposal.outcome === 'rejected') return 'Rejected'
    return 'Decided (outcome not recorded)'
  }
  return proposalStateLabel(proposal.state)
}

// Can this proposal be promoted right now? (promote_proposal()'s own checks:
// open or under review, not archived, and not an older proposal that still
// needs its required details.)
export function isPromotable(proposal: Pick<Proposal, 'state' | 'archived_at' | 'legacy_incomplete'>): boolean {
  return (
    proposal.state === 'approved' &&
    proposal.archived_at === null &&
    !proposal.legacy_incomplete
  )
}
