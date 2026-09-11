import { describeRoles, type Permissions } from '../auth/permissions.ts'
import { AUDIENCES, CHAPTERS, type ChapterId, type TutorialStep } from './steps.ts'

// Which tour to run: everything for this person, only the steps their role
// adds, or one screen on its own.
export type TourSelection = { kind: 'full' } | { kind: 'role' } | { kind: 'chapter'; chapter: ChapterId }

// What the chooser offers this person, with how long each option is.
export type TourMenu = {
  full: number
  // Null for someone with no privileged role: there is nothing extra to show.
  role: { label: string; count: number } | null
  chapters: { id: ChapterId; label: string; count: number }[]
}

export function chapterLabel(id: ChapterId): string {
  return CHAPTERS.find((c) => c.id === id)?.label ?? ''
}

// A step is for everyone unless it names an audience, and then only for the
// people that audience includes.
export function isFor(step: TutorialStep, can: Permissions): boolean {
  return !step.audience || AUDIENCES[step.audience].includes(can)
}

// The steps to run, in order. Pure, so what each role is taught can be tested
// without rendering anything (tutorial.test.tsx).
export function buildTour(
  steps: readonly TutorialStep[],
  can: Permissions,
  selection: TourSelection,
): TutorialStep[] {
  const mine = steps.filter((step) => isFor(step, can))
  switch (selection.kind) {
    case 'full':
      return mine
    case 'role': {
      const extras = mine.filter((step) => step.audience)
      // The same ending as the full tour: how to start it again.
      return extras.length > 0 ? [...extras, ...mine.filter((step) => step.chapter === 'end')] : []
    }
    case 'chapter':
      return mine.filter((step) => step.chapter === selection.chapter)
  }
}

export function tourMenu(steps: readonly TutorialStep[], can: Permissions): TourMenu {
  const full = buildTour(steps, can, { kind: 'full' })
  const role = buildTour(steps, can, { kind: 'role' })
  return {
    full: full.length,
    role: role.length > 0 ? { label: describeRoles(can.roles), count: role.length } : null,
    chapters: CHAPTERS.filter((c) => c.id !== 'end')
      .map((c) => ({ id: c.id, label: c.label, count: full.filter((s) => s.chapter === c.id).length }))
      .filter((c) => c.count > 0),
  }
}
