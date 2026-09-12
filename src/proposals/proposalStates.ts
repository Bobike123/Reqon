import type { ProposalState } from '../data/useProposals.ts'

// A proposal's stages, in the order it moves through them, with the words
// people see. The stored values are the original topic_state enum, so no row
// had to change when the concept was renamed
// (20260108000000_proposals_and_meetings.sql documents the mapping).
export const PROPOSAL_STATES: { value: ProposalState; label: string }[] = [
  { value: 'open', label: 'Suggested' },
  { value: 'agenda', label: 'Under review' },
  { value: 'decided', label: 'Decided' },
  { value: 'parked', label: 'Parked' },
]

export function proposalStateLabel(state: ProposalState): string {
  return PROPOSAL_STATES.find((s) => s.value === state)?.label ?? state
}
