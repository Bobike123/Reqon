import type { Milestone, MilestoneSection } from '../../data/useMilestones.ts'

// A milestone with no published window renders TBC. MS1-7 happens at the Final
// Event and genuinely has no date yet — an invented deadline is worse than a
// blank, because someone will plan around it.
export type Window =
  | { kind: 'tbc' }
  | { kind: 'dated'; opensOn: string | null; dueOn: string; daysRemaining: number; passed: boolean }

export function submissionWindow(milestone: Milestone, today: Date): Window {
  if (!milestone.due_on) return { kind: 'tbc' }
  const todayIso = today.toISOString().slice(0, 10)
  const days = Math.round(
    (Date.parse(`${milestone.due_on}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000,
  )
  return {
    kind: 'dated',
    opensOn: milestone.opens_on,
    dueOn: milestone.due_on,
    daysRemaining: days,
    passed: days < 0,
  }
}

export function sectionsFor(
  sections: MilestoneSection[],
  milestoneKey: string,
): MilestoneSection[] {
  return sections
    .filter((s) => s.milestone_key === milestoneKey)
    .sort((a, b) => a.ordinal - b.ordinal)
}

export function draftedCount(sections: MilestoneSection[]): { drafted: number; total: number } {
  return {
    drafted: sections.filter((s) => s.is_drafted).length,
    total: sections.length,
  }
}
