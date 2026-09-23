import type { Database } from '../lib/database.types.ts'

// The milestone domain's own type aliases (Phase 6 §6.5) — see tasks/types.ts
// for why this exists apart from data/useMilestones.ts.
export type Milestone = Database['public']['Tables']['milestones']['Row']
export type MilestoneSection = Database['public']['Tables']['milestone_sections']['Row']
