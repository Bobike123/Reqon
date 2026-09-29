import type { MilestoneSection } from '../../milestones/types.ts'
import { taskProgress, tasksInMilestone } from '../../tasks/progress.ts'
import type { Task } from '../../tasks/types.ts'
import { draftedCount } from '../milestones/milestoneModel.ts'

// Progress for milestones and sections, on the ONE shared rule (tasks/progress.ts):
// distinct tasks, cancelled left out, archived Done counted as done, archived
// unfinished kept in the denominator, and "nothing to count" reported as such.
//
// Every figure says what it is BASED ON, so the screen can never present the old
// "section drafted" tick as if it were task completion:
//   tasks    — linked Board tasks (active and archived) decided the number
//   drafted  — no task is linked yet, so the legacy drafted checklist is shown,
//              labelled as that
//   none     — nothing to count at all; the screen says "No linked work"
//
// Feed the PROGRESS list (active + archived tasks), never the active Board list,
// or archiving a Done task would make progress fall.
export type ProgressSource = Pick<Task, 'id' | 'state' | 'archived_at' | 'section_id' | 'milestone_key'>

// A progress row that also carries who owns it and which department, so the
// department lens can filter the very same list progress is counted from.
export type ProgressRow = ProgressSource & Pick<Task, 'owner_id' | 'subteam_key'>

export type ProgressBasis = 'tasks' | 'drafted' | 'none'

export type ProgressView = {
  basis: ProgressBasis
  // null only when basis is 'none'.
  percent: number | null
  done: number
  total: number
  // Archived tasks that finished / never finished, so the text can say the
  // percentage includes archived work.
  archivedDone: number
  archivedUnfinished: number
}

function fromTasks(tasks: readonly ProgressSource[]): Omit<ProgressView, 'basis'> & { counted: number } {
  const p = taskProgress(tasks)
  const archivedDone = tasks.filter((t) => t.state === 'done' && t.archived_at != null).length
  return {
    percent: p.percent,
    done: p.done,
    total: p.total,
    archivedDone,
    archivedUnfinished: p.archivedUnfinished,
    counted: p.total,
  }
}

const NOTHING: ProgressView = { basis: 'none', percent: null, done: 0, total: 0, archivedDone: 0, archivedUnfinished: 0 }

// A milestone: every task attached to it — directly (its milestone_key, sectioned
// or not) or through one of its sections — each counted once. With none, its
// sections' drafted ticks stand in, labelled.
export function milestoneProgress(
  sections: readonly MilestoneSection[],
  tasks: readonly ProgressSource[],
  milestoneKey: string,
): ProgressView {
  const ids = new Set(sections.map((s) => s.id))
  const mine = tasksInMilestone(tasks, milestoneKey, ids)
  const { counted, ...rest } = fromTasks(mine)
  if (counted > 0) return { basis: 'tasks', ...rest }

  const { drafted, total } = draftedCount([...sections])
  if (total === 0) return NOTHING
  return {
    basis: 'drafted',
    percent: Math.round((drafted / total) * 100),
    done: drafted,
    total,
    archivedDone: 0,
    archivedUnfinished: 0,
  }
}

// A section: the tasks linked to it; with none, its own drafted tick.
export function sectionProgress(section: MilestoneSection, tasks: readonly ProgressSource[]): ProgressView {
  const mine = tasks.filter((t) => t.section_id === section.id)
  const { counted, ...rest } = fromTasks(mine)
  if (counted > 0) return { basis: 'tasks', ...rest }
  return {
    basis: 'drafted',
    percent: section.is_drafted ? 100 : 0,
    done: section.is_drafted ? 1 : 0,
    total: 1,
    archivedDone: 0,
    archivedUnfinished: 0,
  }
}

// The department lens' own figure: the SAME rule over only the tasks the lens
// lets through. Never falls back to the drafted checklist (a checklist has no
// department), and never replaces the overall figure — it is shown beside it.
export function lensProgress(
  sections: readonly MilestoneSection[],
  lensTasks: readonly ProgressSource[],
  milestoneKey: string,
): ProgressView {
  const ids = new Set(sections.map((s) => s.id))
  const { counted, ...rest } = fromTasks(tasksInMilestone(lensTasks, milestoneKey, ids))
  return counted > 0 ? { basis: 'tasks', ...rest } : NOTHING
}

// The words for a figure. Always says what it counts.
export function progressLabel(view: ProgressView, unit: 'submission' | 'section' = 'submission'): string {
  if (view.basis === 'none') return 'No linked work'
  if (view.basis === 'drafted') {
    return unit === 'section'
      ? `${view.done === 1 ? 'Drafted' : 'Not drafted'} (no tasks linked)`
      : `${view.done} of ${view.total} sections drafted (no tasks linked)`
  }
  const archived = view.archivedDone > 0 ? `, incl. ${view.archivedDone} archived done` : ''
  const stuck = view.archivedUnfinished > 0 ? `, ${view.archivedUnfinished} archived unfinished` : ''
  return `${view.done} of ${view.total} tasks done${archived}${stuck}`
}

// Tasks attached to a milestone with no section yet: the explicit "unsectioned
// work" group. Never a fake section record.
export function unsectionedFor<T extends Pick<Task, 'milestone_key' | 'section_id'>>(
  tasks: readonly T[],
  milestoneKey: string,
): T[] {
  return tasks.filter((t) => t.milestone_key === milestoneKey && t.section_id === null)
}

// Tasks under a section.
export function tasksUnderSection<T extends Pick<Task, 'section_id'>>(tasks: readonly T[], sectionId: string): T[] {
  return tasks.filter((t) => t.section_id === sectionId)
}
