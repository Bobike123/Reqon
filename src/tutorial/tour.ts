import { describePublicAccess } from '../auth/permissions.ts'
import { AUDIENCES, CHAPTERS, GUIDE_PARTS, type ChapterId, type GuidePartId, type TourViewer, type TutorialStep } from './steps.ts'

// Which tour to run: everything for this person, only the steps their role
// adds, or one screen on its own.
export type TourSelection =
  | { kind: 'full' }
  | { kind: 'role' }
  | { kind: 'chapter'; chapter: ChapterId }
  // The Developer guide, whole or one part of it. Separate from every tour above; only a Developer gets steps.
  | { kind: 'guide'; part?: GuidePartId }

// What the chooser offers this person, with how long each option is.
export type TourMenu = {
  full: number
  // Null for someone with no privileged role: there is nothing extra to show.
  role: { label: string; count: number } | null
  chapters: { id: ChapterId; label: string; count: number }[]
  // The Developer guide (backups, keys, loading a backup). Null for everyone who is not a Developer.
  developerGuide: { count: number; parts: { id: GuidePartId; label: string; count: number }[] } | null
}

export function chapterLabel(id: ChapterId | GuidePartId): string {
  return CHAPTERS.find((c) => c.id === id)?.label ?? GUIDE_PARTS.find((p) => p.id === id)?.label ?? ''
}

// A step is for everyone unless it names an audience, and then only for the
// people that audience includes.
export function isFor(step: TutorialStep, can: TourViewer): boolean {
  return !step.audience || AUDIENCES[step.audience].includes(can)
}

// The steps to run, in order. Pure, so what each role is taught can be tested
// without rendering anything (tutorial.test.tsx).
export function buildTour(
  steps: readonly TutorialStep[],
  can: TourViewer,
  selection: TourSelection,
): TutorialStep[] {
  // The Developer guide is a tour of its own: no other selection ever includes one of its steps.
  if (selection.kind === 'guide') {
    if (!can.hasRole('developer')) return []
    return steps.filter((step) => step.guide === 'developer' && (!selection.part || step.chapter === selection.part))
  }
  // Run in the menu's order, whatever order the steps were written in; steps of one screen keep their order.
  const rank = (step: TutorialStep) => CHAPTERS.findIndex((c) => c.id === step.chapter)
  const mine = steps
    .filter((step) => !step.guide && isFor(step, can))
    .map((step, index) => ({ step, index }))
    .sort((a, b) => rank(a.step) - rank(b.step) || a.index - b.index)
    .map(({ step }) => step)
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

// The role tour's label: the privileged roles held, Head of a department
// added on if it applies, in one readable phrase — "President and Head of a
// department", or just "Head of a department" for someone with no privileged
// role at all.
function roleLabel(can: TourViewer): string {
  if (!can.isHeadOfDepartment) return describePublicAccess(can.roles)
  if (can.roles.length === 0) return 'Head of a department'
  return `${describePublicAccess(can.roles)} and Head of a department`
}

export function tourMenu(steps: readonly TutorialStep[], can: TourViewer): TourMenu {
  const full = buildTour(steps, can, { kind: 'full' })
  const role = buildTour(steps, can, { kind: 'role' })
  const guide = buildTour(steps, can, { kind: 'guide' })
  return {
    full: full.length,
    role: role.length > 0 ? { label: roleLabel(can), count: role.length } : null,
    chapters: CHAPTERS.filter((c) => c.id !== 'end')
      .map((c) => ({ id: c.id, label: c.label, count: full.filter((s) => s.chapter === c.id).length }))
      .filter((c) => c.count > 0),
    developerGuide:
      guide.length > 0
        ? {
            count: guide.length,
            parts: GUIDE_PARTS.map((p) => ({ id: p.id, label: p.label, count: guide.filter((x) => x.chapter === p.id).length })).filter((p) => p.count > 0),
          }
        : null,
  }
}
