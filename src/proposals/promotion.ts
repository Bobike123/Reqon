import type { Proposal } from './types.ts'

// Exactly which fields stop a proposal being promoted, mirroring
// promote_proposal()'s own checks (legacy_incomplete, missing department,
// deadline, milestone, requirements). The database refuses regardless; this
// only lets the review dialog say WHAT is missing instead of a bare refusal.
export type PromotionBlocker = 'department' | 'deadline' | 'milestone' | 'requirements'

export const PROMOTION_BLOCKER_LABEL: Record<PromotionBlocker, string> = {
  department: 'a department',
  deadline: 'a deadline',
  milestone: 'a milestone',
  requirements: 'at least one requirement',
}

export type PromotionDraft = {
  departmentKey: string | null
  dueDate: string | null
  milestoneKey: string | null
  requirementCount: number
}

export function draftFrom(proposal: Pick<Proposal, 'subteam_key' | 'due_date' | 'milestone_key'>, requirementCount: number): PromotionDraft {
  return {
    departmentKey: proposal.subteam_key,
    dueDate: proposal.due_date,
    milestoneKey: proposal.milestone_key,
    requirementCount,
  }
}

export function promotionBlockers(draft: PromotionDraft): PromotionBlocker[] {
  const blockers: PromotionBlocker[] = []
  if (!draft.departmentKey) blockers.push('department')
  if (!draft.dueDate) blockers.push('deadline')
  if (!draft.milestoneKey) blockers.push('milestone')
  if (draft.requirementCount < 1) blockers.push('requirements')
  return blockers
}

export function describeBlockers(blockers: readonly PromotionBlocker[]): string {
  const labels = blockers.map((b) => PROMOTION_BLOCKER_LABEL[b])
  if (labels.length === 0) return ''
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
