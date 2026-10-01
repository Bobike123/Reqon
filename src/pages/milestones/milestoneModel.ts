import type { Milestone, MilestoneSection } from '../../milestones/types.ts'
import { toLocalDateString } from '../../lib/dates.ts'

// A milestone with no published window renders TBC. MS1-7 happens at the Final
// Event and genuinely has no date yet — an invented deadline is worse than a
// blank, because someone will plan around it.
export type Window =
  | { kind: 'tbc' }
  | { kind: 'dated'; opensOn: string | null; dueOn: string; daysRemaining: number; passed: boolean }

export function submissionWindow(milestone: Milestone, today: Date): Window {
  if (!milestone.due_on) return { kind: 'tbc' }
  const todayIso = toLocalDateString(today)
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

// Top-level sections of a milestone, in order (subsections are nested under them).
export function topLevelSections(sections: MilestoneSection[], milestoneKey: string): MilestoneSection[] {
  return sectionsFor(sections, milestoneKey).filter((s) => !s.parent_section_id)
}

// The subsections of one section, in order.
export function subsectionsOf(sections: MilestoneSection[], parentId: string): MilestoneSection[] {
  return sections.filter((s) => s.parent_section_id === parentId).sort((a, b) => a.ordinal - b.ordinal)
}

export function draftedCount(sections: MilestoneSection[]): { drafted: number; total: number } {
  return {
    drafted: sections.filter((s) => s.is_drafted).length,
    total: sections.length,
  }
}
