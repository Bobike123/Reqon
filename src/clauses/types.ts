import type { Database } from '../lib/database.types.ts'

// The clause domain's own type aliases (Phase 6 §6.5) — see tasks/types.ts
// for why this exists apart from data/useClauses.ts / data/useClauseStatus.ts.
// `Clause` is the rulebook row; `ClauseStatus` is what the team did about it.
export type Clause = Database['public']['Tables']['clauses']['Row']
export type ClauseStatus = Database['public']['Tables']['clause_status']['Row']
export type ClauseState = Database['public']['Enums']['clause_state']
