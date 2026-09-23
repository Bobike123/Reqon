import type { Database } from '../lib/database.types.ts'

// The proposal domain's own type aliases (Phase 6 §6.5) — see tasks/types.ts
// for why this exists apart from data/useProposals.ts.
export type Proposal = Database['public']['Tables']['task_proposals']['Row']
export type ProposalState = Database['public']['Enums']['topic_state']
